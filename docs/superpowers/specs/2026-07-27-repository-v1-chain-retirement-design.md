# Repository v1 posts/threading chain retirement — design

**Date:** 2026-07-27
**Status:** rev 4 — corrections below, ready for plan once this rev is accepted
**Trigger:** the "Dead client/service surface sweep" backlog entry
(`docs/superpowers/ideas.md`, added `f929245`) deliberately deferred one item
out of its mechanical bundle (landed as `ea99e71`): "the core-side v1
timeline/thread read chain in `domain/service.ts` + `Repository` +
`sqlite.ts` — real surgery, needs its own scoping pass." This is that pass.

## Correction (rev 2)

Rev 1 was reviewed by a fresh subagent before planning began, per this
project's standing practice of reviewing every spec/plan before it's acted
on. The review found rev 1 had repeated the exact failure mode it existed
to avoid: it checked "dead" by tracing `service.ts` wrapper → HTTP route,
and missed a non-route consumer, `core/src/domain/push.ts`, which takes
`Repository` directly and never goes through `service.ts` at all. Three of
rev 1's 22 "dead" methods are genuinely live — one of them, notably,
carries a comment-documented v2-union arm added *during* the V2 wave, not
v1 residue. Rev 1 also got its own staging order wrong in a way that
breaks the build, missed two real survivors and two real dead methods
never in either list, and understated the test-suite blast radius of
making `logical` a required parameter. All of that is corrected below.
Every number in this document was independently re-verified against
current source during this correction, not carried forward from rev 1.

## Correction (rev 3)

A second independent review (a parallel session, re-deriving every claim
from source rather than trusting rev 2 or this document's own framing)
found rev 2 repeated the same *class* of error on a different axis: not
"which methods are dead" this time, but "which test files break once
`logical` becomes required." Rev 2 estimated "roughly 20" such call sites
and enumerated only the 4 that needed special handling (3 deletions + 1
repair), waving the rest through as a generic "~16, just add a store."
The parallel review found 9 more files never mentioned anywhere in rev 2
at all. Verifying that finding turned up a further problem: the parallel
review's own list of 9 was *also* incomplete (missed 3 more: `auth.test.ts`,
`moderation.test.ts`, `posts-edit.test.ts`) — three consecutive attempts at
hand-enumerating this one axis, three consecutive undercounts. The same
review also confirmed Design item 5's 16-file list had **5 false
positives** (not the 4 it explicitly named): `federation-threading.test.ts`,
`feed.test.ts`, and `logical-reconcile.test.ts` all call `LogicalStore`'s
own live `adoptOrphans` (a name collision with the deleted `Repository`
method, the exact same trap rev 1 was caught making on the method-inventory
itself), `api-follows.test.ts` has zero genuine doomed-method hits, and
this correction independently found a 5th — `logical-policy-events.test.ts`
— which belongs only in Design item 1's list (it's one of the 3 confirmed
OFF-path deletions), not item 5's.

**Given three consecutive rounds of hand-enumeration undercounting the same
axis, this rev stops trying to hand-curate a longer list and replaces it
with an exhaustive mechanical sweep, quoted below verbatim, plus a
requirement that the plan re-run the identical commands itself rather than
trust this document's list as final.** Both axes are corrected below with
the full, mechanically-derived file sets.

## Correction (rev 4)

A third independent review, checking rev 3 with the same re-derive-from-
source discipline, confirmed rev 3's own corrections held up (the 21-method
recount, the 8 branch sites, the staging-order fix, the 38-test bucket
mapping) but found 5 more real issues — every one independently
re-verified against current source during this correction:

1. **Critical, a fixture bug, not a citation issue:** `push.test.ts`'s `O5`
   test (`'self mode fat ping counts a REMOTE logical reply (v2) so the
   push body matches the pull'`) manually inserts a `logical_items_v2` row
   for `root.id` to simulate what a real logical store would write. Once
   `push.test.ts` gets a REAL logical store (per Design item 1's repair
   instruction), `service.createLocalPostAs` will go through the v2 path,
   and `logical/local.ts:182`'s `createLocalPost` calls
   `materializeLocalItem(tx, { id, ... })` using the post's own id —
   confirmed by reading `local.ts` directly. That write and the test's own
   manual insert target the SAME primary key (`root.id`), so simply adding
   a logical store to this test (as Design item 1 currently says) throws on
   a PK collision. The test's manual `local`-origin insert for `root.id`
   must be DROPPED once a real store is wired in; only the second insert
   (the remote reply row) is still needed.
