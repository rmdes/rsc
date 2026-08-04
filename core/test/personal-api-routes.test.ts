import { test, expect } from 'vitest'
import { Hono } from 'hono'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { mountPersonalApiRoutes } from '../src/api/logical-routes.ts'
import { ensureCoreUser } from '../src/api/auth.ts'
import { makeAuth, registeredSession, anonSession } from './auth-helper.ts'

// Same erasure api-key-plugin.test.ts / api-key-auth-middleware.test.ts hit:
// createAuth's `plugins: BetterAuthPlugin[]` widens every plugin so
// betterAuth()'s .api inference can't see apiKey()'s createApiKey.
interface ApiKeyCreation {
  createApiKey(input: {
    body: { configId?: string; userId?: string; permissions?: Record<string, string[]> }
  }): Promise<{ key: string; id: string }>
}

async function setup() {
  const repo = await createSqliteRepository(':memory:')
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  const bus = createEventBus()
  const auth = makeAuth(repo)
  const service = createService(repo, bus, null, store)

  const authApp = new Hono()
  authApp.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))
  const cookie = await registeredSession(authApp, 'reader@x.test', repo)
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  const authUserId = session!.user.id
  // Mint the core user the same way apiKeyAuth's first authed hit would
  // (ensureCoreUser is idempotent) — a real key owner already has a core
  // account from prior session activity by the time they mint a key.
  const me = await ensureCoreUser(repo, authUserId)
  const apiKeyApi = auth.api as unknown as ApiKeyCreation
  const key = (await apiKeyApi.createApiKey({ body: { configId: 'user', userId: authUserId, permissions: { timeline: ['read'], posts: ['read'] } } })).key!

  const app = new Hono()
  mountPersonalApiRoutes(app, { store, auth, users: repo, service, sourceService: createSourceService(repo, null) })
  return { app, key, service, repo, authUserId, me }
}

// Cast + call shared by every test that mints a key with custom
// permissions (posts:write here; the read-permission tests below use the
// existing `ApiKeyCreation` cast directly, matching the file's established
// style) — a thin wrapper around that same cast, not a new abstraction.
async function mintKey(auth: ReturnType<typeof makeAuth>, userId: string, permissions: Record<string, string[]>): Promise<string> {
  const apiKeyApi = auth.api as unknown as ApiKeyCreation
  return (await apiKeyApi.createApiKey({ body: { configId: 'user', userId, permissions } })).key!
}

test('GET /me/timeline requires an api key', async () => {
  const { app } = await setup()
  const res = await app.request('/me/timeline')
  expect(res.status).toBe(401)
})

test("GET /me/timeline returns posts by people the key's owner follows (the personal/home-timeline lens)", async () => {
  const { app, key, service, me } = await setup()
  const followedPost = await service.createLocalPostAs('alice', 'Alice', 'alice post')
  const alice = await service.getUserByHandle('alice')
  await service.addFollow(me, alice!)
  const res = await app.request('/me/timeline', { headers: { 'x-api-key': key } })
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(JSON.stringify(body)).toContain(followedPost.id)
})

test("GET /me/posts returns the key owner's own local posts", async () => {
  const { app, key, service, me } = await setup()
  // Post AS the key's own owner (createLocalPostAs mints/reuses by handle).
  const post = await service.createLocalPostAs(me.handle, me.displayName, 'my own post')
  const res = await app.request('/me/posts', { headers: { 'x-api-key': key } })
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(JSON.stringify(body)).toContain(post.id)
})

// POST /me/api-keys (the web settings page's create action) — cookie-authed,
// not apiKeyAuth: you can't authenticate a first key with a key you don't
// have yet. This route exists because better-auth's own REST /api-key/create
// endpoint throws SERVER_ONLY_PROPERTY on a `permissions` field for any real
// HTTP request (verified against the live server, not the plugin's docs) —
// permissions can only be set via the in-process auth.api.createApiKey call
// this route makes server-side.

