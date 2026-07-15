# Textcaster debt batch — design

Date: 2026-07-15
Status: design approved (brainstorm); implementation not started
Author: Ricardo (rmdes) with Claude Code
Basis: spine complete at `addb889`; debt items from
`docs/superpowers/reviews/2026-07-15-spine-improvement-suggestions.md` (#12, #14, #15, #20) and
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
  `Migrator`), and cursor + replay share one keyset *mechanism* — but two
  orderings: pagination pages by `published_at` (display order), replay
  catches up by `created_at` (arrival order, matching bus emission). See §2.
- Spec review `docs/superpowers/reviews/2026-07-15-debt-batch-spec-review.md`
  (H1–H10) is incorporated below; its "Verified sound" list stands.

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
  - `user_version = 0` **and** tables already exist (`sqlite_master`
    non-empty — a just-created empty file has zero tables and is correctly
    classified fresh) → "pre-migration database — delete it (dev data only)
    and restart". **This intentionally includes valid current-schema spine
    DBs** — every DB created before this batch has `user_version = 0`, and
    we do NOT sniff the schema to grandfather them in. Deletion is the
    designed outcome; do not add schema detection.
  - `user_version >` highest known → "database is newer than this build".
- The mechanism is SQLite-private. The `Repository` interface does not
  know migrations exist; a future Postgres/Mongo adapter brings its own
  mechanism behind its own `createXRepository`.
- RUNNING.md's stale-DB section becomes: schema changes now produce a clear
  startup error; delete the dev DB when told to — **and the first boot after
  this batch will demand exactly that**, even for a freshly recreated spine
  DB.
- This batch ships only migration 1. It defines the whole current schema
  plus the right indexes: composite `(published_at, id)` for the timeline
  ordering (the spine's single-column `posts_published_idx` mis-splits
  keyset pages on `published_at` ties) and composite `(created_at, id)` for
  replay. Cursor, replay, and dup-handle need no further schema change.

## 2. Cursor + replay — one mechanism, two orderings (#12, #20)

The system has two orderings and they must not be conflated (spec-review
H1): the **timeline displays** by `(published_at DESC, id DESC)`, but the
**bus emits in arrival order**, and remote items keep past `publishedAt`
dates. A replay keyed on `publishedAt` would silently skip any old-dated
remote item ingested during the disconnect — the exact bug replay exists
to fix. Therefore:

- **Pagination** pages by `(published_at, id)` — display order.
- **Replay** catches up by `(created_at, id)` — arrival order, which is
  exactly what a continuously connected client would have received.

A cursor is a `(timestamp, id)` pair serialized as `<timestamp>~<id>`
(`~` never appears in ISO-8601 dates or UUIDs; both columns store
`toISOString()` values, so this holds for `created_at` too). Both
predicates use SQLite row-value comparison (kysely 0.27.6 supports it
natively via `eb.tuple`/`eb.refTuple` — no raw SQL).

Repository changes (all pinned by the adapter-neutral contract suite):

- `getTimeline(limit, before?)` — when `before` (a `publishedAt` cursor)
  is given: `(published_at, id) < (before.publishedAt, before.id)`, same
  display ordering as today.
- `getTimelineAfter(cursor, limit)` — entries with
  `(created_at, id) > (cursor.createdAt, cursor.id)`, ordered by arrival
  (`created_at ASC, id ASC`), capped at `limit`; used only by SSE replay.
- `getPost(id)` — returns the full `Post` (it carries both timestamps, so
  either cursor kind is derivable); `undefined` for unknown ids.

Contract-suite additions: page 2 starts exactly where page 1 ended;
`publishedAt` ties split correctly by id; `getTimelineAfter` excludes the
cursor post itself and returns arrival order even when `publishedAt`
order differs; unknown replay id → `getPost` returns undefined.

## 3. API + web surface

- `GET /timeline?before=<cursor>&limit=<n>` — `before` parsed and
  validated (400 on garbage), `limit` clamped to 1–100. Response gains
  `nextCursor: string | null` (null when the page came back short —
  i.e. no further pages).
- **SSE replay**: on connect to `GET /timeline/stream`, if the
  `Last-Event-ID` request header is present (EventSource sends it
  automatically on reconnect; Hono exposes it via `c.req.header()` inside
  `streamSSE`), core:
  1. **Subscribes to the live bus FIRST** (H2 — a post landing between
     replay query and subscription must not be lost; double-delivery is
     safe because clients dedup by id).
  2. Then `getPost(id)` → `getTimelineAfter(createdAtCursor, 101)`.
  3. **If more than 100 rows come back, skip replay entirely** (H4) —
     the client is too stale for patch-up; the SSR page is the recovery
     path. Otherwise write the missed posts as normal `post` frames
     **oldest-first in arrival order**.
  4. Unknown id (DB reset) → skip replay silently and go live.
  - **Backfill interaction (H3), decided: accepted.** A client
    disconnected during someone's first-sync backfill will receive those
    old posts as replay frames even though connected clients never saw
    them live. They are genuinely new content, the volume is bounded by
    the 100-cap skip rule, and excluding them would need a per-post
    emitted-live marker — more machinery than the annoyance warrants.
    Revisit only if it bites in practice.
