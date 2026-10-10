# Retire `TimelineEntry` — Design

**Status:** Rev 1, 2026-10-10. Approved section-by-section in brainstorming
(scope: core + web; approach A of three: renderers read `LogicalItemDto`
directly).
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
| Are the v1 queries used elsewhere? | `getPostsByAuthor` / `countRepliesByPostIds` / `getRecentLocalPosts`: only push, their `service.ts:85,113,122` wrappers (no callers), the SQLite impl and `repository-contract.ts`. |
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
`channel: { handle: string; displayName: string }` instead of a whole `User`.
`read.ts`'s `injectComments` moves into `feed.ts` as
`injectReplyCounts(xml, items, ctx)` (reads `directReplyCount`), shared by
pull and push. `removed` stays out of every feed (same-origin UI signal only).

The public firehose SSE serializer `firehoseEntry` (`public.ts:154`) — the
external API's `firehose-v1` wire JSON — reads the DTO the same way
(`itemContentFields(item)`, `item.permalink`, `item.inReplyToRef`,
`selectedAuthor`); its JSON output is part of the frozen surface and is
covered by the step-1 goldens.

**2. Push regenerates from the projector** (`core/src/domain/push.ts`).
`PushDeps` gains `store: LogicalStore` (`server.ts:51` passes `logicalStore`).
The personal-topic body uses `projectLocalActivity({ authorId, limit })`, the
firehose body `projectLocalActivity({ authorId: null, limit })` — the same
calls `read.ts` makes — and both go through `injectReplyCounts`. The repo stays
in `PushDeps` for the subscription tables only.

**3. The bus event is `LocalPostEvent = { authorId: string; handle: string }`**
(`bus.ts`). The `source !== 'local'` guard moves from `onLocalPost` to the
emitters; all three `service.ts` emit sites already handle only local posts.

**4. The write API response is frozen.** `createLocalPostAs`, `editLocalPost`,
`deletePost` keep returning `{ ...post, author }`, typed as
`PostWithAuthor = Post & { author: User }` (declared beside `Post` in
`types.ts`, commented as the response shape of `POST`/`PATCH /posts` that
`mcp/src/tools.ts` mirrors). `rootReplyCount` is dropped.

**5. Deletions.** `logicalToFeedEntry`; core `TimelineEntry`;
`Repository.getRecentLocalPosts`, `getPostsByAuthor`, `countRepliesByPostIds`
with their SQLite implementations, contract tests and the three uncalled
`service.ts` wrappers. Each is re-grepped for callers before deletion.

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

### Out of scope

`mcp/src/tools.ts`'s hand-declared type (it mirrors the frozen write response);
the `firehose-v1` JSON shape (frozen, only its producer's input type changes);
the `Post` type and `posts` table (still the local content authority); any
change to the feed wire format.

## Behaviour change

Exactly one, intended: **the pushed fat-ping body equals the pulled feed** —
same items, order and `source:comments` counts. Wherever `getPostsByAuthor` /
`getRecentLocalPosts` and `projectLocalActivity` disagree today, push now
follows the projector. The step-3 test measures that; it is not assumed.

## Order and verification

Each step is one commit with every gate green (core tsc, core + web suites,
svelte-check — in the containers).

1. **Golden capture.** A fixture builds a fixed dataset — local posts and
   replies, a remote reply with an origin guid, an edited post, a removed
   post, a fragment-bearing permalink guid, an XML-illegal character — and
   renders the six outputs (personal RSS, personal JSON, firehose, comments,
   push bodies for both topics, `firehoseEntry` JSON) through the *current*
   code into golden files.
   Committed before any conversion.
2. **Renderers on DTOs** (§1). Pulled outputs byte-identical to their goldens.
   Existing feed-test fixtures built as `TimelineEntry`/`Post` convert to DTO
   fixtures via one `dto(overrides)` helper.
3. **Push from the projector** (§2–4). The push bodies must now equal the
   *pulled* goldens; the old push goldens are replaced in this commit.
4. **Deletions** (§5). Done-test: `grep -rn "logicalToFeedEntry\|TimelineEntry" core/src`
   is empty.
5. **Web `Entry`** (§6–8). Done-test: `grep -rn TimelineEntry web/src` is empty;
   svelte-check 0/0.

Branch-end gates: `.claude/skills/run-rsc/driver.sh smoke` and `flow` on the
dev stack; a pulled personal feed and the firehose pass valid.rss.chat; a
captured fat-ping body diffed against the pulled feed on the dev stack.

## Risks

- Goldens only prove parity for cases the fixture contains — hence the
  deliberately adversarial fixture in step 1.
- Test fixtures across ~8 core test files are built in the v1 shape; the
  conversion is mechanical but wide. The `dto()` helper keeps it short.