// Lighter than setup() — a fresh registered session with no pre-minted key,
// since these tests are about the create route itself.
async function freshApp(email: string) {
  const repo = await createSqliteRepository(':memory:')
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  const bus = createEventBus()
  const auth = makeAuth(repo)
  const service = createService(repo, bus, null, store)
  const authApp = new Hono()
  authApp.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))
  const cookie = await registeredSession(authApp, email, repo)
  const app = new Hono()
  mountPersonalApiRoutes(app, { store, auth, users: repo, service, sourceService: createSourceService(repo, null) })
  return { app, cookie, auth, service, repo }
}

test('POST /me/api-keys requires a cookie session', async () => {
  const { app } = await setup()
  const res = await app.request('/me/api-keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x', permissions: { timeline: ['read'] } })
  })
  expect(res.status).toBe(401)
})

test('POST /me/api-keys rejects an anonymous/guest session (spec scopes self-serve keys to registered users)', async () => {
  const repo = await createSqliteRepository(':memory:')
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  const auth = makeAuth(repo)
  const service = createService(repo, createEventBus(), null, store)
  const authApp = new Hono()
  authApp.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))
  const cookie = await anonSession(authApp)
  const app = new Hono()
  mountPersonalApiRoutes(app, { store, auth, users: repo, service, sourceService: createSourceService(repo, null) })
  const res = await app.request('/me/api-keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'x', permissions: { timeline: ['read'] } })
  })
  expect(res.status).toBe(403)
})

test('POST /me/api-keys creates a scoped key that works against an apiKeyAuth route', async () => {
  const { app, cookie } = await freshApp('creator@x.test')
  const res = await app.request('/me/api-keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'my script', permissions: { timeline: ['read'] } })
  })
  expect(res.status).toBe(201)
  const body = await res.json()
  expect(body.key).toBeTruthy() // the plaintext key, returned exactly once
  expect(body.name).toBe('my script')

  // The created key must actually authenticate against apiKeyAuth-gated routes.
  const timelineRes = await app.request('/me/timeline', { headers: { 'x-api-key': body.key } })
  expect(timelineRes.status).toBe(200)
  // ...but was scoped to timeline:read only, so posts:read is refused (401).
  const postsRes = await app.request('/me/posts', { headers: { 'x-api-key': body.key } })
  expect(postsRes.status).toBe(401)
})

test('POST /me/api-keys rejects a permission outside the phase-2 whitelist', async () => {
  const { app, cookie } = await freshApp('scopetest@x.test')
  const res = await app.request('/me/api-keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'x', permissions: { write: ['create'] } })
  })
  expect(res.status).toBe(400)
})

test('POST /me/api-keys rejects a missing name', async () => {
  const { app, cookie } = await freshApp('noname@x.test')
  const res = await app.request('/me/api-keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ permissions: { timeline: ['read'] } })
  })
  expect(res.status).toBe(400)
})

// The apiKey plugin's real maximumNameLength default is 32 (installed source,
// @better-auth/api-key/dist/index.mjs — core/src/auth.ts's apiKey() config
// never overrides it). Before this route's own bound matched, a longer name
// reached the plugin's own check and threw a raw 500 past this route.
test("POST /me/api-keys cleanly rejects a name past the plugin's 32-char limit", async () => {
  const { app, cookie } = await freshApp('longname@x.test')
  const res = await app.request('/me/api-keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'a'.repeat(40), permissions: { timeline: ['read'] } })
  })
  expect(res.status).toBe(400)
})

// isValidKeyPermissions used to index ALLOWED_KEY_PERMISSIONS with a bare
// `[resource]` lookup — a resource name that collides with an inherited
// Object.prototype member (e.g. "toString") resolved to that member instead
// of undefined, and the subsequent `.includes` call threw a TypeError that
// surfaced as a raw 500. No key is minted either way; this only asserts the
// response is a clean 400.
test('POST /me/api-keys cleanly rejects a permissions object with an Object.prototype-colliding key', async () => {
  const { app, cookie } = await freshApp('crafted@x.test')
  const res = await app.request('/me/api-keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'x', permissions: { toString: ['read'] } })
  })
  expect(res.status).toBe(400)
})

