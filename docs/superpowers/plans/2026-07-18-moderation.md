# Moderation (SP3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An instance admin can permanently delete a local account (and its content) or a single local post, from the admin surface — hard removal, no new schema, no labeling.

**Architecture:** Two admin-gated core endpoints (`DELETE /admin/users/:handle`, `DELETE /admin/posts/:id`) backed by service orchestration over thin repo primitives (mirroring `removeRemoteFeed`), reusing `deleteUserCascade` and a `deleteAuthRows` helper extracted from `sweepAnonymousUsers`. Web: a "Delete account" action on `/admin/users`, and an admin-only "Remove" affordance on local posts in the timeline + post-detail.

**Tech Stack:** Hono/Node core (better-sqlite3 + Kysely, Node 22 native type-stripping — no build step, no TS parameter properties), SvelteKit web (Svelte 5 runes, plain scoped CSS `--color-*` tokens), vitest.

**Spec:** `docs/superpowers/specs/2026-07-18-moderation-design.md` (rev 1).

## Global Constraints

- **Hard removal only** — no suspend/ban/hide flag, no labeling/reports. Deletion is the lever.
- **`service.deleteLocalAccount(handle)`** and **`service.deletePost(id)`** own lookup + kind-check + a discriminated result (`{ ok: true } | { error: … }`), mirroring `removeRemoteFeed`; the repo stays primitives-only.
- **`repo.deleteAuthRows(authUserId)`** is extracted from `sweepAnonymousUsers`'s inline `session`/`account`/`user` teardown (wrapped in a transaction), and `sweepAnonymousUsers` is refactored to call it — one source, not a re-typed block.
- **No admin-delete guard** — an admin may delete *any* local account, including one whose email is in `adminEmails`. (Deleting the account does not touch the `TEXTCASTER_ADMIN_EMAIL` env allowlist.)
- **Kind checks:** account delete → 409 (`not a local account`) on a remote handle; post delete → 409 (`not a local post`) on a remote post; both → 404 on unknown; 200 on success.
- **Both endpoints** are `authed` + `requireAdmin()` (admin session, **not** the ops token) under `/admin/*`. SP2's `DELETE /users/:handle` (remote feeds, 409-on-local) is **left unchanged**.
- **Web:** destructive actions use `--color-destructive`, are confirmation-guarded (`use:enhance` + `confirm()`), and work no-JS (plain form POST). The post "Remove" is gated on `data.me?.isAdmin && post.source === 'local'`, placed beside the existing owner-`Edit` affordance. Built via `ui-ux-pro-max:ui-ux-pro-max` + MASTER.md; no raw hex, no `{@html}`.
- **No TS parameter properties** in core/src. Shared checkout: stage explicit paths, **never `git add -A`**. Commit trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Known flaky: a full `npm test -w core` may show one `ingest.test.ts > pollAll swallows an oversized feed` timeout — a load artifact, passes isolated; not a regression.
- **Coordination:** the parallel session landed Live-edits (`PATCH /posts/:id`, revisions, the owner-`Edit` link on the timeline + post-detail). Task 4 edits those same two page files — re-read their current state before editing and place "Remove" beside the existing `Edit` block; do not touch the Live-edits code.

## File Structure

- **Modify `core/src/domain/repository.ts`** — add `deleteAuthRows` + `deletePost` to the `Repository` interface.
- **Modify `core/src/storage/sqlite.ts`** — `deleteAuthRows` (extract from sweep, refactor sweep); `deletePost`.
- **Modify `core/src/domain/service.ts`** — `deleteLocalAccount` + `deletePost` (delegating).
- **Modify `core/src/api/app.ts`** — `DELETE /admin/users/:handle` + `DELETE /admin/posts/:id`.
- **Modify `core/src/storage/repository-contract.ts`** — if it enumerates repo methods for the contract suite, add the two (check first).
- **Create `core/test/moderation.test.ts`** — endpoint + service tests.
- **Create `web/src/lib/confirm.ts`** — one `confirmSubmit(message)` `use:enhance` guard, reused by every destructive action (account + post, both surfaces).
- **Modify `web/src/lib/api.ts`** (+ `api.test.ts`) — `deleteLocalAccount`, `deletePost`.
- **Modify `web/src/routes/admin/users/+page.server.ts` + `+page.svelte`** — delete-account action + button.
- **Modify `web/src/routes/+page.server.ts` + `+page.svelte`** — timeline `deletePost` action + Remove affordance.
- **Modify `web/src/routes/post/[id]/+page.server.ts` + `+page.svelte`** — post-detail `deletePost` action + Remove affordance.

