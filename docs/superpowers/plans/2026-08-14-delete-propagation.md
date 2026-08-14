# Delete Propagation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a post is removed on its origin instance, peers that federate with it destroy their copy, while threads continue under the removed post.

**Architecture:** Deletions travel as a separate JSON document (`/deletions.json`), not inside the feed — feedsmith is strictly schema-driven and drops every unknown element, so nothing in a feed can reach our ingest. Consumers fetch it during acquisition, which both WebSub and rssCloud pings already funnel into. Applying a deletion destroys the item's evidence, converts it to a structural tombstone (keeping the row so replies survive), and records the permalink so it can never be resurrected.

**Tech Stack:** Node 22 native type-stripping (no build step), Hono, better-sqlite3, vitest, SvelteKit (Svelte 5 runes).

**Spec:** `docs/superpowers/specs/2026-08-13-delete-propagation-design.md` (rev 3)

## Global Constraints

- **No TypeScript parameter properties** in `core/src` — Node native type-stripping. Constructors assign fields plainly.
- **Hono house style** (`.claude/skills/hono/SKILL.md`): `return c.json({error}, status)` never `HTTPException`; hand-rolled validators never `zValidator`; middleware factories; `app.request()` in tests.
- **Tests run in the container** when the dev stack is up: `docker compose exec core npm test -w core`. Host runs die EACCES.
- **Type-stripping means vitest passes on type errors** — every task ends with `npm run typecheck` as well as tests.
- **Never `git add -A`** — shared checkout, a parallel session commits on `main`. Stage explicit paths.
- **Commit messages end with** `developed with the help of AI tools`.
- **Sanitizer twins**: `core/src/domain/markdown.ts` and `web/src/lib/server/render.ts` must change together or not at all. No task here touches them.

---

## File Structure

**Phase A — local fixes (no wire change)**
- `core/src/logical/projector.ts` — reply-count descent fix
- `core/src/api/logical-routes/shared.ts`, `read.ts` — feed limit from settings
- `core/src/api/app.ts` — `feed_item_limit` in admin settings GET/PATCH
- `web/src/routes/admin/settings/+page.svelte`, `+page.server.ts`, `web/src/lib/api.ts` — the admin field

**Phase B — self-serve deletion**
- `core/src/api/app.ts` — cookie-authed `DELETE /posts/:id`
- `web/src/lib/api.ts` — author vs admin delete routing
- `web/src/routes/+page.svelte`, `web/src/routes/post/[id]/+page.svelte` — ungate

**Phase C — origin emission**
- `core/src/domain/bus.ts`, `core/src/domain/service.ts`, `core/src/server.ts`, `core/src/domain/push.ts` — deletion event and ping
- `core/src/api/logical-routes/read.ts` — `GET /deletions.json`
- `core/src/logical/store.ts` — the marker query
- `Caddyfile`, `cloudron/nginx.conf` — proxy exposure

**Phase D — consumer application**
- `core/src/logical/schema.ts` — `retracted_permalinks_v2`
- `core/src/logical/deletions.ts` *(new)* — fetch, gate, apply
- `core/src/logical/acquisition.ts` — call site and cursor persistence
- `core/src/logical/reconcile.ts` — retraction check before identity resolution

---

## Task 1: Reply counts descend past invisible nodes

**Files:**
- Modify: `core/src/logical/projector.ts:486-505`
- Test: `core/test/logical-projector.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: no signature change. `replyCounts` keeps `(tx, id) => { direct, conversation }`.

**Why:** `replyCounts` runs `if (!nodeVisible(tx, cid)) continue` *before* pushing children, so an invisible node removes its whole subtree from the count. A card can read "0 replies" above a thread showing two. Pre-existing; every propagated deletion will trigger it.

- [ ] **Step 1: Write the failing test**

Add to `core/test/logical-projector.test.ts`. **Use that file's existing
helpers** — `seedSource`, `seedUser`, `seedPost`, `seedSubscription`,
`seedFederation`, `seedFollow` (`:25-49`) — and assert through the **public
projection**: `projectItem` already returns `directReplyCount` and
`conversationReplyCount` (`core/src/logical/projector.ts:719-720`), so
`replyCounts` stays module-private and needs no new export.

The file builds local posts with `seedPost` (including `replyTo`), so the
cheapest fixture for this case is three local posts, with the middle one made
invisible the way a received deletion will make it — a structural tombstone on
its logical row.

```ts
test('reply counts descend past an invisible node to its visible children', () => {
  const { raw, store } = freshFixture()   // use the file's own setup, whatever it names it
  seedUser(raw, 'u1', 'rick')
  seedPost(raw, { id: 'A', author: 'u1' })
  seedPost(raw, { id: 'B', author: 'u1', replyTo: 'A' })
  seedPost(raw, { id: 'C', author: 'u1', replyTo: 'B' })

  // Make B invisible exactly as an applied deletion will: materialize its
  // logical row, then tombstone it and drop the posts row so nodeVisible fails.
  raw.prepare(
    `INSERT INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, created_at)
     VALUES ('B', 'remote', ?, 'resolved', 'A', NULL, NULL, ?)`,
  ).run(NOW, NOW)
  raw.prepare(`UPDATE logical_items_v2 SET structural_tombstone = 1 WHERE id = 'B'`).run()
  raw.prepare(`DELETE FROM posts WHERE id = 'B'`).run()

  const a = store.snapshot((tx) => projectItem(tx, 'A', ANON))
  expect(a?.conversationReplyCount).toBe(1)   // C still counts
  expect(a?.directReplyCount).toBe(0)         // B does not, and C is not direct
})
```

Read the file's first few tests before writing this: match how they obtain
`raw` and a store/tx, and reuse the exact names. Do not invent a fixture
helper — if the file opens its database inline per test, do that.

- [ ] **Step 2: Run the test to verify it fails**

Run: `docker compose exec core npx vitest run test/logical-projector.test.ts -t 'descend past an invisible node'`
Expected: FAIL, `expected 0 to be 1` — C's subtree is pruned today.

- [ ] **Step 3: Make the minimal change**

In `core/src/logical/projector.ts`, inside `replyCounts`'s inner loop, move the
child enqueue above the visibility test so it always runs:

```ts
    for (const cid of level) {
      if (seen.has(cid)) continue
      seen.add(cid)
      // Always descend: an invisible node (tombstoned, admin-hidden, or from a
      // non-allowed source) must not remove its visible descendants from the
      // count — the thread page renders them, so the card must count them.
      for (const gc of childIds(tx, cid)) next.push(gc)
      if (!nodeVisible(tx, cid)) continue
      if (depth === 0) direct++
      conversation++
    }
