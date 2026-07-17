# Walkable Feeds (threadwalker parity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Textcaster's local-post feeds walkable by Dave Winer's `threadwalker` verbatim — emit permalink URLs as bare `<guid>` (its string-compare key) and `source:account` on every multi-consumer feed (its author label).

**Architecture:** One derivation function `localGuid(p)` at the emission layer keys the guid off the post's already-stored `url` (no migration, no reconstruction, so guid/`<link>`/reply-refs share one source). Every local-post serialization and every injector call-site switches to it. `source:account` — already on the firehose — extends to per-user and comments feeds. A walker-parity test mimics `walker.js`'s exact semantics as a permanent regression pin.

**Tech Stack:** feedsmith 2.9.6 (existing), Kysely/better-sqlite3 (existing), Hono (existing), Vitest. No new dependency.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-17-textcaster-walkable-feeds-design.md`. It wins on ambiguity.
- **Emission-layer only.** No schema, no migration, no new column, no web-app change, no API surface change. The one repository-internal touch (widening `listRepliesByPostId`'s return type) is justified in Task 2 and stays behind the same HTTP routes.
- **The feedsmith guid pin (verified 2026-07-17 against 2.9.6):** `{ value, isPermaLink: true }` emits `<guid isPermaLink="true">` (breaks walker.js's string compare); `{ value }` with the `isPermaLink` key OMITTED emits a bare `<guid>` (correct); a bare string emits NO guid. So `localGuid`'s URL branch MUST be `{ value: p.url }` with no `isPermaLink` key — never `true`.
- **guid keys off stored `p.url`, never reconstructed from publicUrl** — so guid, `<link>`, and reply-refs can't drift, and url-less posts (predating url-storage) keep their stable UUID guid.
- **Remote posts untouched:** only `source: 'local'` posts get derived guids; pass-through re-emission keeps the origin's guid verbatim.
- **Injector keying:** `injectSourceComments` / `injectSourceAccounts` match on the `<guid>` element value in the XML they inject into (`injectItemElements`, feed.ts:143 — marker `>${guid}</guid>`). Every call-site must pass `localGuid(p).value` (the EMITTED guid), not `p.guid`, or the injection silently no-ops on url-bearing posts.
- **F-1 firehose reconciliation is already recorded** (spec rev 2 annotated the firehose spec `a2dc9ef`) — no doc task here; the guid-stability *test* updates live in Task 1.
- Shared checkout with a parallel session: read current file state before every edit (line numbers below are 2026-07-17 snapshots), stage EXPLICIT paths only (never `git add -A`). Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Gate every task: `npm test -w core` and `npm run typecheck -w core`, both green, before commit.

---

### Task 1: `localGuid` — permalink guids at every local-post emission + injector re-keying + firehose test reconciliation

**Files:**
- Modify: `core/src/domain/feed.ts` (add `localGuid`; three RSS render paths + JSON id; export `localGuid`)
- Modify: `core/src/api/app.ts` (injector call-site keys: lines ~168, ~221, ~223, ~237)
- Modify: `core/src/domain/push.ts` (injector call-site keys: lines ~236, ~256, ~258)
- Test: `core/test/feed.test.ts` (new emission tests; UPDATE the F-1 stability assertions at ~46 and ~117)

**Interfaces:**
- Consumes: `Post` type (`url: string | null`, `guid: string`, `source: 'local' | 'remote'`).
- Produces: `export function localGuid(p: Post): { value: string; isPermaLink?: false }` — `p.url` present → `{ value: p.url }` (no `isPermaLink` key); else `{ value: p.guid, isPermaLink: false }`. Task 2 and Task 3 call it.

- [ ] **Step 1: Write the failing tests**

Append to `core/test/feed.test.ts` (reuse the file's `makeApp`/`CTX`/`seedAlice` helpers; `CTX.publicUrl = 'https://cast.example.com'`, so `seedAlice`'s posts store `url = https://cast.example.com/post/<id>`):

