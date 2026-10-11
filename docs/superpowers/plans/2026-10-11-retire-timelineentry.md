# Retire `TimelineEntry` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Core's feed renderers and WebSub push read `LogicalItemDto` directly, so the v1 `TimelineEntry` shape, its adapter `logicalToFeedEntry` and the three v1 push queries are deleted, and a pushed fat-ping body is byte-equal to the pulled feed; web's `RenderEntry` folds into web's `TimelineEntry`.

**Architecture:** Spec: `docs/superpowers/specs/2026-10-10-retire-timelineentry-design.md` (**rev 3**). First pin every pulled wire format with vitest snapshots. Then move push onto the projector, still through the adapter, exactly as `read.ts` does. Then switch the renderers' input type to `LogicalItemDto` for every caller at once. Then delete the v1 leftovers, and finally the web type fold.

**Tech Stack:** Node 22+ native type stripping (no build; no TS parameter properties in `core/src`), Hono, better-sqlite3, feedsmith, vitest; SvelteKit/Svelte 5 for web.

## Global Constraints

- **Pulled outputs never change.** The Task 1 snapshots (personal RSS + JSON, firehose, comments feed, `firehose-v1` JSON) must stay byte-identical through Tasks 2–5. Never update a snapshot (`-u`) after Task 1. A snapshot diff is a bug in your change.
- **Exactly one behaviour change:** after Task 2, the pushed fat-ping body is byte-equal to the pulled feed for the same topic (spec "Behaviour change").
- **The write API JSON is frozen.** `POST/PATCH /posts` and `/me/posts` keep returning `{ post: { ...post, author } }`, typed `PostWithAuthor`.
- `removed` never reaches any feed. It is a same-origin UI signal only.
- **All gates run in the containers.** The dev stack must be up (`docker compose up -d`). Host `node_modules` is stale, so a host `tsc` or `npm test` is meaningless.
  - Core typecheck: `docker compose exec -T core npm run typecheck -w core`
  - Core tests (all): `docker compose exec -T core npm test -w core`
  - Core tests (one file): `docker compose exec -T core npm test -w core -- test/<file>.test.ts`
  - Web tests: `docker compose exec -T web env -u CORE_API_URL npm test -w web`
  - Web check: `docker compose exec -T web npm run check -w web`
- **Git:** shared checkout. Stage explicit paths only (never `git add -A` / `git add .`). Commit messages take no attribution trailer.
- `tsconfig` has no `noUnusedLocals`, so tsc will not catch a dead import. Every step that stops using an imported symbol removes that import explicitly.

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `core/test/logical-feeds.test.ts` | parity snapshots; push==pull test | 1, 2 |
| `core/src/api/logical-routes/public.ts` | `firehoseEntry` exported (test seam), then reads the DTO | 1, 3 |
| `core/src/domain/feed.ts` | renderers; new `feedChannel`, `injectReplyCounts`; adapter deleted | 2, 3 |
| `core/src/api/logical-routes/read.ts` | pulled feed routes use `feedChannel` / `injectReplyCounts`, then pass DTOs | 2, 3 |
| `core/src/domain/push.ts` | fat-ping bodies from the projector | 2, 3 |
| `core/src/domain/bus.ts` | `LocalPostEvent = { authorId, handle }` | 2 |
| `core/src/domain/service.ts` | emits `LocalPostEvent`; returns `PostWithAuthor`; v1 wrappers deleted | 2, 4 |
| `core/src/domain/types.ts` | `PostWithAuthor` added; `TimelineEntry`, `hideResolvedReplyContext` deleted | 2, 4 |
| `core/src/server.ts` | passes `store` to `createPush` | 2 |
| `core/test/dto-helper.ts` (new) | `dto()` / `localAuthor()` / `remoteAuthor()` fixtures | 3 |
| `core/src/domain/repository.ts`, `core/src/storage/sqlite.ts`, `core/src/domain/repository-contract.ts` | v1 queries deleted | 4 |
| `web/src/lib/types.ts`, `logical-types.ts`, `logical-api.ts`, `logical-live.ts`, `Avatar.svelte`, `FeedIcon.svelte` + 5 route pages | one view type; `sourceName` and `live.ts` gone | 5 |

**Order deviation from the spec (deliberate):** the spec's steps 2 (renderers on DTOs) and 3 (push from the projector) are swapped. Converting the renderers first would break `push.ts`, which still passes `Post`s, between commits. Push therefore moves onto the projector first, still through `logicalToFeedEntry` exactly as `read.ts` does, and Task 3 then switches the renderers for every caller at once. The spec's guarantees are unchanged.

**Second deviation:** spec §5 says push.test O5 "re-seeds its remote reply with a real delivery". Instead, O5 is deleted (Task 2 Step 8). Its claim, that push counts a remote reply toward `source:comments` exactly as pull does, is asserted by the `push == pull` test. That test's corpus holds two real reconciled remote replies, and it checks `count="3"` explicitly. Duplicating `seedRemoteReply` into `push.test.ts` would only re-prove what that test proves.

---

### Task 1: Pin the pulled wire formats

**Files:**
- Modify: `core/src/api/logical-routes/public.ts:154` (export `firehoseEntry`)
- Modify: `core/test/logical-feeds.test.ts` (append; imports at top)
- Creates (by vitest): `core/test/__snapshots__/logical-feeds.test.ts.snap`

**Interfaces:**
- Produces: `parityCorpus(repo, store): Promise<{ root: LogicalItemDto; remoteIds: string[] }>` and `stable(s: string): string` in `logical-feeds.test.ts`, both reused by Task 2. `export function firehoseEntry(item: LogicalItemDto, feeds: FeedContext): Record<string, unknown>`.

- [ ] **Step 1: Export `firehoseEntry`**

In `core/src/api/logical-routes/public.ts`, change `function firehoseEntry(` to `export function firehoseEntry(`. That is the only change to this file.

- [ ] **Step 2: Add the imports**

At the top of `core/test/logical-feeds.test.ts`, add:

```ts
import { firehoseEntry } from '../src/api/logical-routes/public.ts'
import type { ProjectionViewer } from '../src/logical/types.ts'
```

- [ ] **Step 3: Append the corpus, the normalizer and the pin test**

Append to the end of `core/test/logical-feeds.test.ts`. The file's existing helpers (`makeApp`, `seedUser`, `seedGuest`, `seedRemoteReply`, `remoteIdForSource`, `drain`, `NOW`) are reused as they are:

```ts
// --- PARITY PIN (retire-TimelineEntry plan, Task 1) -------------------------
// Pins the bytes of every PULLED outbound format over one adversarial corpus, so
// moving the renderers onto LogicalItemDto must leave them unchanged. Never
// re-record these snapshots after they land: a diff is a regression.
//
// Post ids are random per run; stable() renames each UUID to ID<n> in order of
// first appearance, so a snapshot is deterministic.
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
function stable(s: string): string {
  const seen = new Map<string, string>()
  return s.replace(UUID_RE, (u) => { if (!seen.has(u)) seen.set(u, `ID${seen.size}`); return seen.get(u)! })
}

// Everything the renderers branch on: markdown + raw HTML in a local body, a
// url-less local post (guid = id, isPermaLink=false) carrying an XML-illegal NUL,
// a local reply, an edit (atom:updated), a removal notice, a guest post (must be
// absent), two remote replies (fragment permalink guid; opaque guid) and a local
// reply to a REMOTE parent (the projector re-derives its source:inReplyTo).
async function parityCorpus(repo: Awaited<ReturnType<typeof makeApp>>['repo'], store: Awaited<ReturnType<typeof makeApp>>['store']) {
  const PUB = 'https://rsc.test'
  const at = (n: number) => `2026-07-23T00:00:0${n}.000Z`
  seedUser(repo.raw, 'u1', 'alice')
  seedUser(repo.raw, 'u2', 'bob')
  seedGuest(repo.raw, 'g1', 'guest-abc')
  const alice = (await repo.getUser('u1'))!
  const bob = (await repo.getUser('u2'))!
  const guest = (await repo.getUser('g1'))!
  const root = store.createLocalPost({ author: alice, content: 'ROOT **md** & <b>raw</b>', replyToId: null, now: at(1), publicUrl: PUB })
  store.createLocalPost({ author: alice, content: 'URLLESS nul\u0000here', replyToId: null, now: at(2), publicUrl: null })
  store.createLocalPost({ author: bob, content: 'BOBREPLY', replyToId: root.id, now: at(3), publicUrl: PUB })
  store.editLocalPost({ postId: root.id, authorId: alice.id, content: 'ROOT edited **md**', now: at(4) })
  const doomed = store.createLocalPost({ author: alice, content: 'DOOMED', replyToId: null, now: at(5), publicUrl: PUB })
  store.removeLocalPost({ postId: doomed.id, actor: { kind: 'author' }, now: at(6) })
  store.createLocalPost({ author: guest, content: 'GUESTBODY', replyToId: null, now: at(7), publicUrl: PUB })
  seedRemoteReply(repo.raw, { sourceId: 'sA', deliveryKey: { kind: 'permalink', key: 'https://origin.test/reply-a#c1' }, permalink: 'https://origin.test/reply-a#c1', inReplyTo: `${PUB}/post/${root.id}`, content: 'REMOTEFRAG' })
  seedRemoteReply(repo.raw, { sourceId: 'sB', deliveryKey: { kind: 'opaque', key: 'opaque-guid-b' }, permalink: null, inReplyTo: `${PUB}/post/${root.id}`, content: 'REMOTEOPAQUE' })
  drain(store)
  const remoteIds = [remoteIdForSource(repo.raw, 'sA'), remoteIdForSource(repo.raw, 'sB')]
  // Both remote replies fall back to arrival time (published: ''), so they tie on
  // timeline_sort_at and the comments feed would break the tie on their RANDOM ids —
  // a flaky snapshot. Separate them.
  repo.raw.prepare(`UPDATE logical_items_v2 SET timeline_sort_at = ? WHERE id = ?`).run('2026-07-23T00:00:00.500Z', remoteIds[1])
  store.createLocalPost({ author: alice, content: 'REPLYTOREMOTE', replyToId: remoteIds[1], now: at(8), publicUrl: PUB })
  return { root, remoteIds }
}

test('parity pin: every pulled outbound format, byte for byte', async () => {
  const { app, repo, store } = await makeApp()
  const { root, remoteIds } = await parityCorpus(repo, store)
  const text = async (path: string) => {
    const res = await app.request(path)
    expect([path, res.status]).toEqual([path, 200])
    return stable(await res.text())
  }
  const comments = await text(`/post/${root.id}/comments.xml`)
  const firehose = await text('/users/rss.xml')
  // the corpus really exercises what it claims — guards against a vacuous pin
  for (const s of ['BOBREPLY', 'REMOTEFRAG', 'REMOTEOPAQUE']) expect(comments).toContain(s)
  for (const s of ['ROOT edited', 'URLLESS', 'REPLYTOREMOTE', 'isPermaLink="false"']) expect(firehose).toContain(s)
  expect(firehose).not.toContain('GUESTBODY')

  expect(await text('/users/alice/feed.xml')).toMatchSnapshot('alice feed.xml')
  expect(await text('/users/alice/feed.json')).toMatchSnapshot('alice feed.json')
  expect(await text('/users/bob/feed.xml')).toMatchSnapshot('bob feed.xml')
  expect(firehose).toMatchSnapshot('firehose rss.xml')
  expect(comments).toMatchSnapshot('root comments.xml')

  const feeds = { publicUrl: 'https://rsc.test', hubUrl: null, rssCloud: false }
  const ANON: ProjectionViewer = { localAccountId: null, activeSourceIds: [] }
  const items = [
    ...store.snapshot((tx) => tx.projectLocalActivity({ authorId: null, limit: 50 })),
    ...remoteIds.map((id) => store.snapshot((tx) => tx.projectItem(id, ANON))!),
  ]
  expect(stable(JSON.stringify(items.map((d) => firehoseEntry(d, feeds)), null, 1))).toMatchSnapshot('firehose-v1 entries')
})
```

- [ ] **Step 4: Run it to record the snapshots, then run it again to prove they are deterministic**

Run: `docker compose exec -T core npm test -w core -- test/logical-feeds.test.ts`
Expected: PASS, with `Snapshots  6 written`.
Run the same command again.
Expected: PASS, with `6 passed` snapshots and none written. A mismatch on the second run means the output is nondeterministic, for example a timestamp vitest didn't normalize. Report that rather than masking it.

If `store.createLocalPost` rejects the remote parent (`replyToId: remoteIds[1]`), or the fragment-permalink reply never appears in `comments`, **stop and report BLOCKED**. Do not drop the case: it is one the conversion must preserve.

- [ ] **Step 5: Inspect the snapshot file**

Open `core/test/__snapshots__/logical-feeds.test.ts.snap` and confirm:
- `firehose rss.xml` contains `<guid isPermaLink="false">ID…</guid>` for the url-less post, and no NUL character.
- `root comments.xml` contains `<guid>https://origin.test/reply-a#c1</guid>` or its `isPermaLink="false"` form, whichever the current code emits.
- `<guid isPermaLink="false">opaque-guid-b</guid>` is present.
- `firehose-v1 entries` contains an entry whose `author.url` is a remote canonical feed URL or `null`.

- [ ] **Step 6: Full core gate and commit**

Run the core typecheck, then the full core test suite (commands in Global Constraints). Expected: typecheck exit 0; all tests pass.

```bash
git add core/src/api/logical-routes/public.ts core/test/logical-feeds.test.ts core/test/__snapshots__/logical-feeds.test.ts.snap
git commit -m "test(core): pin every pulled outbound feed format before retiring TimelineEntry"
```

---

### Task 2: Push builds its fat-ping bodies from the projector

**Files:**
- Modify: `core/src/domain/feed.ts` (add `FeedChannel`, `feedChannel`, `injectReplyCounts`; widen two renderer params)
- Modify: `core/src/api/logical-routes/read.ts:140-187`
- Modify: `core/src/domain/bus.ts` (whole file)
- Modify: `core/src/domain/types.ts` (add `PostWithAuthor`)
- Modify: `core/src/domain/service.ts:4,37-65,163-178`
- Modify: `core/src/domain/push.ts:1-20,197-283`
- Modify: `core/src/server.ts:51`
- Test: `core/test/logical-feeds.test.ts`, `core/test/push.test.ts`, `core/test/bus.test.ts`

**Interfaces:**
- Consumes: `parityCorpus`, `stable` (Task 1).
- Produces:
  - `feed.ts`: `export type FeedChannel = { handle: string; displayName: string }`, `export function feedChannel(handle: string, items: LogicalItemDto[], fallbackName: string = handle): FeedChannel`, and `export function injectReplyCounts(xml: string, items: LogicalItemDto[], ctx: FeedContext): string`.
  - `bus.ts`: `export interface LocalPostEvent { authorId: string; handle: string }`.
  - `types.ts`: `export type PostWithAuthor = Post & { author: User }`.
  - `push.ts`: `createPush(deps: PushDeps & { store: LogicalStore }): Push` and `Push.onLocalPost(e: LocalPostEvent): Promise<void>`.

- [ ] **Step 1: Write the failing push==pull test (replacing the canary and the push-path guest test)**

In `core/test/logical-feeds.test.ts`:

(a) Add these imports at the top:

```ts
import { createPush } from '../src/domain/push.ts'
import { loadConfig } from '../src/config.ts'
import { hubLinkUrl, type FeedContext } from '../src/domain/feed.ts'
```

(b) Let `makeApp` take the feed context. Change its signature line and its `feeds:` line:

```ts
async function makeApp(feeds: FeedContext = { publicUrl: 'https://rsc.test', hubUrl: null, rssCloud: false }) {
```

```ts
    feeds,
```

(c) Delete two tests outright:
- `'the push-path feed queries exclude guest posts too'`, together with its preceding comment block that starts `// The PUSH twins.`
- `'drift canary: the pulled and pushed feeds select exactly the same posts'`, together with its preceding `// --- DRIFT CANARY` comment block.

(d) Append:

```ts
// --- PUSH == PULL --------------------------------------------------------------
// The successor to the drift canary. RSC used to build its outbound feeds twice
// (pull: the projector; push: v1 repository queries), and that seam leaked twice.
// Push now renders through the same projector calls and renderers as the pull
// routes. This pins that a subscriber's fat-ping body is byte-equal to what it
// would fetch, for every self-hub topic. Any rule added to one path and not the
// other fails here.
async function selfHubApp() {
  const config = loadConfig({ RSC_TOKEN: 't', RSC_AUTH_SECRET: 's', RSC_PUBLIC_URL: 'https://rsc.test', RSC_WEBSUB: 'self' })
  const feeds = { publicUrl: config.publicUrl, hubUrl: hubLinkUrl(config.websub, config.publicUrl), rssCloud: config.rssCloud }
  return { config, ...(await makeApp(feeds)) }
}
async function captureFatPings(ctx: Awaited<ReturnType<typeof selfHubApp>>, topics: Record<string, string>, event: { authorId: string; handle: string }) {
  for (const [callback, topic] of Object.entries(topics)) {
    await ctx.repo.upsertSubscription({ id: callback, protocol: 'websub', topic, callback, callbackHost: 'cb.test', secret: null, expiresAt: '2099-01-01T00:00:00.000Z', createdAt: NOW })
  }
  const bodies = new Map<string, string>()
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    bodies.set(String(url), String(init?.body))
    return new Response('', { status: 200 })
  }) as unknown as typeof fetch
  await createPush({ repo: ctx.repo, config: ctx.config, store: ctx.store, fetchFn }).onLocalPost(event)
  return bodies
}

test('push == pull: every fat-ping body is byte-equal to the pulled feed for its topic', async () => {
  const ctx = await selfHubApp()
  await parityCorpus(ctx.repo, ctx.store)
  const topics = {
    'https://cb.test/alice-xml': 'https://rsc.test/users/alice/feed.xml',
    'https://cb.test/alice-json': 'https://rsc.test/users/alice/feed.json',
    'https://cb.test/firehose': 'https://rsc.test/users/rss.xml',
  }
  const bodies = await captureFatPings(ctx, topics, { authorId: 'u1', handle: 'alice' })
  for (const [callback, topic] of Object.entries(topics)) {
    const pulled = await (await ctx.app.request(new URL(topic).pathname)).text()
    expect([topic, bodies.get(callback)]).toEqual([topic, pulled])
  }
  // Remote replies count toward source:comments on the PUSH path too (was push.test O5):
  // root has bob's local reply + two remote replies.
  expect(bodies.get('https://cb.test/alice-xml')).toContain('<source:comments count="3"')
  // Guests are local-only on the push path too (was 'the push-path feed queries exclude guest posts too').
  expect(bodies.get('https://cb.test/firehose')).toContain('BOBREPLY') // delivered, not vacuous
  for (const body of bodies.values()) expect(body).not.toContain('GUESTBODY')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `docker compose exec -T core npm test -w core -- test/logical-feeds.test.ts`
Expected: FAIL. The current `onLocalPost` sees `entry.source` as `undefined` on the new event, so `undefined !== 'local'` makes it return before delivering anything. `bodies.get(...)` is `undefined` and the equality assertion fails. The Task 1 snapshot test still PASSES.

- [ ] **Step 3: Add `FeedChannel`, `feedChannel`, `injectReplyCounts` to `feed.ts` and widen the channel parameter**

In `core/src/domain/feed.ts`, add directly after the `FeedContext` interface:

```ts
// A personal feed's channel identity — all renderRssFeed/renderJsonFeed read of
// the account.
export type FeedChannel = { handle: string; displayName: string }

// A local account feed's channel: the newest item's local display name, else
// `fallbackName` (an empty feed has no item to read it from). The pulled routes
// pass the handle AS REQUESTED (v1 parity: /users/Alice/feed.xml of an empty feed
// is titled "Alice"); push passes the stored handle, which is exactly what a pull
// of its own topic URL requests. One helper, so the two cannot diverge.
export function feedChannel(handle: string, items: LogicalItemDto[], fallbackName: string = handle): FeedChannel {
  const a = items[0]?.selectedAuthor
  return { handle, displayName: a && a.kind === 'local' ? a.displayName : fallbackName }
}
```

Change the first parameter of `renderRssFeed` and `renderJsonFeed` from `user: User` to `channel: FeedChannel`, and rename `user.` to `channel.` inside both bodies. `User` is structurally a `FeedChannel`, so every existing caller still compiles.

Add directly after `injectSourceComments`:

```ts
// source:comments for every item with direct replies, keyed by the item's EMITTED
// guid. One function for the pulled routes AND push's fat-ping bodies, so both
// count replies the same way (the projector's directReplyCount).
export function injectReplyCounts(xml: string, items: LogicalItemDto[], ctx: FeedContext): string {
  if (!ctx.publicUrl) return xml
  const pub = ctx.publicUrl
  return injectSourceComments(xml, items.filter((d) => d.directReplyCount > 0)
    .map((d) => ({ guid: emittedGuid(logicalToFeedEntry(d)), count: d.directReplyCount, feedUrl: commentsFeedUrl(pub, d.id) })))
}
```

- [ ] **Step 4: Point `read.ts` at the shared helpers**

In `core/src/api/logical-routes/read.ts`:
- Delete the local `function injectComments(...) { ... }` (lines ~140-145).
- Replace every `injectComments(X, Y)` call with `injectReplyCounts(X, Y, feeds)`. There are three: firehose, personal xml, comments.
- In both `/users/:handle/feed.xml` and `/users/:handle/feed.json`, replace the two lines `const author = items[0]?.selectedAuthor` and `const user = { … }` with:

```ts
    const channel = feedChannel((c.req.param('handle') ?? '').toLowerCase(), items, c.req.param('handle') ?? '')
```

  and pass `channel` where `user` was passed (`renderRssFeed(channel, …)`, `renderJsonFeed(channel, …)`).
- Import line 2 becomes:

```ts
import { logicalToFeedEntry, renderFirehoseRss, renderRssFeed, renderJsonFeed, renderCommentsFeed, injectReplyCounts, feedChannel } from '../../domain/feed.ts'
```

  Then remove `LogicalItemDto` from the `../../logical/types.ts` type import if nothing else in `read.ts` uses it (`grep -n LogicalItemDto core/src/api/logical-routes/read.ts`).

- [ ] **Step 5: Narrow the bus event**

Replace `core/src/domain/bus.ts` lines 1-7 (the imports and the first two interface members) so the file begins:

```ts
import { EventEmitter } from 'node:events'

// A committed local post, edit or removal, as its listeners need it: whose feed
// changed. Carries no content — push and the stream re-read under current policy.
export interface LocalPostEvent { authorId: string; handle: string }

