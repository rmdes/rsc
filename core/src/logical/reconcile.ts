import { randomUUID } from 'node:crypto'
import type { WriteTx } from './database.ts'
import type { ReconciliationClaim, ReconcileClaimInput, ReconcileResult, RecordJobFailureInput, NormalizedReplyReference } from './types.ts'
import type { FanoutClaim, FanoutBatchResult } from './fanout.ts'
import { appendJournal } from './journal.ts'
import { resolveInitialParent, scheduleOrphanWork } from './threading.ts'
import { materializeLocalPost } from './local.ts'
import { scheduleVerification } from './verification.ts'
import { normalizePermalink } from './roots.ts'
import {
  compareFirstArrival, selectDisplayDelivery, selectAuthor,
  normalizePublisherName, presentationFingerprint, nextPresentationEntry, normalizeUtc,
  isStructuralTombstone,
  type EvidenceLevel, type FirstArrival, type DeliveryCandidate, type AuthorCandidate,
} from './projector.ts'

// The in-process serial reconciliation drain (spec §2.3) plus the one bounded
// per-job transaction that converges an observation version into logical identity,
// publisher evidence, an accepted presentation chain, ancestry, selection hints,
// and a journal effect (spec §2.4-2.6, §3.2-3.3, §4.4). ONE write transaction per
// job; reads never depend on the stored hints (spec §3.1). Flag-off isolation is
// absolute — nothing runs unless the runtime (Task 10) wires it in.
//
// ponytail: serial drain, no lease/fence — leases only if reconciliation ever
// leaves the single Core process (spec §2.3, review rev 1 P6).

export const MAX_OPERATIONAL_ATTEMPTS = 8

// Operational retry backoff (spec §2.3): min(5s * 2^(attempt-1), 15 min). The
// longest scheduled delay under the eight-failure limit is 320s (attempt 7).
export function retryDelayMs(attempt: number): number {
  return Math.min(5000 * 2 ** (attempt - 1), 900_000)
}

// A deterministic invariant/data failure — terminal immediately (spec §2.3),
// distinct from an operational failure which retries with backoff.
export class ReconcileDataError extends Error {}

// ---- claim: pick the next eligible job (spec §2.3) --------------------------

interface CandidateRow {
  job_id: string; run_id: string; version_id: string; delivery_id: string
  committed_at: string; wire_ordinal: number; governance: string | null; next_attempt_at: string
}

// Take one job in (nextAttemptAt ASC, jobId ASC) order across BOTH kinds
// (observation and verification interleave by that order — no separate queue,
// spec §7.1). Observation jobs skip (a) a blocked/gone source — left, not failed
// (spec §2.3 supersession) — and (b) any job that is not the earliest
// non-terminal version of its delivery (first-arrival serialization). Verification
// jobs have no such gating (one active job per batch key is guaranteed at
// scheduling). Sets the chosen job 'processing' and returns the matching claim
// variant. The observation path is byte-identical to V2 when no verification job
// exists (verification adds nothing to the observation ordering).
export function claimReconciliation(tx: WriteTx, now: string): ReconciliationClaim | null {
  const rows = tx.prepare(
    `SELECT j.id AS job_id, j.run_id, j.observation_version_id AS version_id, v.delivery_id,
            r.acquisition_committed_at AS committed_at, v.wire_ordinal, s.governance, j.next_attempt_at
     FROM reconciliation_jobs_v2 j
     JOIN observation_versions_v2 v ON v.id = j.observation_version_id
     JOIN acquisition_runs_v2 r ON r.id = v.run_id
     JOIN deliveries_v2 d ON d.id = v.delivery_id
     LEFT JOIN remote_sources_v2 s ON s.id = d.source_id
     WHERE j.kind = 'observation' AND j.status IN ('pending','retrying') AND j.next_attempt_at <= ?
     ORDER BY j.next_attempt_at ASC, j.id ASC`,
  ).all(now) as CandidateRow[]

  const earlierSibling = tx.prepare(
    `SELECT 1 FROM reconciliation_jobs_v2 j2
       JOIN observation_versions_v2 v2 ON v2.id = j2.observation_version_id
       JOIN acquisition_runs_v2 r2 ON r2.id = v2.run_id
     WHERE v2.delivery_id = ? AND j2.kind = 'observation' AND j2.status IN ('pending','processing','retrying')
       AND ( r2.acquisition_committed_at < @c
          OR (r2.acquisition_committed_at = @c AND v2.run_id < @r)
          OR (r2.acquisition_committed_at = @c AND v2.run_id = @r AND v2.wire_ordinal < @w)
          OR (r2.acquisition_committed_at = @c AND v2.run_id = @r AND v2.wire_ordinal = @w AND v2.id < @v) )
     LIMIT 1`,
  )

  // The earliest ELIGIBLE observation candidate (first row surviving the skips).
  let obs: CandidateRow | null = null
  for (const row of rows) {
    if (row.governance == null || row.governance === 'blocked') continue // left (spec §2.3)
    const waits = earlierSibling.get(row.delivery_id, { c: row.committed_at, r: row.run_id, w: row.wire_ordinal, v: row.version_id })
    if (waits) continue // an earlier version of this delivery is still non-terminal
    obs = row
    break
  }

  // The earliest eligible verification job (one active per batch key by construction).
  const ver = tx.prepare(
    `SELECT id AS job_id, verification_batch_key AS batch_key, next_attempt_at
     FROM reconciliation_jobs_v2
     WHERE kind = 'verification' AND status IN ('pending','retrying') AND next_attempt_at <= ?
     ORDER BY next_attempt_at ASC, id ASC LIMIT 1`,
  ).get(now) as { job_id: string; batch_key: string; next_attempt_at: string } | undefined

  // Interleave by (nextAttemptAt ASC, jobId ASC); the earlier one wins.
  const verWins = ver && (!obs
    || ver.next_attempt_at < obs.next_attempt_at
    || (ver.next_attempt_at === obs.next_attempt_at && ver.job_id < obs.job_id))

  if (verWins && ver) {
    tx.prepare(`UPDATE reconciliation_jobs_v2 SET status = 'processing' WHERE id = ?`).run(ver.job_id)
    return { kind: 'verification', jobId: ver.job_id, batchKey: ver.batch_key }
  }
  if (obs) {
    tx.prepare(`UPDATE reconciliation_jobs_v2 SET status = 'processing' WHERE id = ?`).run(obs.job_id)
    return { kind: 'observation', jobId: obs.job_id, runId: obs.run_id, observationVersionId: obs.version_id }
  }
  return null
}