test('a key with only timeline:read cannot reach /me/posts (posts:read required)', async () => {
  const repo = await createSqliteRepository(':memory:')
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  const auth = makeAuth(repo)
  const service = createService(repo, createEventBus(), null, store)
  const authApp = new Hono()
  authApp.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))
  const cookie = await registeredSession(authApp, 'timelineonly@x.test', repo)
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  const apiKeyApi = auth.api as unknown as ApiKeyCreation
  const key = (await apiKeyApi.createApiKey({ body: { configId: 'user', userId: session!.user.id, permissions: { timeline: ['read'] } } })).key!
  const app = new Hono()
  mountPersonalApiRoutes(app, { store, auth, users: repo, service, sourceService: createSourceService(repo, null) })
  const res = await app.request('/me/posts', { headers: { 'x-api-key': key } })
  expect(res.status).toBe(401)
})

// --- POST/PATCH/DELETE /me/posts (posts:write, phase 3 task 1) -----------
// POST/PATCH are key-authed twins of app.ts's cookie-authed `POST /posts` /
// `PATCH /posts/:id`. DELETE is a genuinely new self-serve capability —
// until now only an admin could hard-delete any post (`DELETE
// /admin/posts/:id`); this scopes the exact same service.deletePost to the
// caller's OWN post via the same ownership check PATCH already uses.

test('POST /me/posts creates a post as the key owner (posts:write)', async () => {
  const { app, cookie, auth } = await freshApp('poster@x.test')
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  const key = await mintKey(auth, session!.user.id, { posts: ['write'] })
  const res = await app.request('/me/posts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ content: 'hello from the api' })
  })
  expect(res.status).toBe(201)
  const body = await res.json()
  expect(body.post.content).toBe('hello from the api')
})

test('POST /me/posts requires posts:write, not posts:read', async () => {
  const { app, cookie, auth } = await freshApp('readonly-poster@x.test')
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  const key = await mintKey(auth, session!.user.id, { posts: ['read'] })
  const res = await app.request('/me/posts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ content: 'should not be created' })
  })
  expect(res.status).toBe(401)
})

test("PATCH /me/posts/:id edits only the key owner's own post", async () => {
  // Two owners sharing one app/db (freshApp only mints one user per call).
  const repo = await createSqliteRepository(':memory:')
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  const service = createService(repo, createEventBus(), null, store)
  const auth = makeAuth(repo)
  const authApp = new Hono()
  authApp.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))
  const cookieA = await registeredSession(authApp, 'edit-ownerA@x.test', repo)
  const cookieB = await registeredSession(authApp, 'edit-ownerB@x.test', repo)
  const sessionA = await auth.api.getSession({ headers: new Headers({ cookie: cookieA }) })
  const sessionB = await auth.api.getSession({ headers: new Headers({ cookie: cookieB }) })
  const keyA = await mintKey(auth, sessionA!.user.id, { posts: ['write'] })
  const keyB = await mintKey(auth, sessionB!.user.id, { posts: ['write'] })
  const app = new Hono()
  mountPersonalApiRoutes(app, { store, auth, users: repo, service, sourceService: createSourceService(repo, null) })

  const ownerA = await ensureCoreUser(repo, sessionA!.user.id)
  const post = await service.createLocalPostAs(ownerA.handle, ownerA.displayName, 'original content')

  const forbidden = await app.request(`/me/posts/${post.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-api-key': keyB },
    body: JSON.stringify({ content: 'hijacked' })
  })
  expect(forbidden.status).toBe(403)
  expect((await service.getPost(post.id))?.content).toBe('original content') // untouched

  const ok = await app.request(`/me/posts/${post.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-api-key': keyA },
    body: JSON.stringify({ content: 'edited content' })
  })
  expect(ok.status).toBe(200)
  const body = await ok.json()
  expect(body.post.content).toBe('edited content')
})