---

### Task 1: Core — delete a local account

**Files:**
- Modify: `core/src/domain/repository.ts` (interface), `core/src/storage/sqlite.ts` (`deleteAuthRows` + sweep refactor), `core/src/domain/service.ts` (`deleteLocalAccount`), `core/src/api/app.ts` (route)
- Test: `core/test/moderation.test.ts`

**Interfaces:**
- Consumes: `this.raw`, `deleteUserCascade` (existing), `getUserByHandle` (returns `User` with `.kind`, `.id`, `.authUserId`), `normalizeHandle` (service-local), `authed`/`requireAdmin`.
- Produces: `Repository.deleteAuthRows(authUserId: string): void`; `service.deleteLocalAccount(handle: string): Promise<{ ok: true } | { error: 'unknown' | 'remote' }>`; `DELETE /admin/users/:handle`.

- [ ] **Step 1: Write the failing test** — `core/test/moderation.test.ts`

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
  return { app, repo, service }
}

test('deleteLocalAccount removes the core user + posts + better-auth rows', async () => {
  const { app, repo, service } = await makeApp()
  const cookie = await registeredSession(app, 'target@x.test', repo)
  const me = await (await app.request('/me', { headers: { cookie } })).json() // lazy-mints + returns the core user
  const handle = me.user.handle
  await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ content: 'bad post' }) })
  const authRow = repo.raw.prepare('SELECT id FROM user WHERE email = ?').get('target@x.test') as { id: string }

  expect(await service.deleteLocalAccount(handle)).toEqual({ ok: true })
  expect(await repo.getUserByHandle(handle)).toBeUndefined()                                    // core user gone
  expect(repo.instanceStats().posts).toBe(0)                                                    // their post cascaded away
  expect(repo.raw.prepare('SELECT id FROM user WHERE id = ?').get(authRow.id)).toBeUndefined()  // better-auth user gone
  expect(repo.raw.prepare('SELECT id FROM session WHERE userId = ?').get(authRow.id)).toBeUndefined()
  expect(repo.raw.prepare('SELECT id FROM account WHERE userId = ?').get(authRow.id)).toBeUndefined()
})

test('deleteLocalAccount: unknown → error unknown; a remote feed → error remote', async () => {
  const { repo, service } = await makeApp()
  expect(await service.deleteLocalAccount('nope')).toEqual({ error: 'unknown' })
  await repo.createRemoteUser({ handle: 'feed1', displayName: 'Feed', feedUrl: 'https://e/f.xml' })
  expect(await service.deleteLocalAccount('feed1')).toEqual({ error: 'remote' })
})

test('DELETE /admin/users/:handle: deletes even an admin-email account (no guard); 409 remote; 404 unknown', async () => {
  const { app, repo } = await makeApp(['boss@x.test', 'other@x.test'])
  // 'other@x.test' is ALSO an admin email — register + mint its local account
  const otherCookie = await registeredSession(app, 'other@x.test', repo)
  const other = await (await app.request('/me', { headers: { cookie: otherCookie } })).json()
  // boss (a different admin) deletes other's admin-email account → 200 (no guard), boss's own session untouched
  const admin = await registeredSession(app, 'boss@x.test', repo)
  expect((await app.request(`/admin/users/${other.user.handle}`, { method: 'DELETE', headers: { cookie: admin } })).status).toBe(200)

  await repo.createRemoteUser({ handle: 'feed2', displayName: 'F', feedUrl: 'https://e/f.xml' })
  expect((await app.request('/admin/users/feed2', { method: 'DELETE', headers: { cookie: admin } })).status).toBe(409)
  expect((await app.request('/admin/users/ghost', { method: 'DELETE', headers: { cookie: admin } })).status).toBe(404)
})

