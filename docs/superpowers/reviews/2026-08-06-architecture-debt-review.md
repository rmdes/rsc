# Architecture & technical-debt review — 2026-08-06

Scope: whole repo. Requested honest assessment ahead of a possible large
refactor, after earlier refactor attempts "didn't succeed".

Method: read `core/src/logical/*` headers (all 19), `core/src/api/*`,
`core/src/domain/*`, `core/src/storage/sqlite.ts` structure,
`web/src/lib/*`, both catch-all proxies, both `+page.server.ts` patterns,
`package.json` × 2. Gates run where the host allows.

## Evidence actually gathered

| Check | Result |
|---|---|
| `core: npx tsc --noEmit` | **exit 0, clean** |
| `web: npx svelte-check` | 39 "errors", **all the same** `EACCES` on `web/node_modules/.vite-temp/…` — host permission artifact, not type errors. Web checks run in-container per project convention; **web type state is unverified this pass.** |
| Test suite | **not run** (Docker). 107 core test files, 1,544 `it/test` blocks, 23,463 LOC test vs 15,025 LOC core src. |
| `git` | main **18 ahead** of `origin/main`, 0 behind. 1,036 commits in 30 days. Worktree HEAD moved mid-session (parallel session commits on `main`). |
| `senior-fullstack` analyzer | **Discarded — invalid input.** Reported 865 files / 494 JavaScript files; the repo has **275** JS/TS source files and **one** `.js` file. It counted `graphify-out/` (271 files) and build output. Its "0/100 F", "23% coverage", "67 critical" and "0 dependencies" are artifacts of that. No finding from it is used below. |

## Corrections to the earlier deep-dive in this session

1. **`logical/store.ts` is not a delegation façade.** It is 340 lines of admin
   projection helpers (`runProjection`, `acquisitionRun`, `adminItemDetail`,
   row types, column lists) plus one 440-line factory. **Zero** methods are
   one-line delegations. "Split it into a barrel" was wrong advice.
2. **`sqlite.ts`'s split boundary is sharper than stated**: the class
   implements *two* interfaces — `Repository` (users/posts/settings/subs) and
   `SourceRepository` (sources/federation/following/transitions). The second
   occupies roughly lines 535–1245.

## The actual debt, ranked

### 1. Two god objects re-aggregate every module — this is why refactors don't land

- `LogicalStore` (`logical/store.ts:341`) — **50 methods**, covering local post
  CRUD, follows, profile, acquisition, reconciliation, verification, orphan
  adoption, admin run/job reads, moderation, purge, fanout, item audit, push
  rows, scheduler queries, health.
- `SqliteRepository` (`storage/sqlite.ts:208`) — **46 methods** across two
  interfaces.

`logical/` is already split into 19 files by concern. That split is real and
good. But every one of those files is reachable only *through* `LogicalStore`,
and `sqlite.ts` imports back into `logical/` six ways (membership, journal,
fanout, acquisition, tombstones, schema). **Splitting files under a façade that
re-aggregates everything moves lines without moving coupling** — the next change
still edits the façade, so the refactor feels like it changed nothing. That is
the mechanical explanation for "I already tried without much success."

The `logical-routes.ts` split (7 SDD tasks, 2026-08-06) succeeded precisely
because routes had *no* façade: the barrel is a pure re-export and callers
import concrete route mounters. Same technique applied to `store.ts` will
fail, because `LogicalStore` is a real type that ~40 call sites depend on.

### 2. Two live data models, joined by an adapter at the center

`core/src/domain/feed.ts:20`:

```ts
export function logicalToFeedEntry(dto: LogicalItemDto): TimelineEntry
```

v2 DTOs are **downgraded to the v1 shape** to feed RSS/JSON generation
(`logical-routes/read.ts` × 6 call sites), the firehose, comment feeds, the
event bus (`bus.ts` `emitNewPost(TimelineEntry)`), and outbound push
(`push.ts:200 onLocalPost(entry: TimelineEntry)`).

The web mirrors it: `lib/types.ts` (`TimelineEntry`, 22 files) alongside
`lib/logical-types.ts` (266 lines, 14 files); `lib/api.ts` (391 lines) alongside
`lib/logical-api.ts` (258 lines). The home page loads through **both**
(`+page.server.ts:3-4`).

Neither model can be deleted unilaterally: feeds and push consume v1, reads
produce v2. This is the single highest-value thing to resolve and the reason
the "V1 retirement" milestone could close while v1 shapes stayed alive.

### 3. Hand-duplicated twins that npm workspaces would solve for free

