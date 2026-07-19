# Per-User Feeds SP1 — Subscription Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give core a self-serve, capped feed-subscription primitive with a `feed_type` taxonomy, the four filtered timeline queries, and last-unfollow cleanup — the headless engine the web tabs (SP2) and subscribe UX (SP3) ride on.

**Architecture:** One mechanism + a type tag — every remote target stays a `users` row (`kind='remote'`) + a `follows` edge, plus a new `feed_type ∈ {person,webfeed,instance}`. Self-serve subscribe reuses the OPML importer's find-or-create-then-follow shape (handle-mint loop extracted and shared). Timeline tabs are additive `WHERE` filters over the existing shared pool.

**Tech Stack:** core = Hono + Kysely + better-sqlite3 (Node 22 native type-stripping, ESM `.ts` imports). Spec: `docs/superpowers/specs/2026-07-19-per-user-feeds-engine-design.md` (read it first; rev 1 folds the security review).

## Global Constraints

- **Node 22 native type-stripping in `core/src`** — NO TS parameter properties; ESM imports carry `.ts`.
- **Every core HTTP task (routes/middleware/tests) MUST invoke the project `hono` skill first** (`.claude/skills/hono/SKILL.md`) — hand-rolled validators (`isString`/enum), `c.json({error}, status)`, `app.request` tests, no RPC client.
- **Core tests live in `core/test/*.test.ts`** (vitest `include: ['test/**']`), importing `../src/...`. Reuse the harness in `core/test/api.test.ts` + `core/test/auth-helper.ts` (`makeAuth`, `anonSession(app)`, `registeredSession(app, email, repo)`; drive via `app.request(path, { headers: { cookie } })`).
- **Run core tests on the HOST:** `npm run -w core test [-- <name>]`. If default-timeout flakiness appears (stray mongodb processes), re-run from `core/` with `npx vitest run --testTimeout=30000`.
- **TYPECHECK GATE (required every task):** `npm run -w core typecheck` (tsc --noEmit) exit 0 before DONE — type-stripping means vitest passes on type errors.
- **Git:** shared checkout (a parallel session commits core too) — stage EXPLICIT paths, NEVER `git add -A`. Re-base each task on live HEAD; re-read files before editing (core is churning). Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **`feed_type` values:** `'person' | 'webfeed' | 'instance'` (remote rows only; `NULL` for local). Instances = admin-only + global (never followed); person/webfeed = self-serve.

## File Structure

- `core/src/domain/types.ts` — `User.feedType`; `NewRemoteUser.feedType` (required); new `FeedType` union.
- `core/src/storage/sqlite.ts` — migration entry (feed_type col + data-driven backfill + `UNIQUE(feed_url)` + `instance_settings`); `UsersTable.feed_type`; `rowToUser`; `insertUser`/`createRemoteUser` type param; the timeline join+filters; the new repo reads; `DB` gains `instance_settings`.
- `core/src/domain/repository.ts` — interface: `createRemoteUser` (grown input), `getRemoteUserByFeedUrl`, `countRemoteSubscriptions`, `countFollowers`, `getSetting`/`setSetting`.
- `core/src/domain/opml.ts` — Case 3 uses the shared mint helper; passes `feedType:'webfeed'`.
- `core/src/domain/service.ts` — `subscribeByUrl`; `removeFollow` cleanup; `getTimeline` filter passthrough; `getSetting`/`setSetting` passthrough.
- `core/src/domain/subscribe.ts` (new) — the extracted `mintRemoteUser` handle-loop helper (shared by opml + subscribe).
- `core/src/api/app.ts` — `POST /me/subscriptions`; `POST /users` tags `instance`; `DELETE /me/follows/:target` cleanup; `/timeline` params; `GET/PATCH /admin/settings`.
- `core/test/*.test.ts` — per task.
- `docs/superpowers/documentation/RUNNING.md` — endpoints + schema.

---

### Task 1: Data model — `feed_type`, `instance_settings`, `UNIQUE(feed_url)` (migration)

