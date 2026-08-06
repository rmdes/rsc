# Instance-Member Reap Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop instance-governed member sources being reaped as orphans (guard reap by membership, not by the churnable `verified_origin` claim), and recover members already lost on existing instances via a one-time boot heal.

**Architecture:** Four localized changes across two parallel encodings of "what retains a source" (the `reapSource` guard chain and the `retentionFor` classifier) plus the admin web surface, plus a version-gated recovery heal. Spec: `docs/superpowers/specs/2026-08-06-instance-member-reap-fix-design.md` (rev 2).

**Tech Stack:** Node 22 native type-stripping (no build step), better-sqlite3, Hono, SvelteKit. Tests: Vitest (core `core/test/`, web in-container), svelte-check.

## Global Constraints

- **Native type-stripping ⇒ `tsc` is mandatory** (`npm run typecheck -w core`); vitest passes on type errors, so tsc gates every core task. Web: `svelte-check`.
- **No new dependencies.**
- **The guard and `retentionFor` are two hand-duplicated encodings of the same truth** — both must gain the `instance_member` rung or enforcement and UI disagree.
- **Guard placement:** the new `instance_member` guard is gated on `!opts.force` and inserted **after** the existing unconditional `federated` guard (`source-repository.ts:257`), so a self-governing approved-federated row is refused by `federated` first (preserves `MEMBER_RANGE_SQL` F14).
- **`retentionFor` rung order:** `instance_member` is checked **first** (it is the protection once the claim has churned away).
- **Heal:** version-gated (one-time), idempotent, wrapped in its own transaction; excludes `blocked_source_tombstones_v2` batch keys; **chunk `IN (...)` param lists** (≤ ~500, mirroring `collapseVersionHistory`) — the DB can have many stranded batch keys and SQLite caps bound params.
- **Shared checkout:** stage explicit paths, **never `git add -A`**; end commit messages with `developed with the help of AI tools`.
- **Behavior-preserving except the fix:** ordinary (non-member) orphan sources are still reaped exactly as before.

## File Structure

- `core/src/domain/source-repository.ts` — `reapSource` guard + `SELECT` widen + `ReapResult` `'instance_member'` reason (Task 1).
- `core/src/storage/sqlite.ts` — `retentionFor` rung (Task 2); recovery heal + `migrate()` gate + `MIGRATIONS` marker (Task 4).
- `core/src/logical/membership.ts` — reuse `approvedInstanceFor` (import; no change).
- `web/src/routes/admin/feeds/+page.server.ts` — `retention` union widen (Task 3).
- `web/src/routes/admin/feeds/+page.svelte` — `RETENTION_LABEL` / `FORCE_REAP_CONSEQUENCE` / `REAP_REFUSAL_LABEL` + comment fix (Task 3).
- Tests: `core/test/instance-member-reap.test.ts` (new, Tasks 1–2–4), web feeds test (Task 3).

---

## Task 1: Reap guard by membership + `instance_member` reason

**Files:**
- Modify: `core/src/domain/source-repository.ts` (`ReapResult` L238; `reapSource` L252-271)
- Test: `core/test/instance-member-reap.test.ts` (new)

**Interfaces produced:** `ReapResult` refused-reason union gains `'instance_member'`. The reap route (`app.ts:480`) already returns `result.reason` verbatim in the 409 body — no route change.

- [ ] **Step 1: Write failing tests.** In `core/test/instance-member-reap.test.ts`, set up an approved federated aggregate instance + a minted `origin_verification` member (a `remote_sources_v2` row whose `canonical_url` is under the instance prefix, provenance `'origin_verification'`, governance `'allowed'`, no subscriptions, no `federation_relationships_v2` row) with **no** `verified_origin` claim. Assert:
  - `reapSource(tx, memberId, { force: false })` → `{ kind: 'refused', reason: 'instance_member' }`.
  - `reapSource(tx, memberId, { force: true })` → `{ kind: 'reaped' }`.
  - After deleting the instance's `federation_relationships_v2` row (revoke), `reapSource(tx, memberId, { force: false })` → `{ kind: 'reaped' }`.
  - An ordinary orphan (allowed, no subs/federation, provenance `'opml'`, no claim) → still `{ kind: 'reaped' }`.
  - A row that is itself approved-federated (`federation_relationships_v2` present) → refused `'federated'` (not `'instance_member'`) — pins ordering.

- [ ] **Step 2: Run, verify red.** `npm test -w core -- instance-member-reap` → fails (`instance_member` not a value; guard absent).

