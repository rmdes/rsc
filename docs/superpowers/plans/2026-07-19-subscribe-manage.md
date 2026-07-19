# Subscribe & Manage Web UX (SP3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-07-19-subscribe-manage-design.md` (**rev 2**)

**Goal:** Wire the web to SP1's self-serve engine — home subscribe form, mode-switched following page, admin cap Settings tab — plus five core ride-alongs (central follow guard, local-URL resolve, OPML fixes, 201/200, displayName backfill).

**Architecture:** Core: one `followUnlessExcluded` helper every edge-minting path routes through (returns `minted: boolean` the callers/counters branch on); `subscribeByUrl` gains `created`; the route resolves local URLs and answers 201/200; ingest backfills `display_name` from feed titles while it still equals the seeded URL. Web: three new api wrappers; home swaps the broken admin form for `?/subscribe` with a three-outcome redirect; the following page becomes owner-manager/visitor-read-only; `/admin/settings` is a fourth admin tab.

**Tech Stack:** Core: Hono + Kysely/better-sqlite3, native type stripping (no TS parameter properties). Web: SvelteKit, Svelte 5 runes.

## Global Constraints

- Shared checkout: a parallel session commits on main. **Never `git add -A`** — stage explicit paths. Re-read files before editing; rebase each task on live HEAD.
- Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Core tests on host: `npm run -w core test -- <name>`; typecheck: `npm run -w core typecheck`.
- Web tests ONLY in-container: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- <name>`; typecheck: `docker compose exec -T web npm run check -w web` (expect 0 errors; 1 pre-existing warning in post/[id]/edit is known).
- Type stripping ⇒ vitest passes on type errors. **Every task runs its typecheck before DONE.** Trust the check command over editor diagnostics.
- Core route work follows the project `hono` skill; web UI tasks invoke `ui-ux-pro-max:ui-ux-pro-max` and follow `design-system/textcaster/MASTER.md`; Svelte tasks consult `svelte-skills`.
- No raw hex; `--color-*`/`--space-*` tokens only. `{@html}` stays confined to PostBody.svelte. No new dependencies.
- Read installed library source before using an API (feedsmith, Kysely) — never from memory.

---

### Task 1: Core — follow guard, `subscribeByUrl` created/followed, local-URL resolve, 201/200

**Files:**
- Modify: `core/src/domain/service.ts` (addFollow ~:117, subscribeByUrl ~:161)
- Modify: `core/src/domain/opml.ts` (export `localHandleForUrl`, ~:69)
- Modify: `core/src/api/app.ts` (`/me/subscriptions` route ~:294)
- Test: `core/test/subscribe.test.ts`, `core/test/subscriptions-api.test.ts`, `core/test/api-follows.test.ts`

**Interfaces:**
- Consumes: `repo.addFollow(followerId, followedId): Promise<void>` (stays permissive — `repository-contract.ts:276`'s "self-follow is allowed" describes the REPO layer and stands unchanged; the service layer now refuses).
- Produces (Tasks 2/4 rely on these):
  - `service.addFollow(follower: User, target: User): Promise<boolean>` — `true` iff an edge was minted; `false` for instance targets and self-follows (no edge). Still throws `DomainError` for non-local followers.
  - `service.subscribeByUrl(user, url, type): Promise<{ user: User; followed: boolean; created: boolean } | { error: 'cap' }>`.
  - `service.getRemoteUserByFeedUrl(url): Promise<User | undefined>` (passthrough — Task 2's OPML wiring needs it).
  - `POST /me/subscriptions` → `201 { user, followed }` on create, `200 { user, followed }` on reuse/local-resolve, `429` on cap.
  - `localHandleForUrl` exported from `opml.ts`.

- [ ] **Step 1: Write the failing tests**

`core/test/subscribe.test.ts` — amend the race test (~:77): expected object gains `created: false`:

```ts
  expect(result).toEqual({ user: winner, followed: true, created: false })
```

Append (reuse the file's fake-repo style — read it first; `alice`/`User` literals as in the race test):

```ts
test('subscribeByUrl reuse of an instance URL mints NO follow (guard)', async () => {
  const url = 'https://peer.example/feed.xml'
  const instance: User = { id: 'inst-id', kind: 'remote', handle: 'peer', displayName: 'Peer', feedUrl: url, createdAt: '2026-01-01T00:00:00.000Z', authUserId: null, feedType: 'instance' }
  const follows: Array<[string, string]> = []
  const repo = {
    getRemoteUserByFeedUrl: async () => instance,
    addFollow: async (a: string, b: string) => { follows.push([a, b]) },
  } as unknown as Repository
  const svc = createService(repo, createEventBus())
  const alice: User = { id: 'alice-id', kind: 'local', handle: 'alice', displayName: 'Alice', feedUrl: null, createdAt: '2026-01-01T00:00:00.000Z', authUserId: null }
  const result = await svc.subscribeByUrl(alice, url, 'webfeed')
  expect(result).toEqual({ user: instance, followed: false, created: false })
  expect(follows).toEqual([])
})

