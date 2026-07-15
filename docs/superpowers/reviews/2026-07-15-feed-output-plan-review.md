# Plan review — feed output + push (pre-execution)

Date: 2026-07-15
Target: `docs/superpowers/plans/2026-07-15-textcaster-feed-output.md` (at `1ac1bc8`)
Basis: revised spec (stale-prose fixes confirmed landed), spec review H1–H8,
current code, and live probes of the installed packages (feedsmith 2.9.6,
kysely 0.29, @types/node 24, hono).

**Verdict: executable after one mechanical plan fix (P1). Coverage is
complete with zero spec drift and zero code-vs-reality mismatches — a first
for this project's plans; the probe-before-embedding discipline shows.**

## P1 (medium, must fix) — the `racy` Repository stub breaks Tasks 2 and 3's own gates

`core/test/service.test.ts:51` builds a structurally-typed
`const racy: Repository = { …10 methods… }`. Task 2 grows the interface by
five subscription methods and Task 3 by `getPostsByAuthor`; the stub literal
then fails `npm run typecheck -w core` ("missing the following properties")
at both tasks' verify-GREEN step. Vitest stays green (it doesn't typecheck),
so the failure lands exactly on the gate the plan promises passes — and the
plan's self-review missed it.

**Fix:** in Task 2, convert the stub to spread-and-override
(`{ ...repo, getUserByHandle: … }`) so future interface growth stops
breaking it (nothing further needed in Task 3), or add delegating members in
both tasks.

## Recommended, non-blocking

- **Task 6 Step 3's illustrative block is mis-ordered:** the "this was
  illustrative" note comes AFTER the code, under a normal instruction line —
  a literal executor pastes it first. Recovery is forced (undefined
  `ctxPlaceholder` breaks typecheck immediately), but delete the block or
  move the disclaimer above it.
- Task 6's `/hub` API test name claims "forwards to the handler when wired"
  but only asserts the unwired 404 — rename or add one wired assertion.
- The failed-verification negative case awaits a fixed 20ms `setTimeout`
  before asserting non-storage; near-deterministic with stubbed fetch, but a
  `vi.waitFor`-style settle is sturdier (the positive cases already use it).

## Verified sound (don't re-check during execution)

- **Frozen v1 schema is verbatim identical to `MIGRATIONS[0]`** — the
  upgrade test tests what it claims.
- **Feedsmith probe with the plan's exact mapper input:** all raw-string
  markers render (isPermaLink, rel=self/hub, `<cloud `, unconditional
  description, http-post); empty `registerProcedure` omitted as expected; no
  synthesized empty `<title>`; the JSON version marker survives the plan's
  `JSON.stringify` form. Round-trip through the real `parseFeed` preserves
  guid/null-title/content/url/date for both formats.
- kysely `oc.columns([...]).doUpdateSet({...})`, dns single-arg
  `lookup(hostname)`, Hono `c.body/redirect/parseBody`, variable-status
  `c.json` — all real APIs in the installed versions.
- `resolveLocalTopic` (regex prefilter + re-mint equality) implements H3
  exactly; variants and foreign hosts cannot pass.
- XFF-only requester IP is spoofable on a directly-exposed core but harmless
  by construction (every registration passes the SSRF guard and must echo
  the challenge from the claimed host); RUNNING.md documents the
  reverse-proxy assumption.
- All network/DNS touchpoints injectable; no test hits real network; REDs
  are accurate throughout (no typecheck-masked failures); Task 9's smoke is
  runnable as written, and its note that a full local subscribe is
  impossible (loopback rejected) is the SSRF guard working as designed.
- Every code anchor matches the current tree (config fields, `Context`
  import, single-arg `parseFeed`, `rowToPost`, contract-file style, the
  federation bridge vs `ingestRemoteUser`'s fetch usage).

## Coverage

All spec items map to tasks — config rules (1), migration 2 + DO-UPDATE +
five repo methods + v1→v2 test (2), `getPostsByAuthor` (3), routes +
profile + discovery links + H5 raw strings + 302/404 (4), SSRF guard +
external pings + H4 seam (5), self hub + H3/H7 + HMAC + caps + one-retry
(6), rssCloud always-challenge + 25h + thin ping (7), money test +
RUNNING.md at the correct path (8), whole-milestone gates + smoke (9). No
non-goal leaked in; web untouched and gated.
