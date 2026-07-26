import type { DatabaseContext, ReadTx, WriteTx } from './database.ts'
import type { LogicalStore } from './store.ts'
import type { AcquisitionEngine } from './acquisition.ts'
import type { LogicalItemDto, ProjectionViewer, ReplyCountOverlay, SourceModelV2Activation } from './types.ts'
import {
  getJournalMetadata, readJournalBatch, appendJournal, reconstructJournal,
  encodeJournalCursor, decodeJournalCursor, isServeableCursor,
} from './journal.ts'
import { createScheduler } from './scheduler.ts'
import type { LogicalScheduler, Breather } from './scheduler.ts'
import { createLogicalPush } from './push.ts'
import type { LogicalPush } from './push.ts'
import type { Config } from '../config.ts'
import type { LookupFn } from '../domain/push-guard.ts'
import { drainReconciliation, drainReconciliationAsync } from './reconcile.ts'
import { createVerificationRunner } from './verification.ts'
import { projectItem } from './projector.ts'
import { materializeLocalChain } from './local.ts'
import { deriveRoot } from './roots.ts'
import { loadManifest, runPreflight } from '../migration/preflight.ts'
import type { Manifest } from '../migration/preflight.ts'
import { runConversion } from '../migration/convert.ts'
import type { ConversionCounts } from '../migration/convert.ts'

// Startup activation and worker composition (spec §7.1-7.2). This is the module
// that REPLACES Task 2's temporary fail-closed guard: with RSC_SOURCE_MODEL_V2 on
// the runtime constructs every worker, runs the ONE pre-listen activation
// transaction, then lets the server accept traffic. The construction order is
// exactly journal → projector → scheduler → reconcile → orphan → activate → listen
// (Appendix D). No TS parameter properties; no new dependency.

// The SSE stream event union (spec §5.3) — the wire shape Web consumes.
export type LogicalV2StreamEvent =
  | { model: 'logical-v2'; kind: 'upsert'; logicalItemId: string; item: LogicalItemDto; replyCounts?: ReplyCountOverlay }
  | { model: 'logical-v2'; kind: 'remove'; logicalItemId: string; replyCounts?: ReplyCountOverlay }
  | { model: 'logical-v2'; kind: 'reset' }

// One outbound frame the /stream route serializes: a data event carrying its
// generation-qualified `id`, OR a reset control that stops replay and closes.
// A stored reset carries the reset row's encoded cursor; a synthesized recovery
// reset (generation change or unsafe reconstruction) has no invented id.
export type StreamOutFrame =
  | { control: 'reset'; id?: string }
  | { control: 'event'; id: string; event: LogicalV2StreamEvent }

export interface StreamStart {
  kind: 'serve' | 'reset'
  afterSequence: number
  generation: number
}

export interface StreamBatch {
  frames: StreamOutFrame[]
  lastSequence: number
  done: boolean // a reset control terminated this batch — the caller closes
}

export interface LogicalStreamSource {
  // Resolve the opaque incoming cursor. Missing/empty/malformed/unserveable
  // (unknown, stale, or older-generation) all resolve to a reset (spec §5.3).
  start(cursor: string | null): StreamStart
  // One consistent snapshot: read high water + replay rows after `afterSequence`,
  // project each under CURRENT policy. Stops at the first stored reset / generation
  // change / unsafe reconstruction (spec §5.4). The in-memory bus is never authority.
  batch(input: { afterSequence: number; generation: number; viewer: ProjectionViewer; limit: number }): StreamBatch
}

export interface LogicalRuntime {
  scheduler: LogicalScheduler
  acquisition: AcquisitionEngine // wrapped: drains + hints after every committed acquisition
  streamSource: LogicalStreamSource
  // The v2 inbound push lifecycle + its four callbacks (V4 §1.2-1.4). Exposed so
  // server.ts routes the existing public callback paths at it; the scheduler drives
  // the lifecycle half on its poll pass.
  push: LogicalPush
  ready: Promise<void>
  order: string[]
  // The background drain — the ONLY path that runs verification's network I/O.
  // The scheduler's poll tick calls it; exposed so a test can drive it explicitly.
  drainVerification(): Promise<void>
  stop(): Promise<void>
}

