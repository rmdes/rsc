# Textcaster spine — 20 improvement suggestions

Date: 2026-07-15
Basis: design spec (`docs/superpowers/specs/2026-07-15-textcaster-design.md`),
implementation plan (`docs/superpowers/plans/2026-07-15-textcaster-spine.md`),
the SDD progress ledger, and the code as of task 5 (commit `171041f`).

This is a review document, not a work order. The executing session is mid-plan
(tasks 6–13 pending); each item says **when** it's cheapest to act. Items
marked *(ledger)* were already flagged during task reviews and are confirmed
here with a concrete fix.

---

## Correctness bugs (fix before or at task 13)

### 1. Guid dedup is global, but should be per-author
`posts.guid` has a global UNIQUE constraint and `hasPostGuid(guid)` isn't
scoped to an author. Two remote users whose feeds carry the same item (two
planet-style aggregators, or two people syndicating the same article with the
same canonical URL as guid) → the second user's item is silently dropped, or
`insertPost` throws inside `pollAll`. Change the constraint to
`UNIQUE(author_id, guid)` and the contract method to
`hasPostGuid(authorId, guid)`. One-line schema change now; a three-adapter
migration later.

### 2. `randomUUID()` guid fallback breaks idempotency *(ledger)*
In `parseFeed`, an item with no guid and no link gets a fresh UUID per poll →
re-inserted every cycle, forever, and each re-insert emits on the bus (live
timelines get spammed). Fallback should be deterministic: a hash of
`content + publishedAt` (`node:crypto` `createHash('sha256')`, stdlib).

### 3. `PRAGMA foreign_keys = ON` missing *(ledger)*
SQLite ignores FK constraints by default; `posts.author_id REFERENCES users.id`
is decorative. One line in `createSqliteRepository`:
`new Database(filename).pragma('foreign_keys = ON')`.

### 4. Check-then-insert race → replace `hasPostGuid` with conflict-tolerant insert
`ingestRemoteUser` does `hasPostGuid` then `insertPost` — a TOCTOU pair that
throws if the poller and a manual ingest overlap. Simpler contract: drop
`hasPostGuid` entirely and make `insertPost` return `boolean` using
`ON CONFLICT DO NOTHING` (Kysely: `.onConflict((oc) => oc.doNothing())`).
One round trip instead of two, race-free by construction, and one less method
every future adapter must implement. Pairs with #1.

### 5. Domain errors surface as raw 500s
`createLocalPostAs` throws `Error('handle belongs to a remote user')`; Hono
will turn that into a 500. Task 6 should map known domain errors to 4xx JSON
(a tiny `app.onError` or a try/catch in the route). Also reconcile the plan's
two error strings (`'unknown local user'` in the Interfaces paragraph vs the
implemented message) *(ledger)*.

### 6. Poller intervals can overlap
`setInterval(() => void pollAll(...))` (task 8) fires again even if the
previous `pollAll` is still running (one slow feed is enough). Use a
self-rescheduling `setTimeout` loop: `async function loop() { await pollAll();
setTimeout(loop, ms) }`. Same line count, no overlap.

## Security / trust boundary (fix in tasks 6–8, not later)

### 7. Open `POST /users` + poller = SSRF service
Anyone can POST a `feedUrl` of `http://169.254.169.254/…` or
`http://localhost:8787/…` and the server will fetch it on a loop. In the
spine, put `POST /users` behind the same bearer token as `/posts` (the web
app calls it server-side with the token anyway — nothing is lost), and
validate `feedUrl` is `http(s):`. Blocking private IP ranges can wait for the
"real auth" milestone, but scheme validation and auth are two lines now.

### 8. No request-body validation at the API boundary
Task 6's routes destructure `await c.req.json()` unchecked: missing fields
become `undefined` and flow into the DB (`NOT NULL` throws a 500), and there
are no length caps (a 100 MB `content` is accepted). Validate shape, presence,
and rough max lengths in the routes. Plain `typeof` checks suffice — no
schema library needed for four fields.

### 9. Timing-safe token comparison
`header !== \`Bearer ${token}\`` in `auth.ts` is a textbook timing-leak
pattern. `crypto.timingSafeEqual` on equal-length buffers is three lines.
Low practical risk at spine scale, but it's the kind of thing that never gets
revisited — do it while the file is one function long.

### 10. Fetch without timeout or size cap
`ingestRemoteUser` will hang on a feed that never responds and buffer a body
of any size. `fetchFn(user.feedUrl, { signal: AbortSignal.timeout(10_000) })`
plus a `content-length`/byte cap (a few MB) keeps one bad feed from stalling
every poll cycle. Stdlib only.

## Schema / contract — cheap now, expensive after three adapters