```

`COUNT_NODE_BOUND` (`:483`) still bounds the walk — that is deliberate, see step 5.

- [ ] **Step 4: Run tests**

Run: `docker compose exec core npx vitest run test/logical-projector.test.ts`
Expected: PASS, and every existing test in the file still passes.

- [ ] **Step 5: Add the two consequence tests**

The change deliberately alters counts for admin-hidden and blocked-source
parents too, and lets a large invisible subtree consume the node budget.

```ts
test('replies under an admin-hidden parent now count toward the visible ancestor', () => {
  const { raw, tx } = freshDb()
  seedItem(raw, 'A'); seedItem(raw, 'B', 'A'); seedItem(raw, 'C', 'B')
  raw.prepare(`UPDATE logical_items_v2 SET hidden_at = '2026-08-14T00:00:00.000Z' WHERE id = 'B'`).run()
  seedVisibleDelivery(raw, 'C')
  expect(replyCountsForTest(tx, 'A').conversation).toBe(1)
})

test('the node bound still caps the walk when the invisible subtree is large', () => {
  const { raw, tx } = freshDb()
  seedItem(raw, 'A')
  let parent = 'A'
  for (let i = 0; i < 6000; i++) { seedItem(raw, `n${i}`, parent); parent = `n${i}` }
  // No delivery seeded: every node is invisible. The walk must terminate.
  const counts = replyCountsForTest(tx, 'A')
  expect(counts.conversation).toBe(0)
})
```

- [ ] **Step 6: Run the full core suite and typecheck**

Run: `docker compose exec core npm test -w core && docker compose exec core npm run typecheck -w core`
Expected: all pass. If any existing test asserted the old pruning behaviour, it
encoded the bug — update it and note that in the commit message.

- [ ] **Step 7: Commit**

```bash
git add core/src/logical/projector.ts core/test/logical-projector.test.ts
git commit -m "fix(counts): descend past invisible nodes in replyCounts

An invisible node removed its whole subtree from the reply count, so a
timeline card could read 0 replies above a thread rendering two. Visible
descendants of a tombstoned, hidden, or blocked-source parent now count.

developed with the help of AI tools"
```

---

## Task 2: `feed_item_limit` — core setting and async feed handlers

**Files:**
- Modify: `core/src/api/logical-routes/read.ts:141,163,173`
- Modify: `core/src/api/app.ts:576-610` (settings GET and PATCH)
- Test: `core/test/logical-read.test.ts` (or the file that already covers the feed routes — find it with `grep -rln "users/rss.xml" core/test`)

**Interfaces:**
- Consumes: nothing.
- Produces: setting key `feed_item_limit`, default `50`. Admin API field name `feedItemLimit` (number, integer, ≥ 1).

**Why:** `FEED_LIMIT = 50` is hardcoded. It must be operator-tunable. It governs **feed rendering only** — `clampLimit` is API pagination with its own hard cap of 100 and is deliberately untouched.

- [ ] **Step 1: Write the failing test**

```ts
test('the firehose honours feed_item_limit', async () => {
  const { app, service } = await makeApp()      // the file's existing helper
  await service.setSetting('feed_item_limit', '2')
  // seed 3 local posts via the same helper the file's other feed tests use
  await seedLocalPosts(3)
  const res = await app.request('/users/rss.xml')
  const xml = await res.text()
  expect(xml.match(/<item>/g)?.length).toBe(2)
})
```

- [ ] **Step 2: Run it and verify failure**

Run: `docker compose exec core npx vitest run test/logical-read.test.ts -t 'honours feed_item_limit'`
Expected: FAIL — 3 items, the setting is ignored.

- [ ] **Step 3: Read the setting in the three feed handlers**

`/users/rss.xml` (`read.ts:141`) is currently **synchronous** and must become
`async`. `service` is already on `LogicalReadDeps` (`read.ts:18-24`), so no new
dependency is needed.

```ts
  async function feedLimit(): Promise<number> {
    const n = Number(await service.getSetting('feed_item_limit') ?? '50')
    return Number.isInteger(n) && n >= 1 ? n : 50
  }

  app.get('/users/rss.xml', async (c) => {
    const limit = await feedLimit()
    const items = store.snapshot((tx) => tx.projectLocalActivity({ authorId: null, limit }))
    // ...unchanged below
  })
```

Apply the same `await feedLimit()` in the two per-user feed handlers
(`read.ts:163,173`), which are already `async`.

- [ ] **Step 4: Run the test**

Run: `docker compose exec core npx vitest run test/logical-read.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the setting to the admin API**

In `core/src/api/app.ts`, extend the GET at `:576`:

```ts
      feedItemLimit: Number(await service.getSetting('feed_item_limit') ?? '50'),
```

and the PATCH at `:585` — destructure `feedItemLimit`, validate, persist:

```ts
    // feedItemLimit: how many items each RSS/JSON feed renders. Minimum 1 --
    // unlike the settings above, 0 has no useful meaning for a feed.
    if (!(typeof feedItemLimit === 'number' && Number.isInteger(feedItemLimit) && feedItemLimit >= 1)) {
      return c.json({ error: 'feedItemLimit invalid' }, 400)
    }
```
```ts
    await service.setSetting('feed_item_limit', String(feedItemLimit))
```
and add `feedItemLimit` to the 200 response body alongside the existing three.

- [ ] **Step 6: Test the admin round-trip**

```ts
test('admin settings round-trip feedItemLimit', async () => {
  const { app } = await makeApp()
  const patch = await app.request('/admin/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...adminAuth },
    body: JSON.stringify({ maxSubsPerUser: 500, maxRemoteItemsPerSource: 0, maxRemoteItemAgeDays: 0, feedItemLimit: 25 }),
  })
  expect(patch.status).toBe(200)
  const get = await app.request('/admin/settings', { headers: adminAuth })
  expect((await get.json()).feedItemLimit).toBe(25)
})

test('admin settings reject feedItemLimit below 1', async () => {
  const { app } = await makeApp()
  const res = await app.request('/admin/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...adminAuth },
    body: JSON.stringify({ maxSubsPerUser: 500, maxRemoteItemsPerSource: 0, maxRemoteItemAgeDays: 0, feedItemLimit: 0 }),
  })
  expect(res.status).toBe(400)
})
```

- [ ] **Step 7: Full suite, typecheck, commit**

```bash
docker compose exec core npm test -w core && docker compose exec core npm run typecheck -w core
git add core/src/api/logical-routes/read.ts core/src/api/app.ts core/test/logical-read.test.ts
git commit -m "feat(feeds): make the feed item limit an admin setting

FEED_LIMIT was hardcoded at 50. feed_item_limit now governs feed
rendering only; clampLimit stays API pagination with its own cap.

developed with the help of AI tools"
```

---

## Task 3: `feed_item_limit` in the admin UI

**Files:**
- Modify: `web/src/lib/api.ts` (the `AdminSettings` type and `patchAdminSettings` payload)
- Modify: `web/src/routes/admin/settings/+page.server.ts:34-40`
- Modify: `web/src/routes/admin/settings/+page.svelte:21-33`
- Test: `web/src/routes/admin-settings.actions.test.ts`

**Interfaces:**
- Consumes: Task 2's `feedItemLimit` field on `GET`/`PATCH /admin/settings`.
- Produces: form field `name="feedItemLimit"`.