test('addFollow refuses self-follow and instance targets, minting nothing', async () => {
  const follows: Array<[string, string]> = []
  const repo = { addFollow: async (a: string, b: string) => { follows.push([a, b]) } } as unknown as Repository
  const svc = createService(repo, createEventBus())
  const alice: User = { id: 'alice-id', kind: 'local', handle: 'alice', displayName: 'Alice', feedUrl: null, createdAt: '2026-01-01T00:00:00.000Z', authUserId: null }
  const peer: User = { id: 'inst-id', kind: 'remote', handle: 'peer', displayName: 'Peer', feedUrl: 'https://p.example/f.xml', createdAt: '2026-01-01T00:00:00.000Z', authUserId: null, feedType: 'instance' }
  expect(await svc.addFollow(alice, alice)).toBe(false)
  expect(await svc.addFollow(alice, peer)).toBe(false)
  expect(follows).toEqual([])
  const person: User = { ...peer, id: 'p2', handle: 'p2', feedType: 'person' }
  expect(await svc.addFollow(alice, person)).toBe(true)
  expect(follows).toEqual([['alice-id', 'p2']])
})
```

`core/test/subscriptions-api.test.ts` — read the file first for its harness (app + registered session helpers), then append tests:

1. **Reuse returns 200** (create then re-subscribe same URL as another registered user or the same one): first POST → 201, second POST same URL → **200**, both `followed: true` for a webfeed.
2. **Local-URL resolve**: harness app must be built with a `publicUrl` (read how the app/feeds config is constructed in that file or `api.test.ts`; if the existing harness passes no publicUrl, construct one with it for this test). Create a registered user B (or use an existing local user's handle); POST `{ url: '<publicUrl>/users/<b-handle>/feed.xml', type: 'webfeed' }` → **200**, `user.kind === 'local'`, `followed: true`, and NO remote row with that feed_url exists afterward.
3. **Own URL** → same shape but subscriber's own handle → `200`, `followed: false`.
4. **Instance-URL reuse** over HTTP: admin-create an instance feed (`POST /users` with bearer token), then subscribe its URL → `200 { followed: false }` and the follows list does NOT contain it.

`core/test/api-follows.test.ts` — append one test: `POST /me/follows` targeting an instance handle still returns `200 {ok:true}` but `GET /users/<me>/follows` does not list it.

- [ ] **Step 2: Run to verify failure**

Run: `npm run -w core test -- subscribe subscriptions-api api-follows`
Expected: FAIL — race test gets no `created` key; guard tests find edges minted; reuse POST returns 201 not 200.

- [ ] **Step 3: Implement**

`core/src/domain/opml.ts`: change `function localHandleForUrl` to `export function localHandleForUrl` (no other change).

`core/src/domain/service.ts` — add the module-level helper (near `mintRemoteUser`):

```ts
// Instance targets are global (Decision B) and self-follows are meaningless —
// mint nothing for either; callers branch on the returned boolean.
async function followUnlessExcluded(repo: Repository, followerId: string, target: User): Promise<boolean> {
  if (target.feedType === 'instance' || target.id === followerId) return false
  await repo.addFollow(followerId, target.id)
  return true
}
```

`addFollow` becomes:

```ts
    async addFollow(follower: User, target: User): Promise<boolean> {
      if (follower.kind !== 'local') throw new DomainError('follower must be a local user')
      return followUnlessExcluded(repo, follower.id, target)
    },
```

`subscribeByUrl` becomes (keep the existing race comment block verbatim):

```ts
    async subscribeByUrl(user: User, url: string, type: 'person' | 'webfeed'): Promise<{ user: User; followed: boolean; created: boolean } | { error: 'cap' }> {
      const existing = await repo.getRemoteUserByFeedUrl(url)
      // caller is a registered LOCAL user → addFollow's local-follower guard is satisfied by construction; call the shared helper directly (service methods close over `repo`, not `this`).
      if (existing) return { user: existing, followed: await followUnlessExcluded(repo, user.id, existing), created: false }
      const cap = Number(await repo.getSetting('max_subs_per_user') ?? '500')
      if (await repo.countRemoteSubscriptions(user.id) >= cap) return { error: 'cap' }
      const base = slugBase(new URL(url).host)
      const target = await mintRemoteUser((i) => repo.createRemoteUser(i), base, url, url, type)
      if (!target) {
        // (existing comment block unchanged)
        const raced = await repo.getRemoteUserByFeedUrl(url)
        if (raced) return { user: raced, followed: await followUnlessExcluded(repo, user.id, raced), created: false }
        throw new DomainError('could not allocate a handle')
      }
      await repo.addFollow(user.id, target.id) // fresh person/webfeed row — never excluded
      return { user: target, followed: true, created: true }
    },
```

Add the service passthrough (next to `getSetting`):

```ts
    getRemoteUserByFeedUrl(url: string) { return repo.getRemoteUserByFeedUrl(url) },
```

`core/src/api/app.ts` — import `localHandleForUrl` from `../domain/opml.ts` (it already imports `importFollowingOpml` — extend that import). The `/me/subscriptions` handler's tail becomes:

```ts
    // Own-instance feed URL → follow the local user; never mint a remote shadow (SP3 F1).
    // Requires publicUrl; without it (dev) the resolve never matches — accepted, spec S4.
    const localHandle = localHandleForUrl(url, feeds.publicUrl)
    if (localHandle) {
      const local = await resolveUser(localHandle)
      if (local && local.kind === 'local') {
        const minted = await service.addFollow(c.get('coreUser'), local)
        return c.json({ user: local, followed: minted }, 200)
      }
    }
    const result = await service.subscribeByUrl(c.get('coreUser'), url, type)
    if ('error' in result) return c.json({ error: 'subscription limit reached' }, 429)
    return c.json({ user: result.user, followed: result.followed }, result.created ? 201 : 200)
