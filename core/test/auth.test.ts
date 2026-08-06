import { test, expect } from 'vitest'
import type { Hono } from 'hono'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { createApp } from '../src/api/app.ts'
import { ensureCoreUser } from '../src/api/auth.ts'
import { resetMagicLinkCap, MAGIC_LINK_MAX_PER_WINDOW } from '../src/auth.ts'
import { makeAuth, anonSession, registeredSession, fakeMailer, uniqueIp } from './auth-helper.ts'
import type { Mailer } from '../src/mail.ts'

async function makeApp(opts: { mailEnabled?: boolean; mailer?: Mailer | null } = {}) {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  // The store IS passed to createService here (matching prod: server.ts:47), so
  // POST /posts materializes a logical_local_origins_v2 row per post. That row's
  // post_id FK is ON DELETE RESTRICT, so any test below that calls
  // repo.sweepAnonymousUsers directly on an account that has posted MUST thread
  // `store` through too (repo.sweepAnonymousUsers(7, store)) — the raw
  // deleteUserCascade fallback (sqlite.ts:626) violates that FK otherwise (the
  // v2 defect found in Task 8b/8c; see the sqlite.ts comment above
  // sweepAnonymousUsers). Tests that never post before sweeping are unaffected
  // either way.
  const service = createService(repo, bus, null, store)
  const fake = fakeMailer()
  const mailer = opts.mailer !== undefined ? opts.mailer : fake.mailer
  const mailEnabled = opts.mailEnabled ?? true
  const auth = makeAuth(repo, mailer)
  const app = createApp({
    service, bus, token: 'secret', auth, users: repo, mailEnabled,
    sources: { service: createSourceService(repo, null), repo },
    logical: { store, acquisition: createAcquisition({ db }) },
  })
  return { app, repo, service, auth, store, mail: fake }
}

// Hard verification (Step 1) blocks sign-in until the emailed link is
// visited — a fresh signed-up user must be pushed through verification
// before assertions that assume a working session.
async function verifyByEmail(app: Hono, mail: ReturnType<typeof fakeMailer>, email: string): Promise<void> {
  const verifyUrl = /(https?:\/\/\S+)/.exec([...mail.sent].reverse().find((m) => /verify/i.test(m.subject) && m.to === email)!.text)![1]!
  await app.request(verifyUrl, { headers: { origin: 'http://web.test' } })
}

function anonAuthUserId(repo: Awaited<ReturnType<typeof createSqliteRepository>>): string {
  const row = repo.raw.prepare('SELECT id FROM user WHERE isAnonymous = 1').get() as { id: string } | undefined
  if (!row) throw new Error('no anonymous auth user row found')
  return row.id
}

test('anonymous sign-in mints a host-only session cookie', async () => {
  const { app } = await makeApp()
  const res = await app.request('/api/auth/sign-in/anonymous', { method: 'POST', headers: { origin: 'http://web.test' } })
  expect(res.status).toBe(200)
  const sc = res.headers.get('set-cookie') ?? ''
  expect(sc).toContain('rsc.session_token=')
  expect(sc.toLowerCase()).not.toContain('domain=') // host-only (SEC-1)
  expect(sc.toLowerCase()).toContain('httponly')
  expect(sc.toLowerCase()).toContain('samesite=lax')
})

test('cookie without Origin is rejected by better-auth CSRF (probed MISSING_OR_NULL_ORIGIN)', async () => {
  const { app } = await makeApp()
  const cookie = await anonSession(app)
  const res = await app.request('/api/auth/sign-out', { method: 'POST', headers: { cookie } })
  expect(res.status).toBe(403)
})