**REQUIRED SKILL:** invoke `ui-ux-pro-max:ui-ux-pro-max` before editing the
Svelte file, and follow `design-system/rsc/MASTER.md`. This is a new form field
in an existing fieldset — match the three fields above it exactly; no new colours,
no raw hex.

- [ ] **Step 1: Write the failing action test**

```ts
test('save action forwards feedItemLimit', async () => {
  const form = new FormData()
  form.set('maxSubsPerUser', '500')
  form.set('maxRemoteItemsPerSource', '0')
  form.set('maxRemoteItemAgeDays', '0')
  form.set('feedItemLimit', '25')
  const patched: Record<string, unknown>[] = []
  // stub patchAdminSettings the way the file's existing tests stub api.ts
  await actions.save(makeEvent(form))
  expect(patched[0].feedItemLimit).toBe(25)
})

test('save action rejects a feedItemLimit below 1', async () => {
  const form = new FormData()
  form.set('maxSubsPerUser', '500'); form.set('maxRemoteItemsPerSource', '0')
  form.set('maxRemoteItemAgeDays', '0'); form.set('feedItemLimit', '0')
  const result = await actions.save(makeEvent(form))
  expect(result.status).toBe(400)
})
```

- [ ] **Step 2: Run and verify failure**

Run: `docker compose exec web npx vitest run src/routes/admin-settings.actions.test.ts`
Expected: FAIL — the field is not forwarded.

- [ ] **Step 3: Parse and forward it**

`parseNonNegativeInt` allows 0, which is invalid here. Add a minimum-1 parse
beside it in `+page.server.ts`:

```ts
function parsePositiveInt(raw: FormDataEntryValue | null, field: string): number {
	const value = Number(String(raw ?? '').trim())
	if (!Number.isInteger(value) || value < 1) throw new Error(`${field} must be an integer ≥ 1`)
	return value
}
```

Parse `feedItemLimit` inside the existing `try` alongside the other three, and
add it to the `patchAdminSettings` payload.

- [ ] **Step 4: Add the field to the page**

In `+page.svelte`, after the "Max remote item age (days)" field, matching that
block exactly:

```svelte
	<label for="feed-item-limit">Items per feed</label>
	<input id="feed-item-limit" name="feedItemLimit" type="number" min="1" required value={data.settings.feedItemLimit} />
```

- [ ] **Step 5: Run web tests and typecheck**

Run: `docker compose exec web npm test -w web && docker compose exec web npm run check -w web`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/api.ts web/src/routes/admin/settings/+page.server.ts web/src/routes/admin/settings/+page.svelte web/src/routes/admin-settings.actions.test.ts
git commit -m "feat(admin): expose feed item limit on the settings page

developed with the help of AI tools"
```

---

## Task 4: Cookie-authed `DELETE /posts/:id`

**Files:**
- Modify: `core/src/api/app.ts` (immediately after the `PATCH /posts/:id` block at `:286-299`)
- Test: `core/test/service.test.ts` or the file covering `POST /posts` — find with `grep -rln "app.request('/posts'" core/test`

**Interfaces:**
- Consumes: `service.deletePost(id)` → `{ ok: true } | { error: 'unknown' | 'remote' }` (`domain/service.ts:147-153`).
- Produces: `DELETE /posts/:id` → `200 {ok:true}` | `403 {error:'not deletable'}` | `404 {error:'unknown post'}`.

**Why:** ordinary users cannot delete their own posts. `DELETE /me/posts/:id`
enforces the right rule but is API-key-only with no web caller. `personal.ts:97`
documents the house pattern: cookie-authed route in `app.ts`, key-authed twin in
`personal.ts`. This adds the missing cookie-authed twin.

- [ ] **Step 1: Write the failing tests**

```ts
test('an author deletes their own post', async () => {
  const { app, authorAuth, postId } = await seedLocalPost()
  const res = await app.request(`/posts/${postId}`, { method: 'DELETE', headers: authorAuth })
  expect(res.status).toBe(200)
})

test('a non-author cannot delete someone else post', async () => {
  const { app, otherAuth, postId } = await seedLocalPost()
  const res = await app.request(`/posts/${postId}`, { method: 'DELETE', headers: otherAuth })
  expect(res.status).toBe(403)
})

test('deleting an unknown post is 404', async () => {
  const { app, authorAuth } = await seedLocalPost()
  const res = await app.request('/posts/does-not-exist', { method: 'DELETE', headers: authorAuth })
  expect(res.status).toBe(404)
})
```

- [ ] **Step 2: Run and verify failure**

Run: `docker compose exec core npx vitest run test/service.test.ts -t 'deletes their own post'`
Expected: FAIL — 404 from Hono, the route does not exist.

- [ ] **Step 3: Add the route**

Directly below `PATCH /posts/:id` in `core/src/api/app.ts`, mirroring its shape
and its ownership check:

```ts
  // Cookie-authed twin of personal.ts's key-authed DELETE /me/posts/:id, same
  // ownership rule. Admins remove OTHERS' posts via DELETE /admin/posts/:id;
  // this route is only ever the author acting on their own post.
  app.delete('/posts/:id', authed, async (c) => {
    const me = c.get('coreUser')
    const post = await service.getPost(c.req.param('id'))
    if (!post) return c.json({ error: 'unknown post' }, 404)
    if (post.source !== 'local' || post.authorId !== me.id) return c.json({ error: 'not deletable' }, 403)
    const result = await service.deletePost(post.id)
    if ('error' in result) return c.json({ error: result.error === 'unknown' ? 'unknown post' : 'not a local post' }, result.error === 'unknown' ? 404 : 409)
    return c.json({ ok: true }, 200)
  })
```

- [ ] **Step 4: Run tests, full suite, typecheck**

Run: `docker compose exec core npm test -w core && docker compose exec core npm run typecheck -w core`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/api/app.ts core/test/service.test.ts
git commit -m "feat(posts): cookie-authed DELETE /posts/:id for the author

Ordinary users could not delete their own posts: the self-serve route
was API-key-only with no web caller. Same ownership rule, added as the
cookie-authed twin per the app.ts/personal.ts pattern.

developed with the help of AI tools"
```

---

## Task 5: Route the web delete by role, and ungate the UI

**Files:**
- Modify: `web/src/lib/api.ts:151-154`
- Modify: `web/src/routes/+page.svelte:231`
- Modify: `web/src/routes/post/[id]/+page.svelte:104`
- Test: `web/src/routes/page.actions.test.ts`

**Interfaces:**
- Consumes: Task 4's `DELETE /posts/:id`; existing `DELETE /admin/posts/:id`.
- Produces: `deletePost(f, id, opts: { asAdmin: boolean })`.

**Why:** `deletePost` posts to `/admin/posts/:id` unconditionally, so ungating
the buttons alone would leave an author's Remove button 403ing.

**REQUIRED SKILL:** invoke `ui-ux-pro-max:ui-ux-pro-max` before the Svelte edits.
These are condition changes only — no markup, copy, or style changes.

