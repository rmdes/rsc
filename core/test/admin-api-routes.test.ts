import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createAuth } from '../src/auth.ts'
import { createApp } from '../src/api/app.ts'
import { createService } from '../src/domain/service.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { removalNotice } from '../src/logical/local.ts'

// Same erasure every other api-key test hits: createAuth's `plugins:
// BetterAuthPlugin[]` widens every plugin so betterAuth()'s .api inference
// can't see apiKey()'s createApiKey (see api-key-auth-admin.test.ts).
interface ApiKeyPluginApi {
  createApiKey(input: {
    body: { configId?: string; userId?: string; name?: string; permissions?: Record<string, string[]> }
  }): Promise<{ key: string; id: string }>
}

async function setup(adminEmails: ReadonlySet<string> = new Set(['admin@x.test'])) {
  const repo = await createSqliteRepository(':memory:')
  const db = repo.raw
  const auth = createAuth({
    sqlite: repo.raw, users: repo, secret: 'test-secret-test-secret-32chars',
    webOrigin: 'http://localhost:5173', anonTtlDays: 30, mailer: null,
    authOpenApi: false, adminEmails,
  })
  const bus = createEventBus()
  // These 3 tests only exercise POST /admin/api-keys, which never touches
  // the logical store or acquisition engine — a minimal stub (cast past
  // LogicalStore's full interface) avoids standing up createDatabaseContext
  // + createLogicalStore + createAcquisition for a route that never calls
  // them (smoke.test.ts builds the real ones where a test needs them).
  const logicalStoreStub = { schedulerStats: () => ({ dueNow: 0, lastPollAt: null }) } as never
  const service = createService(repo, bus, null, logicalStoreStub)
  const sourceService = createSourceService(repo, null)
  const app = createApp({
    service, bus, token: 'ops-token', auth, users: repo, adminEmails,
    sources: { service: sourceService, repo },
    logical: { store: logicalStoreStub } as never,
  })
  return { app, auth, repo, db }
}

// The two moderation "actually deletes" tests below need a real local post
// and a real deleteLocalAccount call, both of which route through
// service->logical (see service.ts's createLocalPostAs/deleteLocalAccount) —
// setup()'s logicalStoreStub only implements schedulerStats. Mirrors
// moderation.test.ts's own makeApp, which stands up the real store for the
// same reason.
async function setupWithLogicalStore(adminEmails: ReadonlySet<string> = new Set(['admin@x.test'])) {
  const repo = await createSqliteRepository(':memory:')
  const db = repo.raw
  const auth = createAuth({
    sqlite: repo.raw, users: repo, secret: 'test-secret-test-secret-32chars',
    webOrigin: 'http://localhost:5173', anonTtlDays: 30, mailer: null,
    authOpenApi: false, adminEmails,
  })
  const bus = createEventBus()
  const dbContext = createDatabaseContext(repo.raw)
  const store = createLogicalStore(dbContext)
  const service = createService(repo, bus, null, store)
  const sourceService = createSourceService(repo, null)
  const app = createApp({
    service, bus, token: 'ops-token', auth, users: repo, adminEmails,
    sources: { service: sourceService, repo },
    logical: { store, acquisition: createAcquisition({ db: dbContext }) },
  })
  return { app, auth, repo, db }
}

