import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto'
import type { FeedDiscovery } from './ingest.ts'
import type { Repository } from './repository.ts'
import type { EventBus } from './bus.ts'
import type { Config } from '../config.ts'
import type { User, PushSubscription, PushProtocol } from './types.ts'
import { checkCallbackUrl } from './push-guard.ts'
import type { LookupFn } from './push-guard.ts'
import { ingestRemoteUser, parseFeedWithMeta, ingestItems } from './ingest.ts'

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
    return { mode: 'rsscloud', endpoint: `http://${domain}:${port}${path}`, topic: feedUrl }
  }
  return null
}

export const PENDING_TTL_MS = 600_000 // 10 min (spec H3)
export const WEBSUB_LEASE_SECONDS = 864000 // 10 days requested
export const WEBSUB_RENEW_HORIZON_MS = 86_400_000 // renew when < 1 day left
export const RSSCLOUD_TTL_MS = 90_000_000 // 25 h
export const RSSCLOUD_RENEW_HORIZON_MS = 7_200_000 // renew when < 2 h left
const PUSH_IN_TIMEOUT_MS = 10_000

export function pushInEffective(config: Config): boolean {
  return config.pushIn && config.publicUrl !== null
}

export interface PushIn {
  maybeSubscribe(user: User, discovery: FeedDiscovery): Promise<void>
  renewDue(): Promise<void>
  hasActivePush(userId: string): Promise<boolean>
  handleWebSubVerification(token: string, query: Record<string, string>): Promise<{ status: number; body: string }>
  handleFatPing(token: string, body: string, signatureHeader: string | null, io: { bus: EventBus }): Promise<number>
}

export interface PushInDeps {
  repo: Repository
  config: Config
  fetchFn?: typeof fetch
  lookupFn?: LookupFn
}