- [ ] **Step 1: Write the failing test**

```ts
test('an author delete hits the self-serve route', async () => {
  const calls: string[] = []
  const f = ((url: string) => { calls.push(url); return new Response('{}', { status: 200 }) }) as unknown as typeof fetch
  await deletePost(f, 'abc', { asAdmin: false })
  expect(calls[0]).toContain('/posts/abc')
  expect(calls[0]).not.toContain('/admin/')
})

test('an admin delete hits the admin route', async () => {
  const calls: string[] = []
  const f = ((url: string) => { calls.push(url); return new Response('{}', { status: 200 }) }) as unknown as typeof fetch
  await deletePost(f, 'abc', { asAdmin: true })
  expect(calls[0]).toContain('/admin/posts/abc')
})
```

- [ ] **Step 2: Run and verify failure**

Run: `docker compose exec web npx vitest run src/routes/page.actions.test.ts -t 'self-serve route'`
Expected: FAIL — the signature takes no options.

- [ ] **Step 3: Branch the helper**

```ts
export async function deletePost(f: typeof fetch, id: string, opts: { asAdmin: boolean }): Promise<void> {
	const path = opts.asAdmin ? `/admin/posts/${encodeURIComponent(id)}` : `/posts/${encodeURIComponent(id)}`
	const res = await f(`${base()}${path}`, { method: 'DELETE' })
	if (!res.ok) throw new Error(await errorMessage(res, 'deletePost failed'))
}
```

- [ ] **Step 4: Pass the flag from both actions**

In `web/src/routes/+page.server.ts` and `web/src/routes/post/[id]/+page.server.ts`,
each `deletePost` action already loads the viewer. Pass
`{ asAdmin: <viewer is admin> && <post is not theirs> }` — read how each file
obtains the viewer and the post's author, and use the values already in scope.
An admin deleting their **own** post takes the self-serve path.

- [ ] **Step 5: Ungate both buttons**

`web/src/routes/+page.svelte:231`:

```svelte
						{#if (data.me?.isAdmin || post.author?.id === data.me?.id) && post.source === 'local'}
```

`web/src/routes/post/[id]/+page.svelte:104`: the same condition against `root`.
Confirm the viewer-id and author-id property names in each file before writing —
do not assume `data.me.id` exists with that name.

- [ ] **Step 6: Web tests, check, commit**

```bash
docker compose exec web npm test -w web && docker compose exec web npm run check -w web
git add web/src/lib/api.ts web/src/routes/+page.svelte web/src/routes/+page.server.ts web/src/routes/post/[id]/+page.svelte web/src/routes/post/[id]/+page.server.ts web/src/routes/page.actions.test.ts
git commit -m "feat(web): let authors delete their own posts

Both surfaces were admin-gated and the helper posted to the admin route
unconditionally. Authors now route to the self-serve endpoint; admins
keep the admin route for others' posts.

developed with the help of AI tools"
```

**STOP AND DEPLOY.** Tasks 1-5 are rollout steps 1-2: local, no wire change.
Ship to all five instances and confirm before continuing.

---

## Task 6: A deletion event on the bus

**Files:**
- Modify: `core/src/domain/bus.ts:5-35`
- Modify: `core/src/domain/service.ts:147-153` and `:137-146`
- Test: `core/test/service.test.ts`

**Interfaces:**
- Produces: `EventBus.emitPostDeleted(e: { handle: string })` / `onPostDeleted(fn)`.

**Why:** deletion publishes no signal at all — `hint()` fires only from the
acquisition drains and `emitNewPost` only on create/edit. The bus lives at the
**service** layer; `logical/local.ts` is tx-level and has no bus, and emitting
inside the transaction would announce a deletion a rollback could undo. The
handle must be captured **before** the delete, because account deletion removes
the `users` row.

- [ ] **Step 1: Write the failing test**

```ts
test('deleting a post emits a post-deleted event carrying the handle', async () => {
  const { service, bus, post, author } = await seedLocalPost()
  const seen: { handle: string }[] = []
  bus.onPostDeleted((e) => seen.push(e))
  await service.deletePost(post.id)
  expect(seen).toEqual([{ handle: author.handle }])
})

test('deleting an account emits exactly one post-deleted event', async () => {
  const { service, bus, author } = await seedAccountWithPosts(3)
  const seen: { handle: string }[] = []
  bus.onPostDeleted((e) => seen.push(e))
  await service.deleteLocalAccount(author.handle)
  expect(seen).toHaveLength(1)
})
```

- [ ] **Step 2: Run and verify failure**

Run: `docker compose exec core npx vitest run test/service.test.ts -t 'post-deleted'`
Expected: FAIL — `bus.onPostDeleted is not a function`.

- [ ] **Step 3: Add the event**

In `core/src/domain/bus.ts`, alongside the existing two:

```ts
  // Deletion carries no TimelineEntry -- the post is gone and, for an account
  // deletion, so is the users row. The handle is captured BEFORE the delete so
  // push can resolve the per-author topic.
  emitPostDeleted(e: { handle: string }): void
  onPostDeleted(fn: (e: { handle: string }) => void): () => void
```
```ts
    emitPostDeleted(e) { emitter.emit('post-deleted', e) },
    onPostDeleted(fn) {
      emitter.on('post-deleted', fn)
      return () => emitter.off('post-deleted', fn)
    },
```

- [ ] **Step 4: Emit from the service, after the write**

In `service.deletePost`, capture the handle before deleting and emit after:

```ts
    async deletePost(id: string): Promise<{ ok: true } | { error: 'unknown' | 'remote' }> {
      const post = await repo.getPost(id)
      if (!post) return { error: 'unknown' }
      if (post.source !== 'local') return { error: 'remote' }
      const author = await repo.getUserById(post.authorId)
      logical.deleteLocalPost({ postId: id, actorId: post.authorId, now: new Date().toISOString() })
      if (author) bus.emitPostDeleted({ handle: author.handle })
      return { ok: true }
    },
```

Verify `repo.getUserById` exists with that name before using it — if the
repository exposes a different lookup, use that one. In
`service.deleteLocalAccount`, the handle is already the argument: emit once,
after `deleteAuthRows`.

- [ ] **Step 5: Tests, typecheck, commit**

```bash
docker compose exec core npm test -w core && docker compose exec core npm run typecheck -w core
git add core/src/domain/bus.ts core/src/domain/service.ts core/test/service.test.ts
git commit -m "feat(bus): add a post-deleted event

Deletion published no signal. Emitted at the service layer after the
write commits, carrying the handle captured before the delete.

developed with the help of AI tools"
```

---

## Task 7: `GET /deletions.json`

**Files:**
- Modify: `core/src/api/logical-routes/read.ts`
- Modify: `core/src/logical/store.ts` (the marker query)
- Modify: `core/src/logical/schema.ts` (index)
- Test: `core/test/logical-read.test.ts`

