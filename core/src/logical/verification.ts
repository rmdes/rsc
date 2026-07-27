import { randomUUID } from 'node:crypto'
import type { DatabaseContext, WriteTx } from './database.ts'
import { isPrivateIp } from '../domain/push-guard.ts'
import type { LookupFn } from '../domain/push-guard.ts'
import {
  BOUNDS, fetchBounded, readCappedBody, raceDeadline, DeadlineError, parseCandidates,
  type FetchCtx, type FetchResult,
} from './acquisition.ts'
import type { ResolveVerificationInput, VerificationFeedItem, NewObservationVersion, PermanentRedirectProof, ProjectionViewer } from './types.ts'
import { applyPresentation, applySelectionHints, getOrCreatePublisher, recordReconciliationFailure } from './reconcile.ts'
import { projectItem } from './projector.ts'
import { appendJournal } from './journal.ts'
import { appendItemAudit } from './moderation.ts'
import { isTombstoned } from './tombstones.ts'

// Bounded origin verification — SCHEDULING + the batched fetch (V3 Task 4, spec
// §7). A valid publisher (origin feed) URL first seen in an aggregate claim
// enqueues one check per (logical item, URL) and one batch job on V2's ONE
// reconciliation drain; the drain runs a single bounded fetch per URL and hands
// the parsed response to resolveVerificationBatch. OUTCOME handling (containment
// match, the verified rung, publisher aliases) is Task 5 — resolveVerificationBatch
// is a no-op stub here. Attempt counts and next-attempt times live ONLY on the
// job rows; the check row carries state + timestamps only.

// Bounds (spec §7.1, plan-adjustable). Each is pinned by a boundary test.
export const VERIFICATION_MAX_NEW_PER_RESPONSE = 25
export const VERIFICATION_MAX_PENDING_PER_PUBLISHER = 50
export const VERIFICATION_MAX_PENDING_PER_SOURCE = 200
export const VERIFICATION_RESPONSE_REUSE_MS = 10 * 60 * 1000

