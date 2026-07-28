# Scalable Ingest Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the poll scheduler's feed count structurally unable to starve HTTP request handling, at any catalog size, with every scaling knob operator-tunable via env vars rather than hardcoded — plus a startup self-heal for `acquisition_runs_v2` rows orphaned by a past process restart.

**Architecture:** Replace the scheduler's strict-serial "attempt every schedulable source every tick" loop with a self-pacing batch size (derived from an operator-declared target cycle time, not a feed count) dispatched through a bounded-concurrency pool with a per-host cap, fed by a new staleness-ordered, index-backed SQL query. A startup heal terminalizes any `acquisition_runs_v2` row still `processing` from before this boot — certain to be orphaned since the in-process in-flight guard starts empty every process start.

**Tech Stack:** Node.js (native type stripping, no build step), Hono, better-sqlite3 (WAL mode), Vitest.

## Global Constraints

- `core/src` runs on Node 22+ native type stripping: no TypeScript parameter properties (constructors/functions assign fields plainly).
- Never `git add -A` — this is a shared checkout; stage explicit paths only.
- New migrations are appended strictly at the TAIL of `MIGRATIONS` in `core/src/storage/sqlite.ts` — mid-array insertion corrupts `user_version` on live databases.
- Config knobs follow the existing `positiveInt('RSC_..._', env.RSC_..._ ?? 'default')` pattern in `core/src/config.ts` — same validation, same error-message shape.
- End every commit message with "developed with the help of AI tools".
- Spec: `docs/superpowers/specs/2026-07-28-scalable-ingest-scheduler-design.md` (rev 2). Review: `docs/superpowers/reviews/2026-07-28-scalable-ingest-scheduler-spec-review.md`.

---

### Task 1: Ingest scheduling config knobs

**Files:**
- Modify: `core/src/config.ts`
- Test: `core/test/config.test.ts`

**Interfaces:**
- Produces: `Config.ingestCycleMinutes: number`, `Config.ingestConcurrency: number`, `Config.ingestMaxPerHost: number` — consumed by Task 4's scheduler rewrite via `config: Config`.

- [ ] **Step 1: Write the failing tests**

Append to `core/test/config.test.ts`:

```ts
test('ingest scheduling knobs apply defaults', () => {
  const c = loadConfig({ RSC_TOKEN: 't', RSC_AUTH_SECRET: 's' })
  expect(c.ingestCycleMinutes).toBe(30)
  expect(c.ingestConcurrency).toBe(8)
  expect(c.ingestMaxPerHost).toBe(2)
})
test('ingest scheduling knobs are tunable', () => {
  const c = loadConfig({
    RSC_TOKEN: 't', RSC_AUTH_SECRET: 's',
    RSC_INGEST_CYCLE_MINUTES: '10', RSC_INGEST_CONCURRENCY: '20', RSC_INGEST_MAX_PER_HOST: '1',
  })
  expect(c.ingestCycleMinutes).toBe(10)
  expect(c.ingestConcurrency).toBe(20)
  expect(c.ingestMaxPerHost).toBe(1)
})
test('ingest scheduling knobs reject non-positive-integer values', () => {
  expect(() => loadConfig({ RSC_TOKEN: 't', RSC_AUTH_SECRET: 's', RSC_INGEST_CYCLE_MINUTES: '0' })).toThrow('RSC_INGEST_CYCLE_MINUTES')
  expect(() => loadConfig({ RSC_TOKEN: 't', RSC_AUTH_SECRET: 's', RSC_INGEST_CONCURRENCY: 'many' })).toThrow('RSC_INGEST_CONCURRENCY')
  expect(() => loadConfig({ RSC_TOKEN: 't', RSC_AUTH_SECRET: 's', RSC_INGEST_MAX_PER_HOST: '-1' })).toThrow('RSC_INGEST_MAX_PER_HOST')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd core && npx vitest run test/config.test.ts`
Expected: FAIL — `c.ingestCycleMinutes` is `undefined`, not `30`.

- [ ] **Step 3: Add the fields to `Config` and `loadConfig`**

In `core/src/config.ts`, add to the `Config` interface (after `pollSeconds: number`):

```ts
  pollSeconds: number
  ingestCycleMinutes: number
  ingestConcurrency: number
  ingestMaxPerHost: number
```

In `loadConfig`'s returned object (after the `pollSeconds:` line):

```ts
    pollSeconds: positiveInt('RSC_POLL_SECONDS', env.RSC_POLL_SECONDS ?? '60'),
    ingestCycleMinutes: positiveInt('RSC_INGEST_CYCLE_MINUTES', env.RSC_INGEST_CYCLE_MINUTES ?? '30'),
    ingestConcurrency: positiveInt('RSC_INGEST_CONCURRENCY', env.RSC_INGEST_CONCURRENCY ?? '8'),
    ingestMaxPerHost: positiveInt('RSC_INGEST_MAX_PER_HOST', env.RSC_INGEST_MAX_PER_HOST ?? '2'),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd core && npx vitest run test/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/src/config.ts core/test/config.test.ts
git commit -m "$(cat <<'EOF'
core: add ingest scheduling config knobs

RSC_INGEST_CYCLE_MINUTES/CONCURRENCY/MAX_PER_HOST, operator-tunable via
env like RSC_POLL_SECONDS already is. Not consumed yet — the scheduler
rewrite that reads them lands in a later task.

developed with the help of AI tools
EOF
)"
```

---

### Task 2: Migration #20 — `source_health_v2(last_poll_at)` index

**Files:**
- Modify: `core/src/storage/sqlite.ts`
- Modify: `core/test/migrations.test.ts`
- Modify: `core/test/logical-schema.test.ts`

**Interfaces:**
- Produces: an index `source_health_v2_last_poll` on `source_health_v2(last_poll_at)`, `user_version` 20. Consumed by Task 3's `listDueSources` (keeps its `ORDER BY last_poll_at` index-supported at any catalog size).

- [ ] **Step 1: Write the failing test**

Append to `core/test/logical-schema.test.ts` (near the existing "required indexes" test):

