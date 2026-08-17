import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { createApp } from '../src/api/app.ts'
import type { FeedContext } from '../src/domain/feed.ts'
import { makeAuth, anonSession, registeredSession } from './auth-helper.ts'

// v2 thread envelope (spec §4.3): `nodes`, each an {kind:'item'} or a neutral
// {kind:'placeholder'} for a connective node the viewer may not see. The v1
// flat `thread` array is gone, so every assertion here reads nodes' item ids.
const itemIds = (env: { nodes: Array<{ kind: string; item?: { id: string } }> }) =>
  env.nodes.filter((n) => n.kind === 'item').map((n) => n.item!.id)

async function makeApp(feeds?: FeedContext) {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  const service = createService(repo, bus, feeds?.publicUrl ?? null, store)
  const app = createApp({
    service, bus, token: 'secret', auth: makeAuth(repo), users: repo, feeds,
    sources: { service: createSourceService(repo, feeds?.publicUrl ?? null), repo },
    logical: { store, acquisition: createAcquisition({ db }) },
  })
  return { app, repo, service }
}

test('reply compose: stores refs, resolves parent, thread endpoint returns the conversation', async () => {
  const { app } = await makeApp()
  const cookie = await anonSession(app)
  const auth = { 'content-type': 'application/json', cookie }
  const root = await (await app.request('/posts', { method: 'POST', headers: auth, body: JSON.stringify({ content: 'root post' }) })).json()
  const re = await (await app.request('/posts', { method: 'POST', headers: auth, body: JSON.stringify({ content: 'a reply', inReplyTo: root.post.id }) })).json()
  // v2 (logical/projector.ts:525 parentReplyRef): with no publicUrl the parent has no
  // permalink, so the wire ref is the parent's ID — which is exactly the
  // guid that parent's own feed advertises (logical-outbound-threading.test.ts:153).
  expect(re.post.inReplyTo).toBe(root.post.id)
  expect(re.post.inReplyToPostId).toBe(root.post.id)
  expect(re.post.threadRootId).toBe(root.post.id)
  // thread endpoint works from BOTH the root id and the reply id
  // Same-ms local posts tie on published_at and order by random id — assert
  // membership, not a total order (the contract suite pins ordering with distinct days).
  for (const id of [root.post.id, re.post.id]) {
    const t = await (await app.request(`/post/${id}/thread`)).json()
    expect(new Set(itemIds(t))).toEqual(new Set([root.post.id, re.post.id]))
  }
})

// v2 river (projector.ts:667-693): a conversation-entry lens carries roots and
// unresolved replies only — a RESOLVED reply never appears in /timeline, so the
// v1 shape (every reply present with replyCount 0) no longer exists. This is the
// same predicate the deleted `?top_level=1` test used to ask for explicitly.
test('the river carries roots with their reply counts and excludes resolved replies', async () => {
  const { app } = await makeApp()
  const cookie = await anonSession(app)
  const auth = { 'content-type': 'application/json', cookie }
  const root = await (await app.request('/posts', { method: 'POST', headers: auth, body: JSON.stringify({ content: 'root' }) })).json()
  await app.request('/posts', { method: 'POST', headers: auth, body: JSON.stringify({ content: 're one', inReplyTo: root.post.id }) })
  await app.request('/posts', { method: 'POST', headers: auth, body: JSON.stringify({ content: 're two', inReplyTo: root.post.id }) })
  const { timeline } = await (await app.request('/timeline')).json()
  const byContent = (c: string) => timeline.find((e: { content: string }) => e.content === c)
  // v2 DTO splits v1's single replyCount into direct/conversation counts.
  expect(byContent('root')).toMatchObject({ directReplyCount: 2, conversationReplyCount: 2 })
  expect(byContent('re one')).toBeUndefined()
  expect(byContent('re two')).toBeUndefined()
})

