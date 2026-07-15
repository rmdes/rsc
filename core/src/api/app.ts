import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { bearerAuth } from './auth.ts'
import type { Service } from '../domain/service.ts'
import type { EventBus } from '../domain/bus.ts'

export function createApp(deps: { service: Service; bus: EventBus; token: string }): Hono {
  const { service, bus, token } = deps
  const app = new Hono()

  app.get('/health', (c) => c.json({ ok: true }))

  app.post('/users', async (c) => {
    const { handle, displayName, feedUrl } = await c.req.json()
    const user = await service.addRemoteUser({ handle, displayName, feedUrl })
    return c.json({ user }, 201)
  })

  app.post('/posts', bearerAuth(token), async (c) => {
    const { handle, displayName, content } = await c.req.json()
    const post = await service.createLocalPostAs(handle, displayName, content)
    return c.json({ post }, 201)
  })

  app.get('/timeline', async (c) => {
    const timeline = await service.getTimeline(100)
    return c.json({ timeline })
  })

  app.get('/timeline/stream', (c) =>
    streamSSE(c, async (stream) => {
      const off = bus.onNewPost((entry) => { void stream.writeSSE({ event: 'post', data: JSON.stringify(entry) }) })
      stream.onAbort(off)
      while (!stream.aborted) { await stream.sleep(15000); await stream.writeSSE({ event: 'ping', data: '' }) }
    }),
  )

  return app
}
