# Instance Feed Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make instance feeds admin-managed and removable — an `adminOrToken` gate, `DELETE /users/:handle` (transactional cascade), `GET /admin/feeds`, the SP1 footgun fix, and a web `/admin` feed-management page.

**Architecture:** Core hoists the anon-sweep's cascade into a shared `deleteUserCascade`, adds an `adminOrToken` gate (mirrors `sessionOrToken` with `requireAdmin`), binds one `authed` session middleware reused everywhere (kills the SP1 per-route footgun), re-gates `POST /users`, and adds the DELETE + list routes. Web adds an admin-only `/admin` page proxying to core.

**Tech Stack:** Node 22 (native type stripping), Hono, better-auth, SQLite/better-sqlite3, vitest; SvelteKit (Svelte 5 runes, adapter-node).

**Spec:** `docs/superpowers/specs/2026-07-18-feed-management-design.md` (rev 1).

## Global Constraints

- **Admin-managed instance feeds:** `POST /users` and `DELETE /users/:handle` require **`adminOrToken`** — ops bearer token OR an admin session (403 non-admin, 401 no session). This is the accepted regular-user gap.
- **Footgun fix:** bind `const authed = sessionAuth(deps.auth, deps.users, adminEmails)` once in `createApp` and reuse it on every session route — so `requireAdmin`/`adminOrToken` always see the real `adminEmails`.
- **Remove = shared cascade:** `DELETE` uses one `deleteUserCascade(id)` storage method (hoisted from `sweepAnonymousUsers`' `coreCascade`), run in a transaction, order `follows → push_subscriptions → posts → users`. **404** unknown handle, **409** `{ error: 'not a remote feed' }` for a local user, **200** `{ ok: true }` on success.
- **Cascade semantics:** the removed feed's posts are deleted; local replies to them survive as orphans (`in_reply_to_post_id` is not a FK). No explicit remote WebSub unsubscribe (deferred).
- **Web `/admin` is admin-only** (load gated on `data.me.isAdmin`), one plain page (list + add + remove). It MUST be built via `ui-ux-pro-max:ui-ux-pro-max` **and** `ui-ux-pro-max:ui-styling`, follow `design-system/textcaster/MASTER.md`, use `--color-*` vars from `web/src/app.css` (no raw hex), and consult `svelte-skills` (`sveltekit-data-flow`, `svelte-runes`).
- Node 22 native type stripping means vitest does NOT type-check — run `npm run typecheck -w core` / `npm run check -w web` before committing. **Never `git add -A`.** Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Hoist `deleteUserCascade` (storage) + reuse in the sweep

**Files:**
- Modify: `core/src/storage/sqlite.ts` (add `deleteUserCascade`; replace the `coreCascade` closure in `sweepAnonymousUsers` with calls to it)
- Modify: `core/src/domain/repository.ts` (add `deleteUserCascade` to the interface)
- Test: `core/test/delete-cascade.test.ts` (create)

**Interfaces:**
- Produces: `SqliteRepository.deleteUserCascade(id: string): void` — deletes a user's follows (either direction), push_subscriptions, posts, and the user row, in one transaction. Added to the `Repository` interface.

- [ ] **Step 1: Write the failing test**

Create `core/test/delete-cascade.test.ts`:

```ts
import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'

test('deleteUserCascade removes a remote user and its posts', async () => {
  const repo = await createSqliteRepository(':memory:')
  const u = await repo.createRemoteUser({ handle: 'peer', displayName: 'Peer', feedUrl: 'https://ex.com/f.xml' })
  await repo.insertPost({
    id: 'p1', authorId: u.id, source: 'remote', guid: 'g1', title: null, content: 'hi',
    url: 'https://ex.com/post/1', publishedAt: '2026-07-18T00:00:00Z', createdAt: '2026-07-18T00:00:00Z',
    inReplyTo: null, inReplyToPostId: null, threadRootId: null,
  })
  expect(await repo.getUserByHandle('peer')).toBeTruthy()

  repo.deleteUserCascade(u.id)

  expect(await repo.getUserByHandle('peer')).toBeUndefined()
  expect((await repo.getTimeline(50)).length).toBe(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w core -- delete-cascade`
Expected: FAIL — `repo.deleteUserCascade is not a function`.

- [ ] **Step 3: Add `deleteUserCascade` to `core/src/storage/sqlite.ts`**

Add this method to the `SqliteRepository` class (near `sweepAnonymousUsers`):

```ts
  // Manual cascade for a user (no DB-level ON DELETE CASCADE; FKs are plain
  // REFERENCES users(id)). Shared by sweepAnonymousUsers and DELETE /users.
  deleteUserCascade(id: string): void {
    const raw = this.raw
    raw.transaction(() => {
      raw.prepare(`DELETE FROM follows WHERE follower_id = ? OR followed_id = ?`).run(id, id)
      raw.prepare(`DELETE FROM push_subscriptions WHERE user_id = ?`).run(id)
      raw.prepare(`DELETE FROM posts WHERE author_id = ?`).run(id)
      raw.prepare(`DELETE FROM users WHERE id = ?`).run(id)
    })()
  }
```

- [ ] **Step 4: Replace the sweep's inline `coreCascade` with the method**

In `sweepAnonymousUsers`, delete the local `const coreCascade = (coreUserId: string) => { … }` closure and replace its two call sites (`coreCascade(core.id)` and `coreCascade(o.id)`) with `this.deleteUserCascade(core.id)` and `this.deleteUserCascade(o.id)`. (The sweep's outer `raw.transaction(...)` still wraps them; `deleteUserCascade`'s own transaction nests as a savepoint — better-sqlite3 supports this.)

- [ ] **Step 5: Add to the `Repository` interface**

In `core/src/domain/repository.ts`, add to the `Repository` interface (near `listRemoteUsers`):

```ts
  deleteUserCascade(id: string): void
```

- [ ] **Step 6: Run the cascade test + the sweep tests (no regression)**

Run: `npm test -w core -- delete-cascade`
Expected: PASS.
Run: `npm test -w core` then confirm the anon-sweep tests still pass (search output for the sweep test file — it must stay green).
Run: `npm run typecheck -w core`
Expected: clean (exit 0).

- [ ] **Step 7: Commit**

```bash
git add core/src/storage/sqlite.ts core/src/domain/repository.ts core/test/delete-cascade.test.ts
git commit -m "core: hoist deleteUserCascade (shared by sweep + upcoming DELETE /users)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `adminOrToken` gate + footgun fix + re-gate `POST /users`

**Files:**
- Modify: `core/src/api/auth.ts` (add `adminOrToken`)
- Modify: `core/src/api/app.ts` (bind `authed`; reuse it; swap `POST /users` to `adminOrToken`)
- Test: `core/test/admin-feeds.test.ts` (create — grows in Task 3)

**Interfaces:**
- Consumes: `sessionAuth`, `requireAdmin`, `bearerAuth` (existing in `auth.ts`).
- Produces: `adminOrToken(token, auth, users, adminEmails?): MiddlewareHandler` — bearer token OR admin session.

- [ ] **Step 1: Write the failing test**

Create `core/test/admin-feeds.test.ts`:

```ts
import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'
import { makeAuth, anonSession, registeredSession } from './auth-helper.ts'

async function makeApp(adminEmails: string[] = ['boss@x.test']) {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const app = createApp({ service, bus, token: 'secret', auth: makeAuth(repo), users: repo, adminEmails: new Set(adminEmails) })
  return { app, repo }
}
const body = (handle: string) => JSON.stringify({ handle, displayName: handle, feedUrl: 'https://ex.com/f.xml' })

test('POST /users: bearer token allowed', async () => {
  const { app } = await makeApp()
  const res = await app.request('/users', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: body('news') })
  expect(res.status).toBe(201)
})
test('POST /users: admin session allowed', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  const res = await app.request('/users', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: body('news2') })
  expect(res.status).toBe(201)
})
test('POST /users: non-admin registered session → 403', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'peon@x.test', repo)
  const res = await app.request('/users', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: body('news3') })
  expect(res.status).toBe(403)
})
test('POST /users: anonymous session → 403 (a session, just not admin — matches SP1 /admin/status)', async () => {
  const { app } = await makeApp()
  const cookie = await anonSession(app)
  const res = await app.request('/users', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: body('news4') })
  expect(res.status).toBe(403)
})
test('POST /users: no session at all → 401', async () => {
  const { app } = await makeApp()
  const res = await app.request('/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body('news5') })
  expect(res.status).toBe(401)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w core -- admin-feeds`
Expected: FAIL — non-admin session currently gets 201 (still `sessionOrToken`), so the 403 test fails.

- [ ] **Step 3: Add `adminOrToken` to `core/src/api/auth.ts`**

Add after `sessionOrToken` (mirrors it, `requireAdmin` in place of `registeredOnly`):

```ts
// Admin-gated writes (feed add/remove): ops bearer token OR an admin session.
export function adminOrToken(token: string, auth: Auth, users: UserDirectory, adminEmails: ReadonlySet<string> = new Set()): MiddlewareHandler {
  const viaSession = sessionAuth(auth, users, adminEmails)
  const mustBeAdmin = requireAdmin()
  return async (c, next) => {
    const header = c.req.header('authorization')
    if (header !== undefined) return bearerAuth(token)(c, next)
    return viaSession(c, (() => mustBeAdmin(c, next)) as unknown as Next)
  }
}
```

- [ ] **Step 4: Bind `authed` and re-gate `POST /users` in `core/src/api/app.ts`**

Update the import to add `adminOrToken`:

```ts
import { sessionAuth, registeredOnly, sessionOrToken, requireAdmin, adminOrToken } from './auth.ts'
```

Just after `const adminEmails = deps.adminEmails ?? new Set<string>()`, bind the session middleware once:

```ts
  const authed = sessionAuth(deps.auth, deps.users, adminEmails)
```

Change `POST /users` (line ~82) from `sessionOrToken(token, deps.auth, deps.users)` to:

```ts
  app.post('/users', adminOrToken(token, deps.auth, deps.users, adminEmails), async (c) => {
```

Replace every remaining `sessionAuth(deps.auth, deps.users)` and `sessionAuth(deps.auth, deps.users, adminEmails)` call with the bound `authed` — at these routes: `POST /posts`, `GET /me`, `GET /admin/status`, `PATCH /me`, `POST /me/follows`, `DELETE /me/follows/:target`, `POST /me/follows/opml`. (e.g. `app.get('/me', authed, (c) => …)`, `app.post('/me/follows/opml', authed, registeredOnly(), …)`.) `sessionOrToken` is no longer used — leave its import if other code references it, otherwise the linter is fine either way.

- [ ] **Step 5: Run the test + typecheck**

Run: `npm test -w core -- admin-feeds`
Expected: PASS (4/4 — token/admin allowed, non-admin 403, anon 401).
Run: `npm run typecheck -w core` → clean.

- [ ] **Step 6: Run the full suite (the `sessionAuth`→`authed` swap must not regress)**

Run: `npm test -w core`
Expected: all pass (the bound `authed` is identical behavior with the real `adminEmails`; `/admin/status` from SP1 keeps working).

- [ ] **Step 7: Commit**

```bash
git add core/src/api/auth.ts core/src/api/app.ts core/test/admin-feeds.test.ts
git commit -m "core: adminOrToken gate + bind one authed middleware; re-gate POST /users to admin

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `DELETE /users/:handle` + `GET /admin/feeds`

**Files:**
- Modify: `core/src/domain/service.ts` (add `removeRemoteFeed`)
- Modify: `core/src/api/app.ts` (add the two routes)
- Test: `core/test/admin-feeds.test.ts` (extend)

**Interfaces:**
- Consumes: `deleteUserCascade` (Task 1), `adminOrToken`/`authed`/`requireAdmin` (Task 2), existing `service.listRemoteUsers()`, `repo.getUserByHandle`.
- Produces: `service.removeRemoteFeed(handle): Promise<{ ok: true } | { error: 'unknown' | 'local' }>`; routes `DELETE /users/:handle`, `GET /admin/feeds`.

- [ ] **Step 1: Write the failing tests (append to `core/test/admin-feeds.test.ts`)**

```ts
test('DELETE /users/:handle removes a remote feed and cascades', async () => {
  const { app } = await makeApp()
  await app.request('/users', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: body('gone') })
  const del = await app.request('/users/gone', { method: 'DELETE', headers: { authorization: 'Bearer secret' } })
  expect(del.status).toBe(200)
  // A remote user's /users/:handle/feed.xml 302-redirects to its external feed
  // while it exists; once removed it 404s — proving the row is gone.
  const gone = await app.request('/users/gone/feed.xml', { redirect: 'manual' })
  expect(gone.status).toBe(404)
})
test('DELETE /users/:handle: 404 unknown handle', async () => {
  const { app } = await makeApp()
  const res = await app.request('/users/nope', { method: 'DELETE', headers: { authorization: 'Bearer secret' } })
  expect(res.status).toBe(404)
})
test('DELETE /users/:handle: 409 on a local user', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ content: 'hi' }) })
  const me = await (await app.request('/me', { headers: { cookie } })).json()
  const res = await app.request(`/users/${me.user.handle}`, { method: 'DELETE', headers: { authorization: 'Bearer secret' } })
  expect(res.status).toBe(409)
})
test('DELETE cascades but a local reply to a removed post survives (orphaned)', async () => {
  const { app, repo } = await makeApp()
  const remote = await repo.createRemoteUser({ handle: 'gone2', displayName: 'Gone2', feedUrl: 'https://ex.com/g.xml' })
  await repo.insertPost({ id: 'rp', authorId: remote.id, source: 'remote', guid: 'rg', title: null, content: 'remote post', url: 'https://ex.com/post/rp', publishedAt: '2026-07-18T00:00:00Z', createdAt: '2026-07-18T00:00:00Z', inReplyTo: null, inReplyToPostId: null, threadRootId: null })
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  const reply = await (await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ content: 'my reply', inReplyTo: 'rp' }) })).json()
  await app.request('/users/gone2', { method: 'DELETE', headers: { authorization: 'Bearer secret' } })
  const tl = await (await app.request('/timeline?limit=50')).json()
  expect(tl.timeline.some((p: { id: string }) => p.id === reply.post.id)).toBe(true) // reply survives
  expect(tl.timeline.some((p: { id: string }) => p.id === 'rp')).toBe(false)         // remote post gone
})
test('GET /admin/feeds: admin lists feeds; non-admin 403; anon 401', async () => {
  const { app, repo } = await makeApp()
  await app.request('/users', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: body('shown') })
  const adminCookie = await registeredSession(app, 'boss@x.test', repo)
  const ok = await app.request('/admin/feeds', { headers: { cookie: adminCookie } })
  expect(ok.status).toBe(200)
  expect((await ok.json()).feeds.some((f: { handle: string }) => f.handle === 'shown')).toBe(true)
  const peon = await registeredSession(app, 'peon@x.test', repo)
  expect((await app.request('/admin/feeds', { headers: { cookie: peon } })).status).toBe(403)
  expect((await app.request('/admin/feeds', { headers: { cookie: await anonSession(app) } })).status).toBe(403) // anon session = not admin
  expect((await app.request('/admin/feeds')).status).toBe(401) // no session
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w core -- admin-feeds`
Expected: FAIL — `DELETE /users/:handle` and `GET /admin/feeds` are 404 (routes don't exist).

- [ ] **Step 3: Add `removeRemoteFeed` to `core/src/domain/service.ts`**

Add to the service object (near `listRemoteUsers` / `getUserByHandle`; `normalizeHandle` is already imported there):

```ts
    async removeRemoteFeed(handle: string): Promise<{ ok: true } | { error: 'unknown' | 'local' }> {
      const user = await repo.getUserByHandle(normalizeHandle(handle))
      if (!user) return { error: 'unknown' }
      if (user.kind !== 'remote') return { error: 'local' }
      repo.deleteUserCascade(user.id)
      return { ok: true }
    },
```

- [ ] **Step 4: Add the two routes in `core/src/api/app.ts`**

Add immediately after the `GET /admin/status` route:

```ts
  app.get('/admin/feeds', authed, requireAdmin(), async (c) => {
    const feeds = await service.listRemoteUsers()
    return c.json({ feeds: feeds.map((u) => ({ handle: u.handle, displayName: u.displayName, feedUrl: u.feedUrl })) })
  })

  app.delete('/users/:handle', adminOrToken(token, deps.auth, deps.users, adminEmails), async (c) => {
    const result = await service.removeRemoteFeed(c.req.param('handle') ?? '')
    if ('error' in result) return c.json({ error: result.error === 'unknown' ? 'unknown feed' : 'not a remote feed' }, result.error === 'unknown' ? 404 : 409)
    return c.json({ ok: true }, 200)
  })
```

- [ ] **Step 5: Run the tests + typecheck**

Run: `npm test -w core -- admin-feeds`
Expected: PASS (all — DELETE cascade/404/409/orphan, GET admin/non-admin/anon).
Run: `npm run typecheck -w core` → clean.

- [ ] **Step 6: Full suite**

Run: `npm test -w core`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add core/src/domain/service.ts core/src/api/app.ts core/test/admin-feeds.test.ts
git commit -m "core: DELETE /users/:handle (cascade) + GET /admin/feeds

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Web `/admin` feed-management page

**Files:**
- Modify: `web/src/lib/api.ts` (add `isAdmin` to `getMe`'s type; add `listAdminFeeds`, `removeRemoteFeed`)
- Create: `web/src/routes/admin/+page.server.ts`
- Create: `web/src/routes/admin/+page.svelte`

**Interfaces:**
- Consumes: core `GET /admin/feeds`, `POST /users`, `DELETE /users/:handle` (Tasks 2-3); existing `authedFetch`, `cookieHeader` (`$lib/server/session`), `addRemoteUser` (`$lib/api`), `data.me` (from `+layout.server.ts` → `getMe`).

- [ ] **Step 1: Invoke the UI skills FIRST (required by project convention)**

Before writing any markup, invoke **`ui-ux-pro-max:ui-ux-pro-max`** and **`ui-ux-pro-max:ui-styling`**, and read `design-system/textcaster/MASTER.md`. Consult `svelte-skills` (`sveltekit-data-flow` for the load/actions shape, `svelte-runes` for any component state). All colors must come from `--color-*` vars in `web/src/app.css` — no raw hex.

- [ ] **Step 2: Extend `web/src/lib/api.ts`**

Add `isAdmin` to `getMe`'s return type (SP1 added it to core's `/me` response; the type must reflect it so `data.me.isAdmin` typechecks):

```ts
export async function getMe(f: typeof fetch): Promise<{ user: TimelineEntry['author']; isAnonymous: boolean; emailVerified?: boolean; isAdmin?: boolean } | null> {
  const res = await f(`${base()}/me`)
  if (res.status === 401) return null
  if (!res.ok) throw new Error(await errorMessage(res, 'getMe failed'))
  return (await res.json()) as { user: TimelineEntry['author']; isAnonymous: boolean; emailVerified?: boolean; isAdmin?: boolean }
}
```

Add two client functions (mirror `addRemoteUser`'s style):

```ts
export async function listAdminFeeds(f: typeof fetch): Promise<Array<{ handle: string; displayName: string; feedUrl: string | null }>> {
  const res = await f(`${base()}/admin/feeds`)
  if (!res.ok) throw new Error(await errorMessage(res, 'listAdminFeeds failed'))
  return ((await res.json()) as { feeds: Array<{ handle: string; displayName: string; feedUrl: string | null }> }).feeds
}

export async function removeRemoteFeed(f: typeof fetch, handle: string): Promise<void> {
  const res = await f(`${base()}/users/${encodeURIComponent(handle)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await errorMessage(res, 'removeRemoteFeed failed'))
}
```

- [ ] **Step 3: Create `web/src/routes/admin/+page.server.ts`**

```ts
import { error, fail } from '@sveltejs/kit'
import { authedFetch, cookieHeader } from '$lib/server/session'
import { listAdminFeeds, addRemoteUser, removeRemoteFeed } from '$lib/api'
import type { Actions, PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ parent, fetch, url, cookies }) => {
  const { me } = await parent()
  if (!me?.isAdmin) throw error(404, 'Not found') // admin-only; hide existence
  const f = authedFetch(fetch, url.origin, cookieHeader(cookies))
  return { feeds: await listAdminFeeds(f) }
}

export const actions: Actions = {
  add: async (event) => {
    const form = await event.request.formData()
    const feedUrl = String(form.get('feedUrl') ?? '').trim()
    const handle = String(form.get('handle') ?? '').trim()
    const displayName = String(form.get('displayName') ?? '').trim()
    if (!handle || !feedUrl) return fail(400, { error: 'handle and feedUrl are required' })
    try {
      const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
      await addRemoteUser(f, { handle, displayName: displayName || handle, feedUrl })
    } catch (err) {
      return fail(400, { error: err instanceof Error ? err.message : 'add failed' })
    }
    return { added: true }
  },
  remove: async (event) => {
    const form = await event.request.formData()
    const handle = String(form.get('handle') ?? '').trim()
    if (!handle) return fail(400, { error: 'handle required' })
    try {
      const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
      await removeRemoteFeed(f, handle)
    } catch (err) {
      return fail(400, { error: err instanceof Error ? err.message : 'remove failed' })
    }
    return { removed: true }
  },
}
```

- [ ] **Step 4: Create `web/src/routes/admin/+page.svelte`**

Build the page per the UI skills + MASTER.md (Step 1). It must: show a heading; render `data.feeds` as a list, each row showing `handle` + `feedUrl` with a **remove** `<form method="POST" action="?/remove">` (hidden `handle` input + a submit button, `use:enhance`); and an **add** `<form method="POST" action="?/add">` with `feedUrl` (required), `handle` (required), and optional `displayName` inputs. Use `--color-*` tokens from `web/src/app.css`, Public Sans / Libre Bodoni per MASTER.md, and show `form?.error` inline. No raw hex, no inline color literals. Keep it no-JS-functional (plain form posts); `use:enhance` is a progressive enhancement.

- [ ] **Step 5: Typecheck + build the web workspace**

Run: `npm run check -w web`
Expected: svelte-check clean (0 errors) — in particular `data.me.isAdmin` and the new `$lib/api` functions typecheck.
Run: `npm run build -w web`
Expected: build succeeds (the `/admin` route compiles).

- [ ] **Step 6: Run the web test suite (no regression)**

Run: `npm test -w web`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/api.ts web/src/routes/admin/+page.server.ts web/src/routes/admin/+page.svelte
git commit -m "web: admin-only /admin feed-management page (list/add/remove)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Notes for the executor

- Tasks 1→2→3 are core (each independently testable); Task 3 needs Tasks 1+2; Task 4 (web) needs Task 3's routes live in the API contract (it calls them — the core routes already exist by then).
- The security-sensitive pieces are `adminOrToken` (Task 2) and `deleteUserCascade` (Task 1); the whole-branch review will re-scrutinize them.
- **Live cleanup (post-merge, human/controller):** after this deploys to the instances, `DELETE /users/main` on alice + bob (via the admin UI or `cloudron exec ... curl -X DELETE .../users/main` with the ops token) to drop the redundant guest-feed sub. Not a code task.
- Task 4 must not skip the UI skills — the page is real UI on a public instance.