```ts
import { localGuid } from '../src/domain/feed.ts' // add to the existing feed.ts import

test('localGuid: url-bearing post → bare permalink guid, no isPermaLink key', () => {
  const p = { url: 'https://cast.example.com/post/abc', guid: 'uuid-abc', source: 'local' } as any
  expect(localGuid(p)).toEqual({ value: 'https://cast.example.com/post/abc' })
  expect('isPermaLink' in localGuid(p)).toBe(false)
})

test('localGuid: url-less post → UUID guid with isPermaLink false (unchanged)', () => {
  const p = { url: null, guid: 'uuid-xyz', source: 'local' } as any
  expect(localGuid(p)).toEqual({ value: 'uuid-xyz', isPermaLink: false })
})

test('per-user feed emits the permalink as a bare guid (threadwalker string-compare key)', async () => {
  const { service, app } = await makeApp(CTX)
  await seedAlice(service)
  const body = await (await app.request('/users/alice/feed.xml')).text()
  // url-bearing local posts now emit <guid>URL</guid> with NO attribute
  expect(body).toMatch(/<guid>https:\/\/cast\.example\.com\/post\/[^<]+<\/guid>/)
  expect(body).not.toContain('isPermaLink') // no url-less local posts in this fixture
})

test('firehose emits bare permalink guids and still injects source:comments (keyed on emitted guid)', async () => {
  const { service, app } = await makeApp(CTX)
  await seedAlice(service)
  const root = (await service.getRecentLocalPosts(10)).find((p) => p.content === 'first body')!
  await service.createLocalPostAs('bob', 'Bob', 'a reply', root)
  const body = await (await app.request('/users/rss.xml')).text()
  expect(body).toMatch(/<guid>https:\/\/cast\.example\.com\/post\/[^<]+<\/guid>/)
  // injection landed on the url-bearing parent → keyed on the EMITTED (URL) guid, not the UUID
  expect(body).toContain(`<source:comments count="1" feedUrl="https://cast.example.com/post/${root.id}/comments.xml"/>`)
})

test('JSON feed id equals the emitted permalink for url-bearing posts', async () => {
  const { service, app } = await makeApp(CTX)
  await seedAlice(service)
  const body = await (await app.request('/users/alice/feed.json')).json()
  for (const item of body.items) expect(item.id).toMatch(/^https:\/\/cast\.example\.com\/post\//)
})

test('remote post keeps its origin guid verbatim (never localGuid-derived)', () => {
  const p = { url: 'https://elsewhere.example/p/1', guid: 'origin-guid-1', source: 'remote' } as any
  // localGuid is only applied to source==='local'; a remote post serialized via
  // the pass-through path keeps guid='origin-guid-1'. Pin at the helper boundary:
  expect(p.source).toBe('remote') // guard: the render paths below must not call localGuid for remotes
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w core -- feed`
Expected: FAIL — `localGuid` is not exported; per-user/firehose/JSON still emit `<guid isPermaLink="false">UUID`.

- [ ] **Step 3: Add `localGuid` to `core/src/domain/feed.ts`**

Add near the top of the file (after imports, before the render functions), and `export` it:

```ts
// The emitted identity of a LOCAL post. A post created under a public URL
// stored url = `${publicUrl}/post/${id}` (service.ts) — that stored url IS the
// permalink and becomes a bare <guid> (rss.chat's convention, which our ingest
// already honors, and which Dave's threadwalker string-compares). A post with
// no stored url keeps its UUID guid with isPermaLink="false" (a bare non-URL
// guid would be a lie, and that post emits no <link> either — consistent).
// PIN (feedsmith 2.9.6): the URL branch omits the isPermaLink key entirely —
// isPermaLink:true would serialize an attribute that breaks the walker.
export function localGuid(p: Post): { value: string; isPermaLink?: false } {
  return p.url !== null ? { value: p.url } : { value: p.guid, isPermaLink: false }
}
```

