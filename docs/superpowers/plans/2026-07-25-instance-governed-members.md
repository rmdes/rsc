# Instance-Governed Members Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Federating an instance governs its verification-minted member
sources as one unit — cascade on instance transitions AND establishment,
sticky per-member overrides, absolute block, a one-time heal, and an admin
UI that nests members under their instance.

**Architecture:** Write-side cascade only (stored governance IS effective
governance — zero read-path changes). One exported membership predicate
(byte-prefix range over `canonical_url`) shared by cascade, mint rule,
endpoints, and heal, all living in one new module,
`core/src/logical/membership.ts`. One new `overridden` bit column. Cascade
is one factored function called from `transition()` and
`establishFederation()`, re-running the instance's ACTION through
`SOURCE_TRANSITIONS` per member.

**Tech Stack:** Node 22 native TS, better-sqlite3, Hono, Vitest, SvelteKit 2/Svelte 5.

**Spec:** `docs/superpowers/specs/2026-07-25-instance-governed-members-design.md`
rev 3 (`8e894db`). Review trail: `docs/superpowers/reviews/2026-07-25-instance-governed-members-spec-review.md`,
`docs/superpowers/reviews/2026-07-25-instance-governed-members-plan-review.md`.

**Plan revision:** rev 2. Folds the plan review's 8 must-fix items
(F1-F7/F14, PT7/PT9/PT13/PT16/PT17) and its accepted 8-tasks→6 shape cut.
Also carries two amendments the rev-2 fold's mandatory fresh re-verification
surfaced — this plan's rev 1 was written 2026-07-25; two unrelated pieces of
work landed on `main` since and changed load-bearing facts this plan
depends on:

1. **Migration slot 18 is taken.** The concurrent "publisher-identity-fix"
   release landed `AGGREGATE_PUBLISHER_IDENTITY_FIX` as migration #18
   (`core/src/storage/sqlite.ts:1211`, current HEAD version). This plan's
   schema change is now **migration 19**, appended after it. Every citation
   below reflects this.