const ORPHAN_BATCH = 100

// Send-time reply-count overlay (spec §5.5): the derived root's ID and its current
// ordinary-visible conversation total, computed in THIS projection snapshot. Present
// for a resolved-reply subject; because it is an authoritative TOTAL (not a delta),
// replay and duplicate delivery are idempotent.
function overlayFor(tx: ReadTx, rootId: string | null, viewer: ProjectionViewer): ReplyCountOverlay | null {
  if (!rootId) return null
  const root = projectItem(tx, rootId, viewer)
  if (!root) return null
  return { rootLogicalItemId: root.id, rootConversationReplyCount: root.conversationReplyCount }
}

function upsertFrame(tx: ReadTx, item: LogicalItemDto, viewer: ProjectionViewer): LogicalV2StreamEvent {
  const rc = item.parentResolutionState === 'resolved' ? overlayFor(tx, item.threadRootId, viewer) : null
  return { model: 'logical-v2', kind: 'upsert', logicalItemId: item.id, item, ...(rc ? { replyCounts: rc } : {}) }
}

function removeFrame(tx: ReadTx, id: string, viewer: ProjectionViewer): LogicalV2StreamEvent {
  // A removed / now-unavailable reply still carries an overlay so its root's card
  // reflects the decremented total. Read the durable ancestry edge directly (the
  // item is no longer ordinary-visible, so projectItem yields nothing for it).
  const row = tx.prepare(`SELECT parent_state, parent_logical_item_id FROM logical_items_v2 WHERE id = ?`).get(id) as
    { parent_state: string; parent_logical_item_id: string | null } | undefined
  const rc = row && row.parent_state === 'resolved' && row.parent_logical_item_id
    ? overlayFor(tx, deriveRoot(tx, row.parent_logical_item_id), viewer)
    : null
  return { model: 'logical-v2', kind: 'remove', logicalItemId: id, ...(rc ? { replyCounts: rc } : {}) }
}

export function createStreamSource(db: DatabaseContext): LogicalStreamSource {
  const RESET_SYNTH: StreamOutFrame = { control: 'reset' }
  return {
    start(cursor) {
      return db.read((tx) => {
        const meta = getJournalMetadata(tx)
        if (!cursor) return { kind: 'reset', afterSequence: 0, generation: meta.resetGeneration }
        const dec = decodeJournalCursor(cursor)
        if (!dec || !isServeableCursor(meta, dec)) return { kind: 'reset', afterSequence: 0, generation: meta.resetGeneration }
        return { kind: 'serve', afterSequence: dec.sequence, generation: dec.resetGeneration }
      })
    },
    batch({ afterSequence, generation, viewer, limit }) {
      return db.read((tx) => {
        const meta = getJournalMetadata(tx)
        // An explicit reconstruction advanced the generation → single reset, close.
        if (meta.resetGeneration !== generation) return { frames: [RESET_SYNTH], lastSequence: afterSequence, done: true }
        const rows = readJournalBatch(tx, afterSequence, limit)
        const frames: StreamOutFrame[] = []
        let lastSequence = afterSequence
        for (const row of rows) {
          lastSequence = row.sequence
          const id = encodeJournalCursor({ version: 1, resetGeneration: generation, sequence: row.sequence })
          if (row.kind === 'reset') {
            // A STORED reset (policy barrier, account deletion, orphan adoption)
            // uses its own encoded cursor; stop replay and close (spec §5.3).
            frames.push({ control: 'reset', id })
            return { frames, lastSequence, done: true }
          }
          let event: LogicalV2StreamEvent
          try {
            if (row.kind === 'remove') {
              event = removeFrame(tx, row.logicalItemId as string, viewer)
            } else {
              // Historical upsert projected under CURRENT policy: visible → upsert;
              // unavailable → remove; placeholders are never streamed (projectItem
              // returns undefined for a non-visible item, never a placeholder node).
              const item = projectItem(tx, row.logicalItemId as string, viewer)
              event = item ? upsertFrame(tx, item, viewer) : removeFrame(tx, row.logicalItemId as string, viewer)
            }
          } catch {
            // Unsafe reconstruction → single synthesized reset, stop, close.
            frames.push(RESET_SYNTH)
            return { frames, lastSequence, done: true }
          }
          frames.push({ control: 'event', id, event })
        }
        return { frames, lastSequence, done: false }
      })
    },
  }
}