// The synchronous drain cannot run the async verification fetch, so it un-claims
// a verification job it happens to pick (setting it back to 'pending') and leaves
// it for the async drain. It ALSO nudges next_attempt_at one ms past `now`: a
// deferred verification job otherwise stays at the head of the (nextAttemptAt ASC,
// jobId ASC) order and claimReconciliation keeps returning IT, starving any
// observation job that sorts after it. Bumping it strictly past `now` drops it out
// of this sync pass's claimable set (WHERE next_attempt_at <= now), so observation
// and fan-out work is reached; the async drain (drainReconciliationAsync,
// runtime-wired in Task 10) re-claims it on a later `now`. Status stays 'pending'.
export function deferVerification(tx: WriteTx, jobId: string, now: string): void {
  const bumped = new Date(Date.parse(now) + 1).toISOString()
  tx.prepare(`UPDATE reconciliation_jobs_v2 SET status = 'pending', next_attempt_at = ? WHERE id = ? AND kind = 'verification' AND status = 'processing'`).run(bumped, jobId)
}

// ---- failure bookkeeping (spec §2.3): a separate small transaction -----------

export function recordReconciliationFailure(tx: WriteTx, input: RecordJobFailureInput): void {
  const row = tx.prepare(`SELECT attempts FROM reconciliation_jobs_v2 WHERE id = ?`).get(input.jobId) as { attempts: number } | undefined
  if (!row) return
  const next = row.attempts + 1
  if (input.category === 'invariant_or_data_failure' || next >= MAX_OPERATIONAL_ATTEMPTS) {
    tx.prepare(`UPDATE reconciliation_jobs_v2 SET status = 'failed', attempts = ?, next_attempt_at = ?, failure_category = ?, diagnostic = ? WHERE id = ?`)
      .run(next, input.now, input.category, input.diagnostic, input.jobId)
    // A terminally-failed VERIFICATION job must never strand its checks 'pending':
    // scheduling counts pending rows (spec §7.1 caps), so 25 stranded distinct URLs
    // block verification for that source forever. Terminalize here — the ONE point
    // every exhaustion path converges on (the outcome handler AND the drain's
    // catch), so no caller can reintroduce the strand. The subquery yields NULL for
    // an observation job (no batch key), which matches no row; scoping to
    // state = 'pending' keeps it idempotent with any earlier terminalisation.
    tx.prepare(
      `UPDATE verification_checks_v2 SET state = 'unverified', resolved_at = ?
       WHERE state = 'pending'
         AND batch_key = (SELECT verification_batch_key FROM reconciliation_jobs_v2 WHERE id = ? AND kind = 'verification')`,
    ).run(input.now, input.jobId)
    return
  }
  const at = input.retryAt ?? new Date(Date.parse(input.now) + retryDelayMs(next)).toISOString()
  tx.prepare(`UPDATE reconciliation_jobs_v2 SET status = 'retrying', attempts = ?, next_attempt_at = ?, failure_category = NULL, diagnostic = ? WHERE id = ?`)
    .run(next, at, input.diagnostic, input.jobId)
}