test('reply compose errors: unknown target 404; thread of unknown post 404', async () => {
  const { app } = await makeApp()
  const cookie = await anonSession(app)
  const res = await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ content: 'x', inReplyTo: 'ghost' }) })
  expect(res.status).toBe(404)
  expect((await app.request('/post/ghost/thread')).status).toBe(404)
})

// removeLocalPost (Task 11) keeps the row and rewrites its content to a removal
// notice, so projectItem now succeeds for it — projectThread stops emitting an
// 'unavailable' placeholder for the removed node (the notice replaces it, by
// design) and, critically, the thread must still surface the surviving replies
// rather than 404ing the whole conversation.
test('a thread rooted at a removed post still returns its replies; the notice replaces the placeholder', async () => {
  const { app, service } = await makeApp()
  const cookie = await anonSession(app)
  const auth = { 'content-type': 'application/json', cookie }
  const root = await (await app.request('/posts', { method: 'POST', headers: auth, body: JSON.stringify({ content: 'root post' }) })).json()
  const reply = await (await app.request('/posts', { method: 'POST', headers: auth, body: JSON.stringify({ content: 'a reply', inReplyTo: root.post.id }) })).json()

  expect(await service.deletePost(root.post.id, { kind: 'author' })).toEqual({ ok: true })

  const t = await (await app.request(`/post/${root.post.id}/thread`)).json()
  expect(t.nodes.map((n: { kind: string }) => n.kind)).toEqual(['item', 'item']) // no placeholder
  expect(new Set(itemIds(t))).toEqual(new Set([root.post.id, reply.post.id]))
  const rootNode = t.nodes.find((n: { item?: { id: string } }) => n.item?.id === root.post.id)
  expect(rootNode.item.content).toContain('removed by its author')
})

test('reply-to-reply threads to the TOP root', async () => {
  const { app } = await makeApp()
  const cookie = await anonSession(app)
  const auth = { 'content-type': 'application/json', cookie }
  const root = await (await app.request('/posts', { method: 'POST', headers: auth, body: JSON.stringify({ content: '1' }) })).json()
  const r1 = await (await app.request('/posts', { method: 'POST', headers: auth, body: JSON.stringify({ content: '2', inReplyTo: root.post.id }) })).json()
  const r2 = await (await app.request('/posts', { method: 'POST', headers: auth, body: JSON.stringify({ content: '3', inReplyTo: r1.post.id }) })).json()
  expect(r2.post.threadRootId).toBe(root.post.id) // not r1
  const t = await (await app.request(`/post/${root.post.id}/thread`)).json()
  expect(itemIds(t)).toHaveLength(3)
})

// GONE: 'GET /timeline?top_level=1 …'. top_level is a FORBIDDEN lens key in v2
// (logical-routes.ts:324) — every use of it is now one 400 'invalid lens',
// already pinned in logical-routes.test.ts:66. The river predicate that
// replaced it is covered by logical-feeds/logical-routes.

test('comments.xml serves direct replies; feed.xml advertises source:comments', async () => {
  const { app, repo } = await makeApp({ publicUrl: 'https://cast.example', hubUrl: null, rssCloud: false })
  const aliceCookie = await registeredSession(app, 'alice@test.example', repo)
  await app.request('/me', { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: aliceCookie }, body: JSON.stringify({ handle: 'alice', displayName: 'Alice' }) })
  const bobCookie = await anonSession(app)
  const root = await (await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie: aliceCookie }, body: JSON.stringify({ content: 'root' }) })).json()
  await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie: bobCookie }, body: JSON.stringify({ content: 'the reply', inReplyTo: root.post.id }) })
  const comments = await (await app.request(`/post/${root.post.id}/comments.xml`)).text()
  expect(comments).toContain('the reply')
  const feed = await (await app.request('/users/alice/feed.xml')).text()
  expect(feed).toContain(`<source:comments count="1" feedUrl="https://cast.example/post/${root.post.id}/comments.xml"/>`)
  expect((await app.request('/post/ghost/comments.xml')).status).toBe(404)
})