export interface EventBus {
  emitNewPost(e: LocalPostEvent): void
  onNewPost(fn: (e: LocalPostEvent) => void): () => void
```

Keep the rest of the interface. In `createEventBus`, change the emit to:

```ts
    emitNewPost(e) { emitter.emit('new-post', e) },
```

- [ ] **Step 6: `PostWithAuthor` and the service emitters**

In `core/src/domain/types.ts`, directly after the `TimelineEntry` line, add:

```ts
// The JSON a local write returns (POST /posts, PATCH /posts/:id and their /me
// twins): the stored post plus its author. A frozen wire shape — mcp/src/tools.ts
// hand-declares it — so it changes only with the API.
export type PostWithAuthor = Post & { author: User }
```

In `core/src/domain/service.ts`:
- Import line 4 becomes `import type { NewLocalUser, PostWithAuthor, User, Post } from './types.ts'`.
- `createLocalPostAs(...)` returns `Promise<PostWithAuthor>`. Its body:

```ts
      const dto = logical.createLocalPost({ author, content, replyToId: replyTo?.id ?? null, now: new Date().toISOString(), publicUrl: publicUrl ?? null })
      const stored = await repo.getPost(dto.id)
      const entry: PostWithAuthor = { ...(stored as Post), author }
      bus.emitNewPost({ authorId: author.id, handle: author.handle })
      return entry
```

  Also update its leading comment: "Read the stored post back as a TimelineEntry" becomes "Read the stored post back (the write API's response shape)".
- `editLocalPost(...)` returns `Promise<PostWithAuthor | { error: 'removed' }>`. Its last lines:

```ts
      const entry: PostWithAuthor = { ...post, content, editedAt: now, author }
      bus.emitNewPost({ authorId: author.id, handle: author.handle })
      return entry
```

- In `deletePost`, replace the four lines from `const stored = await repo.getPost(id)` through `bus.emitNewPost(entry)` with:

```ts
      const author = await repo.getUser(post.authorId)
      bus.emitNewPost({ authorId: post.authorId, handle: (author as User).handle })
```

- [ ] **Step 7: Push from the projector**

In `core/src/domain/push.ts`:
- Replace the import block lines 1-8 with:

```ts
import { createHmac, randomBytes } from 'node:crypto'
import type { Repository } from './repository.ts'
import type { Config } from '../config.ts'
import type { LogicalStore } from '../logical/store.ts'
import type { LocalPostEvent } from './bus.ts'
import { checkCallbackUrl } from './push-guard.ts'
import type { LookupFn } from './push-guard.ts'
import { feedUrls, firehoseUrl, renderRssFeed, renderJsonFeed, renderFirehoseRss, hubLinkUrl, feedChannel, injectReplyCounts, logicalToFeedEntry } from './feed.ts'
import type { User } from './types.ts' // still used by ResolvedTopic
```
- `Push` becomes `onLocalPost(e: LocalPostEvent): Promise<void>`. `PushDeps` is **unchanged**.
- `createPush`'s first lines become:

```ts
export function createPush(deps: PushDeps & { store: LogicalStore }): Push {
  const { repo, config, store } = deps
```

- `onLocalPost`: change the signature to `async onLocalPost(e: LocalPostEvent): Promise<void> {`. Delete the line `if (entry.source !== 'local') return`, because the emitters only ever emit local posts: `deletePost` checks `service.ts:171`, the PATCH routes check `app.ts:290` and `personal.ts:128`, and create is local by construction. Change `feedUrls(config.publicUrl, entry.author.handle)` to `feedUrls(config.publicUrl, e.handle)`.
- In the `config.websub.mode === 'self'` block, replace everything from `const posts = await repo.getPostsByAuthor(...)` through the end of the firehose body construction with the projector version. The full self block:

```ts
        if (config.websub.mode === 'self') {
          const now = new Date().toISOString()
          const ctx = { publicUrl: config.publicUrl, hubUrl: hubLinkUrl(config.websub, config.publicUrl), rssCloud: config.rssCloud }
          // The SAME projector calls and renderers as the pulled routes
          // (api/logical-routes/read.ts), so a fat-ping body is byte-equal to a
          // pull of the same topic (pinned by logical-feeds.test.ts "push == pull").
          const limit = await feedLimit(repo)
          const items = store.snapshot((tx) => tx.projectLocalActivity({ authorId: e.authorId, limit }))
          const channel = feedChannel(e.handle, items)
          for (const [format, topic] of [['xml', topics.xml], ['json', topics.json]] as const) {
            const subs = (await repo.listActiveSubscriptions(topic, now)).filter((s) => s.protocol === 'websub')
            if (subs.length === 0) continue
            // Body regenerated ONCE per topic per event; same body (and HMAC input) for every subscriber.
            const body = format === 'xml'
              ? injectReplyCounts(renderRssFeed(channel, items.map(logicalToFeedEntry), ctx), items, ctx)
              : renderJsonFeed(channel, items.map(logicalToFeedEntry), ctx)
            const contentType = format === 'xml' ? 'application/rss+xml; charset=utf-8' : 'application/feed+json; charset=utf-8'
            for (const sub of subs) {
              const headers: Record<string, string> = {
                'content-type': contentType,
                link: `<${topic}>; rel="self", <${ctx.hubUrl}>; rel="hub"`,
              }
              if (sub.secret) headers['x-hub-signature'] = 'sha256=' + createHmac('sha256', sub.secret).update(body).digest('hex')
              await deliverOnce(fetchFn, sub.callback, body, headers)
            }
          }

          const fhTopic = firehoseUrl(config.publicUrl)
          const fhSubs = (await repo.listActiveSubscriptions(fhTopic, now)).filter((s) => s.protocol === 'websub')
          if (fhSubs.length > 0) {
            const recent = store.snapshot((tx) => tx.projectLocalActivity({ authorId: null, limit }))
            const body = injectReplyCounts(renderFirehoseRss(recent.map(logicalToFeedEntry), ctx), recent, ctx)
            for (const sub of fhSubs) {
              const headers: Record<string, string> = {
                'content-type': 'application/rss+xml; charset=utf-8',
                link: `<${fhTopic}>; rel="self", <${ctx.hubUrl}>; rel="hub"`,
              }
              if (sub.secret) headers['x-hub-signature'] = 'sha256=' + createHmac('sha256', sub.secret).update(body).digest('hex')
              await deliverOnce(fetchFn, sub.callback, body, headers)
            }
          }
        }
```

  The `external` and `rssCloud` blocks are unchanged apart from `entry.author.handle` → `e.handle`, already covered by `topics`.
- In `core/src/server.ts:51`: `const push = createPush({ repo, config, store: logicalStore })`.

- [ ] **Step 8: Update `push.test.ts` and `bus.test.ts` to the new event and deps**

`core/test/push.test.ts`:
- `setup()` returns `store` too: `return { repo, bus, service, config, store }`.
- Add after `setup`:

```ts
// The bus event push receives for a local write.
const ev = (p: { authorId: string; author: { handle: string } }) => ({ authorId: p.authorId, handle: p.author.handle })
```

- Every `createPush({ repo, config, fetchFn: …` becomes `createPush({ repo, config, store, fetchFn: …`, and that test's `const { … } = await setup(…)` destructuring gains `store`. Three call sites use other names:
  - `createPush({ repo: off.repo, config: off.config, store: off.store, fetchFn: … })`
  - `createPush({ repo: ws.repo, config: ws.config, store: ws.store, fetchFn: … })`
  - `push2` in the HMAC test reuses that test's `store`.
- Every `.onLocalPost(X)`, including `push2.` and `offPush.`, becomes `.onLocalPost(ev(X))`.
- In the test `'remote posts and websub-off both produce no pings'`, delete the first half: `const remote = …`, the `push.onLocalPost({ id: 'x', … source: 'remote' … })` line, its `expect(fetchFn).not.toHaveBeenCalled()`, and the `push` created only for it. Rename the test to `'websub-off produces no pings'`. The remote-event guard is gone by design.
- Delete the test `'O5: self mode fat ping counts a REMOTE logical reply (v2) so the push body matches the pull'` entirely. Its NULL-delivery seed is invisible to the projector, and its claim is now asserted with a real remote delivery by the `push == pull` test (`count="3"`).
- `handleWebSubRequest`/`handleRssCloudRequest` calls are untouched (`PushDeps` is unchanged).

`core/test/bus.test.ts`: replace the `import type { TimelineEntry }` line and the `const entry: TimelineEntry = …` line with:

```ts
const entry = { authorId: 'a', handle: 'alice' }
```

- [ ] **Step 9: Run the affected tests, then the full gate**

Run: `docker compose exec -T core npm test -w core -- test/logical-feeds.test.ts test/push.test.ts test/bus.test.ts test/service.test.ts`
Expected: all PASS. Snapshots are unchanged (`0 written`, `0 updated`).
Then run the core typecheck and the full core suite. Expected: exit 0, all pass.

- [ ] **Step 10: Commit**

```bash
git add core/src/domain/feed.ts core/src/api/logical-routes/read.ts core/src/domain/bus.ts core/src/domain/types.ts core/src/domain/service.ts core/src/domain/push.ts core/src/server.ts core/test/logical-feeds.test.ts core/test/push.test.ts core/test/bus.test.ts
git commit -m "feat(core): push builds fat-ping bodies from the projector — byte-equal to the pulled feed"
```

---

### Task 3: The renderers read `LogicalItemDto`; delete the adapter

**Files:**
- Create: `core/test/dto-helper.ts`
- Modify: `core/src/domain/feed.ts` (renderers, helpers; delete `logicalToFeedEntry`)
- Modify: `core/src/api/logical-routes/read.ts`, `core/src/domain/push.ts`, `core/src/api/logical-routes/public.ts:154-174`
- Test: `core/test/feed.test.ts`, `threading.test.ts`, `xml-safety.test.ts`, `feed-edits.test.ts`, `rich-content.test.ts`, `logical-outbound-threading.test.ts`

**Interfaces:**
- Consumes: `FeedChannel`, `feedChannel`, `injectReplyCounts` (Task 2).
- Produces (all in `feed.ts`):
  - `localGuid(d: LogicalItemDto)`, `emittedGuid(d: LogicalItemDto): string`, `itemContentFields(d: LogicalItemDto)`
  - `renderRssFeed(channel: FeedChannel, items: LogicalItemDto[], ctx)` and `renderJsonFeed(channel, items, ctx)`
  - `renderFirehoseRss(items: LogicalItemDto[], ctx)`
  - `renderCommentsFeed(item: LogicalItemDto, replies: LogicalItemDto[], ctx)`
- Produces (`core/test/dto-helper.ts`): `dto(over?)`, `localAuthor(handle?, displayName?, id?)`, `remoteAuthor(displayName?, canonicalFeedUrl?, id?)`.

**Field map** (replaces the adapter; byte-for-byte equivalent to `logicalToFeedEntry` + the old renderers):

| old (`Post`/`TimelineEntry`) | `LogicalItemDto` |
|---|---|
| `source` | `origin` |
| `url` | `permalink` |
| `inReplyTo` | `inReplyToRef` |
| `editedAt` | `updatedAt` |
| `content` | `content ?? ''` |
| `guid` | `wireGuid(d)`, i.e. `origin === 'remote' && originGuid !== null ? originGuid : id` |
| `author.displayName` / `handle` / `feedUrl` | `authorOf(d)`: local gives `{displayName, handle, feedUrl: null}`; remote gives `{displayName, handle: '', feedUrl: canonicalFeedUrl}` |

- [ ] **Step 1: Create the fixture helper**

`core/test/dto-helper.ts`:

```ts
import type { LogicalItemDto, SelectedAuthor } from '../src/logical/types.ts'

// LogicalItemDto fixtures for the feed renderers' unit tests. dto() is a
// top-level LOCAL item by alice with no permalink; override field by field.
export const localAuthor = (handle = 'alice', displayName = 'Alice', id = 'u1'): SelectedAuthor =>
  ({ kind: 'local', id, handle, displayName })

export const remoteAuthor = (displayName = 'Bob', canonicalFeedUrl: string | null = 'https://bob.example/rss.xml', id = 'pub1'): SelectedAuthor =>
  ({ kind: 'remote_publisher', id, displayName, canonicalFeedUrl, profileAvailable: true, attributionLevel: 'bound_single_publisher' })

export function dto(over: Partial<LogicalItemDto> = {}): LogicalItemDto {
  return {
    kind: 'logical_item', id: 'p1', origin: 'local', parentResolutionState: 'none',
    parentLogicalItemId: null, threadRootId: null, selectedAuthor: localAuthor(),
    title: null, content: 'c', contentMarkdown: null, permalink: null, originGuid: null,
    inReplyToRef: null, sourceLink: null, replyContext: null, enclosures: [],
    publishedAt: '2026-01-01T00:00:00.000Z', updatedAt: null, updatedAtProvenance: null,
    directReplyCount: 0, conversationReplyCount: 0,
    classification: { personal: false, federated: false }, removed: false,
    ...over,
  }
}
```

- [ ] **Step 2: Convert the renderer unit tests (they are the failing tests)**

The conversion rule, used in every file below:
- `source` → `origin`; `url` → `permalink`; `inReplyTo` → `inReplyToRef`; `editedAt` → `updatedAt`.
- A remote item's `guid` → `originGuid`.
- A local item's `guid` is gone. Where a test asserts the guid of a permalink-less local item, set `id` to the asserted value.
- `author: User` → `selectedAuthor: localAuthor(…) | remoteAuthor(…)`.
- Drop `authorId`, `createdAt`, `sourceName`, `sourceFeedUrl` and `replyContext*`.
- A `user: User` channel argument → `{ handle, displayName }`.

`core/test/feed.test.ts`:
- Import line 13 becomes `import { renderFirehoseRss, injectSourceComments, localGuid, renderRssFeed } from '../src/domain/feed.ts'`. Add `import { dto } from './dto-helper.ts'`.
- Delete the test `'logicalToFeedEntry never carries the removed flag onto the outgoing feed entry, even for a removed item'` and its preceding 5-line comment. The adapter is gone (spec §5). `removed` is pinned absent from every feed by the Task 1 snapshots, whose corpus has a removed post.
- In `'firehose: RSS 2.0 channel + <source> attribution on every item'`, delete `const alice = …` and set:

```ts
  const entries = [dto({ id: 'p1', content: 'hello **world**', permalink: 'https://tc.example/post/p1', publishedAt: '2026-01-02T00:00:00.000Z' })]
```

- In `'injectSourceComments: element lands inside the right item; xmlns declared once'`, delete `const alice = …` and set:

```ts
  const entries = [dto({ id: 'guid-1', content: 'x', publishedAt: '2026-01-02T00:00:00.000Z' })]
```

- In `"a body quoting another item's guid element cannot steal that item's source:comments"`, delete `const alice = …` and replace the `entry` helper with:

```ts
  const entry = (id: string, content: string, url: string) => dto({ id, content, permalink: url, publishedAt: '2026-01-02T00:00:00.000Z' })
```

- In `'injectSourceComments still matches a guid feedsmith CDATA-wrapped (& in the permalink)'`, delete `const alice = …` and replace the `entry` helper with:

```ts
  const entry = (id: string, url: string) => dto({ id, content: `body ${id}`, permalink: url, publishedAt: '2026-01-02T00:00:00.000Z' })
```

- Replace the two `localGuid` tests with:

```ts
test('localGuid: permalink-bearing item → bare permalink guid, no isPermaLink key', () => {
  const d = dto({ id: 'uuid-abc', permalink: 'https://cast.example.com/post/abc' })
  expect(localGuid(d)).toEqual({ value: 'https://cast.example.com/post/abc' })
  expect('isPermaLink' in localGuid(d)).toBe(false)
})

test('localGuid: permalink-less item → its id with isPermaLink false', () => {
  expect(localGuid(dto({ id: 'uuid-xyz' }))).toEqual({ value: 'uuid-xyz', isPermaLink: false })
})
```

- In `'the WebSub fat-ping path is gated too: a hostile stored ref never reaches rendered RSS'`:
  - Replace its 3-line leading comment with: `// itemContentFields gates EVERY render path itself (safeReplyRef) — defense in depth behind the projector's own gate, since a renderer must never trust its input.`
  - Replace the `hostile` and `user` declarations with:

```ts
  const hostile = dto({ id: 'p1', content: 'body', permalink: 'https://cast.example.com/post/p1', publishedAt: NOW, inReplyToRef: 'javascript:alert(1)' })
  const user = { handle: 'alice', displayName: 'Alice' }
```

  - Change `{ ...hostile, inReplyTo: 'yt:video:dQw4w9WgXcQ' }` to `{ ...hostile, inReplyToRef: 'yt:video:dQw4w9WgXcQ' }`, and `{ ...hostile, inReplyTo: bad }` to `{ ...hostile, inReplyToRef: bad }`.

`core/test/threading.test.ts`:
- Import line 5 becomes `import { dto, localAuthor, remoteAuthor } from './dto-helper.ts'`. Delete the `user`, `remoteAuthor`, `entry` and `post` consts (lines 32-35). Keep `ctx`.
- Add after `ctx`: `const channel = { handle: 'alice', displayName: 'Alice' }`.
- `'RSS out: …'`:

```ts
  const xml = renderRssFeed(channel, [dto({ inReplyToRef: 'https://a.ex/1' }), dto({ id: 'p2', inReplyToRef: 'bare-guid-ref' }), dto({ id: 'p3' })], ctx)
```

- `'renderCommentsFeed: one item per reply, …'`:

```ts
  const parent = dto({ id: 'root', title: 'Root', content: 'root body' })
  const replies = [
    dto({ id: 'c1', content: 'first reply', inReplyToRef: 'root-guid', publishedAt: '2026-01-02T00:00:00.000Z' }),
    dto({ id: 'c2', content: 'second reply', inReplyToRef: 'root-guid', publishedAt: '2026-01-03T00:00:00.000Z' }),
  ]
```

- `'renderCommentsFeed: each reply carries core <source> naming its author'`:

```ts
  const parent = dto({ id: 'root', title: 'Root', content: 'root body' })
  const replies = [
    dto({ id: 'c1', content: 'local reply', inReplyToRef: 'root-guid', selectedAuthor: localAuthor() }), // Alice, local
    dto({ id: 'c2', origin: 'remote', originGuid: 'c2-guid', content: 'remote reply', inReplyToRef: 'root-guid', selectedAuthor: remoteAuthor('Bob', 'https://bob.example/rss.xml') }),
  ]
```

`core/test/xml-safety.test.ts`:
- Import line 3 becomes `import type { LogicalItemDto } from '../src/logical/types.ts'`, plus `import { dto, remoteAuthor } from './dto-helper.ts'`.
- Replace `U` and `P` with:

```ts
const A = (n: string) => remoteAuthor(n, 'https://o.example/f.xml')
const P = (over: Partial<LogicalItemDto>): LogicalItemDto => dto({
  id: 'p1', origin: 'remote', originGuid: 'g1', content: 'body',
  permalink: 'https://o.example/1', publishedAt: NOW, selectedAuthor: A('Author'), ...over,
})
```

- The case list becomes:

```ts
      ['content', renderFirehoseRss([P({ content: bad })], CTX)],
      ['title', renderFirehoseRss([P({ title: bad })], CTX)],
      ['markdown', renderFirehoseRss([P({ contentMarkdown: bad })], CTX)],
      ['authorName', renderFirehoseRss([P({ selectedAuthor: A(bad) })], CTX)],
      ['guid', renderFirehoseRss([P({ originGuid: bad, permalink: null })], CTX)],
      // channel-level: the comments feed builds its <title> from the post body, so a
      // poisoned item breaks the CHANNEL element, not just its own <item>.
      ['commentsChannel', renderCommentsFeed(P({ content: bad }), [], CTX)],
      ['userFeed', renderRssFeed({ handle: '', displayName: 'A' }, [P({ content: bad })], CTX)],
```

- The rich test: `renderFirehoseRss([P({ content: rich, title: rich, selectedAuthor: A(rich) })], CTX)`.

`core/test/feed-edits.test.ts`:
- Imports become `import { renderRssFeed, renderFirehoseRss, renderJsonFeed } from '../src/domain/feed.ts'` and `import { dto } from './dto-helper.ts'`.
- Replace `user` and `post()` with:

```ts
const user = { handle: 'alice', displayName: 'Alice' }
const post = (over: Parameters<typeof dto>[0] = {}) => dto({ content: 'hi', ...over })
```

- Every `post({ editedAt: X })` becomes `post({ updatedAt: X })`.
- The firehose line becomes `expect(renderFirehoseRss([post({ updatedAt: '2026-02-02T00:00:00.000Z' })], ctx)).toContain('<atom:updated>2026-02-02T00:00:00.000Z</atom:updated>')`, and the `const entry: TimelineEntry = …` line is deleted.

`core/test/rich-content.test.ts`:
- Import line 4 becomes `import { dto } from './dto-helper.ts'`.
- Replace `alice` and `basePost` with:

```ts
const alice = { handle: 'alice', displayName: 'Alice' }
const basePost = dto({ id: 'p1', content: '' })
```

- `remote` becomes `{ ...basePost, id: 'p2', origin: 'remote' as const, originGuid: 'g-2', content: '<p>as-authored &amp; untouched</p>', contentMarkdown: '**their** source' }`.
- `reply` becomes `{ ...basePost, content: '**re** body', inReplyToRef: 'https://a.ex/1' }`.

`core/test/logical-outbound-threading.test.ts`:
- Rewrite the test `'cutover identity: …'` so its body keeps the user/post inserts but drops the v1 renderer half:

```ts
test('cutover identity: a v1-created post (UUID guid column, absolute url) emits its url as the bare guid', async () => {
  const { repo, app } = await v2app(PUB)
  // A v1-shaped local post: stored url ABSOLUTE, guid a UUID (v1's create).
  const id = 'p-cut'
  const guid = '11111111-1111-1111-1111-111111111111'
  const url = `${PUB}/post/${id}`
  repo.raw.prepare(`INSERT INTO users (id, kind, handle, display_name, feed_url, created_at) VALUES ('u1','local','alice','Alice',NULL,?)`).run(NOW)
  repo.raw.prepare(`INSERT INTO posts (id, author_id, source, guid, title, content, url, published_at, created_at, in_reply_to, in_reply_to_post_id, thread_root_id, source_name, source_feed_url, content_markdown, edited_at, reply_context_author, reply_context_snippet) VALUES (?, 'u1','local',?,NULL,'BODY',?,?,?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`).run(id, guid, url, NOW, NOW)
  // rss.chat permalink-guid: the absolute url IS the guid — never the UUID column
  expect(guidOf(await (await app.request('/users/alice/feed.xml')).text())).toBe(url)
})
```

- Remove the `renderRssFeed` import. Remove `User`/`Post` from the type imports if they are now unused (`grep -n "\bUser\b\|\bPost\b" core/test/logical-outbound-threading.test.ts`).

- [ ] **Step 3: Run the converted tests to verify they fail**

Run: `docker compose exec -T core npm run typecheck -w core`
Expected: FAIL. Errors are in the 6 test files: DTOs passed where `Post`/`TimelineEntry` is expected.

- [ ] **Step 4: Convert `feed.ts`**

In `core/src/domain/feed.ts`:
- Import line 3 is deleted (`Post`, `User`, `TimelineEntry` are no longer used). `LogicalItemDto` is already imported.
- Delete `logicalToFeedEntry` and its whole leading comment block (lines 9-48).
- Add, directly above `localGuid`:

```ts
// The guid an item carries on the wire before localGuid's permalink rule. A
// remote item re-emits its ORIGIN wire guid, so the peer dedupes its own item back
// (v1 parity: posts.guid); a local item — or a remote one with no stored origin
// guid — uses its id. (Local items never have an originGuid.)
function wireGuid(d: LogicalItemDto): string {
  return d.origin === 'remote' && d.originGuid !== null ? d.originGuid : d.id
}

// An item's author as the renderers name it. A remote publisher has no handle
// here, and its feed is its origin's (canonicalFeedUrl, possibly unknown).
function authorOf(d: LogicalItemDto): { displayName: string; handle: string; feedUrl: string | null } {
  const a = d.selectedAuthor
  return a.kind === 'local'
    ? { displayName: a.displayName, handle: a.handle, feedUrl: null }
    : { displayName: a.displayName, handle: '', feedUrl: a.canonicalFeedUrl }
}
```

- `localGuid` and `emittedGuid`, with their comments unchanged except that "stored url" now reads "permalink":

```ts
export function localGuid(d: LogicalItemDto): { value: string; isPermaLink?: false } {
  return d.permalink !== null ? { value: d.permalink } : { value: wireGuid(d), isPermaLink: false }
}

export function emittedGuid(d: LogicalItemDto): string {
  return d.origin === 'local' ? localGuid(d).value : wireGuid(d)
}
```

- `itemContentFields`. The first comment line stays; the rest of the comment is replaced as shown:

```ts
export function itemContentFields(d: LogicalItemDto) {
  // EVERY render path funnels through here — the pulled feeds, push's fat-ping
  // bodies and the firehose-v1 JSON. safeReplyRef gates here as well as in the
  // projector: a renderer never trusts its input.
  const ref = safeReplyRef(d.inReplyToRef)
  const reply = ref ? replyWireElements(ref) : undefined
  const content = d.content ?? ''
  const markdown = d.origin === 'local' ? content : d.contentMarkdown ?? undefined
  const sourceNs = { ...(reply?.sourceNs ?? {}), ...(markdown ? { markdown } : {}) }
  return {
    description: d.origin === 'local' ? renderMarkdown(content) : content,
    ...(Object.keys(sourceNs).length ? { sourceNs } : {}),
    ...(reply?.thr ? { thr: reply.thr } : {}),
  }
}
```

- `renderRssFeed(channel: FeedChannel, items: LogicalItemDto[], ctx: FeedContext)`. Its `items:` mapping:

```ts
      items: items.map((d) => ({
        ...(d.title !== null ? { title: d.title } : {}), // Textcasting: never synthesize a title
        guid: localGuid(d),
        ...(d.permalink !== null ? { link: d.permalink } : {}),
        pubDate: d.publishedAt,
        ...(d.updatedAt ? { atom: { updated: d.updatedAt } } : {}),
        ...itemContentFields(d),
      })),
```

- `renderFirehoseRss(items: LogicalItemDto[], ctx: FeedContext)`. Its `items:` mapping:

```ts
      items: items.map((d) => ({
        ...(d.title !== null ? { title: d.title } : {}),
        guid: localGuid(d),
        ...(d.permalink !== null ? { link: d.permalink } : {}),
        pubDate: d.publishedAt,
        // RSS core <source>: the item's author and their personal feed.
        ...(ctx.publicUrl ? { source: { title: authorOf(d).displayName, url: feedUrls(ctx.publicUrl, authorOf(d).handle).xml } } : {}),
        ...(d.updatedAt ? { atom: { updated: d.updatedAt } } : {}),
        ...itemContentFields(d),
      })),
```

- `authorSourceUrl(author: { handle: string; feedUrl: string | null }, ctx: FeedContext)`, with an unchanged body.
- `renderCommentsFeed(item: LogicalItemDto, replies: LogicalItemDto[], ctx: FeedContext)`. Head:

```ts
  const body = item.content ?? '' // load-bearing ?? '': Array.from(null) would throw
  const chars = Array.from(body) // code-point safe: .length/.slice on a string split surrogate pairs
  const label = item.title ?? (chars.length > 60 ? `${chars.slice(0, 60).join('')}…` : body)
  const self = ctx.publicUrl ? commentsFeedUrl(ctx.publicUrl, item.id) : null
```

  In the channel object: `link: item.permalink ?? ctx.publicUrl ?? 'https://rsc.invalid',`. The `replies` mapping keeps its long guid comment verbatim, with field names updated:

```ts
      items: replies.map((d) => {
        const author = authorOf(d)
        const srcUrl = authorSourceUrl(author, ctx)
        const guid = wireGuid(d)
        return {
          ...(d.title !== null ? { title: d.title } : {}),
          // (existing comment block about local vs remote guid — keep verbatim)
          guid: d.origin === 'local' ? localGuid(d) : { value: guid, ...((normalizePermalink(guid) ?? guid) === d.permalink ? {} : { isPermaLink: false }) },
          ...(d.permalink !== null ? { link: d.permalink } : {}),
          pubDate: d.publishedAt,
          // (existing <source> comment — keep verbatim)
          ...(srcUrl ? { source: { title: author.displayName, url: srcUrl } } : {}),
          ...itemContentFields(d),
        }
      }),
```

- `renderJsonFeed(channel: FeedChannel, items: LogicalItemDto[], ctx: FeedContext)`. Its `items:` mapping:

```ts
      items: items.map((d) => ({
        id: localGuid(d).value,
        ...(d.title !== null ? { title: d.title } : {}),
        ...(d.origin === 'local'
          ? { content_html: renderMarkdown(d.content ?? ''), content_text: d.content ?? '' }
          : { content_text: d.content ?? '' }),
        ...(d.permalink !== null ? { url: d.permalink } : {}),
        date_published: d.publishedAt,
        ...(d.updatedAt ? { date_modified: d.updatedAt } : {}),
      })),
```

- `injectReplyCounts`: `guid: emittedGuid(d)`, with no adapter.

- [ ] **Step 5: Convert the three callers**

`core/src/api/logical-routes/read.ts`:
- Every `items.map(logicalToFeedEntry)` / `data.replies.map(logicalToFeedEntry)` becomes `items` / `data.replies`.
- `renderCommentsFeed(logicalToFeedEntry(data.item), …)` becomes `renderCommentsFeed(data.item, …)`.
- Drop `logicalToFeedEntry` from the import.

`core/src/domain/push.ts`:
- `items.map(logicalToFeedEntry)` / `recent.map(logicalToFeedEntry)` become `items` / `recent`.
- Drop `logicalToFeedEntry` from the import.

`core/src/api/logical-routes/public.ts`:
- Import line 8 becomes `import { itemContentFields } from '../../domain/feed.ts'`.
- `firehoseEntry`, keeping `export` and the existing `contentMarkdown` comment:

```ts
export function firehoseEntry(item: LogicalItemDto, feeds: FeedContext): Record<string, unknown> {
  const { description, sourceNs } = itemContentFields(item)
  const a = item.selectedAuthor
  const authorUrl = a.kind === 'local' ? (feeds.publicUrl ? `${feeds.publicUrl}/u/${a.handle}` : null) : a.canonicalFeedUrl
  return {
    model: 'firehose-v1',
    kind: 'upsert',
    id: item.id,
    title: item.title,
    content: description,
    // (existing contentMarkdown comment — keep, with "entry.contentMarkdown" → "item.contentMarkdown")
    contentMarkdown: sourceNs?.markdown ?? null,
    url: item.permalink,
    publishedAt: item.publishedAt,
    author: { displayName: a.displayName, url: authorUrl },
    inReplyTo: item.inReplyToRef,
  }
}
```

- [ ] **Step 6: Run the gates**

Run the core typecheck. Expected: exit 0.
Run the full core suite. Expected: all PASS. The 6 Task 1 snapshots are unchanged (`0 written`, `0 updated`), and `push == pull` passes.
Run `grep -rn "logicalToFeedEntry" core/src core/test`. Expected: only the two comments `core/src/logical/types.ts:95` and `core/src/logical/projector.ts:614`, reworded in Task 4.

- [ ] **Step 7: Commit**

```bash
git add core/test/dto-helper.ts core/src/domain/feed.ts core/src/api/logical-routes/read.ts core/src/domain/push.ts core/src/api/logical-routes/public.ts core/test/feed.test.ts core/test/threading.test.ts core/test/xml-safety.test.ts core/test/feed-edits.test.ts core/test/rich-content.test.ts core/test/logical-outbound-threading.test.ts
git commit -m "refactor(core): feed renderers read LogicalItemDto; delete logicalToFeedEntry"
```

---

### Task 4: Delete the v1 leftovers

**Files:**
- Modify: `core/src/domain/repository.ts:1,24-26`
- Modify: `core/src/storage/sqlite.ts:5,7,43-50,143-~190`
- Modify: `core/src/domain/repository-contract.ts` (4 tests plus the `seedLegacyPost` helper)
- Modify: `core/src/domain/service.ts` (3 wrappers)
- Modify: `core/src/domain/types.ts:41-47,51-55`
- Modify: `core/src/logical/types.ts:95`, `core/src/logical/projector.ts:614` (comments)
- Test: `core/test/service.test.ts:40`, `core/test/migrations.test.ts:16,96`, `core/test/api-follows.test.ts:116-117`, `core/test/feed.test.ts` (`seedAlice` + 3 call sites)

**Interfaces:**
- Consumes: nothing new. Deletes `Repository.getPostsByAuthor`, `Repository.getRecentLocalPosts`, `Repository.countRepliesByPostIds`, the service wrappers of the same names, `TimelineEntry` and `hideResolvedReplyContext`.

- [ ] **Step 1: Re-grep every symbol for remaining callers**

Run:

```bash
grep -rn "getPostsByAuthor\|getRecentLocalPosts\|countRepliesByPostIds\|hideResolvedReplyContext\|joinedRowToEntry\|JoinedRow\|TimelineEntry" core/src core/test mcp/src
```

Expected callers are only the definitions and the sites listed in this task, plus one legitimate comment: `mcp/src/tools.ts:99` mentions *web's* `TimelineEntry` (it stays). Any other hit is a caller this plan missed: **stop and report it**.

- [ ] **Step 2: Repoint the test callers first (still green before the deletions)**

`core/test/service.test.ts`, in `'handles are lowercased, …'`:

```ts
  expect(repo.raw.prepare(`SELECT content FROM posts WHERE author_id = ? ORDER BY content`).all(alice!.id)).toEqual([{ content: 'first' }, { content: 'second' }])
```

`core/test/migrations.test.ts:16`:

```ts
  expect(repo.raw.prepare(`SELECT COUNT(*) AS n FROM posts`).get()).toEqual({ n: 0 })
```

`core/test/migrations.test.ts:96`:

```ts
  expect((await repo.getPost('p1'))?.content).toBe('kept')
```

`core/test/api-follows.test.ts:116-117`: replace the two lines (`await service.createLocalPostAs('x', 'X', 'x1')` and `const post = (await service.getRecentLocalPosts(10))[0]!`) with:

```ts
  const post = await service.createLocalPostAs('x', 'X', 'x1')
```

`core/test/feed.test.ts`: `seedAlice` returns the first post:

```ts
async function seedAlice(service: Awaited<ReturnType<typeof makeApp>>['service']) {
  const first = await service.createLocalPostAs('alice', 'Alice', 'first body')
  await service.createLocalPostAs('alice', 'Alice', 'second body')
  return first
}
```

In the three tests that do `await seedAlice(service)` followed by `const root = (await service.getRecentLocalPosts(10)).find((p) => p.content === 'first body')!` (`'firehose emits bare permalink guids …'`, `'comments feed carries per-reply core <source> …'` and `'a RSC conversation is walkable …'`), replace both lines with:

```ts
  const root = await seedAlice(service)
```

Run: `docker compose exec -T core npm test -w core -- test/service.test.ts test/migrations.test.ts test/api-follows.test.ts test/feed.test.ts`
Expected: all PASS.

- [ ] **Step 3: Delete the v1 queries, types and helpers**

- `core/src/domain/repository.ts`: delete the three method lines (24-26). Remove `TimelineEntry` from the import on line 1.
- `core/src/storage/sqlite.ts`:
  - Delete `type JoinedRow …` and `function joinedRowToEntry …` (lines 43-48).
  - Delete the comment block starting `// local_only = 0 on both feed queries below` plus the methods `getPostsByAuthor`, `getRecentLocalPosts` and `countRepliesByPostIds`, all of them, through `countRepliesByPostIds`'s closing brace.
  - Remove `TimelineEntry` from the line-5 type import, and delete line 7 (`import { hideResolvedReplyContext } …`).
  - `FeedType` is still used by `UsersTable`, so keep it.
- `core/src/domain/repository-contract.ts`: delete the tests `'getPostsByAuthor returns only that author, …'`, `'countRepliesByPostIds keys on resolved ids only'`, `'countRepliesByPostIds counts direct replies only, …'` and `'getRecentLocalPosts: local authors only, …'`. Delete the `seedLegacyPost` helper (line ~23), whose only callers were two of those tests. Re-grep `seedLegacyPost` to confirm 0 hits.
- `core/src/domain/service.ts`: delete the wrappers `countRepliesByPostIds(ids)`, `getPostsByAuthor(authorId, limit)` and `getRecentLocalPosts(limit)`.
- `core/src/domain/types.ts`: delete `hideResolvedReplyContext` with its 3-line comment (lines 41-47), and `TimelineEntry` with its 4-line `rootReplyCount` comment (lines 51-55).

- [ ] **Step 4: Reword the stale comments**

- `core/src/logical/types.ts:95`: `// logicalToFeedEntry (domain/feed.ts) must never wire it into the outbound feed.` becomes `// the feed renderers (domain/feed.ts) must never emit it.`
- `core/src/logical/projector.ts:614`: `// id (logicalToFeedEntry emits guid = dto.id === post.id in the null-url fallback —` becomes `// id (localGuid, domain/feed.ts, emits guid = dto.id in the null-permalink fallback —`.

- [ ] **Step 5: Completion test and gates**

Run:

```bash
grep -rn "logicalToFeedEntry\|TimelineEntry\|getPostsByAuthor\|getRecentLocalPosts\|countRepliesByPostIds\|hideResolvedReplyContext\|JoinedRow" core/src core/test
```

Expected: no output.
Run the core typecheck (exit 0) and the full core suite (all PASS, snapshots unchanged).

- [ ] **Step 6: Commit**

```bash
git add core/src/domain/repository.ts core/src/storage/sqlite.ts core/src/domain/repository-contract.ts core/src/domain/service.ts core/src/domain/types.ts core/src/logical/types.ts core/src/logical/projector.ts core/test/service.test.ts core/test/migrations.test.ts core/test/api-follows.test.ts core/test/feed.test.ts
git commit -m "refactor(core): delete TimelineEntry and the v1 push queries"
```

---

### Task 5: Web — one view type, no dead fields, no dead live module

Invoke `svelte-skills:svelte-runes` before editing `.svelte` files (a `$props` destructure changes).

**Files:**
- Modify: `web/src/lib/types.ts:1-41`
- Modify: `web/src/lib/logical-types.ts:200-240`, `web/src/lib/logical-api.ts:6,33,53,68`
- Modify: `web/src/lib/logical-live.ts:1-12`, `web/src/lib/logical-live.test.ts`
- Delete: `web/src/lib/live.ts`, `web/src/lib/live.test.ts`, `web/src/lib/LiveTimeline.svelte`
- Modify: `web/src/lib/Avatar.svelte`, `web/src/lib/FeedIcon.svelte`, `web/src/lib/ReplyTree.svelte:39-40`, `web/src/routes/+page.svelte:196-200`, `web/src/routes/post/[id]/+page.svelte:87-88`, `web/src/routes/u/[handle]/+page.svelte:101-102`, `web/src/routes/u/[handle]/following/+page.svelte:136-145`, `web/src/routes/p/[publisherId]/+page.svelte:29`

**Interfaces:**
- Produces: web `TimelineEntry` gains `enclosures?: EnclosureDto[]` and loses `sourceName`. `RenderEntry` is deleted. `overlayVisibleRootCount` is now exported from `logical-live.ts`. `Avatar`/`FeedIcon` no longer take `sourceName`.

- [ ] **Step 1: Move `overlayVisibleRootCount` and its test (the failing test first)**

In `web/src/lib/logical-live.test.ts`:
- Import line 2 becomes `import { applyLiveEvent, insertSorted, overlayVisibleRootCount, type LiveState } from './logical-live.ts'`.
- Append:

```ts
describe('overlayVisibleRootCount', () => {
	it('replaces a visible root count with the server total, and never materializes an absent root', () => {
		const posts = [e('root', 'T1', { replyCount: 1 })]
		expect(overlayVisibleRootCount({}, posts, 'root', 3).root.replyCount).toBe(3)
		expect(overlayVisibleRootCount({}, posts, 'off-page', 3)).toEqual({})
		expect(overlayVisibleRootCount({ root: e('root', 'T1', { replyCount: 2 }) }, posts, 'root', 3).root.replyCount).toBe(3)
	})
})
```

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- src/lib/logical-live.test.ts`
Expected: FAIL (`overlayVisibleRootCount` is not exported from `logical-live.ts`).

In `web/src/lib/logical-live.ts`, replace `import { overlayVisibleRootCount } from './live.ts'` with the function itself, with its comment unchanged, placed after the `LiveState` type:

```ts
// Replace a VISIBLE root's reply count with the server's total. The count is
// authoritative — never incremented, never decremented, so replaying the same
// frame lands on the same number. A root that isn't a loaded card is left
// alone: an off-page parent is never materialized out of a reply frame.
export function overlayVisibleRootCount(
	edited: Record<string, TimelineEntry>,
	posts: TimelineEntry[],
	rootId: string,
	count: number
): Record<string, TimelineEntry> {
	const root = posts.find((p) => p.id === rootId)
	return root ? { ...edited, [rootId]: { ...root, replyCount: count } } : edited
}
```

In the file's header comment, "It reuses the frozen root-only overlay helper so a resolved reply behaves identically in both models:" becomes "Its root-only overlay helper keeps a resolved reply from ever becoming a card:".

Delete `web/src/lib/live.ts` and `web/src/lib/live.test.ts`. Their remaining exports (`mergeIncoming`, `applyRiverEvent`, `RiverState`) have no runtime importer. Also delete `web/src/lib/LiveTimeline.svelte`, which has no importers. Confirm with `grep -rn "LiveTimeline\|lib/live'\|/live.ts'\|from './live" web/src` (expected: no output).

```bash
git rm web/src/lib/live.ts web/src/lib/live.test.ts web/src/lib/LiveTimeline.svelte
```

Run the same web test file. Expected: PASS.

- [ ] **Step 2: Fold `RenderEntry` into `TimelineEntry`**

`web/src/lib/types.ts`:
- Add as line 1: `import type { EnclosureDto } from './logical-types.ts'`.
- In `TimelineEntry`, delete `sourceName?: string | null`.
- Replace the `publisherId` comment with `// Set for a navigable remote publisher, so bylines link /p/:id instead of /u (which stays local-account only).`
- Replace `placeholder`'s leading `// v2 thread-read only:` with `// Thread reads only:`.
- In the `removed` comment, change `v2 local items only:` to `Local items only:`, and `(core's logicalToFeedEntry never sets it)` to `(core's feed renderers never emit it)`.
- Add as the last member:

```ts
	// The bounded enclosure list (audio/video/image attachments, MASTER.md "text
	// first, enclosures second"); absent on placeholder entries.
	enclosures?: EnclosureDto[]
```

`web/src/lib/logical-types.ts`:
- Delete the 4-line comment `// v2 entries carry the bounded enclosure list …` and the line `export type RenderEntry = TimelineEntry & { enclosures?: EnclosureDto[] }`.
- `logicalToEntry` and `placeholderToEntry` return `TimelineEntry`.
- Delete the line `sourceName: null,` in `logicalToEntry`.

`web/src/lib/logical-api.ts`: remove `type RenderEntry` from the line-6 import, add `import type { TimelineEntry } from './types.ts'` (or extend an existing `./types.ts` import), and replace the three `RenderEntry[]` with `TimelineEntry[]`.

- [ ] **Step 3: Remove the dead `sourceName` reads**

Every entry these pages render comes from `logicalToEntry`/`placeholderToEntry` (their loads import only `$lib/logical-api`), and both producers leave `sourceName` unset. So each read below is always `null`/`undefined`:
- `web/src/lib/Avatar.svelte`: the props become `let { author }: { author: TimelineEntry['author'] } = $props()`, and `const name = $derived(author.displayName)`.
- `web/src/lib/FeedIcon.svelte`: delete `sourceName = null,` and `sourceName?: string | null;` from the props. `const label = $derived(`${author.displayName}'s feed`)`. Keep `sourceFeedUrl`, which is live: the adapter sets it for remote publishers.
- `web/src/lib/ReplyTree.svelte:39-40`: `<Avatar author={reply.author} />` and `<strong>{reply.author.displayName}</strong>`.
- `web/src/routes/+page.svelte:196-200`: `<FeedIcon author={post.author} sourceFeedUrl={post.sourceFeedUrl} />`, `<Avatar author={post.author} />` and `<strong>{post.author.displayName}</strong>`.
- `web/src/routes/post/[id]/+page.svelte:87-88`: `<Avatar author={root.author} />` and `<strong>{root.author.displayName}</strong>`.
- `web/src/routes/u/[handle]/+page.svelte:101-102`: `<Avatar author={post.author} />`, and delete the line `{#if post.sourceName}<strong>{post.sourceName}</strong>{/if}`.
- `web/src/routes/u/[handle]/following/+page.svelte:136-145`: `<Avatar author={post.author} />`, `<strong>{post.author.displayName}</strong>` and `<FeedIcon author={post.author} sourceFeedUrl={post.sourceFeedUrl} />`.
- `web/src/routes/p/[publisherId]/+page.svelte:29`: `<Avatar author={post.author} />`.

- [ ] **Step 4: Completion test and gates**

Run: `grep -rn "RenderEntry\|sourceName" web/src`
Expected: no output.
Run the web tests (all PASS) and svelte-check (`svelte-check found 0 errors and 0 warnings`).
Run the full core suite once more (all PASS), since nothing in core should have moved.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/types.ts web/src/lib/logical-types.ts web/src/lib/logical-api.ts web/src/lib/logical-live.ts web/src/lib/logical-live.test.ts web/src/lib/Avatar.svelte web/src/lib/FeedIcon.svelte web/src/lib/ReplyTree.svelte web/src/routes/+page.svelte "web/src/routes/post/[id]/+page.svelte" "web/src/routes/u/[handle]/+page.svelte" "web/src/routes/u/[handle]/following/+page.svelte" "web/src/routes/p/[publisherId]/+page.svelte"
git commit -m "refactor(web): one TimelineEntry view type — fold RenderEntry, drop sourceName and live.ts"
```

(`live.ts`, `live.test.ts` and `LiveTimeline.svelte` were already staged by `git rm` in Step 1.)

---

## Branch-end verification (controller, after the final review)

1. `.claude/skills/run-rsc/driver.sh up`, then `login`, then `smoke` and `flow`: all PASS.
2. Post through the UI. Fetch `http://localhost:8787/users/<handle>/feed.xml` and `/users/rss.xml` and run both through valid.rss.chat: no errors.
3. Fat-ping parity on the live dev stack. With `RSC_WEBSUB=self`, a pushed body equals the pulled feed; the `push == pull` test asserts this on the corpus. On the stack, confirm one real delivery if a subscriber is configured; otherwise record that it was covered by the test only.
4. `graphify update .`