**Interfaces:**
- Produces: `GET /deletions.json?cursor=<opaque>` →
  `{ deletions: Array<{ ref: string; deletedAt: string }>, nextCursor: string | null, hasMore: boolean }`.
- Uses the existing opaque tuple codec `encodeCursor`/`decodeCursor`
  (`core/src/domain/source-repository.ts:188-196`). Do **not** write a second codec.

**Why and constraints:**
- **Ascending** by `(deleted_at, logical_item_id)` — consumers drain forward.
  Every other cursor here pages DESC; this one does not.
- Account deletion writes N markers sharing one `deleted_at`
  (`logical/local.ts:234-236`), so the cursor must be the tuple, never the
  timestamp alone.
- Serve only this instance's own **absolute** permalinks: markers store
  `cur.url ?? '/post/<id>'` (`local.ts:33,207`), so historical rows can be
  relative or carry a previous domain. Filter to `publicUrl`.
- `ref` must be normalized the same way identity keys are
  (`normalizePermalink`, `core/src/logical/roots.ts:34-44`), or the consumer's
  lookup silently misses.
- **Gated to approved federated peers** — unauthenticated it is a permanent
  public list of every permalink the instance ever deleted, including every post
  of anyone who used delete-my-account.

- [ ] **Step 1: Write the failing tests**

```ts
test('deletions page ascending and drain across a shared timestamp', async () => {
  const { app, peerAuth } = await makeAppWithApprovedPeer()
  await seedMarkers(5, { deletedAt: '2026-08-14T00:00:00.000Z' })  // all identical
  const first = await app.request('/deletions.json', { headers: peerAuth })
  const a = await first.json()
  expect(a.deletions.length).toBeGreaterThan(0)
  expect(a.hasMore).toBe(true)
  const second = await app.request(`/deletions.json?cursor=${encodeURIComponent(a.nextCursor)}`, { headers: peerAuth })
  const b = await second.json()
  const refs = [...a.deletions, ...b.deletions].map((d) => d.ref)
  expect(new Set(refs).size).toBe(5)   // nothing skipped, nothing repeated
})

test('deletions omit relative and foreign-host permalinks', async () => {
  const { app, peerAuth } = await makeAppWithApprovedPeer()
  await seedMarkerRaw('/post/legacy', '2026-08-14T00:00:00.000Z')
  await seedMarkerRaw('https://old-domain.example/post/x', '2026-08-14T00:00:01.000Z')
  const res = await app.request('/deletions.json', { headers: peerAuth })
  expect((await res.json()).deletions).toEqual([])
})

test('deletions.json is refused without an approved federation relationship', async () => {
  const { app } = await makeApp()
  const res = await app.request('/deletions.json')
  expect(res.status).toBe(403)
})
```

- [ ] **Step 2: Run and verify failure**

Run: `docker compose exec core npx vitest run test/logical-read.test.ts -t 'deletions'`
Expected: FAIL — route missing.

- [ ] **Step 3: Add the index**

In `core/src/logical/schema.ts`, as a new migration step (follow how the file's
most recent migration array is appended — do not edit an already-shipped array):

```sql
CREATE INDEX IF NOT EXISTS logical_deleted_local_v2_paging
  ON logical_deleted_local_v2 (deleted_at, logical_item_id)
```

- [ ] **Step 4: Add the store query**

In `core/src/logical/store.ts`, beside the other read methods:

```ts
    // Ascending -- consumers drain forward. Tuple comparison, never deleted_at
    // alone: an account deletion writes every marker with one timestamp.
    listDeletionsAfter(cursor: { deletedAt: string; id: string } | null, limit: number, publicUrlPrefix: string) {
      return db.read((tx) => tx.prepare(
        `SELECT logical_item_id AS id, canonical_permalink AS ref, deleted_at AS deletedAt
         FROM logical_deleted_local_v2
         WHERE canonical_permalink LIKE ? || '/post/%'
           AND (? IS NULL OR (deleted_at, logical_item_id) > (?, ?))
         ORDER BY deleted_at ASC, logical_item_id ASC
         LIMIT ?`,
      ).all(publicUrlPrefix, cursor?.deletedAt ?? null, cursor?.deletedAt ?? null, cursor?.id ?? null, limit + 1))
    },
```

SQLite supports row-value comparison from 3.15. Verify the bundled
better-sqlite3's SQLite version at the REPL before relying on it
(`docker compose exec core node -e "console.log(require('better-sqlite3')(':memory:').prepare('select sqlite_version() v').get())"`);
if it is older, expand to
`(deleted_at > ?) OR (deleted_at = ? AND logical_item_id > ?)`.

- [ ] **Step 5: Add the route**

In `read.ts`, beside the feed routes. Fetch `limit + 1` to compute `hasMore`.
Gate on an approved federation relationship — read how `membership.ts`'s
`approvedInstanceFor` resolves a caller and follow it; if the caller cannot be
resolved to an approved peer, `return c.json({ error: 'not found' }, 403)`.
Normalize each `ref` with `normalizePermalink` before returning it.

- [ ] **Step 6: Tests, typecheck, commit**

```bash
docker compose exec core npm test -w core && docker compose exec core npm run typecheck -w core
git add core/src/api/logical-routes/read.ts core/src/logical/store.ts core/src/logical/schema.ts core/test/logical-read.test.ts
git commit -m "feat(deletions): serve GET /deletions.json to approved peers

Ascending tuple-cursor paging over the permanent deletion markers,
filtered to this instance's own absolute permalinks. Gated: unauthed it
would be a permanent public list of everything ever deleted here.

developed with the help of AI tools"
```

---

## Task 8: Expose `/deletions.json` through both proxies

**Files:**
- Modify: `Caddyfile:23-31`
- Modify: `cloudron/nginx.conf:30-38`

**Why:** only feeds and federation callbacks reach core directly. Without both,
peers cannot reach the endpoint — and the failure appears **only in production**.

- [ ] **Step 1: Add to the Caddy matcher**

In the `@core` block, beside `path /users/rss.xml`:

```
		path /deletions.json
```

- [ ] **Step 2: Add the nginx location**

Beside the `/users/rss.xml` location:

```
        location = /deletions.json { proxy_pass http://127.0.0.1:8787; include /app/pkg/proxy_params; }
```

- [ ] **Step 3: Verify locally**

Run: `docker compose up -d && curl -s -o /dev/null -w '%{http_code}\n' http://localhost/deletions.json`
Expected: `403` (reached core and was refused for lack of an approved peer), **not** 404 from the web app.

- [ ] **Step 4: Commit**

```bash
git add Caddyfile cloudron/nginx.conf
git commit -m "chore(proxy): route /deletions.json directly to core

developed with the help of AI tools"
```

---

## Task 9: Ping peers when a post is deleted

**Files:**
- Modify: `core/src/domain/push.ts`
- Modify: `core/src/server.ts:106-110`
- Test: `core/test/push.test.ts`