// Same shape as source-admin-api.test.ts's own insertSourceRow — a real
// remote_sources_v2 row to transition/read back, not a mocked one.
type Raw = InstanceType<typeof Database>
function insertSourceRow(db: Raw, opts: { canonicalUrl: string; operation?: string; governance?: string }): string {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, 'single_publisher', ?, ?, 'user_subscription', NULL, 0, ?)`,
  ).run(id, opts.canonicalUrl, opts.operation ?? 'enabled', opts.governance ?? 'allowed', '2026-01-01T00:00:00.000Z')
  return id
}

async function registerSession(auth: ReturnType<typeof createAuth>, db: Database.Database, email: string) {
  const signUp = await auth.api.signUpEmail({ body: { email, password: 'password123', name: email } })
  db.prepare(`UPDATE user SET emailVerified = 1 WHERE id = ?`).run(signUp.user.id)
  const signIn = await auth.api.signInEmail({
    body: { email, password: 'password123' }, returnHeaders: true,
  }) as unknown as { headers: Headers }
  return { userId: signUp.user.id, cookie: signIn.headers.get('set-cookie') ?? '' }
}

describe('POST /admin/api-keys', () => {
  test('an admin session can mint an admin-tier key', async () => {
    const { app, auth, db } = await setup()
    const { cookie } = await registerSession(auth, db, 'admin@x.test')
    const res = await app.request('/admin/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'ops-key', permissions: { 'admin.read': ['read'] } }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.key).toBeTruthy()
  })

  test('a non-admin registered session is rejected before reaching the route (403)', async () => {
    const { app, auth, db } = await setup()
    const { cookie } = await registerSession(auth, db, 'nobody@x.test')
    const res = await app.request('/admin/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'k', permissions: { 'admin.read': ['read'] } }),
    })
    expect(res.status).toBe(403)
  })

  test('rejects a permission outside the admin whitelist', async () => {
    const { app, auth, db } = await setup()
    const { cookie } = await registerSession(auth, db, 'admin@x.test')
    const res = await app.request('/admin/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'k', permissions: { 'admin.superpowers': ['write'] } }),
    })
    expect(res.status).toBe(400)
  })

  // Found via Task 6's manual UI check, not written speculatively: a key
  // minted through THIS route (as opposed to every other test in this file,
  // which mints directly via apiKeyApi.createApiKey({body:{userId: the
  // better-auth authUserId from registerSession, ...}})) must actually work
  // when used — i.e. authenticate against an admin.read route, AND be
  // listable/revocable through better-auth's own /api-key/list + /api-key/
  // delete REST endpoints (which key off the session's authUserId). Both
  // depend on the key's referenceId being the SAME id apiKeyAuthAdmin and
  // better-auth's own session-based endpoints use — NOT the RSC-domain
  // `users` table id (a separately generated UUID, see users.insertUser).
  test('a key minted through this route actually works: authenticates an admin.read route AND is listable via /api/auth/api-key/list', async () => {
    const { app, auth, db } = await setup()
    const { cookie } = await registerSession(auth, db, 'admin@x.test')
    const mint = await app.request('/admin/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'ops', permissions: { 'admin.read': ['read'] } }),
    })
    expect(mint.status).toBe(201)
    const { key } = await mint.json()

    // The minted key must authenticate against the API it was minted for.
    const readRes = await app.request('/admin-api/overview', { headers: { 'x-api-key': key } })
    expect(readRes.status).toBe(200)

    // The minted key must be visible to its own owner's session via
    // better-auth's own list endpoint (same referenceId).
    const listRes = await app.request('/api/auth/api-key/list?configId=admin', { headers: { cookie } })
    const { apiKeys } = await listRes.json()
    expect(apiKeys.some((k: { name: string | null }) => k.name === 'ops')).toBe(true)
  })

  // Final-review gap: proves Task 6's revokeApiKey(configId) fix actually
  // round-trips for the admin tier — mint via this route, revoke exactly the
  // way the web panel's revoke action does (web/src/lib/api.ts's
  // revokeApiKey: POST /api/auth/api-key/delete with an EXPLICIT
  // configId:'admin', not the default 'user', which would 404 an admin-tier
  // key per that function's own comment), then confirm the key is dead.
  test('an admin key minted via this route can be revoked with configId:admin, and then stops working', async () => {
    const { app, auth, db } = await setup()
    const { cookie } = await registerSession(auth, db, 'admin@x.test')
    const mint = await app.request('/admin/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'revoke-me', permissions: { 'admin.read': ['read'] } }),
    })
    expect(mint.status).toBe(201)
    const { id, key } = await mint.json()

    // Sanity: the key works before revocation.
    const before = await app.request('/admin-api/overview', { headers: { 'x-api-key': key } })
    expect(before.status).toBe(200)

    // origin is required — better-auth's CSRF check 403s a same-origin-less
    // POST (MISSING_OR_NULL_ORIGIN), same as every other real-HTTP POST to
    // /api/auth/* in this suite (see auth.test.ts's sign-in/sign-up calls).
    const revoke = await app.request('/api/auth/api-key/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost:5173' },
      body: JSON.stringify({ configId: 'admin', keyId: id }),
    })
    expect(revoke.ok).toBe(true)

    const after = await app.request('/admin-api/overview', { headers: { 'x-api-key': key } })
    expect(after.status).toBe(401)
  })
})

describe('admin.read routes', () => {
  test('GET /admin-api/sources, /users, /overview, /settings all work with one admin.read key', async () => {
    const { app, auth, db } = await setup()
    const apiKeyApi = auth.api as unknown as ApiKeyPluginApi
    const { userId } = await registerSession(auth, db, 'admin@x.test')
    const created = await apiKeyApi.createApiKey({
      body: { configId: 'admin', userId, name: 'k', permissions: { 'admin.read': ['read'] } },
    })
    for (const path of ['/admin-api/sources', '/admin-api/users', '/admin-api/overview', '/admin-api/settings']) {
      const res = await app.request(path, { headers: { 'x-api-key': created.key } })
      expect(res.status).toBe(200)
    }
  })

  test('a key survives its owner staying admin, but 403s once removed from adminEmails', async () => {
    const repo = await createSqliteRepository(':memory:')
    const db = repo.raw
    const adminEmails = new Set(['revocable@x.test'])
    const auth = createAuth({
      sqlite: repo.raw, users: repo, secret: 'test-secret-test-secret-32chars',
      webOrigin: 'http://localhost:5173', anonTtlDays: 30, mailer: null, authOpenApi: false,
      adminEmails,
    })
    const bus = createEventBus()
    const logicalStoreStub = { schedulerStats: () => ({ dueNow: 0, lastPollAt: null }) } as never
    const service = createService(repo, bus, null, logicalStoreStub)
    const sourceService = createSourceService(repo, null)
    const app = createApp({
      service, bus, token: 'ops-token', auth, users: repo, adminEmails,
      sources: { service: sourceService, repo },
      logical: { store: logicalStoreStub } as never,
    })
    const { userId } = await registerSession(auth, db, 'revocable@x.test')
    const apiKeyApi = auth.api as unknown as ApiKeyPluginApi
    const created = await apiKeyApi.createApiKey({
      body: { configId: 'admin', userId, name: 'k', permissions: { 'admin.read': ['read'] } },
    })
    const before = await app.request('/admin-api/sources', { headers: { 'x-api-key': created.key } })
    expect(before.status).toBe(200)
    adminEmails.delete('revocable@x.test')
    const after = await app.request('/admin-api/sources', { headers: { 'x-api-key': created.key } })
    expect(after.status).toBe(403)
  })
})

describe('admin.sources write routes', () => {
  test('POST /admin-api/sources/:id/:action rejects an action outside the six named verbs', async () => {
    const { app, auth, db } = await setup()
    const apiKeyApi = auth.api as unknown as ApiKeyPluginApi
    const { userId } = await registerSession(auth, db, 'admin@x.test')
    const created = await apiKeyApi.createApiKey({
      body: { configId: 'admin', userId, name: 'k', permissions: { 'admin.sources': ['write'] } },
    })
    const res = await app.request('/admin-api/sources/some-id/approve', {
      method: 'POST', headers: { 'x-api-key': created.key, 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'c1' }),
    })
    expect(res.status).toBe(400)
  })

  test('POST /admin-api/sources/:id/:action 404s an unknown source for a named verb', async () => {
    const { app, auth, db } = await setup()
    const apiKeyApi = auth.api as unknown as ApiKeyPluginApi
    const { userId } = await registerSession(auth, db, 'admin@x.test')
    const created = await apiKeyApi.createApiKey({
      body: { configId: 'admin', userId, name: 'k', permissions: { 'admin.sources': ['write'] } },
    })
    const res = await app.request('/admin-api/sources/unknown-id/pause', {
      method: 'POST', headers: { 'x-api-key': created.key, 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'c1' }),
    })
    expect(res.status).toBe(404)
  })

  // Regression: the route's `category` validator must resolve to app.ts's
  // narrower six-value isAuditCategory (same list the cookie-authed sibling
  // POST /admin/sources/:id/:action uses), NOT this file's own wider
  // eight-value isAuditCategory (used by the V3 moderation routes). A same-
  // named-different-symbol shadow previously let 'false_positive'/'remediated'
  // through here while the cookie-authed sibling 400s them.
  test('rejects a V3-moderation-only category (false_positive) that the cookie-authed sibling also rejects', async () => {
    const { app, auth, db } = await setup()
    const apiKeyApi = auth.api as unknown as ApiKeyPluginApi
    const { userId } = await registerSession(auth, db, 'admin@x.test')
    const created = await apiKeyApi.createApiKey({
      body: { configId: 'admin', userId, name: 'k', permissions: { 'admin.sources': ['write'] } },
    })
    const res = await app.request('/admin-api/sources/some-id/quarantine', {
      method: 'POST', headers: { 'x-api-key': created.key, 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'c1', category: 'false_positive' }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'category invalid' })
  })

  test('a category from the narrower six-value list still passes validation (fix did not over-tighten)', async () => {
    const { app, auth, db } = await setup()
    const apiKeyApi = auth.api as unknown as ApiKeyPluginApi
    const { userId } = await registerSession(auth, db, 'admin@x.test')
    const created = await apiKeyApi.createApiKey({
      body: { configId: 'admin', userId, name: 'k', permissions: { 'admin.sources': ['write'] } },
    })
    const res = await app.request('/admin-api/sources/unknown-id/quarantine', {
      method: 'POST', headers: { 'x-api-key': created.key, 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'c1', category: 'spam' }),
    })
    // Category validation passes, so this falls through to the (unknown)
    // source lookup — 404, not the 400 'category invalid' from above.
    expect(res.status).toBe(404)
  })

  test('a posts:write-only key (wrong resource) is rejected', async () => {
    const { app, auth, db } = await setup()
    const apiKeyApi = auth.api as unknown as ApiKeyPluginApi
    const { userId } = await registerSession(auth, db, 'admin@x.test')
    const created = await apiKeyApi.createApiKey({
      body: { configId: 'admin', userId, name: 'k', permissions: { 'admin.read': ['read'] } },
    })
    const res = await app.request('/admin-api/sources/some-id/pause', {
      method: 'POST', headers: { 'x-api-key': created.key, 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'c1' }),
    })
    expect(res.status).toBe(401)
  })

  // Final-review gap: every test above only covers rejection paths. This one
  // proves the success path actually mutates persisted state, not just that
  // the route answers 200 — same "check the row, not just the response"
  // discipline as source-admin-api.test.ts's own pause assertions and the
  // moderation "actually deletes" tests below.
  test('POST /admin-api/sources/:id/pause actually pauses a real source (200 + persisted operation=paused)', async () => {
    const { app, auth, db } = await setup()
    const apiKeyApi = auth.api as unknown as ApiKeyPluginApi
    const { userId } = await registerSession(auth, db, 'admin@x.test')
    const created = await apiKeyApi.createApiKey({
      body: { configId: 'admin', userId, name: 'k', permissions: { 'admin.sources': ['write'] } },
    })
    const sourceId = insertSourceRow(db, { canonicalUrl: 'https://203.0.113.90/f.xml' })

    const res = await app.request(`/admin-api/sources/${sourceId}/pause`, {
      method: 'POST', headers: { 'x-api-key': created.key, 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'pause-1' }),
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.source.operation).toBe('paused')

    // Re-read independently of the response body, via the same repo the
    // route itself reads/writes through.
    const row = db.prepare(`SELECT operation FROM remote_sources_v2 WHERE id = ?`).get(sourceId) as { operation: string }
    expect(row.operation).toBe('paused')
  })

  // Final-review gap: POST /admin-api/sources (establish federation) had ZERO
  // test coverage — the reviewer only verified it manually. URL fixture
  // (203.0.113.0/24, TEST-NET-3) matches source-admin-api.test.ts's own
  // FED_URL convention for a URL that passes the SSRF check.
  test('POST /admin-api/sources establishes federation (201 + source/federation shape)', async () => {
    const { app, auth, db } = await setup()
    const apiKeyApi = auth.api as unknown as ApiKeyPluginApi
    const { userId } = await registerSession(auth, db, 'admin@x.test')
    const created = await apiKeyApi.createApiKey({
      body: { configId: 'admin', userId, name: 'k', permissions: { 'admin.sources': ['write'] } },
    })
    const url = 'https://203.0.113.91/f.xml'

    const res = await app.request('/admin-api/sources', {
      method: 'POST', headers: { 'x-api-key': created.key, 'content-type': 'application/json' },
      body: JSON.stringify({ url, attributionMode: 'single_publisher', category: 'operator_policy', commandId: 'fed-1' }),
    })
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.source.canonicalUrl).toBe(url)
    expect(json.federation).toMatchObject({ sourceId: json.source.id, status: 'approved' })
  })
})

describe('admin.moderation write routes', () => {
  test('DELETE /admin-api/users/:handle 404s an unknown handle', async () => {
    const { app, auth, db } = await setup()
    const apiKeyApi = auth.api as unknown as ApiKeyPluginApi
    const { userId } = await registerSession(auth, db, 'admin@x.test')
    const created = await apiKeyApi.createApiKey({
      body: { configId: 'admin', userId, name: 'k', permissions: { 'admin.moderation': ['write'] } },
    })
    const res = await app.request('/admin-api/users/nobody', {
      method: 'DELETE', headers: { 'x-api-key': created.key },
    })
    expect(res.status).toBe(404)
  })

  test('DELETE /admin-api/posts/:id 404s an unknown post', async () => {
    const { app, auth, db } = await setup()
    const apiKeyApi = auth.api as unknown as ApiKeyPluginApi
    const { userId } = await registerSession(auth, db, 'admin@x.test')
    const created = await apiKeyApi.createApiKey({
      body: { configId: 'admin', userId, name: 'k', permissions: { 'admin.moderation': ['write'] } },
    })
    const res = await app.request('/admin-api/posts/nope', {
      method: 'DELETE', headers: { 'x-api-key': created.key, 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'spam' }),
    })
    expect(res.status).toBe(404)
  })

  test('DELETE /admin-api/posts/:id: missing category → 400', async () => {
    const { app, auth, db } = await setup()
    const apiKeyApi = auth.api as unknown as ApiKeyPluginApi
    const { userId } = await registerSession(auth, db, 'admin@x.test')
    const created = await apiKeyApi.createApiKey({
      body: { configId: 'admin', userId, name: 'k', permissions: { 'admin.moderation': ['write'] } },
    })
    const res = await app.request('/admin-api/posts/nope', {
      method: 'DELETE', headers: { 'x-api-key': created.key, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  test('an admin.sources-only key cannot hit moderation routes', async () => {
    const { app, auth, db } = await setup()
    const apiKeyApi = auth.api as unknown as ApiKeyPluginApi
    const { userId } = await registerSession(auth, db, 'admin@x.test')
    const created = await apiKeyApi.createApiKey({
      body: { configId: 'admin', userId, name: 'k', permissions: { 'admin.sources': ['write'] } },
    })
    const res = await app.request('/admin-api/posts/nope', {
      method: 'DELETE', headers: { 'x-api-key': created.key },
    })
    expect(res.status).toBe(401)
  })

  // Mirrors moderation.test.ts's cookie-authed 'deletes even an admin-email
  // account' — proves the key-authed route actually deletes, not just
  // returns 200, by re-checking the row via repo.getUserByHandle afterward.
  test('DELETE /admin-api/users/:handle actually deletes a real local user (200 + row gone)', async () => {
    const { app, auth, db, repo } = await setupWithLogicalStore()
    const apiKeyApi = auth.api as unknown as ApiKeyPluginApi
    const { userId: adminUserId } = await registerSession(auth, db, 'admin@x.test')
    const created = await apiKeyApi.createApiKey({
      body: { configId: 'admin', userId: adminUserId, name: 'k', permissions: { 'admin.moderation': ['write'] } },
    })
    // A separate, non-admin actor whose account gets deleted.
    const { cookie: targetCookie } = await registerSession(auth, db, 'victim@x.test')
    const me = await (await app.request('/me', { headers: { cookie: targetCookie } })).json() // lazy-mints the core user
    const handle = me.user.handle

    const res = await app.request(`/admin-api/users/${handle}`, {
      method: 'DELETE', headers: { 'x-api-key': created.key },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(await repo.getUserByHandle(handle)).toBeUndefined()
  })

  // Mirrors moderation.test.ts's cookie-authed removal-notice check: the row
  // survives with the moderator notice as its content, not gone.
  test('DELETE /admin-api/posts/:id actually replaces a real local post with the moderator notice (200 + row survives)', async () => {
    const { app, auth, db, repo } = await setupWithLogicalStore()
    const apiKeyApi = auth.api as unknown as ApiKeyPluginApi
    const { userId: adminUserId } = await registerSession(auth, db, 'admin@x.test')
    const created = await apiKeyApi.createApiKey({
      body: { configId: 'admin', userId: adminUserId, name: 'k', permissions: { 'admin.moderation': ['write'] } },
    })
    const { cookie: authorCookie } = await registerSession(auth, db, 'author@x.test')
    await app.request('/me', { headers: { cookie: authorCookie } }) // lazy-mints the core user
    const createdPost = await (await app.request('/posts', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: authorCookie },
      body: JSON.stringify({ content: 'delete me' }),
    })).json()
    const postId = createdPost.post.id

    const res = await app.request(`/admin-api/posts/${postId}`, {
      method: 'DELETE', headers: { 'x-api-key': created.key, 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'spam' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    const stored = await repo.getPost(postId)
    expect(stored).toBeDefined()
    expect(stored!.content).toBe(removalNotice({ kind: 'administrator', category: 'spam', note: null }))
  })
})

// Guardrail: every /admin-api/* route must reject a keyless request.
//
// The cookie-authed /admin/* surface gets its safety structurally, from one
// `app.use('/admin/*', authed, requireAdmin())` gate — a new route there
// cannot ship ungated by forgetting the guard. /admin-api/* CANNOT reuse that
// gate (it runs cookie sessionAuth, incompatible with key auth), so it relies
// on a per-route guard instead, on the one surface that hard-deletes users and
// posts. This restores the missing half reflectively, the same way
// logical-fk-indexes.test.ts fails CI on any future un-indexed FK: it walks
// Hono's own route table rather than a hand-maintained list, so a route added
// without a guard fails here without anyone remembering to add a case.
//
// Deliberately NOT a blanket middleware: stacking a second apiKeyAuthAdmin
// would call verifyApiKey twice per request, and better-auth's own docs warn
// that double verification double-increments the key's rate limit — halving
// the effective 300/hour budget. A catch-all `app.all` fallback wouldn't work
// either: Hono matches in registration order, so a new ungated route declared
// above it still wins.
describe('/admin-api/* guard coverage', () => {
  test('every registered admin-api route 401s without an api key', async () => {
    const { app } = await setup()

    // One entry per handler, so `app.get(p, guard, handler)` appears twice —
    // dedupe on method+path. ALL entries are prefix middleware, not routes.
    const routes = [
      ...new Set(
        app.routes
          .filter((r) => r.path.startsWith('/admin-api/') && r.method !== 'ALL')
          .map((r) => `${r.method} ${r.path}`),
      ),
    ].sort()

    // Anti-vacuity: a reflective test that discovers nothing passes silently.
    // Pin the destructive pair explicitly so renaming the prefix fails loudly
    // rather than emptying the set.
    expect(routes).toContain('DELETE /admin-api/users/:handle')
    expect(routes).toContain('DELETE /admin-api/posts/:id')
    expect(routes.length).toBeGreaterThanOrEqual(8)

    for (const route of routes) {
      const [method, pattern] = route.split(' ')
      // Params never reach a handler here — the guard runs first, which is the
      // property under test — so any concrete value does.
      const path = pattern.replace(/:[^/]+/g, 'guard-coverage-probe')
      const res = await app.request(path, { method })
      expect(res.status, `${method} ${path} must 401 without an api key`).toBe(401)
    }
  })
})
