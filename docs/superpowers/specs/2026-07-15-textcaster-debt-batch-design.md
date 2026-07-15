# Textcaster debt batch — design

Date: 2026-07-15
Status: design approved (brainstorm); implementation not started
Author: Ricardo (rmdes) with Claude Code
Basis: spine complete at `addb889`; debt items from
`docs/2026-07-15-spine-improvement-suggestions.md` (#12, #14, #15, #20) and
the spine run's review ledger.

## What this is

The hardening batch between the spine and the next feature milestone. Four
real designs — schema migrations, timeline cursor pagination, SSE reconnect
replay, duplicate-handle contract semantics — plus a set of mechanical
minors. No new product features; every later milestone gets cheaper.

Decisions taken at design time:

- **Migrations use a fail-fast fresh baseline** — no retroactive upgrades
  for pre-migration dev DBs; they get a clear startup error telling the
  operator to delete the file.
- **Cursor pagination is wired end to end** — repository → API → a plain
  no-JS "Older posts" link in the web UI, not an API-only param.
- **Approach A**: hand-rolled `PRAGMA user_version` migrations (no Kysely
  `Migrator`), and cursor + replay share one keyset-ordering primitive.

## 1. Migrations (#15)

- `core/src/storage/sqlite.ts` gains `const MIGRATIONS: string[][]` — an
  ordered array; index N-1 holds the SQL statements that bring the schema
  to version N. **Migration 1 = today's full schema**; the current
  `createTable(...).ifNotExists()` bootstrap converts into it and is
  deleted.
- `createSqliteRepository` reads `PRAGMA user_version` and applies each
  pending migration batch inside a transaction, stamping `user_version`
  after each batch.
- **Fail-fast rules** (thrown at startup, before serving anything):
  - `user_version = 0` **and** tables already exist → "pre-migration
    database — delete it (dev data only) and restart".
  - `user_version >` highest known → "database is newer than this build".
- The mechanism is SQLite-private. The `Repository` interface does not
  know migrations exist; a future Postgres/Mongo adapter brings its own
  mechanism behind its own `createXRepository`.
- RUNNING.md's stale-DB section shrinks to: schema changes now produce a
  clear startup error; delete the dev DB when told to.
- This batch likely ships only migration 1 — cursor, replay, and
  dup-handle need no schema change (`posts_published_idx` already covers
  the timeline ordering).

## 2. Cursor + replay — one ordering, two consumers (#12, #20)

Timeline ordering stays `(published_at DESC, id DESC)`. A **cursor** is
the pair `{ publishedAt, id }`, serialized on the wire as
`<publishedAt>~<id>` (`~` never appears in ISO-8601 dates or UUIDs).

Repository changes (all pinned by the adapter-neutral contract suite):

- `getTimeline(limit, before?)` — when `before` is given, keyset predicate
  `(published_at, id) < (before.publishedAt, before.id)` under the same
  ordering (SQLite row-value comparison, supported since 3.15).
- `getTimelineAfter(cursor, limit)` — the mirror: entries strictly newer
  than the cursor, capped at `limit`; used by SSE replay.
- `getPost(id)` — turns a `Last-Event-ID` into a cursor.

Contract-suite additions: page 2 starts exactly where page 1 ended;
`publishedAt` ties split correctly by id; `getTimelineAfter` excludes the
cursor post itself; unknown replay id → `getPost` returns undefined.

## 3. API + web surface

- `GET /timeline?before=<cursor>&limit=<n>` — `before` parsed and
  validated (400 on garbage), `limit` clamped to 1–100. Response gains
  `nextCursor: string | null` (null when the page came back short —
  i.e. no further pages).
- **SSE replay**: on connect to `GET /timeline/stream`, if the
  `Last-Event-ID` request header is present (EventSource sends it
  automatically on reconnect), core does `getPost(id)` →
  `getTimelineAfter(cursor, 100)` and writes the missed posts as normal
  `post` frames **oldest-first** (so a prepending client ends up ordered)
  before subscribing to the live bus. Unknown id (DB reset) → skip replay
  silently and go live.
- **Web `/stream` proxy** forwards the incoming `Last-Event-ID` request
  header upstream (the breadcrumb comment in
  `web/src/routes/stream/+server.ts` marks the spot).
- **Web page**: `load` reads `?before=` from the URL and passes it to the
  core call; when the response has a `nextCursor`, the page renders
  `<a href="/?before={nextCursor}">Older posts</a>` under the list — plain
  link, no JS. The live island mounts **only on page 1** (no `before`):
  prepending live posts onto a history page would be wrong.

## 4. Duplicate-handle contract (#14)

- `HandleTakenError extends DomainError`, defined in
  `core/src/domain/types.ts`.
- **Adapters** must throw it from `createLocalUser`/`createRemoteUser` on
  a taken handle. SQLite adapter: catch the UNIQUE violation on
  `users.handle`, rethrow typed. The contract suite pins the behavior for
  both user kinds — future adapters converge on it instead of leaking
  driver errors.
- The service-level check-then-throw guard added in the spine's final fix
  batch is **deleted** — the guard moves to where it is race-free.
  `app.onError` already maps `DomainError` → 400, so the API behavior
  (400 "handle already taken") is unchanged.

## 5. Minors (mechanical)

- `loadConfig` rejects non-numeric `TEXTCASTER_PORT` /
  `TEXTCASTER_POLL_SECONDS` (clear startup error instead of NaN).
- `displayName` blank-after-trim falls back to `handle` at the route
  level (today only absence triggers the fallback).
- Two api-client unit tests in `web/src/lib/api.test.ts` asserting the
  `authorization: Bearer` header on `createPost` and `addRemoteUser`.
- Align TypeScript majors across workspaces: move core to `^6` if
  `tsc --noEmit` stays clean; otherwise pin web back to `^5`.
- `fallbackGuid` joins its hash inputs with `'\0'` separators
  (`('ab','c')` vs `('a','bc')` no longer collide).
- JSON Feed detection drops the `contentType.includes('json')` disjunct —
  body sniff only (first non-whitespace char `{`, after stripping a BOM).
  A mis-labeled XML feed can no longer be routed into `JSON.parse`.
- Backfill/empty-first-sync: current behavior is already correct (an
  empty first sync leaves the author postless, so the next sync is still
  silent backfill — nothing was ever live-visible). This item is a **test
  pinning that semantic**, not a behavior change.

## Non-goals

- No feed output / WebSub (next milestone), no following, no threading,
  no auth changes, no Postgres/Mongo adapters.
- No streaming body cap for ingestion (F4 stays a documented ceiling).
- No SSE replay persistence beyond the newest 100 posts.

## Testing approach

TDD throughout, extending the existing suites:

- Migration tests (temp-file DBs): fresh DB → current version; already-
  current DB → no-op; version-0-with-tables → fail-fast error; future
  version → fail-fast error.
- Contract suite grows the cursor/replay/dup-handle pins listed above.
- API tests: `before`/`limit` validation, `nextCursor` presence/null.
- SSE end-to-end test: connect with `Last-Event-ID` → missed frames
  arrive (oldest-first) before live frames.
- Web: load test for `?before=` passthrough; the "Older posts" link
  renders only when `nextCursor` exists.

## Sequencing

1. Migrations (everything else rides on the mechanism being in place).
2. Repository/contract work (cursor, replay lookup, dup-handle).
3. API surface (timeline params + nextCursor, SSE replay).
4. Web (proxy header, `?before=` load, older-posts link, island gating).
5. Minors.