test("DELETE /me/posts/:id deletes only the key owner's own post, never another user's", async () => {
  const repo = await createSqliteRepository(':memory:')
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  const service = createService(repo, createEventBus(), null, store)
  const auth = makeAuth(repo)
  const authApp = new Hono()
  authApp.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))
  const cookieA = await registeredSession(authApp, 'del-ownerA@x.test', repo)
  const cookieB = await registeredSession(authApp, 'del-ownerB@x.test', repo)
  const sessionA = await auth.api.getSession({ headers: new Headers({ cookie: cookieA }) })
  const sessionB = await auth.api.getSession({ headers: new Headers({ cookie: cookieB }) })
  const keyA = await mintKey(auth, sessionA!.user.id, { posts: ['write'] })
  const keyB = await mintKey(auth, sessionB!.user.id, { posts: ['write'] })
  const app = new Hono()
  mountPersonalApiRoutes(app, { store, auth, users: repo, service, sourceService: createSourceService(repo, null) })

  const ownerA = await ensureCoreUser(repo, sessionA!.user.id)
  const post = await service.createLocalPostAs(ownerA.handle, ownerA.displayName, 'do not delete me yet')

  const forbidden = await app.request(`/me/posts/${post.id}`, { method: 'DELETE', headers: { 'x-api-key': keyB } })
  expect(forbidden.status).toBe(403)
  expect(await service.getPost(post.id)).toBeDefined() // still there

  const ok = await app.request(`/me/posts/${post.id}`, { method: 'DELETE', headers: { 'x-api-key': keyA } })
  expect(ok.status).toBe(200)
  expect(await service.getPost(post.id)).toBeUndefined() // gone
})

test('DELETE /me/posts/:id 404s for an unknown post id', async () => {
  const { app, cookie, auth } = await freshApp('delete-unknown@x.test')
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  const key = await mintKey(auth, session!.user.id, { posts: ['write'] })
  const res = await app.request('/me/posts/does-not-exist', { method: 'DELETE', headers: { 'x-api-key': key } })
  expect(res.status).toBe(404)
})

test('DELETE /me/posts/:id refuses a remote post (never deletable by any user)', async () => {
  const { app, cookie, auth, repo } = await freshApp('delete-remote@x.test')
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  const key = await mintKey(auth, session!.user.id, { posts: ['write'] })
  const me = await ensureCoreUser(repo, session!.user.id)
  // A remote-authored `posts` row (the legacy shape v2 no longer writes but
  // converted databases still hold — see moderation.test.ts's seedRemotePost
  // for the same pattern) — the only thing the ownership check's
  // `source !== 'local'` branch can be exercised against. authorId is the
  // caller's own core user id: a remote post is refused by source alone,
  // never reachable by ANY caller, not just a mismatched owner.
  repo.raw.prepare(
    `INSERT INTO posts (id, author_id, source, guid, title, content, url, published_at, created_at)
     VALUES ('remote-1', ?, 'remote', 'g-remote-1', NULL, 'x', 'https://e/remote-1', '2026-07-18T00:00:00Z', '2026-07-18T00:00:00Z')`,
  ).run(me.id)
  const res = await app.request('/me/posts/remote-1', { method: 'DELETE', headers: { 'x-api-key': key } })
  expect(res.status).toBe(403)
})

// --- POST/DELETE /me/api-follows (follows:write, phase 3 task 2a) --------
// Key-authed twins of app.ts's cookie-authed `POST /me/follows` / `DELETE
// /me/follows/:target`, same body/param + response shape, transcribed onto
// the `api-follows` path (app.ts already claims the bare `/me/follows`
// method+path pair for its own cookie-authed routes).