// ---- the one job transaction (spec §2.3-2.6, §3.2-3.3, §4.4) -----------------

interface VersionRow {
  version_id: string; delivery_id: string; source_id: string; key_kind: string; key: string
  committed_at: string; wire_ordinal: number; run_id: string
  canonical_material: Buffer; raw_evidence_json: string; normalized_json: string
}
interface Material { title: string | null; content: string | null; link: string | null; published: string | null; updated: string | null; inReplyTo: string | null; enclosures: unknown[] }

function identityOwner(tx: WriteTx, kind: string, key: string): string | null {
  const r = tx.prepare(`SELECT logical_item_id FROM logical_identity_keys_v2 WHERE kind = ? AND key = ?`).get(kind, key) as { logical_item_id: string } | undefined
  return r ? r.logical_item_id : null
}

function claimIdentity(tx: WriteTx, kind: string, key: string, itemId: string, now?: string): void {
  const inserted = tx.prepare(`INSERT OR IGNORE INTO logical_identity_keys_v2 (kind, key, logical_item_id) VALUES (?, ?, ?)`).run(kind, key, itemId).changes > 0
  // A NEW resolvable alias (permalink or scoped opaque — never the delivery
  // bookkeeping kind) schedules durable orphan work in the SAME transaction
  // (spec §4.2): replies routinely reconcile before their parents in
  // newest-first feeds, and without this producer the adoption worker never
  // runs and every such reply stays 'missing' forever.
  if (inserted && now !== undefined && kind !== 'delivery') scheduleOrphanWork(tx, { aliasKind: kind === 'permalink' ? 'permalink' : 'scoped_opaque', aliasKey: key, candidateHighWater: now, createdAt: now })
}

