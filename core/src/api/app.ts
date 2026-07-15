import { Hono } from 'hono'
import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { bearerAuth } from './auth.ts'
import { parseCursor, formatCursor } from './cursor.ts'
import { DomainError } from '../domain/types.ts'
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

export function createApp(deps: { service: Service; bus: EventBus; token: string }): Hono {
  const { service, bus, token } = deps
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
    const user = await service.addRemoteUser({ handle, displayName: displayName ?? handle, feedUrl })
    return c.json({ user }, 201)
  })

  app.post('/posts', bearerAuth(token), async (c) => {
    const body = await readJsonBody(c)
    if (!body) return c.json({ error: 'body invalid' }, 400)
    const { handle, displayName, content } = body
    if (!isString(handle, 1, 64)) return c.json({ error: 'handle invalid' }, 400)
    if (displayName !== undefined && !isString(displayName, 0, 200)) return c.json({ error: 'displayName invalid' }, 400)
    if (!isString(content, 1, 100000)) return c.json({ error: 'content invalid' }, 400)
    const post = await service.createLocalPostAs(handle, displayName ?? handle, content)
    return c.json({ post }, 201)
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
      const off = bus.onNewPost((entry) => { void stream.writeSSE({ event: 'post', id: entry.id, data: JSON.stringify(entry) }) })
      stream.onAbort(off)
      while (!stream.aborted) { await stream.sleep(15000); await stream.writeSSE({ event: 'ping', data: '' }) }
    }),
  )

  return app
}