```ts
test('migration 20 adds source_health_v2(last_poll_at) for the self-pacing scheduler', async () => {
  const repo = await createSqliteRepository(':memory:')
  const idx = indexNames(repo.raw)
  expect([...idx].some((n) => n.includes('source_health_v2'))).toBe(true)
  expect(repo.raw.pragma('user_version', { simple: true })).toBe(20)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npx vitest run test/logical-schema.test.ts -t "migration 20"`
Expected: FAIL — no index name contains `source_health_v2`, and `user_version` is 19.

- [ ] **Step 3: Add the migration**

In `core/src/storage/sqlite.ts`, append to the `MIGRATIONS` array (after the migration-19 entry, before the closing `]`):

```ts
  [`ALTER TABLE remote_sources_v2 ADD COLUMN overridden INTEGER NOT NULL DEFAULT 1 CHECK (overridden IN (0,1))`],
  // 20 — scalable ingest scheduler (spec 2026-07-28): the self-pacing scheduler's
  // staleness-ordered due-query needs this index to stay index-supported (not a
  // full scan+sort) at any catalog size. Appended at the TAIL, AFTER migration
  // #19 (the overridden column) — mid-array insertion corrupts user_version on
  // live databases. Pure additive CREATE INDEX, no table rebuilt.
  [`CREATE INDEX source_health_v2_last_poll ON source_health_v2(last_poll_at)`],
]
```

- [ ] **Step 4: Bump the hardcoded `user_version` expectations**

The new migration shifts every "current version" literal from 19 to 20. Update:

- `core/test/logical-schema.test.ts:102` — `toBe(19)` → `toBe(20)`
- `core/test/migrations.test.ts` — every `toBe(19)` → `toBe(20)` (lines 19, 99, 135, 246, 286, 381, 440 as of this writing; search for the literal, don't assume line numbers are still exact after Task 1's edits shifted nothing in this file).

Run: `grep -n "toBe(19)" core/test/migrations.test.ts core/test/logical-schema.test.ts` and change every match to `toBe(20)`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd core && npx vitest run test/logical-schema.test.ts test/migrations.test.ts`
Expected: PASS (all migration-version assertions now expect 20; the new index test passes)

- [ ] **Step 6: Commit**

```bash
git add core/src/storage/sqlite.ts core/test/migrations.test.ts core/test/logical-schema.test.ts
git commit -m "$(cat <<'EOF'
core: migration 20 — index source_health_v2(last_poll_at)

Needed by the upcoming staleness-ordered due-query so it stays
index-supported instead of a full scan+sort at any catalog size.
Pure additive CREATE INDEX, no table rebuilt.

developed with the help of AI tools
EOF
)"
```

---

### Task 3: Store — `listDueSources` + `countSchedulableSources`

**Files:**
- Modify: `core/src/logical/store.ts`
- Test: `core/test/logical-scheduler.test.ts`

**Interfaces:**
- Consumes: `SCHEDULABLE_SOURCE_WHERE` (new module-level SQL fragment constant, factored out of the existing `listSchedulableSources`).
- Produces: `store.listDueSources(input: { now: string; pollSeconds: number; pushPollFactor: number; limit: number }): { id: string; canonicalUrl: string }[]` and `store.countSchedulableSources(): number` — consumed by Task 4's scheduler rewrite.

This task does NOT touch `scheduler.ts` — it only adds store methods and tests them directly against `store`, bypassing the scheduler entirely (the scheduler rewrite that consumes them is Task 4).

- [ ] **Step 1: Write the failing tests**

Add near the top of `core/test/logical-scheduler.test.ts`, after the existing helpers (`fresh`, `seedSource`, `seedSubscribed`) and before the first `createScheduler`-based test:

```ts
// --- store: listDueSources / countSchedulableSources (spec 2026-07-28) -------
// Staleness-ordered, LIMIT-bounded due-query + a cheap catalog-size count — the
// two primitives the self-pacing scheduler (below) composes into a batch size.
// Tested directly against the store here, independent of the scheduler.

test('countSchedulableSources matches listSchedulableSources().length', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 'a')
  await seedSubscribed(raw, repo, 'b')
  seedSource(raw, 'lonely') // no subscriber, no federation — not schedulable
  expect(store.countSchedulableSources()).toBe(2)
  expect(store.listSchedulableSources().length).toBe(2)
  raw.close()
})

test('listDueSources: never-polled sources are due, ordered by id when equally stale', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 'c')
  await seedSubscribed(raw, repo, 'a')
  await seedSubscribed(raw, repo, 'b')
  const due = store.listDueSources({ now: NOW, pollSeconds: 60, pushPollFactor: 10, limit: 10 })
  expect(due.map((d) => d.id)).toEqual(['a', 'b', 'c'])
  expect(due[0]).toEqual({ id: 'a', canonicalUrl: 'https://feed.test/a' })
  raw.close()
})

test('listDueSources: a source polled within pollSeconds is excluded', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  raw.prepare(`INSERT INTO source_health_v2 (source_id, last_poll_at, last_success_at, last_failure_at, consecutive_failures) VALUES ('s1', ?, ?, NULL, 0)`).run(NOW, NOW)
  expect(store.listDueSources({ now: at(30), pollSeconds: 60, pushPollFactor: 10, limit: 10 })).toEqual([])
  expect(store.listDueSources({ now: at(61), pollSeconds: 60, pushPollFactor: 10, limit: 10 }).map((d) => d.id)).toEqual(['s1'])
  raw.close()
})

test('listDueSources: an active push lease widens the interval to pollSeconds × pushPollFactor', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  raw.prepare(`INSERT INTO source_health_v2 (source_id, last_poll_at, last_success_at, last_failure_at, consecutive_failures) VALUES ('s1', ?, ?, NULL, 0)`).run(NOW, NOW)
  raw.prepare(
    `INSERT INTO push_subscriptions_v2 (id, source_id, mode, endpoint, topic, callback_token, secret, state, expires_at, created_at)
     VALUES ('lease-1', 's1', 'websub', 'https://hub.test/hub', 'https://feed.test/s1', 'tok-1', NULL, 'active', ?, ?)`,
  ).run(at(100000), NOW)
  // 61s elapsed: past the base interval, still inside the 10x push interval
  expect(store.listDueSources({ now: at(61), pollSeconds: 60, pushPollFactor: 10, limit: 10 })).toEqual([])
  // 601s elapsed: past 10 × 60s
  expect(store.listDueSources({ now: at(601), pollSeconds: 60, pushPollFactor: 10, limit: 10 }).map((d) => d.id)).toEqual(['s1'])
  raw.close()
})

