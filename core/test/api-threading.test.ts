import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'

async function makeApp() {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const app = createApp({ service, bus, token: 'secret' })
  return { app, repo, service }
}
const auth = { authorization: 'Bearer secret', 'content-type': 'application/json' }

test('reply compose: stores refs, resolves parent, thread endpoint returns the conversation', async () => {
  const { app } = await makeApp()
  const root = await (await app.request('/posts', { method: 'POST', headers: auth, body: JSON.stringify({ handle: 'alice', content: 'root post' }) })).json()
  const re = await (await app.request('/posts', { method: 'POST', headers: auth, body: JSON.stringify({ handle: 'bob', content: 'a reply', inReplyTo: root.post.id }) })).json()
  expect(re.post.inReplyTo).toBe(root.post.guid) // local posts have url null → ref falls to guid
  expect(re.post.inReplyToPostId).toBe(root.post.id)
  expect(re.post.threadRootId).toBe(root.post.id)
  // thread endpoint works from BOTH the root id and the reply id
  // Same-ms local posts tie on published_at and order by random id — assert
  // membership, not a total order (the contract suite pins ordering with distinct days).
  for (const id of [root.post.id, re.post.id]) {
    const t = await (await app.request(`/post/${id}/thread`)).json()
    expect(new Set(t.thread.map((e: { id: string }) => e.id))).toEqual(new Set([root.post.id, re.post.id]))
  }
})

test('reply compose errors: unknown target 404; thread of unknown post 404', async () => {
  const { app } = await makeApp()
  const res = await app.request('/posts', { method: 'POST', headers: auth, body: JSON.stringify({ handle: 'a', content: 'x', inReplyTo: 'ghost' }) })
  expect(res.status).toBe(404)
  expect((await app.request('/post/ghost/thread')).status).toBe(404)
})

test('reply-to-reply threads to the TOP root', async () => {
  const { app } = await makeApp()
  const root = await (await app.request('/posts', { method: 'POST', headers: auth, body: JSON.stringify({ handle: 'a', content: '1' }) })).json()
  const r1 = await (await app.request('/posts', { method: 'POST', headers: auth, body: JSON.stringify({ handle: 'b', content: '2', inReplyTo: root.post.id }) })).json()
  const r2 = await (await app.request('/posts', { method: 'POST', headers: auth, body: JSON.stringify({ handle: 'c', content: '3', inReplyTo: r1.post.id }) })).json()
  expect(r2.post.threadRootId).toBe(root.post.id) // not r1
  const t = await (await app.request(`/post/${root.post.id}/thread`)).json()
  expect(t.thread).toHaveLength(3)
})

test('comments.xml serves direct replies; feed.xml advertises source:comments', async () => {
  const { app } = await makeApp()
  // makeApp has no publicUrl — rebuild with one for this test
  const repo2 = await createSqliteRepository(':memory:')
  const bus2 = createEventBus()
  const service2 = createService(repo2, bus2)
  const app2 = createApp({ service: service2, bus: bus2, token: 'secret', feeds: { publicUrl: 'https://cast.example', hubUrl: null, rssCloud: false } })
  const root = await (await app2.request('/posts', { method: 'POST', headers: auth, body: JSON.stringify({ handle: 'alice', content: 'root' }) })).json()
  await app2.request('/posts', { method: 'POST', headers: auth, body: JSON.stringify({ handle: 'bob', content: 'the reply', inReplyTo: root.post.id }) })
  const comments = await (await app2.request(`/post/${root.post.id}/comments.xml`)).text()
  expect(comments).toContain('the reply')
  const feed = await (await app2.request('/users/alice/feed.xml')).text()
  expect(feed).toContain(`<source:comments count="1" feedUrl="https://cast.example/post/${root.post.id}/comments.xml"/>`)
  expect((await app2.request('/post/ghost/comments.xml')).status).toBe(404)
  void app // silence unused
})