### 11. `Post.title` is missing, and the Textcasting profile is *about* titles
The design's behavioral contract ("optional titles, Markdown+HTML dual
content") is the product's namesake, yet `parseFeed` irreversibly flattens
title into content with `' — '`. Add `title: string | null` to `Post` now,
while the schema is days old and there's one adapter. Feed output (deferred
item #1) cannot round-trip titles otherwise — you'd be violating your own
profile on the very first federation milestone.

### 12. Timeline needs a cursor, not just a limit
`getTimeline(limit)` can't page. The SSR "refresh for more" story and any
future infinite scroll need `getTimeline(limit, before?)` (before = a
`(publishedAt, id)` cursor). Adding an optional parameter now costs nothing;
changing the `Repository` contract after Postgres/Mongo adapters exist costs
three implementations plus the contract suite.

### 13. Normalize and constrain handles
Handles are identity, auto-created on first post, and the UNIQUE constraint is
case-sensitive — `Alice` and `alice` become two users today, and future
IndieAuth claiming inherits whatever garbage got in. Lowercase on write and
enforce a charset (`^[a-z0-9-]{1,64}$`) in the service. Two lines that spare a
data-cleanup migration at milestone 4.

### 14. Define contract behavior for duplicate handles
`createLocalUser` with a taken handle currently throws a raw better-sqlite3
error — adapter-specific and untested. The contract suite should pin the
behavior (a typed domain error, or "returns existing"), so Postgres/Mongo
adapters converge on it instead of each leaking their own driver error.

### 15. A minimal migration story before first real deploy
Schema bootstrap is `ifNotExists`, so any schema change is a silent no-op on
existing databases — the first person who upgrades a running instance gets a
crash or quiet data skew. A `PRAGMA user_version`-gated list of migration
statements (10 lines, no library; Kysely `Migrator` if you'd rather) turns
"reset your DB" into "restart the server". Needed before anyone but you runs
this; trivially retrofittable onto #1/#11's schema changes.

## Ingestion robustness

### 16. Don't trust `content-type` to detect JSON Feed
`contentType.includes('json')` misses the many JSON Feeds served as
`text/plain` or `application/octet-stream`, and those bodies then hit the XML
parser and fail. Sniff instead: if the body's first non-whitespace char is
`{`, try JSON Feed first, else RSS/Atom. Keeps the content-type as a hint,
not a gate.

### 17. First ingest of a feed floods the live timeline
Adding a remote user with a 50-item feed emits 50 bus events → every connected
browser's live island prepends 50 old posts above the fold, timestamped in the
past. Suppress bus emits when the user has zero existing posts (first sync =
backfill, silent; subsequent polls = live). One boolean, and clamp
`publishedAt > now` to now while you're there so a feed with future-dated
items can't pin the top of the timeline.

### 18. Add an Atom fixture test
Commit `171041f` says "RSS/Atom + JSON Feed" but `ingest.test.ts` covers only
RSS 2.0 and JSON Feed — Atom support is an untested claim inherited from
rss-parser. One fixture test (`<feed xmlns=…><entry>…`) makes the claim true;
Atom's `id`-vs-`link` guid semantics differ from RSS, so it's the fixture most
likely to catch a real mapping bug.

## Architecture / deployment

### 19. Proxy SSE through SvelteKit instead of exposing core to browsers
Task 12 has the browser open `EventSource(PUBLIC_CORE_SSE_URL)` straight at
the core — the only browser-facing core touchpoint, and the sole reason CORS
config exists. Add a `web/src/routes/stream/+server.ts` that pipes the core's
SSE response through (a ~10-line pass-through `fetch`), and the deployment
story collapses to one public origin: core stays fully private,
`TEXTCASTER_CORS_ORIGIN` and the `PUBLIC_` env var get deleted, and the
plan's own "CORS ordering" caveat in task 8 evaporates. Fewer moving parts,
strictly better for the Docker/Cloudron operators the design targets.

### 20. SSE reconnect misses posts — use event IDs for catch-up
On network blips `EventSource` auto-reconnects, but every post emitted while
disconnected is lost until a manual refresh — quietly undermining "live
timeline" on flaky connections. SSE has this built in: set `id: <post.id>` on
each frame; the browser sends `Last-Event-ID` on reconnect; the stream handler
replays newer posts from the repository before going live. Cheap while the
stream handler is 8 lines (task 6/7); retrofitting replay onto a deployed
protocol is a versioning event. Fine as a fast-follow after task 13, but the
`id:` field itself should go in now — it's one key in `writeSSE`.

---

## Suggested sequencing

- **Fold into remaining tasks 6–8:** #5, #7, #8, #9 (task 6); #6, #10 (task 8);
  #19, #20's `id:` field (tasks 6–7, 12).
- **Small pre-task-13 fix batch (schema + ingest, one commit each):**
  #1–#4, #11, #13, #16, #17, #18.
- **Fast-follow after the spine is green:** #12, #14, #15, #20's replay.