`core/src/domain/markdown.ts` (83 lines) and `web/src/lib/server/render.ts`
(92 lines) are **byte-identical modulo tabs-vs-spaces and trailing commas** —
verified by diff. Guarded today by a drift-canary test in both suites and a
CLAUDE.md invariant ("change both or neither").

They also drag **9 duplicated dependencies pinned to identical exact versions**
in both workspaces: `unified@11.0.5`, `remark-parse@11.0.0`, `remark-gfm@4.0.1`,
`remark-breaks@4.0.0`, `remark-emoji@5.0.2`, `remark-rehype@11.1.2`,
`rehype-highlight@7.0.2`, `rehype-stringify@10.0.1`, `unist-util-visit@5.1.0`,
plus `sanitize-html`.

This is already an npm-workspaces repo. A third workspace holding one module
deletes the duplication, the canary test, and the invariant — and makes the XSS
gate literally single-source instead of "single-source by discipline".

`native:` npm workspaces. `[core/src/domain/markdown.ts + web/src/lib/server/render.ts]`

### 4. Migration numbering no longer describes what runs

Entries 19, 22 and 23 in `MIGRATIONS` are **no-op SQL markers** whose real work
runs in JS after the loop (`sqlite.ts:1580-1590`: `healMembers`,
`collapseVersionHistory`, member-reap heal). Legitimate pattern — `sqlite.exec`
can't do it — but "we're on migration 23" no longer tells anyone what happened.
One comment block at the `MIGRATIONS` declaration fixes this. Cheap.

### 5. Volume as its own risk

1,036 commits in 30 days, 58 specs / 59 plans / 60 reviews, main 18 commits
unpushed, a parallel session committing to the same checkout. The
spec→plan→review→SDD discipline is visibly working — the seam comments in
`api/app.ts` and `logical/*` are the proof, and they are the best asset in this
codebase. But unpushed work on a shared checkout is the one place where that
discipline has no backstop.

## What is genuinely good — do not refactor this

Listing this because the stated willingness to "refactor large parts" is
itself a risk.

- **`projector.ts`'s no-DB purity** (`:12`) — reconciliation writes hints, reads
  re-derive with the same pure comparators, stored hints are never authority.
  This is the strongest design decision in the repo. Any refactor that lets a
  read trust a stored hint is a regression, not a cleanup.
- **The security seams** — auth proxy, `/api/v1` proxy, per-hop SSRF
  re-validation, HMAC push-in, and the `app.ts:139` ↔ `acquisition.ts` BOUNDS
  equality test. Each carries the incident that produced it in a comment. Leave
  them; the comments are the reason they haven't regressed.
- **The documented single-lane ceilings** (`reconcile.ts:22`, `scheduler.ts:5`,
  `fanout.ts:16`, `tombstones.ts:19`) — every one names its upgrade trigger.
  That is correctly deferred work, not debt.
- **`api/logical-routes/`** — just split, byte-identical moves, reviewed. Done.

## Recommended order

Smallest risk and clearest payoff first. Each is independently shippable.

1. **Shared render workspace.** Move the twin into a third npm workspace; both
   sides import it. Deletes ~90 duplicated lines, ~9 duplicated deps, one
   canary test, and one CLAUDE.md invariant. Mechanical, high confidence.
2. **Migration comment.** One block. Minutes.
3. **Split `SqliteRepository` along its two interfaces** — `Repository` stays,
   `SourceRepository` moves to its own file/class over the same connection.
   The seam already exists in the type system, so the compiler proves the move.
   This is the `logical-routes` technique applied where it actually works.
4. **Retire `TimelineEntry` — the real one.** Requires a spec, not a patch:
   pick the target shape (almost certainly `LogicalItemDto`), then convert the
   consumers in order — feed generation, comments feed, firehose, `bus`/`push`,
   then web `types.ts`/`api.ts`. `logicalToFeedEntry` is deleted last, and its
   deletion is the completion test. Expect this to be the biggest single piece
   of work in the repo, and do not start it in the same window as (3).
5. **`LogicalStore` — do not split by file. Split by consumer.** The 50 methods
   fall into roughly: write commands, acquisition/reconciliation worker surface,
   admin reads, push/scheduler infrastructure. Define those as *separate
   interfaces over the same object* first (zero runtime change, compiler-checked),
   let call sites narrow to the interface they need, and only then consider
   whether the object needs splitting at all. If narrowing alone kills the
   coupling pain, stop there — that is the whole win, at a fraction of the risk.

## Anti-recommendation

Do not attempt (4) and (5) together, and do not start either while 18 commits
are unpushed on a checkout a second session is writing to. Push first.