2. **Citation gap:** Design item 1's "delete outright" list named
   `service.test.ts:178`'s `test.each([false, true])` singular, but
   `renameApp` (the shared helper at `service.test.ts:173`) feeds TWO
   separate `test.each([false, true])` blocks (currently `:190` and `:208`)
   — both need their `false` half deleted, not just one.
3. **Withdraw a claim, don't just soften it.** Design item 6 claimed follow
   idempotency has "no test anywhere" once `repository-contract.ts:227`
   and `service.test.ts:58-65` are deleted. `grep -rn "addLocalFollow"
   core/test` (the check rev 2/3 used) only matches the literal function
   name and missed real existing coverage:
   `logical-policy-events.test.ts:258-268` calls `svc.addFollow` twice with
   an explicit `// idempotent → no new edge → no reset` comment, asserting
   the reset count doesn't move on the second call. This test survives
   Design item 1 untouched (it already passes a real logical store). Follow
   idempotency is NOT an uncovered behavior — drop this bullet from item 6
   entirely.
4. **Important — a real design gap, not a test problem.** `addFollow`'s
   current v2 branch (`service.ts:163-168`) only implements the "proceed"
   case (`if (logical && target.feedType !== 'instance' && target.id !==
   follower.id) { logical.addLocalFollow(...); return true }`) and
   delegates EVERY rejection case to `followUnlessExcluded(repo,
   follower.id, target)`'s own guard (`service.ts:18-22`: `if
   (target.feedType === 'instance' || target.id === followerId) return
   false`). Design item 1 deletes `followUnlessExcluded` entirely on the
   premise that "its exclusion semantics are already correctly reproduced
   by the v2 branch's own condition" — that premise is WRONG: the v2
   branch's condition only decides when to WRITE; the reject-and-return-
   false behavior lives exclusively inside the function being deleted, with
   no replacement. Deleting it as rev 2/3 specified would leave
   `addFollow` with no way to reject a self-follow or instance-follow
   target — a real behavior regression, not a test gap. **Fix:** fold the
   guard inline into `addFollow` itself:
   ```typescript
   async addFollow(follower: User, target: User): Promise<boolean> {
     if (follower.kind !== 'local') throw new DomainError('follower must be a local user')
     if (target.feedType === 'instance' || target.id === follower.id) return false
     logical.addLocalFollow({ followerId: follower.id, followedId: target.id, now: new Date().toISOString() })
     return true
   }
   ```
   This drops the dependency on `repo` inside `addFollow` entirely (correct,
   since `repo.addFollow` is deleted) while preserving the exact external
   behavior. Its test, `service.test.ts:74-86` ("addFollow refuses
   self-follow and instance targets, minting nothing" — currently line 74,
   not 77 as rev 3 cited), must be **preserved, not deleted** — Design item
   1 wrongly listed it in the "delete outright" bucket. It uses a fake
   `Repository` stub and `createService(repo, createEventBus())` with no
   `logical` — once `logical` is required, this test needs a fake/stub
   `LogicalStore` too (only `addLocalFollow` needs to exist on the stub,
   to prove the guard rejects before ever calling it), not deletion.
5. **Repository-contract.ts's mixed-method tests generalize beyond the one
   test rev 3 already flagged.** Item 3 already identified `:407` and
   `:422` as interleaving a surviving method's assertions with a dead
   method's in the same test body. The same pattern exists at `:227`
   (`'addFollow is idempotent and listFollowing returns follows in
   created_at order'` — uses the dying `repo.addFollow` purely as SETUP to
   test the SURVIVING `listFollowing`'s created_at ordering and dedup
   behavior) and `:241` (`'removeFollow is idempotent...'` — same shape,
   `repo.removeFollow`/`repo.addFollow` as setup, `listFollowing` as the
   real assertion). **None of these five (`:227`, `:241`, `:254`, `:407`,
   `:422`) can be handled by the blanket "delete outright" instruction in
   item 4's 23-test bucket** — each needs the surviving method's assertion
   preserved (with its setup re-pointed to seed via `logical.addLocalFollow`
   /`LogicalStore.createLocalPost` instead of the dying `Repository`
   methods), and only the dead-method-specific assertions actually deleted.
   `:254` ("self-follow is allowed and needs no special-casing") is
   different in kind — its own comment says it deliberately documents the
   REPO layer's permissiveness in contrast to the SERVICE layer's guard
   (finding 4, above); once `Repository.addFollow` is gone, that contrast
   has nothing left to describe on the repo side, so this one is a genuine
   delete, not a split.

## What actually changed since the inventory was written