- [ ] **Step 4: Apply `localGuid` at the three RSS render paths + JSON id**

In `renderRssFeed` (feed.ts ~86), `renderFirehoseRss` (~124), and `renderCommentsFeed` (~182), replace each hardcoded:

```ts
        guid: { value: p.guid, isPermaLink: false },
```

with:

```ts
        guid: localGuid(p),
```

In `renderJsonFeed` (feed.ts ~200), replace:

```ts
        id: p.guid,
```

with:

```ts
        id: localGuid(p).value,
```

(These are all LOCAL-post render paths. The remote pass-through re-emission path — where remote items keep their origin guid — is elsewhere and MUST NOT change; verify no `p.guid`→`localGuid` swap touches a `source: 'remote'` item.)

- [ ] **Step 5: Re-key every injector call-site to the emitted guid**

The injectors match on the `<guid>` value now present in the XML (the URL for url-bearing posts). Every call-site currently passing `p.guid`/`r.guid` must pass `localGuid(p).value`.

`core/src/api/app.ts`:
- ~168 comments route `injectSourceComments`: `guid: r.guid` → `guid: localGuid(r).value`
- ~221 firehose `injectSourceAccounts`: `guid: p.guid` → `guid: localGuid(p).value`
- ~223 firehose `injectSourceComments`: `guid: p.guid` → `guid: localGuid(p).value`
- ~237 per-user `injectSourceComments`: `guid: p.guid` → `guid: localGuid(p).value`

`core/src/domain/push.ts` (import `localGuid` from `./feed.ts` alongside the existing feed imports):
- ~236 per-user `injectSourceComments`: `guid: p.guid` → `guid: localGuid(p).value`
- ~256 firehose `injectSourceAccounts`: `guid: p.guid` → `guid: localGuid(p).value`
- ~258 firehose `injectSourceComments`: `guid: p.guid` → `guid: localGuid(p).value`

(Grep to confirm you caught all seven: `grep -n "guid: [pr]\.guid" core/src/api/app.ts core/src/domain/push.ts` should return nothing after this step.)

- [ ] **Step 6: Update the F-1 firehose stability assertions**

These assert the OLD shape and must change (spec F-1 item 2). Read current line numbers first.

`core/test/feed.test.ts` ~46 (per-user `RSS raw output` test): `seedAlice` posts are url-bearing under `CTX`, so:
```ts
  expect(body).toContain('<guid isPermaLink="false">')
```
becomes:
```ts
  expect(body).toMatch(/<guid>https:\/\/cast\.example\.com\/post\/[^<]+<\/guid>/)
```

`core/test/feed.test.ts` ~117 (firehose fixture with `guid: 'guid-1'` AND `url: 'https://tc.example/post/p1'`): under `localGuid` the emitted guid is the url. Change:
```ts
  expect(xml).toContain('<guid isPermaLink="false">guid-1</guid>')
```
to:
```ts
  expect(xml).toContain('<guid>https://tc.example/post/p1</guid>')
```
Leave the sibling `expect(xml).toContain('<link>https://tc.example/post/p1</link>')` as-is (guid and link now coincide — that IS the design). If the fixture at ~127 has a second item with `url: null`, its `<guid isPermaLink="false">` assertion (if any) stays.

- [ ] **Step 7: Run the full feed suite + whole core suite**

Run: `npm test -w core -- feed` → PASS, then `npm test -w core` → ALL PASS. Any OTHER test asserting `<guid isPermaLink="false">` on a url-bearing local post is the same reconciliation — update it to the bare-permalink shape and note it in the report. A test on a url-less or remote post keeps its shape; do not change those.

- [ ] **Step 8: Typecheck + commit**

