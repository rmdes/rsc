# Root-Only Timelines and Compact Replies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each conversation once in river-style timelines, keep expanded threads live with replay-safe reply counts, and replace the oversized wedge pill with a compact accessible reply-count control.

**Architecture:** Add an opt-in `topLevel` filter at the core repository/API boundary so SQL filters resolved replies before pagination while preserving existing callers. Core adds authoritative total-descendant counts to root-only HTTP results and new-reply SSE frames. Web river pages consume those frames with a small visible-root count overlay — expanded inline threads stay snapshot-only (today's behavior; rev 1 removed the reconciliation/queue layer) — plus a reusable progressive-enhancement anchor component.

**Spec:** `docs/superpowers/specs/2026-07-22-root-only-timelines-design.md` (**rev 1** — R1–R9 folded; this plan is rev 1 to match).

**Tech Stack:** Node 22 native TypeScript stripping, Hono, Kysely/SQLite, Vitest, SvelteKit, Svelte 5 runes, server-rendered Svelte, plain CSS.

## Global Constraints

- Read `CLAUDE.md`, `AGENTS.md` when present, and `docs/superpowers/specs/2026-07-22-root-only-timelines-design.md` before implementation.
- For core HTTP work, invoke the repository's `.claude/skills/hono/SKILL.md` if available; follow the established Hono validation and `app.request` test patterns.
- For UI work, invoke `ui-ux-pro-max:ui-ux-pro-max` if available and follow `design-system/rsc/MASTER.md`; if that skill is unavailable, state that and use the design-system file directly.
- Use Node 22-compatible erasable TypeScript in `core/src`; no parameter properties.
- Do not change reply storage, feed output/ingest, federation, comments feeds, conversation-page semantics, or author-profile grouping.
- Resolved replies are absent only from river-style timelines; unresolved replies remain visible with their existing context.
- Resolved-reply SSE frames only ever update a visible root's count (when `rootReplyCount` is present) — they are never prepended, never passed to `mergeIncoming`, and never enter expanded/loading inline trees. Expanded threads are snapshot-only; reload repairs.
- Preserve the server-side sanitizer boundary at `/post/:id/thread.json`; do not render un-enriched remote content.
- Keep real anchors and 44×44 CSS-pixel targets for no-JavaScript and accessibility behavior; no raw hex colors or new dependencies.
- Use explicit `git add <paths>` only. Every implementation commit message ends with `developed with the help of AI tools`.
- With Docker running, run core commands in `rsc-core` and web commands in `rsc-web`; unset `CORE_API_URL` for web tests/checks.

---

### Task 1: Add top-level repository filtering and conversation counts

**Files:**
- Modify: `core/src/domain/types.ts`
- Modify: `core/src/domain/repository.ts`
- Modify: `core/src/domain/service.ts`
- Modify: `core/src/storage/sqlite.ts`
- Modify: `core/src/domain/repository-contract.ts`

**Interfaces:**
- Produces: `TimelineFilter` with `topLevel?: true`.
- Produces: `Repository.countThreadRepliesByRootIds(rootIds: string[]): Promise<Map<string, number>>`.
- Preserves: `countRepliesByPostIds()` direct-child semantics.

- [ ] **Step 1: Add failing repository contract tests for top-level selection**

Add a contract test that inserts two roots, a resolved child, a resolved grandchild, and an unresolved reply. Assert the default timeline still returns all five entries, while `topLevel: true` returns both roots plus the unresolved reply and excludes both resolved descendants.

```ts
test('topLevel timeline keeps roots and honest orphans but excludes resolved descendants before pagination', async () => {
  const repo = await makeRepo()
  const a = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
  const insert = (id: string, day: string, over: Partial<Post> = {}) => repo.insertPost({
    id, authorId: a.id, source: 'local', guid: `g-${id}`, title: null,
    content: id, url: null,
    publishedAt: `2026-01-${day}T00:00:00.000Z`,
    createdAt: `2026-01-${day}T00:00:00.000Z`,
    ...over,
  })
  await insert('root-old', '01')
  await insert('reply', '02', { inReplyTo: 'root-old', inReplyToPostId: 'root-old', threadRootId: 'root-old' })
  await insert('nested', '03', { inReplyTo: 'reply', inReplyToPostId: 'reply', threadRootId: 'root-old' })
  await insert('orphan', '04', { inReplyTo: 'https://missing.example/post', inReplyToPostId: null, threadRootId: null })
  await insert('root-new', '05')

  expect((await repo.getTimeline(10)).map((e) => e.id)).toEqual(['root-new', 'orphan', 'nested', 'reply', 'root-old'])
  expect((await repo.getTimeline(10, undefined, { topLevel: true })).map((e) => e.id)).toEqual(['root-new', 'orphan', 'root-old'])

  const page1 = await repo.getTimeline(2, undefined, { topLevel: true })
  const last = page1.at(-1)!
  const page2 = await repo.getTimeline(2, { publishedAt: last.publishedAt, id: last.id }, { topLevel: true })
  expect(page1.map((e) => e.id)).toEqual(['root-new', 'orphan'])
  expect(page2.map((e) => e.id)).toEqual(['root-old'])
})
```

- [ ] **Step 2: Add a failing contract test separating total and direct counts**

```ts
test('conversation counts include every descendant while direct counts stay direct', async () => {
  const repo = await makeRepo()
  const a = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
  const base = { authorId: a.id, source: 'local' as const, title: null, url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' }
  await repo.insertPost({ ...base, id: 'root', guid: 'root', content: 'root' })
  await repo.insertPost({ ...base, id: 'r1', guid: 'r1', content: 'r1', inReplyTo: 'root', inReplyToPostId: 'root', threadRootId: 'root' })
  await repo.insertPost({ ...base, id: 'r2', guid: 'r2', content: 'r2', inReplyTo: 'r1', inReplyToPostId: 'r1', threadRootId: 'root' })

  expect(await repo.countRepliesByPostIds(['root', 'r1'])).toEqual(new Map([['root', 1], ['r1', 1]]))
  expect(await repo.countThreadRepliesByRootIds(['root'])).toEqual(new Map([['root', 2]]))
  expect(await repo.countThreadRepliesByRootIds([])).toEqual(new Map())
})
```

- [ ] **Step 3: Run the focused core tests and confirm the red state**

Run:

```bash
docker exec rsc-core sh -c "cd /app && npm test -w core -- test/sqlite-repository.test.ts"
```

Expected: TypeScript/test failure because `TimelineFilter.topLevel` and `countThreadRepliesByRootIds` do not exist.

- [ ] **Step 4: Add the shared filter type and repository contract**

In `core/src/domain/types.ts`:

```ts
export interface TimelineFilter {
  followedBy?: string
  authorId?: string
  source?: 'local'
  feedType?: 'instance'
  topLevel?: true
}
```

Import it into `repository.ts` and change the interface to:

```ts
getTimeline(limit: number, before?: TimelineCursor, filter?: TimelineFilter): Promise<TimelineEntry[]>
countThreadRepliesByRootIds(rootIds: string[]): Promise<Map<string, number>>
```

Use the same `TimelineFilter` signature in `service.ts` instead of the repeated inline object.

- [ ] **Step 5: Implement SQL filtering and total-descendant counts**

In `SqliteRepository.getTimeline()`, first widen the impl's own inline filter
type at `sqlite.ts:226` to `TimelineFilter` (the fourth of the four filter
sites — interface, impl, service, route; missing it fails typecheck), then add
the filter before `execute()`:

```ts
if (filter?.topLevel) q = q.where('posts.in_reply_to_post_id', 'is', null)
```

Add the grouped count method without altering `countRepliesByPostIds()`:

```ts
async countThreadRepliesByRootIds(rootIds: string[]): Promise<Map<string, number>> {
  if (rootIds.length === 0) return new Map()
  const rows = await this.db
    .selectFrom('posts')
    .select('thread_root_id')
    .select(({ fn }) => fn.countAll().as('n'))
    .where('thread_root_id', 'in', rootIds)
    .groupBy('thread_root_id')
    .execute()
  return new Map(rows.map((r) => [r.thread_root_id as string, Number(r.n)]))
}
```

Expose it unchanged through `createService()`.

- [ ] **Step 6: Run the focused repository tests and core typecheck**

Run:

```bash
docker exec rsc-core sh -c "cd /app && npm test -w core -- test/sqlite-repository.test.ts"
docker exec rsc-core sh -c "cd /app && npm run typecheck -w core"
```

Expected: focused repository suite passes; typecheck exits 0.

- [ ] **Step 7: Commit Task 1**

```bash
git add core/src/domain/types.ts core/src/domain/repository.ts core/src/domain/service.ts core/src/storage/sqlite.ts core/src/domain/repository-contract.ts
git commit -m "feat: add top-level timeline repository mode" -m "developed with the help of AI tools"
```

---

### Task 2: Expose root-only HTTP timelines and opt river loads into them

**Files:**
- Modify: `core/src/api/app.ts`
- Modify: `core/test/api-threading.test.ts`
- Modify: `core/test/timeline-tabs.test.ts`
- Modify: `web/src/lib/api.ts`
- Modify: `web/src/lib/api.test.ts`
- Modify: `web/src/routes/+page.server.ts`
- Modify: `web/src/routes/page.load.test.ts`
- Modify: `web/src/routes/u/[handle]/following/+page.server.ts`
- Modify: `web/src/routes/u/[handle]/following/following.actions.test.ts`

**Interfaces:**
- Produces: `GET /timeline?top_level=1`.
- Produces: `getTimeline(..., { topLevel: true })` web option.
- Consumes: `TimelineFilter` and `countThreadRepliesByRootIds()` from Task 1.

- [ ] **Step 1: Add failing core API tests for validation, composition, and total counts**

Extend `core/test/api-threading.test.ts` with a root, direct reply, nested reply, and orphan. Assert:

```ts
const top = await app.request('/timeline?top_level=1')
expect(top.status).toBe(200)
const body = await top.json() as { timeline: Array<{ id: string; replyCount: number }> }
expect(body.timeline.map((e) => e.id)).toEqual(expect.arrayContaining([rootId, orphanId]))
expect(body.timeline.map((e) => e.id)).not.toEqual(expect.arrayContaining([replyId, nestedId]))
expect(body.timeline.find((e) => e.id === rootId)?.replyCount).toBe(2)
expect((await app.request('/timeline?top_level=true')).status).toBe(400)
```

Extend `timeline-tabs.test.ts` so `top_level=1` composes independently with Local, Federated, Personal, and Public filters; each response excludes a resolved reply but preserves an eligible unresolved reply.

- [ ] **Step 2: Add failing web API and load tests**

In `web/src/lib/api.test.ts`, assert the exact URL:

```ts
await getTimeline(f as unknown as typeof fetch, { topLevel: true })
expect(f).toHaveBeenCalledWith('http://localhost:8787/timeline?top_level=1')
```

In `page.load.test.ts`, capture the timeline request for each resolved tab and assert it contains `top_level=1`. In the following-page load test, assert its timeline request contains both `followed_by=alice` and `top_level=1`. Do not change the author-page load expectation.

- [ ] **Step 3: Run focused tests and confirm failure**

Run:

```bash
docker exec rsc-core sh -c "cd /app && npm test -w core -- test/api-threading.test.ts test/timeline-tabs.test.ts"
docker exec rsc-web sh -c "cd /app && env -u CORE_API_URL npm test -w web -- src/lib/api.test.ts src/routes/page.load.test.ts src/routes/u/[handle]/following/following.actions.test.ts"
```

Expected: failures for missing `top_level` validation/serialization and missing load options.

- [ ] **Step 4: Implement strict API parsing and count selection**

In `createApp()`:

```ts
const topLevelRaw = c.req.query('top_level')
if (topLevelRaw !== undefined && topLevelRaw !== '1') {
  return c.json({ error: 'top_level invalid' }, 400)
}
// Include topLevel only when explicitly requested.
filter = { ...filter, ...(topLevelRaw === '1' ? { topLevel: true as const } : {}) }
const entries = await service.getTimeline(limit, before, filter)
const counts = topLevelRaw === '1'
  ? await service.countThreadRepliesByRootIds(entries.map((e) => e.id))
  : await service.countRepliesByPostIds(entries.map((e) => e.id))
```

Keep `replyCount: counts.get(e.id) ?? 0` and cursor logic unchanged.

- [ ] **Step 5: Implement the web option and opt in river loads**

Extend `getTimeline()` options:

```ts
opts: {
  before?: string
  followedBy?: string
  author?: string
  source?: 'local'
  feedType?: 'instance'
  topLevel?: true
} = {}
```

Append `top_level=1` when true. Pass `topLevel: true` from the home load for every tab and from the following load. Leave author-profile requests unchanged.

- [ ] **Step 6: Run focused tests and static checks**

Run:

```bash
docker exec rsc-core sh -c "cd /app && npm test -w core -- test/api-threading.test.ts test/timeline-tabs.test.ts"
docker exec rsc-core sh -c "cd /app && npm run typecheck -w core"
docker exec rsc-web sh -c "cd /app && env -u CORE_API_URL npm test -w web -- src/lib/api.test.ts src/routes/page.load.test.ts src/routes/u/[handle]/following/following.actions.test.ts"
docker exec rsc-web sh -c "cd /app && env -u CORE_API_URL npm run check -w web"
```

Expected: all focused tests pass; both static checks exit 0.

- [ ] **Step 7: Commit Task 2**

```bash
git add core/src/api/app.ts core/test/api-threading.test.ts core/test/timeline-tabs.test.ts web/src/lib/api.ts web/src/lib/api.test.ts web/src/routes/+page.server.ts web/src/routes/page.load.test.ts web/src/routes/u/\[handle\]/following/+page.server.ts web/src/routes/u/\[handle\]/following/following.actions.test.ts
git commit -m "feat: serve root-only river pages" -m "developed with the help of AI tools"
```

---

### Task 3: Add authoritative reply totals to live and replayed SSE entries

**Files:**
- Modify: `core/src/domain/types.ts`
- Modify: `core/src/api/app.ts`
- Modify: `core/test/sse.test.ts`
- Modify: `web/src/lib/types.ts`
- Modify: `web/src/routes/stream/server.test.ts`

**Interfaces:**
- Produces: optional transient `TimelineEntry.rootReplyCount?: number`.
- Consumes: `countThreadRepliesByRootIds()` from Task 1.
- Preserves: `event: post`, event IDs, inclusive replay, sanitizer enrichment, and edit behavior.

- [ ] **Step 1: Add failing live SSE tests**

Add tests in `core/test/sse.test.ts` that create a root, open the stream, then create a reply. Parse the first `event: post` data object and assert:

```ts
expect(replyFrame).toMatchObject({
  inReplyToPostId: root.id,
  threadRootId: root.id,
  rootReplyCount: 1,
})
```

Create a nested reply and assert its authoritative root total is `2`. Edit that reply and assert the edit frame has `editedAt` but no own `rootReplyCount` property. Emit/create an unresolved reply and assert it has no `rootReplyCount`.

Assert per-frame content only — never cross-frame emit ordering: the count query makes the bus handler async, so frames from closely-spaced posts may interleave (harmless; totals are authoritative).

- [ ] **Step 2: Add failing replay and degradation tests**

For replay, create a root plus two descendants after an anchor, reconnect from the anchor, and assert both replayed reply frames carry the same authoritative total `2` (not deltas).

For degradation, wrap the service passed to `createApp()`:

```ts
const broken = {
  ...service,
  countThreadRepliesByRootIds: async () => { throw new Error('count failed') },
}
```

Assert the reply frame is still delivered and lacks `rootReplyCount`; then create another live root post and assert the stream remains alive.

- [ ] **Step 3: Run focused SSE tests and confirm failure**

Run:

```bash
docker exec rsc-core sh -c "cd /app && npm test -w core -- test/sse.test.ts"
```

Expected: reply frames lack `rootReplyCount`.

- [ ] **Step 4: Add the transient type and a shared SSE enrichment helper**

Add `rootReplyCount?: number` to core and web `TimelineEntry` interfaces. Inside `createApp()`, add a local helper that enriches a batch without N+1 queries:

```ts
async function withRootReplyCounts(entries: TimelineEntry[]): Promise<TimelineEntry[]> {
  const roots = [...new Set(entries
    .filter((e) => e.inReplyToPostId && e.threadRootId && !e.editedAt)
    .map((e) => e.threadRootId as string))]
  if (roots.length === 0) return entries
  try {
    const counts = await service.countThreadRepliesByRootIds(roots)
    return entries.map((e) =>
      e.inReplyToPostId && e.threadRootId && !e.editedAt
        ? { ...e, rootReplyCount: counts.get(e.threadRootId) ?? 0 }
        : e)
  } catch (err) {
    console.error('reply count enrichment failed:', err instanceof Error ? err.message : err)
    return entries
  }
}
```

Use the helper for a one-entry live batch and once for the complete replay batch before writing frames. Do not query for root posts, unresolved replies, or edits. Preserve replay order and the existing subscribe-before-replay sequence.

- [ ] **Step 5: Prove the web SSE proxy preserves the field**

Extend `web/src/routes/stream/server.test.ts` so a sanitized post frame containing `rootReplyCount: 3` retains that value after `contentHtml` enrichment. No proxy implementation change should be needed because it spreads the parsed object.

- [ ] **Step 6: Run focused tests and static checks**

Run:

```bash
docker exec rsc-core sh -c "cd /app && npm test -w core -- test/sse.test.ts"
docker exec rsc-core sh -c "cd /app && npm run typecheck -w core"
docker exec rsc-web sh -c "cd /app && env -u CORE_API_URL npm test -w web -- src/routes/stream/server.test.ts"
docker exec rsc-web sh -c "cd /app && env -u CORE_API_URL npm run check -w web"
```

Expected: focused tests pass; checks exit 0.

- [ ] **Step 7: Commit Task 3**

```bash
git add core/src/domain/types.ts core/src/api/app.ts core/test/sse.test.ts web/src/lib/types.ts web/src/routes/stream/server.test.ts
git commit -m "feat: stream authoritative reply totals" -m "developed with the help of AI tools"
```

---

### Task 4: Create the compact progressive-enhancement reply control

**Files:**
- Create: `web/src/lib/reply-toggle.ts`
- Create: `web/src/lib/reply-toggle.test.ts`
- Create: `web/src/lib/ReplyToggle.svelte`
- Create: `web/src/lib/ReplyToggle.test.ts`
- Modify: `web/src/app.css`

**Interfaces:**
- Produces: `replyToggleLabel(count, expanded, busy): string`.
- Produces: `ReplyToggle` props `count`, `href`, `expanded`, `busy`, `onactivate` (rev 1 — no `enhanced` prop; the fetch-failure fallback is handled by the parent clearing `loading` and the `href` remaining a real link).

- [ ] **Step 1: Add failing label-contract tests**

```ts
expect(replyToggleLabel(1, false, true)).toBe('Loading 1 reply')
expect(replyToggleLabel(2, false, false)).toBe('Show 2 replies')
expect(replyToggleLabel(2, true, false)).toBe('Hide 2 replies')
```

- [ ] **Step 2: Add failing server-render tests for component semantics**

Use `render` from `svelte/server`, following `ReplyContext.test.ts`. Assert the HTML contains the real `href`, visible numeric count, `aria-expanded`, SVG `aria-hidden="true"`, and `aria-busy="true"` only in the busy case. Assert no old `wedge` class or triangle glyph appears.

- [ ] **Step 3: Run focused tests and confirm failure**

Run:

```bash
docker exec rsc-web sh -c "cd /app && env -u CORE_API_URL npm test -w web -- src/lib/reply-toggle.test.ts src/lib/ReplyToggle.test.ts"
```

Expected: missing modules/component.

- [ ] **Step 4: Implement the pure label helper**

```ts
export function replyToggleLabel(count: number, expanded: boolean, busy: boolean): string {
  const replies = `${count} ${count === 1 ? 'reply' : 'replies'}`
  if (busy) return `Loading ${replies}`
  return `${expanded ? 'Hide' : 'Show'} ${replies}`
}
```

- [ ] **Step 5: Implement `ReplyToggle.svelte` with exact click precedence**

```svelte
<script lang="ts">
  import { replyToggleLabel } from './reply-toggle'
  let {
    count,
    href,
    expanded,
    busy = false,
    onactivate,
  }: {
    count: number
    href: string
    expanded: boolean
    busy?: boolean
    onactivate: () => void
  } = $props()
  function activate(event: MouseEvent) {
    event.preventDefault()
    if (!busy) onactivate()
  }
</script>

<a class="reply-toggle" {href} aria-expanded={expanded} aria-busy={busy || undefined}
   aria-label={replyToggleLabel(count, expanded, busy)} onclick={activate}>
  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 8.5-8.5 8.38 8.38 0 0 1 8.5 8.5z"/></svg>
  <span aria-hidden="true">{count}</span>
</a>
```

Without JavaScript the `onclick` never runs and the anchor navigates to the
conversation — the progressive-enhancement fallback needs no prop. No external
icon dependency.

- [ ] **Step 6: Replace `.wedge` styling with compact `.reply-toggle` styling**

Add a transparent, borderless inline-flex control with a 44×44 minimum hit target (via padding on the compact glyph — the tabs' idiom, not `::after`), approximately 1rem SVG, secondary resting color, accent expanded state, muted hover surface, and the existing tokenized focus ring. Leave `.wedge`, `.wedge.light`, and `.wedge .glyph` in place until Task 5 removes all markup consumers.

- [ ] **Step 7: Run focused tests and web check**

Run:

```bash
docker exec rsc-web sh -c "cd /app && env -u CORE_API_URL npm test -w web -- src/lib/reply-toggle.test.ts src/lib/ReplyToggle.test.ts"
docker exec rsc-web sh -c "cd /app && env -u CORE_API_URL npm run check -w web"
```

Expected: helper and render tests pass; check exits 0.

- [ ] **Step 8: Commit Task 4**

```bash
git add web/src/lib/reply-toggle.ts web/src/lib/reply-toggle.test.ts web/src/lib/ReplyToggle.svelte web/src/lib/ReplyToggle.test.ts web/src/app.css
git commit -m "feat: add compact reply-count control" -m "developed with the help of AI tools"
```

---

### Task 5: Integrate root-only live behavior and reply controls across web surfaces

**Files:**
- Modify: `web/src/routes/+page.svelte`
- Modify: `web/src/routes/u/[handle]/following/+page.svelte`
- Modify: `web/src/routes/u/[handle]/+page.svelte`
- Modify: `web/src/lib/ReplyTree.svelte`
- Modify: `web/src/lib/live.ts`
- Modify: `web/src/lib/live.test.ts`
- Modify: `web/src/lib/wedge.ts`
- Modify: `web/src/lib/wedge.test.ts`

**Interfaces:**
- Consumes: `ReplyToggle` from Task 4.
- Produces: visible-root count overlay helper in `live.ts`.
- Removes: root-only river dependency on `hiddenIds()`.

- [ ] **Step 1: Add failing tests for visible-root authoritative count overlays**

Add this pure helper contract to `live.test.ts`:

```ts
const posts = [e('root', { replyCount: 1 })]
expect(overlayVisibleRootCount({}, posts, 'root', 3).root.replyCount).toBe(3)
expect(overlayVisibleRootCount({}, posts, 'off-page', 3)).toEqual({})
expect(overlayVisibleRootCount({ root: e('root', { replyCount: 2 }) }, posts, 'root', 3).root.replyCount).toBe(3)
```

This proves count updates are authoritative/idempotent and never materialize absent roots.

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```bash
docker exec rsc-web sh -c "cd /app && env -u CORE_API_URL npm test -w web -- src/lib/live.test.ts"
```

Expected: `overlayVisibleRootCount` is missing.

- [ ] **Step 3: Implement the count overlay helper**

```ts
export function overlayVisibleRootCount(
  edited: Record<string, TimelineEntry>,
  posts: TimelineEntry[],
  rootId: string,
  count: number,
): Record<string, TimelineEntry> {
  const root = posts.find((p) => p.id === rootId)
  return root ? { ...edited, [rootId]: { ...root, replyCount: count } } : edited
}
```

- [ ] **Step 4: Integrate Home and Following river state**

For both river pages (rev 1 — no `RiverThreads` reducers; today's simple maps
plus a loading guard):

- keep `expanded: Record<string, TimelineEntry[]>` and add
  `loading: Record<string, boolean>`; drop the `hidden` derivation;
- maintain `pageIds`, `edited`, and derived `posts` on Following as Home
  already does (Following gains Home's `mergeIncoming`/`edited` handler —
  today it is prepend-only);
- in `onPost`, branch on `inReplyToPostId` BEFORE the lens: if
  `rootReplyCount` and `threadRootId` are present,
  `edited = overlayVisibleRootCount(edited, posts, entry.threadRootId, entry.rootReplyCount)`;
  then return — a resolved reply is never passed to the lens or
  `mergeIncoming()`, and expanded threads are not touched (snapshot-only);
- for roots/unresolved replies, retain existing lens then `mergeIncoming()`;
- implement `toggleReplies(id)`: collapse if expanded; otherwise
  `if (loading[id]) return`, set loading, `await fetchThread(id)` into
  `expanded[id]`, clear loading; on failure clear loading and leave closed
  (the user can re-click, or follow the permalink);
- render `ReplyToggle` with `count`, `href`, `expanded`, `busy={loading[id]}`,
  and `onactivate`;
- render `ReplyTree` from `expanded[id]`;
- iterate `posts` directly, removing `hiddenIds()` filtering.

- [ ] **Step 5: Integrate Author profile and recursive ReplyTree controls**

On the author profile, preserve grouping and live activity behavior. Add the same per-ID `loading` guard around its existing `fetchThread()` calls and use `ReplyToggle`. Do not apply `topLevel` or river reply suppression — its direct counts are honest (ReplyTree nests collapsed by default, so opening reveals exactly the counted direct children).

In `ReplyTree.svelte`, replace each nested wedge with `ReplyToggle` using direct-child count, `busy={false}`, and the existing local open-state callback. Preserve recursive rendering, `openAll`, highlighting, Reply/source links, and the fully unfolded conversation-page behavior.

- [ ] **Step 6: Remove obsolete duplicate-hiding helpers and CSS**

After `rg "hiddenIds|subtreeIds|class=\"wedge\"|glyph" web/src` shows no consumers except tests/styles, delete `hiddenIds()` and `subtreeIds()` plus their tests, and remove the old `.wedge` CSS. Keep `childrenOf()`, `fetchThread()`, and `.replies` nesting styles.

- [ ] **Step 7: Run all affected web tests and check**

Run:

```bash
docker exec rsc-web sh -c "cd /app && env -u CORE_API_URL npm test -w web -- src/lib/live.test.ts src/lib/wedge.test.ts src/lib/reply-toggle.test.ts src/lib/ReplyToggle.test.ts src/routes/page.load.test.ts src/routes/u/[handle]/following/following.actions.test.ts src/routes/post/[id]/reply.actions.test.ts"
docker exec rsc-web sh -c "cd /app && env -u CORE_API_URL npm run check -w web"
```

Expected: affected tests pass; zero Svelte errors/warnings.

- [ ] **Step 8: Manually verify progressive enhancement in the running stack**

At `http://localhost:5173` verify:

1. Home tabs show roots plus unresolved replies, never resolved reply cards.
2. Reply control is visually compact but keyboard focus and hit area remain clear.
3. With JavaScript, the control expands/collapses inline.
4. With JavaScript disabled, the same anchor opens `/post/<id>`.
5. The conversation page remains fully expanded and author profile replies remain grouped.
6. Both themes retain legible rest/hover/focus/expanded states.

- [ ] **Step 9: Commit Task 5**

```bash
git add web/src/routes/+page.svelte web/src/routes/u/\[handle\]/following/+page.svelte web/src/routes/u/\[handle\]/+page.svelte web/src/lib/ReplyTree.svelte web/src/lib/live.ts web/src/lib/live.test.ts web/src/lib/wedge.ts web/src/lib/wedge.test.ts
git commit -m "feat: render root-only live conversations" -m "developed with the help of AI tools"
```

---

### Task 6: Update live documentation and run full verification

**Files:**
- Modify: `README.md`
- Modify: `design-system/rsc/MASTER.md`

**Interfaces:**
- Documents: root-only rivers, unresolved-reply exception, compact reply control, and full conversation fallback.
- Preserves: historical threading specs unchanged.

- [ ] **Step 1: Update current product and design-system documentation**

In `README.md`, replace wording that implies every reply is a top-level timeline card with:

```md
Each conversation appears once in the river at its root. A compact reply count
expands the sanitized thread inline, while the conversation permalink opens the
complete tree. Replies whose parent is not available remain visible with their
carried reply context instead of being silently discarded.
```

In `MASTER.md`, add the root-only river rule and the `ReplyToggle` specification: outline speech bubble plus count, no persistent pill border, 44×44 minimum target, token colors, visible focus, real-anchor no-JS fallback, and `aria-expanded`/`aria-busy` states. Do not edit historical executed specs.

- [ ] **Step 2: Run the complete core verification suite**

Run:

```bash
docker exec rsc-core sh -c "cd /app && npm test -w core"
docker exec rsc-core sh -c "cd /app && npm run typecheck -w core"
```

Expected: every core test passes and typecheck exits 0.

- [ ] **Step 3: Run the complete web verification suite**

Run:

```bash
docker exec rsc-web sh -c "cd /app && env -u CORE_API_URL npm test -w web"
docker exec rsc-web sh -c "cd /app && env -u CORE_API_URL npm run check -w web"
```

Expected: every web test passes; `svelte-check` reports 0 errors and 0 warnings.

- [ ] **Step 4: Run repository hygiene checks**

```bash
git diff --check
rg "class=\"wedge\"|\.wedge|hiddenIds|subtreeIds" web/src
git status --short
```

Expected: `git diff --check` is silent; the obsolete-symbol search returns no matches; status contains only intentional task files plus pre-existing unrelated user files.

- [ ] **Step 5: Commit Task 6**

```bash
git add README.md design-system/rsc/MASTER.md
git commit -m "docs: describe root-only conversation rivers" -m "developed with the help of AI tools"
```

- [ ] **Step 6: Request final code review**

Invoke `superpowers:requesting-code-review` against the complete implementation range. Require the reviewer to check the approved design’s pagination, unresolved-reply visibility, authoritative SSE counts (idempotent overlay, never optimistic), resolved replies never prepending or entering expanded threads, the duplicate-fetch loading guard on all three expansion handlers, no-JS navigation fallback, and unchanged feeds/conversation/author behavior. Address findings through `superpowers:receiving-code-review`, then rerun the complete verification commands before declaring completion.