- **Web `/stream` proxy** forwards the incoming `Last-Event-ID` request
  header upstream (the breadcrumb comment in
  `web/src/routes/stream/+server.ts` marks the spot).
- **Web page**: `load` reads `?before=` from the URL, passes it to the
  core call (URL-encoding the cursor in the link, since `publishedAt`
  contains `:`), and returns `isFirstPage: boolean` alongside the timeline
  (the flag, not the raw cursor, crosses the load boundary). When the
  response has a `nextCursor`, the page renders
  `<a href="/?before={encoded nextCursor}">Older posts</a>` under the
  list — plain link, no JS. The live island mounts **only when
  `isFirstPage`**: prepending live posts onto a history page would be
  wrong. Known edge, accepted: an exactly-limit final page has a non-null
  `nextCursor`, so its "Older posts" link leads to an empty page (which
  renders an empty list and no further link).

## 4. Duplicate-handle contract (#14)

- `HandleTakenError extends DomainError`, defined in
  `core/src/domain/types.ts`.
- **Adapters** must throw it from `createLocalUser`/`createRemoteUser` on
  a taken handle. SQLite adapter: rethrow typed **only** when the caught
  error's `code === 'SQLITE_CONSTRAINT_UNIQUE'` (no message parsing; in
  the createUser paths the only UNIQUE constraint reachable is
  `users.handle` — ids are fresh UUIDs). The contract suite pins the
  behavior for both user kinds — future adapters converge on it instead
  of leaking driver errors.
- **There are two service-level guards; only one dies (H8):**
  - `addRemoteUser`'s duplicate-handle pre-check (added in the spine's
    final fix batch) is **deleted** — the adapter's typed throw replaces
    it race-free. `app.onError` already maps `DomainError` → 400, so the
    API behavior (400 "handle already taken") is unchanged.
  - `ensureLocalUser`'s kind check ("handle belongs to a remote user")
    **stays** — for an existing user no insert happens, so the adapter
    never throws; deleting it would let anyone post as any remote user.
- **Race repair (H7):** `ensureLocalUser` is get-then-create, so two
  concurrent first posts under one handle would 400 the loser. It
  catches `HandleTakenError` and retries the lookup **once** (the found
  user then goes through the usual kind check).

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
  (`('ab','c')` vs `('a','bc')` no longer collide). Accepted consequence
  (H9): every stored guidless/linkless item gets a new fallback guid, so
  the first post-deploy poll re-inserts each such item once — dev-scale,
  one-time, then stable.
- Web form failures surface core's error message (H10): the api-client
  throws with the response body's `error` field when present
  (`invalid handle`, `handle already taken`) instead of `createPost 400`;
  the actions already pass `err.message` through to the page.
- The `/stream` proxy stamps `text/event-stream` only on OK upstream
  responses; error responses keep the upstream content-type (H10).
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
- No SSE replay beyond 100 missed posts (skip-and-go-live per H4); no
  per-post emitted-live marker for backfill exclusion (H3 accepted as-is).

## Testing approach

TDD throughout, extending the existing suites:

- Migration tests (temp-file DBs): fresh DB → current version; already-
  current DB → no-op; version-0-with-tables → fail-fast error; future
  version → fail-fast error.
- Contract suite grows the cursor/replay/dup-handle pins listed above.
- API tests: `before`/`limit` validation, `nextCursor` presence/null.
- SSE end-to-end tests: connect with `Last-Event-ID` → missed frames
  arrive (oldest-first, arrival order) before live frames; an old-dated
  remote item ingested "during the disconnect" IS replayed (the H1
  regression case); more than 100 missed → no replay frames, live still
  works.
- Web: load test for `?before=` passthrough and `isFirstPage`; the
  "Older posts" link renders only when `nextCursor` exists; island only
  on page 1.

## Sequencing

1. Migrations (everything else rides on the mechanism being in place).
2. Repository/contract work (cursor, replay lookup, dup-handle).
3. API surface (timeline params + nextCursor, SSE replay).
4. Web (proxy header, `?before=` load, older-posts link, island gating).
5. Minors.