test('DELETE /admin/users/:handle gate: non-admin 403, anon 403, no session 401', async () => {
  const { app, repo } = await makeApp()
  await repo.createRemoteUser({ handle: 'x', displayName: 'X', feedUrl: 'https://e/x.xml' })
  expect((await app.request('/admin/users/x', { method: 'DELETE', headers: { cookie: await registeredSession(app, 'peon@x.test', repo) } })).status).toBe(403)
  expect((await app.request('/admin/users/x', { method: 'DELETE', headers: { cookie: await anonSession(app) } })).status).toBe(403)
  expect((await app.request('/admin/users/x', { method: 'DELETE' })).status).toBe(401)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w core -- moderation`
Expected: FAIL — `service.deleteLocalAccount is not a function` / route 404.

- [ ] **Step 3: Extract `deleteAuthRows` + refactor the sweep** (`core/src/storage/sqlite.ts`)

Add the method (near `deleteUserCascade`):

```ts
  deleteAuthRows(authUserId: string): void {
    const raw = this.raw
    raw.transaction(() => {
      raw.prepare(`DELETE FROM session WHERE userId = ?`).run(authUserId)
      raw.prepare(`DELETE FROM account WHERE userId = ?`).run(authUserId)
      raw.prepare(`DELETE FROM user WHERE id = ?`).run(authUserId)
    })()
  }
```

In `sweepAnonymousUsers`, replace the three inline deletes in the idle loop:

```ts
        const core = raw.prepare(`SELECT id FROM users WHERE auth_user_id = ?`).get(a.id) as { id: string } | undefined
        if (core) this.deleteUserCascade(core.id)
        this.deleteAuthRows(a.id)
        swept++
```

(The nested `raw.transaction` inside the sweep's outer transaction is a harmless savepoint.)

- [ ] **Step 4: Add `deleteAuthRows` to the `Repository` interface** (`core/src/domain/repository.ts`, beside `deleteUserCascade`)

```ts
  deleteAuthRows(authUserId: string): void
```

- [ ] **Step 5: Add `deleteLocalAccount` to the service** (`core/src/domain/service.ts`, near `removeRemoteFeed`)

```ts
    async deleteLocalAccount(handle: string): Promise<{ ok: true } | { error: 'unknown' | 'remote' }> {
      const user = await repo.getUserByHandle(normalizeHandle(handle))
      if (!user) return { error: 'unknown' }
      if (user.kind !== 'local') return { error: 'remote' }
      repo.deleteUserCascade(user.id)
      if (user.authUserId) repo.deleteAuthRows(user.authUserId)
      return { ok: true }
    },
```

- [ ] **Step 6: Add the route** (`core/src/api/app.ts`, near `DELETE /users/:handle` / the `/admin/*` block)

```ts
  app.delete('/admin/users/:handle', authed, requireAdmin(), async (c) => {
    const result = await service.deleteLocalAccount(c.req.param('handle') ?? '')
    if ('error' in result) return c.json({ error: result.error === 'unknown' ? 'unknown user' : 'not a local account' }, result.error === 'unknown' ? 404 : 409)
    return c.json({ ok: true }, 200)
  })
```

- [ ] **Step 7: Run tests + typecheck**

Run: `npm test -w core -- moderation` → PASS. `npm run typecheck -w core` → clean. `npm test -w core` once (apply the ingest-flaky note) → all pass.

- [ ] **Step 8: Commit**

```bash
git add core/src/domain/repository.ts core/src/storage/sqlite.ts core/src/domain/service.ts core/src/api/app.ts core/test/moderation.test.ts
git commit -m "core: DELETE /admin/users/:handle — delete a local account (cascade + auth rows)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Core — delete a single local post

**Files:**
- Modify: `core/src/domain/repository.ts` (interface), `core/src/storage/sqlite.ts` (`deletePost`), `core/src/domain/service.ts` (`deletePost`), `core/src/api/app.ts` (route)
- Test: extend `core/test/moderation.test.ts`

**Interfaces:**
- Consumes: `getPost(id)` (returns `Post` with `.source`, `.id`), the Kysely `db`.
- Produces: `Repository.deletePost(id: string): Promise<void>`; `service.deletePost(id: string): Promise<{ ok: true } | { error: 'unknown' | 'remote' }>`; `DELETE /admin/posts/:id`.

- [ ] **Step 1: Write the failing test** (append to `core/test/moderation.test.ts`)

```ts
test('deletePost removes a local post; 409 remote, 404 unknown', async () => {
  const { app, repo, service } = await makeApp()
  const cookie = await registeredSession(app, 'a@x.test', repo)
  await app.request('/me', { headers: { cookie } })
  const created = await (await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ content: 'nuke me' }) })).json()
  const postId = created.post.id

  expect(await service.deletePost(postId)).toEqual({ ok: true })
  expect(await repo.getPost(postId)).toBeUndefined()

  // a remote post → error remote
  const remote = await repo.createRemoteUser({ handle: 'rf', displayName: 'RF', feedUrl: 'https://e/f.xml' })
  await repo.insertPost({ id: 'rp', authorId: remote.id, source: 'remote', guid: 'rg', title: null, content: 'x', url: 'https://e/p', publishedAt: '2026-07-18T00:00:00Z', createdAt: '2026-07-18T00:00:00Z', inReplyTo: null, inReplyToPostId: null, threadRootId: null })
  expect(await service.deletePost('rp')).toEqual({ error: 'remote' })
  expect(await service.deletePost('ghost')).toEqual({ error: 'unknown' })
})

test('DELETE /admin/posts/:id: 200 local, 409 remote, 404 unknown; gate matrix', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'a@x.test', repo)
  await app.request('/me', { headers: { cookie } })
  const created = await (await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ content: 'p' }) })).json()
  const admin = await registeredSession(app, 'boss@x.test', repo)
  expect((await app.request(`/admin/posts/${created.post.id}`, { method: 'DELETE', headers: { cookie: admin } })).status).toBe(200)
  const remote = await repo.createRemoteUser({ handle: 'rf2', displayName: 'RF', feedUrl: 'https://e/f.xml' })
  await repo.insertPost({ id: 'rp2', authorId: remote.id, source: 'remote', guid: 'rg2', title: null, content: 'x', url: 'https://e/p2', publishedAt: '2026-07-18T00:00:00Z', createdAt: '2026-07-18T00:00:00Z', inReplyTo: null, inReplyToPostId: null, threadRootId: null })
  const admin2 = await registeredSession(app, 'boss@x.test', repo)
  expect((await app.request('/admin/posts/rp2', { method: 'DELETE', headers: { cookie: admin2 } })).status).toBe(409)
  expect((await app.request('/admin/posts/ghost', { method: 'DELETE', headers: { cookie: admin2 } })).status).toBe(404)
  expect((await app.request('/admin/posts/rp2', { method: 'DELETE', headers: { cookie: await anonSession(app) } })).status).toBe(403)
  expect((await app.request('/admin/posts/rp2', { method: 'DELETE' })).status).toBe(401)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w core -- moderation`
Expected: FAIL — `service.deletePost is not a function` / route 404.

- [ ] **Step 3: Add `deletePost` to the `Repository` interface**

```ts
  deletePost(id: string): Promise<void>
```

- [ ] **Step 4: Implement on `SqliteRepository`** (near `getPost`/`insertPost`)

```ts
  async deletePost(id: string): Promise<void> {
    await this.db.deleteFrom('posts').where('id', '=', id).execute()
  }
```

(A reply to the deleted post survives — `in_reply_to_post_id` is not a foreign key — matching the account-cascade semantics.)

- [ ] **Step 5: Add `deletePost` to the service** (near `deleteLocalAccount`)

```ts
    async deletePost(id: string): Promise<{ ok: true } | { error: 'unknown' | 'remote' }> {
      const post = await repo.getPost(id)
      if (!post) return { error: 'unknown' }
      if (post.source !== 'local') return { error: 'remote' }
      await repo.deletePost(id)
      return { ok: true }
    },
```

- [ ] **Step 6: Add the route** (`core/src/api/app.ts`, after `DELETE /admin/users/:handle`)

```ts
  app.delete('/admin/posts/:id', authed, requireAdmin(), async (c) => {
    const result = await service.deletePost(c.req.param('id') ?? '')
    if ('error' in result) return c.json({ error: result.error === 'unknown' ? 'unknown post' : 'not a local post' }, result.error === 'unknown' ? 404 : 409)
    return c.json({ ok: true }, 200)
  })
```

- [ ] **Step 7: Run tests + typecheck**

Run: `npm test -w core -- moderation` → PASS. `npm run typecheck -w core` → clean. `npm test -w core` once (flaky note) → all pass.

- [ ] **Step 8: Commit**

```bash
git add core/src/domain/repository.ts core/src/storage/sqlite.ts core/src/domain/service.ts core/src/api/app.ts core/test/moderation.test.ts
git commit -m "core: DELETE /admin/posts/:id — delete a single local post

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Web — API clients + "Delete account" on `/admin/users`

**Files:**
- Modify: `web/src/lib/api.ts` (+ `web/src/lib/api.test.ts`)
- Modify: `web/src/routes/admin/users/+page.server.ts` (+ action), `web/src/routes/admin/users/+page.svelte` (+ button)

**Interfaces:**
- Consumes: core `DELETE /admin/users/:handle` (Task 1), `DELETE /admin/posts/:id` (Task 2); `authedFetch`/`cookieHeader`, `base()`/`errorMessage`, the SP4 users card list.
- Produces: `deleteLocalAccount(f, handle): Promise<void>`, `deletePost(f, id): Promise<void>` (both mirror `removeRemoteFeed`).

- [ ] **Step 1: Invoke the UI skill first** — `ui-ux-pro-max:ui-ux-pro-max` + `design-system/textcaster/MASTER.md` (destructive = `--color-destructive`); consult `svelte-skills` (`sveltekit-data-flow`, `svelte-runes`). No Tailwind, no new deps.

- [ ] **Step 2: Create the shared confirm guard** — `web/src/lib/confirm.ts` (one place; both surfaces reuse it, matching the `$lib/draft.ts`/`lens.ts` single-purpose-util pattern)

```ts
import type { SubmitFunction } from '@sveltejs/kit'

/** use:enhance guard — confirm() before submit, then apply the result. No-JS falls through to a plain POST. */
export function confirmSubmit(message: string): SubmitFunction {
	return ({ cancel }) => {
		if (typeof confirm === 'function' && !confirm(message)) cancel()
		return async ({ update }) => update()
	}
}
```

- [ ] **Step 3: Add the two api clients** (`web/src/lib/api.ts`, mirroring `removeRemoteFeed`)

```ts
export async function deleteLocalAccount(f: typeof fetch, handle: string): Promise<void> {
	const res = await f(`${base()}/admin/users/${encodeURIComponent(handle)}`, { method: 'DELETE' })
	if (!res.ok) throw new Error(await errorMessage(res, 'deleteLocalAccount failed'))
}

export async function deletePost(f: typeof fetch, id: string): Promise<void> {
	const res = await f(`${base()}/admin/posts/${encodeURIComponent(id)}`, { method: 'DELETE' })
	if (!res.ok) throw new Error(await errorMessage(res, 'deletePost failed'))
}
```

- [ ] **Step 4: Add api-fn tests** (`web/src/lib/api.test.ts`, extend the import; mirror `removeRemoteFeed`'s tests)

```ts
test('deleteLocalAccount DELETEs the url-encoded handle', async () => {
	const f = vi.fn(async (..._a: unknown[]) => new Response(null, { status: 200 }))
	await deleteLocalAccount(f as unknown as typeof fetch, 'a b')
	expect(f).toHaveBeenCalledWith('http://localhost:8787/admin/users/a%20b', { method: 'DELETE' })
})
test('deleteLocalAccount surfaces the core error', async () => {
	const f = vi.fn(async () => new Response(JSON.stringify({ error: 'not a local account' }), { status: 409 }))
	await expect(deleteLocalAccount(f as unknown as typeof fetch, 'x')).rejects.toThrow('not a local account')
})
test('deletePost DELETEs /admin/posts/:id', async () => {
	const f = vi.fn(async (..._a: unknown[]) => new Response(null, { status: 200 }))
	await deletePost(f as unknown as typeof fetch, 'p1')
	expect(f).toHaveBeenCalledWith('http://localhost:8787/admin/posts/p1', { method: 'DELETE' })
})
```

- [ ] **Step 5: Add the `deleteUser` action** (`web/src/routes/admin/users/+page.server.ts`)

```ts
import { fail } from '@sveltejs/kit'
import { authedFetch, cookieHeader } from '$lib/server/session'
import { listAdminUsers, deleteLocalAccount } from '$lib/api'
import type { Actions, PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ fetch, url, cookies }) => {
	const f = authedFetch(fetch, url.origin, cookieHeader(cookies))
	return { users: await listAdminUsers(f) }
}

export const actions: Actions = {
	deleteUser: async (event) => {
		const form = await event.request.formData()
		const handle = String(form.get('handle') ?? '').trim()
		if (!handle) return fail(400, { error: 'handle required' })
		try {
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			await deleteLocalAccount(f, handle)
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'delete failed' })
		}
		return { deleted: true }
	},
}
```

- [ ] **Step 6: Add the "Delete account" button per local user** — `web/src/routes/admin/users/+page.svelte`

Per Step 1 (MASTER.md, `--color-destructive`): in each **local** user's card (`{#if u.kind === 'local'}`), add a form using the shared `confirmSubmit` guard from Step 2:

```svelte
<script lang="ts">
	import { enhance } from '$app/forms'
	import { confirmSubmit } from '$lib/confirm'
	// … existing …
</script>
…
{#if u.kind === 'local'}
	<form method="POST" action="?/deleteUser" use:enhance={confirmSubmit(`Delete @${u.handle} and all their posts? This can't be undone.`)}>
		<input type="hidden" name="handle" value={u.handle} />
		<button class="danger" type="submit">Delete account</button>
	</form>
{/if}
```

with a scoped `.danger` style: `background: var(--color-destructive); color: var(--color-on-accent);` (or an outline variant per MASTER.md). Show `form?.error` inline. Remote feeds show **no** delete here (their remove lives on `/admin/feeds`).

- [ ] **Step 7: Verify** — `npm run check -w web` (0 errors), `npm run build -w web`, `npm test -w web` (incl. the new api tests). If the dev stack is running and `.vite-temp` blocks svelte-check, run it inside the container: `docker compose exec -T web sh -c "npm run check -w web"`.

- [ ] **Step 8: Commit**

```bash
git add web/src/lib/confirm.ts web/src/lib/api.ts web/src/lib/api.test.ts web/src/routes/admin/users/+page.server.ts web/src/routes/admin/users/+page.svelte
git commit -m "web: /admin/users — delete-account action + button (admin moderation)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Web — admin "Remove" affordance on local posts

**Files:**
- Modify: `web/src/routes/+page.server.ts` (+ `deletePost` action), `web/src/routes/+page.svelte` (+ Remove button)
- Modify: `web/src/routes/post/[id]/+page.server.ts` (+ `deletePost` action), `web/src/routes/post/[id]/+page.svelte` (+ Remove button)

**Interfaces:**
- Consumes: `deletePost` (Task 3), `authedFetch`/`cookieHeader`, `data.me?.isAdmin` (root layout), `post.source`/`post.id`.

- [ ] **Step 1: Invoke the UI skill first** — as Task 3 Step 1. **Re-read both page files' current state** (the parallel session's Live-edits owner-`Edit` link is at `+page.svelte` ~`:129` and `post/[id]/+page.svelte` ~`:103`); place "Remove" beside that `Edit` block, don't touch Live-edits code.