The original mechanical-sweep inventory named 8 dead `Repository` methods,
found by checking which `service.ts` pass-through wrappers had zero HTTP-
route callers. Tracing `service.ts`'s eight `if (logical) {v2} else {v1}`
branches (all dead in production since Task 10 made `logical` unconditional
at the only real call site) surfaced 11 more dead methods hiding inside
those branches, plus 3 more found by broadening the caller search to all of
`core/src` rather than just `core/src/api`. Rev 1 stopped there and claimed
22. This rev's review widened the search once more, to every consumer of
`Repository` in `core/src` (not just `service.ts` and route handlers) and
found: 3 of the 22 are actually live (called from `push.ts`), and 2 more
genuinely-dead methods exist that neither rev 1's list nor the mechanical
sweep ever named. **The real dead count is 21, not 22 — and it is a
different 21, not a subset.**

## The complete dead-method inventory (corrected)

**The original 8** (zero callers anywhere in `core/src`, confirmed again
this rev): `getTimeline`, `getTimelineAfter`, `getRevisions`, `getThread`,
`listRepliesByPostId`, `listRemoteUsers`, `countRemoteSubscriptions`,
`getRemoteUserByFeedUrl`.

**8 more, found inside `service.ts`'s dead `if (logical) {...} else {...}`
halves** (of the 8 branch sites listed below, `insertPost` is used by three
of them): `insertPost`, `adoptOrphans` (Repository's — a different method
from `LogicalStore`'s own same-named orphan-adoption, no relation),
`recordEdit`, `updateUserProfile` (Repository's — `Service.updateUserProfile`
survives, simplified to always call `logical.updateUserProfile`),
`addFollow` (Repository's — reached only via `followUnlessExcluded`, itself
reached only when `logical` is falsy — see Design item 1), `removeFollow`
(Repository's), `deletePost` (Repository's), `countThreadRepliesByRootIds`.

**3 more, zero callers anywhere including `service.ts`** (never even
wrapped): `hasPostsByAuthor`, `backfillItemExtras`, `findPostByRef`.

**2 more, found this rev, missed by both rev 1 and the original mechanical
sweep** — genuinely production-dead, each with exactly one test in a
`repository-contract.ts`-adjacent file, not in `repository-contract.ts`
itself: `updateDisplayNameIfUnset` (`repository.ts:8`; sole test
`core/test/per-user-feeds-repo.test.ts:48-52`), `getEditableByGuid`
(`repository.ts:40`; sole test `core/test/sqlite-edits.test.ts:45-49`).

**REMOVED from rev 1's dead list — genuinely live, do not delete:**
`getPostsByAuthor`, `countRepliesByPostIds`, `getRecentLocalPosts`. All
three are called from `core/src/domain/push.ts` (`:226`, `:235`+`:255`,
`:253`), reachable via `server.ts:50` `createPush({repo, config})` →
`server.ts:106` `bus.onNewPost(e => push.onLocalPost(e))`, live whenever
`config.websub.mode === 'self'` (`config.ts:56`, a first-class supported
config, not a deprecated path) — the self-hub WebSub fat-ping's RSS/JSON
Feed body generation. `countRepliesByPostIds` is the clearest signal that
this bucket was never v1-only: `sqlite.ts:536-547` contains a comment-
documented v2-union arm ("mirroring the projector's childIds remote arm
EXACTLY") added during the V2 wave, with its own regression test at
`core/test/push.test.ts:179-190`. Deleting these three is not cleanup, it
is a WebSub-delivery regression.

**What survives in `Repository`, confirmed alive (corrected — adds 5 to
rev 1's list):** user identity (`createLocalUser`, `createRemoteUser`,
`getUser`, `getUserByHandle`, `getUserByAuthUserId`, `setAuthUserId`,
`updateFeedUrl`, `listUsers`, `instanceStats`), `getPost` (single lookup —
called directly by `core/src/api/app.ts`), follows (`listFollowing`,
`countFollowers`), account/auth deletion (`deleteUserCascade`,
`deleteAuthRows`), subscriptions (`upsertSubscription`,
`listActiveSubscriptions`, `deleteSubscription`, `countActiveSubscriptions`,
`purgeExpiredSubscriptions`), settings (`getSetting`, `setSetting`), **plus
5 rev-1-omitted survivors:** `close` (`shutdown.ts:29`),
`sweepAnonymousUsers` (`housekeeping.ts:17`), and the 3 reinstated above
(`getPostsByAuthor`, `countRepliesByPostIds`, `getRecentLocalPosts`).

`Repository` has 47 methods total: 21 dead (above) + 26 alive — accounts
for all of them, unlike rev 1's 22+21=43.

## Design

**1. `createService`'s `logical` parameter becomes required, not optional.**
Mirrors Task 5's identical move on `app.ts`'s `deps.sources`/`deps.logical`
earlier this release. `core/src/domain/service.ts` has **8** `if (logical)`
conditional sites, not 5 — rev 1 both undercounted and mislisted them:

| Line | Method | Branch shape |
|---|---|---|
| 50 | `createLocalPostAs` | `if (logical) {v2} else {repo.insertPost}` |
| 83 | `editLocalPost` | `if (logical) {v2} else {repo.recordEdit}` |
| 106 | `resolveReplyTarget` | `logical && ...` |
| 150 | `updateUserProfile` | ternary, `logical ? v2 : repo.updateUserProfile` |
| 164 | `addFollow` | `logical && ...` (via `followUnlessExcluded`) |
| 171 | `removeFollow` | `if (logical) {v2} else {repo.removeFollow}` |
| 197 | `deleteLocalAccount` | `if (logical) {v2} else {repo.deleteUserCascade}` |
| 213 | `deletePost` | `if (logical) {v2} else {repo.deletePost}` |

Every branch collapses to its v2 half only. `deleteLocalAccount`'s branch
keeps `deleteUserCascade`/`deleteAuthRows` reachable via the surviving
orphan-reap paths elsewhere (see the corrected survivor list) — only the
top-level `else` at line 197 disappears, not those functions. The
`if (logical && ...)` guard in `addFollow` simplifies to the same condition
without the now-always-true `logical &&` prefix. `followUnlessExcluded`
(the v1-only exclusion helper) is deleted entirely — its exclusion
semantics are already correctly reproduced by the v2 branch's own
condition. The stale doc comment at `service.ts:24-27` ("`logical` stays
optional here only so tests that don't need v2 wiring can omit it") must be
deleted — it describes a design this change removes.

**Test-suite consequence — corrected via exhaustive mechanical sweep (rev
3), not hand enumeration.** Every one of these becomes a `tsc --noEmit`
error the moment `logical` is required, and `core/tsconfig.json` includes
`test`, so this is a hard build break, not a runtime one. The authoritative
list was produced by listing every `createService(` call site in
`core/test/*.ts` and classifying each by whether a real (non-`undefined`,
non-`null`) 4th argument is present, given the real signature
`createService(repo, bus, publicUrl?, logical?)`:

```
grep -n "createService(" core/test/*.ts
```

**16 distinct files have at least one call site with `logical` omitted or
`null`**, not "roughly 20" naming only 4. Three call sites are outright
deletions, one is a repair rev 2 already correctly identified, and 12 are
newly-enumerated files needing a real logical store added, most never
mentioned in rev 2 at all:

- **Delete outright** (test a state that can no longer occur — no "OFF"
  left to assert against, same disposition this release gave every other
  flag-off test once Task 10 retired the flag itself):
  - `core/test/logical-vertical.test.ts:106` — `'disabled: a service built
    WITHOUT the logical store writes NO v2 rows (flag-off byte-identical)'`
  - `core/test/logical-policy-events.test.ts:283-291` — `'with v2 OFF the
    same service writes NO journal row (flag-off isolation)'`
  - `core/test/service.test.ts:190` **and** `:208` — TWO separate
    `test.each([false, true])` blocks, not one, both fed by the shared
    `renameApp` helper (`:173`); delete only the `false` half of each, the
    `true` halves survive as ordinary (non-parametrized) tests
- **Preserve, don't delete** (rev 3 wrongly bucketed this as a deletion —
  see Correction rev 4, finding 4 — its behavior is a real design gap, not
  a moot test):
  - `core/test/service.test.ts:74-86` — `'addFollow refuses self-follow and
    instance targets, minting nothing'`. Once `addFollow`'s exclusion guard
    moves inline (finding 4's code fix), this test still needs to exist to
    cover it — update its fake `Repository` stub to also provide a fake
    `LogicalStore` stub (only `addLocalFollow` needs to exist on it, to
    prove the guard rejects before ever reaching it) rather than deleting
    the test.
- **Repair, don't delete** (this is the only test coverage of a
  confirmed-*live* production call pattern — and needs a fixture edit, not
  just a parameter add, per Correction rev 4 finding 1):
  - `core/test/push.test.ts:14` — `push.ts`'s call into
    `createLocalPostAs`; give it a real logical store. **Also required:**
    in the `O5` test specifically (`'self mode fat ping counts a REMOTE
    logical reply (v2)...'`), delete the manual `INSERT INTO
    logical_items_v2` for `root.id` — once a real logical store is wired
    in, `service.createLocalPostAs` writes that exact row itself via
    `materializeLocalItem` (`local.ts:182`), and the test's own duplicate
    insert would violate the `logical_items_v2` primary key. Only the
    second manual insert (the remote reply row, a genuinely synthetic
    fixture with no production equivalent) stays.
- **Add a real logical store** (not OFF-path-specific, just used the
  parameter's optionality for convenience; none of these needs deletion on
  this basis alone, though several are also directly affected by the
  method deletions in item 2/5, handled there): `core/test/admin.test.ts`,
  `admin-users.test.ts`, `admin-overview.test.ts`,
  `logical-admin-api.test.ts`, `logical-review-api.test.ts`,
  `logical-routes.test.ts`, `logical-feeds.test.ts`, `multi-session.test.ts`,
  `auth.test.ts`, `moderation.test.ts`, `posts-edit.test.ts`,
  `smoke.test.ts`. Plus `service.test.ts`'s own remaining non-OFF-path call
  sites (lines 18, 53, 100, 107, 114 — the same file also has the deletions
  and the one preservation above; it needs mixed treatment internally, not
  one disposition for the whole file).

**Required plan step, not optional:** given three consecutive rounds of
hand-enumeration undercounting this exact axis (rev 2's own attempt, a
parallel review's follow-up, and this correction's discovery that even the
follow-up missed 3 more), the plan's first task must **re-run the grep
above itself** against the then-current `core/test/`, not trust this list
as final — commits landing between this spec and plan execution could add
or remove call sites.

**2. Delete the 21 methods** from three places together, in the same
commit(s) — deleting only one layer at a time would leave the interface or
implementation referencing a symbol the other side no longer has:
`core/src/domain/repository.ts` (the `Repository` interface declarations),
`core/src/storage/sqlite.ts` (`SqliteRepository`'s implementations — the
only implementation of `Repository`), and every `service.ts` pass-through
wrapper that merely forwarded to a now-deleted method. `updateDisplayNameIfUnset`
and `getEditableByGuid` (found this rev, never wrapped by `service.ts`) are
part of this same deletion — same treatment as `hasPostsByAuthor`/
`backfillItemExtras`/`findPostByRef`, just delete the interface + impl.

**3. `insertPost`'s removal strands contract-level fixture setup for the 3
reinstated survivors.** `getPostsByAuthor`, `countRepliesByPostIds`, and
`getRecentLocalPosts` all need existing post rows to test meaningfully, and
`Repository.insertPost` is (after this change) the only interface-level way
to create one — `LogicalStore.createLocalPost` is a distinct interface with
no shared implementation (confirmed: `logical/store.ts:343-345` delegates
to `./local.ts` inside `db.write`, no reference to `Repository` or
`SqliteRepository` anywhere in that file except one unrelated comment at
`:383`). **Decision for the plan to execute, not re-derive:** check whether
`core/test/push.test.ts:179-190`'s existing v2-union assertion (and any
sibling assertions in that file) for `countRepliesByPostIds` already
supersedes `repository-contract.ts`'s versions of these three tests
end-to-end; if so, delete the redundant `repository-contract.ts` tests
rather than porting their setup. If any specific assertion in
`repository-contract.ts`'s versions isn't already covered in `push.test.ts`,
port only that assertion into a test that seeds via `LogicalStore.createLocalPost`
instead of `Repository.insertPost`. Default expectation is that `push.test.ts`
already covers this (it's the real production caller's own test file), but
the plan must verify per-assertion, not assume.

**4. `repository-contract.ts` shrinks to what's left reachable — corrected
bucket counts.** The file has 38 tests (confirmed: `grep -c '^\s*test('` =
38, 448 lines). Corrected buckets, verified test-by-test against the
current file (rev 1's "~24/1/~13" both undercounted the untouched bucket
and didn't yet know about the 3 reinstated survivors):

- **10 tests untouched**, not ~13 (exact set: lines 8, 16, 33, 151, 159,
  170, 180, 189, 196, 207) — identity (`createLocalUser`/`getUser`/
  `getUserByHandle`/`updateFeedUrl`/`HandleTakenError`), `getPost`'s
  not-found case, and the entire subscription block.
- **1 test simplified, not deleted:** `:23-31` "creates a remote user and
  lists it among remotes only" — drops its `listRemoteUsers`-specific
  assertion (`:29-30`), keeps its `createRemoteUser` assertions (`kind`,
  `feedUrl`, `:27-28`).
- **19 tests deleted outright** (down from 23 — see the next bullet for the
  4 that move) — every test whose primary subject is one of the 21
  genuinely-dead methods AND whose setup doesn't also carry a surviving
  method's real assertion: `getThread` ×3, `adoptOrphans` ×2,
  `backfillItemExtras`, `findPostByRef` ×2, the reply-fields-round-trip
  test, all `getTimeline`/`getTimelineAfter` tests, `insertPost`/
  `recordEdit`/`updateUserProfile`/`deletePost` tests where those are the
  primary subject, and `:254` (`'self-follow is allowed and needs no
  special-casing'` — its own comment documents the REPO layer's
  permissiveness in contrast to the SERVICE layer's guard; once
  `Repository.addFollow` is gone there's nothing left on the repo side for
  that contrast to describe). None of this needs a replacement test in this
  file — see item 6 below for the one specific behavior (timeline
  ordering) that needs more than a shrug here.
- **4 tests need SPLITTING, not blanket deletion or blanket keeping**
  (Correction rev 4, finding 5) — each interleaves a dying method's call
  with a surviving method's real behavioral assertion in the same test
  body, so the dead-method assertion is deleted but the surviving one's
  coverage must be preserved (setup re-pointed to
  `logical.addLocalFollow`/`LogicalStore.createLocalPost` instead of the
  dying `Repository` methods):
  - `:227` `'addFollow is idempotent and listFollowing returns follows in
    created_at order'` — `addFollow` (dying) is pure setup;
    `listFollowing`'s created_at ordering and dedup behavior (surviving)
    is the real assertion.
  - `:241` `'removeFollow is idempotent...'` — same shape,
    `removeFollow`/`addFollow` (dying) as setup, `listFollowing`
    (surviving) as the real assertion.
  - `:407` `'countRepliesByPostIds and listRepliesByPostId key on resolved
    ids only'` — `countRepliesByPostIds` (surviving) and
    `listRepliesByPostId` (dying) both asserted in one test body. Its
    surviving half is also one of the tests item 3's decision applies to.
  - `:422` `'conversation counts include every descendant while direct
    counts stay direct'` — `countRepliesByPostIds` (surviving) and
    `countThreadRepliesByRootIds` (dying) both asserted in one test body.
    Its surviving half is also one of the tests item 3's decision applies
    to.
- **Also needing item 3's decision** (not automatic deletion, not a split —
  these are standalone survivor-method tests): `:215` (`getPostsByAuthor`),
  `:435` (`getRecentLocalPosts`).

**On the exact totals: this document is not the source of truth for them
anymore.** Every one of the last three revisions has shipped a bucket
count that didn't survive independent re-verification — the pattern itself
is the finding. Rather than assert a fourth precise sum, the plan's actual
first step for this file must be to read every one of the 38 tests fresh,
tag each as untouched / simplified / delete-outright / split / needs-item-3
by its ACTUAL body (not this document's characterization of it), and treat
whatever total that produces as authoritative. The categories above are a
strong prior, not a checklist to transcribe.

**5. `repository-contract.ts` has exactly ONE consumer, not two — and 12
other test files use the doomed methods directly (corrected from rev 2's
16 — 4 were name collisions with `LogicalStore`'s own live `adoptOrphans`
or had zero genuine hits, and a 5th belongs only in item 1's list, not
here).** Rev 1 claimed `core/test/api.test.ts` and
`core/test/sqlite-repository.test.ts` both consume `runRepositoryContract`
and need no other changes. Verified: `grep -rn "runRepositoryContract"
core/src core/test` returns exactly the definition
(`repository-contract.ts:6`) and one import+call, both in
`sqlite-repository.test.ts`. `api.test.ts` never imports or calls it, and
has zero direct dead-method usage — rev 1's claim about it was simply
wrong.

**The real fan-out, verified via exhaustive mechanical sweep (not hand
enumeration — rev 2's own 16-file list had 5 false positives, caught by a
second independent review plus this correction's own check):**

```
DOOMED='insertPost|getThread\(|adoptOrphans|recordEdit|updateUserProfile|addFollow|removeFollow|deletePost\(|countRepliesByPostIds|countThreadRepliesByRootIds|getTimeline\(|getTimelineAfter|getRevisions|listRepliesByPostId|listRemoteUsers|countRemoteSubscriptions|getRemoteUserByFeedUrl|hasPostsByAuthor|backfillItemExtras|findPostByRef|updateDisplayNameIfUnset|getEditableByGuid'
grep -lrE "repo\.(${DOOMED})" core/test/*.ts
```

This returns exactly **12 files**: `service.test.ts`, `sqlite-edits.test.ts`,
`per-user-feeds-repo.test.ts`, `moderation.test.ts`,
`unfollow-cleanup.test.ts`, `delete-cascade.test.ts`, `migrations.test.ts`,
`posts-edit.test.ts`, `auth.test.ts`, `source-capability-api.test.ts`,
`source-following.test.ts`, `sqlite-repository.test.ts` (the last has its
own direct `repo.updateUserProfile` calls at `:18,24`, separate from its
role as `runRepositoryContract`'s sole consumer).

**Removed from rev 2's 16, confirmed as false positives:**
`federation-threading.test.ts`, `feed.test.ts`, `logical-reconcile.test.ts`
all call `LogicalStore`'s own live `adoptOrphans` (`store.adoptOrphans(...)`,
not `repo.adoptOrphans(...)`) — the identical name-collision trap the
method-inventory correction (rev 2) already had to catch once on the
inventory itself, recurring here in the file-list; `api-follows.test.ts`
has zero genuine doomed-method hits at all; `logical-policy-events.test.ts`
does call `createService` without `logical` (correctly relevant to item 1)
but has zero doomed-*method* calls — it belongs only in item 1's deletion
list, not here.

**Required plan step, same as item 1:** re-run the grep above against the
then-current `core/test/` before trusting this 12-file list — the same
three-rounds-of-undercounting lesson applies to both axes.

Two specific hard blockers the plan must solve, not just discover:

- `source-following.test.ts:64` and `per-user-feeds-repo.test.ts:23-26,34-35`
  call `repo.addFollow(...)` as their only way to seed a `follows` row.
  Once `addFollow` is deleted, these need a replacement seeding path — the
  plan must confirm `logical.addLocalFollow` writes rows the surviving
  `listFollowing`/`countFollowers` still read correctly, and re-point these
  tests at it.
- `service.test.ts:74-84` builds a fake `{ addFollow }` repo specifically to
  test `followUnlessExcluded` directly. Since `followUnlessExcluded` itself
  is deleted in item 1, this test is moot — delete it, don't port it.

`service.getRecentLocalPosts` (the *service* wrapper, distinct from the
`Repository` method of the same name) is called from
`core/test/feed.test.ts:316,352,394` and `core/test/api-follows.test.ts:95` —
confirming the service wrapper for this survivor also isn't free to touch;
it stays, simplified to always call the v2 path only if it currently
branches, or untouched if it's already a straight pass-through (the plan
must check `service.ts`'s current wrapper shape for this one specifically,
since it's a survivor whose wrapper might still contain now-dead branching
logic worth simplifying even though the underlying `Repository` method
stays).

**6. One behavior has NO v2-equivalent test today — the plan must ADD a
test, not just delete the v1 one.** Rev 1's Non-goals section assumed the
plan would find and cite existing `logical-*.test.ts` coverage for
everything being deleted. That holds for orphan adoption and thread-root
derivation (`logical-threading.test.ts` has 9+ dedicated tests) — and, per
Correction rev 4 finding 3, for follow idempotency too:
`logical-policy-events.test.ts:258-268` already asserts `svc.addFollow`
called twice produces no second reset (`// idempotent → no new edge → no
reset`), a real behavioral pin on `logical.addLocalFollow` reached through
the service layer rather than by that literal function name — a prior
draft of this spec wrongly claimed this had zero coverage; it does not, and
nothing needs to be added for it. One gap remains real:

- **Timeline cursor / tie-break ordering.** `repository-contract.ts:86,99,111`
  test the `(published_at, id)` tuple-cursor pagination and its tie-break
  semantics. `logical-feeds.test.ts` tests feed transport and visibility,
  not this — it is not a like-for-like replacement. The plan must confirm
  whether the v2 timeline query (`sort_at DESC, id DESC` per
  `core/src/logical/projector.ts`) has its own tie-break test somewhere
  already; if not, write one covering the equivalent v2 semantics before
  deleting the v1 versions.

**7. `AdminRefreshResult`** (`core/src/logical/types.ts:256`) — out of
scope for this spec, correctly. It was flagged as possibly-dead in the
same backlog entry that triggered this spec, but was resolved before this
spec was written: commit `4eba531` ("core: wire AdminRefreshResult into the
refresh route it already describes"), the commit immediately preceding
this spec's own first draft, wired it live at
`core/src/api/logical-routes.ts:169,193`. Nothing to do here.

## Non-goals

- No change to `LogicalStore` or anything in `core/src/logical/` — this is
  entirely about retiring the v1 half of `Repository`/`SqliteRepository`/
  `service.ts`, not touching the v2 systems that already replaced it.
- No change to the *surviving* `Repository` methods' behavior or
  signatures, including the 5 rev-2-reinstated ones (`getPostsByAuthor`,
  `countRepliesByPostIds`, `getRecentLocalPosts`, `close`,
  `sweepAnonymousUsers`).
- No wire/HTTP contract changes — every one of the 21 methods being
  deleted was already unreachable from any route before this change;
  nothing about the running application's user-facing behavior changes.
- Confirmed non-overlap with the already-merged mechanical sweep
  (`ea99e71`, on `main` as of this rev — not an unmerged branch as rev 1
  implied): it touched none of `service.ts`, `repository.ts`, `sqlite.ts`,
  `repository-contract.ts`. It did touch `core/test/service.test.ts`
  (+33 lines) — the plan must read that file's CURRENT state, not assume
  rev 1's line citations still hold there.

## Testing

- Full core suite green before AND after, at every task boundary (this
  release's standing discipline).
- `tsc --noEmit` 0 errors after each task.
- **Corrected staging order** (rev 1's order did not compile — see below):
  1. Delete all callers first, together: `service.ts`'s wrapper functions,
     `repository-contract.ts` (its ~60 direct calls to the doomed methods,
     confirmed at e.g. `:44` `insertPost`, plus `getThread`/`adoptOrphans`/
     `addFollow`/etc.), and the 12 affected `core/test/` files from Design
     item 5 (a distinct set from item 1's 16 `createService`-required-arg
     files — some files appear on both lists, e.g. `service.test.ts`, but
     the two axes are independent and both must be swept). `repository-
     contract.ts` lives in `core/src/domain/` and is typed against
     `Repository` — it is a caller, not downstream cleanup, and
     `core/tsconfig.json` includes both `src` and `test`, so it and every
     affected test file are in `tsc`'s scope at every step.
  2. Only once every caller is gone: delete from `repository.ts` (the
     interface) and `sqlite.ts` (the implementation) together, in the same
     commit — an interface member with no implementation, or vice versa, is
     a compile error either way round.
  3. Rev 1's stated order (`service.ts` → `repository.ts`+`sqlite.ts` →
     `repository-contract.ts` last) breaks at step 2 in that ordering,
     because `repository-contract.ts` still calls the doomed interface
     methods and fails to compile the moment they're removed from
     `repository.ts`. The staging *principle* — interface and
     implementation must move together — was right; the error was treating
     the shared contract-test file as if it were downstream of the
     interface rather than a caller of it.
- The plan should size this as multiple small tasks — e.g., one per
  `service.ts` branch site's caller-side cleanup, one for
  `repository-contract.ts` + the 12 affected test files' caller-side
  cleanup (item 5), one for the ~16 `createService`-required-arg test
  files (item 1), one for the `repository.ts`+`sqlite.ts`
  interface+implementation deletion, one for the two new v2 tests in item
  6 — rather than one giant commit, consistent with how every other
  multi-file task this release was sequenced, and it keeps each task's
  diff reviewable.

## Grounding index

`core/src/domain/service.ts` (all 8 `if (logical)` sites: lines 50, 83,
106, 150, 164, 171, 197, 213) · `core/src/domain/repository.ts` (the
`Repository` interface, 47 methods) ·
`core/src/domain/repository-contract.ts` (448 lines, 38 tests, the shared
assertion suite, the sole consumer being `sqlite-repository.test.ts`) ·
`core/src/storage/sqlite.ts` (the sole `Repository` implementation;
`:536-547` the v2-union arm proving `countRepliesByPostIds` is post-V2
code) · `core/src/domain/push.ts` (`:226,235,253,255` — the live caller
rev 1 missed entirely) · `core/test/push.test.ts` (`:14` needs a real
logical store; `:179-190` the existing v2-union regression test) ·
`core/src/api/logical-routes.ts` (`:169,193` — `AdminRefreshResult`,
already resolved, out of scope) · the 16 test files named in Design item 1
(`createService`-required-arg fallout) and the 12 named in Design item 5
(direct doomed-method callers) — two distinct, overlapping sets, both
produced by the mechanical greps quoted in their respective sections, both
requiring the plan to re-run those greps rather than trust this document
· `docs/superpowers/ideas.md`'s "Dead client/service surface sweep" entry
(the deferred item this spec resolves).

*developed with the help of AI tools*
