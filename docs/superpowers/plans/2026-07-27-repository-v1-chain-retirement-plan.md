# Repository v1 posts/threading chain retirement — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the 21 genuinely-dead `Repository` methods (v1 posts/timeline/threading/follow chain) from `core/src/domain/repository.ts`, `core/src/storage/sqlite.ts`, and `core/src/domain/service.ts`, per `docs/superpowers/specs/2026-07-27-repository-v1-chain-retirement-design.md` (rev 4).

**Architecture:** Test callers first (16 files for the `createService(logical)`-required change, `repository-contract.ts`'s 38 tests, 12 other test files with direct doomed-method calls), then `service.ts`'s branch collapse, then the interface+implementation deletion last. This order is load-bearing — the spec's own rev-1 draft got it backwards and didn't compile.

**Tech Stack:** Node 22 native type-stripping (no build step — `tsc --noEmit` is the real compile gate, vitest passes on type errors), better-sqlite3, Kysely-adjacent raw SQL in `sqlite.ts`, vitest.

## Global Constraints

- **Container-only test commands.** `docker compose exec -T core npm run -w core test -- <files>` for vitest; `docker compose exec -T core npm run -w core typecheck` for `tsc --noEmit`. A host run fails on `RSC_TOKEN`/`RSC_AUTH_SECRET` env vars the container supplies — don't use it.
- **Baseline at plan-writing time (re-verify before Task 1):** `docker compose exec -T core npm run -w core test` → 93 files / 958 tests / 0 failures. `tsc --noEmit` → 0 errors.
- **Never `git add -A`** — this is a shared checkout; a parallel session may commit to `main` concurrently. Stage explicit paths.
- **Every task ends with the full core suite green and `tsc --noEmit` clean** — no task may leave the tree red for the next task to inherit.
- **This spec went through 4 revisions**, each surfacing something a prior review missed via hand-enumeration. Every count and file list in this plan was independently re-verified fresh during plan-writing (not transcribed from the spec) — but if an implementer's own read of a file disagrees with this plan, trust the file. Cite the actual line, not this document's line number, if they've drifted.
- **The spec's own required first steps are folded into Task 1 below**, not left as a promise: the `createService` and doomed-method greps were re-run fresh at plan-writing time (result: same 16 and 12 files as the spec, no drift as of `2814da7`), and `repository-contract.ts`'s 38 tests were read and categorized fresh, finding one MORE gap the spec's 3 review rounds missed (`:151`'s `getPost` test depends on the dying `insertPost`) plus a confirmed-real gap in v2's timeline tie-break coverage (checked `logical-projector.test.ts` and `logical-feeds.test.ts` directly — no existing tie-break test, the spec's concern was real, not hypothetical).

---

### Task 1: Fix the 16 `createService`-missing-`logical` test files (test-only, no `src` changes)

**Files:**
- Modify: `core/test/logical-vertical.test.ts`, `core/test/logical-policy-events.test.ts`, `core/test/service.test.ts`, `core/test/push.test.ts`, `core/test/admin.test.ts`, `core/test/admin-users.test.ts`, `core/test/admin-overview.test.ts`, `core/test/logical-admin-api.test.ts`, `core/test/logical-review-api.test.ts`, `core/test/logical-routes.test.ts`, `core/test/logical-feeds.test.ts`, `core/test/multi-session.test.ts`, `core/test/auth.test.ts`, `core/test/moderation.test.ts`, `core/test/posts-edit.test.ts`, `core/test/smoke.test.ts`

**Interfaces:**
- Consumes: `createService(repo, bus, publicUrl?, logical?)` — current signature, unchanged in this task.
- Produces: every listed file compiles and passes with a real (or fake, where noted) `LogicalStore` at every `createService` call site, so Task 2 can flip `logical?` to required with zero broken callers.

- [ ] **Step 1: Confirm the baseline**

Run: `docker compose exec -T core npm run -w core test && docker compose exec -T core npm run -w core typecheck`
Expected: 93 files / 958 tests / 0 failures; 0 tsc errors.

- [ ] **Step 2: Re-run the mechanical sweep to confirm no drift**

```bash
grep -n "createService(" core/test/*.ts
```
Expected: the same 16 files identified above have at least one call site with `logical` omitted or explicit `null`. If a 17th file appears, stop and re-scope this task before proceeding — do not silently absorb it.

- [ ] **Step 3: `core/test/logical-vertical.test.ts` — delete the OFF-path test**

Delete the test containing `createService(repo, createEventBus(), null) // no logical store — exactly the OFF path` (currently `:106`, body runs through `:~120` — read the file to find the exact `test(...)`/`})` boundary). This test asserts "a service built WITHOUT the logical store writes NO v2 rows" — that state cannot occur once `logical` is required (Task 2). No replacement needed; nothing else in the deleted test body exercises surviving behavior.

- [ ] **Step 4: `core/test/logical-policy-events.test.ts` — delete the OFF-path test**

Delete the test containing `createService(repo, createEventBus(), 'https://cast.example') // no logical store` (currently `:283-292`, `'with v2 OFF the same service writes NO journal row (flag-off isolation)'`). Same reasoning as Step 3.

- [ ] **Step 5: `core/test/service.test.ts` — the renameApp helper's two `test.each` blocks**

The shared `renameApp(v2: boolean)` helper (currently `:173`, internally calls `createService(repo, bus, null, v2 ? store : undefined)`) feeds TWO separate `test.each([false, true])` blocks (currently `:190` and `:208`). For EACH block: delete the `false` case, keep the `true` case as an ordinary (non-parametrized) test — i.e. change `test.each([false, true])('...(v2=%s)', async (v2) => { const { repo, app } = await renameApp(v2) ... })` to `test('...', async () => { const { repo, app } = await renameApp(true) ... })`, dropping the `(v2=%s)` from the test name and the now-unused `v2` parameter, for both blocks.