```

(`feeds` is in scope — the OPML route below it already uses `feeds.publicUrl`. `POST /me/follows` at ~:212 needs no change — it ignores `addFollow`'s new return value.)

- [ ] **Step 4: Run tests + typecheck**

Run: `npm run -w core test -- subscribe subscriptions-api api-follows opml` → PASS (opml.ts consumers: `ImportDeps.addFollow` is typed `Promise<void>` — a `Promise<boolean>` assignment is compatible, Task 2 tightens it).
Run: `npm run -w core test` → full suite green (unfollow-cleanup, service, federation-following all use person/webfeed targets — unaffected; investigate ANY failure in a followed/follow path before proceeding).
Run: `npm run -w core typecheck` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add core/src/domain/service.ts core/src/domain/opml.ts core/src/api/app.ts core/test/subscribe.test.ts core/test/subscriptions-api.test.ts core/test/api-follows.test.ts
git commit -m "core: central follow guard (instance+self), subscribeByUrl created flag, local-URL resolve, 201/200 split

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Core — OPML minted-count branches + Case-3 re-resolve

**Files:**
- Modify: `core/src/domain/opml.ts` (`ImportDeps`, import loop)
- Modify: `core/src/api/app.ts` (OPML deps wiring ~:274-286)
- Test: `core/test/opml.test.ts`

**Interfaces:**
- Consumes: `service.addFollow → Promise<boolean>`, `service.getRemoteUserByFeedUrl` (Task 1).
- Produces: import counts are guard-accurate — instance/self targets count `skipped`; a Case-3 feed_url race resolves to the winner instead of skipping.

- [ ] **Step 1: Write the failing tests**

Read `core/test/opml.test.ts` first (its deps-stub style; note the unused-`repo` TS6133 hint at ~:111 — fix it while in the file). Append:

```ts
test('import: an existing instance feed in the OPML counts skipped, not followed', async () => {
  // deps stub: listRemoteUsers returns one user with feedType 'instance' whose
  // feedUrl matches the outline; addFollow delegates to a guard-faithful stub
  // returning false for instance targets. Assert { followed: 0, skipped: 1 }
  // and that no follow was recorded.
})

test('import Case-3: a concurrent create winning the feed_url race is followed via re-resolve', async () => {
  // deps stub: addRemoteUser always throws HandleTakenError (as the race does);
  // getRemoteUserByFeedUrl returns the winner (feedType 'webfeed').
  // Assert { followed: 1, created: 0, skipped: 0 } and the follow recorded.
})

test('import Case-3 re-resolve to an instance winner counts skipped', async () => {
  // same as above but the winner has feedType 'instance' → guard-faithful
  // addFollow returns false. Assert { followed: 0, skipped: 1 }.
})
```

Write these as REAL tests following the file's existing stub pattern (the sketches above name the required behavior; the file's own helpers dictate the shape). The guard-faithful `addFollow` stub is `async (f, t) => t.feedType === 'instance' || t.id === f.id ? false : (follows.push([f.id, t.id]), true)`.

- [ ] **Step 2: Run to verify failure**

Run: `npm run -w core test -- opml`
Expected: FAIL — instance import counts `followed: 1` (no branch); race test gets `skipped: 1` (no re-resolve); possibly a type error on the new `getRemoteUserByFeedUrl` dep (that's the point).

- [ ] **Step 3: Implement**

`core/src/domain/opml.ts`:

1. `ImportDeps`: `addFollow: (follower: User, target: User) => Promise<boolean>` and add `getRemoteUserByFeedUrl: (url: string) => Promise<User | undefined>`.
2. Case 1 becomes:

```ts
      if (existing) {
        if (subCount >= subCap) { skipped++; continue }
        if (await deps.addFollow(follower, existing)) { followed++; subCount++ } else skipped++
        continue
      }
```

3. Case 2's follow line becomes:

```ts
        if (localUser && localUser.kind === 'local') {
          if (await deps.addFollow(follower, localUser)) followed++; else skipped++
          continue
        }
```

4. Case-3 exhaustion (`if (!handleUser) { skipped++; continue }`) becomes:

```ts
      if (!handleUser) {
        // Mint exhausted — a concurrent create may have won the feed_url race
        // (HandleTakenError is a UNIQUE collision on either column). Re-resolve
        // and follow the winner instead of skipping (mirrors subscribeByUrl).
        const raced = await deps.getRemoteUserByFeedUrl(xmlUrl)
        if (raced) {
          byFeedUrl.set(xmlUrl, raced)
          if (await deps.addFollow(follower, raced)) { followed++; subCount++ } else skipped++
        } else skipped++
        continue
      }