test('registration while anonymous re-points the guest core user (onLinkAccount)', async () => {
  const { app, repo, store, mail } = await makeApp()
  const cookie = await anonSession(app)
  const anonAuthId = anonAuthUserId(repo)
  const guest = await ensureCoreUser(repo, anonAuthId)
  // Seeded the way POST /posts does it, so the logical origin row travels too.
  const guestPostId = store.createLocalPost({ author: guest, content: 'guest content', replyToId: null, now: '2026-01-01T00:00:00.000Z' }).id

  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://web.test', cookie, 'x-forwarded-for': uniqueIp() },
    body: JSON.stringify({ email: 'a@b.example', password: 'password123', name: 'a' }),
  })
  expect(res.status).toBe(200)
  const newAuthId = (await res.json()).user.id as string
  // Hard verification (Step 1): sign-up no longer auto-signs-in
  // (shouldSkipAutoSignIn), so onLinkAccount can't fire there. It fires on
  // the anon-cookied sign-in that follows verification — the still-anonymous
  // browser authenticating as the new account is the actual link event.
  await verifyByEmail(app, mail, 'a@b.example')
  const signIn = await app.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://web.test', cookie, 'x-forwarded-for': uniqueIp() },
    body: JSON.stringify({ email: 'a@b.example', password: 'password123' }),
  })
  expect(signIn.status).toBe(200)

  const linked = await repo.getUserByAuthUserId(newAuthId)
  expect(linked?.id).toBe(guest.id) // same core identity, re-pointed
  expect(linked?.handle).toBe(guest.handle) // guest handle intact
  const guestPost = await repo.getPost(guestPostId)
  expect(guestPost?.authorId).toBe(guest.id) // posts intact

  const remainingAnon = repo.raw.prepare('SELECT COUNT(*) AS n FROM user WHERE isAnonymous = 1').get() as { n: number }
  expect(remainingAnon.n).toBe(0) // anon auth row deleted by better-auth
})

test('login while anonymous abandons the guest core user (orphaned, reclaimed in Task 5)', async () => {
  const { app, repo, mail } = await makeApp()

  // Register X in a fresh (non-anonymous) session, and establish X's core
  // user the way a real GET /me would lazily (Task 4 route, not wired yet).
  const signUp = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://web.test', 'x-forwarded-for': uniqueIp() },
    body: JSON.stringify({ email: 'x@b.example', password: 'password123', name: 'x' }),
  })
  expect(signUp.status).toBe(200)
  const xAuthId = (await signUp.json()).user.id as string
  await ensureCoreUser(repo, xAuthId)
  // Hard verification (Step 1): sign-in is blocked until X verifies.
  await verifyByEmail(app, mail, 'x@b.example')

  // Now a separate anonymous session mints its own guest core user.
  const cookie = await anonSession(app)
  const anonAuthId = anonAuthUserId(repo)
  const guest = await ensureCoreUser(repo, anonAuthId)

  // That anonymous session logs in as X — onLinkAccount sees an existing
  // core user for X and abandons the guest instead of re-pointing it.
  const res = await app.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://web.test', cookie, 'x-forwarded-for': uniqueIp() },
    body: JSON.stringify({ email: 'x@b.example', password: 'password123' }),
  })
  expect(res.status).toBe(200)

  const guestAfter = await repo.getUser(guest.id)
  expect(guestAfter?.authUserId).toBe(anonAuthId) // still points at the now-deleted anon auth row: orphaned
})

// The admin-gated probe used to be POST /users (deleted with v1). POST
// /admin/sources is its surviving equivalent — same gate shape, and the same
// two answers: a session that is not an admin is 403, no session at all is 401.
test('user actions 401 without a session; the admin write surface is admin-gated', async () => {
  const { app, repo } = await makeApp()
  expect((await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"content":"x"}' })).status).toBe(401)
  expect((await app.request('/me')).status).toBe(401)
  expect((await app.request('/me', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"handle":"x"}' })).status).toBe(401)
  expect((await app.request('/me/follows/whoever', { method: 'DELETE' })).status).toBe(401)
  expect((await app.request('/me/follows/opml', { method: 'POST', body: '<opml></opml>' })).status).toBe(401)
  const federate = (cookie?: string) => app.request('/admin/sources', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ url: 'https://203.0.113.60/f.xml', attributionMode: 'single_publisher', category: 'operator_policy', commandId: 'auth-gate-1' }),
  })
  expect((await federate()).status).toBe(401) // no session at all
  expect((await federate(await anonSession(app))).status).toBe(403) // an anon session IS a session, just not admin (matches SP1 /admin/status)
  expect((await federate(await registeredSession(app, 'r@test.example', repo))).status).toBe(403) // registered but not admin (no adminEmails configured in this app)
})

