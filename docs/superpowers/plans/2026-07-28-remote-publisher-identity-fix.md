# Remote publisher identity fix — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop aggregate-mode remote sources from minting a real, navigable
`feed_anchored` publisher identity for their own instance-level URL (use the
already-defined `source_scoped_fallback` instead, everywhere that mints one),
and give a per-item verification check that raced and lost a second chance
whenever fresh evidence for the same URL arrives, per
`docs/superpowers/specs/2026-07-27-remote-publisher-identity-fix-design.md`
(rev 2).

**Architecture:** Four independently-testable tasks. Task 1 fixes the two
live `getOrCreatePublisher` copies (`reconcile.ts`, `verification.ts`) and
collapses them into one. Task 2 reverses the 2026-07-24 `convert.ts`
adjudication to match. Task 3 migrates existing data to the corrected shape.
Task 4 (fully independent of 1-3) widens the verification batch resolver's
re-check window. Order 1 → 2 → 3 → 4, but 4 could run any time after 1 lands
(it doesn't touch `getOrCreatePublisher` at all) — kept last here only
because it's the least entangled with the identity-modeling change.

**Tech Stack:** Node 22 native type-stripping (no build step — `tsc --noEmit`
is the real compile gate, vitest passes on type errors), better-sqlite3,
vitest.

## Global Constraints

- **Container-only test commands.** `docker compose exec -T core npm run -w core test -- <files>` for vitest; `docker compose exec -T core npm run -w core typecheck` for `tsc --noEmit`. Never invoke `vitest`/`npx vitest` directly — the container's default CWD is `/app` (repo root), which silently drops `$lib`-style config (this bit a different task in this same session; `npm run -w core` always resolves correctly regardless of starting CWD).
- **Baseline (re-verify before Task 1):** run the full core suite and confirm it's green before starting; note the exact file/test counts and `MIGRATIONS.length` (expected 17, but re-verify — this plan was written against a specific point in time).
- **Never `git add -A`** — shared checkout; a parallel session may commit to `main` concurrently. Stage explicit paths.
- **Every task ends with the full core suite green and `tsc --noEmit` clean.**
- **This spec has 2 revisions** — rev 2 reverses a prior, dated, tested adjudication in `convert.ts` (maintainer call, recorded in the spec's header). Task 2 exists specifically to carry that reversal through; do not skip it thinking rev 1's narrower scope still applies.

---

### Task 1: Collapse `getOrCreatePublisher` into one function with an explicit identity level

**Files:**
- Modify: `core/src/logical/reconcile.ts`
- Modify: `core/src/logical/verification.ts`
- Test: `core/test/logical-reconcile.test.ts`, `core/test/logical-verification.test.ts`, `core/test/logical-projector.test.ts`

**Interfaces:**
- Consumes: nothing from another task.
- Produces: `export function getOrCreatePublisher(tx: WriteTx, canonicalUrl: string, identityLevel: 'feed_anchored' | 'source_scoped_fallback', now: string): string` and `function identityLevelFor(attributionMode: string): 'feed_anchored' | 'source_scoped_fallback'`, both in `core/src/logical/reconcile.ts`, both exported (Tasks 2 and 4 don't need `identityLevelFor` directly, but exporting it now costs nothing and Task 2 imports `getOrCreatePublisher`... actually Task 2's `convert.ts` needs its own copy of the `attributionMode → identityLevel` mapping too — export `identityLevelFor` as well so Task 2 imports it instead of re-deriving the mapping).

- [ ] **Step 1: Confirm the baseline**

Run: `docker compose exec -T core npm run -w core test && docker compose exec -T core npm run -w core typecheck`
Record the exact test count and confirm 0 tsc errors.

- [ ] **Step 2: Read `core/src/logical/reconcile.ts` lines 183-197 and 250-260 fresh, confirm they still read as follows before editing**

```typescript
// ponytail: keys on canonical_feed_url and hardcodes feed_anchored, ignoring
// attribution_mode (the accepted §2.4 debt). The V4 cutover now DEPENDS on this
// uniformity — conversion mints the same way (spec §3.2 amendment 2026-07-24) —
// so the eventual §2.4 fix must migrate publisher rows, not just change this
// function.
function getOrCreatePublisher(tx: WriteTx, canonicalUrl: string, now: string): string {
  const r = tx.prepare(`SELECT id FROM remote_publishers_v2 WHERE canonical_feed_url = ?`).get(canonicalUrl) as { id: string } | undefined
  if (r) return r.id
  const id = randomUUID()
  tx.prepare(`INSERT INTO remote_publishers_v2 (id, canonical_feed_url, identity_level, created_at) VALUES (?, ?, 'feed_anchored', ?)`).run(id, canonicalUrl, now)
  return id
}
```
and (further down, inside `reconcileClaim`):
```typescript
  const publisherId = getOrCreatePublisher(tx, source.canonical_url, now)
```
If either has drifted from this shape, stop and re-read the surrounding function before proceeding — the edit below assumes this exact text.

- [ ] **Step 3: Replace the function and its call site in `reconcile.ts`**

Replace the block from Step 2 with:

```typescript
// The §2.4 attribution fix (2026-07-27/28 spec, rev 2): an aggregate source's
// own URL never gets a real navigable identity — only a genuinely-resolved
// per-author URL (via origin verification) does.
function identityLevelFor(attributionMode: string): 'feed_anchored' | 'source_scoped_fallback' {
  return attributionMode === 'aggregate' ? 'source_scoped_fallback' : 'feed_anchored'
}

export function getOrCreatePublisher(tx: WriteTx, canonicalUrl: string, identityLevel: 'feed_anchored' | 'source_scoped_fallback', now: string): string {
  const r = tx.prepare(`SELECT id FROM remote_publishers_v2 WHERE canonical_feed_url = ?`).get(canonicalUrl) as { id: string } | undefined
  if (r) return r.id
  const id = randomUUID()
  tx.prepare(`INSERT INTO remote_publishers_v2 (id, canonical_feed_url, identity_level, created_at) VALUES (?, ?, ?, ?)`).run(id, canonicalUrl, identityLevel, now)
  return id
}
```

And change the call site to:

```typescript
  const publisherId = getOrCreatePublisher(tx, source.canonical_url, identityLevelFor(source.attribution_mode), now)
```

Also export `identityLevelFor` (add `export` to its declaration above) — Task 2 imports it.

- [ ] **Step 4: Read `core/src/logical/verification.ts` lines 255-320 fresh, confirm the duplicate copy and its call site still read as follows**

```typescript
    if (originSourceId === null) {
      originSourceId = findOrCreateOriginSource(tx, batchKey, check.source_id, now)
      originPublisherId = getOrCreatePublisher(tx, batchKey, now)
    }
```
and, further down:
```typescript
// find-or-create a publisher by canonical feed url (mirrors reconcile.ts).
function getOrCreatePublisher(tx: WriteTx, canonicalUrl: string, now: string): string {
  const r = tx.prepare(`SELECT id FROM remote_publishers_v2 WHERE canonical_feed_url = ?`).get(canonicalUrl) as { id: string } | undefined
  if (r) return r.id
  const id = randomUUID()
  tx.prepare(`INSERT INTO remote_publishers_v2 (id, canonical_feed_url, identity_level, created_at) VALUES (?, ?, 'feed_anchored', ?)`).run(id, canonicalUrl, now)
  return id
}
```

- [ ] **Step 5: Delete verification.ts's duplicate, import the shared one, fix the call site**

Delete the entire `function getOrCreatePublisher(...) { ... }` block (with its "mirrors reconcile.ts" comment) from `verification.ts`.

Change the import line (currently `import { applyPresentation, applySelectionHints, recordReconciliationFailure } from './reconcile.ts'`) to:

```typescript
import { applyPresentation, applySelectionHints, getOrCreatePublisher, recordReconciliationFailure } from './reconcile.ts'
```

Change the call site to:

```typescript
      originPublisherId = getOrCreatePublisher(tx, batchKey, 'feed_anchored', now)
```

(literal `'feed_anchored'` — this call is always for a freshly found/created `single_publisher` origin source, never an aggregate; see the spec's "No collision risk" note.)

- [ ] **Step 6: Typecheck**

Run: `docker compose exec -T core npm run -w core typecheck`
Expected: 0 errors. If `reconcile.ts` or `verification.ts` have other callers of the now-two-argument-longer `getOrCreatePublisher`, this is where it surfaces — there should be none besides the two fixed above (confirm with `grep -rn "getOrCreatePublisher" core/src` — expect exactly 3 hits: the definition, `reconcile.ts`'s call, `verification.ts`'s call).

- [ ] **Step 7: Add the identity_level minting test to `core/test/logical-reconcile.test.ts`**

Read the file's existing imports and `fresh()`/`seedSource()`-style helpers first (follow its own conventions — don't invent a new pattern). Add:

```typescript
test('getOrCreatePublisher mints source_scoped_fallback for an aggregate source, feed_anchored for single_publisher', async () => {
  const { raw, db, store } = await fresh()
  seedSource(raw, 's_agg', 'https://instance.test/users/rss.xml', { mode: 'aggregate' })
  seedSource(raw, 's_bound', 'https://blog.test/feed.xml', { mode: 'single_publisher' })
  await acquire(db, raw, 's_agg', 'https://instance.test/users/rss.xml', RSS(guidItem('g-agg')))
  await acquire(db, raw, 's_bound', 'https://blog.test/feed.xml', RSS(guidItem('g-bound')))
  drainReconciliation({ store, now: () => NOW })
  const aggPub = raw.prepare(`SELECT identity_level FROM remote_publishers_v2 WHERE canonical_feed_url = ?`).get('https://instance.test/users/rss.xml') as { identity_level: string }
  const boundPub = raw.prepare(`SELECT identity_level FROM remote_publishers_v2 WHERE canonical_feed_url = ?`).get('https://blog.test/feed.xml') as { identity_level: string }
  expect(aggPub.identity_level).toBe('source_scoped_fallback')
  expect(boundPub.identity_level).toBe('feed_anchored')
})
```

Adjust the exact helper names/signatures (`fresh`, `seedSource`, `acquire`, `RSS`, `guidItem`, `drainReconciliation`) to match what the file actually exports/uses — read it first, this snippet mirrors the shape used in `logical-verification.test.ts`, which has the closest equivalent setup.

- [ ] **Step 8: Add the verification-mint test to `core/test/logical-verification.test.ts`**

Near the existing `'containment match by opaque id → check verified + a direct-origin verified_origin author under a find-or-created source'` test, add:

```typescript
test('a verified origin source always gets feed_anchored, even though the aggregate that asserted it does not', async () => {
  const { raw, db, store } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f', { mode: 'aggregate' })
  await acquire(db, raw, 's_agg', 'https://agg.test/f', RSS(guidItem('g1', ORIGIN)))
  const cf = countingFetch({ [ORIGIN]: () => ok(RSS(guidItem('g1'))) })
  const runner = createVerificationRunner({ db, store, fetchFn: cf.fn, lookupFn: publicLookup, now: () => NOW })
  await drainReconciliationAsync({ store, now: () => NOW, runVerificationBatch: (i) => runner.runVerificationBatch(i.claim, i.now) })
  const aggPub = raw.prepare(`SELECT identity_level FROM remote_publishers_v2 WHERE canonical_feed_url = 'https://agg.test/f'`).get() as { identity_level: string }
  const originPub = raw.prepare(`SELECT identity_level FROM remote_publishers_v2 WHERE canonical_feed_url = ?`).get(ORIGIN) as { identity_level: string }
  expect(aggPub.identity_level).toBe('source_scoped_fallback')
  expect(originPub.identity_level).toBe('feed_anchored')
})
```

- [ ] **Step 9: Add the projector-gate guard test to `core/test/logical-projector.test.ts`**

Read the file's existing test for `resolvePublisher`/publisher-page navigability first (search for `identityLevel` or `resolvePublisher`) to match its fixture style, then add a sibling test asserting that a `source_scoped_fallback` publisher is refused:

```typescript
test('resolvePublisher refuses a source_scoped_fallback publisher — no publisher page for an unresolved aggregate identity', async () => {
  const { raw, db } = await fresh()
  const pub = 'pub-fallback'
  raw.prepare(`INSERT INTO remote_publishers_v2 (id, canonical_feed_url, identity_level, created_at) VALUES (?, ?, 'source_scoped_fallback', ?)`).run(pub, 'https://instance.test/users/rss.xml', NOW)
  const result = db.read((tx) => resolvePublisher(tx, pub))
  expect(result).toBeUndefined()
})
```

Adjust `fresh`/`resolvePublisher`'s import path and any required seed rows (e.g. an allowed-governance `publisher_claims_v2` row is NOT needed here since the function returns `undefined` before reaching that check for a non-`feed_anchored` row — verify this by reading `resolvePublisher`'s exact current body, `core/src/logical/projector.ts:645-654`, before writing the test, in case it has shifted).

- [ ] **Step 10: Run the full core suite**

Run: `docker compose exec -T core npm run -w core test && docker compose exec -T core npm run -w core typecheck`
Expected: 0 tsc errors, all tests pass, test count up by 3 from the Step 1 baseline.

- [ ] **Step 11: Commit**

```bash
git add core/src/logical/reconcile.ts core/src/logical/verification.ts core/test/logical-reconcile.test.ts core/test/logical-verification.test.ts core/test/logical-projector.test.ts
git commit -m "core: aggregate sources mint source_scoped_fallback, not feed_anchored

getOrCreatePublisher collapses from two independent copies (reconcile.ts,
verification.ts) into one, exported from reconcile.ts, taking an explicit
identity level instead of hardcoding feed_anchored. reconcile.ts's own call
site now derives it from the source's attribution_mode (identityLevelFor);
verification.ts's call site stays feed_anchored literally, since it only
ever runs for a freshly-verified single_publisher origin source. Closes
the ponytail: comment above the old function.

developed with the help of AI tools"
```

---

### Task 2: Reverse the `convert.ts` adjudication to match

**Files:**
- Modify: `core/src/migration/convert.ts`
- Test: `core/test/migration-convert.test.ts`

**Interfaces:**
- Consumes: `identityLevelFor` exported from `core/src/logical/reconcile.ts` (Task 1).
- Produces: `convert.ts` mints publishers with the same identity-level rule as live reconcile, and skips `handle_reservations_v2` for aggregate sources.

- [ ] **Step 1: Confirm Task 1 landed**

Run: `docker compose exec -T core npm run -w core test`
Expected: green, at Task 1's ending count.

- [ ] **Step 2: Read `core/src/migration/convert.ts` lines 268-308 fresh, confirm they still read as follows**

```typescript
    // Same ID as the legacy user row (spec §3.1) — every existing /post/:id
    // and admin reference keeps resolving across cutover.
    tx.prepare(
      `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, policy_generation, created_at)
       VALUES (?, ?, ?, 'enabled', ?, 'migration', ?, 0, 0, ?)`,
    ).run(row.id, canonicalUrl, mode, governance, note, now)

    // A NEW publisher identity per source — never the recycled user id
    // (foundation §12) — minted EXACTLY as reconcile.ts's getOrCreatePublisher
    // mints one: keyed on canonical_feed_url alone, identity_level
    // 'feed_anchored', for aggregates too.
    //
    // ADJUDICATED 2026-07-24 (spec §3.2 dated note). §3.2 asks for
    // 'source_scoped_fallback' on aggregates, but §3.6 gives a publisher page
    // only to feed-anchored publishers, and projector.ts's resolvePublisher
    // implements §3.6 faithfully — so a fallback row is one no reader will
    // serve, and §3.5's PERMANENT /u/:handle -> /p/:publisherId redirect would
    // point at a 404. §3.6 governs, because it is what every reader depends on.
    // Keying identically also means the first post-cutover reconcile FINDS this
    // row instead of minting a second identity beside it and forking the items.
    // V4 preserves; it does not reform live publisher semantics — §2.4
    // attribution stays recorded, accepted debt, and now inherits a single
    // uniform population to migrate rather than two regimes to reconcile.
    const publisherId = randomUUID()
    tx.prepare(
      `INSERT INTO remote_publishers_v2 (id, canonical_feed_url, identity_level, created_at) VALUES (?, ?, 'feed_anchored', ?)`,
    ).run(publisherId, canonicalUrl, now)
    converted.set(row.id, { publisherId, mode, canonicalUrl })

    if (federation) {
      tx.prepare(
        `INSERT INTO federation_relationships_v2 (source_id, status, provenance_note, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(row.id, federation, note, now, now)
    }

    // The permanent impersonation guard (spec §3.5). NO foreign keys by design:
    // the reservation outlives source removal and purge.
    tx.prepare(
      `INSERT INTO handle_reservations_v2 (handle, source_id, publisher_id, created_at) VALUES (?, ?, ?, ?)`,
    ).run(row.handle, row.id, publisherId, now)