```

5. Case-3 success tail stays (`await deps.addFollow(follower, handleUser); created++; followed++; subCount++` — a fresh webfeed row always mints; ignoring the boolean here is correct).

`core/src/api/app.ts` OPML wiring adds one line:

```ts
        getRemoteUserByFeedUrl: (u) => service.getRemoteUserByFeedUrl(u),
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm run -w core test -- opml` → PASS. `npm run -w core test` → green. `npm run -w core typecheck` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add core/src/domain/opml.ts core/src/api/app.ts core/test/opml.test.ts
git commit -m "core: OPML counts branch on minted follows; Case-3 feed_url race re-resolves the winner

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Core — displayName backfill from feed titles

**Files:**
- Modify: `core/src/domain/ingest.ts` (`parseFeedWithMeta` ~:87-131, `ingestRemoteUser` ~:227, `ingestViaDiscovery` ~:253)
- Modify: `core/src/storage/sqlite.ts` (new method near `updateFeedUrl` ~:108), `core/src/domain/repository.ts` (interface line)
- Test: `core/test/ingest.test.ts`, `core/test/sqlite-repository.test.ts` (or the repo-contract file the suite uses — read `core/test/per-user-feeds-repo.test.ts` first and put the repo test where its siblings live)

**Interfaces:**
- Consumes: nothing from Tasks 1-2 (independent).
- Produces: `repo.updateDisplayNameIfUnset(userId: string, name: string): Promise<void>` — writes only while `display_name = feed_url`; `parseFeedWithMeta` returns `{ items, discovery, title: string | null }`.

- [ ] **Step 1: Write the failing tests**

Repo test (in the file where repo CRUD tests live):

```ts
test('updateDisplayNameIfUnset writes only while display_name equals feed_url', async () => {
  const repo = await createSqliteRepository(':memory:')
  const seeded = await repo.createRemoteUser({ handle: 'f1', displayName: 'https://ex.com/f.xml', feedUrl: 'https://ex.com/f.xml', feedType: 'webfeed' })
  await repo.updateDisplayNameIfUnset(seeded.id, 'Example Feed')
  expect((await repo.getUser(seeded.id))?.displayName).toBe('Example Feed')
  await repo.updateDisplayNameIfUnset(seeded.id, 'Clobber Attempt')
  expect((await repo.getUser(seeded.id))?.displayName).toBe('Example Feed') // no longer equals feed_url → refused
})
```

Ingest test (read `core/test/ingest.test.ts` for its fetch-stub + fixture-feed pattern first; follow it):

```ts
test('poll backfills display_name from the feed title while still URL-named', async () => {
  // createRemoteUser seeded displayName === feedUrl; fetch stub serves an RSS
  // body whose <title> is "Real Title"; ingestRemoteUser(...) → user's
  // displayName becomes "Real Title". A second poll with a different title
  // must NOT overwrite (displayName no longer equals feed_url).
})

test('discovery pass backfills BEFORE rewriting feed_url', async () => {
  // fetch stub: pageUrl returns HTML with an alternate link; feed URL returns
  // an RSS body with a title. After ingestRemoteUser on the page URL:
  // displayName === feed title AND feedUrl === discovered URL (the backfill
  // ran against the pre-rewrite equality; ordering is the point).
})
```

Write these as real tests per the file's pattern.

- [ ] **Step 2: Run to verify failure**

Run: `npm run -w core test -- ingest sqlite-repository per-user-feeds-repo`
Expected: FAIL — `updateDisplayNameIfUnset` doesn't exist (type/runtime), titles never applied.

- [ ] **Step 3: Implement**

`core/src/storage/sqlite.ts`, next to `updateFeedUrl`:

```ts
  async updateDisplayNameIfUnset(userId: string, name: string) {
    // Only while display_name still equals feed_url (the subscribe-seeded value) — never clobber a chosen name.
    await this.db.updateTable('users').set({ display_name: name }).where('id', '=', userId).whereRef('display_name', '=', 'feed_url').execute()
  }
```

`core/src/domain/repository.ts`, after `updateFeedUrl`:

```ts
  updateDisplayNameIfUnset(userId: string, name: string): Promise<void>
```

`core/src/domain/ingest.ts` — `parseFeedWithMeta` returns `title` in all four branches. **Verify the exact title field shapes against the installed feedsmith types (`node_modules/feedsmith`) before writing** — expected: `parsed.feed.title` is a string (json/rss/rdf) and a string for atom too; normalize with a tiny local helper if any branch differs:

- json: `return { items, discovery: {...}, title: parsed.feed.title ?? null }`
- atom: `return { items, discovery: {...}, title: parsed.feed.title ?? null }`
- rdf: `return { items, discovery: NO_DISCOVERY, title: parsed.feed.title ?? null }`
- rss (final return): `return { items, discovery: {...}, title: parsed.feed.title ?? null }`
- Return type: `Promise<{ items: ParsedItem[]; discovery: FeedDiscovery; title: string | null }>`

`ingestRemoteUser` — after the successful primary parse, before `ingestItems`:

```ts
  const title = parsed.title?.trim()
  if (title) await repo.updateDisplayNameIfUnset(user.id, title)
```

`ingestViaDiscovery` branch 1 — after its parse, BEFORE the R1 `updateFeedUrl` block:

```ts
      const title = parsed.title?.trim()
      // BEFORE updateFeedUrl: the unset-guard compares display_name to the
      // CURRENT (input) feed_url; the rewrite below would break equality forever.
      if (title) await repo.updateDisplayNameIfUnset(user.id, title)
