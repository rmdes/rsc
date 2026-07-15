# Plan review — debt batch (pre-execution)

Date: 2026-07-15
Target: `docs/superpowers/plans/2026-07-15-textcaster-debt-batch.md` (at `e95a50d`)
Basis: spec rev 3 (`eb3ec59`), spec review H1–H10/R1–R2, and the actual code —
every line reference the plan makes was checked against the current files.

**Verdict: executable after one mechanical fix (M1) and one decision (D1).**
Spec rev 3 is covered faithfully and completely: the R1 inclusive replay scan
survived translation (with an explicit "do not optimize it back" constraint),
the H1/R1 disconnect scenarios are real regression tests, the H8
keep-this-guard warning is un-missable, all nine §5 minors are mapped, and no
non-goal leaked in. No internal inconsistencies: types/signatures line up
across tasks, and the existing suite survives every task (including `:memory:`
correctly classifying as fresh under the migration path).

## Must fix before execution

### M1 — stale RUNNING.md path (three-line plan edit)

The plan's file-structure block, Task 1 Files/Step 5, and Task 1's `git add`
say `docs/RUNNING.md`. The file lives at
`docs/superpowers/documentation/RUNNING.md` since `752c9f5`, and CLAUDE.md
forbids new markdown directly under `docs/`. Executed literally, Task 1
either errors or recreates the file at the dead path. (The `## Stale DB
warning` heading it edits does exist in the real file.)

### D1 — Task 8 commits on red gates by design (decide)

After Task 8, `page.load.test.ts` fails and svelte-check flags
`+page.server.ts`; the plan says so honestly and treats it as Task 9's RED —
but then commits with a failing web suite, which the batch's own per-task
discipline (and any task reviewer) will trip over. Cheapest: merge Tasks 8+9
into one task/commit. Alternative: update the load test within Task 8.

## Polish (one line each, optional)

- **M2:** migration 1 recreates `posts_author_guid_uq` as an unnamed inline
  `UNIQUE(author_id, guid)`; `sqlite.ts:42-43`'s comment names the
  constraint. Name it in the migration SQL or touch the comment.
- **D2:** two RED expectations imprecise — Task 2's failures are runtime
  `TypeError: ... is not a function` (vitest doesn't typecheck), and Task 6's
  BOM test is a genuine RED (no hedge needed: `trimStart()` strips the BOM
  for the sniff but `JSON.parse` still rejects the un-stripped body).
- **D3:** two spec-listed web assertions ("Older posts" link only with
  nextCursor; island only on page 1) are wired but untested — no
  component-render infra in web/ and the plan forbids new deps. Add a manual
  browse step to Task 9 or a web-page check to Task 10's smoke (currently
  core-only via curl).
- **D4:** Task 6's `parseFeed` shadows `text` (outer BOM-stripped body vs
  inner item-content const). Rename the outer one.

## Verified sound (don't re-check during execution)

- kysely 0.27.6 `eb.tuple`/`eb.refTuple` usage matches the installed .d.ts.
- Migration runner mechanics (better-sqlite3 sync `transaction()`,
  `pragma('user_version = N')` inside it, FK pragma ordering) are valid.
- Task 5's SSE tests are deterministic where they assert order and robust
  where order is indeterminate; the 102/101/skip cap arithmetic matches the
  spec's anchor-inclusive count.
- Cursor URL-encoding literals, Hono header case-insensitivity, `parseCursor`
  garbage cases → 400, Task 4's tie-robust pagination assertion: all check
  out.
- Existing duplicate-handle service/API tests survive the guard surgery
  (`HandleTakenError extends DomainError`, same message); the stream-proxy
  test tolerates the added `headers` key.
- Plan line references are current as of `e95a50d` — execute the plan before
  unrelated core/web edits drift them.
