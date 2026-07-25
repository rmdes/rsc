# Instance-Governed Members Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Federating an instance governs its verification-minted member
sources as one unit — cascade on instance transitions AND establishment,
sticky per-member overrides, absolute block, a one-time heal, and an admin
UI that nests members under their instance.

**Architecture:** Write-side cascade only (stored governance IS effective
governance — zero read-path changes). One exported membership predicate
(byte-prefix range over `canonical_url`) shared by cascade, mint rule,
endpoints, and heal. One new `overridden` bit column. Cascade is one
factored function called from `transition()` and `establishFederation()`,
re-running the instance's ACTION through `SOURCE_TRANSITIONS` per member.

**Tech Stack:** Node 22 native TS, better-sqlite3, Hono, Vitest, SvelteKit 2/Svelte 5.

**Spec:** `docs/superpowers/specs/2026-07-25-instance-governed-members-design.md`
rev 3 (`8e894db`). Review trail (plan-level notes 10-15 apply):
`docs/superpowers/reviews/2026-07-25-instance-governed-members-spec-review.md`.

## Global Constraints

- Flag-off byte-identical: every touched path is v2-only; nothing changes when `RSC_SOURCE_MODEL_V2` is off.
- Tail-append migrations only; migration 18 is DDL-only SQL; the heal is a JS step beside it (the `convert.ts` precedent). `core/test/migrations.test.ts` pins `user_version` at lines 19, 99, 133, 244 — update all four to 18.
- No new command kinds, no fingerprint inputs, no `SourceTransitionResult` widening. Replay: the ledger check returns before effects at both cascade call sites.
- Membership range queries are `>= prefix AND < upperBound(prefix)` — NEVER `LIKE` (scans under BINARY collation).
- Tests in-container per `TESTING.md`: `docker exec rsc-core sh -c "cd /app && npm test -w core"`; web with `-w web` + `env -u CORE_API_URL`. Always also `npx tsc -p core --noEmit` / `svelte-check` (type stripping).
- Never `git add -A`; stage explicit paths; commits end with `developed with the help of AI tools`.
- No new dependencies.

---

### Task 1: Schema column, DTO field, mint writes 0

**Files:**
- Modify: `core/src/storage/sqlite.ts` (MIGRATIONS tail ~:1489-1510; `RemoteSourceV2Row` ~:69-78; `rowToRemoteSourceV2` ~:88-94; inline row literals at ~:939, ~:1036, ~:1178)
- Modify: `core/src/domain/types.ts` (`RemoteSource` ~:117-127)
- Modify: `core/src/logical/verification.ts:299-302` (mint INSERT)
- Modify: `core/test/migrations.test.ts:19,99,133,244` (17 → 18)
- Test: `core/test/logical-schema.test.ts`

**Interfaces:**
- Produces: `remote_sources_v2.overridden INTEGER NOT NULL DEFAULT 1 CHECK (overridden IN (0,1))`; `RemoteSource.overridden: boolean`; `RemoteSourceV2Row.overridden: 0 | 1`.

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
  expect(raw.pragma('user_version', { simple: true })).toBe(18)
  repo.close()
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run core/test/logical-schema.test.ts` → FAIL (`no such column: overridden`).
- [ ] **Step 3: Implement.** Append to `MIGRATIONS` in `sqlite.ts` (tail, after migration 17):

```ts
  // 18 — instance-governed members (spec 2026-07-25): the sticky-override bit.
  // DEFAULT 1: every existing INSERT omits the column and every non-mint row is
  // a deliberate act; the origin_verification mint writes an explicit 0.
  [`ALTER TABLE remote_sources_v2 ADD COLUMN overridden INTEGER NOT NULL DEFAULT 1 CHECK (overridden IN (0,1))`],
