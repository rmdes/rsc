import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'

async function makeApp() {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  return createApp({ service, bus, token: 'secret' })
}

test('POST /posts requires the bearer token', async () => {
  const app = await makeApp()
  const res = await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', displayName: 'Alice', content: 'hi' }) })
  expect(res.status).toBe(401)
})

test('POST /posts then GET /timeline shows the post', async () => {
  const app = await makeApp()
  const post = await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: JSON.stringify({ handle: 'alice', displayName: 'Alice', content: 'hi there' }) })
  expect(post.status).toBe(201)
  const tl = await app.request('/timeline')
  const body = await tl.json()
  expect(body.timeline[0].content).toBe('hi there')
})

test('POST /users adds a remote user', async () => {
  const app = await makeApp()
  const res = await app.request('/users', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: JSON.stringify({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' }) })
  expect(res.status).toBe(201)
  expect((await res.json()).user.kind).toBe('remote')
})

test('POST /users requires the bearer token', async () => {
  const app = await makeApp()
  const res = await app.request('/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' }) })
  expect(res.status).toBe(401)
})

test('POST /users rejects a non-http(s) feedUrl', async () => {
  const app = await makeApp()
  const res = await app.request('/users', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: JSON.stringify({ handle: 'news', displayName: 'News', feedUrl: 'file:///etc/passwd' }) })
  expect(res.status).toBe(400)
})

test('POST /posts with a handle belonging to a remote user returns 400 with a JSON error', async () => {
  const app = await makeApp()
  await app.request('/users', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: JSON.stringify({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' }) })
  const res = await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: JSON.stringify({ handle: 'news', displayName: 'News', content: 'hi' }) })
  expect(res.status).toBe(400)
  expect((await res.json()).error).toBe('handle belongs to a remote user')
})