function recordConflict(tx: WriteTx, itemId: string | null, versionId: string, kind: string, evidence: unknown, now: string): void {
  tx.prepare(`INSERT INTO logical_conflicts_v2 (id, logical_item_id, observation_version_id, kind, evidence_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), itemId, versionId, kind, JSON.stringify(evidence), now)
}

// ponytail: keys on canonical_feed_url and hardcodes feed_anchored, ignoring
// attribution_mode (the accepted §2.4 debt). The V4 cutover now DEPENDS on this
// uniformity — conversion mints the same way (spec §3.2 amendment 2026-07-24) —
// so the eventual §2.4 fix must migrate publisher rows, not just change this
// function.
function getOrCreatePublisher(tx: WriteTx, canonicalUrl: string, now: string): string {
  const r = tx.prepare(`SELECT id FROM remote_publishers_v2 WHERE canonical_feed_url = ?`).get(canonicalUrl) as { id: string } | undefined
  if (r) return r.id
  const id = randomUUID()
  tx.prepare(`INSERT INTO remote_publishers_v2 (id, canonical_feed_url, identity_level, created_at) VALUES (?, ?, 'feed_anchored', ?)`).run(id, canonicalUrl, now)
  return id
}

// A local item (canonical local post, materialized or not) or a deleted-local
// marker owning this permalink — a remote echo may never create a second ordinary
// item or resurrect a marker (spec §2.6).
function localPermalinkOwner(tx: WriteTx, permalink: string): string | null {
  const marker = tx.prepare(`SELECT logical_item_id FROM logical_deleted_local_v2 WHERE canonical_permalink = ?`).get(permalink) as { logical_item_id: string } | undefined
  if (marker) return marker.logical_item_id
  const owner = identityOwner(tx, 'permalink', permalink)
  if (owner) {
    const local = tx.prepare(`SELECT 1 FROM logical_items_v2 WHERE id = ? AND origin = 'local'`).get(owner)
    if (local) return owner
  }
  // a local post whose bridge row is not yet materialized (spec §2.6)
  const post = tx.prepare(`SELECT id FROM posts WHERE url = ? AND source = 'local'`).get(permalink) as { id: string } | undefined
  return post ? post.id : null
}

function evidenceLevelFor(attributionMode: string): EvidenceLevel {
  return attributionMode === 'aggregate' ? 'aggregate_assertion' : 'bound_single_publisher'
}

function replyReference(inReplyTo: string | null, publisherId: string): NormalizedReplyReference | null {
  if (!inReplyTo) return null
  const perma = normalizePermalink(inReplyTo)
  if (perma) return { kind: 'permalink', key: perma, scope: null, raw: inReplyTo }
  return { kind: 'opaque', key: inReplyTo, scope: { kind: 'publisher', id: publisherId }, raw: inReplyTo }
}

export function reconcileClaim(tx: WriteTx, input: ReconcileClaimInput): ReconcileResult {
  const { claim, now } = input
  // The drain dispatches on kind; only observation claims reach here. Verification
  // claims run the async batched fetch (createVerificationRunner), never this path.
  if (claim.kind !== 'observation') throw new ReconcileDataError('reconcileClaim: expected an observation claim')
  const v = tx.prepare(
    `SELECT v.id AS version_id, v.delivery_id, d.source_id, d.key_kind, d.key,
            r.acquisition_committed_at AS committed_at, v.wire_ordinal, v.run_id,
            v.canonical_material, v.raw_evidence_json, v.normalized_json
     FROM observation_versions_v2 v
     JOIN deliveries_v2 d ON d.id = v.delivery_id
     JOIN acquisition_runs_v2 r ON r.id = v.run_id
     WHERE v.id = ?`,
  ).get(claim.observationVersionId) as VersionRow | undefined
  if (!v) throw new ReconcileDataError(`reconcile: observation version ${claim.observationVersionId} not found`)

  const source = tx.prepare(`SELECT canonical_url, attribution_mode, governance FROM remote_sources_v2 WHERE id = ?`).get(v.source_id) as { canonical_url: string; attribution_mode: string; governance: string } | undefined
  // Policy-generation supersession (spec §2.3): a blocked/gone source leaves the
  // job requeued and consumes no attempt. ponytail: blocked/missing IS the V2
  // supersession trigger (governance->blocked advances the generation, §3.7).
  if (!source || source.governance === 'blocked') {
    tx.prepare(`UPDATE reconciliation_jobs_v2 SET status = 'pending' WHERE id = ?`).run(claim.jobId)
    return { kind: 'superseded' }
  }

  const material = JSON.parse(v.canonical_material.toString('utf8')) as Material
  const normalized = JSON.parse(v.normalized_json) as { keyKind: string; key: string; permalink: string | null; inReplyTo: string | null; enclosures: unknown[]; originFeedUrl?: string | null }
  // raw_evidence title/sourceName may be inert digest-evidence objects when the
  // claim was over-limit (spec §1.5) — those are never presentable names.
  const raw = JSON.parse(v.raw_evidence_json) as { title: unknown; sourceName: unknown }
  const asName = (x: unknown): string | null => (typeof x === 'string' ? x : null)
  const arrival = v.committed_at
  const publisherId = getOrCreatePublisher(tx, source.canonical_url, now)

  // ---- convergence (spec §2.5) --------------------------------------------
  let targetId: string
  let outcome: 'reconciled' | 'conflicted' = 'reconciled'
  const home = identityOwner(tx, 'delivery', v.delivery_id)
  if (home) {
    targetId = home // a later version of an already-homed delivery
  } else {
    const permalinkKey = normalizePermalink(normalized.permalink)
    const opaqueGuid = v.key_kind === 'opaque' ? v.key : null
    const opaqueKind = `opaque:publisher:${publisherId}`

    // local-first: a canonical local permalink or deleted marker wins absolutely.
    if (permalinkKey) {
      const localId = localPermalinkOwner(tx, permalinkKey)
      if (localId) {
        // The conflict FK references logical_items_v2(id); a local post's bridge
        // row is unmaterialized by default (spec §2.6), so materialize it first
        // (idempotent, reuses Task 3's INSERT OR IGNORE path). The remote echo
        // merges nothing — no delivery key, no presentation, no second item.
        materializeLocalPost(tx, localId)
        recordConflict(tx, localId, v.version_id, 'local_permalink_collision', { permalink: permalinkKey, sourceId: v.source_id }, now)
        tx.prepare(`UPDATE reconciliation_jobs_v2 SET status = 'conflicted' WHERE id = ?`).run(claim.jobId)
        return { kind: 'conflicted', logicalItemId: localId }
      }
    }

    const byPermalink = permalinkKey ? identityOwner(tx, 'permalink', permalinkKey) : null
    const byOpaque = opaqueGuid ? identityOwner(tx, opaqueKind, opaqueGuid) : null

    if (byPermalink && byOpaque && byPermalink !== byOpaque) {
      // cross-key disagreement: isolated new item, claims NEITHER disputed key (§2.5)
      targetId = createRemoteItem(tx, v, material, normalized, arrival, publisherId, now)
      recordConflict(tx, targetId, v.version_id, 'cross_key_disagreement', { permalink: permalinkKey, opaque: opaqueGuid, byPermalink, byOpaque }, now)
      claimIdentity(tx, 'delivery', v.delivery_id, targetId)
      outcome = 'conflicted'
    } else {
      // A valid permalink governs: never fall through to publisher-opaque (§2.5).
      const resolved = permalinkKey ? byPermalink : byOpaque
      targetId = resolved ?? createRemoteItem(tx, v, material, normalized, arrival, publisherId, now)
      claimIdentity(tx, 'delivery', v.delivery_id, targetId)
      // claim every UNCONTESTED valid identity key atomically (§2.5)
      if (permalinkKey) {
        if (!byPermalink || byPermalink === targetId) claimIdentity(tx, 'permalink', permalinkKey, targetId, now)
        else recordConflict(tx, targetId, v.version_id, 'contested_permalink', { permalink: permalinkKey, owner: byPermalink }, now)
      }
      if (opaqueGuid) {
        if (!byOpaque || byOpaque === targetId) claimIdentity(tx, opaqueKind, opaqueGuid, targetId, now)
        else recordConflict(tx, targetId, v.version_id, 'contested_opaque', { opaque: opaqueGuid, owner: byOpaque }, now)
      }
    }
  }

  // ---- publisher name + mode-neutral claim (spec §2.4) --------------------
  const level = evidenceLevelFor(source.attribution_mode)
  // sourceName only: the adapters supply <source> attribution or the channel
  // title. An ITEM title is never a publisher name — falling back to it named
  // publishers after their latest post (a linkblog became "Interesting read
  // as always !"). No evidence → NULL → the projector's hostname fallback.
  const normalizedName = normalizePublisherName(asName(raw.sourceName))
  // A visible author change is a change in the publisher's observed name; a fresh
  // claim row with an unchanged name is not (the name/claim are always inserted).
  const prevName = tx.prepare(`SELECT normalized_name FROM publisher_names_v2 WHERE publisher_id = ? ORDER BY rowid DESC LIMIT 1`).get(publisherId) as { normalized_name: string | null } | undefined
  const nameChanged = !prevName || prevName.normalized_name !== normalizedName
  tx.prepare(`INSERT INTO publisher_names_v2 (id, publisher_id, source_id, observation_version_id, evidence_level, normalized_name, first_seen_at, effective) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`)
    .run(randomUUID(), publisherId, v.source_id, v.version_id, level, normalizedName, now)
  tx.prepare(`INSERT INTO publisher_claims_v2 (id, logical_item_id, publisher_id, source_id, observation_version_id, evidence_level, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), targetId, publisherId, v.source_id, v.version_id, level, now)

  // ---- origin verification scheduling (spec §7.1) -------------------------
  // An aggregate claim naming a valid origin feed URL (RSS <source url>) schedules
  // one containment check the first time this (item, URL) pair is seen; scheduling
  // is idempotent, capped, and SSRF-gated inside scheduleVerification. Single-
  // publisher claims and missing/invalid URLs schedule nothing.
  if (source.attribution_mode === 'aggregate' && normalized.originFeedUrl) {
    scheduleVerification(tx, { logicalItemId: targetId, sourceId: v.source_id, publisherFeedUrl: normalized.originFeedUrl, now })
  }

  // ---- structural-tombstone arrival guard (spec §5.3) ---------------------
  // A delivery homed to a structural tombstone is administrator-only evidence and
  // NEVER resurrects it: the name/claim above stay as admin evidence, but no
  // selection hint is written back onto the terminal row and no journal frame is
  // emitted (it is not ordinary-visible). A NEW delivery cannot reach here — a
  // tombstone's identity keys are stripped, so convergence creates a fresh item.
  const tombstoned = isStructuralTombstone(tx, targetId)

  // ---- accepted presentation chain (spec §4.4) ----------------------------
  const presentationChanged = applyPresentation(tx, v, material, normalized, arrival, now)

  // ---- selection hints (spec §3.1-3.2): recomputed, never trusted ---------
  const selection = tombstoned ? { deliveryChanged: false, publisherChanged: false } : applySelectionHints(tx, targetId, v.version_id)

  // ---- journal + job terminalisation --------------------------------------
  // Emit an upsert ONLY when something visible changed (spec §5.1), with a mask
  // reflecting what changed — otherwise a no-op re-reconcile churns the journal
  // and misfires SSE. Presentation/display-delivery reads as 'presentation';
  // an author-only change (selected publisher or its name) reads as 'author'. A
  // structural tombstone emits neither.
  if (!tombstoned && (presentationChanged || selection.deliveryChanged)) {
    appendJournal(tx, { kind: 'upsert', logicalItemId: targetId, changeMask: 'presentation' }, now)
  } else if (!tombstoned && (selection.publisherChanged || nameChanged)) {
    appendJournal(tx, { kind: 'upsert', logicalItemId: targetId, changeMask: 'author' }, now)
  }
  tx.prepare(`UPDATE reconciliation_jobs_v2 SET status = ? WHERE id = ?`).run(outcome, claim.jobId)
  return { kind: outcome, logicalItemId: targetId }
}

