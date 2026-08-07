# rss.chat Interop Compliance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make RSC's outbound feeds pass Dave Winer's `valid.rss.chat` validator — closing one error and four warnings — so conversations thread correctly across rss.chat-compatible apps.

**Architecture:** Local posts already emit complete Textcasting items; remote items relayed into our comments feeds are stripped of theirs. Five of the six fixes are in the outbound emission path (`projector.ts` → `feed.ts` → `read.ts`); the sixth adds `source:markdown` capture to v2 acquisition. Nothing touches the fingerprint, the sanitizer, or the XML namespace.

**Tech Stack:** Node 22+ native type-stripping (no build step), Hono, better-sqlite3 + Kysely, feedsmith (RSS generate/parse), vitest.

**Spec of record:** `docs/superpowers/specs/2026-08-07-rsschat-interop-compliance-design.md` (rev 2).

## Global Constraints

- **No TypeScript parameter properties in `core/src`** — Node's native type stripping rejects them; constructors assign fields plainly.
- **`tsc` is not optional.** Native type-stripping means vitest passes on type errors. Every task runs `npm run typecheck -w core` (the existing script — do not invent a `tsc` invocation).
- **Work in the worktree** `/home/rmdes/textcaster-interop`, branch `interop-rsschat-compliance`. Baseline before Task 1: core 1140/1140 in 106 files, typecheck 0.
- **Never `git add -A`.** This is a shared checkout with a parallel session committing to `main`. Stage explicit paths only, exactly as listed in each task.
- **Commit messages end with the line** `developed with the help of AI tools`.
- **The sanitizer is the XSS gate.** `core/src/domain/markdown.ts` and `web/src/lib/server/render.ts` are hand-duplicated twins with a drift-canary test in both suites. No task here changes either — if a change seems to require it, stop and escalate.
- **The source namespace stays `http://source.scripting.com/`.** Deliberate (spec §3). Do not "fix" it; feedsmith emits it and it is not configurable.
- **Remote guid values are never rewritten.** A remote item's `<guid>` value is always `p.guid` verbatim — only the `isPermaLink` *attribute* is in scope.
- Tests live in `core/test/`, not `core/src/`.

---

### Task 1: Remote replies carry a reply ref that resolves *(closes the ERROR)*

Relocates `parentReplyRef` to a leaf module (required — see below), then uses it for remote items.

**Why the move:** `projector.ts` cannot import `local.ts`. `local.ts:6` imports `threading.ts`, and `threading.ts:4` imports `isStructuralTombstone` from `projector.ts` — so `projector → local` closes a cycle. `roots.ts` is a dependency leaf (imports only `type { ReadTx }`) that `local.ts` already imports, and it already holds the sibling identity helper `normalizePermalink`.

