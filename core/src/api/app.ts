import { Hono } from 'hono'
import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { bearerAuth } from './auth.ts'
import { parseCursor, formatCursor } from './cursor.ts'
import { DomainError } from '../domain/types.ts'
import { renderRssFeed, renderJsonFeed } from '../domain/feed.ts'
import type { FeedContext } from '../domain/feed.ts'
import type { Service } from '../domain/service.ts'
import type { EventBus } from '../domain/bus.ts'

function isValidFeedUrl(feedUrl: unknown): feedUrl is string {
  if (typeof feedUrl !== 'string') return false
  try {
    const protocol = new URL(feedUrl).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function isString(v: unknown, min: number, max: number): v is string {
  return typeof v === 'string' && v.length >= min && v.length <= max
}

async function readJsonBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    return await c.req.json()
  } catch {
    return null
  }
}

const REPLAY_CAP = 100

export interface PushApi {
  websub?: (form: Record<string, string>) => Promise<{ status: 202 | 400 | 404 | 429; error?: string }>
  rsscloud?: (form: Record<string, string>, requesterIp: string | null) => Promise<{ status: 202 | 400 | 404 | 429; error?: string }>
}

export interface PushInApi {
  websubVerify: (token: string, query: Record<string, string>) => Promise<{ status: number; body: string }>
  websubDeliver: (token: string, body: string, signature: string | null) => Promise<number>
  rsscloudChallenge?: (url: string, challenge: string) => Promise<{ status: number; body: string }>
  rsscloudPing?: (url: string) => Promise<number>
}

const MAX_FAT_PING_BYTES = 5 * 1024 * 1024