test('listDueSources: LIMIT bounds the result to the most-overdue N', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 'a')
  await seedSubscribed(raw, repo, 'b')
  await seedSubscribed(raw, repo, 'c')
  expect(store.listDueSources({ now: NOW, pollSeconds: 60, pushPollFactor: 10, limit: 2 }).map((d) => d.id)).toEqual(['a', 'b'])
  raw.close()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd core && npx vitest run test/logical-scheduler.test.ts -t "listDueSources"`
Expected: FAIL — `store.listDueSources is not a function`

- [ ] **Step 3: Factor the shared WHERE fragment and add the two store methods**

In `core/src/logical/store.ts`, add a module-level constant right before `export function createLogicalStore(db: DatabaseContext) {` (around line 338):

```ts
// The schedulability predicate (spec §1.3): enabled, not blocked, and either
// actively subscribed or federated. Shared by listSchedulableSources (the full
// membership-check list push.ts uses), countSchedulableSources, and
// listDueSources (both below) — one predicate, never re-expressed.
const SCHEDULABLE_SOURCE_WHERE = `s.operation = 'enabled' AND s.governance != 'blocked'
  AND (EXISTS (SELECT 1 FROM source_subscriptions_v2 sub WHERE sub.source_id = s.id AND sub.state = 'active')
       OR EXISTS (SELECT 1 FROM federation_relationships_v2 f WHERE f.source_id = s.id))`
```

Replace the existing `listSchedulableSources` body (around line 671-682) to use the constant — behavior-identical, pure refactor:

```ts
    listSchedulableSources(): string[] {
      return db.read((tx) => {
        const rows = tx.prepare(
          `SELECT s.id FROM remote_sources_v2 s WHERE ${SCHEDULABLE_SOURCE_WHERE} ORDER BY s.id ASC`,
        ).all() as { id: string }[]
        return rows.map((r) => r.id)
      })
    },
```

Add the two new methods right after `recordHealth` (before the closing `}` of the returned object, around line 709):

```ts
    countSchedulableSources(): number {
      return db.read((tx) => (tx.prepare(
        `SELECT COUNT(*) AS n FROM remote_sources_v2 s WHERE ${SCHEDULABLE_SOURCE_WHERE}`,
      ).get() as { n: number }).n)
    },
    // Staleness-ordered (oldest last_poll_at first, NULLs first — never-polled
    // is maximally overdue), LIMIT-bounded due-query (spec 2026-07-28 §1). A
    // source with an active, unexpired push lease needs pollSeconds ×
    // pushPollFactor elapsed instead of pollSeconds — same rule scheduler.ts
    // used to apply per-source in JS, now index-supported SQL so this stays
    // O(limit), never O(catalog size).
    listDueSources(input: { now: string; pollSeconds: number; pushPollFactor: number; limit: number }): { id: string; canonicalUrl: string }[] {
      return db.read((tx) => {
        const nowMs = Date.parse(input.now)
        const baseCutoff = new Date(nowMs - input.pollSeconds * 1000).toISOString()
        const pushCutoff = new Date(nowMs - input.pollSeconds * 1000 * input.pushPollFactor).toISOString()
        const rows = tx.prepare(
          `SELECT s.id AS id, s.canonical_url AS canonical_url FROM remote_sources_v2 s
           LEFT JOIN source_health_v2 h ON h.source_id = s.id
           WHERE ${SCHEDULABLE_SOURCE_WHERE}
             AND (
               h.last_poll_at IS NULL
               OR h.last_poll_at < CASE
                    WHEN EXISTS (SELECT 1 FROM push_subscriptions_v2 p WHERE p.source_id = s.id AND p.state = 'active' AND p.expires_at > ?)
                    THEN ? ELSE ? END
             )
           ORDER BY h.last_poll_at ASC, s.id ASC
           LIMIT ?`,
        ).all(input.now, pushCutoff, baseCutoff, input.limit) as { id: string; canonical_url: string }[]
        return rows.map((r) => ({ id: r.id, canonicalUrl: r.canonical_url }))
      })
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd core && npx vitest run test/logical-scheduler.test.ts`
Expected: PASS (new tests pass; every pre-existing test in this file still passes unchanged — `listSchedulableSources`'s refactor is behavior-identical)

- [ ] **Step 5: Commit**

```bash
git add core/src/logical/store.ts core/test/logical-scheduler.test.ts
git commit -m "$(cat <<'EOF'
core: add listDueSources + countSchedulableSources to the logical store

Staleness-ordered, LIMIT-bounded due-query and a cheap catalog-size
count — the primitives the self-pacing scheduler rewrite (next task)
composes into a batch size. listSchedulableSources refactored to share
the schedulability predicate via one constant; behavior unchanged.

developed with the help of AI tools
EOF
)"
```

---

### Task 4: Scheduler — self-pacing batch size + bounded concurrency + per-host cap

**Files:**
- Modify: `core/src/logical/scheduler.ts`
- Modify: `core/test/logical-scheduler.test.ts`
- Modify: `core/test/logical-admin-api.test.ts` (one `config:` literal, widened type only)
- Modify: `core/test/logical-vertical.test.ts` (one `config:` literal, widened type only)
- Modify: `core/test/migration-cutover.test.ts` (one `config:` literal, widened type only)

**Interfaces:**
- Consumes: `store.listDueSources`, `store.countSchedulableSources` (Task 3); `config.ingestCycleMinutes/ingestConcurrency/ingestMaxPerHost` (Task 1).
- Produces: `pollDue`'s external signature (`(now: string) => Promise<number>`) is unchanged; its internal dispatch is now self-pacing + bounded-concurrent instead of strict-serial.

**Design decision this task makes concrete:** the push-lease cadence check moves fully into `store.listDueSources`'s SQL (Task 3) — `pollDue` no longer calls `deps.push?.hasActivePush()` for scheduling at all (that method stays defined and used internally by `push.ts` for its own H3 registration gate; only the scheduler's *own* call to it disappears). This means the two existing tests that fake push-cadence behavior via `stubPush({active: new Set([...])})` must instead seed a real `push_subscriptions_v2` row, since the fake object no longer has any bearing on scheduling. `push.registered`/`push.passes` (the maybeRegister/renewDue/purgeExpired side effects) are completely unaffected and untouched.

- [ ] **Step 1: Update every bare `{ pollSeconds: N }` scheduler config in the test suite**

Widening `SchedulerDeps.config`'s required fields (Step 3 below) means every existing `config: { pollSeconds: N }` object literal in the test suite must gain the three new required fields or it fails `tsc` type-checking — vitest alone will NOT catch this (native type-stripping runs unchecked types through; this project's own testing convention is "always run tsc separately"). There are four such literals across three files.

In `core/test/logical-scheduler.test.ts`, change the shared config constant (around line 53):

```ts
const CONFIG = { pollSeconds: 60, ingestCycleMinutes: 1, ingestConcurrency: 8, ingestMaxPerHost: 8 }
```

(`ingestCycleMinutes: 1` with `pollSeconds: 60` makes `ticksPerCycle = ceil(60/60) = 1`, so `batchSize = catalogSize` — every existing test's small fixture still gets attempted in full on one `pollDue` call, exactly like today. `ingestConcurrency`/`ingestMaxPerHost` are set generously high so they don't constrain any existing test; Steps 4-5 below add dedicated tests that exercise both knobs directly.)

In `core/test/logical-admin-api.test.ts:182` (a skip-if-recent test unrelated to batch pacing):

```ts
  const sched = createScheduler({ store, acquisition: throwingEngine, config: { pollSeconds: 60, ingestCycleMinutes: 1, ingestConcurrency: 8, ingestMaxPerHost: 8 }, drainVerification: undefined, push: undefined, breather: undefined })
