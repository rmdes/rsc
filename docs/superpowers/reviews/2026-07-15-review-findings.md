# Review findings

## Round 3 — final verification (4075262..f9ac324): GREEN, verified live

All four gates run fresh: core tests 41/41, core typecheck clean, web tests
11/11, svelte-check 0 errors (web build also succeeds). No new bugs found.

Round-2 fixes verified in code and at runtime: W1 (`.ts` extensions dropped
from `$lib` imports — the right fix), W2 (form errors render with
`role="alert"` for both actions; confirmed visible live), W3 (core-down →
HTTP 200 + "Core API unreachable" notice, proven with core actually dead).
The duplicate-remote-handle 400 lands as a `DomainError` guard in the
service — no SQLite leakage into domain code; its check-then-insert race is
marked with a `ponytail:` comment.

End-to-end boot per RUNNING.md (temp DB, 5s poll, local RSS fixture):
health ✓; local post ✓; remote feed ingested alongside it in one timeline ✓
(**the coexistence thesis, observed**); first sync silent on SSE (0 frames
for a 2-item backfill) ✓; live `event: post` frame with `id:` on a new
post ✓; fresh feed item arrived live within one poll ✓; SSR page shows both
post kinds with curl (no JS) ✓; SSE proxy relays end to end ✓; no-JS compose
form 303s and lands ✓; invalid handle shows a visible error ✓.

RUNNING.md is accurate: stale-DB warning (F3) present, adapter-node note
present, no stale env-var references, commands runnable as written
(`--env-file-if-exists=.env` in the dev script is load-bearing and present).

**Open ledger (known, non-blocking):** #12 cursor, #14 duplicate-handle in
the *Repository contract* (service guard landed; adapter behavior still
unpinned), #15 migrations (warning is mitigation, not fix), #20 Last-Event-ID
replay (id: emitted; proxy carries the forward-the-header comment), F4
memory-unbounded cap for chunked bodies, generic web error strings
(`createPost 400` instead of core's message).

---

## Round 2 — F1/F2 fixes + web app (f7b02d9..4075262)

Checks: `npm test -w core` → 39/39. `npm test -w web` → 10/10. Core
typecheck clean. **`npm run check -w web` (svelte-check) FAILS — 5 errors**
(see W1).

F1 and F2 from round 1: **both verified fixed.** F1's test forces a
different "now" between polls via `vi.setSystemTime`, so it genuinely proves
determinism. F2 covers the JSON path with a mixed good/garbage-date feed;
the RSS path was verified safe in rss-parser's source (its date parse is
try/catch-wrapped, yielding `isoDate === undefined`, which degrades to
"now"). The fallback guid hashes the raw date string, so F2's degrade
doesn't reintroduce F1's nondeterminism.

