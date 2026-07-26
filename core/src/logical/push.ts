import { randomBytes, randomUUID, createHmac, timingSafeEqual } from 'node:crypto'
import type { DatabaseContext } from './database.ts'
import type { LogicalStore } from './store.ts'
import type { Config } from '../config.ts'
import type { PushProtocol } from '../domain/types.ts'
import type { FeedDiscovery } from '../domain/ingest.ts'
import type { LookupFn } from '../domain/push-guard.ts'
import type { AcquisitionEngine } from './acquisition.ts'
import { checkCallbackUrl } from '../domain/push-guard.ts'
import { FETCH_TIMEOUT_MS } from '../domain/ingest.ts'
import { urlPort } from '../domain/feed.ts'
import { cloudScheme } from '../domain/push.ts'

// v1's H5 thin-ping floor (push-in.ts:75). The ONE value this module restates
// instead of importing: it is module-private there, and push-in.ts stays
// byte-identical until Task 11 relocates these helpers.
const THIN_PING_FLOOR_MS = 30_000

// The v2 inbound push lifecycle (V4 spec §1.1-1.3): v1's shape rebuilt over
// sources instead of users. Two states only (pending | active), registration
// from the latest successful run's capability claim, renewal riding the poll
// pass, and NO unsubscribe request ever — pause, block and unsubscribe-to-zero
// simply stop renewing and the lease lapses.
//
// The pure v1 helpers and every constant, RELOCATED here from domain/push-in.ts
// (V4 Task 11 step 1 of 3) — that module keeps its own byte-identical copies
// until Task 11's later step deletes the v1 runtime and the whole file.
const SIGNATURE_ALGOS = new Set(['sha1', 'sha256', 'sha384', 'sha512'])