```

In `core/test/logical-vertical.test.ts:183`:

```ts
  const sched = createScheduler({ store: deps.store, acquisition: wrapped, config: { pollSeconds: 60, ingestCycleMinutes: 1, ingestConcurrency: 8, ingestMaxPerHost: 8 }, now: () => NOW, drainVerification: undefined, push: undefined, breather: undefined })
```

In `core/test/migration-cutover.test.ts:362` (`pollSeconds: 9999` — `ingestCycleMinutes: 1` still forces `ticksPerCycle = ceil(60/9999) = 1` for any `pollSeconds >= 60`, so this reproduces "attempt everyone every tick" here too):

```ts
  const scheduler = createScheduler({ store, acquisition, config: { pollSeconds: 9999, ingestCycleMinutes: 1, ingestConcurrency: 8, ingestMaxPerHost: 8 }, now: () => NOW, drainVerification: undefined, push, breather: undefined })
```

Replace the two push-cadence tests (`'an active push lease reduces the cadence...'` and `'a pending push row does not reduce the cadence'`) with:

```ts
test('an active push lease reduces the cadence to 10 × the base interval — durable, no tick state', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  raw.prepare(
    `INSERT INTO push_subscriptions_v2 (id, source_id, mode, endpoint, topic, callback_token, secret, state, expires_at, created_at)
     VALUES ('lease-1', 's1', 'websub', 'https://hub.test/hub', 'https://feed.test/s1', 'tok-1', NULL, 'active', ?, ?)`,
  ).run(at(100000), NOW) // expires far beyond every timestamp this test checks
  const order: string[] = []
  const sched = createScheduler({ store, acquisition: stubEngine({ order }), config: CONFIG, drainVerification: undefined, push: undefined, breather: undefined })

  expect(await sched.pollDue(NOW)).toBe(1)
  expect(await sched.pollDue(at(61))).toBe(0) // past the base interval, inside the push one
  expect(await sched.pollDue(at(599))).toBe(0)
  expect(await sched.pollDue(at(601))).toBe(1) // 10 × 60 s elapsed since lastPollAt
  expect(order).toEqual(['s1', 's1'])
  raw.close()
})

