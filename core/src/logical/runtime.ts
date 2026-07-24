import type { DatabaseContext, ReadTx, WriteTx } from './database.ts'
import type { LogicalStore } from './store.ts'
import type { AcquisitionEngine } from './acquisition.ts'
import type { LogicalItemDto, ProjectionViewer, ReplyCountOverlay, SourceModelV2Activation } from './types.ts'
import {
  getJournalMetadata, readJournalBatch, appendJournal, reconstructJournal,
  encodeJournalCursor, decodeJournalCursor, isServeableCursor,
} from './journal.ts'
import { createScheduler } from './scheduler.ts'
import type { LogicalScheduler } from './scheduler.ts'
import { drainReconciliation, drainReconciliationAsync } from './reconcile.ts'
import { createVerificationRunner } from './verification.ts'
import { projectItem } from './projector.ts'
import { materializeLocalPost } from './local.ts'

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
  ready: Promise<void>
  order: string[]
  // The background drain — the ONLY path that runs verification's network I/O.
  // The scheduler's poll tick calls it; exposed so a test can drive it explicitly.
  drainVerification(): Promise<void>
  stop(): Promise<void>
}

const ORPHAN_BATCH = 100

// The derived root of the chain ending at `id` (inclusive) — roots are derived,
// never stored authority (spec §4.1).
// ponytail: LOCKSTEP with local.ts's deriveRoot and store.ts's adminDeriveRoot
// — see the note in local.ts. Exported only for the behavioural canary in
// test/logical-lockstep.test.ts. Change one copy, change all three.
export function deriveRoot(tx: ReadTx, id: string): string {
  const parentOf = tx.prepare(`SELECT parent_logical_item_id FROM logical_items_v2 WHERE id = ?`)
  let root = id
  let cur: string | null = id
  for (let i = 0; i < 1000 && cur; i++) {
    root = cur
    const row = parentOf.get(cur) as { parent_logical_item_id: string | null } | undefined
    cur = row ? row.parent_logical_item_id : null
  }
  return root
}

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

function readActivation(tx: ReadTx): SourceModelV2Activation {
  const row = tx.prepare(
    `SELECT schema_version, state, last_activated_at, last_reconciled_at FROM logical_activation_v2 WHERE singleton = 1`,
  ).get() as { schema_version: 1; state: SourceModelV2Activation['state']; last_activated_at: string | null; last_reconciled_at: string | null }
  return { schemaVersion: row.schema_version, state: row.state, lastActivatedAt: row.last_activated_at, lastReconciledAt: row.last_reconciled_at }
}

// Materialize every pre-existing local post's bridge row so no UNMATERIALIZED
// local item survives activation (resolves the Task 3/8 carry: projectThread 404s
// on an unmaterialized legacy local post). Parent-before-child so each reply's
// parent FK holds; a post whose ancestry leaves the local `posts` table (e.g. a
// local reply to a remote/absent parent) is skipped — materializing it would
// FK-violate on the unconditional parent edge in local.ts (NOT a staged path).
function materializePreexistingLocalPosts(tx: WriteTx): void {
  const rows = tx.prepare(`SELECT id, in_reply_to_post_id FROM posts WHERE source = 'local'`).all() as
    { id: string; in_reply_to_post_id: string | null }[]
  const byId = new Map(rows.map((r) => [r.id, r]))
  const done = new Set<string>()
  const skip = new Set<string>()
  const ensure = (id: string): boolean => {
    if (done.has(id)) return true
    if (skip.has(id)) return false
    const post = byId.get(id)
    if (!post) { skip.add(id); return false } // parent is not a local post → not materializable here
    if (post.in_reply_to_post_id && !ensure(post.in_reply_to_post_id)) { skip.add(id); return false }
    materializeLocalPost(tx, id)
    done.add(id)
    return true
  }
  for (const r of rows) ensure(r.id)
}

function writeActivation(tx: WriteTx, state: SourceModelV2Activation['state'], lastActivatedAt: string | null, lastReconciledAt: string | null): void {
  tx.prepare(`UPDATE logical_activation_v2 SET state = ?, last_activated_at = ?, last_reconciled_at = ? WHERE singleton = 1`)
    .run(state, lastActivatedAt, lastReconciledAt)
}

// The ONE pre-listen activation transaction (spec §7.1). Local-state read,
// materialization, journal initialization, one reset, timestamps, and the
// transition to `active` all commit together — no application mutation intervenes.
export function activateLogicalV2(db: DatabaseContext, now: string): void {
  db.write((tx) => {
    const act = readActivation(tx)
    if (act.state === 'active') return // continuous-v2 restart: preserve generation + timestamps, append no reset
    materializePreexistingLocalPosts(tx)
    if (act.state === 'never_activated') {
      // First activation creates the reset generation + first reset atomically.
      reconstructJournal(tx, now)
      writeActivation(tx, 'active', now, act.lastReconciledAt)
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

// ---- worker composition + fail-closed decision (spec §5.6/§7.4, Appendix D) --

// The v1/v2 worker isolation decision. A configured-v2 process with no runtime
// (activation failed) fails closed; enabled installs NEITHER legacy poll nor legacy
// inbound push; disabled runs today's legacy behavior.
export function compose(input: { sourceModelV2: boolean; runtime: LogicalRuntime | null }): { legacyPoll: boolean; legacyPushIn: boolean } {
  if (input.sourceModelV2) {
    if (!input.runtime) throw new Error('logical-v2 runtime unavailable')
    return { legacyPoll: false, legacyPushIn: false }
  }
  return { legacyPoll: true, legacyPushIn: true }
}

export function createLogicalRuntime(input: {
  db: DatabaseContext
  store: LogicalStore
  acquisition: AcquisitionEngine
  config: { pollSeconds: number }
  now?: () => string
  notify?: (sequence: number) => void
  trace?: (phase: string) => void
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

  const scheduler = createScheduler({ store, acquisition: wrapped, config, now, drainVerification })
  trace('scheduler')
  trace('reconcile')
  trace('orphan')

  const ready = (async (): Promise<void> => {
    activateLogicalV2(db, now())
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
    ready,
    order,
    drainVerification,
    async stop() { scheduler.stop() },
  }
}