export function createPushIn(deps: PushInDeps): PushIn {
  const { repo, config } = deps
  const fetchFn = deps.fetchFn ?? fetch

  // R1 (spec §4.2): the stored row's token/secret are the subscription's
  // identity — generate ONLY when no (user, mode) row exists at all.
  async function tokenAndSecret(userId: string, mode: 'websub' | 'rsscloud'): Promise<{ token: string; secret: string | null; existing: PushSubscription | undefined }> {
    const existing = await repo.findPushSubscription({ userId, mode }) // any state, even expired
    if (existing) return { token: existing.callbackToken, secret: existing.secret, existing }
    return { token: randomBytes(16).toString('hex'), secret: mode === 'websub' ? randomBytes(16).toString('hex') : null, existing: undefined }
  }

  async function sendWebSubSubscribe(sub: { userId: string; endpoint: string; topic: string; token: string; secret: string | null }): Promise<void> {
    await fetchFn(sub.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        'hub.mode': 'subscribe',
        'hub.topic': sub.topic,
        'hub.callback': `${config.publicUrl}/websub/callback/${sub.token}`,
        'hub.lease_seconds': String(WEBSUB_LEASE_SECONDS),
        'hub.secret': sub.secret ?? '',
      }).toString(),
      redirect: 'manual', // hub URL came from remote feed content
      signal: AbortSignal.timeout(PUSH_IN_TIMEOUT_MS),
    })
  }

  async function sendRssCloudRegister(sub: { endpoint: string; topic: string }): Promise<Response> {
    const pub = new URL(config.publicUrl as string)
    const port = pub.port ? Number(pub.port) : pub.protocol === 'https:' ? 443 : 80
    return fetchFn(sub.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ notifyProcedure: '', port: String(port), path: '/rsscloud/notify', protocol: 'http-post', url1: sub.topic, domain: pub.hostname }).toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(PUSH_IN_TIMEOUT_MS),
    })
  }

  async function subscribe(user: User, target: PushTarget): Promise<void> {
    const gate = await checkCallbackUrl(target.endpoint, deps.lookupFn)
    if (!gate.ok) {
      console.error(`push-in: rejecting advertised ${target.mode} endpoint for ${user.handle}: ${gate.reason}`)
      return
    }
    const now = Date.now()
    const { token, secret, existing } = await tokenAndSecret(user.id, target.mode)
    if (target.mode === 'websub') {
      await repo.upsertPushSubscription({
        id: existing?.id ?? crypto.randomUUID(),
        userId: user.id, mode: 'websub', endpoint: target.endpoint, topic: target.topic,
        callbackToken: token, secret, state: 'pending',
        expiresAt: new Date(now + PENDING_TTL_MS).toISOString(), // H3: pending rows expire
        createdAt: existing?.createdAt ?? new Date(now).toISOString(),
      })
      await sendWebSubSubscribe({ userId: user.id, endpoint: target.endpoint, topic: target.topic, token, secret })
      // Row flips to active when the hub's verification GET arrives (Task 6).
    } else {
      const res = await sendRssCloudRegister({ endpoint: target.endpoint, topic: target.topic })
      if (res.ok) {
        await repo.upsertPushSubscription({
          id: existing?.id ?? crypto.randomUUID(),
          userId: user.id, mode: 'rsscloud', endpoint: target.endpoint, topic: target.topic,
          callbackToken: token, secret: null, state: 'active',
          expiresAt: new Date(now + RSSCLOUD_TTL_MS).toISOString(),
          createdAt: existing?.createdAt ?? new Date(now).toISOString(),
        })
      }
    }
  }

  return {
    async maybeSubscribe(user: User, discovery: FeedDiscovery): Promise<void> {
      try {
        if (!pushInEffective(config)) return
        const now = new Date().toISOString()
        // H3 gate: only an UNEXPIRED pending/active row blocks a new attempt.
        if (await repo.findPushSubscription({ userId: user.id }, { unexpiredAt: now })) return
        const target = choosePushTarget(discovery, user.feedUrl ?? '')
        if (!target || !user.feedUrl) return
        await subscribe(user, target)
      } catch (err) {
        console.error(`push-in subscribe failed for ${user.handle}:`, err instanceof Error ? err.message : err)
      }
    },
    async renewDue(): Promise<void> {
      try {
        if (!pushInEffective(config)) return
        const horizon = new Date(Date.now() + WEBSUB_RENEW_HORIZON_MS).toISOString()
        const due = await repo.listRenewablePushSubscriptions(horizon)
        for (const sub of due) {
          try {
            if (sub.mode === 'websub') {
              await sendWebSubSubscribe({ userId: sub.userId, endpoint: sub.endpoint, topic: sub.topic, token: sub.callbackToken, secret: sub.secret })
            } else if (Date.parse(sub.expiresAt) - Date.now() < RSSCLOUD_RENEW_HORIZON_MS) {
              const res = await sendRssCloudRegister({ endpoint: sub.endpoint, topic: sub.topic })
              if (res.ok) await repo.upsertPushSubscription({ ...sub, state: 'active', expiresAt: new Date(Date.now() + RSSCLOUD_TTL_MS).toISOString() })
            }
          } catch (err) {
            console.error(`push-in renewal failed for ${sub.topic}:`, err instanceof Error ? err.message : err)
          }
        }
      } catch (err) {
        console.error('push-in renewDue failed:', err instanceof Error ? err.message : err)
      }
    },
    async hasActivePush(userId: string): Promise<boolean> {
      return (await repo.findPushSubscription({ userId }, { unexpiredAt: new Date().toISOString(), state: 'active' })) !== undefined
    },
    async handleWebSubVerification(token: string, query: Record<string, string>): Promise<{ status: number; body: string }> {
      // State-agnostic (spec rev 3): renewal re-verifications arrive while active.
      const sub = await repo.findPushSubscription({ token, mode: 'websub' })
      if (!sub || query['hub.topic'] !== sub.topic) return { status: 404, body: 'unknown subscription' }
      if (query['hub.mode'] === 'denied') {
        await repo.deletePushSubscription(sub.id)
        return { status: 200, body: 'ok' }
      }
      if (query['hub.mode'] !== 'subscribe' || !query['hub.challenge']) return { status: 404, body: 'bad verification' }
      const granted = Number(query['hub.lease_seconds'])
      const leaseSeconds = Number.isInteger(granted) && granted > 0 ? granted : WEBSUB_LEASE_SECONDS
      await repo.upsertPushSubscription({ ...sub, state: 'active', expiresAt: new Date(Date.now() + leaseSeconds * 1000).toISOString() })
      return { status: 200, body: query['hub.challenge'] }
    },
    async handleFatPing(token: string, body: string, signatureHeader: string | null, io: { bus: EventBus }): Promise<number> {
      const sub = await repo.findPushSubscription({ token, mode: 'websub' })
      if (!sub) return 404
      try {
        // H2: verification failures are silent — 202, discard, log. Never 4xx.
        if (!sub.secret || !verifySignature(body, sub.secret, signatureHeader)) {
          console.error(`fat ping discarded for ${sub.topic}: bad or missing signature`)
          return 202
        }
        const user = await repo.getUser(sub.userId)
        if (!user) return 202
        const { items } = await parseFeedWithMeta(body)
        await ingestItems(repo, io.bus, user, items)
      } catch (err) {
        console.error(`fat ping ingest failed for ${sub.topic}:`, err instanceof Error ? err.message : err)
      }
      return 202
    },
  }
}

export async function runPollCycle(deps: { repo: Repository; bus: EventBus; config: Config; pushIn: PushIn; fetchFn?: typeof fetch }, tick: number): Promise<void> {
  const { repo, bus, pushIn } = deps
  const fetchFn = deps.fetchFn ?? fetch
  for (const user of await repo.listRemoteUsers()) {
    try {
      // ponytail: in-memory tick cadence — a restart polls everything, the safe direction.
      if (tick % 10 !== 0 && (await pushIn.hasActivePush(user.id))) continue
      const { discovery } = await ingestRemoteUser(repo, bus, user, fetchFn)
      await pushIn.maybeSubscribe(user, discovery)
    } catch (err) {
      console.error(`ingest failed for ${user.handle}:`, err instanceof Error ? err.message : err)
    }
  }
  await pushIn.renewDue()
  await repo.purgeExpiredSubscriptions(new Date().toISOString())
}