```

Widen `RemoteSourceV2Row` with `overridden: 0 | 1`, `RemoteSource` with `overridden: boolean`, map in `rowToRemoteSourceV2` (`overridden: r.overridden === 0 ? false : true` — expose as "isOverride"; keep name `overridden`). Add `overridden: 1` to the three inline `RemoteSourceV2Row` literals (`:939`, `:1036`, `:1178`). Change the mint INSERT (`verification.ts:300-301`) to name the column and pass `0`:

```ts
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, overridden, created_at)
     VALUES (?, ?, 'single_publisher', 'enabled', ?, 'origin_verification', NULL, 0, 0, ?)`,
```

Update the four `migrations.test.ts` pins 17 → 18.
- [ ] **Step 4: Run** the schema + migrations + full core suites → PASS; `tsc` 0.
- [ ] **Step 5: Commit** `core: add the overridden bit — sticky member overrides (migration 18)`.

---

### Task 2: The membership predicate module

**Files:**
- Create: `core/src/logical/membership.ts`
- Test: `core/test/logical-membership.test.ts`

**Interfaces:**
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
```

- [ ] **Step 1: Failing tests** (`core/test/logical-membership.test.ts`) — cover: prefix derivation (scheme/host/port kept, path dropped, `https://RSS.chat:443/x` → `https://rss.chat/` via `new URL`), upper bound, member listing excludes the instance row itself / other provenances / other hosts / an `http://` member under an `https://` instance (the stated ceiling), `approvedInstanceFor` picks earliest-created among two approved same-prefix aggregates and prefers a BLOCKED one over an earlier allowed one, returns null when the only candidate's federation is pending or absent. Seed rows with direct INSERTs (the Task 1 column exists). Plus the plan test:

```ts
test('the member range plans as SEARCH on the canonical_url autoindex', async () => {
  const plan = raw.prepare(`EXPLAIN QUERY PLAN SELECT id FROM remote_sources_v2 WHERE canonical_url >= ? AND canonical_url < ? AND provenance = 'origin_verification'`).all('https://x.test/', 'https://x.test0') as { detail: string }[]
  expect(plan.map((r) => r.detail).join(' ')).toMatch(/SEARCH .*USING (COVERING )?INDEX/)
})
```

- [ ] **Step 2: Run** → FAIL (module missing).
- [ ] **Step 3: Implement** `membership.ts`:

```ts
import type Database from 'better-sqlite3'
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

export function memberRows(raw: Db, instance: { id: string; canonical_url: string }): { id: string; governance: string; operation: string; overridden: 0 | 1 }[] {
  const prefix = instancePrefix(instance.canonical_url)
  if (!prefix) return []
  return raw.prepare(
    `SELECT id, governance, operation, overridden FROM remote_sources_v2
     WHERE canonical_url >= ? AND canonical_url < ? AND provenance = 'origin_verification' AND id != ?
     ORDER BY canonical_url ASC`,
  ).all(prefix, prefixUpperBound(prefix), instance.id) as { id: string; governance: string; operation: string; overridden: 0 | 1 }[]
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `core: the one membership predicate — prefix range, deterministic pick`.

---

### Task 3: The cascade at both call sites

**Files:**
- Modify: `core/src/storage/sqlite.ts` — new function near `advancePolicyGeneration`; wire in `transition()` (after the `advancePolicyGeneration`/`journalPolicyReset` block at ~:1250-1253) and in `establishFederation()` (after `journalPolicyReset` at ~:1196); the `overridden` flip inside `transition()`.
- Test: `core/test/source-cascade.test.ts` (new)

**Interfaces:**
- Consumes: Task 2's `memberRows`; existing `SOURCE_TRANSITIONS`, `activatePendingSubscriptions(raw, row)`, `advancePolicyGeneration(raw, sourceId, now)`, `insertAudit(...)`.
- Produces: `cascadeInstanceAction(raw, instanceRow, action: SourceTransitionAction | 'establish', command, now): number` (returns members MOVED).

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

Wire in `transition()` immediately after the existing `advancePolicyGeneration/journalPolicyReset` block (so it runs only when governance/federation/mode changed) — but per spec the trigger is governance-change OR approve:

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

(Import `memberRows` from `../logical/membership.ts`. `insertAudit`'s existing signature — match its parameter names exactly as used at :1256.)
- [ ] **Step 4: Run** cascade suite + FULL core suite (`source-admin-api`, `logical-v3-vertical` must stay green) + `tsc` → PASS.
- [ ] **Step 5: Commit** `core: cascade instance governance to members at both write sites`.

---

### Task 4: Mint rule — inherit from the approved instance

**Files:**
- Modify: `core/src/logical/verification.ts:294-304` (`findOrCreateOriginSource`)
- Test: `core/test/logical-verification.test.ts` (append)

**Interfaces:**
- Consumes: `approvedInstanceFor(raw, memberUrl)` — but verification works over the store tx; call it with the raw db handle it already holds.

- [ ] **Step 1: Failing tests:** (a) minting an origin whose prefix matches an APPROVED allowed instance → born `allowed` even when the ASSERTING aggregate is quarantined (cross-instance echo case); (b) matching approved instance is BLOCKED → born `blocked`; (c) no approved instance → inherits the asserting aggregate's governance (today's behavior, regression-pinned).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** — in `findOrCreateOriginSource`, before the INSERT: `const inst = approvedInstanceFor(tx-or-raw, url); const gov = inst ? inst.governance : assertingGovernance` (keep the existing read of the asserting aggregate's governance at :297 as the fallback).
- [ ] **Step 4: Run** verification suite + full core → PASS. **Step 5: Commit** `core: mint members under their approved instance's governance`.