// H1: the hub picks the algorithm. H2 handling lives at the caller.
export function verifySignature(body: string, secret: string, header: string | null): boolean {
  if (!header) return false
  const i = header.indexOf('=')
  if (i <= 0) return false
  const algo = header.slice(0, i).toLowerCase()
  const hex = header.slice(i + 1)
  if (!SIGNATURE_ALGOS.has(algo) || !/^[0-9a-f]+$/i.test(hex)) return false
  const expected = createHmac(algo, secret).update(body).digest()
  const given = Buffer.from(hex, 'hex')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export interface PushTarget { mode: PushProtocol; endpoint: string; topic: string }

export function choosePushTarget(discovery: FeedDiscovery, feedUrl: string): PushTarget | null {
  if (discovery.hubs.length > 0) {
    return { mode: 'websub', endpoint: discovery.hubs[0], topic: discovery.self ?? feedUrl }
  }
  if (discovery.cloud && discovery.cloud.protocol === 'http-post') {
    const { domain, port, path } = discovery.cloud
    return { mode: 'rsscloud', endpoint: `${cloudScheme(port)}://${domain}:${port}${path}`, topic: feedUrl }
  }
  return null
}

export const PENDING_TTL_MS = 600_000 // 10 min (spec H3)
export const WEBSUB_LEASE_SECONDS = 864000 // 10 days requested
export const WEBSUB_RENEW_HORIZON_MS = 86_400_000 // renew when < 1 day left
export const RSSCLOUD_TTL_MS = 90_000_000 // 25 h
export const RSSCLOUD_RENEW_HORIZON_MS = 7_200_000 // renew when < 2 h left
export const RENEW_RETRY_FLOOR_MS = 3_600_000 // retry a due renewal at most hourly, not every tick

export function pushInEffective(config: Config): boolean {
  return config.pushIn && config.publicUrl !== null
}

export type PushClaim = PushTarget // {mode, endpoint, topic} — the inert run evidence

export interface PushRowV2 {
  id: string
  sourceId: string
  mode: PushProtocol
  endpoint: string
  topic: string
  callbackToken: string
  secret: string | null
  state: 'pending' | 'active'
  expiresAt: string
  createdAt: string
}

// What the poll pass needs (scheduler.ts's dep). The scheduler never sees the
// callbacks below.
export interface PushLifecycle {
  hasActivePush(sourceId: string, now: string): boolean
  latestClaim(sourceId: string): PushClaim | null
  maybeRegister(sourceId: string, claim: PushClaim | null): Promise<void>
  renewDue(): Promise<void>
  purgeExpired(now: string): void
}

// The lifecycle PLUS the four public callbacks (spec §1.4). The callback shapes are
// v1's PushIn shapes verbatim, so api/app.ts's four routes need NO change — under
// v2 the server composition simply supplies these instead of createPushIn's
// (V2 §7.4: the v1 handlers are not routed).
export interface LogicalPush extends PushLifecycle {
  websubVerify(token: string, query: Record<string, string>): Promise<{ status: number; body: string }>
  websubDeliver(token: string, body: string, signatureHeader: string | null): Promise<number>
  rsscloudChallenge(url: string, challenge: string): Promise<{ status: number; body: string }>
  rsscloudPing(url: string): Promise<number>
}

// Stored capability JSON is attacker-influenced (it came from a remote feed), so
// this is TOTAL: it never throws, and anything that is not the pinned
// {mode,endpoint,topic} shape yields null plus one log line. SQL NULL — an
// absent claim — is not a fault and logs nothing.
export function parsePushCapability(json: string | null): PushClaim | null {
  if (json === null) return null
  try {
    const v = JSON.parse(json) as Record<string, unknown>
    if (v !== null && typeof v === 'object' && (v.mode === 'websub' || v.mode === 'rsscloud') && typeof v.endpoint === 'string' && typeof v.topic === 'string') {
      return { mode: v.mode, endpoint: v.endpoint, topic: v.topic }
    }
  } catch { /* fall through to the one log line */ }
  console.error(`push: ignoring malformed capability claim: ${json.slice(0, 200)}`)
  return null
}

export function createLogicalPush(deps: {
  db: DatabaseContext
  store: LogicalStore
  config: Config
  // REQUIRED: a callback that cannot acquire is a callback that silently drops
  // every delivery. The callbacks drive this engine — through the runtime's
  // drain-wrapping composition — so a ping takes exactly the poll's path.
  acquisition: AcquisitionEngine
  fetchFn?: typeof fetch
  lookupFn?: LookupFn
}): LogicalPush {
  const { db, store, config, acquisition } = deps
  const fetchFn = deps.fetchFn ?? fetch
  // H5: in-memory per-topic floor — a ping storm costs the attacker requests and us
  // nothing. ponytail: resets on restart, never pruned; a rate floor, not state.
  const lastThinFetch = new Map<string, number>()
  // The hourly per-row renewal floor, in-memory exactly like v1 (push-in.ts:174-177):
  // a due row against a dead hub would otherwise re-POST every poll pass.
  // ponytail: resets on restart and is never pruned — bounded by row count, it is
  // a rate floor, not state.
  const lastRenewAttempt = new Map<string, number>()

  // Registration eligibility composes the three existing axes (spec §1.3) —
  // enabled, not blocked, currently schedulable — which is EXACTLY V2's
  // schedulability predicate. Reused, never re-expressed.
  // ponytail: a full id list per check; a `WHERE id = ?` variant only if a poll
  // pass ever holds enough sources for this to show up.
  const eligible = (sourceId: string): boolean => store.listSchedulableSources().includes(sourceId)

  async function sendWebSubSubscribe(row: { endpoint: string; topic: string; callbackToken: string; secret: string | null }): Promise<void> {
    await fetchFn(row.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        'hub.mode': 'subscribe',
        'hub.topic': row.topic,
        'hub.callback': `${config.publicUrl}/websub/callback/${row.callbackToken}`,
        'hub.lease_seconds': String(WEBSUB_LEASE_SECONDS),
        'hub.secret': row.secret ?? '',
      }).toString(),
      redirect: 'manual', // the hub URL came from remote feed content
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  }

  async function sendRssCloudRegister(row: { endpoint: string; topic: string }): Promise<Response> {
    const pub = new URL(config.publicUrl as string)
    return fetchFn(row.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ notifyProcedure: '', port: String(urlPort(pub)), path: '/rsscloud/notify', protocol: 'http-post', url1: row.topic, domain: pub.hostname }).toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  }

  const write = (row: PushRowV2): void => { db.write((tx) => { store.upsertPushRow(tx, row) }) }

  async function register(sourceId: string, claim: PushClaim): Promise<void> {
    // The claim is remote evidence, so the SSRF gate revalidates it AT USE — a
    // private/loopback endpoint yields no row and no request.
    const gate = await checkCallbackUrl(claim.endpoint, deps.lookupFn)
    if (!gate.ok) {
      console.error(`push: rejecting advertised ${claim.mode} endpoint for source ${sourceId}: ${gate.reason}`)
      return
    }
    // R1 (v1 push-in.ts:79-83, verbatim): the stored token/secret ARE the
    // subscription's identity — generate ONLY when no (source, mode) row exists
    // at all, in any state, even expired.
    const prior = store.findPushRow({ sourceId, mode: claim.mode })
    const now = Date.now()
    const row: PushRowV2 = {
      id: prior?.id ?? randomUUID(),
      sourceId,
      mode: claim.mode,
      endpoint: claim.endpoint,
      topic: claim.topic,
      callbackToken: prior?.callbackToken ?? randomBytes(16).toString('hex'),
      secret: prior ? prior.secret : (claim.mode === 'websub' ? randomBytes(16).toString('hex') : null),
      state: 'pending',
      expiresAt: new Date(now + PENDING_TTL_MS).toISOString(), // H3: pending rows expire
      createdAt: prior?.createdAt ?? new Date(now).toISOString(),
    }
    if (claim.mode === 'websub') {
      write(row)
      await sendWebSubSubscribe(row)
      // The row flips to active when the hub's verification GET arrives (Task 3).
    } else {
      // Row BEFORE register (mirrors websub): the publisher's challenge GET
      // arrives while the register POST is still in flight and must find it.
      write(row)
      const res = await sendRssCloudRegister(row)
      if (res.ok) write({ ...row, state: 'active', expiresAt: new Date(Date.now() + RSSCLOUD_TTL_MS).toISOString() })
    }
  }

  return {
    hasActivePush(sourceId: string, now: string): boolean {
      return store.findPushRow({ sourceId }, { unexpiredAt: now, state: 'active' }) !== undefined
    },

    // Spec §1.1: registration acts only on the LATEST successful run's claim.
    // "Successful" = the run parsed a document, so a later 304 (which saw none)
    // cannot erase the claim, while a later parse supersedes it — an older run's
    // claim is inert evidence either way.
    latestClaim(sourceId: string): PushClaim | null {
      const row = db.read((tx) => tx.prepare(
        `SELECT push_capability_json FROM acquisition_runs_v2
         WHERE source_id = ? AND outcome IN ('parsed','completed_truncated')
         ORDER BY started_at DESC, id DESC LIMIT 1`,
      ).get(sourceId) as { push_capability_json: string | null } | undefined)
      return row ? parsePushCapability(row.push_capability_json) : null
    },

    // v1's maybeSubscribe (push-in.ts:149-164) rebuilt over sources.
    async maybeRegister(sourceId: string, claim: PushClaim | null): Promise<void> {
      try {
        if (!pushInEffective(config) || !claim) return
        if (!eligible(sourceId)) return
        // H3 gate: only an UNEXPIRED pending/active row blocks a new attempt —
        // except the rsscloud fallback when the feed now advertises a hub:
        // websub is preferred, so that combination upgrades instead of skipping.
        const existing = store.findPushRow({ sourceId }, { unexpiredAt: new Date().toISOString() })
        if (existing && !(existing.mode === 'rsscloud' && claim.mode === 'websub')) return
        await register(sourceId, claim)
      } catch (err) {
        console.error(`push: registration failed for source ${sourceId}:`, err instanceof Error ? err.message : err)
      }
    },

    // One sweep per poll pass (v1 push-in.ts:165-192). No unsubscribe is ever
    // sent: a row whose source is no longer eligible is simply left to lapse.
    async renewDue(): Promise<void> {
      try {
        if (!pushInEffective(config)) return
        const due = store.listRenewablePushRows(new Date(Date.now() + WEBSUB_RENEW_HORIZON_MS).toISOString())
        if (due.length === 0) return
        const schedulable = new Set(store.listSchedulableSources())
        for (const row of due) {
          if (!schedulable.has(row.sourceId)) continue // paused/blocked/unfollowed → let it lapse
          const last = lastRenewAttempt.get(row.id)
          if (last !== undefined && Date.now() - last < RENEW_RETRY_FLOOR_MS) continue
          lastRenewAttempt.set(row.id, Date.now())
          try {
            if (row.mode === 'websub') {
              await sendWebSubSubscribe(row)
            } else if (Date.parse(row.expiresAt) - Date.now() < RSSCLOUD_RENEW_HORIZON_MS) {
              const res = await sendRssCloudRegister(row)
              if (res.ok) write({ ...row, state: 'active', expiresAt: new Date(Date.now() + RSSCLOUD_TTL_MS).toISOString() })
            }
          } catch (err) {
            console.error(`push: renewal failed for ${row.topic}:`, err instanceof Error ? err.message : err)
          }
        }
      } catch (err) {
        console.error('push: renewal sweep failed:', err instanceof Error ? err.message : err)
      }
    },

    purgeExpired(now: string): void {
      db.write((tx) => { store.purgeExpiredPushRows(tx, now) })
    },

    // --- the four public callbacks (spec §1.4) ----------------------------
    // v1's handlers (push-in.ts:196-254) rebuilt over sources. Every hardening
    // rule v1 earned is kept: silent 202 on a bad HMAC, a neutral 200 no-op for
    // an unknown topic, the per-topic floor, and `denied` DELETES the row.

    async websubVerify(token: string, query: Record<string, string>): Promise<{ status: number; body: string }> {
      // State-agnostic: renewal re-verifications arrive while the row is active.
      const row = store.findPushRow({ token, mode: 'websub' })
      if (!row || query['hub.topic'] !== row.topic) return { status: 404, body: 'unknown subscription' }
      if (query['hub.mode'] === 'denied') {
        db.write((tx) => { store.deletePushRow(tx, row.id) })
        return { status: 200, body: 'ok' }
      }
      if (query['hub.mode'] !== 'subscribe' || !query['hub.challenge']) return { status: 404, body: 'unknown subscription' }
      const granted = Number(query['hub.lease_seconds'])
      const leaseSeconds = Number.isInteger(granted) && granted > 0 ? granted : WEBSUB_LEASE_SECONDS
      // A valid in-flight challenge completes even for a paused or blocked source —
      // answering avoids hub retries and leaks no state. It acquires nothing, and
      // renewDue's own eligibility filter still refuses to renew the lease.
      write({ ...row, state: 'active', expiresAt: new Date(Date.now() + leaseSeconds * 1000).toISOString() })
      // Upgrade complete: websub is live, so the rsscloud fallback row retires.
      const cloudRow = store.findPushRow({ sourceId: row.sourceId, mode: 'rsscloud' })
      if (cloudRow) db.write((tx) => { store.deletePushRow(tx, cloudRow.id) })
      return { status: 200, body: query['hub.challenge'] }
    },

    async websubDeliver(token: string, body: string, signatureHeader: string | null): Promise<number> {
      const row = store.findPushRow({ token, mode: 'websub' })
      if (!row) return 404
      try {
        // H2: verification failures are silent — 202, discard, log. Never 4xx.
        if (!row.secret || !verifySignature(body, row.secret, signatureHeader)) {
          console.error(`push: fat ping discarded for ${row.topic}: bad or missing signature`)
          return 202
        }
        // Paused or blocked (and unsubscribed-to-zero): authenticated, neutral 202,
        // the body neither parsed nor stored.
        if (!eligible(row.sourceId)) return 202
        // An in-flight acquisition owns this source; the delivery is discarded and
        // the next poll catches up (spec §1.4).
        if (acquisition.inFlight(row.sourceId)) {
          console.error(`push: fat ping discarded for ${row.topic}: an acquisition is already in flight`)
          return 202
        }
        await acquisition.acquireSource(row.sourceId, { kind: 'push', document: body })
      } catch (err) {
        console.error(`push: fat ping ingest failed for ${row.topic}:`, err instanceof Error ? err.message : err)
      }
      return 202
    },

    async rsscloudChallenge(url: string, challenge: string): Promise<{ status: number; body: string }> {
      const row = store.findPushRow({ mode: 'rsscloud', topic: url })
      if (!row) return { status: 404, body: 'unknown' }
      return { status: 200, body: `confirming ${challenge}` }
    },

    async rsscloudPing(url: string): Promise<number> {
      try {
        const row = store.findPushRow({ mode: 'rsscloud', topic: url }, { unexpiredAt: new Date().toISOString() })
        if (!row) return 200 // unknown topic: 200 no-op — no subscription-list oracle
        const last = lastThinFetch.get(url) ?? 0
        if (Date.now() - last < THIN_PING_FLOOR_MS) return 200 // H5 floor
        lastThinFetch.set(url, Date.now())
        if (!eligible(row.sourceId)) return 200 // paused or blocked: 200 without fetching
        if (acquisition.inFlight(row.sourceId)) return 200
        // Fire-and-forget: response latency must not distinguish subscribed topics
        // from unknown ones (the timing side of the no-oracle rule).
        void acquisition.acquireSource(row.sourceId, { kind: 'push', document: null }).catch((err: unknown) => {
          console.error(`push: thin ping ingest failed for ${url}:`, err instanceof Error ? err.message : err)
        })
      } catch (err) {
        console.error(`push: thin ping ingest failed for ${url}:`, err instanceof Error ? err.message : err)
      }
      return 200
    },
  }
}