test('a pending push row does not reduce the cadence', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  raw.prepare(
    `INSERT INTO push_subscriptions_v2 (id, source_id, mode, endpoint, topic, callback_token, secret, state, expires_at, created_at)
     VALUES ('lease-1', 's1', 'websub', 'https://hub.test/hub', 'https://feed.test/s1', 'tok-1', NULL, 'pending', ?, ?)`,
  ).run(at(100000), NOW)
  const sched = createScheduler({ store, acquisition: stubEngine(), config: CONFIG, drainVerification: undefined, push: undefined, breather: undefined })

  expect(await sched.pollDue(NOW)).toBe(1)
  expect(await sched.pollDue(at(61))).toBe(1)
  raw.close()
})
```

Update the "one pass polls every schedulable source once, in stable sourceId order" test's description to stay honest (the assertions themselves are unchanged — for never-polled sources, staleness ordering ties on id, reproducing the old ordering exactly):

```ts
test('one pass polls every schedulable source once — staleness order ties on id when all are equally never-polled', async () => {
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd core && npx vitest run test/logical-scheduler.test.ts`
Expected: FAIL — `TypeError` from `store.listSchedulableSources` still being called with the old per-source `getHealth`/`hasActivePush` loop shape is NOT the failure here (scheduler.ts hasn't changed yet); the two rewritten push-cadence tests fail because `pollDue` still asks `deps.push?.hasActivePush()` (now `undefined`, since these tests pass `push: undefined`) instead of reading the real `push_subscriptions_v2` row — expect `0` polled instead of `1` on the first call.

- [ ] **Step 3: Rewrite `pollDue`**

Replace the body of `core/src/logical/scheduler.ts` from `async function pollDue` through its closing `}` with:

```ts
  function hostOf(canonicalUrl: string): string {
    try { return new URL(canonicalUrl).host } catch { return canonicalUrl }
  }

  async function pollDue(nowStr: string): Promise<number> {
    const catalogSize = store.countSchedulableSources()
    if (catalogSize === 0) {
      await deps.push?.renewDue()
      deps.push?.purgeExpired(nowStr)
      return 0
    }
    const ticksPerCycle = Math.max(1, Math.ceil((config.ingestCycleMinutes * 60) / config.pollSeconds))
    const batchSize = Math.max(1, Math.ceil(catalogSize / ticksPerCycle))

    const due = store.listDueSources({ now: nowStr, pollSeconds: config.pollSeconds, pushPollFactor: PUSH_POLL_FACTOR, limit: batchSize })
      .filter((s) => !acquisition.inFlight(s.id))
    // ponytail: a lane that finds nothing startable (every remaining item is
    // host-capped) exits without waiting for a host slot to free — the
    // overflow is still the most-overdue set and is first in line again next
    // tick, rather than this tick blocking to squeeze it in.
    const queue = due.map((s) => ({ id: s.id, host: hostOf(s.canonicalUrl) }))
    const hostCounts = new Map<string, number>()
    let polled = 0

    async function lane(): Promise<void> {
      for (;;) {
        const idx = queue.findIndex((item) => (hostCounts.get(item.host) ?? 0) < config.ingestMaxPerHost)
        if (idx === -1) return
        const [item] = queue.splice(idx, 1)
        hostCounts.set(item.host, (hostCounts.get(item.host) ?? 0) + 1)
        try {
          const run = await acquisition.acquireSource(item.id, { kind: 'scheduled' })
          if (!('kind' in run)) {
            store.recordHealth({ sourceId: item.id, outcome: run.outcome, now: nowStr })
            polled++
            if (SUCCESS_OUTCOMES.has(run.outcome) && deps.push) await deps.push.maybeRegister(item.id, deps.push.latestClaim(item.id))
          }
        } finally {
          hostCounts.set(item.host, (hostCounts.get(item.host) ?? 1) - 1)
        }
        // Breathe HERE — between per-source acquisitions, never mid-transaction
        // (each acquisition's claim/commit/fail, recordHealth and maybeRegister
        // have all committed and returned by this point).
        if (deps.breather) await deps.breather()
      }
    }

    await Promise.all(Array.from({ length: Math.min(config.ingestConcurrency, queue.length) }, () => lane()))

    await deps.push?.renewDue()
    deps.push?.purgeExpired(nowStr)
    return polled
  }
```

Widen `SchedulerDeps.config`'s inline type (near the top of the file):

```ts
  config: { pollSeconds: number; ingestCycleMinutes: number; ingestConcurrency: number; ingestMaxPerHost: number }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd core && npx vitest run test/logical-scheduler.test.ts`
Expected: PASS — all existing tests (with the `CONFIG`/push-cadence updates from Step 1) and the new Task 3 store-level tests pass.

- [ ] **Step 5: Add the self-pacing batch-size test**

Append to `core/test/logical-scheduler.test.ts`:

```ts
// --- self-pacing batch size (spec 2026-07-28 §2) -----------------------------

test('self-pacing batch size: a full cycle is spread evenly across ticks regardless of catalog size', async () => {
  const { raw, store, repo } = await fresh()
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) await seedSubscribed(raw, repo, id)
  const order: string[] = []
  // ticksPerCycle = ceil(6*60/60) = 6 → batchSize = ceil(6/6) = 1 per tick
  const CONFIG6 = { pollSeconds: 60, ingestCycleMinutes: 6, ingestConcurrency: 8, ingestMaxPerHost: 8 }
  const sched = createScheduler({ store, acquisition: stubEngine({ order }), config: CONFIG6, drainVerification: undefined, push: undefined, breather: undefined })

  for (let i = 0; i < 6; i++) {
    expect(await sched.pollDue(at(i * 60))).toBe(1)
  }
  expect(order).toEqual(['a', 'b', 'c', 'd', 'e', 'f']) // each polled exactly once, oldest-due first
  raw.close()
})
```

- [ ] **Step 6: Add the per-host concurrency cap test**

Append:

```ts
// --- per-host concurrency cap (spec 2026-07-28 §2) ---------------------------

async function seedSubscribedUrl(raw: Raw, repo: { createLocalUser: (u: { handle: string; displayName: string }) => Promise<{ id: string }> }, id: string, url: string): Promise<void> {
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, 'single_publisher', 'enabled', 'allowed', 'admin_federation', NULL, 0, ?)`,
  ).run(id, url, NOW)
  const owner = await repo.createLocalUser({ handle: `owner-${id}`, displayName: id })
  raw.prepare(`INSERT INTO source_subscriptions_v2 (id, owner_id, source_id, state, created_at) VALUES (?, ?, ?, 'active', ?)`)
    .run(`sub-${id}`, owner.id, id, NOW)
}

test('RSC_INGEST_MAX_PER_HOST caps simultaneous fetches to the same remote host', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribedUrl(raw, repo, 's1', 'https://shared.test/a.xml')
  await seedSubscribedUrl(raw, repo, 's2', 'https://shared.test/b.xml')
  await seedSubscribedUrl(raw, repo, 's3', 'https://other.test/c.xml')

  let concurrentOnSharedHost = 0
  let maxConcurrentOnSharedHost = 0
  const engine: AcquisitionEngine = {
    async acquireSource(sourceId: string) {
      if (sourceId === 's1' || sourceId === 's2') {
        concurrentOnSharedHost++
        maxConcurrentOnSharedHost = Math.max(maxConcurrentOnSharedHost, concurrentOnSharedHost)
        await new Promise((r) => setTimeout(r, 5))
        concurrentOnSharedHost--
      }
      return { runId: `run-${sourceId}`, sourceId, status: 'terminal', outcome: 'parsed' }
    },
    inFlight: () => false,
  }
  const CONFIG_HOST = { pollSeconds: 60, ingestCycleMinutes: 1, ingestConcurrency: 8, ingestMaxPerHost: 1 }
  const sched = createScheduler({ store, acquisition: engine, config: CONFIG_HOST, drainVerification: undefined, push: undefined, breather: undefined })

  expect(await sched.pollDue(NOW)).toBe(3)
  expect(maxConcurrentOnSharedHost).toBe(1) // never more than RSC_INGEST_MAX_PER_HOST on shared.test at once
  raw.close()
})
```