- [ ] **Step 2: Add the `deletePost` action to the timeline** (`web/src/routes/+page.server.ts`, inside the existing `actions` object)

```ts
	deletePost: async (event) => {
		const form = await event.request.formData()
		const id = String(form.get('id') ?? '').trim()
		if (!id) return fail(400, { error: 'id required' })
		try {
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			await deletePost(f, id)
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'remove failed' })
		}
		return { removed: true }
	},
```

(add `deletePost` to the `$lib/api` import.)

- [ ] **Step 3: Add the Remove affordance to the timeline** (`web/src/routes/+page.svelte`, beside the existing owner-`Edit` block, ~`:129`)

```svelte
{#if data.me?.isAdmin && post.source === 'local'}
	<form method="POST" action="?/deletePost" use:enhance={confirmSubmit('Remove this post? This can\'t be undone.')}>
		<input type="hidden" name="id" value={post.id} />
		<button class="danger-link" type="submit">Remove</button>
	</form>
{/if}
```

reusing the shared `confirmSubmit` from Task 3's `$lib/confirm` (`import { confirmSubmit } from '$lib/confirm'`, plus `enhance` from `$app/forms`), with a scoped `.danger-link` style (a text button in `--color-destructive`, matching the inline `.edit`/`.source` link look, not a filled button).