function createRemoteItem(tx: WriteTx, v: VersionRow, material: Material, normalized: { inReplyTo: string | null }, arrival: string, publisherId: string, now: string): string {
  const id = randomUUID()
  // immutable timelineSortAt (spec §3.3): pub time only when <= durable arrival.
  const pub = normalizeUtc(material.published)
  const timelineSortAt = pub && pub <= arrival ? pub : arrival
  tx.prepare(`INSERT INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, created_at) VALUES (?, 'remote', ?, 'none', NULL, NULL, NULL, ?)`)
    .run(id, timelineSortAt, now)
  // initial ancestry from the reply reference (spec §4.1)
  const reference = replyReference(normalized.inReplyTo, publisherId)
  const parent = resolveInitialParent(tx, { observationVersionId: v.version_id, reference, logicalItemId: id, now })
  if (parent.state === 'resolved') tx.prepare(`UPDATE logical_items_v2 SET parent_state = 'resolved', parent_logical_item_id = ? WHERE id = ?`).run(parent.parentLogicalItemId, id)
  else if (parent.state !== 'none') tx.prepare(`UPDATE logical_items_v2 SET parent_state = ? WHERE id = ?`).run(parent.state, id)
  return id
}

// Returns whether a new presentation entry was written (a visible content change).
// The ONE accepted-presentation-chain writer: origin verification routes its
// verified delivery through here too, so a verified entry is indistinguishable
// in shape from an acquisition-written one (§4.4 watermark/rollback included).
// The parameters are narrowed to what the chain actually reads, so callers that
// hold no full VersionRow/Material (verification) need synthesize neither.
export function applyPresentation(tx: WriteTx, v: { version_id: string; delivery_id: string }, material: { title: string | null; content: string | null; link: string | null; updated: string | null; inReplyTo: string | null }, normalized: { permalink: string | null; enclosures: unknown[] }, arrival: string, now: string): boolean {
  const top = tx.prepare(`SELECT sequence, material_fingerprint FROM presentation_entries_v2 WHERE delivery_id = ? ORDER BY sequence DESC LIMIT 1`).get(v.delivery_id) as { sequence: number; material_fingerprint: string } | undefined
  const wm = tx.prepare(`SELECT MAX(effective_updated_at) AS w FROM presentation_entries_v2 WHERE delivery_id = ? AND provenance = 'explicit'`).get(v.delivery_id) as { w: string | null }
  const fingerprint = presentationFingerprint({
    title: material.title, content: material.content, contentMarkdown: null,
    permalink: normalizePermalink(normalized.permalink), sourceLink: material.link,
    enclosures: (normalized.enclosures ?? []) as never, inReplyTo: material.inReplyTo,
  })
  const explicit = normalizeUtc(material.updated)
  const explicitUpdate = explicit && explicit <= arrival ? explicit : null
  const decision = nextPresentationEntry(
    { sequence: top ? top.sequence : -1, explicitWatermark: wm.w, topFingerprint: top ? top.material_fingerprint : null },
    { materialFingerprint: fingerprint, explicitUpdate, arrivalAt: arrival },
  )
  if (decision.entry) {
    tx.prepare(`INSERT INTO presentation_entries_v2 (delivery_id, sequence, observation_version_id, effective_updated_at, provenance, material_fingerprint) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(v.delivery_id, decision.entry.sequence, v.version_id, decision.entry.effectiveUpdatedAt, decision.entry.provenance, fingerprint)
  }
  if (decision.conflict === 'rollback') recordConflict(tx, null, v.version_id, 'presentation_rollback', { explicit }, now)
  return decision.entry != null
}

// Gather the item's candidate deliveries/claims and let the pure comparators pick
// the effective pointers (spec §3.2). These are OPTIMIZATION hints; ordinary reads
// re-derive from the same comparators (spec §3.1). Returns which pointers moved.
export function applySelectionHints(tx: WriteTx, itemId: string, currentVersionId: string): { deliveryChanged: boolean; publisherChanged: boolean } {
  const cur = tx.prepare(`SELECT selected_delivery_id, selected_publisher_id FROM logical_items_v2 WHERE id = ?`).get(itemId) as { selected_delivery_id: string | null; selected_publisher_id: string | null }
  const deliveryIds = (tx.prepare(`SELECT key FROM logical_identity_keys_v2 WHERE kind = 'delivery' AND logical_item_id = ?`).all(itemId) as { key: string }[]).map((r) => r.key)

  const deliveryCands: DeliveryCandidate[] = []
  for (const deliveryId of deliveryIds) {
    const meta = tx.prepare(`SELECT d.source_id, s.attribution_mode, s.governance FROM deliveries_v2 d JOIN remote_sources_v2 s ON s.id = d.source_id WHERE d.id = ?`).get(deliveryId) as { source_id: string; attribution_mode: string; governance: string } | undefined
    if (!meta || meta.governance !== 'allowed') continue // quarantined/blocked not ordinary-eligible (§3.2)
    const earliest = earliestEligibleVersion(tx, deliveryId, currentVersionId)
    if (!earliest) continue
    deliveryCands.push({ deliveryId, level: evidenceLevelFor(meta.attribution_mode), eligible: true, arrival: earliest })
  }
  const selectedDelivery = selectDisplayDelivery(deliveryCands, cur.selected_delivery_id)

  const authorRows = tx.prepare(
    `SELECT c.id AS claim_id, c.publisher_id, c.evidence_level, c.observation_version_id AS vid,
            r.acquisition_committed_at AS committed_at, v.run_id, v.wire_ordinal, s.governance, j.status
     FROM publisher_claims_v2 c
     JOIN observation_versions_v2 v ON v.id = c.observation_version_id
     JOIN acquisition_runs_v2 r ON r.id = v.run_id
     JOIN reconciliation_jobs_v2 j ON j.observation_version_id = v.id AND j.kind = 'observation'
     JOIN remote_sources_v2 s ON s.id = c.source_id
     WHERE c.logical_item_id = ?`,
  ).all(itemId) as { claim_id: string; publisher_id: string; evidence_level: EvidenceLevel; vid: string; committed_at: string; run_id: string; wire_ordinal: number; governance: string; status: string }[]
  const authorCands: AuthorCandidate[] = authorRows
    .filter((a) => a.governance === 'allowed' && (a.status === 'reconciled' || a.status === 'conflicted' || a.vid === currentVersionId))
    .map((a) => ({ claimId: a.claim_id, publisherId: a.publisher_id, level: a.evidence_level, eligible: true, arrival: { acquisitionCommittedAt: a.committed_at, runId: a.run_id, wireOrdinal: a.wire_ordinal, observationVersionId: a.vid } }))
  const selectedAuthor = selectAuthor(authorCands, cur.selected_publisher_id)

  const selectedPublisher = selectedAuthor ? selectedAuthor.publisherId : null
  tx.prepare(`UPDATE logical_items_v2 SET selected_delivery_id = ?, selected_publisher_id = ? WHERE id = ?`)
    .run(selectedDelivery, selectedPublisher, itemId)
  return { deliveryChanged: selectedDelivery !== cur.selected_delivery_id, publisherChanged: selectedPublisher !== cur.selected_publisher_id }
}

// The delivery's earliest ordinary-eligible version tuple: earliest by the durable
// first-arrival tuple among versions whose job is reconciled/conflicted (or the
// version in the current transaction).
function earliestEligibleVersion(tx: WriteTx, deliveryId: string, currentVersionId: string): FirstArrival | null {
  const rows = tx.prepare(
    `SELECT r.acquisition_committed_at AS committed_at, v.run_id, v.wire_ordinal, v.id AS vid, j.status
     FROM observation_versions_v2 v
     JOIN acquisition_runs_v2 r ON r.id = v.run_id
     JOIN reconciliation_jobs_v2 j ON j.observation_version_id = v.id AND j.kind = 'observation'
     WHERE v.delivery_id = ?`,
  ).all(deliveryId) as { committed_at: string; run_id: string; wire_ordinal: number; vid: string; status: string }[]
  const eligible = rows
    .filter((r) => r.status === 'reconciled' || r.status === 'conflicted' || r.vid === currentVersionId)
    .map((r): FirstArrival => ({ acquisitionCommittedAt: r.committed_at, runId: r.run_id, wireOrdinal: r.wire_ordinal, observationVersionId: r.vid }))
  if (eligible.length === 0) return null
  return eligible.reduce((a, b) => (compareFirstArrival(a, b) <= 0 ? a : b))
}

// ---- the serial drain (spec §2.3) -------------------------------------------

export interface Reconciler {
  claimReconciliation(now: string): ReconciliationClaim | null
  reconcileClaim(input: ReconcileClaimInput): ReconcileResult
  recordReconciliationFailure(input: RecordJobFailureInput): void
  // Policy fan-out shares this ONE drain (spec §4.1) — no second loop.
  claimFanout(now: string): FanoutClaim | null
  processFanoutBatch(input: { claim: FanoutClaim; now: string }): FanoutBatchResult
  // Verification (spec §7.1) rides the SAME claim ordering; the sync drain defers
  // it (async fetch), the async drain processes it.
  deferVerification(jobId: string, now: string): void
}

// One observation job: reconcile it, or record its failure. Returns whether it
// reached a reconciled/conflicted outcome (i.e. counts toward the drain total).
// Shared by both drains so the observation path is byte-identical.
function handleObservationClaim(store: Reconciler, claim: ReconciliationClaim, now: () => string): boolean {
  try {
    const result = store.reconcileClaim({ claim, now: now() })
    return result.kind !== 'superseded'
  } catch (err) {
    recordDrainFailure(store, claim.jobId, err, now)
    return false
  }
}

// The ONE way a drained job's throw is recorded: a data error fails it terminally,
// anything else backs it off and leaves it claimable. No throw may escape a drain —
// a job left at 'processing' can never be re-claimed.
function recordDrainFailure(store: Reconciler, jobId: string, err: unknown, now: () => string): void {
  const category = err instanceof ReconcileDataError ? 'invariant_or_data_failure' : 'operational_exhausted'
  const diagnostic = (err instanceof Error ? err.message : 'reconcile failed').slice(0, 500)
  store.recordReconciliationFailure({ jobId, now: now(), category, diagnostic, retryAt: null })
}

// Drain the whole eligible queue serially, one job at a time (spec §2.3). This
// SYNCHRONOUS drain processes observation + fan-out; it CANNOT run the async
// verification fetch, so it un-claims any verification job it picks (deferring it
// past `now`, see deferVerification) and leaves it for the async drain
// (drainReconciliationAsync, runtime-wired in Task 10). Once the only reconciliation
// claims left are verification jobs it already deferred, it FALLS THROUGH to
// fan-out/observation work instead of stopping — a deferred verification job must
// never starve fan-out (spec §4.1) or a later observation job. The observation path
// is byte-identical to V2 (no verification job exists in the V2 suites, so this
// drain never defers there). Returns the count of reconciled/conflicted jobs.
export function drainReconciliation(deps: { store: Reconciler; now: () => string }): number {
  const { store, now } = deps
  let done = 0
  const deferred = new Set<string>()
  for (;;) {
    let claim = store.claimReconciliation(now())
    if (claim && claim.kind === 'verification') {
      // ALWAYS un-claim: claimReconciliation already set the job 'processing', and a
      // job left there can never be re-claimed (the background drain reads only
      // pending/retrying). Under a real MOVING clock the drain re-reaches a job it
      // deferred one ms ago, so the cycled-back branch has to un-claim it too — a
      // frozen test clock never re-reaches it, which is what hid this.
      store.deferVerification(claim.jobId, now())
      if (!deferred.has(claim.jobId)) {
        deferred.add(claim.jobId)
        continue
      }
      claim = null // cycled back: only already-deferred verification jobs remain — reach fan-out below
    }
    if (claim) {
      if (handleObservationClaim(store, claim, now)) done++
      continue
    }
    // No processable reconciliation job — process fan-out on the SAME drain (spec
    // §4.1). One bounded batch per turn; 'progress' leaves the row 'running' and
    // the next turn re-claims it from the durable cursor. Jobs take priority.
    const fanout = store.claimFanout(now())
    if (fanout) {
      store.processFanoutBatch({ claim: fanout, now: now() })
      continue
    }
    break
  }
  return done
}

// The async drain (spec §7.1): the ONE drain that dispatches on claim.kind —
// observation reconciles synchronously (byte-identical), verification runs the
// bounded batched fetch, fan-out converges hints. Runtime wiring is Task 10; this
// is what the runtime should call so verification jobs are processed in the same
// (nextAttemptAt ASC, jobId ASC) order as observation jobs. runVerificationBatch
// is supplied by createVerificationRunner (it holds the response cache + fetch).
export async function drainReconciliationAsync(deps: {
  store: Reconciler
  now: () => string
  runVerificationBatch(input: { claim: { kind: 'verification'; jobId: string; batchKey: string }; now: string }): Promise<void>
}): Promise<number> {
  const { store, now } = deps
  let done = 0
  for (;;) {
    const claim = store.claimReconciliation(now())
    if (claim) {
      if (claim.kind === 'verification') {
        // A verification batch throw (a data collision, a parse/DB error) is
        // recorded exactly like an observation failure instead of escaping: an
        // escaped throw would strand the job at 'processing' — blocking every
        // future job for that batch key — for a single bad origin response. (It no
        // longer reaches startup: this drain rides the scheduler tick, whose catch
        // would log and swallow it; the strand is the reason to record it here.)
        try { await deps.runVerificationBatch({ claim, now: now() }) }
        catch (err) { recordDrainFailure(store, claim.jobId, err, now) }
        continue
      }
      if (handleObservationClaim(store, claim, now)) done++
      continue
    }
    const fanout = store.claimFanout(now())
    if (fanout) {
      store.processFanoutBatch({ claim: fanout, now: now() })
      continue
    }
    break
  }
  return done
}