2. **The `RSC_SOURCE_MODEL_V2` flag no longer exists.** It was fully
   deleted from the codebase in the V1-retirement release (merged
   2026-07-27, after this plan's rev 1 and its review were written).
   `core/test/config.test.ts:84` now pins it as an inert stale env var that
   "does not prevent boot." v2 is unconditional everywhere; there is no
   flag-off code path left to test. Rev 1's Global Constraints line and
   finding F6 (a `makeApp(false)` flag-off assertion) are both **void** —
   dropped below, not applied. No replacement obligation: nothing in this
   feature is flag-gated.

## Global Constraints

- Tail-append migrations only; migration 19 is DDL-only SQL; the heal is a JS step exported from `core/src/logical/membership.ts` and invoked from `migrate()`, wrapped in its own transaction (the `AGGREGATE_PUBLISHER_IDENTITY_FIX` precedent, one migration prior). `core/test/migrations.test.ts` pins `user_version` at lines 19, 99, 135, 246, 286 — update all five from 18 to 19.
- No new command kinds, no fingerprint inputs, no `SourceTransitionResult` widening. Replay: the ledger check returns before effects at both cascade call sites.
- Membership range queries are `>= prefix AND < upperBound(prefix)` — NEVER `LIKE` (scans under BINARY collation).
- Tests in-container per `TESTING.md`: `docker exec rsc-core sh -c "cd /app && npm test -w core"`; web with `-w web` + `env -u CORE_API_URL`. Always also `npx tsc -p core --noEmit` / `svelte-check` (type stripping).
- Never `git add -A`; stage explicit paths; commits end with `developed with the help of AI tools`.
- No new dependencies.
- File:line citations below are approximate (`~`) and were re-verified against real source at fold time (2026-07-28) — `core/src/storage/sqlite.ts` shrank and shifted substantially since rev 1 was drafted (the Repository v1-chain retirement deleted 21 methods). Re-read the current file before editing; don't trust a citation blind.

---

### Task 1: Schema column, DTO field, mint writes 0

**Files:**
- Modify: `core/src/storage/sqlite.ts` (MIGRATIONS tail ~:1211-1215, after `AGGREGATE_PUBLISHER_IDENTITY_FIX,`; `RemoteSourceV2Row` ~:65-78 — add `export`; `rowToRemoteSourceV2` ~:84-94; inline row literals at :633, :730, :872)
- Modify: `core/src/domain/types.ts` (`RemoteSource` ~:86-96)
- Modify: `core/src/logical/verification.ts:303` (mint INSERT)
- Modify: `core/test/migrations.test.ts:19,99,135,246,286` (18 → 19)
- Test: `core/test/logical-schema.test.ts`

**Interfaces:**
- Produces: `remote_sources_v2.overridden INTEGER NOT NULL DEFAULT 1 CHECK (overridden IN (0,1))`; `RemoteSource.overridden: boolean`; `export interface RemoteSourceV2Row` gains `overridden: 0 | 1` (export the interface — Task 2's `membership.ts` needs the type).

- [ ] **Step 1: Write the failing tests** (append to `core/test/logical-schema.test.ts`):

```ts
test('overridden: DEFAULT 1, mint writes 0, CHECK enforces the bit', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as InstanceType<typeof Database>
  // any legacy-shaped INSERT omitting the column defaults to 1
  raw.prepare(`INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
               VALUES ('s1', 'https://a.test/f', 'single_publisher', 'enabled', 'allowed', 'user_subscription', NULL, 0, '2026-07-25T00:00:00.000Z')`).run()
  expect((raw.prepare(`SELECT overridden FROM remote_sources_v2 WHERE id = 's1'`).get() as { overridden: number }).overridden).toBe(1)
  expect(() => raw.prepare(`UPDATE remote_sources_v2 SET overridden = 2 WHERE id = 's1'`).run()).toThrow()
  expect(raw.pragma('user_version', { simple: true })).toBe(19)
  repo.close()
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run core/test/logical-schema.test.ts` → FAIL (`no such column: overridden`).
- [ ] **Step 3: Implement.** Append to `MIGRATIONS` in `sqlite.ts` (tail, immediately after `AGGREGATE_PUBLISHER_IDENTITY_FIX,`):

```ts
  // 19 — instance-governed members (spec 2026-07-25): the sticky-override bit.
  // Appended at the TAIL, AFTER AGGREGATE_PUBLISHER_IDENTITY_FIX (migration
  // #18) — mid-array insertion corrupts user_version on live databases.
  // DEFAULT 1: every existing INSERT omits the column and every non-mint row
  // is a deliberate act; the origin_verification mint writes an explicit 0.
  [`ALTER TABLE remote_sources_v2 ADD COLUMN overridden INTEGER NOT NULL DEFAULT 1 CHECK (overridden IN (0,1))`],
```

Add `export` to `interface RemoteSourceV2Row` (membership.ts imports it as a type in Task 2). Widen `RemoteSourceV2Row` with `overridden: 0 | 1`, `RemoteSource` (in `types.ts`) with `overridden: boolean`, map in `rowToRemoteSourceV2` (`overridden: r.overridden === 0 ? false : true`). Add `overridden: 1` to the three inline `RemoteSourceV2Row` literals (`:633`, `:730`, `:872`). Change the mint INSERT (`verification.ts:303`) to name the column and pass `0`:

```ts
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, overridden, created_at)
     VALUES (?, ?, 'single_publisher', 'enabled', ?, 'origin_verification', NULL, 0, 0, ?)`,
```

Update the five `migrations.test.ts` pins (lines 19, 99, 135, 246, 286) from `toBe(18)` to `toBe(19)`.
- [ ] **Step 4: Run** the schema + migrations + full core suites → PASS; `tsc` 0.
- [ ] **Step 5: Commit** `core: add the overridden bit — sticky member overrides (migration 19)`.

---

### Task 2: The membership module — predicate, mint rule, admin-read paging, heal

*(Rev 1's Task 2 "membership predicate module" and Task 4 "mint rule" merge here per the plan review's accepted shape cut — both are consumers of the same one-file predicate, and `membership.ts` also gains the two functions the review's F2 and PT16/PT17/F5 require: `memberRowsPage`/`memberCounts` for admin reads, `healMembers` for the migration heal.)*

**Files:**
- Create: `core/src/logical/membership.ts`
- Modify: `core/src/logical/verification.ts:294-304` (`findOrCreateOriginSource`)
- Test: `core/test/logical-membership.test.ts` (new — the module's own unit tests)
- Test: `core/test/logical-verification.test.ts` (append — the mint-rule tests)

**Interfaces:**
- Consumes: Task 1's `RemoteSourceV2Row` (exported), `overridden`.
- Produces (exact, later tasks consume verbatim):

```ts
export function instancePrefix(canonicalUrl: string): string | null
// 'https://rss.chat/users/rss.xml' -> 'https://rss.chat/'; null on unparsable.
export function prefixUpperBound(prefix: string): string
// last byte incremented: 'https://rss.chat/' -> 'https://rss.chat0'
export interface ApprovedInstance { id: string; canonicalUrl: string; governance: string; createdAt: string }
export function approvedInstanceFor(raw: Db, memberUrl: string): ApprovedInstance | null
// The deterministic pick among approved federated aggregates whose prefix
// covers memberUrl: if ANY matching one is blocked, return THAT (block is
// absolute); else earliest created_at, then id. null when none.
export function memberRows(raw: Db, instance: { id: string; canonical_url: string }): { id: string; governance: string; operation: string; overridden: 0 | 1 }[]
// prefix-range + provenance='origin_verification' + id != instance.id. >=/< only.
// Lean projection: the cascade and heal's own working set. NOT gated on the
// instance's own federation status — both callers already hold a
// known-approved instance row before calling this.
export function memberRowsPage(raw: Db, instance: { id: string; canonical_url: string }, cursor: Cursor | undefined, limit: number): { rows: RemoteSourceV2Row[]; nextCursor: string | null }
// F2: full rows (reusable with rowToRemoteSourceV2), GATED — returns
// { rows: [], nextCursor: null } unless instance.id currently holds an
// APPROVED federation_relationships_v2 row. Cursor-paginated same idiom as
// listSourceSubscriptions (created_at DESC, id DESC).
export function memberCounts(raw: Db, instance: { id: string; canonical_url: string }): { members: number; overridden: number }
// PT10: two numbers only — callers derive instanceGoverned = members - overridden.
// Same F2 gate as memberRowsPage.
export function healMembers(raw: Db): void
// PT16/PT17/F5: the migration-19 one-time heal, self-contained in ONE
// raw.transaction(...)() — atomic even if the process dies mid-heal.
export const MEMBER_RANGE_SQL: string
// F7/PT7: the shared WHERE-clause fragment memberRows/memberRowsPage build
// their queries from, so the EXPLAIN plan test asserts against the SHIPPED
// statement text instead of a hand-retyped twin.
```

- [ ] **Step 1: Failing tests** (`core/test/logical-membership.test.ts`) — cover: prefix derivation (scheme/host/port kept, path dropped, `https://RSS.chat:443/x` → `https://rss.chat/` via `new URL`), upper bound, `memberRows` excludes the instance row itself / other provenances / other hosts / an `http://` member under an `https://` instance (the stated ceiling), `approvedInstanceFor` picks earliest-created among two approved same-prefix aggregates and prefers a BLOCKED one over an earlier allowed one, returns null when the only candidate's federation is pending or absent, `memberRowsPage`/`memberCounts` return empty for an instance with NO approved federation relationship (F2's gate) and page/count correctly once approved, `healMembers` is exercised directly in Task 3's migration test (not duplicated here). Seed rows with direct INSERTs (the Task 1 column exists). Plus the plan test, built from the shared SQL constant (F7/PT7):

```ts
test('the member range plans as SEARCH on the canonical_url autoindex', async () => {
  const plan = raw.prepare(`EXPLAIN QUERY PLAN SELECT id FROM remote_sources_v2 WHERE ${MEMBER_RANGE_SQL}`).all('https://x.test/', 'https://x.test0', 'irrelevant') as { detail: string }[]
  expect(plan.map((r) => r.detail).join(' ')).toMatch(/SEARCH .*USING (COVERING )?INDEX/)
})
```

- [ ] **Step 2: Run** → FAIL (module missing).
- [ ] **Step 3: Implement** `membership.ts`:

```ts
import type Database from 'better-sqlite3'
import type { RemoteSourceV2Row } from '../storage/sqlite.ts'
import { encodeCursor, clampLimit, type Cursor } from '../domain/source-repository.ts'
type Db = InstanceType<typeof Database>

// ONE membership definition (spec rev 3 §Decided model), shared verbatim by
// the cascade, the mint rule, the admin member reads, and the heal.
// ponytail: http and https on one host do NOT group — split membership.
export function instancePrefix(canonicalUrl: string): string | null {
  try {
    const u = new URL(canonicalUrl)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return `${u.protocol}//${u.host}/`
  } catch { return null }
}