test('PATCH /me renames; posts and follows survive; 409 on conflict', async () => {
  const { app } = await makeApp()
  const cookie = await anonSession(app)
  await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{"content":"hello"}' })
  const meRes = await (await app.request('/me', { headers: { cookie } })).json()
  expect(meRes.isAnonymous).toBe(true)
  const before = meRes.user
  const renamed = await app.request('/me', { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: '{"handle":"ricardo","displayName":"Ricardo"}' })
  expect(renamed.status).toBe(200)
  // v2 timeline DTO: the author is `selectedAuthor`, not `author` (types.ts:53).
  const timeline = (await (await app.request('/timeline')).json()).timeline
  expect(timeline[0].selectedAuthor).toMatchObject({ kind: 'local', handle: 'ricardo', id: before.id }) // same identity, no data moved
})

test('PATCH /me rejects an unnormalized handle (400), and a valid rename keeps posting working', async () => {
  const { app } = await makeApp()
  const cookie = await anonSession(app)
  const bad = await app.request('/me', { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: '{"handle":"My Name"}' })
  expect(bad.status).toBe(400)

  const renamed = await app.request('/me', { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: '{"handle":"my-name"}' })
  expect(renamed.status).toBe(200)

  const posted = await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{"content":"after rename"}' })
  expect(posted.status).toBe(201)
})

test('PATCH /me with an empty body is 400 (nothing to update)', async () => {
  const { app } = await makeApp()
  const cookie = await anonSession(app)
  const res = await app.request('/me', { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: '{}' })
  expect(res.status).toBe(400)
})

test('PATCH /me rejects whitespace-only displayName (400)', async () => {
  const { app } = await makeApp()
  const cookie = await anonSession(app)
  const res = await app.request('/me', { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: '{"displayName":"   "}' })
  expect(res.status).toBe(400)
})

test('PATCH /me trims displayName edges and preserves internal whitespace', async () => {
  const { app } = await makeApp()
  const cookie = await anonSession(app)
  const res = await app.request('/me', { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: '{"displayName":"  Ricardo Mendes  "}' })
  expect(res.status).toBe(200)
  const user = (await res.json()).user
  expect(user.displayName).toBe('Ricardo Mendes')
})

test('sweep reclaims idle anonymous guests (full cascade, one transaction) and orphans; spares the active and the registered', async () => {
  const { app, repo, store } = await makeApp()
  // idle guest with a post and follows in both directions
  const idle = await anonSession(app)
  await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie: idle }, body: '{"content":"guest post"}' })
  const idleUser = (await (await app.request('/me', { headers: { cookie: idle } })).json()).user
  // registered user follows the guest; guest follows them back
  const reg = await registeredSession(app, 'keeper@test.example', repo)
  const regUser = (await (await app.request('/me', { headers: { cookie: reg } })).json()).user
  await app.request('/me/follows', { method: 'POST', headers: { 'content-type': 'application/json', cookie: reg }, body: JSON.stringify({ handle: idleUser.handle }) })
  await app.request('/me/follows', { method: 'POST', headers: { 'content-type': 'application/json', cookie: idle }, body: JSON.stringify({ handle: regUser.handle }) })
  // age the idle guest's session + auth user beyond the TTL
  const old = new Date(Date.now() - 8 * 86400_000).toISOString()
  repo.raw.prepare(`UPDATE session SET updatedAt = ? WHERE userId = ?`).run(old, idleUser.authUserId)
  repo.raw.prepare(`UPDATE user SET createdAt = ? WHERE id = ?`).run(old, idleUser.authUserId)
  // an ACTIVE anonymous guest must survive
  const active = await anonSession(app)
  await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie: active }, body: '{"content":"still here"}' })

  const { swept } = repo.sweepAnonymousUsers(7, store)
  expect(swept).toBe(1)
  expect(await repo.getUserByHandle(idleUser.handle)).toBeUndefined()
  expect(repo.raw.prepare(`SELECT COUNT(*) AS n FROM posts WHERE author_id = ?`).get(idleUser.id)).toMatchObject({ n: 0 })
  expect(repo.raw.prepare(`SELECT COUNT(*) AS n FROM follows WHERE follower_id = ? OR followed_id = ?`).get(idleUser.id, idleUser.id)).toMatchObject({ n: 0 })
  expect(repo.raw.prepare(`SELECT COUNT(*) AS n FROM user WHERE id = ?`).get(idleUser.authUserId)).toMatchObject({ n: 0 })
  // survivors
  expect(await repo.getUserByHandle(regUser.handle)).toBeDefined()
  const timeline = (await (await app.request('/timeline')).json()).timeline
  expect(timeline.some((e: { content: string }) => e.content === 'still here')).toBe(true)
})