Boundary rules: all clean — no `web/` → `core/` imports; `CORE_API_TOKEN`
only in server-side modules via `$env/dynamic/private`, no `PUBLIC_` vars at
all; wire type carries `title`; forms are plain POSTs with 303 redirects;
the SSE proxy (#19, now complete) streams without buffering and aborts the
upstream fetch on client disconnect (verified in @sveltejs/kit's node
adapter source).

### W1 — `npm run check -w web` is red (blocks task 13's "all green" step)

Five svelte-check errors: `$lib/api.ts` / `$lib/types.ts` imports use a
`.ts` extension through the `$lib` alias (`+page.server.ts:3`,
`+page.svelte:3`) — the core workspace's `allowImportingTsExtensions` isn't
inherited by web's SvelteKit-generated tsconfig, and alias paths error
regardless. Drop the `.ts` extension on `$lib` imports (SvelteKit's own
convention). Plus `page.load.test.ts:34-36`: `result.timeline` accessed on a
union including `void` — type the mocked load call or narrow the assertion.
Vitest passes because it never typechecks; the green tests are masking this.

### W2 — every form failure is invisible to the user

Actions correctly return `fail(400, { error })`, but `+page.svelte` never
renders the `form` prop. Submit compose with handle `Alice!` → core rejects
400 → page re-renders with no post and no message, fields cleared. A wrong
`CORE_API_TOKEN` (401) is indistinguishable from success. Affects no-JS and
JS paths alike. Two-line fix: accept `form` in the page props and render
`{#if form?.error}` near the forms.

### W3 — core down = whole page 500s

`load` lets `getTimeline`'s throw escape, so an unreachable core yields
SvelteKit's stack-trace error page instead of "core unreachable". Defensible
for the spine; worth a try/catch returning `{ timeline: [], coreDown: true }`
if the "web is just a client" story is meant to be visible.

### Round-2 minors

- SSE proxy stamps `text/event-stream` even when forwarding a core error
  status — mislabeled but harmless (EventSource just retries).
- Action catch blocks map core 500s to `fail(400, ...)` — an outage
  mid-submit reads as a client error. Cosmetic until W2 is fixed.
- `adapter-auto` is fine for dev; the Docker/self-host deploy needs
  `adapter-node` for the SSE proxy's streaming + abort to hold in prod —
  belongs in task 13's RUNNING.md.
- `web/src/lib/index.ts` is scaffold cruft; delete.
- The `displayName || handle` default in actions closes round 1's
  empty-displayName gap for web users (direct API callers can still send
  `""`).

---

## Round 1 — hardening/schema batch (171041f..f7b02d9)

Date: 2026-07-15
Scope: independent code review of Task A + Task B (suggestion doc items
#1–#5, #7–#11, #13, #16–#18, SSE id, poller loop), verified against the
actual code, with the suite re-run.

Checks: `npm test -w core` → 37/37 passed. `npm run typecheck -w core` → clean.

Verification: 13 of 15 claimed items are correctly implemented (#1, #3, #4,
#5, #7, #8, #9, #11, #13, #16, #17, #18, SSE id, poller loop). Two are
partial — they are findings F1 and F2 below.

## F1 — #2 is only partially fixed: guid fallback still non-deterministic for undated items

`core/src/domain/ingest.ts` — `fallbackGuid(title, content, publishedAt)`
hashes `publishedAt`, but for an item with no guid, no link, **and no
pubDate**, `publishedAt` falls back to `now` — a different hash every poll.
Verified by probe: two `parseFeed` runs on
`<item><title>X</title><description>Y</description></item>` produce different
guids. Consequence: such items re-insert every poll, and since the author
then has posts (backfill=false), each re-insert **emits on the bus** — the
exact live-timeline spam #2 was meant to kill. The shipped test includes a
pubDate, so it passes while missing this.

**Fix:** exclude the date from the hash input when the item carried none
(hash `title + content` plus a constant, not the `now` fallback).

## F2 — one invalid date kills an entire feed, forever

`core/src/domain/ingest.ts` — `new Date(it.date_published).toISOString()`
throws `RangeError: Invalid time value` on garbage input. A 2-item JSON Feed
where one item has `date_published: "not-a-date"` makes `parseFeed` throw:
zero items ingest, `pollAll` swallows the error every cycle, and the feed
silently never ingests anything. Same pattern on the RSS path (`it.isoDate`).
Pre-existing shape, but this range rewrote these lines.

**Fix:** wrap the date parse per-item (`Number.isNaN(d.getTime())` → treat as
missing), so one bad item degrades to "dated now", not "feed dead".

## F3 — stale dev DB now actively breaks (known #15 deferral, escalated)

The schema gained `title` and swapped guid uniqueness to
`UNIQUE(author_id, guid)`, but bootstrap is `ifNotExists`. Any existing
`data/textcaster.db` (e.g. from the task-8 smoke run) keeps the old shape and
every `insertPost` fails (`no such column: title`) — 500s on POST /posts,
silent per-user poll failures. Until #15 lands: delete the dev DB on
upgrade, and say so in RUNNING.md (task 13).

## F4 — #10's byte cap rejects but doesn't bound memory

`core/src/domain/ingest.ts` — the cap checks the `content-length` header,
then `await res.text()` buffers the **whole body** before the exact-size
check. A chunked response with no content-length is fully buffered first; a
hostile server can push hundreds of MB inside the 10s timeout window.
Rejection works; memory-bounding doesn't. **Fix (when it matters):** read the
body stream incrementally and abort past the cap. Acceptable to defer —
note it as a known ceiling.

## Minor observations (no action forced)

- **Web tasks must use the SSE-proxy variant.** CORS is fully removed from
  core, which commits to #19 before `web/` exists. Plan tasks 9/12 as
  originally written (`PUBLIC_CORE_SSE_URL`, direct browser `EventSource`)
  are now dead on arrival cross-origin. The ledger already notes the
  adjusted briefs — this is a hard dependency, not a suggestion.
- The contract suite now requires `insertPost` with an unknown `authorId` to
  reject — FK semantics are part of the adapter contract, so a future Mongo
  adapter must emulate this in application code.
- `displayName: ""` passes validation (`isString(v, 0, 200)`) and is stored
  as-is; the `?? handle` default only catches absence. Consider `|| handle`
  after trim if empty display names are unwanted.
- `loadConfig` accepts `TEXTCASTER_PORT=abc` → `NaN` → obscure crash in
  `serve`. Two-line guard.
- First poll fires a full interval after boot, and POST /users doesn't
  trigger an immediate ingest — a freshly added feed can take up to
  `pollSeconds` to show anything. Plan-accepted; an immediate
  `ingestRemoteUser` on add would improve the demo moment of task 13.

## Suggested handling

F1 and F2 are small, test-first fixes in `ingest.ts` — fold them in before
the web tasks. F3 is a one-line note in RUNNING.md plus "delete your dev DB
today". F4 is a `ponytail:`-style known ceiling; defer. Minors are optional
polish, except the SSE-proxy dependency, which is already in the adjusted
briefs.