// ---- activation (spec §7.1) -------------------------------------------------

// The activation state and the conversion marker are read TOGETHER (V4 §4.1 step
// 2) — one row, one query, inside the one transaction; the pair is what the
// branch below decides on, and reading them apart is what would let a
// hand-repaired database slip through between the two reads.
type ActivationRow = SourceModelV2Activation & { convertedAt: string | null }

function readActivation(tx: ReadTx): ActivationRow {
  const row = tx.prepare(
    `SELECT schema_version, state, last_activated_at, last_reconciled_at, converted_at FROM logical_activation_v2 WHERE singleton = 1`,
  ).get() as { schema_version: 1; state: SourceModelV2Activation['state']; last_activated_at: string | null; last_reconciled_at: string | null; converted_at: string | null }
  return { schemaVersion: row.schema_version, state: row.state, lastActivatedAt: row.last_activated_at, lastReconciledAt: row.last_reconciled_at, convertedAt: row.converted_at }
}

// Materialize every pre-existing local post's bridge row so no UNMATERIALIZED
// local item survives activation (resolves the Task 3/8 carry: projectThread 404s
// on an unmaterialized legacy local post). materializeLocalChain walks each post's
// ancestry parent-before-child; because conversion runs BEFORE this pass, a local
// reply whose parent is a REMOTE post is materialized too — its parent is already a
// same-ID logical_items_v2 row, so the unconditional parent edge in local.ts holds.
// Only a chain that ends at an id with no logical row at all (a reference to a post
// that is gone) is still skipped. Idempotent by construction (INSERT OR IGNORE plus
// the has-a-row early exit), which is what lets it run on EVERY startup path — a
// database converted by an earlier build, which skipped these replies, repairs
// itself on its next start.
//
// The anti-join pre-filters to UNMATERIALIZED local posts only: better-sqlite3
// does not cache prepares, so this runs on every boot inside the pre-listen
// IMMEDIATE write transaction, and without it materializeLocalChain's per-post
// check would run once per local post on every restart, forever, even in the
// ordinary steady state where nothing needs repairing. Repair semantics are
// unchanged — a straggler this query finds still walks its ancestry via
// materializeLocalChain exactly as before.
function materializePreexistingLocalPosts(tx: WriteTx): void {
  const rows = tx.prepare(
    `SELECT id FROM posts WHERE source = 'local' AND id NOT IN (SELECT id FROM logical_items_v2)`,
  ).all() as { id: string }[]
  for (const r of rows) materializeLocalChain(tx, r.id)
}

function writeActivation(tx: WriteTx, state: SourceModelV2Activation['state'], lastActivatedAt: string | null, lastReconciledAt: string | null): void {
  tx.prepare(`UPDATE logical_activation_v2 SET state = ?, last_activated_at = ?, last_reconciled_at = ? WHERE singleton = 1`)
    .run(state, lastActivatedAt, lastReconciledAt)
}

// ---- the cutover (V4 spec §4.1, §4.3) ---------------------------------------

// The startup tripwire fails LOUD, in the shape of the existing
// `database is newer than this build` guard (storage/sqlite.ts:1442): a thrown
// startup error naming the supported recovery — never a silent skip. (Its twin,
// the converted-database-requires-v2 guard, retired with the legacy branch it
// protected: there is no longer a v1 path to start.)
export const ACTIVE_WITHOUT_MARKER =
  'v2 activation present without conversion marker — this database was activated without the legacy conversion (hand-repaired or partially restored); restore the pre-flip backup and restart the migration'