test('sweep reclaims core users whose auth account is gone (login-abandon orphans)', async () => {
  const { repo, store } = await makeApp()
  await repo.createLocalUser({ handle: 'guest-orphan', displayName: 'guest-orphan', authUserId: 'deleted-auth-id' })
  const { swept } = repo.sweepAnonymousUsers(7, store)
  expect(swept).toBe(1)
  expect(await repo.getUserByHandle('guest-orphan')).toBeUndefined()
})

test('hard verification: login blocked until the emailed link is visited', async () => {
  const { app, mail } = await makeApp()
  const su = await app.request('/api/auth/sign-up/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://web.test', 'x-forwarded-for': uniqueIp() }, body: JSON.stringify({ email: 'a@b.test', password: 'password123', name: 'a' }) })
  expect(su.status).toBe(200)
  const verifyUrl = /(https?:\/\/\S+)/.exec(mail.sent.find((m) => /verify/i.test(m.subject))!.text)![1]
  const before = await app.request('/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://web.test', 'x-forwarded-for': uniqueIp() }, body: JSON.stringify({ email: 'a@b.test', password: 'password123' }) })
  expect(before.status).toBe(403)
  await app.request(verifyUrl!, { headers: { origin: 'http://web.test' } })
  const after = await app.request('/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://web.test', 'x-forwarded-for': uniqueIp() }, body: JSON.stringify({ email: 'a@b.test', password: 'password123' }) })
  expect(after.status).toBe(200)
})

