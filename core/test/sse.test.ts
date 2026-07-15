import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'

test('GET /timeline/stream emits an SSE "post" frame when a post is created', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const app = createApp({ service, bus, token: 'secret' })

  const res = await app.request('/timeline/stream')
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()

  // Give the stream a tick to subscribe, then emit.
  await new Promise((r) => setTimeout(r, 20))
  await service.createLocalPostAs('alice', 'Alice', 'live post')

  let buf = ''
  while (!buf.includes('event: post')) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value)
  }
  await reader.cancel()
  expect(buf).toContain('event: post')
  expect(buf).toContain('live post')
})