```bash
npm run typecheck -w core
git add core/src/domain/feed.ts core/src/api/app.ts core/src/domain/push.ts core/test/feed.test.ts
git commit -m "core: local-post guids are bare permalinks (threadwalker key); reconcile firehose guid tests

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `source:account` on per-user and comments feeds (pull + push)

**Files:**
- Modify: `core/src/domain/repository.ts` (widen `listRepliesByPostId` return type)
- Modify: `core/src/storage/sqlite.ts` (`listRepliesByPostId` → author-joined query)
- Modify: `core/src/api/app.ts` (per-user route + comments route: add `injectSourceAccounts`)
- Modify: `core/src/domain/push.ts` (per-user push body: add `injectSourceAccounts`)
- Test: `core/test/feed.test.ts` (source:account presence on both feeds, multi-author comments)

**Interfaces:**
- Consumes: `localGuid` (Task 1); `injectSourceAccounts(xml, ads: Array<{ guid, service, name }>)` (feed.ts ~168, exists); `joinedRowToEntry` (sqlite.ts ~33, exists).
- Produces: `listRepliesByPostId(id): Promise<TimelineEntry[]>` (was `Post[]`; `TimelineEntry = Post & { author: User }`, so every existing `Post` field remains — callers using `.id`/`.map` are unaffected).

- [ ] **Step 1: Write the failing tests**

Append to `core/test/feed.test.ts`:

```ts
test('per-user feed carries source:account naming the author', async () => {
  const { service, app } = await makeApp(CTX)
  await seedAlice(service)
  const body = await (await app.request('/users/alice/feed.xml')).text()
  const host = 'cast.example.com'
  expect(body).toContain(`<source:account service="${host}">alice</source:account>`)
})