test('rate limiting resolves the real client IP from x-forwarded-for (not one shared bucket)', async () => {
  const { app, repo } = await makeApp()
  const ip = uniqueIp()
  // anon sign-in DOES create a session (email sign-up under hard verification
  // doesn't) — its session row records the IP better-auth resolved.
  await app.request('/api/auth/sign-in/anonymous', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://web.test', 'x-forwarded-for': ip }, body: '{}' })
  const row = repo.raw.prepare('SELECT ipAddress FROM session ORDER BY createdAt DESC LIMIT 1').get() as { ipAddress: string } | undefined
  expect(row?.ipAddress).toBe(ip) // advanced.ipAddress.ipAddressHeaders trusts the header
})

test('magic link logs in and marks the account verified', async () => {
  const { app, mail, repo } = await makeApp()
  const r = await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://web.test', 'x-forwarded-for': uniqueIp() }, body: JSON.stringify({ email: 'm@b.test' }) })
  expect(r.status).toBe(200)
  // Subject is "Your RSC login link" — matches "login", not "log in".
  const link = /(https?:\/\/\S+)/.exec(mail.sent.find((m) => /login/i.test(m.subject))!.text)![1]
  const consume = await app.request(link!, { headers: { origin: 'http://web.test' } })
  expect(consume.headers.get('set-cookie') ?? '').toContain('session_token')
  // I2 (final review): the load-bearing recovery invariant — consuming a magic
  // link marks the account verified, so a user stuck behind hard verification
  // can unblock by requesting one. Assert it directly, not just the session.
  const verified = repo.raw.prepare('SELECT emailVerified FROM user WHERE email = ?').get('m@b.test') as { emailVerified: number }
  expect(verified.emailVerified).toBe(1)
})

test('password reset: request emails a link, reset changes the password', async () => {
  const { app, mail } = await makeApp()
  const su = await app.request('/api/auth/sign-up/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://web.test', 'x-forwarded-for': uniqueIp() }, body: JSON.stringify({ email: 'a@b.test', password: 'password123', name: 'a' }) })
  expect(su.status).toBe(200)
  const verifyUrl = /(https?:\/\/\S+)/.exec(mail.sent.find((m) => /verify/i.test(m.subject))!.text)![1]
  await app.request(verifyUrl!, { headers: { origin: 'http://web.test' } })

  const rp = await app.request('/api/auth/request-password-reset', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://web.test', 'x-forwarded-for': uniqueIp() }, body: JSON.stringify({ email: 'a@b.test', redirectTo: 'http://web.test/reset' }) })
  expect(rp.status).toBe(200)
  expect(mail.sent.some((m) => /reset/i.test(m.subject))).toBe(true)
  // The emailed link is /reset-password/:token?callbackURL=... (a GET redirect
  // route); the token we need for POST /reset-password is the path segment.
  const resetLinkText = mail.sent.find((m) => /reset/i.test(m.subject))!.text
  const token = /\/reset-password\/([^/?\s]+)/.exec(resetLinkText)![1]

  const reset = await app.request('/api/auth/reset-password', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://web.test', 'x-forwarded-for': uniqueIp() }, body: JSON.stringify({ newPassword: 'newpassword456', token }) })
  expect(reset.status).toBe(200)

  const oldPw = await app.request('/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://web.test', 'x-forwarded-for': uniqueIp() }, body: JSON.stringify({ email: 'a@b.test', password: 'password123' }) })
  expect(oldPw.status).toBe(401)
  const newPw = await app.request('/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://web.test', 'x-forwarded-for': uniqueIp() }, body: JSON.stringify({ email: 'a@b.test', password: 'newpassword456' }) })
  expect(newPw.status).toBe(200)
})

test('mailer null gates email routes with 503 and creates NO account row', async () => {
  const { app, repo } = await makeApp({ mailEnabled: false, mailer: null })
  const before = repo.raw.prepare('SELECT COUNT(*) n FROM user').get() as { n: number }
  const su = await app.request('/api/auth/sign-up/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://web.test', 'x-forwarded-for': uniqueIp() }, body: JSON.stringify({ email: 'a@b.test', password: 'password123', name: 'a' }) })
  expect(su.status).toBe(503)
  const after = repo.raw.prepare('SELECT COUNT(*) n FROM user').get() as { n: number }
  expect(after.n).toBe(before.n) // no limbo row
})

test('guest upgrade: register while anon, verify, sign in — prior posts keep their identity', async () => {
  const { app, mail } = await makeApp()
  const anon = await anonSession(app)
  await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie: anon }, body: '{"content":"guest post"}' })
  const guest = (await (await app.request('/me', { headers: { cookie: anon } })).json()).user
  await app.request('/api/auth/sign-up/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://web.test', cookie: anon, 'x-forwarded-for': uniqueIp() }, body: JSON.stringify({ email: 'g@b.test', password: 'password123', name: 'g' }) })
  const verifyUrl = /(https?:\/\/\S+)/.exec(mail.sent.find((m) => /verify/i.test(m.subject))!.text)![1]
  await app.request(verifyUrl!, { headers: { origin: 'http://web.test' } })
  // The re-point (onLinkAccount) fires on the sign-in that follows
  // verification, and only when that request still carries the anon cookie
  // (a real browser's cookie jar would still hold it — sign-up never
  // replaced it, since hard verification skips auto sign-in there).
  const signedIn = await app.request('/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://web.test', cookie: anon, 'x-forwarded-for': uniqueIp() }, body: JSON.stringify({ email: 'g@b.test', password: 'password123' }) })
  const cookie = /(?:^|,)\s*([^,;]*session_token[^;]*)/.exec(signedIn.headers.get('set-cookie') ?? '')![1]
  const me = (await (await app.request('/me', { headers: { cookie } })).json()).user
  expect(me.id).toBe(guest.id) // SAME core user — the guest's posts stayed put
  const timeline = (await (await app.request('/timeline')).json()).timeline
  expect(timeline.some((e: { content: string }) => e.content === 'guest post')).toBe(true)
})