```

If this has drifted, stop and re-read before editing.

- [ ] **Step 3: Add the import**

At the top of `convert.ts`, add `identityLevelFor` to an existing or new import from `reconcile.ts`. There's currently no import from `'../logical/reconcile.ts'` in this file (confirm with `grep -n "from '../logical/reconcile" core/src/migration/convert.ts` — expect no output before this step) — add a new line near the other `../logical/*` imports:

```typescript
import { identityLevelFor } from '../logical/reconcile.ts'
```

- [ ] **Step 4: Replace the publisher mint and reservation block**

Replace the block quoted in Step 2 (from the `// A NEW publisher identity per source` comment through the `handle_reservations_v2` insert) with:

```typescript
    // A NEW publisher identity per source — never the recycled user id
    // (foundation §12) — minted with the SAME identity-level rule live
    // reconcile uses (identityLevelFor), keyed on canonical_feed_url alone so
    // the first post-cutover reconcile FINDS this row instead of minting a
    // second identity beside it and forking the items.
    //
    // REVERSED 2026-07-28 (spec rev 2, maintainer call): the 2026-07-24
    // adjudication kept this feed_anchored for aggregates too, specifically
    // to protect a permanent handle-reservation redirect from 404ing. That
    // protection is no longer worth it — the class of URL it protected (a
    // bookmarked v1-era link to a whole federated instance's pseudo-profile)
    // is vanishingly unlikely to matter on any of these instances, converted
    // or not, this early in the project. Aggregates now mint
    // source_scoped_fallback here too, matching live reconcile, and get NO
    // handle reservation — there is no real identity to permanently protect a
    // redirect for.
    const identityLevel = identityLevelFor(mode)
    const publisherId = randomUUID()
    tx.prepare(
      `INSERT INTO remote_publishers_v2 (id, canonical_feed_url, identity_level, created_at) VALUES (?, ?, ?, ?)`,
    ).run(publisherId, canonicalUrl, identityLevel, now)
    converted.set(row.id, { publisherId, mode, canonicalUrl })

    if (federation) {
      tx.prepare(
        `INSERT INTO federation_relationships_v2 (source_id, status, provenance_note, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(row.id, federation, note, now, now)
    }

    // The permanent impersonation guard (spec §3.5). NO foreign keys by design:
    // the reservation outlives source removal and purge. Skipped for an
    // aggregate's source_scoped_fallback identity — resolvePublisher refuses
    // anything that isn't feed_anchored, so a reservation pointing at one
    // would back an unreachable redirect from the moment it's created.
    if (identityLevel === 'feed_anchored') {
      tx.prepare(
        `INSERT INTO handle_reservations_v2 (handle, source_id, publisher_id, created_at) VALUES (?, ?, ?, ?)`,
      ).run(row.handle, row.id, publisherId, now)
    }
```

- [ ] **Step 5: Typecheck**

Run: `docker compose exec -T core npm run -w core typecheck`
Expected: 0 errors.

- [ ] **Step 6: Update the two pinned tests in `migration-convert.test.ts`**

Read `core/test/migration-convert.test.ts` around lines 119-133 (test `'an unconfirmed instance is quarantined, aggregate, and federation pending'`) fresh — confirm the exact current assertion before editing (line numbers may have shifted since this plan was written; find by the test name, not the number). Change:

```typescript
  // ADJUDICATED (2026-07-24): an aggregate's publisher is feed_anchored on the
  // source's canonical URL too — §3.6 governs over §3.2, see the convergence
  // test at the foot of this file.
  expect(raw.prepare(`SELECT * FROM remote_publishers_v2`).get()).toMatchObject({ canonical_feed_url: 'https://a.test/feed.xml', identity_level: 'feed_anchored' })
```

to:

```typescript
  // REVERSED 2026-07-28 (spec rev 2): an aggregate's publisher is now
  // source_scoped_fallback, matching live reconcile — see the convergence
  // test at the foot of this file, also updated.
  expect(raw.prepare(`SELECT * FROM remote_publishers_v2`).get()).toMatchObject({ canonical_feed_url: 'https://a.test/feed.xml', identity_level: 'source_scoped_fallback' })
  expect(count(raw, 'handle_reservations_v2')).toBe(0)
```

(confirm `count` is already imported/defined in this test file — it's used elsewhere in the same file per the earlier grep of this file; if the helper has a different name, use that instead.)

- [ ] **Step 7: Update the convergence test at the foot of the file**

Find the test `'a converted AGGREGATE source reconciles onto its converted publisher — zero new mints'` (search by name, current line ~309). Read its full current body fresh. Change the `expect(minted)` line and the header comment above the test:

```typescript
// ── post-cutover convergence with the live reconcile ─────────────────────
// The permanent pin for the 2026-07-28 reversal (spec rev 2). reconcile.ts's
// getOrCreatePublisher finds-or-creates by `canonical_feed_url` alone and
// mints identityLevelFor(attribution_mode); conversion mints on exactly that
// key with the same rule, so the FIRST post-cutover reconcile of a converted
// source finds the converted row instead of minting a second identity beside
// it (which would fork the items and make the FIRST reconcile drift from
// the identity conversion chose).

test('a converted AGGREGATE source reconciles onto its converted publisher — zero new mints', async () => {
  const raw = await fresh()
  seedRemote(raw, { feed_type: 'instance' }) // quarantined aggregate: the §3.2 fallback case
  convert(raw)
  const minted = raw.prepare(`SELECT id, canonical_feed_url, identity_level FROM remote_publishers_v2`).get() as { id: string; canonical_feed_url: string | null; identity_level: string }
  expect(minted).toMatchObject({ canonical_feed_url: 'https://a.test/feed.xml', identity_level: 'source_scoped_fallback' })
```

Leave the rest of the test body (the live-path acquire/drain/reconcile section and its final assertions) unchanged — it already asserts the row count stays 1 and the SAME `minted.id` is reused, which is exactly what should still hold true (a `source_scoped_fallback` row is still found-then-reused by `getOrCreatePublisher`'s `SELECT ... WHERE canonical_feed_url = ?` lookup — the identity level only matters at INSERT time, Task 1 confirmed this).

- [ ] **Step 8: Search for any other test asserting the old `feed_anchored`-for-aggregates behavior in this file**

Run: `grep -n "feed_anchored\|handle_reservations_v2" core/test/migration-convert.test.ts`
For each hit, read it in context — the two above are the ones this plan knows about from the spec's own tracing, but re-verify none of the OTHER hits (e.g. the `single_publisher` manifest-override test at line ~158-169, which should stay `feed_anchored` since it's not an aggregate) need changing. Only aggregate-mode assertions change; `single_publisher` ones (including the manifest-conflict-resolution test that ends up `single_publisher`) stay exactly as they are.

- [ ] **Step 9: Run the full core suite**

Run: `docker compose exec -T core npm run -w core test && docker compose exec -T core npm run -w core typecheck`
Expected: 0 tsc errors, all tests pass (no test-count change — these are edits to existing assertions, not new/deleted tests).

- [ ] **Step 10: Commit**

```bash
git add core/src/migration/convert.ts core/test/migration-convert.test.ts
git commit -m "core: convert.ts mints source_scoped_fallback for aggregates too

Reverses the 2026-07-24 adjudication that kept legacy-converted aggregate
publishers feed_anchored everywhere, specifically to protect a permanent
handle-reservation redirect from 404ing. That protection guarded a class of
URL (a bookmarked v1-era link to a whole federated instance's pseudo-profile)
unlikely to matter this early in the project (maintainer call, spec rev 2).
convert.ts now uses the same identityLevelFor rule live reconcile does, and
skips the handle reservation entirely for an aggregate's fallback identity --
there's no real identity there to permanently protect a redirect for.

developed with the help of AI tools"
```

---

### Task 3: Migrate existing data to the corrected shape

**Files:**
- Modify: `core/src/logical/schema.ts`
- Modify: `core/src/storage/sqlite.ts`
- Test: `core/test/migrations.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1-2 (this is a pure data migration; Tasks 1-2 only govern what happens for freshly-inserted rows going forward).
- Produces: migration 18 (assuming the baseline in Step 1 confirms 17 is still current), relabeling existing aggregate-source publisher rows and deleting stale reservations pointing at them.

- [ ] **Step 1: Confirm Task 2 landed and re-verify the current `MIGRATIONS.length`**

Run: `docker compose exec -T core npm run -w core test`
Then read `core/test/migrations.test.ts` and confirm the four `toBe(17)` pins (search `grep -n "toBe(17)" core/test/migrations.test.ts` — expect 4 hits; if the number isn't 17 anymore, someone else added a migration since this plan was written — use THAT number + 1 everywhere below instead of 18).

- [ ] **Step 2: Add the new migration array to `core/src/logical/schema.ts`**

Read the file's tail (around `LOGICAL_PERF_INDEXES_2`'s closing `]`, currently ~line 370) fresh to confirm the exact insertion point, then add immediately after it (before the `assertHandleUnreserved` section):

```typescript
// Aggregate-publisher identity fix (2026-07-27/28 spec, rev 2). ONE migration
// entry, appended strictly at the TAIL of MIGRATIONS in sqlite.ts, AFTER
// LOGICAL_PERF_INDEXES_2 — mid-array insertion corrupts user_version on live
// databases. Pure data UPDATE/DELETE, no DDL, no table rebuilt.
//
// Relabels every aggregate source's publisher row from feed_anchored (wrong
// — it represents a whole instance, not a person) to source_scoped_fallback,
// and deletes any handle_reservations_v2 row left pointing at one of those
// rows (a reservation whose target the projector will now refuse to resolve
// protects nothing by lingering). Reverses the 2026-07-24 convert.ts
// adjudication (spec rev 2, maintainer call) — see convert.ts's own updated
// comment for why. Idempotent: a second run of either statement no-ops.
export const AGGREGATE_PUBLISHER_IDENTITY_FIX: string[] = [
  `UPDATE remote_publishers_v2
   SET identity_level = 'source_scoped_fallback'
   WHERE identity_level = 'feed_anchored'
     AND canonical_feed_url IN (SELECT canonical_url FROM remote_sources_v2 WHERE attribution_mode = 'aggregate')`,
  `DELETE FROM handle_reservations_v2
   WHERE publisher_id IN (
     SELECT id FROM remote_publishers_v2
     WHERE identity_level = 'source_scoped_fallback'
       AND canonical_feed_url IN (SELECT canonical_url FROM remote_sources_v2 WHERE attribution_mode = 'aggregate')
   )`,
]
```

- [ ] **Step 3: Wire it into `MIGRATIONS` in `core/src/storage/sqlite.ts`**

Read the file's import line for `schema.ts` (currently `import { LOGICAL_V2_SCHEMA, LOGICAL_V3_SCHEMA, LOGICAL_V4_SCHEMA, LOGICAL_PERF_INDEXES, LOGICAL_PERF_INDEXES_2, assertHandleUnreserved } from '../logical/schema.ts'`) and add `AGGREGATE_PUBLISHER_IDENTITY_FIX` to it. Read the `MIGRATIONS` array's tail (currently ending `LOGICAL_PERF_INDEXES_2,\n]`) fresh, then append:

```typescript
  // Aggregate-publisher identity fix (migration #18). Appended at the TAIL,
  // AFTER LOGICAL_PERF_INDEXES_2 — mid-array insertion corrupts user_version
  // on live databases. Pure data UPDATE/DELETE, no DDL. Defined in
  // logical/schema.ts; see the 2026-07-27/28 spec rev 2.
  AGGREGATE_PUBLISHER_IDENTITY_FIX,
```

(If Step 1 found the baseline isn't 17, adjust the "#18" comment number accordingly — the comment is documentation, not load-bearing, but should be accurate.)

- [ ] **Step 4: Typecheck**

Run: `docker compose exec -T core npm run -w core typecheck`
Expected: 0 errors.

- [ ] **Step 5: Update the four `MIGRATIONS.length` pins in `core/test/migrations.test.ts`**

Run `grep -n "toBe(17)" core/test/migrations.test.ts` and change each of the 4 matches to `toBe(18)` (or whatever Step 1 determined). Read each one in its full test context first — they're plain `expect(...).toBe(17)` assertions, not part of a larger structure that needs other changes.

- [ ] **Step 6: Export `MIGRATIONS` for test use**

Every existing migration test in `core/test/migrations.test.ts` (e.g. `'a version-1 database upgrades in place to version 2 with data preserved'`, `'migration 11: ...'`) hand-replicates the OLD schema as a small literal SQL array (`V1_SCHEMA`, `V10_SCHEMA`, etc.), because those migrations transitioned FROM the original, small v1 schema — worth hand-writing once. Migration 18 transitions from the CURRENT, already-large v2/v3/v4 schema (dozens of tables) to itself plus one data fix — hand-replicating that whole schema would be enormous and duplicate what `MIGRATIONS` already encodes correctly. Use the real array instead: change `const MIGRATIONS: string[][] = [` in `core/src/storage/sqlite.ts` to `export const MIGRATIONS: string[][] = [`.

- [ ] **Step 7: Write the migration's own test**

Add to `core/test/migrations.test.ts`. Add `MIGRATIONS` to the file's existing import from `'../src/storage/sqlite.ts'` (currently `import { createSqliteRepository } from '../src/storage/sqlite.ts'`):

```typescript
import { createSqliteRepository, MIGRATIONS } from '../src/storage/sqlite.ts'
```

```typescript
test('migration 18 relabels an aggregate source publisher and drops its stale handle reservation', async () => {
  // Build a DB at user_version 17 using the REAL first-17 migrations (not a
  // hand-replicated schema — the current v2/v3/v4 schema is too large to
  // duplicate by hand, unlike the small v1-era schemas the older tests in
  // this file replicate), then seed the exact shape a real 2026-07-24-era
  // legacy conversion produced: an aggregate source, its feed_anchored
  // publisher, and a handle_reservations_v2 row pointing at it.
  const file = tempDb()
  const raw = new Database(file)
  for (const stmt of MIGRATIONS.slice(0, 17).flat()) raw.exec(stmt)
  raw.pragma('user_version = 17')
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, policy_generation, created_at)
     VALUES ('s1', 'https://instance.test/users/rss.xml', 'aggregate', 'enabled', 'quarantined', 'migration', NULL, 0, 0, '2026-01-01T00:00:00.000Z')`,
  ).run()
  raw.prepare(
    `INSERT INTO remote_publishers_v2 (id, canonical_feed_url, identity_level, created_at) VALUES ('p1', 'https://instance.test/users/rss.xml', 'feed_anchored', '2026-01-01T00:00:00.000Z')`,
  ).run()
  raw.prepare(
    `INSERT INTO handle_reservations_v2 (handle, source_id, publisher_id, created_at) VALUES ('theinstance', 's1', 'p1', '2026-01-01T00:00:00.000Z')`,
  ).run()
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, policy_generation, created_at)
     VALUES ('s2', 'https://blog.test/feed.xml', 'single_publisher', 'enabled', 'allowed', 'migration', NULL, 0, 0, '2026-01-01T00:00:00.000Z')`,
  ).run()
  raw.prepare(
    `INSERT INTO remote_publishers_v2 (id, canonical_feed_url, identity_level, created_at) VALUES ('p2', 'https://blog.test/feed.xml', 'feed_anchored', '2026-01-01T00:00:00.000Z')`,
  ).run()
  raw.prepare(
    `INSERT INTO handle_reservations_v2 (handle, source_id, publisher_id, created_at) VALUES ('blogger', 's2', 'p2', '2026-01-01T00:00:00.000Z')`,
  ).run()
  raw.close()

  // Re-open through the real repository constructor, which runs migrate()
  // from version 17 up to current (18).
  const repo = await createSqliteRepository(file)
  expect(repo.raw.pragma('user_version', { simple: true })).toBe(18)
  expect((repo.raw.prepare(`SELECT identity_level FROM remote_publishers_v2 WHERE id = 'p1'`).get() as { identity_level: string }).identity_level).toBe('source_scoped_fallback')
  expect(repo.raw.prepare(`SELECT 1 FROM handle_reservations_v2 WHERE publisher_id = 'p1'`).get()).toBeUndefined()
  // single_publisher untouched
  expect((repo.raw.prepare(`SELECT identity_level FROM remote_publishers_v2 WHERE id = 'p2'`).get() as { identity_level: string }).identity_level).toBe('feed_anchored')
  expect(repo.raw.prepare(`SELECT 1 FROM handle_reservations_v2 WHERE publisher_id = 'p2'`).get()).toBeTruthy()
})
```

Before writing this, read `core/src/logical/schema.ts`'s actual `remote_sources_v2`/`remote_publishers_v2`/`handle_reservations_v2` `CREATE TABLE` statements (in `LOGICAL_V2_SCHEMA`/`LOGICAL_V4_SCHEMA`) to confirm every column named above (`policy_generation`, `admin_retained`, etc.) is exactly right and no `NOT NULL` column is missing from these `INSERT`s — the snippet above mirrors `convert.ts`'s own real `INSERT` shapes (read earlier in this task), but re-verify against the live schema, not this plan, before running it.

- [ ] **Step 8: Run the full core suite**

Run: `docker compose exec -T core npm run -w core test && docker compose exec -T core npm run -w core typecheck`
Expected: 0 tsc errors, all tests pass, test count up by 1 from Task 2's ending count.

- [ ] **Step 9: Commit**

```bash
git add core/src/logical/schema.ts core/src/storage/sqlite.ts core/test/migrations.test.ts
git commit -m "core: migrate existing aggregate publisher rows to source_scoped_fallback

Migration 18: relabels every aggregate source's publisher row from
feed_anchored to source_scoped_fallback, and deletes any
handle_reservations_v2 row left pointing at one -- a reservation whose
target the projector now refuses to resolve protects nothing by lingering.
Pure data UPDATE/DELETE, no DDL, idempotent. Companion to the reversed
convert.ts adjudication (prior commit).

developed with the help of AI tools"
```

---

### Task 4: Opportunistic re-adoption — widen the verification re-check window

**Files:**
- Modify: `core/src/logical/verification.ts`
- Test: `core/test/logical-verification.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1-3 (independent; could run any time after Task 1, listed last only for narrative ordering).
- Produces: no new exported symbols — `resolveVerificationBatch`'s internal query widens, behavior-visible only through its existing effects (checks flip state, items get re-attributed).

- [ ] **Step 1: Confirm Task 3 landed**

Run: `docker compose exec -T core npm run -w core test`
Expected: green, at Task 3's ending count.

- [ ] **Step 2: Read `resolveVerificationBatch`'s check query fresh (currently `verification.ts:249`)**

```typescript
  const checks = tx.prepare(`SELECT id, logical_item_id, source_id FROM verification_checks_v2 WHERE batch_key = ? AND state = 'pending'`).all(batchKey) as { id: string; logical_item_id: string; source_id: string }[]
```

If this has drifted, re-read the surrounding function before editing.

- [ ] **Step 3: Widen it**

Replace with:

```typescript
  const checks = tx.prepare(`SELECT id, logical_item_id, source_id FROM verification_checks_v2 WHERE batch_key = ? AND state IN ('pending', 'unverified')`).all(batchKey) as { id: string; logical_item_id: string; source_id: string }[]
```

Nothing else in the function needs to change — every check in the widened set flows through the same existing loop (`matchContainment`, then either `persistVerifiedDelivery` on a match or the existing `UPDATE verification_checks_v2 SET state = 'unverified', resolved_at = ?` on a miss, which already correctly bumps `resolved_at` to the retry time — the spec's open question about `resolved_at` resolves itself this way, since the no-match branch is unconditional and doesn't distinguish a check's prior state).

- [ ] **Step 4: Typecheck**

Run: `docker compose exec -T core npm run -w core typecheck`
Expected: 0 errors (this is a pure SQL-string change, should be a no-op for types, but run it anyway).

- [ ] **Step 5: Write the money test — replaying the real dev-data shape**

Add to `core/test/logical-verification.test.ts`, near the other `resolveVerificationBatch` outcome tests (using the same `seedCheck`/`fetched`/`evidenceFor` helpers already in the file):

```typescript
test('a previously-terminal unverified check gets re-matched and promoted when a later batch fetch for the same URL succeeds', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f')
  // First fetch for this URL doesn't contain li-1's guid (a timing race, the
  // real dev-data shape: the post hadn't propagated to the author's own feed
  // yet) -> terminal unverified.
  const jobId1 = seedCheck(raw, { itemId: 'li-1', sourceId: 's_agg', batchKey: ORIGIN, guid: 'g1' })
  store.resolveVerificationBatch({ claim: { kind: 'verification', jobId: jobId1, batchKey: ORIGIN }, outcome: fetched([evidenceFor({ guid: 'g-other' })]), now: NOW })
  expect((raw.prepare(`SELECT state FROM verification_checks_v2 WHERE logical_item_id = 'li-1'`).get() as { state: string }).state).toBe('unverified')

  // A second item asserts the same origin URL; this fetch DOES contain g1 ->
  // li-1 (previously stuck) should ALSO get promoted, not just li-2.
  const LATER = '2026-07-24T01:00:00.000Z'
  const jobId2 = seedCheck(raw, { itemId: 'li-2', sourceId: 's_agg', batchKey: ORIGIN, guid: 'g2' })
  store.resolveVerificationBatch({ claim: { kind: 'verification', jobId: jobId2, batchKey: ORIGIN }, outcome: fetched([evidenceFor({ guid: 'g1' }), evidenceFor({ guid: 'g2' })]), now: LATER })

  expect((raw.prepare(`SELECT state FROM verification_checks_v2 WHERE logical_item_id = 'li-1'`).get() as { state: string }).state).toBe('verified')
  expect(count(raw, 'publisher_claims_v2', "WHERE logical_item_id = 'li-1' AND evidence_level = 'verified_origin'")).toBe(1)
  expect((raw.prepare(`SELECT state FROM verification_checks_v2 WHERE logical_item_id = 'li-2'`).get() as { state: string }).state).toBe('verified')
})
```

- [ ] **Step 6: Write the no-regression test**

```typescript
test('a still-non-matching previously-unverified check stays unverified after an unrelated batch re-run', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f')
  const jobId1 = seedCheck(raw, { itemId: 'li-1', sourceId: 's_agg', batchKey: ORIGIN, guid: 'g1' })
  store.resolveVerificationBatch({ claim: { kind: 'verification', jobId: jobId1, batchKey: ORIGIN }, outcome: fetched([evidenceFor({ guid: 'g-other' })]), now: NOW })
  expect((raw.prepare(`SELECT state FROM verification_checks_v2 WHERE logical_item_id = 'li-1'`).get() as { state: string }).state).toBe('unverified')

  // A second batch fetch for the SAME url, still without g1's content.
  const jobId2 = seedCheck(raw, { itemId: 'li-2', sourceId: 's_agg', batchKey: ORIGIN, guid: 'g2' })
  store.resolveVerificationBatch({ claim: { kind: 'verification', jobId: jobId2, batchKey: ORIGIN }, outcome: fetched([evidenceFor({ guid: 'g2' })]), now: NOW })

  expect((raw.prepare(`SELECT state FROM verification_checks_v2 WHERE logical_item_id = 'li-1'`).get() as { state: string }).state).toBe('unverified')
  expect(count(raw, 'publisher_claims_v2', "WHERE logical_item_id = 'li-1'")).toBe(0)
})
```

- [ ] **Step 7: Run the targeted file, then the full suite**

Run: `docker compose exec -T core npm run -w core test -- logical-verification.test.ts`
Expected: all pass, including the 2 new tests.
Then: `docker compose exec -T core npm run -w core test && docker compose exec -T core npm run -w core typecheck`
Expected: 0 tsc errors, all tests pass, test count up by 2 from Task 3's ending count.

- [ ] **Step 8: Commit**

```bash
git add core/src/logical/verification.ts core/test/logical-verification.test.ts
git commit -m "core: re-check previously-unverified verification checks on a fresh batch fetch

resolveVerificationBatch widens its check query from state = 'pending' to
state IN ('pending', 'unverified') -- a terminal unverified check (a per-item
containment miss, often a timing race against the author's own feed) gets a
real second look whenever a later batch fetch succeeds for the same URL,
through the exact same matchContainment/persistVerifiedDelivery path a
first-pass match uses. Fixes the exact shape found in live data: 57 of 58
items sharing an aggregate's stray publisher self-corrected via verification,
1 raced and lost with no way back until now.

developed with the help of AI tools"
```

---

## Final verification (after all 4 tasks)

- [ ] `docker compose exec -T core npm run -w core test` — full suite green, report the real final count.
- [ ] `docker compose exec -T core npm run -w core typecheck` — 0 errors.
- [ ] `grep -rn "getOrCreatePublisher" core/src` — exactly 3 hits (the one definition in `reconcile.ts`, its call in `reconcile.ts`, its call in `verification.ts`); zero remaining duplicate copies.
- [ ] `grep -n "identity_level.*feed_anchored'" core/src/migration/convert.ts` — no hits (the hardcoded literal is gone, replaced by `identityLevelFor(mode)`).
- [ ] Manual smoke (mirrors the dev-DB investigation this spec started from): federate a fresh aggregate-mode instance in the running dev stack, confirm its own publisher row mints `source_scoped_fallback` (`SELECT identity_level FROM remote_publishers_v2 WHERE canonical_feed_url = '<the instance's own firehose URL>'`), and that a byline for an item still awaiting verification renders as plain (non-linked) text rather than a link to a fake instance-wide profile page.

*developed with the help of AI tools*
