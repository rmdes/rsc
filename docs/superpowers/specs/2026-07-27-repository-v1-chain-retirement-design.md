# Repository v1 posts/threading chain retirement — design

**Date:** 2026-07-27
**Status:** approved, ready for plan
**Trigger:** the "Dead client/service surface sweep" backlog entry
(`docs/superpowers/ideas.md`, added `f929245`) deliberately deferred one item
out of its mechanical bundle (landed as `ea99e71`): "the core-side v1
timeline/thread read chain in `domain/service.ts` + `Repository` +
`sqlite.ts` — real surgery, needs its own scoping pass." This is that pass.

## What actually changed since the inventory was written

The original inventory named 8 dead `Repository` methods, found by checking
which `service.ts` pass-through wrappers had zero HTTP-route callers. Tracing
`service.ts`'s five `if (logical) {v2} else {v1}` branches (all dead in
production since Task 10 made `logical` unconditional) surfaced **12 more**
dead methods hiding inside those branches, plus 2 more found by broadening
the caller search to all of `core/src` rather than just `core/src/api`. The
real count is **22 dead `Repository` methods**, not 8 — confirmed by
independent grep for every one, re-verified this session, not carried over
from the original inventory.

## The complete dead-method inventory

**The original 8** (zero route callers, zero `service.ts` branching):
`getTimeline`, `getTimelineAfter`, `getRevisions`, `getThread`,
`listRepliesByPostId`, `listRemoteUsers`, `countRemoteSubscriptions`,
`getRemoteUserByFeedUrl`.

