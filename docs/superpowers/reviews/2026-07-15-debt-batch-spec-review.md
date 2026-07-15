# Spec review — debt batch design (pre-implementation)

## Re-review of revision 2 (b9c90c9): PASSES with one amendment

All ten holes (H1–H10) and the four pinned ambiguities are genuinely
addressed in the revised spec — the H1 rewrite (replay by `(created_at, id)`
arrival order, pagination by `(published_at, id)`), subscribe-then-replay,
the accepted-and-documented H3/H4 decisions, the explicit H6 fail-fast
wording, the two-guards H8 split, and the H7 retry-once are all correct as
written. One residual edge, exposed by the H1+H2 fixes interacting with how
ingest stamps timestamps:

### R1 — same-millisecond `created_at` ties can still lose replay posts

`ingestRemoteUser` stamps `created_at` per item inside a tight loop
(`ingest.ts:76`), so one poll cycle gives many items the **identical**
millisecond ISO string, while ids are random UUIDs and bus emission order is
loop order. Scenario: a poll inserts items A, B, C with equal `created_at`;
a client receives A's frame and disconnects; B and C are emitted after the
disconnect. Replay predicate `(created_at, id) > (T, id_A)` excludes any of
B/C whose random id sorts below `id_A` (~50% each) — **permanently lost**,
and mid-burst disconnects target exactly the moment bursts happen.

**Fix (recommended, cheapest):** make replay *inclusive on the timestamp* —
scan `created_at >= cursor.createdAt` with no id tiebreak in the predicate,
still ordered `(created_at ASC, id ASC)`, and let the client's existing
dedup-by-id absorb the re-delivered same-ms batch (double-delivery is
already declared safe in H2). The contract line "getTimelineAfter excludes
the cursor post itself" flips to "may include it; consumers dedup by id".
Cap rule unchanged (fetch 101 of the inclusive scan). Alternative — a
monotonic sequence column — is strictly more machinery for the same result.

### R2 — cosmetic, accept with a sentence

With subscribe-first, live frames can interleave with replay frames; the
island prepends in arrival order, so a live post can momentarily sit below
newer-prepended replay posts until refresh. This is the island's existing
prepend semantic, not a new defect — one sentence in §3 accepting it keeps
an implementer from "fixing" it with client-side sorting machinery.

**Verdict:** fix R1 in the spec (it changes §2's replay predicate and one
contract-test line), optionally add R2's sentence, and this is ready for
writing-plans. Nothing else found; the revision introduced no new holes.

---

Date: 2026-07-15
Target: `docs/superpowers/specs/2026-07-15-textcaster-debt-batch-design.md`
Status of target: not yet implemented — these are design holes to fix in the
spec before work starts. Factual claims below were verified against the
current code and the installed libraries (kysely 0.27.6, better-sqlite3,
hono, @sveltejs/kit), not just the spec text.

**Verdict: not ready as-is.** One load-bearing premise (H1) is broken; six
items need a one-line decision or wording fix. The migration mechanism,
testing approach, sequencing, and every library-dependent claim check out.

## Holes

### H1 — DESIGN-BREAKING: replay keyed on `(publishedAt, id)` silently loses posts

The spec's economy — "cursor + replay share one keyset-ordering primitive" —
fails because the system has two orderings. SSE frames are emitted in
**arrival** order, and remote items keep *past* `publishedAt` dates
(`ingest.ts` clamps only future dates). Scenario: client receives local post
L1 (published 12:00), disconnects; poller ingests remote item R1 with
publishedAt 09:00; client reconnects with `Last-Event-ID: L1` → cursor
`(12:00, L1.id)` → `getTimelineAfter` returns nothing → **R1 is never
delivered**, though a connected client would have seen it live. That is the
exact bug class replay exists to fix, and old-dated remote items are the
common case, not the edge.

**Fix:** replay keys on `(created_at, id)` — arrival order, which matches
bus emission — while pagination keeps `(published_at, id)`. Two predicates,
two cursors; §2 and `getPost`'s return shape need a small rewrite.

### H2 — subscribe BEFORE replay, not after

"Writes the missed posts before subscribing to the live bus" loses any post
created between the replay query and the subscription. Reverse the order:
subscribe first, then replay. The client already dedups by id, so
double-delivery is safe and misses are not. One-sentence change.

### H3 — reconnect replays the silent backfill

A client disconnected during someone's first sync reconnects → replay
delivers up to 100 backfilled old posts as live frames — the flood #17
suppressed, reintroduced through the back door. Decide explicitly: accept it
(they are genuinely new content; an SSR reload shows them too) or exclude
backfill from replay (needs a marker column — more machinery). The spec
doesn't currently know this interaction exists.

