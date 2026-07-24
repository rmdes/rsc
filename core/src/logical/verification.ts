import { randomUUID } from 'node:crypto'
import type { DatabaseContext, WriteTx } from './database.ts'
import { isPrivateIp } from '../domain/push-guard.ts'
import type { LookupFn } from '../domain/push-guard.ts'
import {
  BOUNDS, fetchBounded, readCappedBody, raceDeadline, DeadlineError, parseCandidates,
  type FetchCtx, type FetchResult,
} from './acquisition.ts'
import type { ResolveVerificationInput, VerificationFeedItem, NewObservationVersion } from './types.ts'

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

    let outcome: FetchedOutcome
    const cached = cache.get(batchKey)
    if (cached && Date.parse(now) - cached.fetchedAt < VERIFICATION_RESPONSE_REUSE_MS) {
      outcome = cached.outcome // reuse within the 10-minute window: no refetch
    } else {
      outcome = await fetchAndParse(batchKey, fetchFn, deps.lookupFn, now)
      if (outcome.kind === 'fetched') cache.set(batchKey, { fetchedAt: Date.parse(now), outcome })
    }
    // Hand off to Task 5's outcome handler (stub today — it terminalizes the job,
    // evaluates containment for every pending check, and persists verified evidence).
    deps.store.resolveVerificationBatch({ claim, outcome, now })
  }

  return { runVerificationBatch }
}

async function fetchAndParse(url: string, fetchFn: typeof fetch, lookupFn: LookupFn | undefined, now: string): Promise<FetchedOutcome> {
  const deadlineMs = BOUNDS.totalDeadlineMs
  // Verification owns no aliases and sends no conditional validators (always a
  // fresh fetch when uncached); the per-hop SSRF/credential guard is inside
  // fetchBounded. A neutral batch-scoped sourceId disables alias-ownership
  // collisions (verification does not own any source's redirect chain).
  const ctx: FetchCtx = {
    fetchFn, lookupFn, signal: AbortSignal.timeout(deadlineMs),
    sourceId: `verify:${url}`, ownedAliases: new Set<string>(), validators: null, aliasOwner: () => null,
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
