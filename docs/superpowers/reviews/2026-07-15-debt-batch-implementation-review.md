# Implementation review — debt batch + unplanned changes (e95a50d..14d6280)

Date: 2026-07-15
Scope: the executed debt-batch plan (rev 2) plus three unplanned changes —
rss-parser→feedsmith swap (7d45500), major dep upgrades (94bf81a: kysely
0.29, better-sqlite3 12, vitest 4, TS 6, tsx dropped), Node-requirement note
(14d6280). All gates re-run; migrations and the full replay loop exercised
live for the first time.

**Verdict: the debt batch is complete and correct against spec rev 3. Every
review gate (H1–H10, R1/R2, M1/M2, D1–D4) is honored in the shipped code.
One bug found in the whole range: E1, a one-line engines fix.**

## Gates

core 65/65, core typecheck clean, web 19/19, svelte-check 0 errors,
`npm ls --workspaces` clean. Node v24.18.0 locally.

## E1 — root `engines` says `>=20`; core now requires Node ≥22.18 (medium)

tsx is gone; `node src/server.ts` relies on native type stripping (no build
artifact exists), which needs Node 22.18+. Commit 14d6280 fixed only
RUNNING.md. A Node 20 user gets a raw loader/syntax error with no engines
warning. Fix: `"engines": { "node": ">=22.18" }` in root `package.json:6`
(and core's, if present).

## Verified live (first exercise of the new machinery)

- Migrations: fresh boot stamps `user_version = 1`; reboot no-op; a
  hand-built old spine-schema DB triggers "pre-migration database — delete
  it"; `user_version = 99` triggers "newer than this build".
- Cursor walk: `limit=2` pages correctly to a `null` nextCursor;
  `before=garbage` → 400.
- SSE replay: reconnect with a captured `Last-Event-ID` delivered the anchor
  (inclusive re-delivery per R1) plus both missed posts, oldest-first.
- Thesis check ran with an **Atom** fixture: guids taken from `<id>`
  (`urn:item-1`), not links — the rss-parser bug class is structurally gone
  under feedsmith.

## Feedsmith swap: sound

Atom `entry.id` used directly; RSS `guid.value` shape confirmed by probe;
JSON Feed now feedsmith-native (hand-rolled branch deleted; snake_case
fields are feedsmith's real names); garbage dates pass through as raw
strings so `toIsoOrNow` + `fallbackGuid('\0')` determinism (F1/F2) is
preserved; one bad feed still can't kill `pollAll` and one bad item can't
kill a feed. Test diff read critically: no assertions weakened (the fixture
that gained a title was an empty-items feed needing a detection signal).
One noted shift: RSS content precedence is now `description ??
content:encoded` — effectively unchanged for real feeds.

## Dep upgrades: clean

kysely 0.29 keeps `eb.tuple`/`eb.refTuple` (verified in installed .d.ts);
better-sqlite3 12 keeps `.code`, `pragma()`, sync `transaction()`; vitest 4
ran all files (65+19 ≥ pre-upgrade counts); the `SqliteRepository`
constructor was correctly rewritten to plain assignment (native type
stripping can't erase parameter properties), with a comment.

## Open ledger after this range

**Closed:** #12, #14, #15, #20 (full loop incl. proxy), config NaN guard,
empty-displayName gap, generic web error strings, proxy content-type,
fallbackGuid separator, JSON sniff (superseded by feedsmith).

**Still open, all accepted/known:** F4 memory-unbounded feed buffering
(`ponytail:` ceiling comment at `ingest.ts:61` is the documented
mitigation); R2 cosmetic replay/live interleave; H3 backfill-on-replay
(revisit if it bites). **New:** E1 engines bump (above).

Misc: the Stop hook is sane (idempotent, safe outside git repos, needs
`jq` — present); env-stub spreads `process.env` after the test token, so an
ambient `CORE_API_TOKEN` would win — harmless today, worth flipping if a
test ever asserts the exact token; zero rss-parser references remain.