---

### Task 5: Migration heal (JS data step)

**Files:**
- Modify: `core/src/storage/sqlite.ts` — in `migrate()`, after the migration exec loop, run the heal exactly when the pre-migration `user_version` was < 18.
- Test: `core/test/migrations.test.ts` (append)

- [ ] **Step 1: Failing test:** build a pre-18 DB fixture (in-memory, run migrations 1-17 by slicing MIGRATIONS, seed: approved instance A + hand-approved member (allowed) + stuck member (quarantined) + BLOCKED instance B with a member + two approved same-prefix aggregates C1/C2 with a member), then open through `createSqliteRepository` → assert: all `origin_verification` rows have `overridden = 0`; A's members both `allowed` (marathon forgiven + stuck lifted); B's member governance UNCHANGED (blocked instances excluded); C's member synced to C1 (earliest created_at).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** in `migrate()`:

```ts
  if (fromVersion < 18) {
    // One-time heal (spec 2026-07-25): members adopt their instance NOW.
    raw.prepare(`UPDATE remote_sources_v2 SET overridden = 0 WHERE provenance = 'origin_verification'`).run()
    const instances = raw.prepare(
      `SELECT s.id, s.canonical_url, s.governance FROM remote_sources_v2 s
       JOIN federation_relationships_v2 f ON f.source_id = s.id AND f.status = 'approved'
       WHERE s.governance != 'blocked' ORDER BY s.created_at ASC, s.id ASC`,
    ).all() as { id: string; canonical_url: string; governance: string }[]
    const healed = new Set<string>()
    for (const inst of instances) {
      for (const m of memberRows(raw, inst)) {
        if (healed.has(m.id)) continue // deterministic: earliest instance wins
        healed.add(m.id)
        if (m.governance !== inst.governance) raw.prepare(`UPDATE remote_sources_v2 SET governance = ? WHERE id = ?`).run(inst.governance, m.id)
      }
    }
  }
```

(Capture `fromVersion` = `user_version` BEFORE the exec loop.)
- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `core: one-time member heal at migration 18`.

---

### Task 6: Member read endpoints

**Files:**
- Modify: `core/src/api/app.ts` — two routes inside the `if (sources)` admin block, registered BEFORE `app.get('/admin/sources/:id', ...)` is irrelevant (paths are deeper: `/admin/sources/:id/members`, `/admin/sources/:id/members/counts` — no shadowing), following the `:id/subscriptions` (:370) and `:id/audit` (:376) siblings.
- Modify: `core/src/domain/source-repository.ts` + `core/src/storage/sqlite.ts` — `listSourceMembers(id, cursor, limit): Promise<Page<SourceSummary>>` (reuse the summary mapper over a memberRows-shaped range query with the created_at/id cursor idiom) and `sourceMemberCounts(id): Promise<{ members: number; instanceGoverned: number; overridden: number }>`.
- Test: `core/test/source-admin-api.test.ts` (append)