**Interfaces:**
- Consumes: Task 6's `bus.onPostDeleted({ handle })`.
- Produces: `push.onPostDeleted(e: { handle: string }): Promise<void>` — same
  never-rejects contract as `onLocalPost` (`push.ts:195-199`: it runs inside a
  synchronous EventEmitter dispatch; an escape is process-fatal).

**Why:** `onLocalPost` needs a `TimelineEntry` and regenerates a per-author body
from `getPostsByAuthor` — neither is available for a deletion. Ping the affected
per-author topic **and** the firehose: peers subscribe to per-user feeds too.

- [ ] **Step 1: Write the failing test**

```ts
test('a deletion pings the author topic and the firehose, and never rejects', async () => {
  const pinged: string[] = []
  const push = createPush({ ...deps, fetchFn: fakeFetch(pinged) })
  await expect(push.onPostDeleted({ handle: 'rick' })).resolves.toBeUndefined()
  expect(pinged.some((u) => u.includes('/users/rick/feed.xml'))).toBe(true)
  expect(pinged.some((u) => u.includes('/users/rss.xml'))).toBe(true)
})

test('onPostDeleted swallows a hub failure', async () => {
  const push = createPush({ ...deps, fetchFn: () => Promise.reject(new Error('hub down')) })
  await expect(push.onPostDeleted({ handle: 'rick' })).resolves.toBeUndefined()
})
```

- [ ] **Step 2: Run and verify failure**

Run: `docker compose exec core npx vitest run test/push.test.ts -t 'deletion pings'`
Expected: FAIL — `push.onPostDeleted is not a function`.

- [ ] **Step 3: Implement**

Add `onPostDeleted` to the `Push` interface and `createPush`'s return, wrapping
everything in the same `try { … } catch (err) { console.error(…) }` as
`onLocalPost`. Bail early on `!config.publicUrl` exactly as `onLocalPost` does at
`push.ts:203`. Ping `feedUrls(config.publicUrl, handle).xml` and
`firehoseUrl(config.publicUrl)`:
- `websub.mode === 'external'` → `publishPing(hubUrl, topic, fetchFn)` per topic.
- `websub.mode === 'self'` → deliver to that topic's active subscribers. The
  per-author fat body cannot be regenerated for a deleted account, so send the
  **thin** notification for both topics; read how the rssCloud thin ping is sent
  at `push.ts:277-283` and follow it.
- `config.rssCloud` → the same thin ping for both topics.

- [ ] **Step 4: Wire the subscription**

`core/src/server.ts`, beside line 110:

```ts
bus.onPostDeleted((e) => { void push.onPostDeleted(e) })
```

- [ ] **Step 5: Tests, typecheck, commit**

```bash
docker compose exec core npm test -w core && docker compose exec core npm run typecheck -w core
git add core/src/domain/push.ts core/src/server.ts core/test/push.test.ts
git commit -m "feat(push): notify peers on deletion

Pings the affected per-author topic and the firehose. Thin only: a
deletion has no TimelineEntry, and for an account deletion the users row
is already gone.

developed with the help of AI tools"
```

**STOP AND DEPLOY.** Tasks 6-9 are rollout step 3: origin side, **rsc.rmdes.be only**.
Confirm alice and bob keep ingesting unchanged before continuing. Golden-file
check: feed bytes must be identical — nothing in this milestone changes a feed
document.

---

## Task 10: `retracted_permalinks_v2`