```

The h-feed branch gets no backfill (no feed-level title exists there — spec S7).

- [ ] **Step 4: Run tests + typecheck**

Run: `npm run -w core test -- ingest sqlite-repository per-user-feeds-repo` → PASS. `npm run -w core test` → green (any repo-contract fake implementing `Repository` gains the method — add it to fakes the typecheck flags). `npm run -w core typecheck` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add core/src/domain/ingest.ts core/src/domain/repository.ts core/src/storage/sqlite.ts core/test/ingest.test.ts <repo-test-file>
git commit -m "core: backfill display_name from feed title while URL-named (before discovery rewrite)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Web — api wrappers + home subscribe form (replaces addRemote)

**Files:**
- Modify: `web/src/lib/api.ts`, `web/src/routes/+page.server.ts`, `web/src/routes/+page.svelte`
- Test: `web/src/lib/api.test.ts`, `web/src/routes/page.actions.test.ts`

**Interfaces:**
- Consumes: `POST /me/subscriptions` 201/200 `{ user, followed }` (Task 1).
- Produces (Tasks 5/6 use these):
  - `subscribeToFeed(f, { url, type }: { url: string; type: 'person' | 'webfeed' }): Promise<{ user: TimelineEntry['author']; followed: boolean }>`
  - `getAdminSettings(f): Promise<{ maxSubsPerUser: number }>`
  - `patchAdminSettings(f, body: { maxSubsPerUser: number }): Promise<void>`
  - Home action `?/subscribe` with the three-outcome redirect (Task 5's following page posts to it cross-route as `/?/subscribe`).

- [ ] **Step 1: Write the failing tests**

`web/src/lib/api.test.ts` — append (match its `as unknown as typeof fetch` style):

```ts
test('subscribeToFeed posts url+type and returns user/followed', async () => {
  const f = vi.fn(async () => new Response(JSON.stringify({ user: { id: 'u1', handle: 'feed', displayName: 'F', kind: 'remote' }, followed: true }), { status: 201 }))
  const out = await subscribeToFeed(f as unknown as typeof fetch, { url: 'https://ex.com/f.xml', type: 'webfeed' })
  expect(out.followed).toBe(true)
  const init = f.mock.calls[0][1] as RequestInit
  expect(JSON.parse(String(init.body))).toEqual({ url: 'https://ex.com/f.xml', type: 'webfeed' })
})

test('subscribeToFeed surfaces the cap error string', async () => {
  const f = vi.fn(async () => new Response(JSON.stringify({ error: 'subscription limit reached' }), { status: 429 }))
  await expect(subscribeToFeed(f as unknown as typeof fetch, { url: 'https://ex.com/f.xml', type: 'webfeed' })).rejects.toThrow('subscription limit reached')
})

test('admin settings wrappers hit GET and PATCH', async () => {
  const f = vi.fn(async () => new Response(JSON.stringify({ maxSubsPerUser: 500 }), { status: 200 }))
  expect(await getAdminSettings(f as unknown as typeof fetch)).toEqual({ maxSubsPerUser: 500 })
  await patchAdminSettings(f as unknown as typeof fetch, { maxSubsPerUser: 250 })
  const patchInit = f.mock.calls[1][1] as RequestInit
  expect(patchInit.method).toBe('PATCH')
  expect(JSON.parse(String(patchInit.body))).toEqual({ maxSubsPerUser: 250 })
})
```

`web/src/routes/page.actions.test.ts` — **delete the FOUR addRemote tests** (currently at ~:66, :74, :81, :107 — grep `addRemote` and remove each whole `test(...)` block), then append:

```ts
test('subscribe follows a feed and redirects to the personal river', async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({ user: { id: 'r1', handle: 'blog', displayName: 'B', kind: 'remote', feedType: 'webfeed' }, followed: true }), { status: 201 }))
	const event = sessionedEvent(formRequest('subscribe', { url: 'https://ex.com/f.xml', type: 'webfeed' }), fetch)
	await expect(actions.subscribe(event as never)).rejects.toMatchObject({ status: 303, location: '/?tab=personal&feed=blog' })
})

test('subscribe to an instance URL lands on federated with no flash', async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({ user: { id: 'i1', handle: 'peer', displayName: 'P', kind: 'remote', feedType: 'instance' }, followed: false }), { status: 200 }))
	const event = sessionedEvent(formRequest('subscribe', { url: 'https://peer.ex/f.xml', type: 'webfeed' }), fetch)
	await expect(actions.subscribe(event as never)).rejects.toMatchObject({ status: 303, location: '/?tab=federated' })
})

test('subscribe to your own feed URL lands on personal with no flash', async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({ user: { id: 'me1', handle: 'me', displayName: 'Me', kind: 'local' }, followed: false }), { status: 200 }))
	const event = sessionedEvent(formRequest('subscribe', { url: 'https://x/users/me/feed.xml', type: 'webfeed' }), fetch)
	await expect(actions.subscribe(event as never)).rejects.toMatchObject({ status: 303, location: '/?tab=personal' })
})

test('subscribe surfaces the cap error and rejects a bad type', async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'subscription limit reached' }), { status: 429 }))
	const capped = await actions.subscribe(sessionedEvent(formRequest('subscribe', { url: 'https://ex.com/f.xml', type: 'webfeed' }), fetch) as never)
	expect(capped).toMatchObject({ status: 400 })
	expect((capped as { data: { error: string } }).data.error).toMatch(/subscription limit reached/)
	const bad = await actions.subscribe(sessionedEvent(formRequest('subscribe', { url: 'https://ex.com/f.xml', type: 'nope' }), fetch) as never)
	expect(bad).toMatchObject({ status: 400 })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- api` → FAIL (`subscribeToFeed` not exported).
Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- page.actions` → FAIL (`actions.subscribe` undefined).

- [ ] **Step 3: Implement**

`web/src/lib/api.ts` — append:

```ts
export async function subscribeToFeed(
	f: typeof fetch,
	input: { url: string; type: 'person' | 'webfeed' }
): Promise<{ user: TimelineEntry['author']; followed: boolean }> {
	const res = await f(`${base()}/me/subscriptions`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(input)
	})
	if (!res.ok) throw new Error(await errorMessage(res, `subscribe ${res.status}`))
	return (await res.json()) as { user: TimelineEntry['author']; followed: boolean }
}

export async function getAdminSettings(f: typeof fetch): Promise<{ maxSubsPerUser: number }> {
	const res = await f(`${base()}/admin/settings`)
	if (!res.ok) throw new Error(await errorMessage(res, 'getAdminSettings failed'))
	return (await res.json()) as { maxSubsPerUser: number }
}

export async function patchAdminSettings(f: typeof fetch, body: { maxSubsPerUser: number }): Promise<void> {
	const res = await f(`${base()}/admin/settings`, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	})
	if (!res.ok) throw new Error(await errorMessage(res, 'patchAdminSettings failed'))
}
```