export const PREFLIGHT_FAILED = 'migration preflight failed'

export interface CutoverInput {
  // RSC_MIGRATION_MANIFEST, or null. Presence only is validated by config; the
  // file is read (and its shape diagnosed) here, in the fail-startup path.
  manifestPath?: string | null
  // Conversion's non-aborting findings (spec §3.6) — log lines beside the
  // per-kind counts sealed into the marker. Production writes them to stdout.
  log?: (line: string) => void
  // Fault-injection seam (V2 Appendix D pattern), called after each step of the
  // ONE transaction. Production passes nothing; a test throws from it to prove a
  // crash anywhere before commit leaves a legacy-intact database.
  // ponytail: one optional callback instead of a mock database.
  step?: (phase: 'conversion' | 'journal' | 'marker' | 'activation') => void
}

// LIVE ON THE FRESH-INSTALL PATH — do not "retire" this as cutover-only
// machinery. activateLogicalV2 reaches convertLegacy whenever activation state
// is `never_activated`, which is every brand-new install's FIRST BOOT, not just
// a legacy cutover. loadManifest/runPreflight (migration/preflight.ts) and
// runConversion (migration/convert.ts) all run there, trivially, over zero
// legacy rows. Deleting either module would break first boot for every new
// install while leaving already-converted instances working — a regression no
// test against existing production can catch. core/test/fresh-install.test.ts
// is the guard; keep it green.
//
// Preflight + conversion, inside the caller's write transaction. runPreflight is
// read-only by construction, so running it here costs nothing and guarantees the
// checks see exactly the rows conversion will convert; any abort throws, and the
// whole transaction — schema and legacy data alike — rolls back untouched.
function convertLegacy(tx: WriteTx, now: string, cutover: CutoverInput): ConversionCounts {
  let manifest: Manifest | null
  try {
    manifest = loadManifest(cutover.manifestPath ?? null)
  } catch (err) {
    // loadManifest THROWS its named diagnostics (unreadable file, bad JSON, wrong
    // schemaVersion, invalid attributionMode) where runPreflight RETURNS findings.
    // Both are aborting preflight problems (spec §2.1), so both fail startup the
    // same way and the named diagnostic is SURFACED — an unhandled throw would
    // reject `ready` just as safely but leave the operator with no diagnosis.
    throw new Error(`${PREFLIGHT_FAILED}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const findings = runPreflight(tx, manifest)
  if (findings.length > 0) {
    throw new Error(`${PREFLIGHT_FAILED}: ${findings.map((f) => `${f.kind}: ${f.detail}`).join('; ')}`)
  }
  return runConversion(tx, { manifest, now, log: cutover.log ?? ((line) => console.log(line)) })
}

// The ONE pre-listen activation transaction (spec V2 §7.1, extended by V4 §4.1 —
// never a second barrier). Local-state read, legacy conversion, local
// materialization, journal initialization, one reset, the conversion marker,
// timestamps, and the transition to `active` all commit together — no application
// mutation intervenes, and a throw anywhere before commit converts nothing. In
// particular the marker is written AFTER materialization, in the same transaction,
// so no crash can leave a database marked converted with its local replies still
// unmaterialized.
//
// NOTHING here does network I/O: preflight and conversion are pure SQL by
// contract, so the pre-listen barrier server.ts awaits stays free of awaited
// network I/O exactly as the V3 I1 fix left it.
export function activateLogicalV2(db: DatabaseContext, now: string, cutover: CutoverInput = {}): void {
  db.write((tx) => {
    const act = readActivation(tx)
    // Tripwire: v2 was activated against UNCONVERTED data. Spec §4.1 step 2 names
    // the `active` case; `reconciliation_required` is the same anomaly one
    // flag-off restart later (markReconciliationRequiredIfActive moves an
    // unmarked active database there), and letting it through would silently skip
    // conversion — the dual-model state WC3 forbids. Both fail loud.
    if (act.state !== 'never_activated' && !act.convertedAt) throw new Error(ACTIVE_WITHOUT_MARKER)

    // Conversion FIRST, ahead of materialization: it mints every legacy remote post
    // as a same-ID logical_items_v2 row, which is exactly what a local reply to a
    // REMOTE parent needs before its bridge row can carry that parent edge. It still
    // runs AT MOST ONCE — only from `never_activated`, and only with no marker (a
    // marker here means conversion committed and the activation was cleared by hand).
    const counts = act.state === 'never_activated' && !act.convertedAt ? convertLegacy(tx, now, cutover) : null
    cutover.step?.('conversion')
    // Materialization runs on EVERY startup path, the continuous-v2 restart below
    // included: it is idempotent, and a database converted by an earlier build (one
    // that skipped local replies to remote parents) reaches only that path.
    materializePreexistingLocalPosts(tx)

    if (act.state === 'active') return // continuous-v2 restart: preserve generation + timestamps, append no reset
    if (act.state === 'never_activated') {
      // First activation creates the reset generation + the cutover reset atomically.
      reconstructJournal(tx, now)
      cutover.step?.('journal')
      if (counts) {
        tx.prepare(`UPDATE logical_activation_v2 SET converted_at = ?, conversion_findings_json = ? WHERE singleton = 1`).run(now, JSON.stringify(counts))
      }
      cutover.step?.('marker')
      writeActivation(tx, 'active', now, act.lastReconciledAt)
      cutover.step?.('activation')
    } else {
      // Reactivation (reconciliation_required): preserve the generation, append one
      // barrier reset, refresh timestamps.
      appendJournal(tx, { kind: 'reset', changeMask: 'barrier' }, now)
      writeActivation(tx, 'active', now, now)
    }
  })
}

// A DISABLED process, before accepting traffic, marks reconciliation_required when
// v2 was previously active (spec §7.1). A never-activated instance is left
// untouched — so flag-off on a fresh install writes nothing (byte-identical legacy).
export function markReconciliationRequiredIfActive(db: DatabaseContext): boolean {
  return db.write((tx) => {
    const act = readActivation(tx)
    if (act.state !== 'active') return false
    writeActivation(tx, 'reconciliation_required', act.lastActivatedAt, act.lastReconciledAt)
    return true
  })
}

export function createLogicalRuntime(input: {
  db: DatabaseContext
  store: LogicalStore
  acquisition: AcquisitionEngine
  // The whole Config, not just the poll cadence: the push lifecycle built below
  // reads RSC_PUSH_IN + RSC_PUBLIC_URL through pushInEffective.
  config: Config
  now?: () => string
  notify?: (sequence: number) => void
  trace?: (phase: string) => void
  // Push's outbound registration/renewal I/O. Production passes neither — default
  // global fetch and real DNS, the same posture acquisition takes in server.ts.
  fetchFn?: typeof fetch
  lookupFn?: LookupFn
}): LogicalRuntime {
  const { db, store, acquisition, config } = input
  const now = input.now ?? (() => new Date().toISOString())
  const order: string[] = []
  const trace = (phase: string): void => { order.push(phase); input.trace?.(phase) }

  trace('journal')
  const streamSource = createStreamSource(db)
  trace('projector')

  // After any committed journal effect, publish the coalesced high-water hint so an
  // open /stream catches up before its heartbeat. Bus carries the number only.
  const hint = (): void => { input.notify?.(store.snapshot((tx) => tx.getJournalMetadata().highWaterSeq)) }

  // Startup crash-recovery + after-acquisition drains (Task 6 deferred this here):
  // pending/retrying reconciliation jobs and pending orphan work. A crashed
  // nonterminal run is left as history and never resumed (spec §7.2); the in-flight
  // flag died with the process (acquisition.ts Map), so startup begins with none.
  const drainOrphans = (): void => {
    for (;;) {
      const claim = store.claimOrphanWork(now())
      if (!claim) break
      let res
      do { res = store.adoptOrphans({ claim, now: now(), limit: ORPHAN_BATCH }) } while (res.remaining)
    }
  }
  // The drain that STARTUP and the acquisition result path run: observation, fan-out
  // and orphan work — local DB work only, NO network. Verification jobs are
  // deferred here (deferVerification) and picked up by the background drain below.
  const drainSync = (): void => {
    drainReconciliation({ store, now })
    drainOrphans()
    hint()
  }

  // Origin verification (spec §7.1) rides the SAME claim ordering, but its bounded
  // fetch is NETWORK I/O — up to 10 s per batch key — so it runs ONLY on the
  // scheduler's background cadence (scheduler.tick calls this), never pre-listen
  // and never on a request path. Production posture matches acquisition
  // (server.ts): default global fetch, no injected DNS lookup.
  const verificationRunner = createVerificationRunner({ db, store, now })
  const drainVerification = async (): Promise<void> => {
    await drainReconciliationAsync({
      store, now,
      runVerificationBatch: (i) => verificationRunner.runVerificationBatch(i.claim, i.now),
    })
    drainOrphans()
    hint()
  }

  // Wrap the acquisition engine so every committed acquisition (scheduled OR admin
  // refresh) is followed by a reconciliation + orphan drain and a wake-up hint.
  const wrapped: AcquisitionEngine = {
    inFlight: (id) => acquisition.inFlight(id),
    async acquireSource(id, reason, signal) {
      const r = await acquisition.acquireSource(id, reason, signal)
      if (!('kind' in r)) drainSync()
      return r
    },
  }

  // The v2 inbound push lifecycle (V4 §1.2-1.4), built HERE — the one composition
  // root — over the WRAPPED engine, so a push-delivered acquisition drains
  // reconciliation and hints the stream exactly as a poll does. Handing it to the
  // scheduler is what makes registration, renewal and the purge run at all;
  // test/logical-push-callbacks.test.ts drives a real runtime through a poll pass
  // and asserts a lease row is written, so dropping this argument goes red.
  const push = createLogicalPush({ db, store, config, acquisition: wrapped, fetchFn: input.fetchFn, lookupFn: input.lookupFn })

  // The poll tick runs post-listen (server.ts fires it via scheduler.start after it
  // awaits `ready`, and each subsequent tick is a background timer), so yielding a
  // macrotask between per-source acquisitions lets pending HTTP callbacks — SSR /,
  // real clients — run instead of starving behind the burst. setImmediate targets
  // the check phase, where socket-read/HTTP callbacks are queued; a microtask yield
  // (queueMicrotask/await Promise.resolve) would NOT let them in, which is exactly
  // why the awaited fetches alone did not prevent the starvation. The pre-listen
  // drainSync path takes no breather and stays synchronous (I1: nothing awaited does
  // network I/O), so this is the ONE place a real breather is wired.
  const breather: Breather = () => new Promise((resolve) => { setImmediate(resolve) })
  const scheduler = createScheduler({ store, acquisition: wrapped, config, now, drainVerification, push, breather })
  trace('scheduler')
  trace('reconcile')
  trace('orphan')

  const ready = (async (): Promise<void> => {
    // The ONE pre-listen transaction — now also the cutover (V4 §4.1). Both
    // tripwires and the legacy conversion live inside it; the manifest path is
    // read off the same Config the push lifecycle above uses.
    activateLogicalV2(db, now(), { manifestPath: config.migrationManifestPath })
    trace('activate')
    // Startup drain: pick up pending/retrying jobs and pending orphan work a crash
    // may have left, then start the serial poll loop. NOTHING here awaits network
    // I/O — server.ts awaits this promise BEFORE it listens, so a crash-left
    // verification backlog must never delay the process accepting traffic.
    drainSync()
    scheduler.start()
  })()

  return {
    scheduler,
    acquisition: wrapped,
    streamSource,
    push,
    ready,
    order,
    drainVerification,
    async stop() { scheduler.stop() },
  }
}