**Files:**
- Modify: `core/src/logical/schema.ts`
- Modify: `core/src/logical/reconcile.ts:216-227` (`localPermalinkOwner`'s neighbourhood)
- Test: `core/test/logical-reconcile.test.ts`

**Interfaces:**
- Produces: table `retracted_permalinks_v2 (permalink TEXT PRIMARY KEY, source_url TEXT NOT NULL, retracted_at TEXT NOT NULL)`.
- Produces: `isRetracted(tx, permalink): boolean`.

**Why:** `convertToStructuralTombstone` strips identity keys, and
`reconcile.ts:388` states the consequence verbatim — *"a tombstone's identity
keys are stripped, so convergence creates a fresh item"*. Deleting the delivery
row does not change that; only a permanent record does. The origin has the same
guard for itself (`logical_deleted_local_v2`, checked before identity lookup).

**`source_url` is plain text with NO foreign key.** Every FK here defaults to
RESTRICT, and `PURGE_INVENTORY` (`logical/tombstones.ts:50-64`) must name every
blocking child of a purge root — a new RESTRICT child would break purge and
orphan reap; adding it to the inventory would drop retraction protection exactly
when a source can be re-added.

- [ ] **Step 1: Write the failing test**

```ts
test('a retracted permalink is never re-owned by a new delivery', () => {
  const { raw, tx } = freshDb()
  raw.prepare(`INSERT INTO retracted_permalinks_v2 (permalink, source_url, retracted_at)
               VALUES ('https://rsc.example/post/a', 'https://rsc.example/users/rss.xml', '2026-08-14T00:00:00.000Z')`).run()
  expect(isRetracted(tx, 'https://rsc.example/post/a')).toBe(true)
  expect(isRetracted(tx, 'https://rsc.example/post/b')).toBe(false)
})
```

- [ ] **Step 2: Run and verify failure**

Run: `docker compose exec core npx vitest run test/logical-reconcile.test.ts -t 'retracted permalink'`
Expected: FAIL — no such table.

- [ ] **Step 3: Add the table and the predicate**

New migration step in `schema.ts` (append; never edit a shipped array):

```sql
CREATE TABLE retracted_permalinks_v2 (
  permalink TEXT PRIMARY KEY,
  source_url TEXT NOT NULL,
  retracted_at TEXT NOT NULL
)
```

In `reconcile.ts`, beside `localPermalinkOwner`:

```ts
// A permalink an approved peer has retracted. Checked BEFORE identity
// resolution so a later delivery can never mint a fresh item for it -- the
// consumer-side equivalent of logical_deleted_local_v2 on the origin.
// No FK to the source on purpose: a RESTRICT child would block purge/reap.
export function isRetracted(tx: ReadTx, permalink: string): boolean {
  return tx.prepare(`SELECT 1 FROM retracted_permalinks_v2 WHERE permalink = ?`).get(permalink) !== undefined
}
```

- [ ] **Step 4: Consult it before identity resolution**

In the reconcile path, before the permalink/opaque lookups that would mint a new
item, return early when `isRetracted(tx, normalizePermalink(normalized.permalink))`.
Read the surrounding function first and place the check where
`localPermalinkOwner` is already consulted, so both guards sit together.

- [ ] **Step 5: Add the resurrection regression test**

```ts
test('a delivery arriving after retraction mints nothing', () => {
  // seed a retracted permalink, then run the reconcile path with an
  // observation carrying that permalink; assert logical_items_v2 count unchanged
})
```

- [ ] **Step 6: Full suite (purge tests included), typecheck, commit**

Run: `docker compose exec core npm test -w core && docker compose exec core npm run typecheck -w core`
Expected: PASS — in particular `logical-purge.test.ts`, which walks
`PURGE_INVENTORY`. If it fails, the new table gained an FK it must not have.

```bash
git add core/src/logical/schema.ts core/src/logical/reconcile.ts core/test/logical-reconcile.test.ts
git commit -m "feat(deletions): record retracted permalinks

Tombstoning strips identity keys, so without a permanent record a later
delivery mints a fresh item with full content. No FK to the source: a
RESTRICT child would block purge and orphan reap.

developed with the help of AI tools"
```

---

## Task 11: Fetch and gate a peer's deletions

**Files:**
- Create: `core/src/logical/deletions.ts`
- Test: `core/test/logical-deletions.test.ts`

**Interfaces:**
- Produces: `fetchDeletions(deps, source, cursor): Promise<{ entries: Array<{ref,deletedAt}>, nextCursor: string | null } | { error: string }>`
- Produces: `gateDeletion(tx, source, ref): 'accept' | 'reject-permanent' | 'reject-retryable'`

**Constraints:**
- Derive the URL from the source's own scheme and host.
- Compare host with `new URL` on both sides, **not** `startsWith` on a
  scheme-bearing prefix: `canonical_url` is never rewritten on a permanent
  redirect (`acquisition.ts:876-881`), so a peer registered as `http://` keeps
  that scheme forever and prefix comparison rejects every deletion.
- Reuse origin verification's gated-fetch pattern: `isPrivateIp` from
  `domain/push-guard.ts`, an injected `lookupFn`, `AbortSignal.timeout`
  (`logical/verification.ts:3,46,166-173`). Do not write new SSRF logic.
- Cap the response size. That bounds `JSON.parse` and therefore the entry count.

- [ ] **Step 1: Write the failing gate tests**

```ts
test('accepts a ref on the source host', () => {
  expect(gateDeletion(tx, approvedSource('https://peer.example/users/rss.xml'), 'https://peer.example/post/a')).toBe('accept')
})

test('accepts across an http/https mismatch on the same host', () => {
  // canonical_url is never rewritten on a permanent redirect
  expect(gateDeletion(tx, approvedSource('http://peer.example/users/rss.xml'), 'https://peer.example/post/a')).toBe('accept')
})

test('rejects a ref on a different host, permanently', () => {
  expect(gateDeletion(tx, approvedSource('https://peer.example/users/rss.xml'), 'https://evil.example/post/a')).toBe('reject-permanent')
})

test('rejects a lookalike host, permanently', () => {
  expect(gateDeletion(tx, approvedSource('https://peer.example/users/rss.xml'), 'https://peer.example.evil.com/post/a')).toBe('reject-permanent')
})

test('holds when the federation relationship is not yet approved', () => {
  expect(gateDeletion(tx, pendingSource('https://peer.example/users/rss.xml'), 'https://peer.example/post/a')).toBe('reject-retryable')
})
```

- [ ] **Step 2: Run and verify failure**

Run: `docker compose exec core npx vitest run test/logical-deletions.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the gate**

```ts
// Host equality, not prefix matching: remote_sources_v2.canonical_url is never
// rewritten on a permanent redirect, so a peer registered once as http:// keeps
// that scheme forever and a scheme-bearing prefix would reject everything.
// Host-level IS the retraction granularity -- any approved peer on a host may
// retract any permalink on it. Acceptable while peers are one instance per host.
export function gateDeletion(tx: ReadTx, source: SourceRow, ref: string): GateOutcome {
  if (!isApprovedFederation(tx, source.id)) return 'reject-retryable'
  let a: URL, b: URL
  try { a = new URL(ref); b = new URL(source.canonical_url) } catch { return 'reject-permanent' }
  if (a.protocol !== 'http:' && a.protocol !== 'https:') return 'reject-permanent'
  return a.host === b.host ? 'accept' : 'reject-permanent'
}
```

- [ ] **Step 4: Implement the fetch**

Derive `new URL('/deletions.json', source.canonical_url)`, append the cursor,
and fetch through the verification module's gated helper. Cap the response body;
on any failure return `{ error }` — never throw into the acquisition pass.

- [ ] **Step 5: Tests, typecheck, commit**

```bash
docker compose exec core npm test -w core && docker compose exec core npm run typecheck -w core
git add core/src/logical/deletions.ts core/test/logical-deletions.test.ts
git commit -m "feat(deletions): fetch and gate a peer's deletion document

Host equality rather than prefix matching, since canonical_url keeps its
original scheme forever. Three-way outcome so a permanently invalid entry
cannot wedge the cursor.

developed with the help of AI tools"
```

---

## Task 12: Apply a deletion

**Files:**
- Modify: `core/src/logical/deletions.ts`
- Test: `core/test/logical-deletions.test.ts`

**Interfaces:**
- Produces: `applyDeletion(tx, source, ref, now): 'applied' | 'unknown'`

**Order matters — evidence first, then tombstone, then sweep:**
1. `deleteObservationVersions` (`logical/tombstones.ts:205-213`) — the house
   function; it handles the RESTRICT ordering across `reconciliation_jobs_v2`,
   `presentation_entries_v2`, `publisher_claims_v2`, `logical_conflicts_v2`,
   `publisher_names_v2`. `foreign_keys = ON` (`storage/sqlite.ts:1713`), so
   hand-rolling this ordering throws. **Do not hand-roll it.**
2. `convertToStructuralTombstone` (`logical/threading.ts:293-299`)
3. `sweepStructuralTombstones` (`:306-315`) — without it, deleting an item with
   no replies here leaves a permanent orphan row.
4. Insert the retraction record (Task 10).
5. `appendJournal(tx, { kind: 'remove', logicalItemId, changeMask: 'presentation' }, now)`
   — matching the origin (`logical/local.ts:230`). **Not** a `reset` barrier,
   which would make every client refetch its whole timeline for one item.

**Resolve `ref` excluding local items:** `materializeLocalItem` inserts a
`permalink` identity key for local posts too (`local.ts:61`), and tombstoning is
explicitly not for local items. `localPermalinkOwner` (`reconcile.ts:216-227`) is
the precedent for that exclusion.

**The audit row is best-effort.** `sweepStructuralTombstones` routes through
`deleteLogicalNode`, which deletes `item_audit_v2` rows for the item
(`threading.ts:282`); writing after the sweep throws on the RESTRICT FK. Write it
before the sweep and accept that a childless item's audit row goes with the node.

- [ ] **Step 1: Write the failing tests**

```ts
test('applying a deletion destroys the evidence', () => {
  const { raw, tx, itemId } = seedRemoteItemWithDelivery()
  applyDeletion(tx, source, ref, NOW)
  expect(count(raw, 'observation_versions_v2')).toBe(0)
  expect(count(raw, 'presentation_entries_v2')).toBe(0)
})

test('a reply under the deleted item survives and the thread still renders', () => {
  const { raw, tx, itemId, replyId } = seedRemoteItemWithReply()
  applyDeletion(tx, source, ref, NOW)
  expect(raw.prepare(`SELECT 1 FROM logical_items_v2 WHERE id = ?`).get(replyId)).toBeTruthy()
  expect(raw.prepare(`SELECT structural_tombstone FROM logical_items_v2 WHERE id = ?`).get(itemId))
    .toMatchObject({ structural_tombstone: 1 })
})

test('a childless deleted item leaves no orphan row', () => {
  const { raw, tx, itemId } = seedRemoteItemWithDelivery()
  applyDeletion(tx, source, ref, NOW)
  expect(raw.prepare(`SELECT 1 FROM logical_items_v2 WHERE id = ?`).get(itemId)).toBeUndefined()
})

test('applying a deletion emits one remove effect, not a reset', () => {
  const { raw, tx } = seedRemoteItemWithDelivery()
  const before = journalCursor(raw)
  applyDeletion(tx, source, ref, NOW)
  expect(journalEffectsSince(raw, before)).toEqual([{ kind: 'remove', changeMask: 'presentation' }])
})

test('a ref resolving to a local item is refused', () => {
  const { tx, localRef } = seedLocalPostWithPermalinkKey()
  expect(applyDeletion(tx, source, localRef, NOW)).toBe('unknown')
})

test('applying twice is idempotent', () => {
  const { tx } = seedRemoteItemWithDelivery()
  expect(applyDeletion(tx, source, ref, NOW)).toBe('applied')
  expect(applyDeletion(tx, source, ref, NOW)).toBe('unknown')
})
```

- [ ] **Step 2: Run and verify failure**

Run: `docker compose exec core npx vitest run test/logical-deletions.test.ts -t 'destroys the evidence'`
Expected: FAIL — `applyDeletion` not exported.

- [ ] **Step 3: Implement, in the stated order**

Resolve the normalized `ref` to a non-local item, collect its observation-version
ids, then run steps 1-5 above in one write transaction.

- [ ] **Step 4: Run tests, full suite, typecheck**

Run: `docker compose exec core npm test -w core && docker compose exec core npm run typecheck -w core`
Expected: PASS. A `FOREIGN KEY constraint failed` here means the deletion order
was hand-rolled instead of using `deleteObservationVersions`.

- [ ] **Step 5: Commit**

```bash
git add core/src/logical/deletions.ts core/test/logical-deletions.test.ts
git commit -m "feat(deletions): apply a received deletion

Evidence via deleteObservationVersions, then tombstone, then sweep, then
the retraction record, then one journal remove effect. Threads continue:
the row and parent edge survive so replies still render.

developed with the help of AI tools"
```

---

## Task 13: Drive deletions from the acquisition pass

**Files:**
- Modify: `core/src/logical/acquisition.ts`
- Test: `core/test/logical-deletions.test.ts`

**Interfaces:**
- Consumes: Tasks 11 and 12.
- Produces: a `deletions_cursor` carried on `acquisition_runs_v2`.

**Cursor rules — both were review findings, do not simplify them away:**
- **Three-way advance.** `applied` → advance. `reject-permanent` **and**
  `unknown` → advance: a peer announces deletions for items we never ingested,
  or that retention already trimmed, and that is the *common* case — holding on
  them wedges the cursor and every later deletion from that peer is lost forever.
  `reject-retryable` → hold.
- **Read only runs that actually carry a cursor.** Do **not** copy
  `latestClaim`'s outcome filter (`push.ts:221-228`) and do not simply take the
  newest run: `acquisition.ts:506-508` inserts the current run as
  `processing`/`pending` **before** the fetch, and `verification.ts:363-367`
  mints synthetic terminal runs — either would shadow the real cursor with NULL
  and re-drain the peer's whole list every poll. Select the newest run with a
  non-NULL `deletions_cursor`, excluding the in-flight run.
- A run that commits but whose deletions fetch failed carries the **previous**
  cursor forward, never NULL.

- [ ] **Step 1: Write the failing tests**

```ts
test('an unknown ref advances the cursor', async () => {
  const cursorBefore = await currentCursor(sourceId)
  await runAcquisitionWithDeletions([{ ref: 'https://peer.example/post/never-seen', deletedAt: T1 }])
  expect(await currentCursor(sourceId)).not.toBe(cursorBefore)
})

test('a pending federation relationship holds the cursor', async () => {
  const cursorBefore = await currentCursor(pendingSourceId)
  await runAcquisitionWithDeletions([{ ref: 'https://peer.example/post/a', deletedAt: T1 }], pendingSourceId)
  expect(await currentCursor(pendingSourceId)).toBe(cursorBefore)
})

test('a failed deletions fetch carries the previous cursor forward', async () => {
  await setCursor(sourceId, 'CURSOR-1')
  await runAcquisitionWithFailingDeletionsFetch(sourceId)
  expect(await currentCursor(sourceId)).toBe('CURSOR-1')
})

test('an in-flight pending run does not shadow the stored cursor', async () => {
  await setCursor(sourceId, 'CURSOR-1')
  await beginRunWithoutCommitting(sourceId)
  expect(await currentCursor(sourceId)).toBe('CURSOR-1')
})
```

- [ ] **Step 2: Run and verify failure**

Run: `docker compose exec core npx vitest run test/logical-deletions.test.ts -t 'cursor'`
Expected: FAIL.

- [ ] **Step 3: Add the column**

New migration step: `ALTER TABLE acquisition_runs_v2 ADD COLUMN deletions_cursor TEXT`.

- [ ] **Step 4: Call the fetch during acquisition**

Read `acquireSource` (`acquisition.ts:845`) before editing and place the call
where the feed commit has already succeeded, for approved federated sources only.
Persist the resulting cursor on the run's UPDATE at commit (`:529`).

- [ ] **Step 5: Tests, full suite, typecheck, commit**

```bash
docker compose exec core npm test -w core && docker compose exec core npm run typecheck -w core
git add core/src/logical/acquisition.ts core/src/logical/schema.ts core/test/logical-deletions.test.ts
git commit -m "feat(deletions): drive the deletion pass from acquisition

Three-way cursor outcomes so an unknown or permanently invalid entry
cannot wedge propagation. The cursor is read from the newest run that
actually carries one -- the newest run is often the in-flight pending
one or a synthetic verification run.

developed with the help of AI tools"
```

**STOP AND DEPLOY.** Tasks 10-13 are rollout step 4: consumer side, **alice only**.
Delete a post on rsc; it must be destroyed on alice while bob still shows it.
That asymmetry proves the gate and the effect together. Then bob, then
rsc.rmendes.net and skyfleet.blue.

---

## Verification before each deploy

- `docker compose exec core npm test -w core` — all pass
- `docker compose exec core npm run typecheck -w core` — clean
- `docker compose exec web npm test -w web && docker compose exec web npm run check -w web`
- Feed bytes unchanged (golden files) — nothing in this milestone alters a feed
  document, and the rollout depends on that
- valid.rss.chat on the firehose after tasks 7-9, since a passing unit suite is
  weak evidence for wire format in this repo