export function prefixUpperBound(prefix: string): string {
  return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
}

export interface ApprovedInstance { id: string; canonicalUrl: string; governance: string; createdAt: string }

export function approvedInstanceFor(raw: Db, memberUrl: string): ApprovedInstance | null {
  const prefix = instancePrefix(memberUrl)
  if (!prefix) return null
  const rows = raw.prepare(
    `SELECT s.id, s.canonical_url, s.governance, s.created_at FROM remote_sources_v2 s
     JOIN federation_relationships_v2 f ON f.source_id = s.id AND f.status = 'approved'
     WHERE s.canonical_url >= ? AND s.canonical_url < ?
     ORDER BY s.created_at ASC, s.id ASC`,
  ).all(prefix, prefixUpperBound(prefix)) as { id: string; canonical_url: string; governance: string; created_at: string }[]
  if (rows.length === 0) return null
  const pick = rows.find((r) => r.governance === 'blocked') ?? rows[0] // block is absolute
  return { id: pick.id, canonicalUrl: pick.canonical_url, governance: pick.governance, createdAt: pick.created_at }
}

// The shared range fragment (F7/PT7): both memberRows and memberRowsPage
// build their WHERE clause from this constant, and the EXPLAIN plan test
// asserts against it directly — a hand-retyped copy in the test could drift
// silently from the real query and still pass.
export const MEMBER_RANGE_SQL = `canonical_url >= ? AND canonical_url < ? AND provenance = 'origin_verification' AND id != ?`

export function memberRows(raw: Db, instance: { id: string; canonical_url: string }): { id: string; governance: string; operation: string; overridden: 0 | 1 }[] {
  const prefix = instancePrefix(instance.canonical_url)
  if (!prefix) return []
  return raw.prepare(
    `SELECT id, governance, operation, overridden FROM remote_sources_v2 WHERE ${MEMBER_RANGE_SQL} ORDER BY canonical_url ASC`,
  ).all(prefix, prefixUpperBound(prefix), instance.id) as { id: string; governance: string; operation: string; overridden: 0 | 1 }[]
}