- [ ] **Step 3: Implement.**
  - Add `'instance_member'` to the `ReapResult` refused union (L238).
  - Import `approvedInstanceFor` from `../logical/membership.ts`. **Watch-point:** if this creates a domain→logical import cycle that breaks module init, inline the predicate instead as an `EXISTS` query mirroring `approvedInstanceFor`'s JOIN (`remote_sources_v2` × `federation_relationships_v2 status='approved'` over the URL prefix). `tsc` + tests decide.
  - Widen `reapSource`'s source `SELECT` to also read `canonical_url, provenance`.
  - Insert, immediately **after** the `federated` guard (L257) and before the `admin_retained` guard:
    ```ts
    if (!opts.force && source.provenance === 'origin_verification'
        && approvedInstanceFor(tx, source.canonical_url) !== null) {
      return { kind: 'refused', reason: 'instance_member' }
    }
    ```

- [ ] **Step 4: Run, verify green + tsc.** `npm test -w core -- instance-member-reap` (pass) and `npm run typecheck -w core` (0).

- [ ] **Step 5: Commit.** `git add core/src/domain/source-repository.ts core/test/instance-member-reap.test.ts` then commit (`refactor→` use `fix(core): guard instance-governed members from orphan reap` + the AI-tools trailer).

## Task 2: `retentionFor` gains the `instance_member` rung

**Files:**
- Modify: `core/src/storage/sqlite.ts` (`retentionFor` L653-660)
- Test: `core/test/instance-member-reap.test.ts` (extend)

**Interfaces produced:** `retentionFor` return type becomes `'instance_member' | 'verified_origin' | 'audit_history' | 'admin_retained' | 'reapable'`. Task 3's web union mirrors this.

- [ ] **Step 1: Failing test.** Extend the test: a member (as in Task 1, no `verified_origin` claim) → `retentionFor(memberId)` returns `'instance_member'`. (If `retentionFor` is `private`, exercise it through the public read that calls it — `getSourceDetail`/`listSourceMembers` — asserting the surfaced `retention` field.)

- [ ] **Step 2: Run red.** Fails (returns `'reapable'`).

- [ ] **Step 3: Implement.** Add, as the **first** check in `retentionFor` (before the `verified_origin` line):
  ```ts
  const s = this.raw.prepare(`SELECT canonical_url, provenance FROM remote_sources_v2 WHERE id = ?`).get(sourceId) as { canonical_url: string; provenance: string } | undefined
  if (s?.provenance === 'origin_verification' && approvedInstanceFor(this.raw, s.canonical_url) !== null) return 'instance_member'
  ```
  Widen the method's return-type annotation. Import `approvedInstanceFor` if not already in `sqlite.ts` (it imports from `membership.ts` already — `healMembers` etc.).

- [ ] **Step 4: Green + tsc.** `npm test -w core -- instance-member-reap`; `npm run typecheck -w core`.

- [ ] **Step 5: Commit.** `git add core/src/storage/sqlite.ts core/test/instance-member-reap.test.ts` + commit.

## Task 3: Admin web surface knows `instance_member`

**Files:**
- Modify: `web/src/routes/admin/feeds/+page.server.ts` (`retention` union L56)
- Modify: `web/src/routes/admin/feeds/+page.svelte` (`REAP_REFUSAL_LABEL` ~L98, `RETENTION_LABEL` L107, `FORCE_REAP_CONSEQUENCE` L126, the "three reasons" comment L114-123)
- Test: the existing admin-feeds web test (`web/src/routes/admin/feeds/feeds.render.test.ts` or `source-actions.test.ts`)