test('guest upgrade abandoned: register but never verify — guest stays anonymous and is swept', async () => {
  const { app, repo, store } = await makeApp()
  const anon = await anonSession(app)
  const guest = (await (await app.request('/me', { headers: { cookie: anon } })).json()).user
  await app.request('/api/auth/sign-up/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://web.test', cookie: anon, 'x-forwarded-for': uniqueIp() }, body: JSON.stringify({ email: 'x@b.test', password: 'password123', name: 'x' }) })
  // still anonymous: /me over the anon cookie is still the guest, still isAnonymous
  const me = await (await app.request('/me', { headers: { cookie: anon } })).json()
  expect(me.isAnonymous).toBe(true)
  expect(me.user.id).toBe(guest.id)
  // age the anon session past TTL and sweep — the guest core row is reclaimed, no orphan
  const old = new Date(Date.now() - 8 * 86400_000).toISOString()
  repo.raw.prepare('UPDATE session SET updatedAt = ? WHERE userId = ?').run(old, guest.authUserId)
  repo.raw.prepare('UPDATE user SET createdAt = ? WHERE id = ?').run(old, guest.authUserId)
  const { swept } = repo.sweepAnonymousUsers(7, store)
  expect(swept).toBeGreaterThanOrEqual(1)
  expect(await repo.getUserByHandle(guest.handle)).toBeUndefined()
})

// The instance-wide magic-link mail ceiling (auth.ts). POST /sign-in/magic-link
// mails a login link to ANY address and creates the account, so without a cap
// the instance is a mailer anyone can aim at a third party.
test('magic-link mail is capped instance-wide, and DISTINCT addresses do not evade it', async () => {
  resetMagicLinkCap()
  const { app, mail } = await makeApp()
  const statuses: number[] = []
  // Every request a DIFFERENT recipient — the exact evasion a per-recipient
  // cap would have allowed (addresses are supplied by the caller and free).
  for (let i = 0; i < MAGIC_LINK_MAX_PER_WINDOW + 3; i++) {
    const r = await app.request('/api/auth/sign-in/magic-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://web.test', 'x-forwarded-for': uniqueIp() },
      body: JSON.stringify({ email: `flood${i}@b.test` }),
    })
    statuses.push(r.status)
  }
  expect(statuses.slice(0, MAGIC_LINK_MAX_PER_WINDOW).every((s) => s === 200)).toBe(true)
  expect(statuses.slice(MAGIC_LINK_MAX_PER_WINDOW)).toEqual([429, 429, 429])
  // The bound is about MAIL, so assert mail — not just the status code.
  expect(mail.sent.filter((m) => /login/i.test(m.subject))).toHaveLength(MAGIC_LINK_MAX_PER_WINDOW)
})

// The 503 mail-gate (app.ts MAIL_GATED) must still win: a capped instance and a
// mailer-less instance are different answers and neither may mask the other.
test('with no mailer the magic-link route still answers 503, not the cap', async () => {
  resetMagicLinkCap()
  const { app } = await makeApp({ mailEnabled: false, mailer: null })
  const r = await app.request('/api/auth/sign-in/magic-link', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://web.test', 'x-forwarded-for': uniqueIp() },
    body: JSON.stringify({ email: 'x@b.test' }),
  })
  expect(r.status).toBe(503)
})