test('POST /me/api-follows follows a target by handle (follows:write)', async () => {
  const { app, cookie, auth, service, repo } = await freshApp('follower@x.test')
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  const key = await mintKey(auth, session!.user.id, { follows: ['write'] })
  const me = await ensureCoreUser(repo, session!.user.id)
  const target = await service.createLocalUser({ handle: 'followee', displayName: 'Followee' })

  const res = await app.request('/me/api-follows', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ handle: 'followee' }),
  })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })

  const following = await service.listFollowing(me.id)
  expect(following.map((u) => u.id)).toContain(target.id)
})

test('POST /me/api-follows 404s for an unknown handle', async () => {
  const { app, cookie, auth } = await freshApp('follower-unknown@x.test')
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  const key = await mintKey(auth, session!.user.id, { follows: ['write'] })
  const res = await app.request('/me/api-follows', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ handle: 'does-not-exist' }),
  })
  expect(res.status).toBe(404)
})

test('DELETE /me/api-follows/:target unfollows a target by handle (follows:write)', async () => {
  const { app, cookie, auth, service, repo } = await freshApp('unfollower@x.test')
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  const key = await mintKey(auth, session!.user.id, { follows: ['write'] })
  const me = await ensureCoreUser(repo, session!.user.id)
  const target = await service.createLocalUser({ handle: 'unfollowee', displayName: 'Unfollowee' })
  await service.addFollow(me, target)
  expect((await service.listFollowing(me.id)).map((u) => u.id)).toContain(target.id)

  const res = await app.request('/me/api-follows/unfollowee', { method: 'DELETE', headers: { 'x-api-key': key } })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
  expect((await service.listFollowing(me.id)).map((u) => u.id)).not.toContain(target.id)
})

test('DELETE /me/api-follows/:target 404s for an unknown handle', async () => {
  const { app, cookie, auth } = await freshApp('unfollower-unknown@x.test')
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  const key = await mintKey(auth, session!.user.id, { follows: ['write'] })
  const res = await app.request('/me/api-follows/does-not-exist', { method: 'DELETE', headers: { 'x-api-key': key } })
  expect(res.status).toBe(404)
})

test('a follows:write key cannot reach posts:read-gated /me/posts (permission isolation)', async () => {
  const { app, cookie, auth } = await freshApp('follows-only@x.test')
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  const key = await mintKey(auth, session!.user.id, { follows: ['write'] })
  const res = await app.request('/me/posts', { headers: { 'x-api-key': key } })
  expect(res.status).toBe(401)
})

test('a posts:read key cannot reach follows:write-gated POST /me/api-follows (permission isolation)', async () => {
  const { app, cookie, auth } = await freshApp('posts-only@x.test')
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  const key = await mintKey(auth, session!.user.id, { posts: ['read'] })
  const res = await app.request('/me/api-follows', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ handle: 'anyone' }),
  })
  expect(res.status).toBe(401)
})

// --- POST/DELETE /me/api-subscriptions (follows:write, phase 3 task 2b) --
// Key-authed twins of app.ts's cookie-authed `POST /me/subscriptions` /
// `DELETE /me/subscriptions/:sourceId`, same body/response shape and
// idempotency semantics, transcribed onto the `api-subscriptions` path
// (app.ts already claims the bare `/me/subscriptions` method+path pair for
// its own cookie-authed routes). checkCallbackUrl runs real DNS for
// hostnames and the sandbox has no network, so every success-path URL below
// is a TEST-NET-3 literal (RFC 5737) — same convention as
// subscriptions-api.test.ts / source-capability-api.test.ts.
const SUB_URL_A = 'https://203.0.113.60/f.xml'
const SUB_URL_B = 'https://203.0.113.61/f.xml'

test('POST /me/api-subscriptions subscribes to a remote source by URL (follows:write)', async () => {
  const { app, cookie, auth } = await freshApp('subscriber@x.test')
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  const key = await mintKey(auth, session!.user.id, { follows: ['write'] })
  const res = await app.request('/me/api-subscriptions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ url: SUB_URL_A, commandId: 'sub-1' }),
  })
  expect(res.status).toBe(201)
  const body = await res.json()
  expect(body.subscription.url).toBe(SUB_URL_A)
  expect(body.subscription.sourceId).toBeTruthy()
})