**Files:** Modify `core/src/domain/types.ts`, `core/src/storage/sqlite.ts` (MIGRATIONS, `UsersTable`, `rowToUser`, `DB`), `core/test/migrations.test.ts`; Test `core/test/per-user-feeds-schema.test.ts` (new).

**Interfaces produced:**
- `type FeedType = 'person' | 'webfeed' | 'instance'`; `User.feedType?: FeedType | null`; `NewRemoteUser.feedType?: FeedType` (**optional**, defaults to `'webfeed'` for remote rows).
- New table `instance_settings(key text PK, value text)`, seeded `max_subs_per_user='500'`.

- [ ] **Step 1: failing test** — `core/test/per-user-feeds-schema.test.ts` (the classification-by-`content_markdown` assertion lives in the `migrations.test.ts` raw-upgrade below; the settings-seed assertion lives in Task 2 where `getSetting` lands):
```ts
import { describe, it, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'

describe('per-user-feeds schema', () => {
  it('createRemoteUser defaults to webfeed; explicit feedType kept; local rows null', async () => {
    const repo = await createSqliteRepository(':memory:')
    const alice = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
    expect(alice.feedType ?? null).toBeNull()
    const wf = await repo.createRemoteUser({ handle: 'blog', displayName: 'Blog', feedUrl: 'https://blog/f' }) // no feedType → default
    expect(wf.feedType).toBe('webfeed')
    const inst = await repo.createRemoteUser({ handle: 'peer', displayName: 'Peer', feedUrl: 'https://peer/f', feedType: 'instance' })
    expect(inst.feedType).toBe('instance')
  })

  it('UNIQUE(feed_url) rejects a duplicate remote feed_url', async () => {
    const repo = await createSqliteRepository(':memory:')
    await repo.createRemoteUser({ handle: 'a', displayName: 'A', feedUrl: 'https://x/f' })
    await expect(repo.createRemoteUser({ handle: 'b', displayName: 'B', feedUrl: 'https://x/f' })).rejects.toThrow()
  })
})
```
Also add to `core/test/migrations.test.ts` a raw-upgrade test: build a v10 DB with a remote row that HAS a `content_markdown` post and one that does NOT + a `follows` edge to the markdown row and one to a local user; run `createSqliteRepository`; assert the markdown-remote → `feed_type='instance'`, the plain-remote → `'webfeed'`, the local-target follow survives, the instance-target follow **survives too** (we do NOT delete follows — the query excludes instances).

- [ ] **Step 2: run → fail.** `npm run -w core test -- per-user-feeds-schema` — FAIL (`getSetting`/`feedType`/`feedUrl`-unique absent).