- [ ] **Step 6: `core/test/service.test.ts` — preserve the self-follow/instance-exclusion test with a fake `LogicalStore` stub**

The test `'addFollow refuses self-follow and instance targets, minting nothing'` (currently `:74-86`) uses a fake `Repository` stub (`{ addFollow: async (a, b) => { follows.push([a, b]) } }`) and calls `createService(repo, createEventBus())` with no `logical`. This test must SURVIVE (its behavior moves inline into `service.ts`'s `addFollow` in Task 2 — see the spec's Correction rev 4, finding 4). Add a fake `LogicalStore` stub alongside the fake `Repository`:

```typescript
test('addFollow refuses self-follow and instance targets, minting nothing', async () => {
  const follows: Array<[string, string]> = []
  const repo = { addFollow: async (a: string, b: string) => { follows.push([a, b]) } } as unknown as Repository
  const logical = { addLocalFollow: () => { follows.push(['via-logical', 'unused']) } } as unknown as LogicalStore
  const svc = createService(repo, createEventBus(), null, logical)
  const alice: User = { id: 'alice-id', kind: 'local', handle: 'alice', displayName: 'Alice', feedUrl: null, createdAt: '2026-01-01T00:00:00.000Z', authUserId: null }
  const peer: User = { id: 'inst-id', kind: 'remote', handle: 'peer', displayName: 'Peer', feedUrl: 'https://p.example/f.xml', createdAt: '2026-01-01T00:00:00.000Z', authUserId: null, feedType: 'instance' }
  expect(await svc.addFollow(alice, alice)).toBe(false)
  expect(await svc.addFollow(alice, peer)).toBe(false)
  expect(follows).toEqual([])
  const person: User = { ...peer, id: 'p2', handle: 'p2', feedType: 'person' }
  expect(await svc.addFollow(alice, person)).toBe(true)
})
```

Note: the assertion `expect(follows).toEqual([['alice-id', 'p2']])` from the original test is dropped, since `addFollow` now writes via `logical.addLocalFollow` not `repo.addFollow` — the fake `logical.addLocalFollow` stub above pushes a marker so you can still assert it was called exactly once with the right args if you prefer (`expect(follows).toEqual([['via-logical', 'unused']])`); either assertion shape is fine as long as it proves the guard rejected the first two calls and the third one reached `logical.addLocalFollow`. Import `LogicalStore`'s type from `../src/logical/store.ts` (check the actual export name/path by reading `core/src/logical/store.ts`'s exports before writing the import).

- [ ] **Step 7: `core/test/push.test.ts` — repair with a real logical store AND fix the `O5` fixture**

Give `setup()` (currently `:14`, `createService(repo, bus)`) a real `LogicalStore` — read the file's existing `setup()` helper and other tests in this same file that already build one (several call sites in other test files pass `createLogicalStore(createDatabaseContext(repo.raw))`; use the same pattern here) so `push.ts`'s call into `createLocalPostAs` continues exercising the real production code path.

**Also required, in the `O5` test specifically** (`'O5: self mode fat ping counts a REMOTE logical reply (v2) so the push body matches the pull'`, currently `:174-190`): once `setup()` gives the service a real logical store, `service.createLocalPostAs('alice', 'Alice', 'root post')` will itself write a `logical_items_v2` row for `root.id` via `materializeLocalItem` (confirmed: `core/src/logical/local.ts:182`). Delete this test's own manual insert of that same row:

```typescript
// DELETE this line (or the whole INSERT statement) — it now collides on PK with
// the row service.createLocalPostAs's own logical store write already creates:
repo.raw.prepare(`INSERT INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, created_at) VALUES (?, 'local', ?, 'none', NULL, NULL, NULL, ?)`).run(root.id, NOW, NOW)
```

Keep the SECOND manual insert (the synthetic remote reply row) — that one has no production equivalent and is still needed.

Run `docker compose exec -T core npm run -w core test -- push.test.ts` after this step specifically and confirm `O5` passes — if it still fails on a PK collision, the delete above targeted the wrong line; re-read the file.

- [ ] **Step 8: Add a real logical store to the remaining 12 files**

For each of: `admin.test.ts`, `admin-users.test.ts`, `admin-overview.test.ts`, `logical-admin-api.test.ts`, `logical-review-api.test.ts`, `logical-routes.test.ts`, `logical-feeds.test.ts`, `multi-session.test.ts`, `auth.test.ts`, `moderation.test.ts`, `posts-edit.test.ts`, `smoke.test.ts` — read the file's existing `createService(...)` call site, and give it a real `LogicalStore` as the 4th argument (following the same `createLogicalStore(createDatabaseContext(repo.raw))` pattern used elsewhere in `core/test/`). None of these are OFF-path-specific — they just used the parameter's current optionality for convenience. If a file's own setup doesn't already have a `Raw`/database context handle available, read how a sibling file in the same directory constructs one (e.g. `logical-sse.test.ts` or `api.test.ts`) rather than inventing a new pattern.

- [ ] **Step 9: Also fix `service.test.ts`'s remaining non-OFF-path call sites**