test('POST /me/api-subscriptions rejects an invalid URL (400)', async () => {
  const { app, cookie, auth } = await freshApp('subscriber-badurl@x.test')
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  const key = await mintKey(auth, session!.user.id, { follows: ['write'] })
  const res = await app.request('/me/api-subscriptions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ url: 'not a url', commandId: 'bad-1' }),
  })
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: 'url invalid' })
})

test('POST /me/api-subscriptions: a replayed commandId returns the original result, a fresh commandId against the same URL is the not-created 200, and a reused commandId against a different URL conflicts', async () => {
  const { app, cookie, auth } = await freshApp('subscriber-idem@x.test')
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  const key = await mintKey(auth, session!.user.id, { follows: ['write'] })
  const subscribe = (url: string, commandId: string) =>
    app.request('/me/api-subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ url, commandId }),
    })

  const first = await subscribe(SUB_URL_A, 'idem-1')
  expect(first.status).toBe(201)
  const firstBody = await first.json()

  const replay = await subscribe(SUB_URL_A, 'idem-1')
  expect(replay.status).toBe(201)
  expect(await replay.json()).toEqual(firstBody)

  const notCreated = await subscribe(SUB_URL_A, 'idem-2')
  expect(notCreated.status).toBe(200)
  expect((await notCreated.json()).subscription.sourceId).toBe(firstBody.subscription.sourceId)

  const conflict = await subscribe(SUB_URL_B, 'idem-1')
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toEqual({ error: 'idempotency conflict' })
})

test('DELETE /me/api-subscriptions/:sourceId unsubscribes (follows:write)', async () => {
  const { app, cookie, auth, repo } = await freshApp('unsubscriber@x.test')
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  const key = await mintKey(auth, session!.user.id, { follows: ['write'] })
  const me = await ensureCoreUser(repo, session!.user.id)
  const sourceService = createSourceService(repo, null)
  const subscribeRes = await app.request('/me/api-subscriptions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ url: SUB_URL_A, commandId: 'sub-for-unsub' }),
  })
  const sourceId = (await subscribeRes.json()).subscription.sourceId as string
  expect((await sourceService.ownerFollowing(me.id)).sourceSubscriptions.map((s) => s.sourceId)).toContain(sourceId)

  const res = await app.request(`/me/api-subscriptions/${sourceId}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ commandId: 'unsub-1' }),
  })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
  expect((await sourceService.ownerFollowing(me.id)).sourceSubscriptions.map((s) => s.sourceId)).not.toContain(sourceId)
})

test('DELETE /me/api-subscriptions/:sourceId rejects an invalid commandId (400)', async () => {
  const { app, cookie, auth } = await freshApp('unsubscriber-badcmd@x.test')
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  const key = await mintKey(auth, session!.user.id, { follows: ['write'] })
  const res = await app.request('/me/api-subscriptions/does-not-matter', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ commandId: '' }),
  })
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: 'commandId invalid' })
})

test('a posts:read key cannot reach follows:write-gated POST /me/api-subscriptions (permission isolation)', async () => {
  const { app, cookie, auth } = await freshApp('subscriber-wrongkey@x.test')
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  const key = await mintKey(auth, session!.user.id, { posts: ['read'] })
  const res = await app.request('/me/api-subscriptions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ url: SUB_URL_A, commandId: 'wrongkey-1' }),
  })
  expect(res.status).toBe(401)
})

test('a timeline:read key cannot reach follows:write-gated DELETE /me/api-subscriptions/:sourceId (permission isolation)', async () => {
  const { app, cookie, auth } = await freshApp('unsubscriber-wrongkey@x.test')
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  const key = await mintKey(auth, session!.user.id, { timeline: ['read'] })
  const res = await app.request('/me/api-subscriptions/does-not-matter', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ commandId: 'x' }),
  })
  expect(res.status).toBe(401)
})