**Files:**
- Modify: `core/src/logical/roots.ts` (add `parentReplyRef`)
- Modify: `core/src/logical/local.ts:45-63` (remove it — docblock `45-51` + body `52-63`), `:8` (import it)
- Modify: `core/src/logical/projector.ts:601`
- Test: `core/test/feed.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `parentReplyRef(tx: ReadTx, parentId: string): string | null`. **Execution note (`82efae4`):** it ended up exported from `core/src/logical/projector.ts:515`, NOT `roots.ts` — moved again so it mirrors `projectRemote`'s guid derivation exactly (a remote parent's advertised guid is its selected delivery's `normalized.key`, not its permalink). Later tasks import it from `projector.ts`.

- [ ] **Step 1: Write the failing test**

Append to `core/test/feed.test.ts`. It reuses the existing `acquireFeed` helper and the `CTX`/`makeApp` conventions already in that file.

ONE test, not two: the divergent fixture is a strict superset — it resolves onto
the same parent, asserts the same emitted ref, AND additionally fails any
verbatim implementation. A separate non-divergent test would add no coverage.

```ts
test('comments feed: a relayed remote reply points back at the parent guid', async () => {
  const ctx = await makeApp(CTX)
  const { service, app } = ctx
  const root = await service.createLocalPostAs('alice', 'Alice', 'root post text')
  // The origin cites the parent WITH a fragment. reconcile.ts:235 runs the ref
  // through normalizePermalink (which strips the fragment) and the local identity
  // key is posts.url verbatim, so this RESOLVES onto our root — but a verbatim
  // re-emission would not string-match the parent's <guid>, which is exactly what
  // the validator's replyDoesntPointBack compares. That makes this fixture the
  // one that bites: it passes only if we emit the parent's own advertised guid.
  await acquireFeed(ctx, {
    url: 'https://elsewhere.example/users/eve/feed.xml',
    xml: `<?xml version="1.0"?><rss version="2.0" xmlns:source="http://source.scripting.com/"><channel><title>Eve</title>`
      + `<item><guid isPermaLink="false">origin-guid-92</guid><link>https://elsewhere.example/notes/92</link>`
      + `<description>divergent ref reply</description><source:inReplyTo>${root.url}#comment</source:inReplyTo></item>`
      + `</channel></rss>`,
  })
  const body = await (await app.request(`/post/${root.id}/comments.xml`)).text()
  expect(body).toContain('divergent ref reply') // sanity: it really resolved onto the local root
  expect(body).toContain(`<source:inReplyTo>${root.url}</source:inReplyTo>`)
  expect(body).toContain(`<thr:in-reply-to ref="${root.url}"`) // feedsmith emits ref before href
  expect(body).not.toContain(`${root.url}#comment`)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w core -- feed.test.ts -t 'points back at the parent guid'`
Expected: FAIL — no `<source:inReplyTo>` is emitted for remote items at all.

- [ ] **Step 3: Move `parentReplyRef` into `roots.ts`**

Cut lines `45-63` from `core/src/logical/local.ts` — the docblock is `45-51` and the body `52-63`. Do **not** cut past `63`: line `64` is blank and `65-67` is `materializeLocalItem`'s own docblock. Paste into `core/src/logical/roots.ts`, adding `export` and changing the parameter type to `ReadTx` (it performs only SELECTs; `ReadTx` and `WriteTx` are both aliases of `BetterSqlite3.Database`, so `local.ts:175`'s existing call still type-checks):

```ts
// The parent's on-the-wire reply reference (v1 parity, service.ts): the string the
// outbound feed emits as <source:inReplyTo>, which a peer instance string-matches to
// the parent's own <guid>. It MUST equal what the parent's feed advertises as its
// guid: a LOCAL parent's guid is its absolute permalink (`url`) or, url-less, its own
// id (logicalToFeedEntry emits guid = dto.id === post.id in the null-url fallback —
// NOT the opaque posts.guid column); a REMOTE parent (logical-only, not in `posts`)
// advertises its canonical permalink identity key.
export function parentReplyRef(tx: ReadTx, parentId: string): string | null {
  const local = tx.prepare(`SELECT url FROM posts WHERE id = ? AND source = 'local'`).get(parentId) as { url: string | null } | undefined
  if (local) return local.url ?? parentId
  // Precedence mirrors v1's `replyTo.url ?? replyTo.guid`: permalink first, then
  // the opaque guid. reconcile stores the opaque key with a publisher-scoped kind
  // but its `key` column IS the bare wire guid (reconcile.ts:322 claims key=v.key),
  // so a peer string-matches it against the parent's own <guid> exactly as under v1.
  const k = tx.prepare(`SELECT key FROM logical_identity_keys_v2 WHERE kind = 'permalink' AND logical_item_id = ? LIMIT 1`).get(parentId) as { key: string } | undefined
  if (k) return k.key
  const o = tx.prepare(`SELECT key FROM logical_identity_keys_v2 WHERE kind LIKE 'opaque:%' AND logical_item_id = ? LIMIT 1`).get(parentId) as { key: string } | undefined
  return o ? o.key : null
}
```

In `core/src/logical/local.ts`, change line 8 from:

```ts
import { deriveRoot } from './roots.ts'
```

to:

```ts
import { deriveRoot, parentReplyRef } from './roots.ts'
```

Leave `local.ts:175` (`const inReplyToRef = parentLogicalItemId ? parentReplyRef(tx, parentLogicalItemId) : null`) unchanged — it now calls the imported function.

- [ ] **Step 4: Run the full core suite to prove the move changed nothing**

Run: `npm test -w core`
Expected: PASS, same count as before the move (the two new tests still FAIL).

- [ ] **Step 5: Use it for remote items in the projector**

`core/src/logical/projector.ts` has no `roots.ts` import today, so add one beside its existing imports:

```ts
import { parentReplyRef } from './roots.ts'
```

Replace line 601:

```ts
    inReplyToRef: null, // remote items keep the current firehose/comments behavior (no source:inReplyTo re-emit)
```

with:

```ts
    // A resolved parent's OWN advertised guid — replyDoesntPointBack is a string
    // compare against it, and an origin may cite a differently-formed URL that
    // still resolves (fragment, alias). Unresolved: the origin's ref verbatim.
    inReplyToRef: state === 'resolved' && item.parent_logical_item_id !== null
      ? parentReplyRef(tx, item.parent_logical_item_id)
      : safeUrl(mat.material.inReplyTo),
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -w core -- feed.test.ts -t 'points back at the parent guid'`
Expected: PASS.

- [ ] **Step 7: Full gates**

Run: `npm test -w core && npm run typecheck -w core`
Expected: full suite PASS, `tsc` exits 0 with no output.

- [ ] **Step 8: Commit**

```bash
git add core/src/logical/roots.ts core/src/logical/local.ts core/src/logical/projector.ts core/test/feed.test.ts
git commit -m "fix(core): relayed remote replies carry source:inReplyTo

projector.ts:601 hardcoded inReplyToRef: null, so a reply federated from a
peer lost source:inReplyTo and thr:in-reply-to on re-emission and the thread
stopped being walkable (valid.rss.chat replyDoesntPointBack).

Emits the resolved parent's own advertised guid via parentReplyRef, which the
validator string-compares, rather than a verbatim origin ref that may not
match. parentReplyRef moves local.ts -> roots.ts because projector cannot
import local.ts (local -> threading -> projector is a cycle); roots.ts is a
leaf that local.ts already imports.

developed with the help of AI tools"
```

---

### Task 2: Stop declaring true permalinks non-permalinks

**Files:**
- Modify: `core/src/domain/feed.ts:257`
- Test: `core/test/feed.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Append to `core/test/feed.test.ts`:

```ts
test('comments feed: a remote guid equal to its permalink emits no isPermaLink attribute', async () => {
  const ctx = await makeApp(CTX)
  const { service, app } = ctx
  const root = await service.createLocalPostAs('alice', 'Alice', 'root post text')
  // Guid === link, the shape a peer RSC/rss.chat instance emits (its own bare
  // permalink guid). Re-emitting it as isPermaLink="false" would assert the
  // origin's permalink is not one, leaving a reply nothing to fetch.
  const PERMA = 'https://peer.example/post/abc-123'
  await acquireFeed(ctx, {
    url: 'https://peer.example/users/frank/feed.xml',
    xml: `<?xml version="1.0"?><rss version="2.0" xmlns:source="http://source.scripting.com/"><channel><title>Frank</title>`
      + `<item><guid>${PERMA}</guid><link>${PERMA}</link>`
      + `<description>peer reply</description><source:inReplyTo>${root.url}</source:inReplyTo></item>`
      + `</channel></rss>`,
  })
  const body = await (await app.request(`/post/${root.id}/comments.xml`)).text()
  expect(body).toContain(`<guid>${PERMA}</guid>`)
  expect(body).not.toContain(`<guid isPermaLink="false">${PERMA}</guid>`)
})
```

Note: the existing test at `feed.test.ts:360` ("keeps its origin guid") uses an opaque guid (`origin-guid-77`) that differs from its link, so it must stay green — that is the guid ≠ url half of this behavior.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w core -- feed.test.ts -t 'no isPermaLink attribute'`
Expected: FAIL — emitted as `<guid isPermaLink="false">https://peer.example/post/abc-123</guid>`.

- [ ] **Step 3: Make the attribute conditional**

In `core/src/domain/feed.ts`, replace line 257:

```ts
          guid: p.source === 'local' ? localGuid(p) : { value: p.guid, isPermaLink: false },
```

with:

```ts
          // Identity, NOT url-shape: acquisition.ts:243 stores the wire guid and
          // DISCARDS the origin's isPermaLink, so a shape test would promote a
          // WordPress-style <guid isPermaLink="false">https://x/?p=1</guid> to a
          // permalink the origin denied. guid === url is provable from stored data.
          // Omits the attribute rather than emitting isPermaLink="true" (feed.ts:60).
          guid: p.source === 'local' ? localGuid(p) : { value: p.guid, ...(p.guid === p.url ? {} : { isPermaLink: false }) },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w core -- feed.test.ts`
Expected: PASS, including the pre-existing `origin-guid-77` test (guid ≠ url ⇒ attribute retained).

- [ ] **Step 5: Full gates**

Run: `npm test -w core && npm run typecheck -w core`
Expected: full suite PASS, `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add core/src/domain/feed.ts core/test/feed.test.ts
git commit -m "fix(core): do not declare a remote permalink guid non-permalink

feed.ts:257 stamped isPermaLink=\"false\" on every remote guid, including guids
byte-identical to the item's own permalink — a peer emits it bare and we
downgraded it on relay, so a reply pointing at it had nothing to fetch
(valid.rss.chat guidNotPermalink).

Uses guid === url rather than a URL-shape test: acquisition discards the
origin's isPermaLink, so shape inference would promote guids the origin
explicitly declared non-permalinks.

Scope note: this also covers link-only remote items (no <guid> at all), which
get keyKind='permalink' so originGuid === permalink and they likewise emit a
bare guid. Correct by construction, and broader than the peer-instance case.

developed with the help of AI tools"
```

---

### Task 3: Comments feed newest-first

**Files:**
- Modify: `core/src/api/logical-routes/read.ts:187-189`
- Test: `core/test/feed.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Append to `core/test/feed.test.ts`:

```ts
test('comments feed items are newest-first', async () => {
  const { service, app } = await makeApp(CTX)
  const root = await service.createLocalPostAs('alice', 'Alice', 'root post text')
  const wait = () => new Promise((r) => setTimeout(r, 2)) // force strictly-increasing published_at
  await service.createLocalPostAs('bob', 'Bob', 'older reply', root)
  await wait()
  await service.createLocalPostAs('carol', 'Carol', 'newer reply', root)
  const body = await (await app.request(`/post/${root.id}/comments.xml`)).text()
  expect(body.indexOf('newer reply')).toBeLessThan(body.indexOf('older reply'))
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w core -- feed.test.ts -t 'newest-first'`
Expected: FAIL — items arrive depth-then-`timelineSortAt` ASC from `threading.ts:427`, so "older reply" comes first.

- [ ] **Step 3: Sort once, before both consumers**

In `core/src/api/logical-routes/read.ts`, replace lines 187-189:

```ts
      const replies = (thread?.nodes ?? [])
        .filter((n): n is { kind: 'item'; item: LogicalItemDto } => n.kind === 'item' && n.item.parentLogicalItemId === id)
        .map((n) => n.item)
```

with:

```ts
      const replies = (thread?.nodes ?? [])
        .filter((n): n is { kind: 'item'; item: LogicalItemDto } => n.kind === 'item' && n.item.parentLogicalItemId === id)
        .map((n) => n.item)
        // RSS convention is newest-first; projectThread returns depth-then-time ASC.
        // Feed bytes only — the web UI reads /post/:id/thread, not comments.xml, so
        // the chronological conversation order users see is unaffected. injectComments
        // keys by guid and is order-independent, so both consumers take this array.
        .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : a.id < b.id ? 1 : -1))
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w core -- feed.test.ts -t 'newest-first'`
Expected: PASS.

- [ ] **Step 5: Update the threadwalker test's expected outline (EXPECTED — not a regression)**

`core/test/feed.test.ts:442` asserts an exact **ordered** array, and its `walk()` iterates the comments feed directly (`:431`), so newest-first legitimately reorders the root's two same-depth direct replies. "Carol replies to the root" is created last (`:402`), so it now comes first. Nesting is structural and does not move.

Replace the `expect(outline).toEqual([...])` block at `core/test/feed.test.ts:442` with:

```ts
  // Feed order is newest-first (RSS convention); nesting stays structural, so
  // Carol's reply to the root sorts above Bob's older one while Carol's reply to
  // Bob stays nested under Bob.
  expect(outline).toEqual([
    'Alice: first body',
    '  Carol: Carol replies to the root',
    '  Bob: Bob replies to Alice',
    '    Carol: Carol replies to Bob',
  ])
```

- [ ] **Step 6: Full gates**

Run: `npm test -w core && npm run typecheck -w core`
Expected: full suite PASS, typecheck 0.

- [ ] **Step 7: Commit**

```bash
git add core/src/api/logical-routes/read.ts core/test/feed.test.ts
git commit -m "fix(core): comments feed items newest-first

projectThread returns depth-then-time ascending, so the comments feed served
oldest-first (valid.rss.chat itemsOutOfOrder). Sorted once before both the
renderer and the source:comments injector.

The threadwalker test's expected outline changes with it: its walk reads the
comments feed directly, so two same-depth sibling replies swap. Nesting is
structural and unchanged. That reordering IS the fix, not a regression.

developed with the help of AI tools"
```

---

### Task 4: Self-pointer on the feeds that lack one

**Files:**
- Modify: `core/src/domain/feed.ts` (add `commentsFeedUrl`; `renderRssFeed`, `renderCommentsFeed`)
- Modify: `core/src/api/logical-routes/read.ts:136`
- Test: `core/test/feed.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `commentsFeedUrl(publicUrl: string, id: string): string` exported from `core/src/domain/feed.ts`.

- [ ] **Step 1: Write the failing test**

Append to `core/test/feed.test.ts`:

```ts
test('comments feed advertises where it lives; user feed carries source:self', async () => {
  const { service, app } = await makeApp(CTX)
  const root = await service.createLocalPostAs('alice', 'Alice', 'root post text')
  await service.createLocalPostAs('bob', 'Bob', 'a reply', root)
  const comments = await (await app.request(`/post/${root.id}/comments.xml`)).text()
  const self = `${CTX.publicUrl}/post/${root.id}/comments.xml`
  expect(comments).toContain(`<source:self>${self}</source:self>`)
  expect(comments).toContain(`href="${self}"`)
  const user = await (await app.request('/users/alice/feed.xml')).text()
  expect(user).toContain(`<source:self>${CTX.publicUrl}/users/alice/feed.xml</source:self>`)
})
```

Then extend the existing no-config test at `core/test/feed.test.ts:122` (`'links are omitted without config: no self/hub/cloud when unset'`) by appending these lines inside it, before its closing brace:

```ts
  const root = await service.createLocalPostAs('alice', 'Alice', 'root')
  const comments = await (await app.request(`/post/${root.id}/comments.xml`)).text()
  expect(comments).not.toContain('<source:self>')
  expect(comments).not.toContain('rel="self"')
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w core -- feed.test.ts -t 'source:self'`
Expected: FAIL — `renderCommentsFeed` emits no self element of either kind.

- [ ] **Step 3: Add the shared URL helper**

In `core/src/domain/feed.ts`, add beside `firehoseUrl` (after line 80):

```ts
// The comments feed for one item. Shared so a feed's advertised
// source:comments feedUrl and that feed's own self-pointer cannot disagree.
export function commentsFeedUrl(publicUrl: string, id: string): string {
  return `${publicUrl}/post/${id}/comments.xml`
}
```

- [ ] **Step 4: Use it at the existing call site**

In `core/src/api/logical-routes/read.ts`, add `commentsFeedUrl` to the existing `../../domain/feed.ts` import on line 2, then replace line 136:

```ts
      .map((d) => ({ guid: emittedGuid(logicalToFeedEntry(d)), count: d.directReplyCount, feedUrl: `${pub}/post/${d.id}/comments.xml` })))
```

with:

```ts
      .map((d) => ({ guid: emittedGuid(logicalToFeedEntry(d)), count: d.directReplyCount, feedUrl: commentsFeedUrl(pub, d.id) })))
```

- [ ] **Step 5: Emit `source:self` on the user feed**

In `core/src/domain/feed.ts`, inside `renderRssFeed`'s `generateRssFeed` channel object, add after the `...(cloud ? { cloud } : {})` line:

```ts
      ...(ctx.publicUrl ? { sourceNs: { self: feedUrls(ctx.publicUrl, user.handle).xml } } : {}),
```

- [ ] **Step 6: Emit both self elements on the comments feed**

In `core/src/domain/feed.ts`, in `renderCommentsFeed`, insert before the `return generateRssFeed(` line:

```ts
  const self = ctx.publicUrl ? commentsFeedUrl(ctx.publicUrl, post.id) : null
```

and add to the channel object, immediately after the `description:` line:

```ts
      ...(self ? { atom: { links: [{ href: self, rel: 'self', type: 'application/rss+xml' }] } } : {}),
      ...(self ? { sourceNs: { self } } : {}),
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -w core -- feed.test.ts`
Expected: PASS, including the extended no-config test.

- [ ] **Step 8: Full gates**

Run: `npm test -w core && npm run typecheck -w core`
Expected: full suite PASS, `tsc` exits 0.

- [ ] **Step 9: Commit**

```bash
git add core/src/domain/feed.ts core/src/api/logical-routes/read.ts core/test/feed.test.ts
git commit -m "feat(core): feeds advertise where they live (source:self + atom self)

The comments feed carried no self-pointer in any form and the user feed had
only atom:link rel=self (valid.rss.chat selfMissing). Adds source:self to
both and atom:link rel=self to the comments feed.

Extracts commentsFeedUrl so the advertised source:comments feedUrl and that
feed's own self-pointer are built by one function. Both gated on publicUrl,
matching how atom/cloud links already gate.

developed with the help of AI tools"
```

---

### Task 5: Project the markdown already stored *(backfills the converted corpus)*

`core/src/migration/convert.ts:553-559` already persists `contentMarkdown` into `normalized_json` for every v1-converted item. The projector nulls it. This one line makes the whole converted backlog emit `source:markdown` with no migration and no re-poll.

**Files:**
- Modify: `core/src/logical/projector.ts:480` (the `materialOf` normalized type), `:594`
- Test: `core/test/feed.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `materialOf`'s `normalized` type gains `contentMarkdown?: string | null` — Task 6 writes this key.

- [ ] **Step 1: Write the failing test**

Append to `core/test/feed.test.ts`. It writes the key directly into the stored blob, exactly as `convert.ts` does, so it tests the projection independently of Task 6's capture:

```ts
test('comments feed: a remote reply with stored contentMarkdown emits source:markdown', async () => {
  const ctx = await makeApp(CTX)
  const { service, app, repo } = ctx
  const root = await service.createLocalPostAs('alice', 'Alice', 'root post text')
  await acquireFeed(ctx, {
    url: 'https://elsewhere.example/users/gina/feed.xml',
    xml: `<?xml version="1.0"?><rss version="2.0" xmlns:source="http://source.scripting.com/"><channel><title>Gina</title>`
      + `<item><guid isPermaLink="false">origin-guid-93</guid><link>https://elsewhere.example/notes/93</link>`
      + `<description>&lt;p&gt;rendered html&lt;/p&gt;</description><source:inReplyTo>${root.url}</source:inReplyTo></item>`
      + `</channel></rss>`,
  })
  // Simulate what convert.ts:553-559 stores for a v1-converted item.
  const row = repo.raw.prepare(`SELECT id, normalized_json FROM observation_versions_v2 LIMIT 1`).get() as { id: string; normalized_json: string }
  const norm = JSON.parse(row.normalized_json)
  norm.contentMarkdown = 'rendered **markdown**'
  repo.raw.prepare(`UPDATE observation_versions_v2 SET normalized_json = ? WHERE id = ?`).run(JSON.stringify(norm), row.id)

  const body = await (await app.request(`/post/${root.id}/comments.xml`)).text()
  expect(body).toContain('<source:markdown>rendered **markdown**</source:markdown>')
})
```

`makeApp` returns `{ repo, service, app, db, store }` (`core/test/feed.test.ts:77`), so `repo.raw` is available directly.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w core -- feed.test.ts -t 'emits source:markdown'`
Expected: FAIL — no `<source:markdown>` element, because `projector.ts:594` returns null.

- [ ] **Step 3: Widen the normalized type**

In `core/src/logical/projector.ts`, in the `materialOf` signature at line 480 and the matching `JSON.parse` cast at line 484, add `contentMarkdown` to both occurrences of the normalized shape:

```ts
{ keyKind: string; key: string; permalink: string | null; enclosures: EnclosureDto[]; inReplyTo: string | null; contentMarkdown?: string | null; replyContextAuthor?: string | null; replyContextSnippet?: string | null }
```

- [ ] **Step 4: Project it**

Replace `core/src/logical/projector.ts:594`:

```ts
    contentMarkdown: null,
```

with:

```ts
    // convert.ts:553-559 already stores this for every v1-converted item, and
    // acquisition captures it for post-cutover ones. Textcasting's point: the
    // writer's markdown is the original, the HTML is derived.
    contentMarkdown: mat.normalized.contentMarkdown ?? null,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -w core -- feed.test.ts -t 'emits source:markdown'`
Expected: PASS.

- [ ] **Step 6: Full gates, both workspaces**

Run: `npm test -w core && npm run typecheck -w core`
Then, because this changes what remote items render as in the web UI:
Run: `env -u CORE_API_URL npm test -w web && npm run check -w web`
Expected: all PASS. `web/src/lib/server/render.test.ts:9` already pins that a remote item WITH `contentMarkdown` renders the markdown and ignores the HTML — this task is what finally supplies that data, so that test should stay green, not change.

- [ ] **Step 7: Commit**

```bash
git add core/src/logical/projector.ts core/test/feed.test.ts
git commit -m "fix(core): project the remote contentMarkdown already on disk

convert.ts:553-559 has persisted contentMarkdown into normalized_json for
every v1-converted item since the migration; projector.ts:594 threw it away.
One line backfills the whole converted corpus — no migration, no re-poll —
and closes valid.rss.chat markupWithoutMarkdown for those items.

Deliberate presentation change: render.ts:85 takes contentMarkdown at top
precedence, so remote items now render the origin's markdown through our
pipeline instead of its HTML. That path was already built and tested
(render.test.ts:9); it had simply never received data. The sanitizer still
gates every branch.

developed with the help of AI tools"
```

---

### Task 6: Capture `source:markdown` for post-cutover items, and heal

Items v2 acquired natively since cutover have no markdown stored. This captures it going forward and heals existing ones on their next poll.

**Files:**
- Modify: `core/src/logical/acquisition.ts` — `RawItem` (~:114), the RSS adapter branch (~:242-256), `normalized` (~:329), the unchanged branch (~:673-677)
- Test: `core/test/logical-acquisition.test.ts`, `core/test/feed.test.ts`

**Interfaces:**
- Consumes: `materialOf`'s `contentMarkdown` key from Task 5.
- Produces: `normalized.contentMarkdown` written by `parseCandidates`.

- [ ] **Step 1: Write the failing fingerprint test**

Append to `core/test/logical-acquisition.test.ts`:

Reuse the file's existing `RSS()` envelope helper (`core/test/logical-acquisition.test.ts:45`) rather than hand-rolling one. `source:markdown` parses with or without an `xmlns:source` declaration, so the plain envelope is fine.

```ts
test('source:markdown never enters the fingerprint', () => {
  const item = `<item><guid>https://x.example/1</guid><link>https://x.example/1</link><description>body</description>`
  const without = parseCandidates(RSS(item + `</item>`))
  const with_ = parseCandidates(RSS(item + `<source:markdown>**body**</source:markdown></item>`))
  // The 2026-07-25 runaway (763k observation_versions, 2.6GB) was volatile fields
  // in the fingerprint. Markdown rides normalized_json and must never change it.
  expect(with_.candidates[0].fingerprint).toBe(without.candidates[0].fingerprint)
  expect(JSON.parse(with_.candidates[0].normalizedJson).contentMarkdown).toBe('**body**')
  expect(JSON.parse(without.candidates[0].normalizedJson).contentMarkdown ?? null).toBe(null)
})
```

`parseCandidates` is already imported there (`core/test/logical-acquisition.test.ts:5`), and `:59-60` uses the same two-parse fingerprint-comparison shape — follow it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w core -- logical-acquisition.test.ts -t 'never enters the fingerprint'`
Expected: FAIL on the `contentMarkdown` assertion (`undefined` ≠ `'**body**'`). The fingerprint assertion already passes — that half is a regression guard.