export function createApp(deps: { service: Service; bus: EventBus; token: string; feeds?: FeedContext; pushApi?: PushApi; pushInApi?: PushInApi }): Hono {
  const { service, bus, token } = deps
  const feeds: FeedContext = deps.feeds ?? { publicUrl: null, hubUrl: null, rssCloud: false }
  const app = new Hono()

  app.onError((err, c) => {
    if (err instanceof DomainError) return c.json({ error: err.message }, 400)
    console.error(err)
    return c.json({ error: 'internal error' }, 500)
  })

  app.get('/health', (c) => c.json({ ok: true }))

  app.post('/users', bearerAuth(token), async (c) => {
    const body = await readJsonBody(c)
    if (!body) return c.json({ error: 'body invalid' }, 400)
    const { handle, displayName, feedUrl } = body
    if (!isString(handle, 1, 64)) return c.json({ error: 'handle invalid' }, 400)
    if (displayName !== undefined && !isString(displayName, 0, 200)) return c.json({ error: 'displayName invalid' }, 400)
    if (!isString(feedUrl, 1, 2048) || !isValidFeedUrl(feedUrl)) return c.json({ error: 'feedUrl invalid' }, 400)
    const effectiveDisplayName = typeof displayName === 'string' && displayName.trim() !== '' ? displayName : handle
    const user = await service.addRemoteUser({ handle, displayName: effectiveDisplayName, feedUrl })
    return c.json({ user }, 201)
  })

  app.post('/posts', bearerAuth(token), async (c) => {
    const body = await readJsonBody(c)
    if (!body) return c.json({ error: 'body invalid' }, 400)
    const { handle, displayName, content } = body
    if (!isString(handle, 1, 64)) return c.json({ error: 'handle invalid' }, 400)
    if (displayName !== undefined && !isString(displayName, 0, 200)) return c.json({ error: 'displayName invalid' }, 400)
    if (!isString(content, 1, 100000)) return c.json({ error: 'content invalid' }, 400)
    const effectiveDisplayName = typeof displayName === 'string' && displayName.trim() !== '' ? displayName : handle
    const post = await service.createLocalPostAs(handle, effectiveDisplayName, content)
    return c.json({ post }, 201)
  })

  const FEED_LIMIT = 50

  async function resolveFeedUser(c: Context): Promise<{ user: import('../domain/types.ts').User } | Response> {
    const handle = (c.req.param('handle') ?? '').toLowerCase()
    const user = await service.getUserByHandle(handle)
    if (!user) return c.json({ error: 'unknown user' }, 404)
    if (user.kind === 'remote') {
      // Pass-through, not republishing. 302 (not 301): feedUrl is mutable.
      if (!user.feedUrl) return c.json({ error: 'unknown user' }, 404)
      return c.redirect(user.feedUrl, 302)
    }
    return { user }
  }

  app.get('/users/:handle/feed.xml', async (c) => {
    const r = await resolveFeedUser(c)
    if (r instanceof Response) return r
    const posts = await service.getPostsByAuthor(r.user.id, FEED_LIMIT)
    return c.body(renderRssFeed(r.user, posts, feeds), 200, { 'content-type': 'application/rss+xml; charset=utf-8' })
  })

  app.get('/users/:handle/feed.json', async (c) => {
    const r = await resolveFeedUser(c)
    if (r instanceof Response) return r
    const posts = await service.getPostsByAuthor(r.user.id, FEED_LIMIT)
    return c.body(renderJsonFeed(r.user, posts, feeds), 200, { 'content-type': 'application/feed+json; charset=utf-8' })
  })

  app.post('/hub', async (c) => {
    if (!deps.pushApi?.websub) return c.json({ error: 'not found' }, 404)
    const parsed = await c.req.parseBody()
    const form = Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'string')) as Record<string, string>
    const result = await deps.pushApi.websub(form)
    return c.json(result.error ? { error: result.error } : { ok: true }, result.status)
  })

  app.post('/rsscloud/pleaseNotify', async (c) => {
    if (!deps.pushApi?.rsscloud) return c.json({ error: 'not found' }, 404)
    const parsed = await c.req.parseBody()
    const form = Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'string')) as Record<string, string>
    const requesterIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null
    const result = await deps.pushApi.rsscloud(form, requesterIp)
    return c.json(result.error ? { error: result.error } : { ok: true }, result.status)
  })

  app.get('/websub/callback/:token', async (c) => {
    if (!deps.pushInApi) return c.json({ error: 'not found' }, 404)
    const query: Record<string, string> = {}
    for (const [k, v] of Object.entries(c.req.query())) if (typeof v === 'string') query[k] = v
    const r = await deps.pushInApi.websubVerify(c.req.param('token') ?? '', query)
    return c.text(r.body, r.status as 200 | 404)
  })

  app.post('/websub/callback/:token', async (c) => {
    if (!deps.pushInApi) return c.json({ error: 'not found' }, 404)
    const contentLength = Number(c.req.header('content-length') ?? '0')
    if (contentLength > MAX_FAT_PING_BYTES) return c.json({ error: 'too large' }, 413)
    const body = await c.req.text()
    if (Buffer.byteLength(body) > MAX_FAT_PING_BYTES) return c.json({ error: 'too large' }, 413)
    const status = await deps.pushInApi.websubDeliver(c.req.param('token') ?? '', body, c.req.header('x-hub-signature') ?? null)
    return c.json({ ok: status === 202 }, status as 202 | 404)
  })

  app.get('/timeline', async (c) => {
    const beforeRaw = c.req.query('before')
    let before
    if (beforeRaw !== undefined) {
      const parsed = parseCursor(beforeRaw)
      if (!parsed) return c.json({ error: 'before invalid' }, 400)
      before = parsed
    }
    const limitRaw = c.req.query('limit')
    let limit = 100
    if (limitRaw !== undefined) {
      const n = Number(limitRaw)
      if (!Number.isInteger(n)) return c.json({ error: 'limit invalid' }, 400)
      limit = Math.min(Math.max(n, 1), 100)
    }
    const timeline = await service.getTimeline(limit, before)
    const last = timeline[timeline.length - 1]
    // Known accepted edge: an exactly-limit final page yields a non-null cursor
    // whose next page is empty.
    const nextCursor = timeline.length === limit && last ? formatCursor({ publishedAt: last.publishedAt, id: last.id }) : null
    return c.json({ timeline, nextCursor })
  })

  app.get('/timeline/stream', (c) =>
    streamSSE(c, async (stream) => {
      // Subscribe BEFORE replay (spec H2): a post landing between the replay
      // query and the subscription must not be lost. Double-delivery is fine —
      // clients dedup by id.
      const off = bus.onNewPost((entry) => { void stream.writeSSE({ event: 'post', id: entry.id, data: JSON.stringify(entry) }) })
      stream.onAbort(off)
      const lastEventId = c.req.header('Last-Event-ID')
      if (lastEventId) {
        try {
          const anchorPost = await service.getPost(lastEventId)
          if (anchorPost) {
            // Inclusive scan (spec R1): the anchor and its same-created_at batch
            // re-deliver in full; the cap count includes the anchor row.
            const missed = await service.getTimelineAfter(anchorPost.createdAt, REPLAY_CAP + 1)
            if (missed.length <= REPLAY_CAP) {
              for (const entry of missed) {
                await stream.writeSSE({ event: 'post', id: entry.id, data: JSON.stringify(entry) })
              }
            }
            // else: too stale for patch-up — skip replay entirely; SSR is the recovery path (spec H4).
          }
        } catch (err) {
          // Replay is best-effort: a failed catch-up must never block going live.
          console.error('SSE replay failed:', err instanceof Error ? err.message : err)
        }
      }
      while (!stream.aborted) { await stream.sleep(15000); await stream.writeSSE({ event: 'ping', data: '' }) }
    }),
  )

  return app
}