function isApprovedFederatedInstance(raw: Db, instanceId: string): boolean {
  return !!raw.prepare(`SELECT 1 FROM federation_relationships_v2 WHERE source_id = ? AND status = 'approved'`).get(instanceId)
}

// F2: admin reads of an id's members are gated on that id CURRENTLY holding
// an approved federation relationship — an arbitrary/non-instance/no-longer-
// federated id returns an empty page/counts, never a 404 (same posture as
// the sibling :id/subscriptions and :id/audit reads).
export function memberRowsPage(raw: Db, instance: { id: string; canonical_url: string }, cursor: Cursor | undefined, limit: number): { rows: RemoteSourceV2Row[]; nextCursor: string | null } {
  if (!isApprovedFederatedInstance(raw, instance.id)) return { rows: [], nextCursor: null }
  const prefix = instancePrefix(instance.canonical_url)
  if (!prefix) return { rows: [], nextCursor: null }
  const upper = prefixUpperBound(prefix)
  const lim = clampLimit(limit)
  const rows = (cursor
    ? raw.prepare(
        `SELECT * FROM remote_sources_v2 WHERE ${MEMBER_RANGE_SQL}
           AND ((created_at < ?) OR (created_at = ? AND id < ?))
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      ).all(prefix, upper, instance.id, cursor.createdAt, cursor.createdAt, cursor.id, lim + 1)
    : raw.prepare(
        `SELECT * FROM remote_sources_v2 WHERE ${MEMBER_RANGE_SQL} ORDER BY created_at DESC, id DESC LIMIT ?`,
      ).all(prefix, upper, instance.id, lim + 1)
  ) as RemoteSourceV2Row[]
  const page = rows.length > lim ? rows.slice(0, lim) : rows
  const nextCursor = rows.length > lim ? encodeCursor({ createdAt: page[lim - 1].created_at, id: page[lim - 1].id }) : null
  return { rows: page, nextCursor }
}

export function memberCounts(raw: Db, instance: { id: string; canonical_url: string }): { members: number; overridden: number } {
  if (!isApprovedFederatedInstance(raw, instance.id)) return { members: 0, overridden: 0 }
  const prefix = instancePrefix(instance.canonical_url)
  if (!prefix) return { members: 0, overridden: 0 }
  const row = raw.prepare(
    `SELECT COUNT(*) AS members, SUM(overridden) AS overridden FROM remote_sources_v2 WHERE ${MEMBER_RANGE_SQL}`,
  ).get(prefix, prefixUpperBound(prefix), instance.id) as { members: number; overridden: number | null }
  return { members: row.members, overridden: row.overridden ?? 0 }
}

// PT16/PT17/F5: the migration-19 one-time heal. Self-contained transaction —
// atomic even if the process dies mid-heal, unlike a heal left to run
// unwrapped after migrate()'s own per-migration transaction closes.
export function healMembers(raw: Db): void {
  raw.transaction(() => {
    raw.prepare(`UPDATE remote_sources_v2 SET overridden = 0 WHERE provenance = 'origin_verification'`).run()
    const instances = raw.prepare(
      `SELECT s.id, s.canonical_url, s.governance FROM remote_sources_v2 s
       JOIN federation_relationships_v2 f ON f.source_id = s.id AND f.status = 'approved'
       WHERE s.governance != 'blocked' ORDER BY s.created_at ASC, s.id ASC`,
    ).all() as { id: string; canonical_url: string; governance: string }[]
    const healed = new Set<string>()
    for (const inst of instances) {
      for (const m of memberRows(raw, { id: inst.id, canonical_url: inst.canonical_url })) {
        if (healed.has(m.id)) continue // deterministic: earliest instance wins
        healed.add(m.id)
        if (m.governance !== inst.governance) raw.prepare(`UPDATE remote_sources_v2 SET governance = ? WHERE id = ?`).run(inst.governance, m.id)
      }
    }
  })()
}
```

- [ ] **Step 4: Run** membership suite → PASS.
- [ ] **Step 5: Mint-rule failing tests** (append to `core/test/logical-verification.test.ts`): (a) minting an origin whose prefix matches an APPROVED allowed instance → born `allowed` even when the ASSERTING aggregate is quarantined (cross-instance echo case); (b) matching approved instance is BLOCKED → born `blocked`; (c) no approved instance → inherits the asserting aggregate's governance (today's behavior, regression-pinned).
- [ ] **Step 6: Run** → FAIL. **Step 7: Implement** — in `findOrCreateOriginSource` (`verification.ts:294-304`), before the INSERT: `const inst = approvedInstanceFor(raw, url); const gov = inst ? inst.governance : assertingGovernance` (keep the existing read of the asserting aggregate's governance as the fallback; import `approvedInstanceFor` from `../logical/membership.ts`).
- [ ] **Step 8: Run** verification suite + full core → PASS. **Step 9: Commit** `core: the membership module — predicate, mint inheritance, admin paging, heal`.

---

### Task 3: The cascade at both call sites

**Files:**
- Modify: `core/src/storage/sqlite.ts` — new function near `advancePolicyGeneration` (~:36); wire in `transition()` (~:896-970, after its own `advancePolicyGeneration`/`journalPolicyReset` block at ~:937-940) and in `establishFederation()` (~:837-885, after its `journalPolicyReset` at ~:883); the `overridden` flip inside `transition()`, after its axes UPDATE (~:920-924).
- Test: `core/test/source-cascade.test.ts` (new)

**Interfaces:**
- Consumes: Task 2's `memberRows` (import from `../logical/membership.ts`); existing `SOURCE_TRANSITIONS`, `activatePendingSubscriptions(raw, row)`, `advancePolicyGeneration(raw, sourceId, now)`, `insertAudit(raw, { sourceId, command: { commandId, actorId }, actorKind, action, category, note, result, now })`.
- Produces: `cascadeInstanceAction(raw, instanceRow, action: SourceTransitionAction | 'establish', now): number` (returns members MOVED). Signature is identical at both call sites — `(raw, instance, action, now)` — with the audit insert pattern also identical at both (PT13/F4).

- [ ] **Step 1: Failing tests** — through the REAL repository API (`createSqliteRepository`, `repo.transition`, `repo.establishFederation`), seed an approved instance + members via direct INSERT (provenance `origin_verification`, `overridden` per case):
  1. instance `quarantine` → instance-governed allowed members become quarantined, `overridden=1` member untouched, policy generation advanced per moved member, ONE `instance_cascade` audit row on the INSTANCE with `result_json` containing `{"moved":N}`, exactly ONE journal reset row appended for the whole command.
  2. instance `allow` → quarantined members lift; an explicitly-BLOCKED member (null cell) skipped; a `pending` subscription on a lifted member becomes `active`.
  3. `block` → ALL members (overridden included) become blocked; `unblock` → ALL members land quarantined (the action re-run, blocked→quarantined cell).
  4. `establishFederation` on a URL whose prefix covers pre-existing quarantined `origin_verification` rows → they lift to allowed (cascade as `allow`).
  5. replay: re-sending the same commandId (both APIs) returns the stored result; member states unchanged; no second audit row.
  6. a direct `repo.transition` `quarantine` on a member (administrator) sets its `overridden = 1`; a `pause` on a member does NOT.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** In `sqlite.ts` (module scope, near `advancePolicyGeneration`):

```ts
// The instance-governed-members cascade (spec 2026-07-25 rev 3): re-run the
// instance's ACTION through SOURCE_TRANSITIONS against each member's own axes
// (action, not value — value→cell has no legal unblock mapping). Members have
// no federation axis. Ordinary actions skip overridden members; block/unblock
// hit ALL (absolute both directions). Returns members MOVED.
function cascadeInstanceAction(raw: Db, instance: { id: string; canonical_url: string }, action: SourceTransitionAction | 'establish', now: string): number {
  const effective = action === 'establish' || action === 'approve' ? 'allow' : action
  if (effective !== 'allow' && effective !== 'quarantine' && effective !== 'block' && effective !== 'unblock') return 0
  const absolute = effective === 'block' || effective === 'unblock'
  let moved = 0
  for (const m of memberRows(raw, instance)) {
    if (!absolute && m.overridden === 1) continue
    const patch = SOURCE_TRANSITIONS[effective]({ operation: m.operation as SourceOperation, governance: m.governance as SourceGovernance, federation: 'none' })
    if (!patch || patch.governance === undefined || patch.governance === m.governance) continue
    raw.prepare(`UPDATE remote_sources_v2 SET governance = ? WHERE id = ?`).run(patch.governance, m.id)
    if (patch.governance === 'allowed') {
      const row = raw.prepare(`SELECT * FROM remote_sources_v2 WHERE id = ?`).get(m.id) as RemoteSourceV2Row
      activatePendingSubscriptions(raw, row)
    }
    advancePolicyGeneration(raw, m.id, now) // members do NOT append their own reset
    moved++
  }
  return moved
}
```

Wire in `transition()` immediately after the existing `advancePolicyGeneration`/`journalPolicyReset` block (so it runs only when governance/federation/mode changed) — but per spec the trigger is governance-change OR approve:

```ts
      if (governance !== row.governance || input.action === 'approve') {
        const fedNow = patch.federation === 'approved' || (fed?.status === 'approved' && patch.federation === undefined)
        if (fedNow) {
          const moved = cascadeInstanceAction(raw, { id: row.id, canonical_url: row.canonical_url }, input.action, input.now)
          if (moved > 0) insertAudit(raw, { sourceId: row.id, command: input.command, actorKind: 'system', action: 'instance_cascade', category: input.category, note: null, result: { moved }, now: input.now })
        }
      }
```

The `overridden` flip, just after the axes UPDATE in `transition()`:

```ts
      // A direct administrator GOVERNANCE change on a member is a sticky
      // override; pause/resume/set_attribution_mode are not judgments.
      if (input.actorKind === 'administrator' && governance !== row.governance && row.provenance === 'origin_verification') {
        raw.prepare(`UPDATE remote_sources_v2 SET overridden = 1 WHERE id = ?`).run(row.id)
      }
```

Wire in `establishFederation()` after its `journalPolicyReset(raw, input.now)`:

```ts
      const moved = cascadeInstanceAction(raw, { id: row.id, canonical_url: row.canonical_url }, 'establish', input.now)
      if (moved > 0) insertAudit(raw, { sourceId: row.id, command: input.command, actorKind: 'system', action: 'instance_cascade', category: input.category, note: null, result: { moved }, now: input.now })
```

(Import `memberRows` from `../logical/membership.ts`. Both call sites already share the identical `cascadeInstanceAction(raw, instance, action, now)` signature and the identical post-cascade `insertAudit` shape — PT13/F4's unification is structural, not an extra abstraction: verify this stays true as you wire both sites, don't let them drift apart.)
- [ ] **Step 4: Run** cascade suite + FULL core suite (`source-admin-api`, `logical-v3-vertical`, `logical-v4-vertical` must stay green) + `tsc` → PASS.
- [ ] **Step 5: Commit** `core: cascade instance governance to members at both write sites`.

---

### Task 4: Migration heal — wire into `migrate()`

*(Rev 1's Task 5. The heal LOGIC now lives in `membership.ts`'s `healMembers`, built in Task 2 — this task is just the wiring + the migration-boundary test, per PT16/PT17/F5.)*

**Files:**
- Modify: `core/src/storage/sqlite.ts` — import `healMembers`; in `migrate()` (~:1217-1231), call it once after the migration loop when the pre-migration version was below 19.
- Test: `core/test/migrations.test.ts` (append)

- [ ] **Step 1: Failing test** — follow the exact pattern already established by the neighboring `migration 18` test at `migrations.test.ts:250-289` (build via `MIGRATIONS.slice(0, N).flat()`, not a hand-replicated schema): build a pre-19 DB fixture at `user_version = 18` (in-memory, run migrations 1-18 via `MIGRATIONS.slice(0, 18).flat()`), seed: approved instance A + hand-approved member (allowed) + stuck member (quarantined) + BLOCKED instance B with a member + two approved same-prefix aggregates C1/C2 (C1 earlier `created_at`) with a member, then open through `createSqliteRepository` → assert: all `origin_verification` rows have `overridden = 0`; A's members both `allowed` (marathon forgiven + stuck lifted); B's member governance UNCHANGED (blocked instances excluded); C's member synced to C1 (earliest created_at); `user_version` is now 19.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** in `migrate()`:

```ts
function migrate(sqlite: InstanceType<typeof Database>): void {
  const version = sqlite.pragma('user_version', { simple: true }) as number
  if (version > MIGRATIONS.length) {
    throw new Error(`database is newer than this build (version ${version}, this build knows ${MIGRATIONS.length})`)
  }
  if (version === 0) {
    const { n } = sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }
    if (n > 0) throw new Error('pre-migration database — delete it (dev data only) and restart')
  }
  for (let v = version + 1; v <= MIGRATIONS.length; v++) {
    sqlite.transaction(() => {
      for (const stmt of MIGRATIONS[v - 1]) sqlite.exec(stmt)
      sqlite.pragma(`user_version = ${v}`)
    })()
  }
  // 19 — instance-governed members: members adopt their instance NOW, once,
  // the first time this DB crosses migration 19. healMembers wraps its own
  // transaction — safe even if the process dies mid-heal.
  if (version < 19) healMembers(sqlite)
}
```

(Import `healMembers` from `../logical/membership.ts` at the top of `sqlite.ts`.)
- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `core: wire the member heal into migration 19`.

---

### Task 5: Member read endpoints

*(Rev 1's Task 6. F2's gate lives in Task 2's `memberRowsPage`/`memberCounts` already — this task wires the repository methods and routes, and folds the authz test into the existing matrix per PT9/F3.)*

**Files:**
- Modify: `core/src/domain/source-repository.ts` — add `listSourceMembers(sourceId, cursor, limit): Promise<Page<SourceSummary>>` and `sourceMemberCounts(sourceId): Promise<{ members: number; overridden: number }>` to the `SourceRepository` interface.
- Modify: `core/src/storage/sqlite.ts` — implement both on `SqliteRepository`, delegating to `memberRowsPage`/`memberCounts`; two new routes in `app.ts`.
- Modify: `core/src/api/app.ts` — two routes inside the `if (sources)` admin block (~:302-320), following the `:id/subscriptions` (~:308) and `:id/audit` (~:314) siblings, before the `POST :id/:action` handler (~:364).
- Test: `core/test/source-admin-api.test.ts` (append — folded into the existing authz matrix, PT9/F3)

- [ ] **Step 1: Failing tests:**
  - counts endpoint returns `{ members: 3, overridden: 1 }` for an instance with 3 members (1 overridden) — caller derives `instanceGoverned = 2` itself (PT10);
  - members endpoint pages with the standard cursor (`created_at DESC, id DESC`);
  - a non-instance id (no approved federation relationship) returns empty counts/page (not 404 — same posture as `:id/subscriptions`), confirming Task 2's F2 gate is reachable through the route;
  - **PT9/F3**: the two new routes join `source-admin-api.test.ts:68`'s existing parametrized authz matrix (`routes: Record<string, ...>`) as two more entries — `members: (headers) => app.request(...)`, `membersCounts: (headers) => app.request(...)` — asserted against the SAME `expected = [401, 403, 403, 200, 401, 401]` array as every other admin route, not a bespoke standalone 401-anonymous pair.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** — repository methods in `sqlite.ts`:

```ts
  async listSourceMembers(sourceId: string, cursor: Cursor | undefined, limit: number): Promise<Page<SourceSummary>> {
    const instRow = this.raw.prepare(`SELECT id, canonical_url FROM remote_sources_v2 WHERE id = ?`).get(sourceId) as { id: string; canonical_url: string } | undefined
    if (!instRow) return { items: [], nextCursor: null }
    const { rows, nextCursor } = memberRowsPage(this.raw, instRow, cursor, limit)
    const items: SourceSummary[] = rows.map((r) => {
      const source = rowToRemoteSourceV2(r)
      return { source, federationStatus: this.federationStatusFor(source.id), subscriptionCounts: this.subscriptionCountsFor(source.id), push: this.pushFor(source.id).push }
    })
    return { items, nextCursor }
  }

  async sourceMemberCounts(sourceId: string): Promise<{ members: number; overridden: number }> {
    const instRow = this.raw.prepare(`SELECT id, canonical_url FROM remote_sources_v2 WHERE id = ?`).get(sourceId) as { id: string; canonical_url: string } | undefined
    if (!instRow) return { members: 0, overridden: 0 }
    return memberCounts(this.raw, instRow)
  }
```

(Import `memberRowsPage`, `memberCounts` from `../logical/membership.ts`. This reuses the exact per-row summary shape `listSourceSummaries` already builds — `federationStatusFor`/`subscriptionCountsFor`/`pushFor` are existing private methods on the class.)

Routes in `app.ts`:

```ts
    app.get('/admin/sources/:id/members', async (c) => {
      const args = pageArgs(c)
      if (args instanceof Response) return args
      return c.json(await v2repo.listSourceMembers(c.req.param('id') ?? '', args.cursor, args.limit))
    })
    app.get('/admin/sources/:id/members/counts', async (c) => {
      return c.json(await v2repo.sourceMemberCounts(c.req.param('id') ?? ''))
    })
```

- [ ] **Step 4: Run** + full core + tsc → PASS. **Step 5: Commit** `core: member list + counts reads per instance`.

---

### Task 6: Admin UI — members under their instance, journey checklist, gates

*(Rev 1's Task 7 "Admin UI" and Task 8 "Journey checklist + gates" merge here per the review's accepted shape cut. F1 and F14 apply here.)*

**Files:**
- Modify: `web/src/routes/admin/feeds/+page.server.ts` (member exclusion in `groupOf` for `user` AND `review`; compute a derived boolean signal — NOT the raw `provenance` string — into the local row type; fetch counts per federated instance row from `/admin/sources/:id/members/counts`, deriving `instanceGoverned = members - overridden` server-side per PT10)
- Modify: `web/src/routes/admin/feeds/+page.svelte` (roll-up line on instance rows; lazy member expansion via `?expand=<sourceId>` re-rendering the page with that instance's member rows inlined, fetched from `/admin/sources/:id/members`; `overridden` badge; `via verification` hint on non-nested members)
- Test: `web/src/routes/admin/feeds/source-actions.test.ts` (append)
- Modify: `docs/superpowers/documentation/2026-07-25-user-journey-checklist.md`

**F1 (must-fix):** the frozen test at `source-actions.test.ts:~121-125` asserts the exact request shape a source action posts (`{ commandId, category, note, attributionMode }` — no extra keys) — the local `SourceSummary`-ish row type in `+page.server.ts` must **never** carry the raw `provenance` string forward from the core API response into anything rendered or posted. Compute one derived boolean instead: `isInstanceMember: boolean`.

**F14 (must-fix, dated spec-edge amendment):** the membership predicate closes a nested-instance edge the spec didn't explicitly resolve — a row that is itself `provenance === 'origin_verification'` AND carries its OWN approved federation relationship is excluded from membership (it is independently federated, not a subordinate of the instance whose prefix happens to cover it). Record this inline as a dated comment (`// 2026-07-28 spec-edge amendment: ...`) at the predicate site, not just in the commit message.

- [ ] **Step 1: Failing tests:** (a) a member row (provenance `origin_verification`, prefix-covered by an approved federated row in the same payload, itself NOT approved-federated) appears in NEITHER `user` NOR `review` groups; (b) a row that IS itself approved-federated is NOT excluded even though its prefix is also covered by another approved instance (F14 — it stays in its own group, un-nested); (c) an instance row carries `memberCounts` (`members`, `overridden`, and a derived `instanceGoverned`) from the counts fetch; (d) `?expand=<id>` loads member rows for that instance only; (e) a member of a NON-federated host stays in `user` with the hint flag; (f) the frozen source-action-post test at `:~121-125` still asserts no extra keys in the posted body (regression-pins F1 — the row type change must not leak into what gets posted).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** — membership predicate, client-side:

```ts
// 2026-07-28 spec-edge amendment (plan review F14): a row that is itself
// approved-federated governs itself — it is never treated as a member, even
// when another approved instance's prefix happens to cover its URL.
function isInstanceMember(row: Row, allRows: Row[]): boolean {
  if (row.provenance !== 'origin_verification') return false
  if (row.federationStatus === 'approved') return false
  const rowPrefix = instancePrefixClient(row.canonicalUrl)
  return allRows.some((inst) => inst.federationStatus === 'approved' && inst.id !== row.id && instancePrefixClient(inst.canonicalUrl) === rowPrefix)
}
```

(`instancePrefixClient` mirrors `membership.ts`'s `instancePrefix` — scheme+host only, via `new URL`.) F1: the local row type carries `isInstanceMember: boolean` computed via the function above; it never carries a `provenance` field. Exclusion in `groupOf` checks `isInstanceMember`; counts fetched in parallel (`Promise.all`) for federated rows only, with `instanceGoverned = members - overridden` computed at the load site (PT10); expansion via the `?expand=` query param.
- [ ] **Step 4: Run** web tests + svelte-check + build → PASS.
- [ ] **Step 5:** Add to the journey checklist: "Federate an instance → members appear under it (counts match); moderate one member (overridden badge); block the instance (ALL members dark on timeline/byline/publisher — navigation assertions); unblock (members quarantined; overrides NOT restored — V1)."
- [ ] **Step 6:** Full gates: core suite + tsc, web suite + svelte-check + build, all in-container. Expected: green (+ the 2 expected-fail markers).
- [ ] **Step 7: Commit** `web: nest instance members under their instance; journey checklist row`.

---

## Self-review record

Spec coverage: model (T1/T2), cascade both sites + overridden flip (T3),
heal (T4), endpoints (T5), UI incl. review-group exclusion + hint + journey
row (T6); replay pinned in T3 tests; EXPLAIN plan in T2 (against the shipped
`MEMBER_RANGE_SQL`, not a hand-typed twin); the five migrations.test pins in
T1 (17→18 was already consumed by the concurrent publisher-identity-fix
release; this plan bumps 18→19). Type consistency: `memberRows` /
`memberRowsPage` / `memberCounts` / `approvedInstanceFor` /
`cascadeInstanceAction` / `healMembers` names used identically across
T2-T5. No placeholders remain.

Plan-review fold (rev 1 → rev 2), all 8 must-fix items applied: F1 (T6, no
`provenance` on web rows, derived boolean instead), F2 (T2/T5, `:id`
approved-federation gate baked into `memberRowsPage`/`memberCounts`), F3/PT9
(T5, folded into `source-admin-api.test.ts`'s existing authz matrix), F4/PT13
(T3, one `(raw, instance, action, now)` cascade signature — already
consistent at both call sites in rev 1's own text, reconfirmed rather than
needlessly rewritten), F5/PT16/PT17 (T2 defines `healMembers`, T4 wires it
into `migrate()` inside its own transaction), F6 (VOID — the
`RSC_SOURCE_MODEL_V2` flag it would have tested no longer exists; dropped,
not applied), F7/PT7 (T2, EXPLAIN test runs over the exported
`MEMBER_RANGE_SQL` constant — `logical-fk-indexes.test.ts` has no standalone
`plan()` helper to import, so the shared-constant approach achieves the
same "not a hand-typed twin" intent through this codebase's real pattern),
F14 (T6, nested-instance edge closes in the client predicate, dated amendment
comment). Accepted shape cut applied: 8 tasks → 6 (T2+T4 merged into new T2;
T8 merged into new T6; old T5/T6/T7 renumbered T4/T5/T6).

Two additional dated amendments beyond the review's own list, both found by
this fold's mandatory fresh re-verification against real source (not
assumed from rev 1's text): migration slot 18 was claimed by the concurrent
`AGGREGATE_PUBLISHER_IDENTITY_FIX` release — this plan is now migration 19,
and all five `migrations.test.ts` pins (not the four rev 1 assumed) move
18→19; and the `RSC_SOURCE_MODEL_V2` flag-off constraint/F6 are void since
that flag was deleted from the codebase entirely in the interim
V1-retirement release.

*developed with the help of AI tools*
