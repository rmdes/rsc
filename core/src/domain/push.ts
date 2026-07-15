import { createHmac, randomBytes } from 'node:crypto'
import type { Repository } from './repository.ts'
import type { Config } from '../config.ts'
import type { TimelineEntry } from './types.ts'
import { checkCallbackUrl } from './push-guard.ts'
import type { LookupFn } from './push-guard.ts'
import { feedUrls, renderRssFeed, renderJsonFeed, hubLinkUrl } from './feed.ts'
import type { User, Subscription } from './types.ts'

const PUSH_TIMEOUT_MS = 10_000

export interface Push {
  onLocalPost(entry: TimelineEntry): Promise<void>
}

export interface PushDeps {
  repo: Repository
  config: Config
  fetchFn?: typeof fetch
}

export const MAX_SUBS_PER_HOST = 20
export const MAX_SUBS_PER_TOPIC = 500
export const DEFAULT_LEASE_SECONDS = 864000 // 10 days
export const MAX_LEASE_SECONDS = 2592000 // 30 days

export interface RegistrationResult { status: 202 | 400 | 404 | 429; error?: string }

// H3: exact string equality against the re-minted URL of an existing LOCAL user.
export async function resolveLocalTopic(repo: Repository, publicUrl: string, topic: string): Promise<{ user: User; format: 'xml' | 'json' } | null> {
  const m = /^.*\/users\/([a-z0-9-]{1,64})\/feed\.(xml|json)$/.exec(topic)
  if (!m) return null
  const [, handle, format] = m
  const minted = format === 'xml' ? feedUrls(publicUrl, handle).xml : feedUrls(publicUrl, handle).json
  if (topic !== minted) return null
  const user = await repo.getUserByHandle(handle)
  if (!user || user.kind !== 'local') return null
  return { user, format: format as 'xml' | 'json' }
}

async function verifyWebSub(deps: Required<Pick<PushDeps, 'repo'>> & { fetchFn: typeof fetch }, mode: 'subscribe' | 'unsubscribe', topic: string, callback: string, callbackHost: string, secret: string | null, leaseSeconds: number): Promise<void> {
  try {
    const url = new URL(callback)
    const challenge = randomBytes(16).toString('hex')
    url.searchParams.set('hub.mode', mode)
    url.searchParams.set('hub.topic', topic)
    url.searchParams.set('hub.challenge', challenge)
    if (mode === 'subscribe') url.searchParams.set('hub.lease_seconds', String(leaseSeconds)) // H7: omitted on unsubscribe
    const res = await deps.fetchFn(url.toString(), { signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) })
    if (!res.ok || (await res.text()) !== challenge) return // no state change
    if (mode === 'subscribe') {
      await deps.repo.upsertSubscription({
        id: crypto.randomUUID(),
        protocol: 'websub',
        topic,
        callback,
        callbackHost,
        secret,
        expiresAt: new Date(Date.now() + leaseSeconds * 1000).toISOString(),
        createdAt: new Date().toISOString(),
      })
    } else {
      await deps.repo.deleteSubscription('websub', topic, callback)
    }
  } catch (err) {
    console.error('websub verification failed:', err instanceof Error ? err.message : err)
  }
}

export async function handleWebSubRequest(deps: PushDeps & { lookupFn?: LookupFn }, form: Record<string, string>): Promise<RegistrationResult> {
  const { repo, config } = deps
  const fetchFn = deps.fetchFn ?? fetch
  const mode = form['hub.mode']
  if (mode !== 'subscribe' && mode !== 'unsubscribe') return { status: 400, error: 'hub.mode invalid' }
  if (!config.publicUrl) return { status: 404, error: 'push not configured' }
  const topic = form['hub.topic'] ?? ''
  if (!(await resolveLocalTopic(repo, config.publicUrl, topic))) return { status: 404, error: 'unknown topic' }
  const callback = form['hub.callback'] ?? ''
  const gate = await checkCallbackUrl(callback, deps.lookupFn)
  if (!gate.ok) return { status: 400, error: gate.reason }
  const secret = form['hub.secret'] ?? null
  if (secret !== null && Buffer.byteLength(secret) >= 200) return { status: 400, error: 'hub.secret too long' }
  const leaseSeconds = Math.min(Number(form['hub.lease_seconds']) > 0 ? Math.floor(Number(form['hub.lease_seconds'])) : DEFAULT_LEASE_SECONDS, MAX_LEASE_SECONDS)
  if (mode === 'subscribe') {
    const now = new Date().toISOString()
    if ((await repo.countActiveSubscriptions({ callbackHost: gate.host }, now)) >= MAX_SUBS_PER_HOST) return { status: 429, error: 'too many subscriptions for this callback host' }
    if ((await repo.countActiveSubscriptions({ topic }, now)) >= MAX_SUBS_PER_TOPIC) return { status: 429, error: 'too many subscriptions for this topic' }
  }
  // 202 first, verification decides asynchronously (spec).
  void verifyWebSub({ repo, fetchFn }, mode, topic, callback, gate.host, secret, leaseSeconds)
  return { status: 202 }
}