test('comments feed carries per-reply source:account (multi-author, threadwalker names)', async () => {
  const { service, app } = await makeApp(CTX)
  await seedAlice(service)
  const root = (await service.getRecentLocalPosts(10)).find((p) => p.content === 'first body')!
  await service.createLocalPostAs('bob', 'Bob', 'bob replies', root)
  await service.createLocalPostAs('carol', 'Carol', 'carol replies', root)
  const body = await (await app.request(`/post/${root.id}/comments.xml`)).text()
  expect(body).toContain('<source:account service="cast.example.com">bob</source:account>')
  expect(body).toContain('<source:account service="cast.example.com">carol</source:account>')
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w core -- feed`
Expected: FAIL — no `source:account` on per-user or comments feeds (firehose-only today).

- [ ] **Step 3: Widen `listRepliesByPostId` to author-joined `TimelineEntry[]`**

`core/src/domain/repository.ts` ~29:
```ts
  listRepliesByPostId(id: string): Promise<Post[]>
```
becomes:
```ts
  listRepliesByPostId(id: string): Promise<TimelineEntry[]>
```

`core/src/storage/sqlite.ts` ~335 — replace the `rowToPost` body with the author-joined pattern already used by `getRecentLocalPosts` (~238):
```ts
  async listRepliesByPostId(id: string): Promise<TimelineEntry[]> {
    const rows = await this.db
      .selectFrom('posts')
      .innerJoin('users', 'users.id', 'posts.author_id')
      .selectAll('posts')
      .select(['users.id as u_id', 'users.kind as u_kind', 'users.handle as u_handle', 'users.display_name as u_display_name', 'users.feed_url as u_feed_url', 'users.created_at as u_created_at', 'users.auth_user_id as u_auth_user_id'])
      .where('in_reply_to_post_id', '=', id)
      .orderBy('posts.published_at', 'asc')
      .orderBy('posts.id', 'asc')
      .execute()
    return rows.map(joinedRowToEntry)
  }
```

(The contract test `repository-contract.ts:442` asserts `.map((p) => p.id)` — `TimelineEntry` still has `.id`, so it stays green. The `service.ts:72` passthrough returns whatever the repo returns — no change needed.)

- [ ] **Step 4: Inject `source:account` in the per-user route (pull)**

`core/src/api/app.ts`, the `/users/:handle/feed.xml` route (~229). After `renderRssFeed` and inside the `if (feeds.publicUrl)` block, add (mirroring the firehose's injection at ~221):
```ts
      const host = new URL(feeds.publicUrl).host
      xml = injectSourceAccounts(xml, posts.map((p) => ({ guid: localGuid(p).value, service: host, name: r.user.handle })))
```
(Single author — `r.user.handle` for every item. Import `localGuid` into app.ts if Task 1 didn't already. Place before or after the existing `injectSourceComments` in that route — order is independent; both key on the emitted guid.)

- [ ] **Step 5: Inject `source:account` in the comments route (pull, multi-author)**

`core/src/api/app.ts`, the `/post/:id/comments.xml` route (~160). `replies` is now `TimelineEntry[]` (Task 2 Step 3), so each carries `.author`. Inside `if (feeds.publicUrl)`:
```ts
      const host = new URL(feeds.publicUrl).host
      xml = injectSourceAccounts(xml, replies.map((r) => ({ guid: localGuid(r).value, service: host, name: r.author.handle })))
```

- [ ] **Step 6: Inject `source:account` in the per-user push body (parity)**

`core/src/domain/push.ts`, per-user xml body (~231, the `format === 'xml'` block that mirrors GET /users/:handle/feed.xml). Add alongside the existing `injectSourceComments`:
```ts
              const host = new URL(ctx.publicUrl).host
              body = injectSourceAccounts(body, posts.map((p) => ({ guid: localGuid(p).value, service: host, name: entry.author.handle })))
```
(`entry.author` is the feed's single user. `injectSourceAccounts` is already imported in push.ts. Push does NOT emit standalone comments-feed pings, so no comments-feed push change is needed — the comments `source:account` is pull-only.)

- [ ] **Step 7: Run + typecheck**

Run: `npm test -w core` → ALL PASS (incl. the contract suite and the ~46/~117 firehose tests from Task 1). `npm run typecheck -w core` → 0 errors.

- [ ] **Step 8: Commit**

```bash
git add core/src/domain/repository.ts core/src/storage/sqlite.ts core/src/api/app.ts core/src/domain/push.ts core/test/feed.test.ts
git commit -m "core: source:account on per-user + comments feeds (author-joined replies) — threadwalker names

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Walker-parity money test

**Files:**
- Test: `core/test/feed.test.ts` (one new test that mimics `walker.js` semantics end-to-end)

**Interfaces:**
- Consumes: the emitted feeds from Tasks 1–2 over `app.request`. No new production code.

**Probed facts (walker.js, do not re-derive):** it (1) reads a starting feed, (2) matches the starting item by `item.guid === startingGuid` (plain string compare — REQUIRES a bare permalink guid), (3) follows each item's `source:comments` `feedUrl` attribute recursively, (4) prints `item["source:account"]._` as the author. This test reproduces that exact walk in-process.

- [ ] **Step 1: Write the parity test**

Append to `core/test/feed.test.ts`. Parse with a small targeted extraction (no new dependency; do NOT rely on feedsmith round-tripping the injected `source:*` elements — extract from the raw XML string, which is exactly the surface walker.js parses):

```ts
test('a Textcaster conversation is walkable by threadwalker semantics (guid string-compare + source:account names)', async () => {
  const { service, app } = await makeApp(CTX)
  await seedAlice(service)
  const root = (await service.getRecentLocalPosts(10)).find((p) => p.content === 'first body')!
  const bob = await service.createLocalPostAs('bob', 'Bob', 'Bob replies to Alice', root)
  await service.createLocalPostAs('carol', 'Carol', 'Carol replies to Bob', bob)
  await service.createLocalPostAs('carol', 'Carol', 'Carol replies to the root', root)

  const startingGuid = `${CTX.publicUrl}/post/${root.id}` // the permalink walker.js compares against

  // --- walker.js semantics, reproduced ---
  async function fetchItems(url: string): Promise<Array<{ guid: string; author: string; text: string; commentsFeed: string | null }>> {
    const path = url.replace(CTX.publicUrl!, '')
    const xml = await (await app.request(path)).text()
    const items: any[] = []
    for (const block of xml.split('<item>').slice(1)) {
      const item = block.slice(0, block.indexOf('</item>'))
      const guid = (item.match(/<guid[^>]*>([^<]+)<\/guid>/) ?? [])[1] ?? ''
      const author = (item.match(/<source:account[^>]*>([^<]+)<\/source:account>/) ?? [])[1] ?? '?'
      const text = (item.match(/<source:markdown>([^<]*)/) ?? [])[1] ?? ''
      const commentsFeed = (item.match(/<source:comments[^>]*feedUrl="([^"]+)"/) ?? [])[1] ?? null
      items.push({ guid, author, text, commentsFeed })
    }
    return items
  }

  const outline: string[] = []
  async function walk(item: { author: string; text: string; commentsFeed: string | null }, depth: number) {
    outline.push('  '.repeat(depth) + `${item.author}: ${item.text}`)
    if (!item.commentsFeed) return
    for (const reply of await fetchItems(item.commentsFeed)) await walk(reply, depth + 1)
  }

  const top = (await fetchItems(`${CTX.publicUrl}/users/alice/feed.xml`)).find((i) => i.guid === startingGuid)
  expect(top).toBeDefined() // guid string-compare succeeds ONLY if the guid is a bare permalink (Task 1)
  await walk(top!, 0)

  expect(outline).toEqual([
    'alice: first body',
    '  Bob: Bob replies to Alice',
    '    Carol: Carol replies to Bob',
    '  Carol: Carol replies to the root',
  ])
  // and never an unresolved author
  expect(outline.join('\n')).not.toContain('?:')
})
```

- [ ] **Step 2: Run**

Run: `npm test -w core -- feed`
Expected: PASS. If `top` is undefined, Task 1's guid is not bare (regression). If any line shows `?:`, Task 2's `source:account` is missing on that feed.

- [ ] **Step 3: Commit**

```bash
git add core/test/feed.test.ts
git commit -m "core: walker-parity test pins threadwalker compatibility (guid compare + source:account outline)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Plan self-review notes (done at write time)

- Spec coverage: permalink guids keyed off stored `url` with the feedsmith omit-key pin (T1 Step 3), applied at all three RSS paths + JSON id (T1 Step 4), injector re-keying enumerated for all seven call-sites (T1 Step 5), remote pass-through untouched (T1 Step 4 note + Step 1 remote test), F-1 firehose stability-test reconciliation (T1 Step 6, plus the doc annotation already committed in spec rev 2), `source:account` on per-user (pull+push) and comments (pull, author-joined) feeds (T2), walker-parity money test (T3). Reply-ref permalink form is pre-existing (`service.ts:49`) — pinned implicitly by T3's nested walk, no code change.
- Deviation from spec's "emission-layer only": T2 widens `listRepliesByPostId`'s return type from `Post[]` to `TimelineEntry[]` (author-joined). This is repository-internal (no schema/API/web change), stays behind the same routes, and is the root-cause way to get per-reply authors to the comments-feed emission point — the alternative (a new batch user-lookup) is a larger new surface. Only 2 callers, both `.id`/`.map`-compatible with the wider type.
- Placeholder scan: none — every step carries concrete code and exact commands.
- Type consistency: `localGuid(p) → { value: string; isPermaLink?: false }` used identically in T1/T2/T3; `injectSourceAccounts` ad shape `{ guid, service, name }` matches the existing signature (feed.ts ~168); `TimelineEntry.author.handle` used in T2 comments + T3 matches the `joinedRowToEntry` mapping.
- Line numbers are 2026-07-17 snapshots in a shared checkout — every task re-reads current state first (stated in Global Constraints).