- [ ] **Step 4: Same on the post-detail page** — add the identical `deletePost` action to `web/src/routes/post/[id]/+page.server.ts`'s `actions`, and the identical Remove form to `web/src/routes/post/[id]/+page.svelte` beside the `root` owner-`Edit` block (~`:103`), gated on `data.me?.isAdmin && root.source === 'local'`.

- [ ] **Step 5: Verify** — `npm run check -w web` (0 errors, container if `.vite-temp` blocks), `npm run build -w web`, `npm test -w web`. Manually confirm (or in the reviewer's judgment) the Remove renders only for an admin on a local post.

- [ ] **Step 6: Commit**

```bash
git add web/src/routes/+page.server.ts web/src/routes/+page.svelte web/src/routes/post/[id]/+page.server.ts web/src/routes/post/[id]/+page.svelte
git commit -m "web: admin Remove affordance on local posts (timeline + post detail)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Notes

- **Order:** Task 1 → 2 (core; 2 extends the same test file + app.ts, so after 1) → 3 (web api + admin/users) → 4 (post affordance; needs Task 3's `deletePost` api fn).
- **Atomicity:** `deleteUserCascade` and `deleteAuthRows` are each transaction-atomic; `deleteLocalAccount` calls them in sequence (not one combined transaction). A failure between them is negligibly unlikely (simple local deletes) and would leave only orphaned better-auth rows — acceptable for a single-admin tool; noted rather than wrapped, matching `removeRemoteFeed`'s simplicity.
- **Live-edits coordination (Task 4):** re-read `+page.svelte` and `post/[id]/+page.svelte` immediately before editing — the parallel session owns the `Edit` affordance there; only add the `Remove` block beside it. If those files moved the post markup into a shared component since this plan was written, add `Remove` there once instead.
- **Shared checkout:** confirm `npm test -w core` is green on the current HEAD before starting (a pre-existing red other than the known ingest flaky is not this work's).

## Revisions

**Rev 1 (2026-07-18)** — folded a ponytail review of this plan (net −10 lines):
- **Extracted `web/src/lib/confirm.ts`** — one `confirmSubmit(message)` `use:enhance` guard replaces three near-identical inline closures (`confirmDelete` + two `confirmRemove`s), matching the existing single-purpose `$lib/*.ts` util pattern (`draft.ts`, `lens.ts`). Reviewer confirmed the rest lean: the `deleteAuthRows` transaction-wrap is load-bearing (the service path calls it standalone, no outer transaction), per-page duplication of the `deletePost` action + Remove button matches the already-duplicated owner-`Edit` link (house convention, not new dup), and the 4-task split is right-sized.
- **Dropped the untested "a local reply survives" claim from Task 2's test title** (the body asserts only local-removed / remote-409 / unknown-404 — single-post delete is a by-id `deleteFrom`, so orphan-survival is the mechanism's default, not worth a dedicated assertion).