- [ ] **Step 7: Run the full test suite AND tsc to verify everything passes**

Run: `cd core && npx vitest run test/logical-scheduler.test.ts`
Expected: PASS (all tests, including the two new ones from Steps 5-6)

Run: `cd core && npx vitest run`
Expected: PASS (no regressions elsewhere — `push.ts`'s own `hasActivePush` usage for its H3 gate is untouched, so `logical-push.test.ts` is unaffected)

Run: `cd core && npx tsc --noEmit`
Expected: PASS — this is the check that actually catches the three `config:` literals in `logical-admin-api.test.ts`, `logical-vertical.test.ts`, and `migration-cutover.test.ts` if Step 1 missed one (vitest's native type-stripping would silently let a type error through).

- [ ] **Step 8: Commit**

```bash
git add core/src/logical/scheduler.ts core/test/logical-scheduler.test.ts core/test/logical-admin-api.test.ts core/test/logical-vertical.test.ts core/test/migration-cutover.test.ts
git commit -m "$(cat <<'EOF'
core: self-pacing scheduler — bounded concurrency + per-host cap

Replaces the strict-serial "attempt every schedulable source every
tick" loop with a self-pacing batch size (catalog size divided across
an operator-declared target cycle time, RSC_INGEST_CYCLE_MINUTES) fed
through a bounded-concurrency pool (RSC_INGEST_CONCURRENCY) with a
per-host cap (RSC_INGEST_MAX_PER_HOST). Root-caused: a burst of 40-75
of ~155 sources crammed into a 20-30s window every cycle was starving
the HTTP event loop on rsc.rmdes.be. Push-lease cadence now lives in
listDueSources's SQL rather than a per-source JS call.

developed with the help of AI tools
EOF
)"
```

---

### Task 5: Startup heal for orphaned `processing` acquisition runs

**Files:**
- Modify: `core/src/logical/types.ts`
- Modify: `core/src/logical/acquisition.ts`
- Modify: `core/src/logical/runtime.ts`
- Test: `core/test/logical-acquisition.test.ts`
- Test: `core/test/logical-runtime.test.ts`

**Interfaces:**
- Produces: `healOrphanedRuns(db: DatabaseContext, now: string): number` (exported from `acquisition.ts`) — called once from `runtime.ts`'s pre-listen `ready` IIFE.

- [ ] **Step 1: Write the failing unit tests**

Append to `core/test/logical-acquisition.test.ts`:

```ts
import { healOrphanedRuns } from '../src/logical/acquisition.ts'
```

(add to the existing `import { createAcquisition, parseCandidates } from '../src/logical/acquisition.ts'` line instead — combine into one import statement from that module.)

```ts
test('healOrphanedRuns terminalizes every processing row unconditionally', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/s1')
  raw.prepare(
    `INSERT INTO acquisition_runs_v2 (id, source_id, reason, status, started_at, acquisition_committed_at, completed_at, outcome, counters_json, failure_category, diagnostic, push_capability_json)
     VALUES ('r1', 's1', 'scheduled', 'processing', ?, NULL, NULL, 'pending', '{}', NULL, NULL, NULL)`,
  ).run(NOW)

  const healed = healOrphanedRuns(db, LATER)
  expect(healed).toBe(1)
  const row = raw.prepare(`SELECT status, outcome, failure_category, diagnostic, completed_at FROM acquisition_runs_v2 WHERE id = 'r1'`).get()
  expect(row).toEqual({ status: 'terminal', outcome: 'operational_failure', failure_category: 'interrupted', diagnostic: 'orphaned by process restart', completed_at: LATER })
})

test('healOrphanedRuns is a no-op when nothing is processing', async () => {
  const { db } = await fresh()
  expect(healOrphanedRuns(db, NOW)).toBe(0)
})

test('healOrphanedRuns never touches an already-terminal run', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/s1')
  raw.prepare(
    `INSERT INTO acquisition_runs_v2 (id, source_id, reason, status, started_at, acquisition_committed_at, completed_at, outcome, counters_json, failure_category, diagnostic, push_capability_json)
     VALUES ('r1', 's1', 'scheduled', 'terminal', ?, ?, ?, 'parsed', '{}', NULL, NULL, NULL)`,
  ).run(NOW, NOW, NOW)
  expect(healOrphanedRuns(db, LATER)).toBe(0)
  const row = raw.prepare(`SELECT status, outcome FROM acquisition_runs_v2 WHERE id = 'r1'`).get()
  expect(row).toEqual({ status: 'terminal', outcome: 'parsed' })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd core && npx vitest run test/logical-acquisition.test.ts -t "healOrphanedRuns"`
Expected: FAIL — `healOrphanedRuns is not a function`

- [ ] **Step 3: Add the `'interrupted'` failure category**

In `core/src/logical/types.ts`, widen the `failureCategory` union (around line 209-211):

```ts
  failureCategory:
    | 'network' | 'timeout' | 'http' | 'body_limit'
    | 'feed_parse' | 'policy' | 'superseded' | 'interrupted' | null
```

- [ ] **Step 4: Implement `healOrphanedRuns`**

In `core/src/logical/acquisition.ts`, add right after `markTerminal` (around line 506):

```ts
// A process's in-flight guard (inFlightMap below) starts EMPTY on every boot,
// so any acquisition_runs_v2 row still 'processing' at this exact moment (this
// runs pre-listen, before any acquisition has started) cannot belong to this
// process — it predates this boot and its owning process is gone. Certain by
// construction, not a timeout heuristic. Harmless if left alone (claimAcquisition
// never checks for an existing 'processing' row before starting a new one — only
// the in-memory map guards a double-claim) but wrong bookkeeping for any future
// admin "is this source stuck?" view. Self-contained transaction, same pattern
// as membership.ts's healMembers.
export function healOrphanedRuns(db: DatabaseContext, now: string): number {
  return db.write((tx) => {
    const result = tx.prepare(
      `UPDATE acquisition_runs_v2
       SET status = 'terminal', outcome = 'operational_failure', failure_category = 'interrupted',
           diagnostic = 'orphaned by process restart', completed_at = ?
       WHERE status = 'processing'`,
    ).run(now)
    return result.changes
  })
}
```

- [ ] **Step 5: Run unit tests to verify they pass**

Run: `cd core && npx vitest run test/logical-acquisition.test.ts`
Expected: PASS

- [ ] **Step 6: Write the failing runtime integration test**

Append to `core/test/logical-runtime.test.ts`:

```ts
test('an orphaned processing acquisition run is healed to terminal before the scheduler starts', async () => {
  const deps = await setup()
  deps.repo.raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES ('s1', 'https://feed.test/s1', 'single_publisher', 'enabled', 'allowed', 'admin_federation', NULL, 0, ?)`,
  ).run(NOW)
  deps.repo.raw.prepare(
    `INSERT INTO acquisition_runs_v2 (id, source_id, reason, status, started_at, acquisition_committed_at, completed_at, outcome, counters_json, failure_category, diagnostic, push_capability_json)
     VALUES ('orphan-1', 's1', 'scheduled', 'processing', ?, NULL, NULL, 'pending', '{}', NULL, NULL, NULL)`,
  ).run(NOW)

  const runtime = mkRuntime(deps)
  await runtime.ready
  await runtime.stop()

  const row = deps.repo.raw.prepare(`SELECT status, outcome, failure_category, diagnostic FROM acquisition_runs_v2 WHERE id = 'orphan-1'`).get()
  expect(row).toEqual({ status: 'terminal', outcome: 'operational_failure', failure_category: 'interrupted', diagnostic: 'orphaned by process restart' })
})
```

- [ ] **Step 7: Run test to verify it fails**

Run: `cd core && npx vitest run test/logical-runtime.test.ts -t "orphaned processing"`
Expected: FAIL — the row is still `status: 'processing'` (nothing calls `healOrphanedRuns` yet)

- [ ] **Step 8: Wire the heal into the runtime's pre-listen `ready` IIFE**

In `core/src/logical/runtime.ts`, add `healOrphanedRuns` to the import from `./acquisition.ts` (find the existing import of acquisition-related symbols in this file, or add a new one if none exists — check with `grep -n "from './acquisition.ts'" core/src/logical/runtime.ts` first):

```ts
import { healOrphanedRuns } from './acquisition.ts'
```

In the `ready` IIFE (around line 435-447), add the heal call right after `activateLogicalV2` and before `drainSync()`:

```ts
  const ready = (async (): Promise<void> => {
    activateLogicalV2(db, now(), { manifestPath: config.migrationManifestPath })
    trace('activate')
    healOrphanedRuns(db, now())
    trace('heal-orphaned-runs')
    drainSync()
    scheduler.start()
  })()
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `cd core && npx vitest run test/logical-runtime.test.ts`
Expected: PASS