- [ ] **Step 3: migration entry** — append to `MIGRATIONS` (becomes version 11; confirm `MIGRATIONS.length` at build and bump the `migrations.test.ts` version pins accordingly):
```ts
  [
    'ALTER TABLE users ADD COLUMN feed_type text',
    // instances = Textcasting peers: their items carry source:markdown (content_markdown).
    `UPDATE users SET feed_type = 'instance'
       WHERE kind='remote' AND EXISTS (SELECT 1 FROM posts p WHERE p.author_id = users.id AND p.content_markdown IS NOT NULL)`,
    `UPDATE users SET feed_type = 'webfeed' WHERE kind='remote' AND feed_type IS NULL`,
    // atomic find-or-create + backs getRemoteUserByFeedUrl. SQLite UNIQUE ignores NULLs (local rows). Same as users_auth_user_idx.
    'CREATE UNIQUE INDEX users_feed_url_idx ON users (feed_url)',
    `CREATE TABLE instance_settings (key text PRIMARY KEY, value text)`,
    `INSERT INTO instance_settings (key, value) VALUES ('max_subs_per_user', '500')`,
  ],
```
`ponytail:` if a live DB already holds two remote rows with the same `feed_url` (POST /users never dedup'd), the `CREATE UNIQUE INDEX` throws and the migration fails loudly — intended fail-fast. **Deploy pre-check (RUNNING.md / Task 8):** verify `SELECT feed_url, count(*) FROM users WHERE kind='remote' GROUP BY feed_url HAVING count(*)>1` is empty on each instance before deploying (documented in Task 8).

- [ ] **Step 4: types + mapping.**
  - `types.ts`: `export type FeedType = 'person' | 'webfeed' | 'instance'`; `User` gains `feedType?: FeedType | null`; `NewRemoteUser` gains `feedType?: FeedType` — **optional** (a required field ripples to ~22 files incl. `repository-contract.ts` + ~21 test files; keep it optional).
  - `sqlite.ts`: `UsersTable` gains `feed_type: FeedType | null`; `DB` gains `instance_settings: { key: string; value: string }`; `rowToUser` maps `feedType: r.feed_type`; `insertUser` inserts the `feed_type` (`null` for local); `createRemoteUser(u)` passes `u.feedType ?? 'webfeed'` (remote default). Safe default — nothing reads `feed_type` yet, and classification / `listTextcastingPeers` key on `content_markdown`, not `feed_type`.

- [ ] **Step 4b: set explicit `feedType` on the two PRODUCTION creation paths ONLY.** `opml.ts` Case 3 → `feedType: 'webfeed'`; `app.ts` `POST /users` handler → `feedType: 'instance'`. Every OTHER caller (`repository-contract.ts`, the ~21 test files) relies on the `'webfeed'` default — **do NOT edit them**. That is the point of the optional field: the T1 diff stays ~4 files and typecheck stays green.

- [ ] **Step 5: bump migration pins + run → pass.** In `core/test/migrations.test.ts` change all **three** `.toBe(10)` version pins (fresh-DB, v1-upgrade, v2-upgrade — ~lines 19/86/120) to `.toBe(11)`. Then `npm run -w core test -- per-user-feeds-schema migrations`; then full `npm run -w core test`.
- [ ] **Step 6: typecheck.** `npm run -w core typecheck` → exit 0.
- [ ] **Step 7: commit** (confirm trailer): stage `core/src/domain/types.ts core/src/storage/sqlite.ts core/src/domain/opml.ts core/src/api/app.ts core/test/per-user-feeds-schema.test.ts core/test/migrations.test.ts` (the call-site plumbing rides along) → `core: per-user-feeds schema — feed_type taxonomy (OPML=webfeed, POST /users=instance), instance_settings, UNIQUE(feed_url), data-driven classification`.

---

### Task 2: Repo reads — dedup lookup, counts, settings

**Files:** Modify `core/src/domain/repository.ts`, `core/src/storage/sqlite.ts`; Test `core/test/per-user-feeds-repo.test.ts`.

**Interfaces produced (Repository):**
- `getRemoteUserByFeedUrl(url: string): Promise<User | undefined>`
- `countRemoteSubscriptions(userId: string): Promise<number>` — follows whose target is a `person`/`webfeed` remote (excludes `instance`, per spec).
- `countFollowers(userId: string): Promise<number>`
- `getSetting(key: string): Promise<string | undefined>` / `setSetting(key: string, value: string): Promise<void>`

- [ ] **Step 1: failing test** covering: create a remote row → `getRemoteUserByFeedUrl` finds it (and misses on unknown); a local user following 2 remotes + 1 local → `countRemoteSubscriptions=2`; `countFollowers` of a remote followed by 2 users → 2; `getSetting('max_subs_per_user')='500'`, `setSetting` round-trips.
- [ ] **Step 2: run → fail.**
- [ ] **Step 3: implement** (Kysely):
```ts
  async getRemoteUserByFeedUrl(url: string) {
    const r = await this.db.selectFrom('users').selectAll().where('kind','=','remote').where('feed_url','=',url).executeTakeFirst()
    return r ? rowToUser(r) : undefined
  }
  async countRemoteSubscriptions(userId: string) {
    const r = await this.db.selectFrom('follows').innerJoin('users','users.id','follows.followed_id')
      .select(({fn}) => fn.countAll().as('n')).where('follows.follower_id','=',userId)
      .where('users.feed_type','in',['person','webfeed']).executeTakeFirst() // excludes vestigial instance follows
    return Number(r?.n ?? 0)
  }
  async countFollowers(userId: string) {
    const r = await this.db.selectFrom('follows').select(({fn}) => fn.countAll().as('n')).where('followed_id','=',userId).executeTakeFirst()
    return Number(r?.n ?? 0)
  }
  async getSetting(key: string) {
    const r = await this.db.selectFrom('instance_settings').select('value').where('key','=',key).executeTakeFirst()
    return r?.value
  }
  async setSetting(key: string, value: string) {
    await this.db.insertInto('instance_settings').values({key,value}).onConflict(oc => oc.column('key').doUpdateSet({value})).execute()
  }
```
Add all five to the `Repository` interface.
- [ ] **Step 4–6:** run → pass; typecheck 0; commit `core/src/domain/repository.ts core/src/storage/sqlite.ts core/test/per-user-feeds-repo.test.ts` → `core: repo reads — getRemoteUserByFeedUrl + follower/subscription counts + instance settings`.

---

### Task 3: `service.subscribeByUrl` + extracted handle-mint helper (capped find-or-create + follow)

**Files:** Create `core/src/domain/subscribe.ts` (extracted `mintRemoteUser`); Modify `core/src/domain/opml.ts` (Case 3 reuses it), `core/src/domain/service.ts` (`subscribeByUrl`, `getSetting`/`setSetting` passthrough); Test `core/test/subscribe.test.ts`.

**Interfaces produced:** `service.subscribeByUrl(user: User, url: string, type: 'person'|'webfeed'): Promise<{ user: User; followed: true } | { error: 'cap' }>`.

- [ ] **Step 1: failing test** (repo + service, no HTTP): subscribe `webfeed` → creates a `webfeed` remote row + a follow; subscribe the SAME url again → reuses the row (one `listRemoteUsers` entry) and still followed; `person` type tags `person`; with `setSetting('max_subs_per_user','1')` and one existing remote sub, a second `subscribeByUrl` returns `{error:'cap'}` and creates nothing.
- [ ] **Step 2: run → fail.**
- [ ] **Step 3: implement.**
  - `subscribe.ts` — extract the mint loop from `opml.ts` (slugBase host/text → suffix → `HandleTakenError` retry). Single-URL variant:
```ts
import { HandleTakenError } from './types.ts'
import type { User, NewRemoteUser } from './types.ts'
const MAX_HANDLE_ATTEMPTS = 50
export function slugBase(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,61); return s || 'feed'
}
// Mint a remote user with a collision-suffixed handle. No network fetch — handle from the given base.
export async function mintRemoteUser(
  addRemoteUser: (i: NewRemoteUser) => Promise<User>,
  base: string, displayName: string, feedUrl: string, feedType: NewRemoteUser['feedType'],
): Promise<User | undefined> {
  for (let n = 1; n <= MAX_HANDLE_ATTEMPTS; n++) {
    const handle = n === 1 ? base : `${base}-${n}`
    try { return await addRemoteUser({ handle, displayName, feedUrl, feedType }) }
    catch (err) { if (err instanceof HandleTakenError) continue; throw err }
  }
  return undefined
}
```
  Refactor `opml.ts` Case 3 to call `mintRemoteUser` (keeping its within-file `assignedHandles` pre-check by passing an already-suffixed base, or leave opml's loop and only share `slugBase` — implementer's call; the point is one `slugBase`/mint definition).
  - `service.ts` `subscribeByUrl` (host-slug handle, NO fetch):
```ts
    async subscribeByUrl(user: User, url: string, type: 'person' | 'webfeed'): Promise<{ user: User; followed: true } | { error: 'cap' }> {
      const existing = await repo.getRemoteUserByFeedUrl(url)
      // caller is a registered LOCAL user → addFollow's local-follower guard is satisfied by construction; call repo directly (service methods close over `repo`, not `this`).
      if (existing) { await repo.addFollow(user.id, existing.id); return { user: existing, followed: true } }
      const cap = Number(await repo.getSetting('max_subs_per_user') ?? '500')
      if (await repo.countRemoteSubscriptions(user.id) >= cap) return { error: 'cap' }
      const base = slugBase(new URL(url).host)
      const target = await mintRemoteUser((i) => repo.createRemoteUser(i), base, url, url, type)
      if (!target) throw new DomainError('could not allocate a handle')
      await repo.addFollow(user.id, target.id)
      return { user: target, followed: true }
    },
    getSetting(key: string) { return repo.getSetting(key) },
    setSetting(key: string, value: string) { return repo.setSetting(key, value) },
```
  (Cap is checked only on the create path — following an already-known feed doesn't grow the poll set. `displayName = url` until a later poll; noted in spec.)
- [ ] **Step 4–6:** run → pass; typecheck 0; commit `core/src/domain/subscribe.ts core/src/domain/opml.ts core/src/domain/service.ts core/test/subscribe.test.ts` → `core: subscribeByUrl — capped find-or-create + follow; shared handle-mint helper`.

---

### Task 4: `POST /me/subscriptions` endpoint

**REQUIRED: invoke the `hono` skill first.**

**Files:** Modify `core/src/api/app.ts`; Test `core/test/subscriptions-api.test.ts`.

- [ ] **Step 1: failing test** (real harness — `registeredSession`/`anonSession`): a registered session POSTs `{url:'https://blog.example/f.xml', type:'webfeed'}` → 201 and the feed appears in `listRemoteUsers` + is followed; a second identical POST → 200/201 but no duplicate; anonymous session → 403; missing/empty url or bad `type` → 400; a loopback url (`http://127.0.0.1/x`) → 400 (checkCallbackUrl); at cap → 429. **Also** (spec Testing, folded here): `POST /users` (admin/token) creates a `feed_type='instance'` row and **no** follow edge.
- [ ] **Step 2: run → fail.**
- [ ] **Step 3: implement** — mounted `authed, registeredOnly()` (BOTH). Add the `checkCallbackUrl` import to `app.ts` (from `../domain/push-guard.ts`). Validate with the house helpers (`readJsonBody`, `isString(url,1,2000)`, `type ∈ {'person','webfeed'}`), the **existing `isValidFeedUrl(url)`** (`app.ts`'s http/https check — NOT `httpOnly`, which is private to `ingest.ts`), and `(await checkCallbackUrl(url)).ok` (reject → 400). A literal loopback IP (`127.0.0.1`) is rejected without DNS injection, so **no `lookupFn` DI is needed** for the test. Then `service.subscribeByUrl(coreUser, url, type)`; `{error:'cap'}` → `429 { error:'subscription limit reached' }`; success → `201 { user, followed:true }`. Follow the existing route/validator style (`POST /posts`, `POST /users`) per the `hono` skill.
- [ ] **Step 4–6:** run → pass; typecheck 0; commit `core/src/api/app.ts core/test/subscriptions-api.test.ts` → `core: POST /me/subscriptions — capped self-serve subscribe (registeredOnly, SSRF-checked)`.

---

### Task 5: Timeline filters — the four tabs

**Files:** Modify `core/src/storage/sqlite.ts` (`getTimeline`), `core/src/domain/service.ts` (filter passthrough type), `core/src/api/app.ts` (`/timeline` params); Test `core/test/timeline-tabs.test.ts`.

**Interfaces produced:** `getTimeline` filter `{ followedBy?, authorId?, source?: 'local', feedType?: 'instance' }`; `followedBy` gains a standing instance-exclusion.

- [ ] **Step 1: failing test** — seed: a local post; a followed `webfeed` with a post; an `instance` with a post; a **stale follow edge to the instance** (simulate a pre-migration vestigial follow). Assert via `repo.getTimeline`:
  - `{source:'local'}` → only the local post.
  - `{feedType:'instance'}` → only the instance post.
  - `{followedBy: alice.id}` → the webfeed post, **NOT** the instance post (excluded despite the stale follow).
  - `{}` → all three.
- [ ] **Step 2: run → fail.**
- [ ] **Step 3: implement** — add ONLY these `WHERE` clauses to `getTimeline`. Do **NOT** add `users.feed_type` to the `select` or touch `joinedRowToEntry`/`JoinedRow`: the filters reference the joined `users.feed_type` column in `WHERE` without selecting it, and adding a required `u_feed_type` to `JoinedRow` would break the four sibling queries that share `joinedRowToEntry` (`getTimelineAfter`, `getRecentLocalPosts`, `getThread`, `listRepliesByPostId`). `author.feedType` on entries is not needed for SP1.
```ts
    if (filter?.source) q = q.where('posts.source','=',filter.source)
    if (filter?.feedType) q = q.where('users.feed_type','=',filter.feedType)
    if (filter?.followedBy) {
      const followerId = filter.followedBy
      q = q.where('posts.author_id','in', eb => eb.selectFrom('follows').select('followed_id').where('follower_id','=',followerId))
      q = q.where(eb => eb.or([eb('users.feed_type','is',null), eb('users.feed_type','!=','instance')])) // Decision B: personal river never shows instances
    }
```
  Widen the `filter` param type `{ followedBy?, authorId?, source?: 'local', feedType?: 'instance' }` in **four** places: `repository.ts` (`getTimeline` sig), `service.ts` (`getTimeline` passthrough), the `sqlite.ts` impl signature, and the local `filter` annotation in the `app.ts` `/timeline` handler. In `/timeline`, accept optional `source=local` / `feed_type=instance` query params and pass them through (compose with the existing `followed_by`/`author`/`before`).
- [ ] **Step 4–6:** run → pass; full suite green (the existing `followedBy` contract test still passes — no instance rows in it); typecheck 0; commit → `core: timeline filters — local/federated/personal(instance-excluded)/public tabs`.

---

### Task 6: Last-unfollow cleanup

**Files:** Modify `core/src/domain/service.ts` (`removeFollow`), `core/src/api/app.ts` (`DELETE /me/follows/:target` passes the resolved target); Test `core/test/unfollow-cleanup.test.ts`.

- [ ] **Step 1: failing test** — alice+bob both follow a `webfeed`; alice unfollows → row kept (bob still follows); bob unfollows → row `deleteUserCascade`d (gone from `listRemoteUsers`, its posts gone). Unfollowing an `instance` (sole follower) → row **kept**. Unfollowing a followed **local** user → local row kept.
- [ ] **Step 2: run → fail.**
- [ ] **Step 3: implement** — change `service.removeFollow` to take the resolved target (the `DELETE /me/follows/:target` handler already resolves it via `getUserByHandle`):
```ts
    async removeFollow(followerId: string, target: User): Promise<void> {
      await repo.removeFollow(followerId, target.id)
      if (target.kind === 'remote' && (target.feedType === 'person' || target.feedType === 'webfeed')
          && (await repo.countFollowers(target.id)) === 0) {
        repo.deleteUserCascade(target.id) // orphaned self-serve feed → stop polling. Instances never auto-cleaned.
      }
    },
```
  Update the `DELETE /me/follows/:target` handler to resolve the target `User` (it likely already does — re-read) and call `service.removeFollow(coreUser.id, target)`. If the target handle is unknown, keep today's behavior (idempotent no-op / 404 per current route).
- [ ] **Step 4–6:** run → pass; typecheck 0; commit → `core: last-unfollow cleanup — cascade an orphaned person/webfeed feed (instances exempt)`.

---

### Task 7: Admin subscription-cap setting endpoint

**REQUIRED: invoke the `hono` skill first.**

**Files:** Modify `core/src/api/app.ts` (`GET`/`PATCH /admin/settings`); Test `core/test/admin-settings.test.ts`.

- [ ] **Step 1: failing test** — admin session `GET /admin/settings` → `{ maxSubsPerUser: 500 }`; `PATCH /admin/settings { maxSubsPerUser: 50 }` → 200 and a subsequent `GET` reflects 50 and the new cap is enforced on the next subscribe; non-admin (registered) → 403; anon → 403.
- [ ] **Step 2: run → fail.**
- [ ] **Step 3: implement** — `app.get('/admin/settings', authed, requireAdmin(), …)` returns `{ maxSubsPerUser: Number(await service.getSetting('max_subs_per_user') ?? '500') }`; `app.patch('/admin/settings', authed, requireAdmin(), …)` validates `maxSubsPerUser` is an integer ≥ 0 (hand-rolled, per `hono` skill) → `service.setSetting('max_subs_per_user', String(n))` → 200. (Web `/admin` UI is SP3.)
- [ ] **Step 4–6:** run → pass; typecheck 0; commit → `core: GET/PATCH /admin/settings — admin-configurable subscription cap`.

---

### Task 8: Docs

**Files:** Modify `docs/superpowers/documentation/RUNNING.md`.

- [ ] **Step 1:** document, in the file's voice: `POST /me/subscriptions` (registered, capped), the `feed_type` taxonomy + how instances are classified, `GET/PATCH /admin/settings` (the cap), the `instance_settings` table + `UNIQUE(feed_url)`, and the **pre-deploy check** (no duplicate remote `feed_url` before migration 11). Note self-serve unfollow now cascades an orphaned feed.
- [ ] **Step 2: commit** `docs/superpowers/documentation/RUNNING.md` → `docs: RUNNING.md — per-user subscriptions, feed_type, cap, migration-11 pre-check`.

---

## Self-Review (author checklist — completed)

- **Spec coverage:** schema+classification+dedup+settings+call-site plumbing (T1) · repo reads (T2) · subscribeByUrl+mint (T3) · endpoint (T4) · four-tab filters (T5) · cleanup (T6) · admin cap (T7) · docs (T8). Every spec section maps to a task.
- **Security folds present:** cap enforced (T3 service + T4 429 + T7 admin) · SSRF `checkCallbackUrl` at subscribe (T4) · `registeredOnly` mounting (T4) · `UNIQUE(feed_url)` dedup (T1) · data-driven classification, no follow-DELETE (T1) · personal river instance-exclusion at query level (T5).
- **Type consistency:** `FeedType`, `NewRemoteUser.feedType`, `subscribeByUrl` signature, `getTimeline` filter shape, `removeFollow(followerId, target)` — used identically across tasks.
- **Ordering/deps:** T1 (schema + types + call-site plumbing → typechecks green) → T2 (reads) → T3 (service subscribe) → T4 (endpoint) → T5 (timeline, needs `feedType` from T1) → T6 (cleanup, needs `countFollowers` T2 + `feedType`) → T7 (admin cap) → T8 (docs). The T1-required-field/call-site coupling is why plumbing lives in T1, not a later task.

## Plan rev 1 — clean-context (opus) review, folded (2026-07-19)

- **T1 required-field ripple (blocking) →** `NewRemoteUser.feedType` made **optional** (default `'webfeed'` in `createRemoteUser`); only the two production paths (OPML=`webfeed`, `POST /users`=`instance`) set it explicitly. A required field would have failed `tsc` across `repository-contract.ts` + ~21 test files (tests are typechecked). Diff shrinks to ~4 files.
- **T4 `httpOnly` phantom →** use the existing `isValidFeedUrl`; add the `checkCallbackUrl` import; dropped the unnecessary `lookupFn` DI (a loopback IP is rejected without DNS injection).
- **T5 select/`joinedRowToEntry` →** dropped; the four-tab filters use `users.feed_type` in `WHERE` only (a required `u_feed_type` would break the 4 sibling joined queries). Filter type widened in 4 places.
- **T1 migration pins →** all **three** `.toBe(10)` in `migrations.test.ts` → `11`; placeholder Step-1 test cleaned; classification assertion lives in the raw-upgrade test.
- Minor: `subscribeByUrl` calls `repo.addFollow`/`repo.createRemoteUser` (not `this.`); `countRemoteSubscriptions` counts `person`/`webfeed` only (excludes vestigial instance follows); added the `POST /users`→`instance`/no-follow test; fixed a "Task 9"→8 reference.

Confirmed sound by the review: task ordering, the T6 `removeFollow(follower, target)` handler assumption, `authed`/`registeredOnly` mounting, migration version 11, the `content_markdown` classification signal (matches `listTextcastingPeers`), and all six security folds present.

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-07-19-per-user-feeds-engine.md`. Two execution options:
1. **Subagent-Driven (recommended)** — fresh implementer per task, spec+quality review each, whole-branch review on the most capable model at the end.
2. **Inline Execution** — batch with checkpoints.

Which approach?