**12 more, found inside `service.ts`'s dead `if (logical) {...} else {...}`
halves** (`createLocalPostAs`, `editLocalPost`, `updateUserProfile`,
`addFollow`, `removeFollow`, `deletePost` — all five branch sites, `logical`
always truthy in production so every `else` is unreachable):
`insertPost`, `adoptOrphans` (Repository's — a different method from
`LogicalStore`'s own same-named orphan-adoption, no relation), `recordEdit`,
`updateUserProfile` (Repository's — `Service.updateUserProfile` survives,
simplified to always call `logical.updateUserProfile`), `addFollow`
(Repository's — reached only via `followUnlessExcluded`, itself reached only
when `logical` is falsy), `removeFollow` (Repository's), `deletePost`
(Repository's), `countRepliesByPostIds`, `countThreadRepliesByRootIds`,
`getPostsByAuthor`, `getRecentLocalPosts`.

**2 more, zero callers anywhere including `service.ts`** (never even
wrapped): `hasPostsByAuthor`, `backfillItemExtras`, `findPostByRef` — three,
not two; all three confirmed via `grep -rln` across all of `core/src`
excluding `repository-contract.ts` and the methods' own definitions.

**What survives in `Repository`, confirmed alive:** user identity
(`createLocalUser`, `createRemoteUser`, `getUser`, `getUserByHandle`,
`getUserByAuthUserId`, `setAuthUserId`, `updateFeedUrl`, `listUsers`,
`instanceStats`), `getPost` (single lookup — called directly by
`core/src/api/app.ts`), follows (`listFollowing`, `countFollowers` — real
`service.ts` callers beyond the dead branches), account/auth deletion
(`deleteUserCascade`, `deleteAuthRows` — called from both branches of
`deleteLocalAccount`, and from `removeFollow`'s orphan-reap and
`removeRemoteFeed`), subscriptions (`upsertSubscription`,
`listActiveSubscriptions`, `deleteSubscription`, `countActiveSubscriptions`,
`purgeExpiredSubscriptions`), settings (`getSetting`, `setSetting`).

## Design

**1. `createService`'s `logical` parameter becomes required, not optional.**
Mirrors Task 5's identical move on `app.ts`'s `deps.sources`/`deps.logical`
earlier this release. Every `if (logical) {...} else {...}` branch in
`service.ts` collapses to its v2 half only; the `if (logical && ...)` guard
in `addFollow` simplifies to the same condition without the now-always-true
`logical &&` prefix. `followUnlessExcluded` (the v1-only exclusion helper)
is deleted entirely — its exclusion semantics are already correctly
reproduced by the v2 branch's own condition.

**2. Delete all 22 methods** from three places together, in the same
commit(s) — deleting only one layer at a time would leave the interface or
implementation referencing a symbol the other side no longer has:
`core/src/domain/repository.ts` (the `Repository` interface declarations),
`core/src/storage/sqlite.ts` (`SqliteRepository`'s implementations — the
only implementation of `Repository`), and every `service.ts` pass-through
wrapper that merely forwarded to a now-deleted method.

**3. `repository-contract.ts` shrinks to what's left reachable.** Once
`insertPost` is gone, there is no way to create a post row through the
`Repository` interface at all — `LogicalStore.createLocalPost` is a
different interface, and this file's own discipline (confirmed: it never
drops to raw SQL, unlike some other test files this release) means it
can't route around that. Concretely, of the file's 38 tests:

- **~24 tests are deleted outright**, not rewritten: every test whose
  primary subject is one of the 22 dead methods, and every test that uses
  `insertPost` purely as setup for testing thread/reply/orphan-adoption
  behavior (`getThread` ×3, `adoptOrphans` ×2, `countRepliesByPostIds` ×2,
  `getRecentLocalPosts`, `backfillItemExtras`, `findPostByRef` ×2, the
  reply-fields-round-trip test, all `getTimeline`/`getTimelineAfter` tests,
  `addFollow`/`removeFollow`/self-follow tests). None of this needs a
  replacement test in this file — v2's own equivalent behavior (threading,
  orphan adoption, timeline ordering, follow idempotency) already has
  dedicated coverage in the `logical-*.test.ts` files built across the
  V1-V4 verticals this release; the plan's job is to confirm that overlap
  exists per deleted test, not assume it, before deleting.
- **1 test is simplified, not deleted:** "creates a remote user and lists
  it among remotes only" drops its `listRemoteUsers`-specific assertion
  (the list-filtering behavior becomes untestable through this interface)
  but keeps its `createRemoteUser` assertions (`kind`, `feedUrl`) — the
  meaningful part of what it verified survives.
- **~13 tests are untouched:** identity (`createLocalUser`/`getUser`/
  `getUserByHandle`/`updateFeedUrl`/`HandleTakenError`), `getPost`'s
  not-found case, and the entire subscription block (`upsertSubscription`,
  `listActiveSubscriptions`, `deleteSubscription`,
  `countActiveSubscriptions`, `purgeExpiredSubscriptions`) — none of these
  touch any of the 22 dead methods even incidentally.

The plan must re-verify this categorization test-by-test against the
now-current file (this spec's line numbers will drift as earlier tasks in
the same release land more commits) rather than trust the bucket counts
above as gospel — the same citation-drift discipline every other task this
release has needed.

**4. `core/test/api.test.ts` and `core/test/sqlite-repository.test.ts`**
(the two consumers of `runRepositoryContract`) need no changes themselves —
they just call the (now-shorter) shared suite — but the plan must grep both
for any DIRECT use of the 22 dead methods outside the shared contract
function, since `repository-contract.ts` isn't necessarily the only place
they're exercised.

## Non-goals

- No change to `LogicalStore` or anything in `core/src/logical/` — this is
  entirely about retiring the v1 half of `Repository`/`SqliteRepository`/
  `service.ts`, not touching the v2 systems that already replaced it.
- No change to the *surviving* `Repository` methods' behavior or signatures.
- Not re-deriving whether v2 has equivalent coverage from scratch — the plan
  should grep for and cite the specific `logical-*.test.ts` test(s) that
  already cover each deleted behavior, as evidence a test can be safely
  deleted rather than ported.
- No wire/HTTP contract changes — every one of the 22 methods was already
  unreachable from any route before this change; nothing about the running
  application's behavior changes.

## Testing

- Full core suite green before AND after, at every task boundary (this
  release's standing discipline).
- `tsc --noEmit` 0 errors after each task — deleting an interface method
  before its implementation (or vice versa) is a compile error by
  construction, so the ordering within each task matters: delete from
  `service.ts` first (removes the only caller), then `repository.ts` +
  `sqlite.ts` together (interface and implementation must move together to
  never leave one referencing what the other lacks), then
  `repository-contract.ts`.
- The plan should size this as multiple small tasks (e.g., one per
  `service.ts` branch site, then one for the standalone pass-through-only
  methods, then one for `repository-contract.ts`'s cleanup) rather than one
  giant commit — consistent with how every other multi-file task this
  release was sequenced, and it keeps each task's diff reviewable.

## Grounding index

`core/src/domain/service.ts` (all `if (logical)` sites: lines 50, 83, 150,
164, 171, 197, 213) · `core/src/domain/repository.ts` (the `Repository`
interface) · `core/src/domain/repository-contract.ts` (448 lines, 38 tests,
the shared assertion suite) · `core/src/storage/sqlite.ts` (the sole
`Repository` implementation) · `core/test/api.test.ts`,
`core/test/sqlite-repository.test.ts` (the contract's two consumers) ·
`docs/superpowers/ideas.md`'s "Dead client/service surface sweep" entry
(the deferred item this spec resolves).

*developed with the help of AI tools*