Lines `:18` (the shared `setup()` helper — check every test that uses it to confirm none of them specifically relies on `logical` being absent; if any do, that's an OFF-path test this step missed and Step 3-6 should have caught it, so re-check), `:53`, `:100`, `:107`, `:114` all call `createService` without a real logical store for reasons unrelated to testing the OFF path. Add one to each, same pattern as Step 8.

- [ ] **Step 10: Run the full targeted set**

Run: `docker compose exec -T core npm run -w core test -- logical-vertical.test.ts logical-policy-events.test.ts service.test.ts push.test.ts admin.test.ts admin-users.test.ts admin-overview.test.ts logical-admin-api.test.ts logical-review-api.test.ts logical-routes.test.ts logical-feeds.test.ts multi-session.test.ts auth.test.ts moderation.test.ts posts-edit.test.ts smoke.test.ts`
Expected: all pass.

- [ ] **Step 11: Run the full core suite**

Run: `docker compose exec -T core npm run -w core test && docker compose exec -T core npm run -w core typecheck`
Expected: 954 tests passed (958 minus the 4 deleted: 1 from `logical-vertical.test.ts`, 1 from `logical-policy-events.test.ts`, 2 from `service.test.ts`'s `test.each` false-halves), file count may drop by 0 (no files deleted, only tests within them). 0 tsc errors.

- [ ] **Step 12: Commit**

```bash
git add core/test/logical-vertical.test.ts core/test/logical-policy-events.test.ts core/test/service.test.ts core/test/push.test.ts core/test/admin.test.ts core/test/admin-users.test.ts core/test/admin-overview.test.ts core/test/logical-admin-api.test.ts core/test/logical-review-api.test.ts core/test/logical-routes.test.ts core/test/logical-feeds.test.ts core/test/multi-session.test.ts core/test/auth.test.ts core/test/moderation.test.ts core/test/posts-edit.test.ts core/test/smoke.test.ts
git commit -m "test: give every createService caller a real logical store

Prep for making createService's logical parameter required (next task):
16 files either omitted it or passed null. Deleted 2 tests asserting a
flag-off state that can no longer exist once the flag itself is gone
(logical-vertical.test.ts, logical-policy-events.test.ts), collapsed
service.test.ts's two test.each([false,true]) rename blocks to their
true-only case, and fixed push.test.ts's O5 fixture — once it gets a
real logical store, service.createLocalPostAs writes the same
logical_items_v2 row the test used to insert manually, so the manual
insert now collides on the primary key.

developed with the help of AI tools"
```

---

### Task 2: Collapse `service.ts`'s branches to v2-only, inline the `addFollow` guard, require `logical`

**Files:**
- Modify: `core/src/domain/service.ts`

**Interfaces:**
- Consumes: Task 1 (every test caller now passes a real logical store).
- Produces: `createService(repo: Repository, bus: EventBus, publicUrl?: string | null, logical: LogicalStore)` — `logical` required. No other exported shape changes.

- [ ] **Step 1: Confirm Task 1 landed and the suite is at 954/954**

Run: `docker compose exec -T core npm run -w core test`
Expected: 954 tests passed, 0 failed.

- [ ] **Step 2: Re-read `service.ts`'s 8 branch sites fresh**

```bash
grep -n "if (logical" core/src/domain/service.ts
```
Expected 8 hits (as of plan-writing: lines 50, 83, 106, 150, 164, 171, 197, 213 — re-verify, this file may have shifted since). For each: collapse to the `if (logical)` branch's body only, deleting the `else` arm entirely.

- [ ] **Step 3: `addFollow` — inline the exclusion guard, delete `followUnlessExcluded`**

Replace:
```typescript
async addFollow(follower: User, target: User): Promise<boolean> {
  if (follower.kind !== 'local') throw new DomainError('follower must be a local user')
  if (logical && target.feedType !== 'instance' && target.id !== follower.id) {
    logical.addLocalFollow({ followerId: follower.id, followedId: target.id, now: new Date().toISOString() })
    return true
  }
  return followUnlessExcluded(repo, follower.id, target)
},
```
with:
```typescript
async addFollow(follower: User, target: User): Promise<boolean> {
  if (follower.kind !== 'local') throw new DomainError('follower must be a local user')
  if (target.feedType === 'instance' || target.id === follower.id) return false
  logical.addLocalFollow({ followerId: follower.id, followedId: target.id, now: new Date().toISOString() })
  return true
},
```
Delete the `followUnlessExcluded` function entirely (currently `:18-22`):
```typescript
async function followUnlessExcluded(repo: Repository, followerId: string, target: User): Promise<boolean> {
  if (target.feedType === 'instance' || target.id === followerId) return false
  await repo.addFollow(followerId, target.id)
  return true
}
```

- [ ] **Step 4: `deleteLocalAccount`'s branch (currently `:197`)**

Collapse to the `if (logical)` half only. Read the surrounding code first — the `else` half called `repo.deleteUserCascade`/`repo.deleteAuthRows`; confirm those two `Repository` methods are NOT being deleted (they're on the survivor list, still reachable via `removeFollow`'s orphan-reap and `removeRemoteFeed` per the spec) and this deletion only removes the `deleteLocalAccount`-specific fallback, not the functions themselves.

- [ ] **Step 5: `resolveReplyTarget` (currently `:106`) and `removeFollow`/`deletePost`/`editLocalPost`/`createLocalPostAs`/`updateUserProfile` (the remaining branch sites)**

For each, delete the `else` arm, keeping only the `if (logical) {...}` body's contents as the function's unconditional behavior. Read each site — some are `if (logical) {v2} else {v1}` blocks, some are `logical && ...` guard expressions (simplify to drop the now-always-true `logical &&` prefix) or ternaries (`logical ? v2 : v1` → just `v2`).

- [ ] **Step 6: Delete the stale doc comment**

Delete the comment above `createService` (currently `:24-27`): `// 'logical' is always present in production ... it stays optional here only so tests that don't need v2 wiring can omit it.` — it describes a design this task removes.

- [ ] **Step 7: Change the signature**

`export function createService(repo: Repository, bus: EventBus, publicUrl?: string | null, logical?: LogicalStore)` → `export function createService(repo: Repository, bus: EventBus, publicUrl?: string | null, logical: LogicalStore)`.

- [ ] **Step 8: Typecheck — this is the real gate for this task**

Run: `docker compose exec -T core npm run -w core typecheck`
Expected: 0 errors. If ANY caller still omits `logical`, this is the signal Task 1 missed a file — stop, find it (re-run Step 2's grep from Task 1), fix it there, then return here.

- [ ] **Step 9: Run the full suite**

Run: `docker compose exec -T core npm run -w core test`
Expected: 954 tests passed, 0 failed — no test COUNT change from this task (pure behavior-preserving collapse, verified by Task 1 already making every caller pass a real store that already exercised the v2 branch).

- [ ] **Step 10: Commit**

```bash
git add core/src/domain/service.ts
git commit -m "core: collapse service.ts's v1/v2 branches, require a logical store

Every if (logical) {v2} else {v1} branch (8 sites) collapses to its v2
half. addFollow's exclusion guard (self-follow, instance-follow reject)
moves inline into addFollow itself, since followUnlessExcluded — the
function that used to own that guard — is deleted along with the
Repository.addFollow it called; the guard's behavior doesn't change,
only where it lives. logical becomes a required parameter: Task 1
already gave every test caller a real store, so this is a pure
signature tightening with zero behavior change, verified by an
unchanged 954-test pass count.

developed with the help of AI tools"
```

---

### Task 3: Rewrite `repository-contract.ts` (38 tests, definitive categorization below)

**Files:**
- Modify: `core/src/domain/repository-contract.ts`
- Modify: `core/test/logical-projector.test.ts` (add one new test, see Step 9)

**Interfaces:**
- Consumes: Task 2 (the 21 methods are not yet deleted from `Repository` — this task only stops `repository-contract.ts` from calling them).
- Produces: a shrunk `runRepositoryContract` covering only surviving `Repository` methods, ready for the interface+implementation deletion in Task 5.

This task's categorization was produced by reading every one of the 38 tests fresh at plan-writing time (2026-07-27), not transcribed from the spec — and found one gap none of the spec's 3 review rounds caught (`:151`). Re-verify line numbers against the current file before editing; they may have drifted since.

- [ ] **Step 1: Confirm Task 2 landed**

Run: `docker compose exec -T core npm run -w core test && docker compose exec -T core npm run -w core typecheck`
Expected: 954 tests passed, 0 tsc errors.

- [ ] **Step 2: Delete outright — 20 tests, pure dead-method subject, no survivor assertion**

Delete these tests entirely (identify by their current `test('...')` string, not by line number, since earlier tasks in this plan don't touch this file but the spec-writing-to-plan-writing gap might have shifted lines): `'inserts posts and returns a newest-first timeline with authors'`, `'insertPost returns false and does not duplicate on a repeat (author_id, guid) pair'`, `'insertPost allows the same guid under a different author'`, `'hasPostsByAuthor is false before any post and true after'`, `'inserting a post whose authorId does not exist rejects'`, `'getTimelineAfter returns arrival order, inclusive of the anchor timestamp'`, `'followedBy filter scopes the timeline to followed authors, paginating across boundaries'`, `'authorId filter scopes to one author (works for remote authors too)'`, `'backfillItemExtras fills each column independently, only where null (COR-1)'`, `'findPostByRef: unique url wins; duplicated url resolves to NOTHING (Hole A)'`, `'findPostByRef: unique guid matches; guid shared by two posts resolves to NOTHING (H2)'`, `'reply fields round-trip through insertPost/getPost and default to null'`, `'getThread returns root + all descendants flat, (published_at, id) ASC'`, `'getThread never shows a reply before its parent, even when feed-truncated timestamps invert them'`, `'getThread terminates on a mutual-reply cycle (adoption-formed) and returns each post exactly once'`, `'adoptOrphans attaches earlier orphans and re-roots their whole subtree'`, `'adoption refuses ambiguous refs on BOTH arms (H2 + Hole A)'`.

Before deleting `'reply fields round-trip through insertPost/getPost and default to null'` specifically: confirm `logical-threading.test.ts` or a sibling `logical-*.test.ts` file has equivalent coverage of reply-field persistence (`inReplyTo`/`inReplyToPostId`/`threadRootId` round-tripping) — the spec's Non-goals section claims this class of behavior is covered by v2's own threading tests; spot-check it's true for this specific assertion before deleting, not just for orphan-adoption in general.

Also delete `'self-follow is allowed and needs no special-casing'` (currently `:254`, with its preceding 2-line comment about the REPO-vs-SERVICE contrast) — that contrast is moot once `Repository.addFollow` no longer exists for the repo side to be "permissive" about.

That's 18 named above + the self-follow one = 19. Also delete `'getTimeline pages with a before cursor: page 2 starts where page 1 ended'` and `'getTimeline splits publishedAt ties by id across pages'` and `'topLevel timeline keeps roots and honest orphans but excludes resolved descendants before pagination'` — but NOT yet; see Step 9 first, which must land BEFORE these three are deleted (they're the ones covering behavior with a confirmed v2 coverage gap).

- [ ] **Step 3: Simplify one test**

`'creates a remote user and lists it among remotes only'` — delete its `listRemoteUsers` call and the assertion on it (`const remotes = await repo.listRemoteUsers(); expect(remotes.map((x) => x.handle)).toEqual(['news'])`), keep the `createRemoteUser` assertions (`kind`, `feedUrl`) above it.

- [ ] **Step 4: Split `'addFollow is idempotent and listFollowing returns follows in created_at order'`**

This test currently seeds follows via `repo.addFollow` (dying) purely to test `listFollowing`'s created_at ordering and duplicate-follow handling (surviving). Re-point the setup to seed via `logical.addLocalFollow` instead — this test needs access to a `LogicalStore`, which `makeRepo()` doesn't currently provide. Read how `runRepositoryContract`'s callers construct their repo (`sqlite-repository.test.ts`) to determine whether to thread a `LogicalStore` through `runRepositoryContract`'s own signature, or construct one inline per-test from `repo.raw` (matching the `createLogicalStore(createDatabaseContext(repo.raw))` pattern used elsewhere) — the latter is almost certainly simpler and doesn't change `runRepositoryContract`'s public signature. Rewrite as:

```typescript
test('listFollowing returns follows in created_at order and duplicate follows are idempotent', async () => {
  const repo = await makeRepo()
  const logical = createLogicalStore(createDatabaseContext(repo.raw))
  const a = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
  const b = await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
  const c = await repo.createRemoteUser({ handle: 'blog', displayName: 'Blog', feedUrl: 'https://ex.com/b.xml' })
  const now = () => new Date().toISOString()
  logical.addLocalFollow({ followerId: a.id, followedId: c.id, now: now() }) // follow 'blog' first
  logical.addLocalFollow({ followerId: a.id, followedId: b.id, now: now() }) // follow 'news' second
  logical.addLocalFollow({ followerId: a.id, followedId: c.id, now: now() }) // duplicate re-follow of blog — still idempotent
  const following = await repo.listFollowing(a.id)
  expect(following.map((u) => u.handle)).toEqual(['blog', 'news'])
})
```

Verify `createLogicalStore`'s and `createDatabaseContext`'s real import paths/signatures by reading `core/src/logical/store.ts` and wherever `createDatabaseContext` is defined before writing the import lines — don't guess.

- [ ] **Step 5: Split `'removeFollow is idempotent (removing a non-follow is a no-op)'`**

Same pattern — rewrite to seed/remove via `logical.addLocalFollow`/`logical.removeLocalFollow` and assert on `listFollowing`:

```typescript
test('listFollowing reflects removeLocalFollow, and removing a non-follow is a no-op', async () => {
  const repo = await makeRepo()
  const logical = createLogicalStore(createDatabaseContext(repo.raw))
  const a = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
  const b = await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
  const now = () => new Date().toISOString()
  logical.removeLocalFollow({ followerId: a.id, followedId: b.id, now: now() }) // never followed — no throw
  logical.addLocalFollow({ followerId: a.id, followedId: b.id, now: now() })
  logical.removeLocalFollow({ followerId: a.id, followedId: b.id, now: now() })
  logical.removeLocalFollow({ followerId: a.id, followedId: b.id, now: now() }) // already gone — no throw
  expect(await repo.listFollowing(a.id)).toEqual([])
})
```

Verify `removeLocalFollow`'s exact signature by reading `core/src/logical/store.ts` before writing this — don't assume it mirrors `addLocalFollow`'s shape exactly.

- [ ] **Step 6: Split `'countRepliesByPostIds and listRepliesByPostId key on resolved ids only'`**

`countRepliesByPostIds` survives, `listRepliesByPostId` doesn't. Delete only the `listRepliesByPostId` assertion (`expect((await repo.listRepliesByPostId('root')).map((p) => p.id)).toEqual(['r1', 'r2'])`) and rename the test to drop the `listRepliesByPostId` half of its description. Everything else in the test (the `root`/`r1`/`r2`/`stray` setup, the `countRepliesByPostIds` assertions) stays — this is `countRepliesByPostIds`'s own coverage, resolve per Step 8 below (this test's `insertPost`-based setup has the same fixture-strand problem as Step 8's other 3 tests).

- [ ] **Step 7: Split `'conversation counts include every descendant while direct counts stay direct'`**

`countRepliesByPostIds` survives, `countThreadRepliesByRootIds` doesn't. Delete the two `countThreadRepliesByRootIds` assertions (lines asserting `new Map([['root', 2]])` and `new Map()`), keep the `countRepliesByPostIds` assertion and its setup. Rename to drop "while direct counts stay direct" (nothing about direct-vs-conversation distinction survives once `countThreadRepliesByRootIds` is gone). Same fixture-strand problem as Step 8.

- [ ] **Step 8: Resolve the `insertPost`-strands-fixture-setup problem for 5 tests**

`getPost`'s not-found-case test (`'getPost returns a post by id and undefined for unknown ids'`), `'getPostsByAuthor returns only that author, display-ordered, limited'`, `'getRecentLocalPosts: local authors only, newest first, limited'`, and the surviving halves of Steps 6 and 7's split tests ALL use `repo.insertPost` to seed post rows — a method being deleted in Task 5. For each: check whether `core/test/push.test.ts` (for `getPostsByAuthor`/`countRepliesByPostIds`/`getRecentLocalPosts`, per the spec's Design item 3) already covers the exact behavior being asserted; if fully covered there, delete the test here instead of porting it. For `getPost`'s not-found case specifically (not named in the spec at all — found fresh during this plan's own re-read) and for the found-case half of that same test: `getPost` is called directly by `core/src/api/app.ts` in production, and its not-found behavior is trivial (`getPost('nope')` → `undefined`) — this half needs no post row at all and can stay completely as-is once its sibling "found" assertion is resolved. For the "found" half and any test where `push.test.ts` doesn't already prove full coverage: re-point the setup to seed via `logical.createLocalPost` (`createLogicalStore(createDatabaseContext(repo.raw))`, same pattern as Steps 4-5) instead of `repo.insertPost`, keeping the assertion against the surviving `Repository` method (`repo.getPost`/`repo.getPostsByAuthor`/`repo.getRecentLocalPosts`/`repo.countRepliesByPostIds`).

This step requires judgment per-test, not a mechanical transcription — read `push.test.ts` in full first, then decide test-by-test.

- [ ] **Step 9: Write the new v2 timeline tie-break test BEFORE deleting the v1 versions**

Confirmed at plan-writing time: `core/test/logical-projector.test.ts:270` (`'timeline orders by (timelineSortAt DESC, id DESC) and paginates through the opaque cursor'`) tests pagination but its fixture (`makeRiver`) seeds every row with a DISTINCT `timelineSortAt` — no two rows share a timestamp, so the tie-break half of `(timelineSortAt DESC, id DESC)` is never actually exercised. `logical-feeds.test.ts` has no tie-break coverage either. This is the one behavior from Design item 6 that genuinely has zero v2 test today. Add a new test to `core/test/logical-projector.test.ts`, near the existing `:270` test:

```typescript
test('timeline tie-breaks equal timelineSortAt by id DESC', async () => {
  const { raw, db } = await fresh()
  seedUser(raw, 'u1', 'alice')
  const tied = '2026-07-23T00:00:05.000Z'
  seedPost(raw, { id: 'aaa', author: 'u1', at: tied })
  seedPost(raw, { id: 'zzz', author: 'u1', at: tied })
  const first = db.read((tx) => projectTimeline(tx, { lens: { kind: 'public' }, before: null, limit: 1, viewer: ANON }))
  expect(first.timeline.map((d) => d.id)).toEqual(['zzz'])
  const dec = decodeCursor(first.nextCursor as string)!
  const before: TimelineCursorV2 = { version: 1, timelineSortAt: dec.tuple[0], logicalItemId: dec.tuple[1] }
  const second = db.read((tx) => projectTimeline(tx, { lens: { kind: 'public' }, before, limit: 1, viewer: ANON }))
  expect(second.timeline.map((d) => d.id)).toEqual(['aaa'])
})
```

Verify `seedUser`/`seedPost`/`fresh`/`decodeCursor`/`TimelineCursorV2`/`ANON`'s exact signatures against the existing `:270` test and the file's imports before writing this — the snippet above mirrors that test's own shape but re-derive it from the real file, don't transcribe blindly. Run this new test alone first (`docker compose exec -T core npm run -w core test -- logical-projector.test.ts`) and confirm it passes before proceeding to delete the v1 tie-break test in Step 10.

- [ ] **Step 10: NOW delete the 3 timeline-cursor tests held back from Step 2**

`'getTimeline pages with a before cursor: page 2 starts where page 1 ended'`, `'getTimeline splits publishedAt ties by id across pages'`, `'topLevel timeline keeps roots and honest orphans but excludes resolved descendants before pagination'` — all three are pure `getTimeline` (dead) tests; their tie-break-specific behavior is now covered by Step 9's new test, and their pagination/topLevel-filter behavior has no surviving `Repository` method to test against (`getTimeline` itself is fully dead).

- [ ] **Step 11: Run the file's tests**

Run: `docker compose exec -T core npm run -w core test -- sqlite-repository.test.ts logical-projector.test.ts` (the two consumers of this contract, plus the file with the new test)
Expected: pass. Read the actual resulting test count in `repository-contract.ts` and compare informally against this plan's categorization (9 untouched + 1 simplified + 21 deleted outright + 4 split-and-kept + whatever Step 8's per-test decisions produced) — do not force the numbers to match a predicted total; if they don't match, that's fine as long as every deletion is individually justified per the steps above.

- [ ] **Step 12: Run the full core suite**

Run: `docker compose exec -T core npm run -w core test && docker compose exec -T core npm run -w core typecheck`
Expected: 0 tsc errors; test count drops from 954 by however many tests Steps 2-10 actually deleted (report the real before/after numbers, don't predict them here).

- [ ] **Step 13: Commit**

```bash
git add core/src/domain/repository-contract.ts core/test/logical-projector.test.ts
git commit -m "core: shrink repository-contract.ts to surviving Repository methods

Deleted every test whose primary subject is one of the 21 dead methods.
4 tests that used a dying method purely as setup for a surviving
method's real assertion (listFollowing's ordering/idempotency,
countRepliesByPostIds) got their setup re-pointed to LogicalStore
instead of deleted outright. Added the one genuinely-missing v2 test
(timeline tie-break on equal timelineSortAt) before deleting its v1
equivalent -- confirmed via direct inspection that no existing
logical-*.test.ts fixture exercises the tie case.

developed with the help of AI tools"
```

---

### Task 4: Fix the 12 other test files with direct doomed-method calls

**Files:**
- Modify: `core/test/service.test.ts`, `core/test/sqlite-edits.test.ts`, `core/test/per-user-feeds-repo.test.ts`, `core/test/moderation.test.ts`, `core/test/unfollow-cleanup.test.ts`, `core/test/delete-cascade.test.ts`, `core/test/migrations.test.ts`, `core/test/posts-edit.test.ts`, `core/test/auth.test.ts`, `core/test/source-capability-api.test.ts`, `core/test/source-following.test.ts`, `core/test/sqlite-repository.test.ts`

**Interfaces:**
- Consumes: Task 2's `service.ts` (for any test calling `svc.*` methods whose Repository-level equivalent is dying), Task 3's `repository-contract.ts` (for `sqlite-repository.test.ts`'s own `runRepositoryContract` call, unaffected by this task).
- Produces: zero remaining `repo.<dead-method>` calls anywhere in `core/test/`, confirmed by re-running the mechanical grep.

- [ ] **Step 1: Confirm Task 3 landed**

Run: `docker compose exec -T core npm run -w core test`
Expected: whatever count Task 3 ended at (recorded in its own commit).

- [ ] **Step 2: Re-run the mechanical sweep**

```bash
DOOMED='insertPost|getThread\(|adoptOrphans|recordEdit|updateUserProfile|addFollow|removeFollow|deletePost\(|countRepliesByPostIds|countThreadRepliesByRootIds|getTimeline\(|getTimelineAfter|getRevisions|listRepliesByPostId|listRemoteUsers|countRemoteSubscriptions|getRemoteUserByFeedUrl|hasPostsByAuthor|backfillItemExtras|findPostByRef|updateDisplayNameIfUnset|getEditableByGuid'
grep -lrE "repo\.(${DOOMED})" core/test/*.ts
```
Expected: the same 12 files. If a 13th appears, stop and re-scope.

- [ ] **Step 3: `source-following.test.ts` and `per-user-feeds-repo.test.ts` — the two known hard blockers**

`source-following.test.ts:64` (verify current line) and `per-user-feeds-repo.test.ts:23-26,34-35` (verify current lines) call `repo.addFollow(...)` as their only way to seed a `follows` row. Re-point both to `logical.addLocalFollow` (same `createLogicalStore(createDatabaseContext(repo.raw))` pattern as Task 3). Confirm the surviving `listFollowing`/`countFollowers` assertions in these files still pass reading rows written via the `logical` path — they should, since both read from the same `follows` table Task 2 confirmed `addLocalFollow` writes to, but verify by running the tests, not by assumption.

- [ ] **Step 4: `service.test.ts` — remaining direct doomed-method calls plus the 3 dead `svc.getTimeline` call sites**

Read the file fresh (it's already been touched twice by this plan — Tasks 1 and possibly 3's setup work — so re-check its current line numbers). Confirm-and-fix:
- Every remaining `repo.<dead-method>` call (`addFollow`, `insertPost`, etc.) used as test setup — re-point to `logical.*` equivalents per the same pattern as Task 3, or delete the test if its whole subject is a dead method.
- `svc.getTimeline(...)` (confirmed at plan-writing time: zero production callers of this service-level wrapper by that name, either) appears in 3 tests: `'createLocalPost stores, emits, and appears in the timeline'`, `'handles are lowercased, so posting as Alice then alice is one user'`, and `'followed lens passes the filter through'`. For each: `svc.getTimeline` itself is being deleted (Task 5). Read each test's actual purpose — the first two are really testing `createLocalPostAs`'s side effects (bus emission, handle normalization via `getUserByHandle`), with the `getTimeline` call as incidental verification of "the post landed somewhere queryable"; replace that incidental check with a direct `repo.getPost(...)` or `repo.getUserByHandle(...)`-based assertion instead of deleting the whole test. The third (`'followed lens passes the filter through'`) is testing `getTimeline`'s `followedBy` filter specifically — that behavior has no surviving equivalent at the `Repository`/`service` layer (v2's own `followedBy`-equivalent lens filtering is covered elsewhere in `logical-*.test.ts`, per the spec's Non-goals section) — delete this one outright.

- [ ] **Step 5: The remaining 9 files — read, categorize, fix**

For `sqlite-edits.test.ts`, `moderation.test.ts`, `unfollow-cleanup.test.ts`, `delete-cascade.test.ts`, `migrations.test.ts`, `posts-edit.test.ts`, `auth.test.ts`, `source-capability-api.test.ts`, `sqlite-repository.test.ts`: read each file's flagged `repo.<dead-method>` call site(s) in context. For each: determine whether the dead-method call is (a) the test's own primary subject (e.g. `sqlite-edits.test.ts`'s `repo.recordEdit`/`repo.getRevisions` tests — these test dead methods directly, delete them) or (b) setup for a surviving assertion (re-point to `logical.*`/a surviving `Repository` method, same pattern as Tasks 3-4's other steps). `sqlite-repository.test.ts`'s two `repo.updateUserProfile` calls (currently `:18,24`) are ALSO primary-subject tests of a dying method — delete them (this file's OTHER job, calling `runRepositoryContract`, is untouched by this deletion).

- [ ] **Step 6: Run the full core suite**

Run: `docker compose exec -T core npm run -w core test && docker compose exec -T core npm run -w core typecheck`
Expected: 0 tsc errors. Report the real before/after test count.

- [ ] **Step 7: Re-run the mechanical sweep one final time**

```bash
grep -rlE "repo\.(${DOOMED})" core/test/*.ts core/src/domain/repository-contract.ts
```
Expected: **zero output.** If anything remains, this task isn't done — find and fix it before committing.

- [ ] **Step 8: Commit**

```bash
git add core/test/service.test.ts core/test/sqlite-edits.test.ts core/test/per-user-feeds-repo.test.ts core/test/moderation.test.ts core/test/unfollow-cleanup.test.ts core/test/delete-cascade.test.ts core/test/migrations.test.ts core/test/posts-edit.test.ts core/test/auth.test.ts core/test/source-capability-api.test.ts core/test/source-following.test.ts core/test/sqlite-repository.test.ts
git commit -m "test: clear the last direct callers of the 21 dying Repository methods

12 files called one or more of the doomed methods directly (outside
repository-contract.ts, handled in the prior task). source-following.ts
and per-user-feeds-repo.ts used addFollow as their only way to seed a
follows row -- re-pointed to logical.addLocalFollow. service.ts's own
dead svc.getTimeline wrapper had 3 remaining test callers, resolved
per-test rather than deleted wholesale where the test's real subject
(bus emission, handle normalization) survives independent of the
getTimeline check. Zero repo.<dead-method> calls remain anywhere in
core/test, confirmed by the same mechanical grep this plan has used
throughout.

developed with the help of AI tools"
```

---

### Task 5: Delete the 21 methods from `repository.ts` + `sqlite.ts` + `service.ts`'s remaining pass-through wrappers

**Files:**
- Modify: `core/src/domain/repository.ts`, `core/src/storage/sqlite.ts`, `core/src/domain/service.ts`

**Interfaces:**
- Consumes: Tasks 1-4 (every caller is gone).
- Produces: `Repository` interface with 26 methods (down from 47), `SqliteRepository`'s matching implementation, `service.ts` with no dead pass-through wrappers.

- [ ] **Step 1: Confirm Task 4 landed and zero callers remain**

Run:
```bash
docker compose exec -T core npm run -w core test
DOOMED='insertPost|getThread\(|adoptOrphans|recordEdit|updateUserProfile|addFollow|removeFollow|deletePost\(|countRepliesByPostIds|countThreadRepliesByRootIds|getTimeline\(|getTimelineAfter|getRevisions|listRepliesByPostId|listRemoteUsers|countRemoteSubscriptions|getRemoteUserByFeedUrl|hasPostsByAuthor|backfillItemExtras|findPostByRef|updateDisplayNameIfUnset|getEditableByGuid'
grep -rlE "\.(${DOOMED})" core/src core/test | grep -v "core/src/logical/" | grep -v "core/src/domain/repository.ts" | grep -v "core/src/storage/sqlite.ts"
```
Expected: the second grep returns nothing outside `repository.ts`'s own declarations and `sqlite.ts`'s own implementations (the two files this task is about to edit) — confirming every caller was actually cleared by Tasks 2-4. If anything else shows up, STOP — do not proceed with this task until it's resolved (this is the compile-safety gate the spec's corrected staging order exists to protect).

- [ ] **Step 2: Delete the 21 method declarations from `repository.ts`**

`getTimeline`, `getTimelineAfter`, `getRevisions`, `getThread`, `listRepliesByPostId`, `listRemoteUsers`, `countRemoteSubscriptions`, `getRemoteUserByFeedUrl`, `insertPost`, `adoptOrphans`, `recordEdit`, `updateUserProfile`, `addFollow`, `removeFollow`, `deletePost`, `countThreadRepliesByRootIds`, `hasPostsByAuthor`, `backfillItemExtras`, `findPostByRef`, `updateDisplayNameIfUnset`, `getEditableByGuid`. Read the interface fresh and confirm each is still present with this exact name before deleting (Tasks 1-4 didn't touch this file, but re-verify — don't assume).

- [ ] **Step 3: Delete the matching 21 implementations from `sqlite.ts`**

Same 21 methods, this time their `SqliteRepository` class implementations. Delete the method bodies entirely, not just the interface declarations — leaving a dangling private helper only used by a deleted method is fine to also delete if `tsc`/lint flags it as unused, check after this step.

- [ ] **Step 4: Delete `service.ts`'s remaining straight pass-through wrappers**

Distinct from Task 2's 8 branch-site collapses: `service.ts` has separate, non-branching wrapper functions for the "original 8" dead methods (`getTimeline`, `getRevisions`, `getThread`, `listRepliesByPostId`, `getTimelineAfter`, `listRemoteUsers`, `countRemoteSubscriptions`, `getRemoteUserByFeedUrl` — confirmed at plan-writing time these exist as plain one-line forwards, e.g. `getTimeline(limit, before, filter) { return repo.getTimeline(limit, before, filter) }`, and confirmed zero external callers of the `service`-level wrapper too, except `svc.getTimeline`'s 3 test call sites which Task 4 already resolved). Delete all 8 of these wrapper functions from the returned service object.

- [ ] **Step 5: Typecheck**

Run: `docker compose exec -T core npm run -w core typecheck`
Expected: 0 errors. This is the real proof the staging order worked — if this fails, something in Tasks 1-4 missed a caller.

- [ ] **Step 6: Run the full core suite**

Run: `docker compose exec -T core npm run -w core test`
Expected: same test count as Task 4 ended at (this task deletes only unreachable `src` code, no test changes, no test-count change).

- [ ] **Step 7: Confirm `Repository` is down to 26 methods**

```bash
grep -c "^\s*[a-zA-Z]" core/src/domain/repository.ts  # rough sanity count, or read the interface directly
```
Read the interface directly and count — expect 26 (47 minus 21). Cross-check against the spec's survivor list (user identity ×9, `getPost`, follows ×2, account/auth deletion ×2, subscriptions ×5, settings ×2, `close`, `sweepAnonymousUsers`, `getPostsByAuthor`, `countRepliesByPostIds`, `getRecentLocalPosts` = 9+1+2+2+5+2+1+1+1+1+1 = 26).

- [ ] **Step 8: Commit**

```bash
git add core/src/domain/repository.ts core/src/storage/sqlite.ts core/src/domain/service.ts
git commit -m "core: delete the 21 dead Repository methods and their implementations

The interface, its sole implementation (SqliteRepository), and
service.ts's remaining dead pass-through wrappers (the 8 straight
forwards for methods that were never inside an if/else branch) all
drop together in one commit -- interface and implementation must move
in lockstep, and every caller was already cleared by the four prior
tasks in this plan. Repository shrinks from 47 methods to 26.

developed with the help of AI tools"
```

---

## Final verification (after all 5 tasks)

- [ ] `docker compose exec -T core npm run -w core test` — full suite green, report the real final count
- [ ] `docker compose exec -T core npm run -w core typecheck` — 0 errors
- [ ] `grep -rn "insertPost\|getThread(\|adoptOrphans\|recordEdit\|updateUserProfile\|addFollow\|removeFollow\|deletePost(\|countRepliesByPostIds\|countThreadRepliesByRootIds\|getTimeline(\|getTimelineAfter\|getRevisions\|listRepliesByPostId\|listRemoteUsers\|countRemoteSubscriptions\|getRemoteUserByFeedUrl\|hasPostsByAuthor\|backfillItemExtras\|findPostByRef\|updateDisplayNameIfUnset\|getEditableByGuid" core/src core/test` — every remaining hit should be a `LogicalStore`'s own same-named-but-different method (`adoptOrphans`, `updateUserProfile`, `addFollow`, `removeFollow`, `deletePost` all have `LogicalStore` equivalents with these names — that's expected and correct) or a `service.*`/`logical.*` call (the surviving service-layer methods), never a bare `Repository`/`repo.` reference to a deleted method
- [ ] Manual smoke: confirm `follows`/timeline/thread behavior still works end-to-end via the app (post, reply, follow, timeline read) — this plan only touched `Repository`'s dead v1-only surface, so nothing here should change observable behavior, but a real smoke pass is cheap insurance given the scale of this change