// Synchronous URL gate for scheduling (runs inside the reconcile write tx, so it
// cannot do DNS): http(s) only, no credentials, and reject IP-literal private
// hosts. The AUTHORITATIVE SSRF guard — DNS resolution on the initial URL AND on
// every redirect hop — runs at fetch time (checkFetchHop inside fetchBounded);
// a stored URL is never trusted. isPrivateIp returns false for domain names, so
// those pass here and are resolved at fetch time.
function normalizeVerificationUrl(raw: string): string | null {
  let u: URL
  try { u = new URL(raw) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (u.username || u.password) return null
  const host = u.hostname.replace(/^\[|\]$/g, '') // strip IPv6 brackets (mirrors checkCallbackUrl)
  if (host === 'localhost' || host.endsWith('.localhost')) return null
  if (isPrivateIp(host)) return null
  u.hash = ''
  return u.toString()
}

// Schedule one containment check per (logical item, publisher feed URL) plus at
// most one active batch job per batch key (spec §7.1). Called from V2
// reconciliation's aggregate-claim path when a valid publisher URL is first seen.
// The batch key is the normalized publisher feed URL. All caps hold exactly; a
// URL that fails normalization/SSRF, a re-seen (item, URL) pair, or a capped
// insertion creates NOTHING. Job dedup is an app-level check INSIDE this write
// transaction — the single Core process needs no lease.
export function scheduleVerification(
  tx: WriteTx,
  input: { logicalItemId: string; sourceId: string; publisherFeedUrl: string; now: string },
): void {
  const { logicalItemId, sourceId, now } = input
  const url = normalizeVerificationUrl(input.publisherFeedUrl)
  if (!url) return // fails normalization / sync SSRF gate

  // re-seeing a known (item, URL) pair creates nothing (UNIQUE also enforces it)
  if (tx.prepare(`SELECT 1 FROM verification_checks_v2 WHERE logical_item_id = ? AND publisher_feed_url = ?`).get(logicalItemId, url)) return

  // cap: at most 50 pending checks per publisher URL
  const perPublisher = (tx.prepare(`SELECT COUNT(*) AS n FROM verification_checks_v2 WHERE publisher_feed_url = ? AND state = 'pending'`).get(url) as { n: number }).n
  if (perPublisher >= VERIFICATION_MAX_PENDING_PER_PUBLISHER) return

  // cap: at most 200 pending checks per source
  const perSource = (tx.prepare(`SELECT COUNT(*) AS n FROM verification_checks_v2 WHERE source_id = ? AND state = 'pending'`).get(sourceId) as { n: number }).n
  if (perSource >= VERIFICATION_MAX_PENDING_PER_SOURCE) return

  // cap: at most 25 previously-unseen publisher URLs. The pinned signature carries
  // no run id, so "per aggregate response" is enforced as at most 25 DISTINCT
  // pending publisher URLs per source — a single response cannot exceed it, so the
  // spec bound (26 distinct URLs in one response ⇒ 25 checks) holds; it is a
  // strictly tighter ceiling across responses. ponytail: per-source distinct-URL
  // count; thread a run id only if per-poll (not per-source) accounting ever matters.
  const urlAlreadyPending = tx.prepare(`SELECT 1 FROM verification_checks_v2 WHERE source_id = ? AND publisher_feed_url = ? AND state = 'pending'`).get(sourceId, url)
  if (!urlAlreadyPending) {
    const distinctUrls = (tx.prepare(`SELECT COUNT(DISTINCT publisher_feed_url) AS n FROM verification_checks_v2 WHERE source_id = ? AND state = 'pending'`).get(sourceId) as { n: number }).n
    if (distinctUrls >= VERIFICATION_MAX_NEW_PER_RESPONSE) return
  }

  tx.prepare(
    `INSERT INTO verification_checks_v2 (id, logical_item_id, source_id, publisher_feed_url, batch_key, state, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL)`,
  ).run(randomUUID(), logicalItemId, sourceId, url, url, now)

  // one active drain job per batch key (app-level dedup inside this tx). The job
  // is the verification-ready shape V2 created: kind='verification',
  // verification_batch_key set, run_id/observation_version_id NULL. Attempts and
  // next-attempt times live here, never on the check.
  const activeJob = tx.prepare(`SELECT 1 FROM reconciliation_jobs_v2 WHERE kind = 'verification' AND verification_batch_key = ? AND status IN ('pending','processing','retrying') LIMIT 1`).get(url)
  if (!activeJob) {
    tx.prepare(
      `INSERT INTO reconciliation_jobs_v2 (id, kind, run_id, observation_version_id, verification_batch_key, status, attempts, next_attempt_at, failure_category, diagnostic, created_at)
       VALUES (?, 'verification', NULL, NULL, ?, 'pending', 0, ?, NULL, NULL, ?)`,
    ).run(randomUUID(), url, now, now)
  }
}

// ---- the bounded batched fetch (spec §7.1) ----------------------------------
// ONE fetch per batch key serves every pending check for that publisher URL,
// reusing V2's §1.5 network/bounds profile verbatim (10 s deadline, ≤5 redirects,
// 5 MiB decoded cap, SSRF + credential guard on EVERY hop via fetchBounded). A
// response fetched within the last 10 minutes serves newly queued checks without
// refetching, from an in-process cache.
// ponytail: in-process response cache; persist it only if verification ever
// outlives the process.

type FetchedOutcome = ResolveVerificationInput['outcome']

export interface VerificationRunnerDeps {
  db: DatabaseContext
  store: { resolveVerificationBatch(input: ResolveVerificationInput): void }
  fetchFn?: typeof fetch
  lookupFn?: LookupFn
  now?: () => string
}

export function createVerificationRunner(deps: VerificationRunnerDeps): {
  runVerificationBatch(claim: { kind: 'verification'; jobId: string; batchKey: string }, now: string): Promise<void>
} {
  const fetchFn = deps.fetchFn ?? fetch
  const cache = new Map<string, { fetchedAt: number; outcome: FetchedOutcome }>()

  async function runVerificationBatch(claim: { kind: 'verification'; jobId: string; batchKey: string }, now: string): Promise<void> {
    const batchKey = claim.batchKey

    // Paused/blocked targets are NEVER fetched (spec §7.1). The tombstone-hop
    // guard is Task 7 (blocked_source_tombstones_v2 is empty until purge; the
    // per-redirect isTombstoned check lands with acquisition's Task-7 seam).
    const blocked = deps.db.read((tx) => tx.prepare(
      `SELECT 1 FROM remote_sources_v2 WHERE canonical_url = ? AND (governance = 'blocked' OR operation = 'paused') LIMIT 1`,
    ).get(batchKey))
    if (blocked) {
      deps.store.resolveVerificationBatch({ claim, outcome: { kind: 'operational_failure', category: 'blocked_target', diagnostic: null }, now })
      return
    }

    // Every redirect hop is tombstone-checked (spec §5.1) exactly like acquisition:
    // a hop landing on a tombstoned URL is never fetched. Read-through per hop.
    const isTombstonedHop = (url: string): boolean => deps.db.read((tx) => isTombstoned(tx, url))

    let outcome: FetchedOutcome
    const cached = cache.get(batchKey)
    if (cached && Date.parse(now) - cached.fetchedAt < VERIFICATION_RESPONSE_REUSE_MS) {
      outcome = cached.outcome // reuse within the 10-minute window: no refetch
    } else {
      outcome = await fetchAndParse(batchKey, fetchFn, deps.lookupFn, now, isTombstonedHop)
      if (outcome.kind === 'fetched') cache.set(batchKey, { fetchedAt: Date.parse(now), outcome })
    }
    // Hand off to Task 5's outcome handler (stub today — it terminalizes the job,
    // evaluates containment for every pending check, and persists verified evidence).
    deps.store.resolveVerificationBatch({ claim, outcome, now })
  }

  return { runVerificationBatch }
}

async function fetchAndParse(url: string, fetchFn: typeof fetch, lookupFn: LookupFn | undefined, now: string, isTombstonedHop: (url: string) => boolean): Promise<FetchedOutcome> {
  const deadlineMs = BOUNDS.totalDeadlineMs
  // Verification owns no aliases and sends no conditional validators (always a
  // fresh fetch when uncached); the per-hop SSRF/credential guard is inside
  // fetchBounded. A neutral batch-scoped sourceId disables alias-ownership
  // collisions (verification does not own any source's redirect chain).
  const ctx: FetchCtx = {
    fetchFn, lookupFn, signal: AbortSignal.timeout(deadlineMs),
    sourceId: `verify:${url}`, ownedAliases: new Set<string>(), validators: null, aliasOwner: () => null,
    isTombstoned: isTombstonedHop,
  }
  let result: FetchResult
  try {
    result = await raceDeadline(fetchBounded(url, ctx), deadlineMs)
  } catch (err) {
    const timeout = err instanceof DeadlineError || (err instanceof Error && err.name === 'TimeoutError')
    return { kind: 'operational_failure', category: timeout ? 'timeout' : 'network', diagnostic: err instanceof Error ? err.message : 'fetch failed' }
  }
  if (result.kind !== 'response') {
    return { kind: 'operational_failure', category: result.kind, diagnostic: null }
  }
  const { body, exceeded } = await readCappedBody(result.res)
  if (exceeded || body == null) return { kind: 'operational_failure', category: 'body_limit', diagnostic: null }

  let parsed
  try {
    parsed = parseCandidates(body, result.effectiveUrl)
  } catch (err) {
    return { kind: 'operational_failure', category: 'feed_parse', diagnostic: err instanceof Error ? err.message : 'parse failed' }
  }

  // Map parsed candidates to the two convergence keys Task 5 matches on (exact
  // normalized permalink, or exact explicit opaque id). Evidence carries the
  // canonical material; Task 5 persists a direct-origin delivery under a
  // find-or-created source on a match.
  const parsedItems: VerificationFeedItem[] = parsed.candidates.map((c) => {
    const n = JSON.parse(c.normalizedJson) as { permalink: string | null }
    const evidence: NewObservationVersion = {
      id: randomUUID(), deliveryId: randomUUID(), wireOrdinal: c.wireOrdinal, arrivalAt: now,
      fingerprintVersion: BOUNDS.fingerprintVersion, fingerprint: c.fingerprint,
      canonicalMaterial: c.canonicalMaterial, rawEvidenceJson: c.rawEvidenceJson, normalizedJson: c.normalizedJson,
    }
    return { normalizedPermalink: n.permalink ?? null, opaqueId: c.keyKind === 'opaque' ? c.key : null, evidence }
  })
  // A proven permanent redirect of the publisher's own feed (spec §1.6) may
  // establish a publisher-feed alias in Task 5.
  const publisherRedirect = result.provenAliases.length > 0
    ? { fromUrl: url, toUrl: result.provenAliases[result.provenAliases.length - 1] }
    : null
  return { kind: 'fetched', parsedItems, publisherRedirect }
}

// ---- outcome handling (V3 Task 5, spec §4.2-4.3) ----------------------------
// Resolve a fetched verification batch into per-check verified/unverified outcomes
// inside the caller's ONE db.write() (store.resolveVerificationBatch wraps this).
// On a containment match: persist a direct-origin delivery + evidence under a
// find-or-created origin_verification source (governance INHERITED from the
// asserting aggregate — a verified origin of a quarantined aggregate is itself
// quarantined), a verified_origin publisher claim, one system-actor item-audit
// entry, and an inline hint recompute through the SHARED comparator. The §6
// journal upsert fires ONLY when the ordinary selection/author actually changed.
// A successful fetch with no match is terminal `unverified` (never contradicted,
// no retry); an operational failure rides the SHARED drain backoff and exhausts
// to `unverified` at eight attempts.

const ANON_VIEWER: ProjectionViewer = { localAccountId: null, activeSourceIds: [] }
// A valid empty AdminAcquisitionCounters JSON for the synthetic verification run.
// Exported (Task 6 review, narrow exception to "no live-path edits" — same
// exception taken in Task 0 for the canary): migration/convert.ts's synthetic
// run row needs the identical shape and shares this definition instead of a
// byte-copy, so the two can never drift apart.
export const EMPTY_COUNTERS = JSON.stringify({ candidates: 0, seen: 0, observed: 0, unchanged: 0, skipped: 0, omitted: 0, itemsTruncated: false, bodyLimitExceeded: false, notModified: false })

export function resolveVerificationBatch(tx: WriteTx, input: ResolveVerificationInput): void {
  const { claim, outcome, now } = input
  const batchKey = claim.batchKey

  if (outcome.kind === 'operational_failure') {
    // Shared drain backoff + eight-attempt exhaustion (reused verbatim). Terminalising
    // the still-pending checks on exhaustion lives INSIDE recordReconciliationFailure —
    // the one point every exhaustion path converges on, including the drain's catch.
    recordReconciliationFailure(tx, { jobId: claim.jobId, now, category: 'operational_exhausted', diagnostic: outcome.diagnostic, retryAt: null })
    return
  }

  const checks = tx.prepare(`SELECT id, logical_item_id, source_id FROM verification_checks_v2 WHERE batch_key = ? AND state = 'pending'`).all(batchKey) as { id: string; logical_item_id: string; source_id: string }[]
  let anyVerified = false
  let originSourceId: string | null = null
  let originPublisherId: string | null = null

  for (const check of checks) {
    const match = matchContainment(tx, check.logical_item_id, outcome.parsedItems)
    if (!match) {
      tx.prepare(`UPDATE verification_checks_v2 SET state = 'unverified', resolved_at = ? WHERE id = ?`).run(now, check.id)
      continue
    }
    if (originSourceId === null) {
      originSourceId = findOrCreateOriginSource(tx, batchKey, check.source_id, now)
      originPublisherId = getOrCreatePublisher(tx, batchKey, 'feed_anchored', now)
    }
    persistVerifiedDelivery(tx, { itemId: check.logical_item_id, sourceId: originSourceId, publisherId: originPublisherId!, match, commandId: `verify:${claim.jobId}:${check.id}`, batchKey, now })
    tx.prepare(`UPDATE verification_checks_v2 SET state = 'verified', resolved_at = ? WHERE id = ?`).run(now, check.id)
    anyVerified = true
  }

  // A proven permanent redirect of the publisher's OWN feed (spec §1.6) may
  // establish a publisher-feed alias — only when a verified direct origin was
  // actually established (an aggregate redirect never merges publishers).
  if (anyVerified && outcome.publisherRedirect) writePublisherFeedAlias(tx, outcome.publisherRedirect, originPublisherId!, now)

  tx.prepare(`UPDATE reconciliation_jobs_v2 SET status = 'reconciled' WHERE id = ?`).run(claim.jobId)
}

// Containment holds ONLY by the two convergence keys (spec §4.2): exact normalized
// permalink, or resolved (origin) publisher + exact explicit opaque id — never by
// title/timestamp/similarity. The item's stored identity keys are already the
// normalized forms the origin feed's normalized_json produces, so compare directly.
function matchContainment(tx: WriteTx, itemId: string, parsedItems: VerificationFeedItem[]): VerificationFeedItem | null {
  const permalinks = new Set((tx.prepare(`SELECT key FROM logical_identity_keys_v2 WHERE kind = 'permalink' AND logical_item_id = ?`).all(itemId) as { key: string }[]).map((r) => r.key))
  const opaques = new Set((tx.prepare(`SELECT key FROM logical_identity_keys_v2 WHERE logical_item_id = ? AND kind LIKE 'opaque:%'`).all(itemId) as { key: string }[]).map((r) => r.key))
  for (const p of parsedItems) {
    if (p.normalizedPermalink && permalinks.has(p.normalizedPermalink)) return p
    if (p.opaqueId && opaques.has(p.opaqueId)) return p
  }
  return null
}

// Find-or-create the direct-origin source keyed by the batch (origin feed) URL,
// with the foundation's verification defaults; governance INHERITED from the
// asserting aggregate source at creation time (found sources keep their state).
function findOrCreateOriginSource(tx: WriteTx, url: string, assertingSourceId: string, now: string): string {
  const existing = tx.prepare(`SELECT id FROM remote_sources_v2 WHERE canonical_url = ?`).get(url) as { id: string } | undefined
  if (existing) return existing.id
  const gov = (tx.prepare(`SELECT governance FROM remote_sources_v2 WHERE id = ?`).get(assertingSourceId) as { governance: string } | undefined)?.governance ?? 'allowed'
  const id = randomUUID()
  tx.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, 'single_publisher', 'enabled', ?, 'origin_verification', NULL, 0, ?)`,
  ).run(id, url, gov, now)
  return id
}

// Persist a fully-reconciled direct-origin delivery so the verified evidence
// participates in BOTH ordinary comparators (while its source is ordinary-eligible)
// and can supply displayed content: a synthetic terminal acquisition run, the
// delivery + its observation version, a reconciled observation job (so the version
// is ordinary-eligible), the delivery identity key + a baseline presentation entry,
// and a verified_origin publisher claim. Then a system-actor audit + inline hint
// recompute + the §6 journal effect.
function persistVerifiedDelivery(tx: WriteTx, a: { itemId: string; sourceId: string; publisherId: string; match: VerificationFeedItem; commandId: string; batchKey: string; now: string }): void {
  const { itemId, sourceId, publisherId, match, commandId, batchKey, now } = a
  const ev = match.evidence
  const keyKind = match.opaqueId ? 'opaque' : 'permalink'
  const key = match.opaqueId ?? match.normalizedPermalink ?? ev.deliveryId

  // Resolve-or-create the delivery + its version (mirrors acquisition's §2.2
  // classification). TWO logical items can match the SAME parsed origin entry —
  // matchContainment pools `opaque:%` across publisher scopes, which is what makes
  // an origin match possible at all — and a later batch can re-verify an entry
  // already persisted. Both must converge on the ONE row UNIQUE(source_id,
  // key_kind, key) allows: a second INSERT rolls the whole batch back and strands
  // its job at 'processing' (never re-claimable, and it blocks every future job for
  // that batch key). An already-present version is reused as-is; only genuinely new
  // origin material creates a run, a version, and a presentation entry.
  const existingDelivery = tx.prepare(`SELECT id FROM deliveries_v2 WHERE source_id = ? AND key_kind = ? AND key = ?`).get(sourceId, keyKind, key) as { id: string } | undefined
  const deliveryId = existingDelivery?.id ?? ev.deliveryId
  const existingVersion = tx.prepare(`SELECT id FROM observation_versions_v2 WHERE delivery_id = ? AND fingerprint_version = ? AND fingerprint = ?`).get(deliveryId, ev.fingerprintVersion, ev.fingerprint) as { id: string } | undefined
  const versionId = existingVersion?.id ?? ev.id

  if (!existingVersion) {
    const runId = randomUUID()
    tx.prepare(
      `INSERT INTO acquisition_runs_v2 (id, source_id, reason, status, started_at, acquisition_committed_at, completed_at, outcome, counters_json, failure_category, diagnostic, push_capability_json)
       VALUES (?, ?, 'scheduled', 'terminal', ?, ?, ?, 'parsed', ?, NULL, NULL, NULL)`,
    ).run(runId, sourceId, now, now, now, EMPTY_COUNTERS)

    if (existingDelivery) tx.prepare(`UPDATE deliveries_v2 SET last_seen_at = ?, last_seen_run_id = ?, seen_count = seen_count + 1 WHERE id = ?`).run(now, runId, deliveryId)
    else tx.prepare(`INSERT INTO deliveries_v2 (id, source_id, key_kind, key, first_seen_at, last_seen_at, last_seen_run_id, seen_count) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(deliveryId, sourceId, keyKind, key, now, now, runId)

    tx.prepare(
      `INSERT INTO observation_versions_v2 (id, delivery_id, fingerprint_version, fingerprint, canonical_material, arrival_at, run_id, wire_ordinal, last_seen_at, last_seen_run_id, seen_count, raw_evidence_json, normalized_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(versionId, deliveryId, ev.fingerprintVersion, ev.fingerprint, Buffer.from(ev.canonicalMaterial), now, runId, ev.wireOrdinal, now, runId, ev.rawEvidenceJson, ev.normalizedJson)

    // reconciled observation job → the version is ordinary-eligible immediately.
    tx.prepare(
      `INSERT INTO reconciliation_jobs_v2 (id, kind, run_id, observation_version_id, verification_batch_key, status, attempts, next_attempt_at, failure_category, diagnostic, created_at)
       VALUES (?, 'observation', ?, ?, NULL, 'reconciled', 0, ?, NULL, NULL, ?)`,
    ).run(randomUUID(), runId, versionId, now, now)

    // The presentation entry goes through the SHARED accepted-chain writer, so a
    // verified delivery's entry carries the same effective_updated_at/provenance,
    // the same unchanged-material suppression and the same rollback watermark an
    // acquisition-written entry does. The synthetic run above commits at `now`, so
    // that is this delivery's arrival.
    const mat = JSON.parse(Buffer.from(ev.canonicalMaterial).toString('utf8')) as { title: string | null; content: string | null; link: string | null; updated: string | null; inReplyTo: string | null }
    const norm = JSON.parse(ev.normalizedJson) as { permalink: string | null; enclosures: unknown[] }
    applyPresentation(tx, { version_id: versionId, delivery_id: deliveryId }, mat, norm, now, now)
  }

  // link the delivery to the logical item (the first matching item owns the key).
  tx.prepare(`INSERT OR IGNORE INTO logical_identity_keys_v2 (kind, key, logical_item_id) VALUES ('delivery', ?, ?)`).run(deliveryId, itemId)

  // the verified_origin author claim — the new strongest rung (spec §4.3).
  tx.prepare(`INSERT INTO publisher_claims_v2 (id, logical_item_id, publisher_id, source_id, observation_version_id, evidence_level, first_seen_at) VALUES (?, ?, ?, ?, ?, 'verified_origin', ?)`).run(randomUUID(), itemId, publisherId, sourceId, versionId, now)

  // ONE system-actor item-audit entry (Task 1's appendItemAudit, synthesized commandId).
  appendItemAudit(tx, { logicalItemId: itemId, commandId, actorId: null, actorKind: 'system', action: 'origin_verified', category: null, note: null, result: { kind: 'verified', sourceId, publisherId, batchKey }, now })

  // inline hint recompute through the SHARED comparator; §6 upsert only when the
  // ordinary selection/author actually changed AND the item is ordinarily visible
  // (a hidden/quarantined item emits no frame).
  const sel = applySelectionHints(tx, itemId, versionId)
  if ((sel.deliveryChanged || sel.publisherChanged) && projectItem(tx, itemId, ANON_VIEWER) !== undefined) {
    appendJournal(tx, { kind: 'upsert', logicalItemId: itemId, changeMask: sel.deliveryChanged ? 'presentation' : 'author' }, now)
  }
}

// A verified direct-origin permanent-chain proof establishes URL → origin publisher
// (spec §1.6/§4.3). A URL already mapped to a DIFFERENT publisher is a collision:
// record a conflict and merge nothing.
function writePublisherFeedAlias(tx: WriteTx, redirect: PermanentRedirectProof, publisherId: string, now: string): void {
  const url = redirect.toUrl
  const existing = tx.prepare(`SELECT publisher_id FROM publisher_feed_aliases_v2 WHERE url = ?`).get(url) as { publisher_id: string } | undefined
  if (existing) {
    if (existing.publisher_id !== publisherId) {
      tx.prepare(`INSERT INTO logical_conflicts_v2 (id, logical_item_id, observation_version_id, kind, evidence_json, created_at) VALUES (?, NULL, NULL, 'publisher_alias_collision', ?, ?)`)
        .run(randomUUID(), JSON.stringify({ url, existing: existing.publisher_id, attempted: publisherId }), now)
    }
    return
  }
  tx.prepare(`INSERT INTO publisher_feed_aliases_v2 (url, publisher_id, created_at) VALUES (?, ?, ?)`).run(url, publisherId, now)
}