### H4 — the 100-post replay cap is doubly unspecified

Which 100 when more were missed (oldest-after-cursor = client permanently
misses the newest; newest-100 = silent mid-stream gap), and no truncation
signal either way. Cheapest coherent rule: if the replay query hits the cap,
skip replay entirely — the client is too stale for patch-up and the SSR page
is the recovery path. Any rule is fine; write one down.

### H5 — §1's index claim is false as stated

`posts_published_idx` is single-column; `ORDER BY published_at DESC, id DESC`
ties order by rowid, not id, so keyset pages can mis-split on ties.
Migration 1 is being written anyway — make it composite `(published_at, id)`
(plus `(created_at, id)` when H1 lands).

### H6 — fail-fast bricks valid current-schema DBs; say so explicitly

Every existing spine DB — including the dev stack DB running right now,
which has exactly the migration-1 schema — has `user_version = 0` and trips
"pre-migration — delete it". Consistent with the stated decision, but the
spec must say "this includes valid current-schema spine DBs", or an
implementer will 'helpfully' add schema sniffing. RUNNING.md's note must
warn that the first post-batch boot demands a delete even for
freshly-recreated spine DBs.

### H7 — deleting the service guard exposes a race that 400s a legitimate first post

`ensureLocalUser` is get-then-create. With the adapter throwing
`HandleTakenError`, two concurrent first posts under one handle → the
loser's `createLocalUser` throws → 400 "handle already taken" for a user
that exists and is local. Fix: `ensureLocalUser` catches `HandleTakenError`
and retries the lookup once.

### H8 — "the service-level guard is deleted": there are TWO guards; only one dies

Delete the `addRemoteUser` dup check (the final-fix-batch addition). The
`ensureLocalUser` kind check ('handle belongs to a remote user') **must
stay**: for an existing user no insert happens, so the adapter never throws —
deleting it would let anyone post as any remote user. The spec's current
wording lets an implementer take both.

### H9 — MINOR: `'\0'` separator change re-ingests existing fallback-guid posts once

New hash input = new guid for every stored guidless/linkless item → one
duplicate insert per item on the first post-deploy poll, then stable.
Dev-scale, acceptable — but state it.

### H10 — MINOR: two ledgered minors silently dropped

Missing from §5 and Non-goals: (1) surface core's error JSON in web form
failures (user currently sees `createPost 400`, not `invalid handle`);
(2) the proxy stamps `text/event-stream` on forwarded error responses.
Include or explicitly defer.

## Ambiguities to pin

- Island gating on page 1: what crosses the load boundary (return `before`
  or an `isFirstPage` flag from `load`)?
- `nextCursor` on an exactly-limit final page is non-null → "Older posts"
  link to an empty page. Probably fine; say so.
- "Tables already exist" detection = `sqlite_master` non-empty (a
  just-created empty file has zero tables → correctly classified fresh).
- `HandleTakenError` detection: pin "error `code === 'SQLITE_CONSTRAINT_UNIQUE'`
  only, no message parsing".

## Verified sound (don't re-check)

- `~` cursor separator is safe: all writers store `toISOString()` dates and
  `randomUUID()` ids; holds for `created_at` too.
- kysely 0.27.6 supports row-value comparison natively (`eb.tuple` /
  `eb.refTuple`) — no raw SQL needed.
- better-sqlite3 `SqliteError` has `.code`; `SQLITE_CONSTRAINT_UNIQUE` in
  createUser paths can only be the handle column (ids are fresh UUIDs).
- Hono exposes `c.req.header('Last-Event-ID')` inside `streamSSE` routes.
- TS alignment: web already runs TypeScript 6.0.3 (nested), core hoists
  5.9.3 from `^5.6.0`; the spec's try-6-else-pin-5 direction is coherent.
- JSON-sniff-only is complete: JSON Feed's top level must be an object;
  `{`-after-BOM covers every valid feed.
- Empty-first-sync is indeed already-correct behavior; test-pin only.
- Proxy reconnects open a fresh upstream fetch with abort propagation
  already in place; forwarding the header is the only missing piece.
- `PRAGMA user_version` participates in transactions; batch+stamp rolls
  back atomically, and SQLite DDL is transactional.

## What must change before implementation

Rewrite §2's replay keying to arrival order (H1: `created_at` cursor,
composite indexes per H5, subscribe-then-replay per H2), add one-line
decisions for H3/H4, fix the H6/H8 wording so the implementer can't do
damage, add H7's retry-once, and one sentence each for H9/H10. After that,
implementable without further design work.