`web/src/routes/+page.server.ts` — delete the whole `addRemote` action; drop `addRemoteUser` from the `$lib/api` import, add `subscribeToFeed`. New action:

```ts
	subscribe: async (event) => {
		const form = await event.request.formData()
		const url = String(form.get('url') ?? '').trim()
		const type = String(form.get('type') ?? '')
		if (!url) return fail(400, { error: 'url is required' })
		if (type !== 'person' && type !== 'webfeed') return fail(400, { error: 'type invalid' })
		let result
		try {
			// no mint: subscribing is registered-only; a sessionless POST gets core's 401/403
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			result = await subscribeToFeed(f, { url, type })
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'subscribe failed' })
		}
		// Landing tab = where the outcome is visible (deliberate exception to tabHome):
		// followed → personal (+flash); instance → federated; own feed → personal. No flash unless followed.
		if (result.followed) throw redirect(303, `/?tab=personal&feed=${encodeURIComponent(result.user.handle)}`)
		throw redirect(303, result.user.kind === 'local' ? '/?tab=personal' : '/?tab=federated')
	},
```

`web/src/routes/+page.svelte` — replace the "Add remote user" panel (~:85-97) with:

```svelte
		{#if data.me && !data.me.isAnonymous}
			<details class="panel">
				<summary>Subscribe to a feed</summary>
				<form method="POST" action="?tab={data.tab}&/subscribe" class="add-remote">
					<label class="visually-hidden" for="sub-url">Feed URL</label>
					<input id="sub-url" name="url" type="url" placeholder="https://their-site.com/feed.xml" required />
					<label><input type="radio" name="type" value="webfeed" checked /> a site or publication</label>
					<label><input type="radio" name="type" value="person" /> an individual</label>
					<button>Subscribe</button>
				</form>
			</details>
		{:else}
			<p class="auth-note">Register to add feeds.</p>
		{/if}
```

Flash copy (~:111-113) becomes:

```svelte
	{#if data.addedFeed}
		<p class="notice confirm" role="status">Now following <strong>@{data.addedFeed}</strong>.</p>
	{/if}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- api page.actions` → PASS.
Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web` → full suite green.
Run: `docker compose exec -T web npm run check -w web` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/api.ts web/src/lib/api.test.ts web/src/routes/+page.server.ts web/src/routes/+page.svelte web/src/routes/page.actions.test.ts
git commit -m "web: self-serve subscribe form replaces the admin-only add-remote (three-outcome redirect)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Web — mode-switched following page

**Implementer note:** UI task — invoke `ui-ux-pro-max:ui-ux-pro-max` first; follow MASTER.md; consult `svelte-skills:svelte-runes`.

**Files:**
- Modify: `web/src/routes/u/[handle]/following/+page.server.ts`, `+page.svelte`
- Test: `web/src/routes/following.actions.test.ts` (extend), new load tests in the same file or `web/src/routes/following.load.test.ts`

**Interfaces:**
- Consumes: layout `me` via `await parent()`; `?/subscribe` on `/` (Task 4); `getFollowing` authors carry `feedType`.
- Produces: load returns `handle` (LOWERCASED), `isOwner: boolean`, `followIds` (instance-excluded). No downstream task.

- [ ] **Step 1: Write the failing tests**

Append load tests (mock-fetch style as in `page.load.test.ts`; `parent` stub):

```ts
test('following load lowercases the handle, computes isOwner, and instance-filters followIds', async () => {
	const fetch = vi.fn(async (url: string | URL) =>
		String(url).includes('/follows')
			? new Response(JSON.stringify({ following: [
					{ id: 'f1', handle: 'w', displayName: 'W', kind: 'remote', feedType: 'webfeed' },
					{ id: 'f2', handle: 'i', displayName: 'I', kind: 'remote', feedType: 'instance' }
				] }), { status: 200 })
			: new Response(JSON.stringify({ timeline: [], nextCursor: null }), { status: 200 })
	)
	const me = { user: { id: 'me1', handle: 'alice', displayName: 'Alice', kind: 'local' as const }, isAnonymous: false }
	const owner = (await load({ fetch, params: { handle: 'Alice' }, url: new URL('http://x/u/Alice/following'), parent: async () => ({ me }) } as never)) as { handle: string; isOwner: boolean; followIds: string[] }
	expect(owner.handle).toBe('alice')
	expect(owner.isOwner).toBe(true)
	expect(owner.followIds).toEqual(['f1'])
	const visitor = (await load({ fetch, params: { handle: 'bob' }, url: new URL('http://x/u/bob/following'), parent: async () => ({ me }) } as never)) as { isOwner: boolean }
	expect(visitor.isOwner).toBe(false)
})
```

(Existing action tests for follow/unfollow/import stay untouched — the actions don't change.)

- [ ] **Step 2: Run to verify failure**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- following`
Expected: FAIL — `isOwner` undefined; `followIds` contains `f2`; handle not lowercased.

- [ ] **Step 3: Implement**

`+page.server.ts` load becomes:

```ts
export const load: PageServerLoad = async ({ fetch, params, url, parent }) => {
	const handle = params.handle.toLowerCase() // handles are stored lowercase; a mixed-case URL must not demote the owner to visitor mode
	const before = url.searchParams.get('before') ?? undefined
	const isFirstPage = !before
	const { me } = await parent()
	const isOwner = me?.user.handle === handle
	try {
		const [{ timeline, nextCursor }, following] = await Promise.all([
			getTimeline(fetch, { before, followedBy: handle }),
			getFollowing(fetch, handle)
		])
		return { handle, isOwner, timeline: enrichEntries(timeline), nextCursor, isFirstPage, following, followIds: following.filter((u) => u.feedType !== 'instance').map((u) => u.id) }
	} catch {
		return { handle, isOwner, timeline: [], nextCursor: null, isFirstPage, following: [], followIds: [], coreDown: true }
	}
}
```

(Actions unchanged.)

`+page.svelte` changes:

1. `onPost` gains the owner disjunct (live-lens self-inclusion, mirrors core's self-inclusive `followed_by`):

```ts
	function onPost(entry: TimelineEntry) {
		const keep = keepEvent(entry, { kind: 'followed', followIds: followSet }) || entry.author.handle === data.handle
		if (keep && !posts.some((p) => p.id === entry.id)) live = [entry, ...live]
	}
```

2. The auth-note (:54) renders in **visitor mode only**:

```svelte
	{#if !data.isOwner}
		<p class="auth-note">Follow buttons here act as you, not as @{data.handle}.</p>
	{/if}
```

3. Panels become owner-gated. Owner gets a subscribe panel FIRST (posting cross-route to the home action — one action, one implementation), then the existing Follow-someone and Import panels; visitors get none:

```svelte
	{#if data.isOwner}
		<details class="panel">
			<summary>Subscribe to a feed</summary>
			<form method="POST" action="/?/subscribe" class="add-remote">
				<label class="visually-hidden" for="sub-url">Feed URL</label>
				<input id="sub-url" name="url" type="url" placeholder="https://their-site.com/feed.xml" required />
				<label><input type="radio" name="type" value="webfeed" checked /> a site or publication</label>
				<label><input type="radio" name="type" value="person" /> an individual</label>
				<button>Subscribe</button>
			</form>
		</details>
		<details class="panel" open>
			<summary>Follow someone</summary>
			<!-- existing ?/follow form unchanged -->
		</details>
		{#if data.me && !data.me.isAnonymous}
			<!-- existing Import OPML panel unchanged -->
		{:else}
			<p class="auth-note">Register to add feeds.</p>
		{/if}
	{/if}
```

4. Section heading + rows:

```svelte
		<h2>{data.isOwner ? 'Your subscriptions' : `@${data.handle} follows`}</h2>
```

Each `<li>`: keep `@handle` + kind badge; add `{#if u.feedType === 'instance'}<span class="badge-kind">instance</span>{/if}`; the mutation form becomes mode-dependent:

```svelte
						{#if data.isOwner}
							<form method="POST" action="?/unfollow" class="unfollow-form">
								<input type="hidden" name="target" value={u.handle} />
								<button>Unfollow</button>
							</form>
						{:else}
							<form method="POST" action="?/follow" class="unfollow-form">
								<input type="hidden" name="target" value={u.handle} />
								<button>Follow</button>
							</form>
						{/if}
```

5. Empty-list copy: `{data.isOwner ? "You're not following anything yet — subscribe above." : \`@${data.handle} isn't following anything yet.\`}`

6. Import-result copy (:51) gains the skip reason:

```svelte
			<p class="import-result">Imported: {form.result.followed} followed, {form.result.created} created, {form.result.skipped} skipped (unfetchable, duplicate, or over your subscription cap).</p>
```

- [ ] **Step 4: Run tests + typecheck**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- following` → PASS.
Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web` → full suite green.
Run: `docker compose exec -T web npm run check -w web` → 0 errors.
Manual smoke: `http://127.0.0.1:5173/u/<some-handle>/following` as guest → read-only list with Follow buttons; no manage panels.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/u/[handle]/following/+page.server.ts web/src/routes/u/[handle]/following/+page.svelte web/src/routes/following.actions.test.ts
git commit -m "web: mode-switched following page — owner manager vs read-only visitor; lens owner-inclusion + instance exclusion

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(If load tests went to a new `following.load.test.ts`, stage that path too.)

---

### Task 6: Web — admin Settings tab

**Implementer note:** UI task — invoke `ui-ux-pro-max:ui-ux-pro-max` first; follow MASTER.md.

**Files:**
- Modify: `web/src/routes/admin/+layout.svelte` (tabs array)
- Create: `web/src/routes/admin/settings/+page.server.ts`, `web/src/routes/admin/settings/+page.svelte`
- Test: `web/src/routes/admin-settings.actions.test.ts` (new)

**Interfaces:**
- Consumes: `getAdminSettings`/`patchAdminSettings` (Task 4); admin 404-hide gate inherited from `admin/+layout.server.ts`.
- Produces: `/admin/settings` page. No downstream task.

- [ ] **Step 1: Write the failing test**

`web/src/routes/admin-settings.actions.test.ts` (match `page.actions.test.ts` helper style — small local `formRequest`/event helpers are fine):

```ts
import { test, expect, vi } from 'vitest'
import { actions } from './admin/settings/+page.server.ts'

function saveEvent(fields: Record<string, string>, fetch: ReturnType<typeof vi.fn>) {
	return {
		request: new Request('http://x/admin/settings?/save', { method: 'POST', body: new URLSearchParams(fields) }),
		fetch,
		url: new URL('http://x/admin/settings'),
		cookies: { getAll: () => [{ name: 'textcaster.session_token', value: 's1' }] }
	}
}

test('save PATCHes a valid integer cap', async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({ maxSubsPerUser: 250 }), { status: 200 }))
	const res = await actions.save(saveEvent({ maxSubsPerUser: '250' }, fetch) as never)
	expect(res).toEqual({ saved: true })
	const init = fetch.mock.calls[0][1] as RequestInit
	expect(init.method).toBe('PATCH')
	expect(JSON.parse(String(init.body))).toEqual({ maxSubsPerUser: 250 })
})

test('save rejects non-integer and negative values without calling core', async () => {
	const fetch = vi.fn()
	expect(await actions.save(saveEvent({ maxSubsPerUser: 'abc' }, fetch) as never)).toMatchObject({ status: 400 })
	expect(await actions.save(saveEvent({ maxSubsPerUser: '-1' }, fetch) as never)).toMatchObject({ status: 400 })
	expect(fetch).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run to verify failure**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- admin-settings`
Expected: FAIL — cannot find `./admin/settings/+page.server.ts`.

- [ ] **Step 3: Implement**

`web/src/routes/admin/+layout.svelte` tabs array gains:

```ts
		{ href: '/admin/settings', label: 'Settings' }
```

`web/src/routes/admin/settings/+page.server.ts`:

```ts
import { fail } from '@sveltejs/kit'
import { authedFetch, cookieHeader } from '$lib/server/session'
import { getAdminSettings, patchAdminSettings } from '$lib/api'
import type { Actions, PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ fetch, url, cookies }) => {
	const f = authedFetch(fetch, url.origin, cookieHeader(cookies))
	return { settings: await getAdminSettings(f) }
}

export const actions: Actions = {
	save: async (event) => {
		const raw = String((await event.request.formData()).get('maxSubsPerUser') ?? '').trim()
		const value = Number(raw)
		if (!Number.isInteger(value) || value < 0) return fail(400, { error: 'maxSubsPerUser must be an integer ≥ 0' })
		try {
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			await patchAdminSettings(f, { maxSubsPerUser: value })
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'save failed' })
		}
		return { saved: true }
	}
}
```

`web/src/routes/admin/settings/+page.svelte`:

```svelte
<script lang="ts">
	import { enhance } from '$app/forms'
	import type { PageData, ActionData } from './$types'

	let { data, form }: { data: PageData; form: ActionData } = $props()
</script>

<svelte:head><title>Admin · Settings — Textcaster</title></svelte:head>

<h2>Settings</h2>

{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}
{#if form?.saved}<p class="notice confirm" role="status">Saved.</p>{/if}

<form method="POST" action="?/save" use:enhance>
	<div class="field">
		<label for="max-subs">Max subscriptions per user</label>
		<input id="max-subs" name="maxSubsPerUser" type="number" min="0" required value={data.settings.maxSubsPerUser} />
		<p class="field-hint">Self-serve subscriptions (person + web feeds) each registered user may hold. Default 500.</p>
	</div>
	<button>Save</button>
</form>
```

- [ ] **Step 4: Run tests + typecheck**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- admin-settings` → PASS.
Run: `docker compose exec -T web npm run check -w web` → 0 errors.
Manual smoke: `/admin/settings` as non-admin/guest → 404 (layout gate); the Settings tab appears in the admin nav.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/admin/+layout.svelte web/src/routes/admin/settings/+page.server.ts web/src/routes/admin/settings/+page.svelte web/src/routes/admin-settings.actions.test.ts
git commit -m "web: /admin/settings — maxSubsPerUser cap field (fourth admin tab)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Docs + integrated verification

**Files:**
- Modify: `README.md`, `docs/superpowers/documentation/RUNNING.md`

**Interfaces:** consumes Tasks 1-6; produces docs + the verified whole.

- [ ] **Step 1: Docs**

`README.md`: in "What works today", after the four-tab paragraph, add:

```markdown
**Your own feed reader.** Registered users subscribe to any RSS/JSON/Atom
feed by URL (capped per user, admin-configurable), follow people, and manage
it all — subscribe, unfollow, OPML import/export — from their following page.
Feed titles become display names automatically on first fetch.
```

`docs/superpowers/documentation/RUNNING.md`: find the per-user-subscriptions section (added in SP1) and append one line noting the admin UI now exists: "The cap is editable in the web UI at `/admin/settings`." (Locate by grepping `max_subs_per_user` / `maxSubsPerUser`; keep the edit to one sentence in the existing section's style.)

- [ ] **Step 2: Integrated verification (evidence before assertions — paste outputs)**

- `npm run -w core test` → all green
- `npm run -w core typecheck` → 0 errors
- `docker compose exec -T web env -u CORE_API_URL npm test -w web` → all green
- `docker compose exec -T web npm run check -w web` → 0 errors
(Known: core suite can flake with 5s timeouts under parallel-session load — re-run affected files standalone and report both results.)

- [ ] **Step 3: Commit**

```bash
git add README.md docs/superpowers/documentation/RUNNING.md
git commit -m "docs: README feed-reader paragraph + RUNNING.md admin settings pointer

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Out of scope (do not build here)

Feed-type re-tag UI, OPML categories, per-instance sub-filters, subscription search/sort/pagination, avatar harvesting, capping `POST /me/follows`, fat-ping displayName wiring, stranded pre-ship URL-named rows — spec "Out of scope" / accepted limitations (S4/S6/S7).