async function deliverOnce(fetchFn: typeof fetch, callback: string, body: string, headers: Record<string, string>): Promise<void> {
  // Best-effort: one attempt + one immediate retry, then drop (spec ceiling).
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fetchFn(callback, { method: 'POST', headers, body, signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) })
      return
    } catch (err) {
      if (attempt === 1) console.error(`delivery to ${callback} dropped:`, err instanceof Error ? err.message : err)
    }
  }
}

async function publishPing(hubUrl: string, topic: string, fetchFn: typeof fetch): Promise<void> {
  await fetchFn(hubUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    // hub.url duplicates hub.topic for hub compatibility (websubhub.com et al).
    body: new URLSearchParams({ 'hub.mode': 'publish', 'hub.topic': topic, 'hub.url': topic }).toString(),
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
  })
}

export function createPush(deps: PushDeps): Push {
  const { repo, config } = deps
  const fetchFn = deps.fetchFn ?? fetch

  return {
    // Seam contract (spec H4): this method NEVER rejects. It runs inside a
    // synchronous EventEmitter dispatch with no global rejection handler —
    // an escape here is process-fatal.
    // ponytail: N rapid posts = N regenerations × M subscribers, no
    // coalescing; debounce per topic when it matters.
    async onLocalPost(entry: TimelineEntry): Promise<void> {
      try {
        if (entry.source !== 'local') return
        if (!config.publicUrl) return
        const pushEnabled = config.websub.mode !== 'off' || config.rssCloud
        if (!pushEnabled) return
        const topics = feedUrls(config.publicUrl, entry.author.handle)

        if (config.websub.mode === 'external') {
          for (const topic of [topics.xml, topics.json]) {
            try {
              await publishPing(config.websub.hubUrl, topic, fetchFn)
            } catch (err) {
              console.error(`websub publish ping failed for ${topic}:`, err instanceof Error ? err.message : err)
            }
          }
        }

        if (config.websub.mode === 'self') {
          const now = new Date().toISOString()
          const ctx = { publicUrl: config.publicUrl, hubUrl: hubLinkUrl(config.websub, config.publicUrl), rssCloud: config.rssCloud }
          const posts = await repo.getPostsByAuthor(entry.author.id, 50)
          for (const [format, topic] of [['xml', topics.xml], ['json', topics.json]] as const) {
            const subs = (await repo.listActiveSubscriptions(topic, now)).filter((s) => s.protocol === 'websub')
            if (subs.length === 0) continue
            // Body regenerated ONCE per topic per event; same body (and HMAC input) for every subscriber.
            const body = format === 'xml' ? renderRssFeed(entry.author, posts, ctx) : renderJsonFeed(entry.author, posts, ctx)
            const contentType = format === 'xml' ? 'application/rss+xml; charset=utf-8' : 'application/feed+json; charset=utf-8'
            for (const sub of subs) {
              const headers: Record<string, string> = {
                'content-type': contentType,
                link: `<${topic}>; rel="self", <${ctx.hubUrl}>; rel="hub"`,
              }
              if (sub.secret) headers['x-hub-signature'] = 'sha256=' + createHmac('sha256', sub.secret).update(body).digest('hex')
              await deliverOnce(fetchFn, sub.callback, body, headers)
            }
          }
        }
      } catch (err) {
        console.error('push dispatch failed:', err instanceof Error ? err.message : err)
      }
    },
  }
}