- [ ] **Step 1: Failing test.** In the web feeds test, render an orphan-list row whose `retention` is `'instance_member'`; assert it shows the instance-member label and offers the force ("Reap anyway") flow, not a plain "Reap". (Follow the existing test's pattern for the other `retention` values.)

- [ ] **Step 2: Run red** (in-container: `env -u CORE_API_URL npm test -w web -- feeds`).

- [ ] **Step 3: Implement.**
  - `+page.server.ts:56`: add `'instance_member'` to the `retention` union.
  - `+page.svelte`: `RETENTION_LABEL['instance_member'] = 'Instance member — retained'`; `FORCE_REAP_CONSEQUENCE['instance_member'] = '<consequence copy: force-reaping removes a governed member of an approved instance>'`; `REAP_REFUSAL_LABEL['instance_member'] = 'This source is a governed member of an approved federated instance.'`; update the L114-123 comment from "three reasons" to four, listing `instance_member`.

- [ ] **Step 4: Green + svelte-check.** web test passes; `npm run check -w web` (svelte-check 0).

- [ ] **Step 5: Commit.** `git add web/src/routes/admin/feeds/+page.server.ts web/src/routes/admin/feeds/+page.svelte <web test file>` + commit.

## Task 4: Recovery heal + migration gate

**Files:**
- Modify: `core/src/storage/sqlite.ts` (new `healStrandedMembers` function; new `MIGRATIONS` marker entry; `migrate()` gate)
- Test: `core/test/instance-member-reap.test.ts` (extend) + a real-DB-copy sanity check at review time

**Interfaces produced:** `export function healStrandedMembers(sqlite): void`, invoked once from `migrate()` gated by a new `user_version` marker (next after 22 → **23**).

- [ ] **Step 1: Failing test.** Seed the exact stranded signature: a `verification_checks_v2` row `state='verified'`, `batch_key = <a per-user feed url>` with **no** `remote_sources_v2` row for that url, and a `reconciliation_jobs_v2` `kind='verification'` row for that `batch_key` `status='reconciled'`. Assert after `healStrandedMembers(db)`: the check is `state='pending'` (`resolved_at` NULL) and the job is `status='pending', attempts=0, failure_category NULL`. Second assertion: a `verified` check whose `batch_key` DOES have a `remote_sources_v2` row, OR is present in `blocked_source_tombstones_v2`, is **left untouched**. Third: idempotent — a second `healStrandedMembers(db)` changes nothing.

- [ ] **Step 2: Run red.** Fails (function absent).

- [ ] **Step 3: Implement `healStrandedMembers`** (mirror `collapseVersionHistory`'s transaction + chunking):
  ```ts
  export function healStrandedMembers(sqlite: InstanceType<typeof Database>): void {
    const bks = (sqlite.prepare(`
      SELECT DISTINCT vc.batch_key AS bk FROM verification_checks_v2 vc
      WHERE vc.state = 'verified'
        AND NOT EXISTS (SELECT 1 FROM remote_sources_v2 s WHERE s.canonical_url = vc.batch_key)
        AND NOT EXISTS (SELECT 1 FROM blocked_source_tombstones_v2 t WHERE t.canonical_url = vc.batch_key)
    `).all() as { bk: string }[]).map((r) => r.bk)
    if (bks.length === 0) return
    const now = new Date().toISOString()
    const CHUNK = 500
    const run = sqlite.transaction(() => {
      for (let i = 0; i < bks.length; i += CHUNK) {
        const c = bks.slice(i, i + CHUNK); const ph = c.map(() => '?').join(',')
        sqlite.prepare(`UPDATE verification_checks_v2 SET state='pending', resolved_at=NULL WHERE state='verified' AND batch_key IN (${ph})`).run(...c)
        sqlite.prepare(`UPDATE reconciliation_jobs_v2 SET status='pending', attempts=0, next_attempt_at=?, failure_category=NULL, diagnostic=NULL WHERE kind='verification' AND verification_batch_key IN (${ph})`).run(now, ...c)
      }
    })
    run()
  }
  ```
  Add a `MIGRATIONS` marker entry advancing `user_version` to 23 (a comment-only/no-op marker, same shape as the collapseVersionHistory marker at L1491-1496 — the real work is the heal), and in `migrate()` after the `if (version < 22) collapseVersionHistory(sqlite)` line, add `if (version < 23) healStrandedMembers(sqlite)`.

- [ ] **Step 4: Green + tsc.** `npm test -w core -- instance-member-reap`; `npm run typecheck -w core`.

- [ ] **Step 5: Commit.** `git add core/src/storage/sqlite.ts core/test/instance-member-reap.test.ts` + commit.

## Task 5: Whole-fix acceptance

- [ ] **Step 1:** Full gates: `npm run typecheck -w core` (0), `npm test -w core` (all green), `npm run check -w web` (0), web tests green.
- [ ] **Step 2:** Confirm the two encodings agree: a member with no `verified_origin` claim is BOTH refused by `reapSource` (`instance_member`) AND labeled `instance_member` by `retentionFor` — a single test asserting both, so future drift is caught.
- [ ] **Step 3 (deploy note, no code):** the heal runs once at boot on each instance and re-pends verification jobs; members re-mint over the next drain cycles. Backup-before-flip per RUNNING.md; the heal only resets state (no destructive writes), so a killed heal simply re-runs next boot (idempotent).

## Self-Review (author checklist — completed)

- **Spec coverage:** Part 1 guard (Task 1) ✓; Part 3 `retentionFor`+web (Tasks 2, 3) ✓; Part 2 heal+gate (Task 4) ✓; guard-ordering/F14 (Task 1 Step 1 test) ✓; tombstone exclusion (Task 4) ✓; revoke-vs-quarantine (Task 1 tests) ✓; drift-guard (Task 5 Step 2) ✓.
- **Placeholder scan:** exact files/lines, real SQL + TS, exact commands. The one FORCE_REAP_CONSEQUENCE copy string is intentionally author-chosen at implementation (marked).
- **Type consistency:** `'instance_member'` added to `ReapResult` (Task 1), `retentionFor` return (Task 2), and the web `retention` union (Task 3) — all three the same literal; `healStrandedMembers` signature matches the `migrate()` call.