Run: `cd core && npx vitest run`
Expected: PASS (no regressions — `activateLogicalV2` and `drainSync` are unchanged, only one new call inserted between them)

- [ ] **Step 10: Commit**

```bash
git add core/src/logical/types.ts core/src/logical/acquisition.ts core/src/logical/runtime.ts core/test/logical-acquisition.test.ts core/test/logical-runtime.test.ts
git commit -m "$(cat <<'EOF'
core: self-heal acquisition_runs_v2 rows orphaned by a past restart

healOrphanedRuns terminalizes every status='processing' row on every
boot, unconditionally: the in-process in-flight guard starts empty on
every process start, so any such row is certainly orphaned, not a
guess. Confirmed harmless today (claimAcquisition never checks for an
existing processing row) but wrong bookkeeping left uncorrected.
Found ~31 such rows on rsc.rmdes.be from a 2026-07-25 restart.

developed with the help of AI tools
EOF
)"
```

---

### Task 6: `/admin/overview` scheduler-stats observability

**Files:**
- Modify: `core/src/logical/store.ts`
- Modify: `core/src/api/app.ts`
- Modify: `core/src/server.ts`
- Modify: `docs/superpowers/ideas.md`
- Test: `core/test/admin.test.ts`

**Interfaces:**
- Consumes: `SCHEDULABLE_SOURCE_WHERE` (Task 3), `Config.pollSeconds` (existing).
- Produces: `store.schedulerStats(input: { now: string; pollSeconds: number }): { catalogSize: number; mostOverdueSeconds: number | null; attemptedLastWindow: number; windowSpanSeconds: number | null }`. `GET /admin/overview`'s JSON response gains a `scheduler` field of this shape.

- [ ] **Step 1: Write the failing test**

Append to `core/test/admin.test.ts`:

```ts
test('admin session: /admin/overview includes scheduler stats', async () => {
  const { app, repo } = await makeApp(['boss@x.test'])
  repo.raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES ('s1', 'https://feed.test/s1', 'single_publisher', 'enabled', 'allowed', 'admin_federation', NULL, 0, ?)`,
  ).run('2026-07-28T00:00:00.000Z')
  const owner = await repo.createLocalUser({ handle: 'owner1', displayName: 'Owner' })
  repo.raw.prepare(`INSERT INTO source_subscriptions_v2 (id, owner_id, source_id, state, created_at) VALUES ('sub1', ?, 's1', 'active', ?)`)
    .run(owner.id, '2026-07-28T00:00:00.000Z')

  const cookie = await registeredSession(app, 'boss@x.test', repo)
  const res = await app.request('/admin/overview', { headers: { cookie } })
  const body = await res.json()
  expect(body.scheduler.catalogSize).toBe(1)
  expect(body.scheduler.mostOverdueSeconds).toBeNull() // never polled = maximally overdue, reported as null
  expect(body.scheduler.attemptedLastWindow).toBe(0)
  expect(body.scheduler.windowSpanSeconds).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npx vitest run test/admin.test.ts -t "scheduler stats"`
Expected: FAIL — `body.scheduler` is `undefined`

- [ ] **Step 3: Add `store.schedulerStats`**

In `core/src/logical/store.ts`, add right after `listDueSources` (from Task 3):

```ts
    // /admin/overview's cycle-health readout (spec 2026-07-28 §4): every field
    // computed fresh from durable state here, matching how every other
    // /admin/overview field already works (service.instanceStats) — no new
    // in-memory scheduler-closure bookkeeping.
    schedulerStats(input: { now: string; pollSeconds: number }): {
      catalogSize: number
      mostOverdueSeconds: number | null
      attemptedLastWindow: number
      windowSpanSeconds: number | null
    } {
      return db.read((tx) => {
        const { n: catalogSize } = tx.prepare(
          `SELECT COUNT(*) AS n FROM remote_sources_v2 s WHERE ${SCHEDULABLE_SOURCE_WHERE}`,
        ).get() as { n: number }

        const staleness = tx.prepare(
          `SELECT MIN(h.last_poll_at) AS oldest, SUM(CASE WHEN h.last_poll_at IS NULL THEN 1 ELSE 0 END) AS neverPolled
           FROM remote_sources_v2 s LEFT JOIN source_health_v2 h ON h.source_id = s.id
           WHERE ${SCHEDULABLE_SOURCE_WHERE}`,
        ).get() as { oldest: string | null; neverPolled: number | null }
        const mostOverdueSeconds = catalogSize === 0 || (staleness.neverPolled ?? 0) > 0 || staleness.oldest === null
          ? null
          : Math.round((Date.parse(input.now) - Date.parse(staleness.oldest)) / 1000)

        const windowStart = new Date(Date.parse(input.now) - input.pollSeconds * 1000).toISOString()
        const window = tx.prepare(
          `SELECT COUNT(*) AS attempted, MIN(started_at) AS windowStart, MAX(COALESCE(completed_at, started_at)) AS windowEnd
           FROM acquisition_runs_v2 WHERE started_at >= ?`,
        ).get(windowStart) as { attempted: number; windowStart: string | null; windowEnd: string | null }
        const windowSpanSeconds = window.attempted > 0 && window.windowStart && window.windowEnd
          ? Math.round((Date.parse(window.windowEnd) - Date.parse(window.windowStart)) / 1000)
          : null

        return { catalogSize, mostOverdueSeconds, attemptedLastWindow: window.attempted, windowSpanSeconds }
      })
    },
```

- [ ] **Step 4: Wire `pollSeconds` through `createApp` and mount the field**

In `core/src/api/app.ts`, `createApp`'s signature (line 114) is currently:

```ts
export function createApp(deps: { service: Service; bus: EventBus; token: string; auth: Auth; users: UserDirectory; feeds?: FeedContext; pushApi?: PushApi; pushInApi?: PushInApi; mailEnabled?: boolean; adminEmails?: ReadonlySet<string>; websub?: string; pushIn?: boolean; sources: { service: SourceService; repo: SourceRepository }; logical: LogicalRouteDeps }): Hono {
```

Insert `pollSeconds?: number;` right after `pushIn?: boolean;`:

```ts
export function createApp(deps: { service: Service; bus: EventBus; token: string; auth: Auth; users: UserDirectory; feeds?: FeedContext; pushApi?: PushApi; pushInApi?: PushInApi; mailEnabled?: boolean; adminEmails?: ReadonlySet<string>; websub?: string; pushIn?: boolean; pollSeconds?: number; sources: { service: SourceService; repo: SourceRepository }; logical: LogicalRouteDeps }): Hono {
```

Add the default near the other optional-with-default reads (around line 120, after `const pushInEnabled = deps.pushIn ?? false`):

```ts
  const pollSeconds = deps.pollSeconds ?? 60
```

Update the `/admin/overview` handler (around line 425):

```ts
  app.get('/admin/overview', (c) => c.json({
    counts: service.instanceStats(true),
    federation: { websub: websubMode, rssCloud: feeds.rssCloud, pushIn: pushInEnabled, publicUrl: feeds.publicUrl },
    mailEnabled,
    adminEmails: [...adminEmails],
    scheduler: deps.logical.store.schedulerStats({ now: new Date().toISOString(), pollSeconds }),
  }))
```

- [ ] **Step 5: Thread `pollSeconds` from `server.ts`**

In `core/src/server.ts`, add to the `createApp({...})` call (near `pushIn: config.pushIn,`):

```ts
  pushIn: config.pushIn,
  pollSeconds: config.pollSeconds,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd core && npx vitest run test/admin.test.ts`
Expected: PASS

Run: `cd core && npx vitest run`
Expected: PASS (no regressions — `pollSeconds` is optional with a default, so every other `createApp` call site in the test suite that omits it keeps working)

- [ ] **Step 7: Annotate the ideas.md backlog entry**

Run `grep -n "Force-refresh" docs/superpowers/ideas.md` to find the current line number of the "Force-refresh — a *paced* re-poll you can trigger, scoped by feed class" heading (line numbers shift as other entries are appended over time). Find that entry's **Status:** line, immediately below the heading, and add this sentence directly after it:

```
`docs/superpowers/specs/2026-07-28-scalable-ingest-scheduler-design.md`
built a bounded-concurrency pool for the scheduled poll path — this
entry's manual trigger can dispatch through the same pool instead of
building a second one.
```

- [ ] **Step 8: Commit**

```bash
git add core/src/logical/store.ts core/src/api/app.ts core/src/server.ts core/test/admin.test.ts docs/superpowers/ideas.md
git commit -m "$(cat <<'EOF'
core: /admin/overview scheduler-stats — catalog size, staleness, cycle span

Every field computed fresh from durable state (schedulable-source
count + source_health_v2 staleness + acquisition_runs_v2 window),
matching how every other /admin/overview field already works — no new
scheduler-closure mutable state. Lets an operator see cadence
silently stretching under load before discovering stale feeds by
accident.

developed with the help of AI tools
EOF
)"
```

---

## Post-plan verification

After all six tasks:

```bash
cd core && npx vitest run && npx tsc --noEmit
```

Expected: full test suite green, zero type errors.

Deployment (per spec's Rollout section, manual — not part of this plan's tasks): deploy to rsc.rmdes.be first (the instance that surfaced the original slowness), verify `/admin/overview`'s new `scheduler` block looks sane in production, then roll to the other 3 instances (alice.rmdes.be, bob.rmdes.be, rsc.rmendes.net).
