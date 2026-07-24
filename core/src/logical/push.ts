import { randomBytes, randomUUID } from 'node:crypto'
import type { DatabaseContext } from './database.ts'
import type { LogicalStore } from './store.ts'
import type { Config } from '../config.ts'
import type { PushProtocol } from '../domain/types.ts'
import type { PushTarget } from '../domain/push-in.ts'
import type { LookupFn } from '../domain/push-guard.ts'
import { checkCallbackUrl } from '../domain/push-guard.ts'
import { FETCH_TIMEOUT_MS } from '../domain/ingest.ts'
import { urlPort } from '../domain/feed.ts'
import {
  pushInEffective, PENDING_TTL_MS, WEBSUB_LEASE_SECONDS, WEBSUB_RENEW_HORIZON_MS,
  RSSCLOUD_TTL_MS, RSSCLOUD_RENEW_HORIZON_MS, RENEW_RETRY_FLOOR_MS,
} from '../domain/push-in.ts'

// The v2 inbound push lifecycle (V4 spec §1.1-1.3): v1's shape rebuilt over
// sources instead of users. Two states only (pending | active), registration
// from the latest successful run's capability claim, renewal riding the poll
// pass, and NO unsubscribe request ever — pause, block and unsubscribe-to-zero
// simply stop renewing and the lease lapses.
//
// The pure v1 helpers and every constant are IMPORTED from domain/push-in.ts,
// never copied; that module stays byte-identical until Task 11 relocates them.

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

// What the poll pass needs (scheduler.ts's dep). Task 3 widens the factory's
// return with the four callback handlers; the scheduler never sees those.
export interface PushLifecycle {
  hasActivePush(sourceId: string, now: string): boolean
  latestClaim(sourceId: string): PushClaim | null
  maybeRegister(sourceId: string, claim: PushClaim | null): Promise<void>
  renewDue(): Promise<void>
  purgeExpired(now: string): void
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
  fetchFn?: typeof fetch
  lookupFn?: LookupFn
}): PushLifecycle {
  const { db, store, config } = deps
  const fetchFn = deps.fetchFn ?? fetch
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
  }
}
