# Public firehose (phase 1) — plan review (2026-08-01)

Target: `docs/superpowers/plans/2026-08-01-public-firehose.md`
(`4dcbdab`, 643 lines, 2 tasks) off spec rev 2 (`d0f01d3`). Dual pass:
security/contract (HIGH-1, HIGH-2 + meds/lows) + ponytail (PT1–PT8),
adjudicated.

**Verdict: NOT READY.** The design is sound and the plan gets the hard
parts right — anonymous viewer correctly pinned, no perimeter breach, the
sanitizer boundary intact, no viewer-scoped leak. But as written it puts an
**unbounded anonymous amplification endpoint on four live instances**, and
its one guardrail does not function. Both reviewers independently found the
guardrail defect; the security lens found the amplification.

## Blockers

1. **HIGH-1 — the per-IP cap is inert, and degrades into a global cap.**
   Core keys on `x-forwarded-for` (plan:293); the web proxy builds a header
   object containing only `Last-Event-ID` and never destructures
   `getClientAddress` (plan:557-566). Every production connection therefore
   keys to `'unknown'`, so `maxPerIp = 5` becomes **one global bucket** —
   five streams anywhere 429s the entire internet off the firehose, while
   any single client can still open unlimited connections from multiple
   addresses. The repo's own convention is otherwise
   (`api/auth/[...path]/+server.ts:27`, `lib/server/session.ts:62`), and
   `getClientAddress()` is trustworthy in both prod paths
   (`compose.prod.yaml:36-37`, `cloudron/start.sh:53-54`). The plan's core
   test hides the defect by setting the header directly on `app.request`
   (plan:221) — a path production cannot reach.
   **Fix:** forward the address in the proxy, and add a core test for the
   no-XFF case. (Or move the counter to the web proxy, which is the real
   public edge and already holds an authoritative address — that deletes
   the core-side counter entirely.)

2. **HIGH-2 — anonymous full-history replay, on demand, with no yield.**
   Journal cursors are unauthenticated, forgeable base64url JSON
   (`journal.ts:68-82`); `isServeableCursor` accepts anything in
   `[0, highWaterSeq]`, so **`sequence = 0` is serveable**
   (`journal.ts:92-94`); the journal is **never pruned**
   (`journal.ts:7-8`); and the caller need not even guess the reset
   generation — the route emits it in every `id:` line (plan:333). The pump
   is a `for(;;)` over 200-row batches doing a synchronous `db.read` plus
   per-row `projectItem` with **no breather between batches**
   (plan:323-343). That is the event-loop starvation class already fixed
   once in `f612128` — except now reachable anonymously, repeatedly, by
   anyone.
   **Fix (minimum):** a global connection cap alongside the per-IP one,
   AND a `setImmediate` breather between pump batches (the `Breather` type
   already exists in `scheduler.ts`), and/or a recency floor on cursors
   accepted from anonymous callers.

3. **MED — the feature is degraded on every instance you actually run.**
   The existing stream needed an explicit nginx SSE block
   (`cloudron/nginx.conf:41-49`: `proxy_buffering off`, `proxy_cache off`,
   `Connection ""`, `X-Accel-Buffering no`, `proxy_read_timeout 24h`).
   `/api/v1/firehose/stream` gets none of it — it inherits `location /`
   with buffering **on**. Caddy streams by default, so this works on
   docker-compose prod and is buffered on all four Cloudron instances. The
   plan modifies neither file and never mentions them. **Add the nginx
   location.**

4. **MED — the tests assert the happy path, not the exclusions.** No
   XSS-negative case (plan:190 asserts markdown rendered, not that
   `<script>`/`onerror=` was stripped) on a NEW public egress across the
   load-bearing sanitizer gate; nothing pins the field allowlist, so a
   future spread silently widens a frozen `v1` contract; no
   deleted-local-post replay test.

## Shape (accepted — the plan shrinks by more than half)

- **PT1 — stop hand-copying the stream.** ~75 lines of
  `mountLogicalStreamRoute` (`logical-routes.ts:539-607`) are duplicated
  verbatim: hint listener, `Last-Event-ID ?? ?last=` resolution, catch-up
  drain, `heartbeatDue`/`': hb\n\n'`, abort cleanup — even `STREAM_BATCH`'s
  200, re-declared as `FIREHOSE_BATCH`. Exactly three things differ: path,
  viewer, per-frame mapping. Add `path?` and `mapFrame?` to
  `LogicalStreamDeps` (~10 shared lines) and `mountPublicFirehoseRoute`
  becomes ~10 lines. This repo has been bitten by hand-duplicated twins
  three times (markdown/render, `deriveRoot` ×3, the two eviction cascades
  merged in `94bfb7d`).
  **Synthesis worth noting:** doing PT1 also gives HIGH-2's breather a
  single home — fix the pump once and BOTH the authenticated and public
  streams get it.
- **PT3** — Step 1 exports a module-private RSS helper to use one field;
  local-only frames reduce to `renderLocalHtml(content)`, already exported.
  Delete the step, the export, and the `feed.ts` edit.
- **PT4** — Step 5's `server.ts` refactor exists to pass `FeedContext` to a
  route that reads one field. Take `publicUrl` directly. (`server.ts` is a
  shared-checkout file; gratuitous edits there are their own hazard.)
- **PT5** — the web proxy duplicates the first 25 lines of
  `routes/stream/+server.ts`, and 4 of its 5 tests already exist against
  that code. Extract one `openCoreSse(request, path, clientAddress)` helper
  — which is also the single place HIGH-1's `x-forwarded-for` should live.
- **PT6** — the new core test file re-copies a harness sitting 20 lines
  away in `core/test/logical-sse.test.ts`. Put the firehose tests there.
- **PT7** — drop the unused `maxConnectionsPerIp` knob (module constant
  until an operator asks), the `kind` field duplicating the SSE `event:`
  line, and the unreachable remote branch of the author ternary.

## Verified clean (do not re-litigate)

Perimeter invariant respected — no new public **core** path in either
`Caddyfile:23-31` or `cloudron/nginx.conf:30-38`; the route is reachable
only through web. Anonymous viewer correctly pinned (`FIREHOSE_ANON` is
byte-identical to `projectLocalActivity`'s anon) with no session lookup at
all, so it cannot become viewer-scoped. No `personal`-lens leak: the only
viewer-scoped field is `classification.personal` and `firehoseEntry` is an
allowlist that omits it along with provenance, retention, evidence levels
and claim internals. Hidden/tombstoned/quarantined exclusion holds
structurally — replay re-projects under CURRENT policy and downgrades
non-visible rows to `removeFrame`. Sanitizer boundary intact: local-only
frames take the `renderLocalHtml` → `sanitizeHtml` path, no second
pipeline, twin untouched. `streamSSE` teardown sound (double-guarded
release). The web proxy leaks nothing upstream — fresh header object, no
cookies. House style matches the hono skill; no new dependencies; api-key
machinery correctly deferred to a later phase.

## Handoff

Fold as plan rev 2: HIGH-1 and HIGH-2 are non-negotiable before this ships
(it is a public endpoint on live instances), the nginx block and the two
missing test classes ride along, and PT1/PT3–PT7 land the same feature at
roughly a third of the code. Execution after the fold; this session
reviews per task, with the shared-pump change getting the deepest look
since it will then serve both streams.