- [ ] **Step 1: Failing tests:** counts endpoint returns the grouped object for an instance with 3 members (2 instance-governed, 1 overridden); members endpoint pages with the standard cursor; a non-instance id returns empty counts/page (not 404 — same posture as `:id/subscriptions`); both answer 401 anonymous (inherited `/admin/*` gate).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** — routes:

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

`sourceMemberCounts` is one grouped query over the membership range (`SUM(overridden)`, `COUNT(*)`).
- [ ] **Step 4: Run** + full core + tsc → PASS. **Step 5: Commit** `core: member list + counts reads per instance`.

---

### Task 7: Admin UI — members under their instance

**Files:**
- Modify: `web/src/routes/admin/feeds/+page.server.ts` (member exclusion in `groupOf` for `user` AND `review`; map `provenance` + `overridden` into the local `SourceSummary` interface + `toRow`; fetch counts per federated instance row from `/admin/sources/:id/members/counts`)
- Modify: `web/src/routes/admin/feeds/+page.svelte` (roll-up line on instance rows; lazy member expansion via a details element whose content loads from a small `?/members`-style GET link to a subroute OR a `+page.server.ts`-driven `?expand=<id>` query param — pick the no-JS-friendly query param: `?expand=<sourceId>` re-renders the page with that instance's member rows inlined, fetched from `/admin/sources/:id/members`; `overridden` badge; `via verification` hint on non-nested members)
- Test: `web/src/routes/admin/feeds/source-actions.test.ts` (append)

- [ ] **Step 1: Failing tests:** (a) a member row (provenance `origin_verification`, prefix-covered by an approved federated row in the same payload) appears in NEITHER `user` NOR `review` groups; (b) an instance row carries `memberCounts` from the counts fetch; (c) `?expand=<id>` loads member rows for that instance only; (d) a member of a NON-federated host stays in `user` with the hint flag.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** — membership client-side: a row is a member iff `provenance === 'origin_verification'` and some federated (`federationStatus === 'approved'`) row's `scheme://host/` prefix (via `new URL(canonicalUrl)`) prefixes its URL. Exclusion in `groupOf`; counts fetched in parallel (`Promise.all`) for federated rows only; expansion via the query param.
- [ ] **Step 4: Run** web tests + svelte-check + build → PASS. **Step 5: Commit** `web: nest instance members under their instance`.

---

### Task 8: Journey checklist + gates

**Files:**
- Modify: `docs/superpowers/documentation/2026-07-25-user-journey-checklist.md`

- [ ] **Step 1:** Add the row: "Federate an instance → members appear under it (counts match); moderate one member (overridden badge); block the instance (ALL members dark on timeline/byline/publisher — navigation assertions); unblock (members quarantined; overrides NOT restored — V1)."
- [ ] **Step 2:** Full gates: core suite + tsc, web suite + svelte-check + build, all in-container. Expected: green (+ the 2 expected-fail markers).
- [ ] **Step 3:** Commit `docs: journey checklist — instance-governed members row`.

---

## Self-review record

Spec coverage: model (T1/T2), cascade both sites + overridden flip (T3),
mint rule (T4), heal (T5), endpoints (T6), UI incl. review-group exclusion +
hint (T7), journey row (T8); replay pinned in T3 tests; EXPLAIN plan in T2;
the four migrations.test pins in T1. Type consistency: `memberRows` /
`approvedInstanceFor` / `cascadeInstanceAction` names used identically in
T2-T5. No placeholders remain. Plan-level review notes 10-15 folded (range
never LIKE, moved-count semantics, navigation assertions, four pins).

*developed with the help of AI tools*