- [ ] **Step 3: Capture it**

In `core/src/logical/acquisition.ts`, add to the `RawItem` interface (after the `inReplyTo` field, ~line 121):

```ts
  // rss.chat's source:markdown — the writer's original. RSS only; no other
  // adapter has an equivalent. Rides normalizedJson, NEVER the fingerprint.
  contentMarkdown?: string | null
```

In the RSS adapter branch, add after the `inReplyTo:` line (~:249):

```ts
    contentMarkdown: str(it.sourceNs?.markdown ?? null),
```

In the `normalized` object (~:329), add `contentMarkdown: it.contentMarkdown ?? null`:

```ts
    const normalized = { keyKind, key, permalink: it.link ? normalizePermalink(it.link) : null, inReplyTo: it.inReplyTo, contentMarkdown: it.contentMarkdown ?? null, enclosures: it.enclosures, originFeedUrl, replyContextAuthor: it.replyContextAuthor ?? null, replyContextSnippet: it.replyContextSnippet ?? null }
```

Do **not** touch `canonicalMaterialFor`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w core -- logical-acquisition.test.ts -t 'never enters the fingerprint'`
Expected: PASS.

- [ ] **Step 5: Write the failing heal test**

Append to `core/test/feed.test.ts`:

```ts
test('an unchanged re-poll heals stored markdown without a new version row', async () => {
  const ctx = await makeApp(CTX)
  const { service, repo } = ctx
  const root = await service.createLocalPostAs('alice', 'Alice', 'root post text')
  const SRC = randomUUID()
  const item = (md: string) => `<?xml version="1.0"?><rss version="2.0" xmlns:source="http://source.scripting.com/"><channel><title>Hal</title>`
    + `<item><guid isPermaLink="false">origin-guid-94</guid><link>https://elsewhere.example/notes/94</link>`
    + `<description>body</description><source:inReplyTo>${root.url}</source:inReplyTo>${md}</item>`
    + `</channel></rss>`
  const url = 'https://elsewhere.example/users/hal/feed.xml'
  await acquireFeed(ctx, { url, xml: item(''), sourceId: SRC })
  const countVersions = () => (repo.raw.prepare(`SELECT count(*) AS n FROM observation_versions_v2`).get() as { n: number }).n
  const before = countVersions()

  // Same content ⇒ same fingerprint ⇒ the "unchanged" branch. Markdown is not
  // fingerprinted, so only the heal can put it in normalized_json.
  await acquireFeed(ctx, { url, xml: item('<source:markdown>**body**</source:markdown>'), sourceId: SRC })
  const healed = repo.raw.prepare(`SELECT normalized_json FROM observation_versions_v2 LIMIT 1`).get() as { normalized_json: string }
  expect(JSON.parse(healed.normalized_json).contentMarkdown).toBe('**body**')
  expect(countVersions()).toBe(before) // no new version row
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npm test -w core -- feed.test.ts -t 'heals stored markdown'`
Expected: FAIL — `contentMarkdown` is `undefined`; the unchanged branch only bumps `last_seen_at`.

- [ ] **Step 7: Add the guarded heal**

First widen the cast the loop **already performs** at `core/src/logical/acquisition.ts:646` — do NOT add a second `JSON.parse` of the same blob, which would run per unchanged item per poll, on every feed, forever:

```ts
    const norm = JSON.parse(obs.normalizedJson) as { keyKind: KeyKind; key: string; contentMarkdown?: string | null }
```

Then add beside the other prepared statements (~:641):

```ts
  // Heal: an item already stored WITHOUT markdown gains it on a later poll.
  // Guarded in SQL so it is idempotent by construction and needs no read-back;
  // json_extract matches both key-absent and key-null. No new version row, no
  // job re-pend, no journal effect — deliberately off the churn path.
  const healMarkdown = tx.prepare(`UPDATE observation_versions_v2 SET normalized_json = ? WHERE id = ? AND json_extract(normalized_json, '$.contentMarkdown') IS NULL`)
```

In the unchanged branch, replace lines 675-677:

```ts
        if (Buffer.compare(Buffer.from(priorVersion.canonical_material), Buffer.from(obs.canonicalMaterial)) === 0) {
          bumpVersion.run(committedAt, runId, priorVersion.id) // unchanged
          counters.unchanged++
```

with:

```ts
        if (Buffer.compare(Buffer.from(priorVersion.canonical_material), Buffer.from(obs.canonicalMaterial)) === 0) {
          bumpVersion.run(committedAt, runId, priorVersion.id) // unchanged
          // Markdown is not fingerprinted, so an item stored before capture existed
          // stays markdown-less forever without this. Rewrites the whole blob, so
          // fresh enclosure URLs / replyContext ride along — harmless.
          if (norm.contentMarkdown != null) healMarkdown.run(obs.normalizedJson, priorVersion.id)
          counters.unchanged++
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm test -w core -- feed.test.ts -t 'heals stored markdown'`
Expected: PASS.

- [ ] **Step 9: Full gates, both workspaces**

Run: `npm test -w core && npm run typecheck -w core`
Run: `env -u CORE_API_URL npm test -w web && npm run check -w web`
Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add core/src/logical/acquisition.ts core/test/logical-acquisition.test.ts core/test/feed.test.ts
git commit -m "feat(core): capture remote source:markdown, heal items stored without it

v2 acquisition never captured source:markdown — RawItem had no such field — so
post-cutover remote items emit markup with no markdown and cannot round-trip
(valid.rss.chat markupWithoutMarkdown). Captured in the RSS adapter only; no
other adapter has an equivalent.

It rides normalized_json and NEVER canonicalMaterialFor: fingerprinting it
would re-version every remote item on the next poll of every feed, which is
the 2026-07-25 runaway's exact mechanism. A test pins the fingerprint is
unchanged by its presence.

Items already stored without markdown heal on their next unchanged poll via
one json_extract-guarded UPDATE — no version row, no job re-pend, no journal
effect, idempotent by construction.

developed with the help of AI tools"
```

---

## Deliberately dropped from spec §5

Two "folded" test items in the spec are already covered and are NOT re-added:

- **`source:comments` injection onto an attribute-free guid** — `injectItemElements` keys on the marker `` >${guid}</guid> ``, which matches with or without the attribute, and `core/test/feed.test.ts:313` already exercises injection against a bare permalink guid.
- **A `render.ts` twin extension for remote + markdown** — `web/src/lib/server/render.test.ts:9` already asserts exactly that (`remote('<p>ignored</p>', '**md**')` → `<strong>md</strong>`). Task 5 supplies the data that path was always built for; the assertion needs no change.

## Post-implementation

- [ ] **Whole-branch review** on the most capable model before merge (house flow).
- [ ] **Deploy** to the fleet — four RSC instances confirmed via `cloudron list` on `my.infinitespace.click` (`rsc.rmdes.be`, `alice.rmdes.be`, `bob.rmdes.be`, `rsc.rmendes.net`) plus `skyfleet.blue` on `my.openbuddhism.org`. Confirm the list and canary order first; build from the repo root with `cloudron build -f cloudron/Dockerfile` and NEVER symlink `CloudronManifest.json`/`logo.png`.
- [ ] **Re-run the validator** (spec §6):

```bash
curl -sS -N "https://valid.rss.chat/validatestreaming?url=$(python3 -c \
  "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" \
  "https://rsc.rmdes.be/users/rss.xml")"
```

Expect `replyDoesntPointBack`, `guidNotPermalink`, `selfMissing`, `itemsOutOfOrder` all gone. `sourceNamespaceUnexpected` deliberately remains (spec §3). `urlAnsweredWithAnError` remains (not ours). `markupWithoutMarkdown` clears immediately for v1-converted items and asynchronously for post-cutover ones as feeds poll.

- [ ] **Spot-check remote post bodies in the web UI** before promoting past the first canary — Task 5 is a deliberate render change.
