# Retire `TimelineEntry` — Design

**Status:** Rev 2, 2026-10-10. Rev 1 was approved section-by-section in
brainstorming (scope: core + web; approach A of three: renderers read
`LogicalItemDto` directly). Rev 2 folds a clean-context review (verdict on
rev 1: READY WITH CHANGES; 6 Important) — every folded finding re-verified
against the code first. See "Rev 2 changes" at the end.
**Origin:** item 4 of the recommended order in
`docs/superpowers/reviews/2026-08-06-architecture-debt-review.md`.

## Problem

Two data models are still live in core, joined by an adapter at the centre.
Reads produce v2 `LogicalItemDto`s; the feed renderers consume the v1
`TimelineEntry` (`Post & { author: User }`), so every pulled feed downgrades
its items through `logicalToFeedEntry` (`core/src/domain/feed.ts:22`).

Worse, the **pushed** copy of a feed is not built from v2 at all. On a local
post, `push.onLocalPost` (`core/src/domain/push.ts:207`) regenerates the WebSub
fat-ping bodies from three v1 repository queries — `getPostsByAuthor`
(`push.ts:233`), `getRecentLocalPosts` (`push.ts:260`) and
`countRepliesByPostIds` (`push.ts:242,262`) — while the pulled feeds use the
projector (`read.ts:151,174`) and count replies from `directReplyCount`
(`read.ts:143`). A subscriber's fat-ping can therefore differ from the feed it
would fetch. This "feeds are built twice" seam has leaked twice already.

The web carries the same split in miniature: `TimelineEntry`
(`web/src/lib/types.ts:1`) and `RenderEntry = TimelineEntry & { enclosures? }`
(`web/src/lib/logical-types.ts:210`) are one view model in two halves, with
fields documented as "v1 only" for entries that no longer exist.

## What exploration established (verified 2026-10-10)

| Question | Answer |
|---|---|
| Who calls the adapter? | `read.ts:144,152,176,187,216` (all pulled feeds + `injectComments`) and `public.ts:155`. |
| Who produces core `TimelineEntry`? | `service.ts:46,62,175` (`createLocalPostAs`, `editLocalPost`, `deletePost`) and `sqlite.ts:45,154` (`joinedRowToEntry`, `getRecentLocalPosts`). |
| Who consumes it? | `bus.emitNewPost` → two listeners: `server.ts:106` (ignores the argument) and `server.ts:110` (`push.onLocalPost`). The write routes `app.ts:282-297` and `personal.ts:120-134` return it as JSON `{ post }`. |
| What does push read from the event? | Only `source`, `author.id`, `author.handle` (`push.ts:209-233`). |
| Are the v1 queries used elsewhere? | In `src`: only push, the `service.ts:85,113,122` wrappers, the SQLite impl and `repository-contract.ts`. In tests: `feed.test.ts:409,445,618`, `api-follows.test.ts:117` (via `service.getRecentLocalPosts`), `service.test.ts:40`, `migrations.test.ts:16,96`, and `logical-feeds.test.ts:243-298` — a guest-exclusion test plus the **push/pull drift canary**, which exist only to compare the two paths. `feed.test.ts:163-179` tests `logicalToFeedEntry` directly. |
| What else is `PushDeps`? | Also the parameter type of `handleWebSubRequest` / `handleRssCloudRequest` (`push.ts:82,111`), called at `server.ts:75-76` and ~14× in `push.test.ts` — none need a store. |
| Where does push get the channel title? | `entry.author` (`push.ts:238`). Pull derives it at `read.ts:174-175`: first item's local `selectedAuthor.displayName`, else the handle. |
| Is a local post's v1 guid its id? | No — `posts.guid` is a separate `randomUUID()` (`local.ts:172`); `localGuid` emits it for a url-less post, while the pull path emits `dto.id`. |
| `rootReplyCount` on core `TimelineEntry`? | Referenced only by the comment at `types.ts:51`. Dead. |
| Is the store available to push? | `server.ts:36` creates `logicalStore`; `server.ts:51` creates push. |
| Web `sourceName`? | Always `null` (`logical-types.ts:236`), yet read in 6 files. |
| Web `lib/live.ts`? | Its only runtime import is `overlayVisibleRootCount` (`logical-live.ts:8`); `mergeIncoming`/`applyRiverEvent`/`RiverState` are imported only by `live.test.ts`. |

## Design

### Core

**1. Renderers take `LogicalItemDto`** (`core/src/domain/feed.ts`).
`renderRssFeed`, `renderJsonFeed`, `renderFirehoseRss`, `renderCommentsFeed`,
`itemContentFields`, `localGuid` and `emittedGuid` read the DTO directly. The
adapter's field map is applied in place:

| v1 field | DTO read |
|---|---|
| `source` | `origin` |
| `url` | `permalink` |
| `inReplyTo` | `inReplyToRef` |
| `editedAt` | `updatedAt` |
| `content` | `content ?? ''` |
| `contentMarkdown` | `contentMarkdown` |
| `guid` | private `wireGuid(dto)`: `origin === 'remote' && originGuid !== null ? originGuid : id` |
| `author.displayName` / `handle` / `feedUrl` | `selectedAuthor` (local: `handle`, `displayName`; remote: `displayName`, `canonicalFeedUrl`, handle `''`) |

The personal feed's channel identity is passed as
`channel: { handle: string; displayName: string }` instead of a whole `User`,
built by ONE exported helper `feedChannel(handle, items)` — the `read.ts:174-175`
derivation (first item's local `selectedAuthor.displayName`, else the handle) —
used by both the pull routes and push, so their channel titles cannot diverge.
`content ?? ''` is load-bearing in `renderCommentsFeed`'s channel label
(`Array.from(post.content)`, `feed.ts:316`).
`read.ts`'s `injectComments` moves into `feed.ts` as
`injectReplyCounts(xml, items, ctx)` (reads `directReplyCount`), shared by
pull and push. `removed` stays out of every feed (same-origin UI signal only).

The public firehose SSE serializer `firehoseEntry` (`public.ts:154`) — the
external API's `firehose-v1` wire JSON — reads the DTO the same way
(`itemContentFields(item)`, `item.permalink`, `item.inReplyToRef`,
`selectedAuthor`); its JSON output is part of the frozen surface and is
covered by the step-1 goldens.

**2. Push regenerates from the projector** (`core/src/domain/push.ts`).
`createPush` takes `PushDeps & { store: LogicalStore }` (`server.ts:51` passes
`logicalStore`); `PushDeps` itself is unchanged, so the two registration
handlers and their callers are untouched.
The personal-topic body uses `projectLocalActivity({ authorId, limit })`, the
firehose body `projectLocalActivity({ authorId: null, limit })` — the same
calls `read.ts` makes — and both go through `injectReplyCounts`. The repo stays
in `PushDeps` for the subscription tables only.

**3. The bus event is `LocalPostEvent = { authorId: string; handle: string }`**
(`bus.ts`). The `source !== 'local'` guard in `onLocalPost` is **dropped**: the
emitters already guarantee local-only (`deletePost` checks at `service.ts:171`,
both PATCH routes at `app.ts:290` / `personal.ts:128`, create is local by
construction). `emitNewPost` no longer applies `hideResolvedReplyContext` — the
event carries no content.

**4. The write API response is frozen.** `createLocalPostAs`, `editLocalPost`,
`deletePost` keep returning `{ ...post, author }`, typed as
`PostWithAuthor = Post & { author: User }` (declared beside `Post` in
`types.ts`, commented as the response shape of `POST`/`PATCH /posts` that
`mcp/src/tools.ts` mirrors). `rootReplyCount` is dropped.

**5. Deletions.** `logicalToFeedEntry`; core `TimelineEntry`;
`Repository.getRecentLocalPosts`, `getPostsByAuthor`, `countRepliesByPostIds`
with their SQLite implementations, contract tests and the three `service.ts`
wrappers; `JoinedRow` / `joinedRowToEntry` (`sqlite.ts:43-50`);
`hideResolvedReplyContext` (`types.ts:45`) once its last two callers
(`bus.ts:24`, `sqlite.ts:46`) are gone. Stale `logicalToFeedEntry` comments at
`logical/types.ts:95`, `projector.ts:614`, `sqlite.ts:143-148` are reworded.
Each symbol is re-grepped for callers before deletion.

**Test fallout (named, so the plan inherits it):**
- `feed.test.ts:163-179` (adapter test) — deleted with the adapter.
- `feed.test.ts:409,445,618`, `api-follows.test.ts:117`, `service.test.ts:40`,
  `migrations.test.ts:16,96` — re-expressed via the projector
  (`projectLocalActivity`) or the pulled route, never deleted blind; each keeps
  what it asserts.
- `logical-feeds.test.ts:243-260` (guest exclusion on the push path) — becomes
  an assertion on the projector-built push body.
- `logical-feeds.test.ts:262-298` (drift canary) — **becomes** the permanent
  "push body === pulled route body" test (step 3), not deleted.
- `push.test.ts`: `setup()` (`:13-20`) returns `store`; every
  `onLocalPost(entry)` passes `{ authorId, handle }`; the remote-event guard
  test (`:44`) is deleted with the guard; O5 (`:180-191`) re-seeds its remote
  reply with a real delivery (as `logical-feeds.test.ts`'s `seedRemoteItem`)
  so the projector counts it.
- `bus.test.ts` — re-typed to the narrowed event.

### Web

**6. One view type, `Entry`**, defined in `logical-types.ts` beside its two
producers (`logicalToEntry`, `placeholderToEntry`), replacing `TimelineEntry`
and `RenderEntry`. Its author type is a named `EntryAuthor`, used where code
now writes `TimelineEntry['author']` (`api.ts` `getFollowing`/`getMe`,
`Avatar.svelte`, `FeedIcon.svelte`). `types.ts` keeps only the source-registry
types.

**7. Dead fields.** `sourceName` and its read sites go, including the
`sourceName` props of `Avatar`/`FeedIcon` — after confirming at each site that
the read is the entry field and not an unrelated binding of the same name; any
live one stays. The "v1 only / undefined on every v1 entry" comments are
rewritten. `rootReplyCount`, `contentHtml`, `replyCount` stay (SSE route and
`PostBody` set or read them).

**8. `live.ts` folds away.** `overlayVisibleRootCount` and its tests move into
`logical-live.ts` / `logical-live.test.ts`; `live.ts`, the dead
`mergeIncoming`/`applyRiverEvent`/`RiverState` and their tests are deleted.
`web/src/lib/LiveTimeline.svelte` (no importers) is deleted too.

### Out of scope

`mcp/src/tools.ts`'s hand-declared type (it mirrors the frozen write response);
the `firehose-v1` JSON shape (frozen, only its producer's input type changes);
the `Post` type and `posts` table (still the local content authority); any
change to the feed wire format.

## Behaviour change

Exactly one, intended: **the pushed fat-ping body is byte-equal to the pulled
feed for the same topic.** Every difference between the two today resolves to
the pull side. Known instances (not exhaustive — the step-3 equality test is
the definition):
- items, order and `source:comments` counts follow the projector;
- a url-less local post's `<guid>` becomes its `id` (was the separate
  `posts.guid` UUID);
- `<source:inReplyTo>` is the projector's re-derived parent ref
  (`projector.ts:724`), not the raw `posts.in_reply_to`;
- an empty personal feed's channel title is the handle (was
  `User.displayName`) — e.g. a guest, whose posts are all `local_only`.

Pulled feeds and `firehose-v1` JSON do not change at all.

## Order and verification

Each step is one commit with every gate green (core tsc, core + web suites,
svelte-check — in the containers).

1. **Snapshot capture.** A fixture builds a fixed dataset — local posts and
   replies, a url-less local post, a reply whose parent ref the projector
   re-derives, a remote reply with an origin guid, an edited post, a removed
   post, a fragment-bearing permalink guid, an XML-illegal character — and
   pins the **pulled** outputs (personal RSS, personal JSON, firehose,
   comments, `firehoseEntry` JSON) with vitest's built-in `toMatchSnapshot()`
   against the *current* code. Committed before any conversion. (No push
   snapshot: push's old bytes are about to change by design.)
2. **Renderers on DTOs** (§1). Snapshots unchanged. Existing feed-test
   fixtures built as `TimelineEntry`/`Post` convert to DTO fixtures via one
   `dto(overrides)` helper.
3. **Push from the projector** (§2–4). The drift canary becomes the permanent
   test: for both topics, the captured fat-ping body `===` the `app.request`
   pulled body, over the step-1 fixture.
4. **Deletions** (§5). Done-test: `grep -rn "logicalToFeedEntry\|TimelineEntry" core/src`
   is empty.
5. **Web `Entry`** (§6–8). Done-test: `grep -rn TimelineEntry web/src` is empty;
   svelte-check 0/0.

Branch-end gates: `.claude/skills/run-rsc/driver.sh smoke` and `flow` on the
dev stack; a pulled personal feed and the firehose pass valid.rss.chat; a
captured fat-ping body diffed against the pulled feed on the dev stack.

## Risks

- Snapshots only prove parity for cases the fixture contains — hence the
  deliberately adversarial fixture in step 1.
- Test fixtures across ~10 core test files are built in the v1 shape; the
  conversion is mechanical but wide. The `dto()` helper keeps it short.

## Rev 2 changes

From a clean-context review of rev 1 (READY WITH CHANGES); each re-verified
against the code before folding:

1. The v1 queries' test callers, the adapter test and the push/pull drift
   canary were unlisted — now named in §5 "Test fallout"; the canary is
   promoted to step 3's permanent equality test instead of deleted.
2. `store` on `PushDeps` would have leaked into both registration handlers —
   now `createPush(PushDeps & { store })`.
3. Push-test breakage (setup, event shape, guard test, O5's NULL-delivery
   seed) — named in §5.
4. The narrowed event has no display name — one shared `feedChannel()` helper
   for pull and push (§1).
5. "Exactly one behaviour change" understated it — restated as byte-equality
   with known instances listed; fixture gains a url-less post and a
   re-derived parent ref.
6. Hand-rolled goldens → vitest `toMatchSnapshot()` for pulled outputs; no
   short-lived push goldens.
7. Minor: `hideResolvedReplyContext`, `JoinedRow`, stale comments (§5);
   `LiveTimeline.svelte` (§8); guard wording "dropped", not "moved" (§3).
