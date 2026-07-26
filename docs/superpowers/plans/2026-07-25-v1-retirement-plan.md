# V1 Retirement (V4 Task 11) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Relationship to the original plan:** `docs/superpowers/plans/2026-07-22-rsc-migration-cutover.md:802`
stubbed "Task 11: Legacy retirement" as 4 steps, explicitly deferring its
"exact inventory... fixed at execution time against the then-real tree." This
plan (and its spec, `docs/superpowers/specs/2026-07-25-v1-retirement-design.md`,
committed `0be85e9`) IS that execution-time inventory — not a duplicate.

**Goal:** Delete the entire v1 (legacy remote-polling) code path and the
`RSC_SOURCE_MODEL_V2` flag, leaving v2 source-governance as the only model —
with zero feature regression and zero test coverage loss.

**Architecture:** This is a *deletion* release, but two places add real new
behavior (a purge call, a fresh-install activation guarantee) and get their own
TDD cycle rather than riding inside a deletion task. Four modules that look
legacy are actually hybrids — pure helpers must be extracted before their v1
shell is deleted. ~24 core test files and ~19 web files fork on the flag; each
gets an explicit disposition (delete-as-superseded, or convert) rather than a
blanket rewrite.

**Tech Stack:** Hono (core), better-sqlite3 + Kysely, SvelteKit 5 (web), vitest.

## Global Constraints

- **No wire contract changes.** `/capabilities`'s `sourceModelV2` field name is
  read by web (`web/src/lib/api.ts:284-300`, typed `web/src/lib/types.ts:5-7`)
  — never rename it.
- **No migration. No table dropped.** `users`, `posts`, `post_revisions`,
  `follows`, `subscriptions`, `instance_settings` keep live v2/shared roles.
- **Deploy order: unset `RSC_SOURCE_MODEL_V2` on all four Cloudron instances
  BEFORE the image update** (rsc.rmdes.be, alice.rmdes.be, bob.rmdes.be,
  rsc.rmendes.net). `cloudron update` takes its own backup and restarts.
- **ALL tests and typechecks run IN THE CONTAINER — the default, not a
  fallback.** `docker compose up` must be running. `core/node_modules/.vite-temp`
  is root-owned by the dev stack, so a host `npm run -w core test` dies with
  `EACCES` before collecting a single test (verified 2026-07-25):
  - core: `docker compose exec -T core npm run -w core test`
  - core types: `docker compose exec -T core npm run -w core typecheck`
  - web: `docker compose exec -T web env -u CORE_API_URL npm test -w web`
  - web types: `docker compose exec -T web npm run check -w web`
- **Native Node 22 type-stripping**: the two typecheck gates above are mandatory
  after every task — vitest passes on type errors alone.
- **Known flake, not a regression**: `ingest.test.ts`'s "pollAll swallows an
  oversized feed" passes isolated (~3.1s) but can exceed the 5s default under
  full-suite contention; the OPML pair behaves the same way. Re-run any such
  failure isolated before treating it as real. (Task 7 deletes this test anyway.)
- **Baseline at plan-authoring time (2026-07-25, verified):** core
  **1085 passed / 2 expected-fail** (the two `test.fails()` fences), core
  typecheck 0 errors, svelte-check 0 errors/0 warnings. Every task's gate is
  measured against this.
- **No new dependency** anywhere in this plan.
- **Every commit message ends with:** `developed with the help of AI tools`
  (project convention) — stage explicit paths only, never `git add -A`
  (shared checkout).
- **GAP 2** (HTML `rel=alternate` feed autodiscovery) is explicitly OUT OF
  SCOPE for this plan — already-live behavior, deferred to its own future task,
  tracked in `docs/superpowers/ideas.md` at the end of this plan (Task 15).

---

## Part 0 — Test disposition table (read this before any task)

**Method (this matters — an earlier draft of this table was ~40% wrong).**
Dispositions here are derived by grepping every **symbol** the plan deletes,
repo-wide, and letting the results define each file's fate. They are NOT
derived from what a file's routes appear to do. Route-surface grepping answers
*"what does this file exercise"*; symbol grepping answers *"what breaks when
this symbol dies"* — a decommission only ever asks the second. The earlier
draft asked the first and consequently misclassified `service.test.ts`,
`feed.test.ts`, `api.test.ts`, `federation-following.test.ts`,
`federation-threading.test.ts`, `peers.test.ts`, `subscriptions-api.test.ts`
and three others as safe, and omitted four files entirely.

**If you extend this plan, extend it the same way:** grep the symbol, not the
route. Comment-only and same-name-different-object hits were excluded by
reading each call site (e.g. `service.subscribeByUrl(owner, url, 'webfeed')` is
the deleted v1 API; `service.subscribeByUrl(owner, url, 'c1')` is the surviving
v2 `SourceService` — third argument distinguishes them).

### 0.1 Deleted-symbol → test-file matrix (verified, comments excluded)

| Deleted symbol | Test files with REAL call sites |
|---|---|
| `createPushIn` | `federation-live`, `logical-v4-vertical:101`, `push-in` |
| `runPollCycle` | `federation-live:71`, `push-in` |
| `ingestItems` | `feed:210,223,307`, `ingest-edits:25,27,35,37`, `ingest`, `api:176` |
| `ingestRemoteUser` | `federation`, `federation-live`, `ingest`, `ingest-discovery` (all 10), `federation-threading:47,68,110` |
| `pollAll` | `ingest:241`, `ingest-discovery` |
| `importFollowingOpml` | `opml:66,76,85,98,109` (17 tests) |
| `mintRemoteUser` | (comment only in `subscribe:57` — but see `subscribeByUrl` below) |
| `service.subscribeByUrl` (v1, 3rd arg `'webfeed'`/`'person'`) | `subscribe:20,26,38,47` |
| `service.addRemoteUser` | `service:20,42,47,48`, `federation-following:22,23`, `opml:74`, `federation:31` |
| `listTextcastingPeers` | `peers:60` (an explicit v1 test) |
| `compose` | `logical-runtime:50,54,55`, `logical-vertical:104,126`, `logical-v3-vertical:644,656`, `logical-v4-vertical:97,311` — **9 sites / 4 files** (NOT `api-threading`, whose "reply compose" is a test name) |
| `assertLegacyStartupAllowed` | `migration-cutover:197,288,292,293`, `logical-v4-vertical:94` |

**False positives explicitly ruled out** (do not "fix" these):
`api-threading` (`compose` = test name "reply compose"),
`logical-scheduler:223` (`runPollCycle` in a comment),
`logical-push-callbacks:17` (`createPushIn` in a comment — the file drives the
handlers directly and only needs its import re-pointed),
`logical-tombstones` + `source-subscribe` (`subscribeByUrl` = the surviving v2
`SourceService` method).

### 0.2 `createApp` signature gap — 30 files, not 24

Every file below calls `createApp` WITHOUT `sources`/`logical` and therefore
stops compiling the moment Task 5 makes them required:

`admin-feeds`, `admin-overview`, `admin-settings`, `admin-users`, `admin`,
`api-follows`, `api-threading`, `api`, `auth`, `federation-following`,
`federation-live`, `federation-threading`, `federation`, `feed`,
`logical-reply-target`, `logical-routes`, `migration-cutover`, `moderation`,
`multi-session`, `posts-edit`, `revisions`, `service`, `smoke`,
`source-capability-api`, `source-control-integration`, `source-ops-api`, `sse`,
`subscriptions-api`, `timeline-tabs`, `unfollow-cleanup`.

### 0.3 Flag-off tests that must be DELETED (a mode this release removes)

These assert behaviour that ceases to exist. Every one was in the earlier
draft's "already v2-aware, no rework needed" list — all wrong:

| File | Test to delete |
|---|---|
| `source-capability-api` | `:71` "while off no v2 route is registered…", `:86` "while off the legacy subscribe/OPML/following routes behave exactly as today", and `:61` "reports the flag exactly" must be rewritten to assert the now-constant shape |
| `source-control-integration` | `:85` "with the flag off the legacy surface is intact and no v2 route exists" |
| `source-ops-api` | `:61` "the ops route exists only under v2 — with the flag off it is a plain 404" |
| `subscriptions-api` | `:25,42,56,66,77,88` — all use the bare `createApp` and POST the **v1** `{url, type}` body; only the v2 test at `:153` survives |
| `peers` | `:60` "GET /peers (v1, sources undefined)" — keep the v2 test at `:29` |
| `logical-v4-vertical` | the `offFlagApp()` harness (`:88`+) and its **three** Part-A tests at `:123`, `:168`, `:194` |

### 0.4 Per-file disposition

**DELETE the whole file** (every test exercises code this release deletes):
`sse`, `timeline-tabs`, `federation`, `federation-live`, `ingest-discovery`,
`opml` (17 tests, all `importFollowingOpml`), `subscribe` (all v1
`subscribeByUrl`), `ingest-edits` (all `ingestItems`), `admin-feeds`.

**REWRITE, keeping a proven subset:**
- `push-in` — keep only `verifySignature`/`choosePushTarget`/`pushInEffective`
  cases, re-pointed to `logical/push.ts`.
- `ingest` — keep only the 9 pure-parser tests (`parseFeedWithMeta`,
  `parseLinkHeader`, `toParsedItem`-as-constructor); delete the ~15 that call
  `ingestRemoteUser`/`ingestItems`/`pollAll`.
- `service` — delete the 3 tests that are ABOUT `addRemoteUser` (`:40`, `:45`,
  and the `:20` fixture use); keep the rest.
- `peers`, `source-capability-api`, `source-control-integration`,
  `source-ops-api`, `subscriptions-api` — delete the flag-off tests named in
  §0.3, keep the v2 ones, add the required deps.
- `feed` (`ingestItems` ×3), `api` (`ingestItems` + `POST /users` fixture),
  `federation-threading` (`ingestRemoteUser` ×3), `federation-following`
  (`addRemoteUser` ×2) — rework each fixture onto a surviving v2 path, or
  delete the individual test if its subject is the deleted function itself.
- `logical-runtime`, `logical-vertical`, `logical-v3-vertical`,
  `logical-v4-vertical`, `migration-cutover` — remove the `compose` /
  `assertLegacyStartupAllowed` sites per §0.1.

**CONVERT (add the required deps only — no deleted symbol, no flag-off test):**
`admin-overview`, `admin-users`, `admin`, `moderation`, `multi-session`,
`posts-edit`, `logical-reply-target`, `logical-routes`, `revisions`,
`api-follows`, `api-threading`, `auth` (plus its two `POST /users` sites),
`admin-settings`, `unfollow-cleanup`, `smoke`.

**Web**: ~14 test files follow their subjects 1:1; each web task's steps name
its own test file.


---

## Task 1: Close GAP 1 — purge expired outbound subscriptions

**Files:**
- Create: `core/src/housekeeping.ts`
- Modify: `core/src/server.ts:177-186`
- Test: `core/test/housekeeping.test.ts`

**Interfaces:**
- Consumes: `Repository.sweepAnonymousUsers(ttlDays: number): {swept: number}`
  (`core/src/domain/repository.ts`), `Repository.purgeExpiredSubscriptions(now: string): Promise<void>`
  (same file), `Config` (`core/src/config.ts`).
- Produces: `sweepHousekeeping(repo, config): Promise<{anonSwept: number}>` —
  Task nothing else depends on this; it is the release's one true addition.

**Why this needs its own cycle:** `repo.purgeExpiredSubscriptions()` deletes
from the **outbound** `subscriptions` table (peers following *our* feeds via
WebSub/rssCloud). Its only caller anywhere is `core/src/domain/push-in.ts:272`,
inside the v1 `runPollCycle` — which Task 6 deletes. The v2 scheduler's
`push.purgeExpired()` purges a **different** table (`push_subscriptions_v2`,
inbound). Zero test coverage exists for `purgeExpiredSubscriptions` today. This
is genuinely new production behavior riding inside a "deletion release" —
exactly the class of change that gets under-tested, so it gets a real
red-green cycle before Task 6 removes its only caller.

- [ ] **Step 1: Write the failing test**

```typescript
// core/test/housekeeping.test.ts
import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { loadConfig } from '../src/config.ts'
import { sweepHousekeeping } from '../src/housekeeping.ts'

test('sweepHousekeeping purges expired outbound subscriptions', async () => {
  const repo = await createSqliteRepository(':memory:')
  const now = new Date()
  const expired = new Date(now.getTime() - 1000).toISOString()
  const future = new Date(now.getTime() + 3600_000).toISOString()
  await repo.upsertSubscription({
    id: 'sub-expired', protocol: 'websub', topic: 'https://a.example/feed.xml',
    callback: 'https://hub.example/cb1', callbackHost: 'hub.example',
    secret: null, expiresAt: expired, createdAt: now.toISOString(),
  })
  await repo.upsertSubscription({
    id: 'sub-live', protocol: 'websub', topic: 'https://b.example/feed.xml',
    callback: 'https://hub.example/cb2', callbackHost: 'hub.example',
    secret: null, expiresAt: future, createdAt: now.toISOString(),
  })
  const config = loadConfig({ ...process.env, RSC_SOURCE_MODEL_V2: undefined })
  // Count with a cutoff far in the PAST so `expires_at > cutoff` is true for every
  // row — this counts rows ACTUALLY PRESENT, independent of expiry. Using
  // `new Date().toISOString()` here would be a FALSE GREEN: countActiveSubscriptions
  // (sqlite.ts:612-618) applies `WHERE expires_at > now` itself, so it excludes the
  // expired row whether or not the purge ever deleted it — the test would pass even
  // with the purge call removed. (Caught in review, 2026-07-26.)
  const EPOCH = '1970-01-01T00:00:00.000Z'
  expect(await repo.countActiveSubscriptions({}, EPOCH)).toBe(2) // both rows present
  await sweepHousekeeping(repo, config)
  expect(await repo.countActiveSubscriptions({}, EPOCH)).toBe(1) // sub-expired physically deleted
})
```

**This test MUST fail if the `purgeExpiredSubscriptions` call is removed from
`housekeeping.ts`.** Verify that explicitly (comment the call out, watch it go
red, restore it) — a test that cannot fail is not a test, and this one exists
solely to guard a call whose only other caller a later task deletes.

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec -T core npm run -w core test -- housekeeping.test.ts`
Expected: FAIL — `Cannot find module '../src/housekeeping.ts'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// core/src/housekeeping.ts
import type { Repository } from './domain/repository.ts'
import type { Config } from './config.ts'

// Runs on server.ts's hourly sweepTimer (V4 Task 11 GAP 1): v1's runPollCycle
// (domain/push-in.ts:272, now deleted) was the ONLY caller of
// purgeExpiredSubscriptions — it deletes from the OUTBOUND `subscriptions`
// table (peers who follow OUR feeds via WebSub/rssCloud). The v2 scheduler
// purges a DIFFERENT table (push_subscriptions_v2, inbound leases) — see
// logical/scheduler.ts — so this call has no v2 equivalent and must be wired
// in explicitly, or the outbound table grows unbounded forever.
export async function sweepHousekeeping(
  repo: Pick<Repository, 'sweepAnonymousUsers' | 'purgeExpiredSubscriptions'>,
  config: Config,
): Promise<{ anonSwept: number }> {
  const { swept } = repo.sweepAnonymousUsers(config.anonTtlDays)
  await repo.purgeExpiredSubscriptions(new Date().toISOString())
  return { anonSwept: swept }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec -T core npm run -w core test -- housekeeping.test.ts`
Expected: PASS

- [ ] **Step 5: Wire into `server.ts`'s existing hourly sweep**

In `core/src/server.ts`, replace lines 177-186:

```typescript
// BEFORE
let sweepTimer: NodeJS.Timeout
async function sweepLoop() {
  try {
    const { swept } = repo.sweepAnonymousUsers(config.anonTtlDays)
    if (swept > 0) console.log(`swept ${swept} abandoned anonymous account(s)`)
  } catch (err) {
    console.error('anon sweep failed:', err instanceof Error ? err.message : err)
  }
  sweepTimer = setTimeout(sweepLoop, 3600_000) // ponytail: fixed hourly cadence; config knob only if an operator ever asks
}
sweepTimer = setTimeout(sweepLoop, 3600_000)
```

```typescript
// AFTER
let sweepTimer: NodeJS.Timeout
async function sweepLoop() {
  try {
    const { anonSwept } = await sweepHousekeeping(repo, config)
    if (anonSwept > 0) console.log(`swept ${anonSwept} abandoned anonymous account(s)`)
  } catch (err) {
    console.error('housekeeping sweep failed:', err instanceof Error ? err.message : err)
  }
  sweepTimer = setTimeout(sweepLoop, 3600_000) // ponytail: fixed hourly cadence; config knob only if an operator ever asks
}
sweepTimer = setTimeout(sweepLoop, 3600_000)
```

Add the import near the top of `server.ts`: `import { sweepHousekeeping } from './housekeeping.ts'`

- [ ] **Step 6: Run the full core suite**

Run: `docker compose exec -T core npm run -w core test`
Expected: PASS, no regressions

- [ ] **Step 7: Typecheck**

Run: `docker compose exec -T core npm run -w core typecheck`
Expected: 0 errors

- [ ] **Step 8: Commit**

```bash
git add core/src/housekeeping.ts core/src/server.ts core/test/housekeeping.test.ts
git commit -m "core: purge expired outbound subscriptions on the hourly sweep

v1's runPollCycle was the only caller of purgeExpiredSubscriptions; deleting
it (V4 Task 11) would silently orphan the purge with no v2 equivalent — the
v2 scheduler purges a different table (push_subscriptions_v2, inbound).
Wire it into the existing hourly housekeeping sweep instead, with its own
test (previously zero coverage).

developed with the help of AI tools"
```

---

## Task 2: Fresh-install activation test (guards Task 13)

**Files:**
- Test: `core/test/fresh-install.test.ts`

**Interfaces:**
- Consumes: `createSqliteRepository` (`core/src/storage/sqlite.ts`),
  `activateLogicalV2`, `createDatabaseContext` (`core/src/logical/runtime.ts`,
  `core/src/logical/database.ts`).
- Produces: nothing new — this is a pure regression guard that Task 13 must
  keep passing.

**Why this needs its own cycle, before Task 13:** `logical/runtime.ts:21`
imports `runConversion` from `migration/convert.ts`, and `activateLogicalV2`
calls it via `convertLegacy` on the `never_activated` path (`:270,316`) — the
path a **brand-new Cloudron install** takes on its very first boot. Task 13
retires the migration machinery; this test must exist and pass **before** that
task starts, so Task 13 has a concrete, automated proof that a fresh instance
still boots and serves after the retirement (not just "no test broke" — a
review of Task 13's diff must show this exact test still green).

- [ ] **Step 1: Write the test (it should already pass — this step proves the CURRENT baseline, so Task 13 has something to break/keep-green against)**

```typescript
// core/test/fresh-install.test.ts
import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { activateLogicalV2 } from '../src/logical/runtime.ts'

test('a brand-new database activates v2 on first boot and serves a post', async () => {
  const repo = await createSqliteRepository(':memory:')
  const db = createDatabaseContext(repo.raw)
  const now = new Date().toISOString()

  // Simulates server.ts's boot sequence for a fresh install: never_activated,
  // zero legacy rows, activateLogicalV2 must convert trivially and activate.
  activateLogicalV2(db, now)

  const activation = db.read((tx) =>
    tx.prepare(`SELECT state FROM logical_activation_v2 WHERE singleton = 1`).get()
  ) as { state: string }
  expect(activation.state).toBe('active')

  // A fresh instance must actually be able to create and read a post through
  // the v2 path immediately after activation — not just report `active`.
  const user = await repo.createLocalUser({ handle: 'first', displayName: 'First' })
  const post = await repo.createPost({ authorId: user.id, content: 'hello, fresh install', now })
  expect(post.id).toBeTruthy()
})
```

- [ ] **Step 2: Run test to verify it PASSES on the current tree (baseline, not a red step — this establishes the guarantee Task 13 must not break)**

Run: `docker compose exec -T core npm run -w core test -- fresh-install.test.ts`
Expected: PASS. If this fails on the current tree, STOP — that is a pre-existing
bug unrelated to this plan and must be resolved before continuing to Task 13.

- [ ] **Step 3: Commit**

```bash
git add core/test/fresh-install.test.ts
git commit -m "test: pin fresh-install v2 activation before retiring migration machinery

V4 Task 11 (§H) retires most of migration/convert.ts, but a brand-new
Cloudron install still boots never_activated and runs convertLegacy
trivially over zero rows on first boot. This test is the concrete guard
Task 13 must keep green.

developed with the help of AI tools"
```

---

## Task 3: Pre-shrink the test suite — delete fully-superseded coverage

**Files:**
- Delete: `core/test/sse.test.ts`, `core/test/timeline-tabs.test.ts`,
  `core/test/federation.test.ts`, `core/test/federation-live.test.ts`,
  `core/test/ingest-discovery.test.ts`
- Modify: `core/test/ingest.test.ts` (remove only the one `test.fails()` +
  its comment block, lines 395-419 — the file's other `ingestRemoteUser`/
  `ingestItems`/`pollAll`-calling tests are removed later, in Task 7, paired
  with deleting those functions from production; removing them here would be
  premature since the functions still exist and are still called by
  `push-in.ts` until Task 6 runs)

**Interfaces:** none — this task only removes test files/sections proven
superseded by name in Part 0's table. No production code changes. Doing this
first shrinks what Tasks 4-8 have to touch and reason about.

- [ ] **Step 1: Confirm each deletion target's superseding coverage exists and passes**

Run: `docker compose exec -T core npm run -w core test -- logical-sse.test.ts logical-feeds.test.ts logical-routes.test.ts logical-vertical.test.ts`
Expected: all PASS (these are what Part 0 names as replacing the deleted
files' coverage — confirm before deleting, not after).

- [ ] **Step 2: Delete the five fully-superseded files**

```bash
git rm core/test/sse.test.ts core/test/timeline-tabs.test.ts core/test/federation.test.ts core/test/federation-live.test.ts core/test/ingest-discovery.test.ts
```

- [ ] **Step 3: Remove the `ingest.test.ts` fence**

In `core/test/ingest.test.ts`, delete the comment block and `test.fails()`
found at (per Part 0) approximately lines 395-419 — the block beginning
`// test.fails() INVERTS when that lands...` through the end of the
`test.fails('KNOWN BUG: one post reached by two subscription paths...')`
call. Do not touch anything else in the file.

- [ ] **Step 4: Confirm the census — zero `test.fails()` markers should now remain except the one in `federation-live.test.ts` (already deleted in Step 2, so truly zero)**

Run: `grep -rn "test\.fails\|it\.fails" core/test/`
Expected: no output.

- [ ] **Step 5: Run the full suite**

Run: `docker compose exec -T core npm run -w core test`
Expected: PASS (fewer tests than before; no failures)

- [ ] **Step 6: Commit**

```bash
git add -u core/test/ingest.test.ts
git commit -m "test: delete v1-route test files superseded by v2 coverage

sse.test.ts, timeline-tabs.test.ts, federation.test.ts, federation-live.test.ts,
and ingest-discovery.test.ts each exercise only routes/functions this V4 Task
11 release deletes; their coverage is fully superseded by logical-sse.test.ts,
logical-feeds.test.ts/logical-routes.test.ts, logical-vertical.test.ts's
positive dual-path proof, and (for ingest-discovery.test.ts) nothing — it is
GAP 2's v1-only autodiscovery feature, backlogged not preserved. Also removes
the last test.fails() fence in ingest.test.ts (the federation-live.test.ts
fence went with the whole file); the file's OTHER direct-ingest tests are
handled in Task 7, paired with deleting the functions they call. Zero
test.fails() markers remain.

developed with the help of AI tools"
```

---

## Task 4: Relocate `domain/push-in.ts`'s pure helpers into `logical/push.ts`

**Full file read confirms:** `push-in.ts`'s pure helpers (lines 16-50) and its
v1 runtime (`PushIn`/`PushInDeps`/`createPushIn`/`runPollCycle`, lines 52-273)
are NOT independently deletable in one step. `server.ts:84` calls
`createPushIn({repo, config})` **unconditionally** (not inside the v1/v2
branch), and `createPushIn`'s own internals (`maybeSubscribe`, `handleFatPing`,
`handleThinPing`) call `choosePushTarget`/`verifySignature`/`pushInEffective`
AND `ingest.ts`'s `ingestItems`/`ingestRemoteUser` directly (lines 158, 218,
225, 247). So the v1 runtime can only be deleted once `server.ts` stops
calling it — that's Task 6, not this one. **This task ONLY relocates the pure
helpers**; it makes no deletions in `push-in.ts` (a short-lived, deliberate
duplication — both files define the same six symbols until Task 6 deletes
`push-in.ts` entirely).

**Files:**
- Modify: `core/src/logical/push.ts` (add relocated helpers, replacing its
  import block)
- Modify: `core/src/logical/acquisition.ts:8` (re-point `choosePushTarget` import)
- Modify: `core/src/server.ts:14` (re-point `pushInEffective` import only —
  `createPushIn`/`runPollCycle` stay imported from `./domain/push-in.ts` here
  until Task 6)

**Interfaces:**
- Produces (from `logical/push.ts`, newly exported there — copies, not moves):
  `verifySignature(body: string, secret: string, header: string | null): boolean`,
  `choosePushTarget(discovery: FeedDiscovery, feedUrl: string): PushTarget | null`,
  `PushTarget` (interface), `PENDING_TTL_MS`, `WEBSUB_LEASE_SECONDS`,
  `WEBSUB_RENEW_HORIZON_MS`, `RSSCLOUD_TTL_MS`, `RSSCLOUD_RENEW_HORIZON_MS`,
  `RENEW_RETRY_FLOOR_MS`, `pushInEffective(config: Config): boolean`.

- [ ] **Step 1: Copy the six pure exports from `domain/push-in.ts` into `logical/push.ts`**

`domain/push-in.ts`'s exact current lines (confirmed by full read): `verifySignature`
16-26, `PushTarget` interface 28, `choosePushTarget` 30-39, the six constants
41-46, `pushInEffective` 48-50. **Copy** (do not cut) these into
`core/src/logical/push.ts`, replacing its current import block at lines 6,12-15:

```typescript
// BEFORE (logical/push.ts:6,12-15)
import type { PushTarget } from '../domain/push-in.ts'
...
import {
  pushInEffective, verifySignature, PENDING_TTL_MS, WEBSUB_LEASE_SECONDS, WEBSUB_RENEW_HORIZON_MS,
  RSSCLOUD_TTL_MS, RSSCLOUD_RENEW_HORIZON_MS, RENEW_RETRY_FLOOR_MS,
} from '../domain/push-in.ts'
```

```typescript
// AFTER (logical/push.ts) — the pure helpers now live HERE too (push-in.ts
// keeps its own copies for one more task — see Task 6, which deletes the
// whole file once server.ts stops calling createPushIn)
export function verifySignature(body: string, secret: string, header: string | null): boolean {
  if (!header) return false
  const i = header.indexOf('=')
  if (i <= 0) return false
  const algo = header.slice(0, i).toLowerCase()
  const hex = header.slice(i + 1)
  if (!SIGNATURE_ALGOS.has(algo) || !/^[0-9a-f]+$/i.test(hex)) return false
  const expected = createHmac(algo, secret).update(body).digest()
  const given = Buffer.from(hex, 'hex')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export interface PushTarget { mode: PushProtocol; endpoint: string; topic: string }

export function choosePushTarget(discovery: FeedDiscovery, feedUrl: string): PushTarget | null {
  if (discovery.hubs.length > 0) {
    return { mode: 'websub', endpoint: discovery.hubs[0], topic: discovery.self ?? feedUrl }
  }
  if (discovery.cloud && discovery.cloud.protocol === 'http-post') {
    const { domain, port, path } = discovery.cloud
    return { mode: 'rsscloud', endpoint: `${cloudScheme(port)}://${domain}:${port}${path}`, topic: feedUrl }
  }
  return null
}

export const PENDING_TTL_MS = 600_000 // 10 min (spec H3)
export const WEBSUB_LEASE_SECONDS = 864000 // 10 days requested
export const WEBSUB_RENEW_HORIZON_MS = 86_400_000 // renew when < 1 day left
export const RSSCLOUD_TTL_MS = 90_000_000 // 25 h
export const RSSCLOUD_RENEW_HORIZON_MS = 7_200_000 // renew when < 2 h left
export const RENEW_RETRY_FLOOR_MS = 3_600_000 // retry a due renewal at most hourly, not every tick

export function pushInEffective(config: Config): boolean {
  return config.pushIn && config.publicUrl !== null
}
```

`verifySignature` needs `createHmac, timingSafeEqual` from `node:crypto` and a
module-level `const SIGNATURE_ALGOS = new Set(['sha1','sha256','sha384','sha512'])`
— add both to `logical/push.ts` if not already present (check its existing
imports first; it may already import `randomBytes, randomUUID` from
`node:crypto`, in which case extend that import). `choosePushTarget` needs
`cloudScheme` from `../domain/push.ts` (already imported there per the file's
existing `import { checkCallbackUrl } from '../domain/push-guard.ts'` block —
verify and add `cloudScheme` alongside if missing).

Do NOT touch `logical/push.ts:20`'s `THIN_PING_FLOOR_MS = 30_000` restatement —
`push-in.ts:75`'s copy is module-private inside `createPushIn` and is deleted
with the whole file in Task 6; nothing to collapse in this task.

- [ ] **Step 2: Re-point `logical/acquisition.ts:8`**

```typescript
// BEFORE
import { choosePushTarget } from '../domain/push-in.ts'
```

```typescript
// AFTER
import { choosePushTarget } from './push.ts'
```

- [ ] **Step 3: Re-point ONLY `server.ts`'s `pushInEffective` import**

In `core/src/server.ts`, line 14 currently reads:

```typescript
import { createPushIn, runPollCycle, pushInEffective } from './domain/push-in.ts'
```

Split it — `pushInEffective` moves, `createPushIn`/`runPollCycle` stay (they
are still called at `server.ts:84,167` until Task 6):

```typescript
import { createPushIn, runPollCycle } from './domain/push-in.ts'
import { pushInEffective } from './logical/push.ts'
```

- [ ] **Step 4: Run the full core suite**

Run: `docker compose exec -T core npm run -w core test`
Expected: PASS — `push-in.ts`'s own copies of the six helpers are untouched,
so `createPushIn`/`runPollCycle` still work exactly as before; `acquisition.ts`
and `server.ts`'s `pushInEffective` call now resolve to the new (identical)
copy in `logical/push.ts`.

- [ ] **Step 5: Typecheck**

Run: `docker compose exec -T core npm run -w core typecheck`
Expected: 0 errors

- [ ] **Step 6: Commit**

```bash
git add core/src/logical/push.ts core/src/logical/acquisition.ts core/src/server.ts
git commit -m "core: relocate push-in.ts's pure helpers into logical/push.ts (copy, not cut)

V4 Task 11 step 1 of 3 for push-in.ts: acquisition.ts and server.ts now read
verifySignature/choosePushTarget/pushInEffective/the renewal constants from
logical/push.ts, their real long-term home. push-in.ts KEEPS its own copies
for now — server.ts still calls createPushIn/runPollCycle unconditionally
(server.ts:84,167), so the v1 runtime cannot be deleted until server.ts's
rewrite (next-next task) removes those calls. Deliberate short-lived
duplication, not a mistake.

developed with the help of AI tools"
```

---

## Task 5: `app.ts` — require `deps.sources`/`deps.logical`, delete v1 route registrations

**Full file read confirms the exact shape.** The v1/v2 split is duplicate route
registrations, and they fall into two distinct classes:
- **Shadowed by a v2 registration inside `app.ts` itself** (inside the
  `if (sources) {...}` block, lines 268-475): `/users/:handle/follows` (v2 at
  334-338, v1 at 558-562), `/users/:handle/following.opml` (v2 at 340-354, v1
  at 610-616), `POST /me/follows/opml` (v2 at 324-330, v1 at 618-636),
  `POST /me/subscriptions` (v2 at 276-308, v1 at 642-665, and the v1 one takes
  a `type` field the v2 one doesn't).
- **Shadowed by a v2 registration in a DIFFERENT FILE** (`logical-routes.ts`,
  mounted via `mountLogicalReadRoutes` at `app.ts:166` and `mountLogicalRoutes`
  at `app.ts:257` — both run BEFORE the v1 handlers below, per the file's own
  comment at :162-165): `GET /posts/:id/revisions` (v1 at 232-236),
  `GET /post/:id/thread` (v1 at 588-593), `GET /post/:id/comments.xml` (v1 at
  595-608), `GET /users/rss.xml` (v1 at 683-694), `GET /users/:handle/feed.xml`
  (v1 at 696-709), `GET /users/:handle/feed.json` (v1 at 711-716),
  `GET /timeline` (v1 at 764-817), `GET /timeline/stream` (v1 at 842-877, plus
  its only-used-here helper `withRootReplyCounts` at 825-840 and the
  `REPLAY_CAP` const at 94 — delete both once the route is gone; verify with
  `grep -n "withRootReplyCounts\|REPLAY_CAP" core/src/api/app.ts` that nothing
  else references them first).
- **No v2 replacement anywhere — delete entirely**: `POST /users` (179-196),
  `DELETE /users/:handle` (505-509), `GET /admin/feeds` (500-503).
- **Stay unchanged** (shared-path, dispatch differs only via `deps.pushInApi`,
  itself simplified in Task 6): `/hub`, `/rsscloud/pleaseNotify`,
  `/websub/callback/:token` GET+POST, `/rsscloud/notify` GET+POST.

**Files:**
- Modify: `core/src/api/app.ts`

**Interfaces:**
- Produces: `createApp`'s `sources` and `logical` become required (not
  optional) fields — every test file constructing `createApp` must supply them
  from this task onward (Task 8 converts the ones that don't yet).

- [ ] **Step 1: Make `deps.sources`/`deps.logical` required**

At `app.ts:133`:

```typescript
// BEFORE
export function createApp(deps: { service: Service; bus: EventBus; token: string; auth: Auth; users: UserDirectory; feeds?: FeedContext; pushApi?: PushApi; pushInApi?: PushInApi; mailEnabled?: boolean; adminEmails?: ReadonlySet<string>; websub?: string; pushIn?: boolean; sources?: { service: SourceService; repo: SourceRepository }; logical?: LogicalRouteDeps }): Hono {
```

```typescript
// AFTER
export function createApp(deps: { service: Service; bus: EventBus; token: string; auth: Auth; users: UserDirectory; feeds?: FeedContext; pushApi?: PushApi; pushInApi?: PushInApi; mailEnabled?: boolean; adminEmails?: ReadonlySet<string>; websub?: string; pushIn?: boolean; sources: { service: SourceService; repo: SourceRepository }; logical: LogicalRouteDeps }): Hono {
```

Note the `sources` shape is `{ service: SourceService; repo: SourceRepository }`
— an object, not a bare repository. Test files (Task 8) must construct this
exact shape, not pass a repository directly.

- [ ] **Step 2: Unwrap the two `if` guards**

At `app.ts:166`:
```typescript
// BEFORE
if (deps.logical) mountLogicalReadRoutes(app, { store: deps.logical.store, auth: deps.auth, users: deps.users, service, feeds })
```
```typescript
// AFTER
mountLogicalReadRoutes(app, { store: deps.logical.store, auth: deps.auth, users: deps.users, service, feeds })
```

At `app.ts:257`:
```typescript
// BEFORE
if (deps.logical) mountLogicalRoutes(app, deps.logical)
```
```typescript
// AFTER
mountLogicalRoutes(app, deps.logical)
```

At `app.ts:268-475`, remove the `if (sources) {` wrapper and its closing `}`
(keep everything between — lines 269-474 — at the same indentation level,
unconditionally registered). `const v2 = sources.service` and
`const v2repo = sources.repo` (currently lines 269-270) stay as-is.

- [ ] **Step 3: Delete the shadowed-by-app.ts-itself v1 duplicates**

Delete these four v1 registrations (each shadowed by an earlier v2
registration inside the former `if (sources)` block, now unconditional):
`app.ts:558-562` (`GET /users/:handle/follows`), `:610-616`
(`GET /users/:handle/following.opml`), `:618-636` (`POST /me/follows/opml`),
`:642-665` (`POST /me/subscriptions`).

- [ ] **Step 4: Delete the shadowed-by-logical-routes.ts v1 duplicates**

Delete: `app.ts:232-236` (`GET /posts/:id/revisions`), `:588-593`
(`GET /post/:id/thread`), `:595-608` (`GET /post/:id/comments.xml`),
`:683-694` (`GET /users/rss.xml`), `:696-709` (`GET /users/:handle/feed.xml`),
`:711-716` (`GET /users/:handle/feed.json`), `:764-817` (`GET /timeline`),
`:842-877` (`GET /timeline/stream`). Also delete `withRootReplyCounts`
(:825-840) and `REPLAY_CAP` (:94) — confirm first with
`grep -n "withRootReplyCounts\|REPLAY_CAP" core/src/api/app.ts` that both
disappear cleanly (only used by the route just deleted).

- [ ] **Step 5: Delete the no-replacement v1 routes**

Delete: `app.ts:179-196` (`POST /users`), `:505-509`
(`DELETE /users/:handle`), `:500-503` (`GET /admin/feeds`).

- [ ] **Step 5b: Collapse `GET /peers`'s v1 arm** (missing from an earlier draft)

`app.ts:569-586` is a single route with an internal branch, not a duplicate
registration — so it survives Steps 3-5 and must be handled explicitly:

```typescript
// BEFORE (app.ts:569-586)
app.get('/peers', async (c) => {
  if (sources !== undefined) {
    const feds = await sources.repo.listApprovedFederationSources()
    // ... builds `peers` from federation ...
    return c.json({ peers })
  }
  const peers = await service.listTextcastingPeers()
  return c.json({ peers: peers.map((u) => ({ handle: u.handle, displayName: u.displayName, feedUrl: u.feedUrl })) })
})
```

```typescript
// AFTER — `sources` is required now, so the v1 arm is unreachable
app.get('/peers', async (c) => {
  const feds = await sources.repo.listApprovedFederationSources()
  const peers: { handle: string; displayName: string; feedUrl: string }[] = []
  for (const f of feds) {
    let host: string
    try {
      host = new URL(f.canonicalUrl).host
    } catch {
      continue
    }
    peers.push({ handle: host, displayName: host, feedUrl: f.canonicalUrl })
  }
  return c.json({ peers })
})
```

This orphans a three-layer chain that Task 7 must then delete:
`service.listTextcastingPeers` (`core/src/domain/service.ts:185-187`) →
`Repository.listTextcastingPeers` (`core/src/domain/repository.ts:14`) →
its implementation (`core/src/storage/sqlite.ts:290`). Its only test is
`core/test/peers.test.ts:60`, deleted per Part 0 §0.3.

- [ ] **Step 5c: DISCLOSURE — delete the now-orphaned imports and helpers in the same commit**

`core/tsconfig.json` extends `tsconfig.base.json`, which sets `strict: true`
but **not** `noUnusedLocals` — so an unused import or helper left behind by
Steps 3-5b **will not fail typecheck and will not fail the suite**. Nothing
downstream catches them; they simply linger as dead code forever. Delete them
deliberately, now, in this same commit:

Now-unused **imports** in `app.ts`: `streamSSE` (only `/timeline/stream`),
`parseCursor`/`formatCursor` (only v1 `/timeline`), `importFollowingOpml`
(only the v1 OPML route), `checkCallbackUrl` and `localHandleForUrl` (only v1
`/me/subscriptions`), `hideResolvedReplyContext` (only v1 revisions),
`renderRssFeed`/`renderJsonFeed`/`renderCommentsFeed`/`injectSourceComments`/
`renderFirehoseRss`/`emittedGuid` (only the v1 feed routes), and the
`TimelineFilter`/`TimelineEntry` types (only v1 `/timeline` and
`withRootReplyCounts`).

Now-unused **module-level helpers** in `app.ts`: `isValidFeedUrl` (`:26-34`),
`isSubscriptionType` (`:40-42`), `resolveFeedUser` (`:669-679`), plus
`withRootReplyCounts` (`:825-840`) and `REPLAY_CAP` (`:94`) already named in
Step 4.

**Keep** (still used by surviving v2 routes — verified by symbol count):
`resolveUser` (10 refs, used by the v2 `/users/:handle/follows` and
`following.opml` at `:335,:341`), `buildFollowingOpml` (used by the v2 OPML
export at `:353`), `HandleTakenError` (still thrown by `PATCH /me` at `:537`),
`isString`/`readJsonBody`/`isAttributionMode`/`isAuditCategory`/`pageArgs`
(all used by the v2 control plane).

Verify at the end of this step with:
`grep -c "\bisValidFeedUrl\b\|\bisSubscriptionType\b\|\bresolveFeedUser\b\|\bstreamSSE\b" core/src/api/app.ts`
Expected: `0`.

- [ ] **Step 6: Collapse `service.instanceStats` and `/capabilities`**

At `app.ts:478`:
```typescript
// BEFORE
counts: service.instanceStats(sources !== undefined),
```
```typescript
// AFTER
counts: service.instanceStats(true),
```

At `app.ts:155-159`:
```typescript
// BEFORE
app.get('/capabilities', (c) => c.json(
  sources !== undefined
    ? { sourceModelV2: true, model: 'logical-v2', journalCursorVersion: JOURNAL_CURSOR_VERSION, streamProtocolVersion: STREAM_PROTOCOL_VERSION }
    : { sourceModelV2: false },
))
```
```typescript
// AFTER
app.get('/capabilities', (c) => c.json(
  { sourceModelV2: true, model: 'logical-v2', journalCursorVersion: JOURNAL_CURSOR_VERSION, streamProtocolVersion: STREAM_PROTOCOL_VERSION },
))
```

Do NOT rename the `sourceModelV2` field (Global Constraint — web reads it as
a wire contract).

- [ ] **Step 7: Run the full core suite — EXPECT MASS FAILURE**

Run: `docker compose exec -T core npm run -w core test`
Expected: many failures — every test file in Part 0's "CONVERT" rows now fails
to construct `createApp` (missing required `sources`/`logical`, or passing the
wrong shape for `sources`). This is expected and is exactly what Task 8 fixes.
Commit this task's production-code change alone; Tasks 5 and 8 should run
back-to-back (do not leave the tree red across a session boundary — Tasks 6-7
must land first per the dependency order below, THEN Task 8).

- [ ] **Step 8: Typecheck (production code only)**

Run: `docker compose exec -T core npm run -w core typecheck`
Expected: 0 errors in `core/src/**`; errors in test files are expected until
Task 8.

- [ ] **Step 9: Commit**

```bash
git add core/src/api/app.ts
git commit -m "core: require sources/logical in createApp, delete v1 route registrations

V4 Task 11: the v1/v2 split in app.ts was duplicate route registrations
shadowed by Hono's registration order — some shadowed by a v2 twin inside
this same file, some by logical-routes.ts (mounted earlier), some (POST
/users, DELETE /users/:handle, GET /admin/feeds) with no v2 replacement at
all. With deps.sources/deps.logical now required, every v1 registration is
unreachable dead code and is deleted, along with withRootReplyCounts/
REPLAY_CAP (only used by the deleted /timeline/stream). Test suite is
expected red until Task 8 converts every createApp call site.

developed with the help of AI tools"
```

---

## Task 6: `server.ts` rewrite — delete the v1 branch, `push-in.ts`, `compose`, `assertLegacyStartupAllowed`

**Full file read confirms the exact before/after.** This is where `push-in.ts`
finally becomes dead (its last caller, `server.ts:84`, is deleted here) and
where the dead-code cascade (`compose`, `workers`, the legacy poll loop) is
fully resolved — not just simplified.

**Files:** (this summary is kept in sync with Step 5 — if they ever disagree,
Step 5 is authoritative; it carries the verified line numbers)
- Modify: `core/src/server.ts` (full rewrite of lines 37-192 per below)
- Modify: `core/src/logical/runtime.ts` (delete `compose` at :360,
  `assertLegacyStartupAllowed` at :247)
- Delete: `core/src/domain/push-in.ts` (now genuinely dead — Task 4 already
  relocated everything else needs from it)
- Modify — **`compose`: 9 call sites across 4 files**:
  `core/test/logical-runtime.test.ts:50,54,55`,
  `core/test/logical-vertical.test.ts:104,126`,
  `core/test/logical-v3-vertical.test.ts:644,656`,
  `core/test/logical-v4-vertical.test.ts:97,311`
- Modify — `assertLegacyStartupAllowed`:
  `core/test/migration-cutover.test.ts:197,288,292,293`,
  `core/test/logical-v4-vertical.test.ts:94`; plus that file's `offFlagApp()`
  harness (from :88) and **all three** Part-A tests it feeds — `:123`, `:168`,
  `:194`
- Delete/rewrite: `core/test/push-in.test.ts` (keep only `verifySignature`/
  `choosePushTarget`/`pushInEffective` cases, re-pointed to `logical/push.ts`)
- Modify — **genuine re-points only** (these import relocated symbols):
  `core/test/logical-push.test.ts:14`,
  `core/test/logical-push-callbacks.test.ts:11` →
  `../src/logical/push.ts`. **`core/test/logical-v4-vertical.test.ts:11` is
  DELETED, not re-pointed** — it imports `createPushIn`, which this task
  deletes outright rather than relocating.

**Interfaces:**
- Consumes: Task 4 complete (helpers already relocated).
- Produces: `server.ts` constructs the logical store/runtime unconditionally;
  no `workers`, no legacy poll loop, no `pushIn` (v1) instance.

- [ ] **Step 1: Rewrite `server.ts`'s composition block**

```typescript
// BEFORE (server.ts:1-93, the relevant imports + composition)
import { createPushIn, runPollCycle, pushInEffective } from './domain/push-in.ts'
// ... (other imports unchanged) ...

let runtime: LogicalRuntime | null = null
let logicalStore: LogicalStore | undefined
let workers: { legacyPoll: boolean; legacyPushIn: boolean }
if (config.sourceModelV2) {
  const { createDatabaseContext } = await import('./logical/database.ts')
  const { createLogicalStore } = await import('./logical/store.ts')
  const { createAcquisition } = await import('./logical/acquisition.ts')
  const { createLogicalRuntime, compose } = await import('./logical/runtime.ts')
  const db = createDatabaseContext(repo.raw)
  logicalStore = createLogicalStore(db)
  const acquisition = createAcquisition({ db })
  runtime = createLogicalRuntime({ db, store: logicalStore, acquisition, config, notify: (sequence) => bus.emitSequenceHint(sequence) })
  await runtime.ready
  workers = compose({ sourceModelV2: true, runtime })
} else {
  const { assertLegacyStartupAllowed } = await import('./logical/runtime.ts')
  assertLegacyStartupAllowed(repo.raw)
  const act = repo.raw.prepare(`SELECT state FROM logical_activation_v2 WHERE singleton = 1`).get() as { state: string } | undefined
  if (act?.state === 'active') repo.raw.prepare(`UPDATE logical_activation_v2 SET state = 'reconciliation_required' WHERE singleton = 1`).run()
  workers = { legacyPoll: true, legacyPushIn: true }
}

const service = createService(repo, bus, config.publicUrl, logicalStore)
// ... mailer/auth unchanged ...
const push = createPush({ repo, config })
const pushIn = createPushIn({ repo, config })
if (config.pushIn && !config.publicUrl) console.log('push-in inactive: no public URL')
const sources = config.sourceModelV2
  ? (await import('./domain/source-service.ts')).createSourcePlane(repo, config.publicUrl, logicalStore)
  : undefined
const app = createApp({
  // ... service, bus, token, adminEmails, auth, users, mailEnabled, feeds, websub, pushIn unchanged ...
  sources,
  logical: runtime && logicalStore ? { store: logicalStore, acquisition: runtime.acquisition } : undefined,
  pushApi: /* unchanged */,
  pushInApi: !pushInEffective(config)
    ? undefined
    : runtime
      ? { websubVerify: (t, q) => runtime.push.websubVerify(t, q), websubDeliver: (t, b, s) => runtime.push.websubDeliver(t, b, s), rsscloudChallenge: (u, c) => runtime.push.rsscloudChallenge(u, c), rsscloudPing: (u) => runtime.push.rsscloudPing(u) }
      : workers.legacyPushIn
        ? { websubVerify: (t, q) => pushIn.handleWebSubVerification(t, q), websubDeliver: (t, b, s) => pushIn.handleFatPing(t, b, s, { bus }), rsscloudChallenge: (u, c) => pushIn.handleRssCloudChallenge(u, c), rsscloudPing: (u) => pushIn.handleThinPing(u, { bus }) }
        : undefined,
})

if (runtime && logicalStore) {
  const store = logicalStore
  mountLogicalHandleRoute(app, { raw: repo.raw })
  mountLogicalStreamRoute(app, { source: runtime.streamSource, bus, resolveViewer: /* unchanged */ })
  bus.onNewPost(() => { bus.emitSequenceHint(store.snapshot((tx) => tx.getJournalMetadata().highWaterSeq)) })
}

bus.onNewPost((e) => { void push.onLocalPost(e) })

let tick = 0
let pollTimer: NodeJS.Timeout | undefined
async function loop() {
  tick++
  try { await runPollCycle({ repo, bus, config, pushIn }, tick) }
  catch (err) { console.error('poll cycle failed:', err instanceof Error ? err.message : err) }
  pollTimer = setTimeout(loop, config.pollSeconds * 1000)
}
if (workers.legacyPoll) pollTimer = setTimeout(loop, config.pollSeconds * 1000)
```

```typescript
// AFTER — unconditional; workers/compose/pushIn(v1)/loop all gone
import { createDatabaseContext } from './logical/database.ts'
import { createLogicalStore } from './logical/store.ts'
import { createAcquisition } from './logical/acquisition.ts'
import { createLogicalRuntime } from './logical/runtime.ts'
import { pushInEffective } from './logical/push.ts'
// ... (createPushIn/runPollCycle imports deleted entirely; other imports unchanged) ...

const db = createDatabaseContext(repo.raw)
const logicalStore = createLogicalStore(db)
const acquisition = createAcquisition({ db })
const runtime = createLogicalRuntime({ db, store: logicalStore, acquisition, config, notify: (sequence) => bus.emitSequenceHint(sequence) })
await runtime.ready

const service = createService(repo, bus, config.publicUrl, logicalStore)
// ... mailer/auth unchanged ...
const push = createPush({ repo, config })
if (config.pushIn && !config.publicUrl) console.log('push-in inactive: no public URL')
const sources = (await import('./domain/source-service.ts')).createSourcePlane(repo, config.publicUrl, logicalStore)
const app = createApp({
  // ... service, bus, token, adminEmails, auth, users, mailEnabled, feeds, websub, pushIn unchanged ...
  sources,
  logical: { store: logicalStore, acquisition: runtime.acquisition },
  pushApi: /* unchanged */,
  pushInApi: !pushInEffective(config)
    ? undefined
    : { websubVerify: (t, q) => runtime.push.websubVerify(t, q), websubDeliver: (t, b, s) => runtime.push.websubDeliver(t, b, s), rsscloudChallenge: (u, c) => runtime.push.rsscloudChallenge(u, c), rsscloudPing: (u) => runtime.push.rsscloudPing(u) },
})

const store = logicalStore
mountLogicalHandleRoute(app, { raw: repo.raw })
mountLogicalStreamRoute(app, { source: runtime.streamSource, bus, resolveViewer: /* unchanged */ })
bus.onNewPost(() => { bus.emitSequenceHint(store.snapshot((tx) => tx.getJournalMetadata().highWaterSeq)) })

bus.onNewPost((e) => { void push.onLocalPost(e) })
// loop()/pollTimer/workers.legacyPoll deleted entirely — v2's scheduler
// (started by runtime.ready above) is the only acquisition path now.
```

`runtime`'s declared type changes from `LogicalRuntime | null` to
`LogicalRuntime` (no longer nullable) — update its `let`/type annotation
accordingly; same for `logicalStore` (`LogicalStore | undefined` →
`LogicalStore`).

- [ ] **Step 2: Update `createShutdown`'s `stopLoops` callback**

```typescript
// BEFORE
const handler = createShutdown({ server, repo, stopLoops: () => { if (pollTimer) clearTimeout(pollTimer); clearTimeout(sweepTimer); void runtime?.stop() } })
```
```typescript
// AFTER
const handler = createShutdown({ server, repo, stopLoops: () => { clearTimeout(sweepTimer); void runtime.stop() } })
```

- [ ] **Step 3: Delete `push-in.ts` entirely**

Confirm zero remaining importers:

Run: `grep -rn "domain/push-in" core/src core/test --include=*.ts`
Expected: only test files (Step 5 below re-points/trims them).

```bash
git rm core/src/domain/push-in.ts
```

- [ ] **Step 4: Delete `compose` and `assertLegacyStartupAllowed` from `runtime.ts`**

Delete `compose` (`:360-361`) and `assertLegacyStartupAllowed` (`:247`) — both
now have zero production callers (`server.ts` no longer calls either).

- [ ] **Step 5: Fix the test fallout** (three corrections vs. an earlier draft — see the notes)

**`compose` — 9 call sites across 4 files** (an earlier draft said "six across
three" and omitted `logical-v4-vertical` entirely):
`core/test/logical-runtime.test.ts:50,54,55`,
`core/test/logical-vertical.test.ts:104,126`,
`core/test/logical-v3-vertical.test.ts:644,656`,
`core/test/logical-v4-vertical.test.ts:97,311`.
Read each: if the test's only purpose was asserting `compose`'s return shape
(true of `logical-runtime:49-55`, which is literally named "compose fails
closed when configured v2 has no runtime"), delete the test; if `compose` was
incidental setup, remove just that call. Note `api-threading.test.ts` is NOT in
this list — its "reply compose" is a test name, not a call.

**`assertLegacyStartupAllowed`**: `core/test/migration-cutover.test.ts:197,288,292,293`
and `core/test/logical-v4-vertical.test.ts:94` — delete these cases.

**`offFlagApp()` — THREE Part-A tests, not one** (an earlier draft named only
`:123`): in `core/test/logical-v4-vertical.test.ts`, delete the `offFlagApp()`
harness (from `:88`) **and all three tests that use it**: `:123` ("OFF: the four
callback routes dispatch to the V1 push-in handlers"), `:168` ("OFF: the ops
route and every V4 admin field are absent"), `:194` ("OFF: preflight and
conversion never run"). Each asserts flag-off behaviour that no longer exists.

**`logical-v4-vertical.test.ts:11` is DELETED, not re-pointed** (an earlier
draft said "re-point it" — wrong): it imports `createPushIn`, which this task
deletes outright rather than relocating. The import goes away with the
`offFlagApp` harness at `:101` that used it. Only `verifySignature`,
`choosePushTarget`, `pushInEffective`, `PushTarget` and the six constants were
relocated to `logical/push.ts`; `createPushIn`/`runPollCycle` were not.

**Genuine re-points** (these import only relocated symbols):
`core/test/logical-push.test.ts:14`,
`core/test/logical-push-callbacks.test.ts:11` — change
`../src/domain/push-in.ts` → `../src/logical/push.ts`. (`logical-push-callbacks`
mentions `createPushIn` only in a comment at `:17`; it drives the handlers
directly, so nothing else changes there.)

**Rewrite `core/test/push-in.test.ts`**: keep only the cases exercising
`verifySignature`/`choosePushTarget`/`pushInEffective`, re-pointed to
`../src/logical/push.ts`; delete every case calling `createPushIn` or
`runPollCycle`.

- [ ] **Step 6: Run the full core suite**

Run: `docker compose exec -T core npm run -w core test`
Expected: PASS

- [ ] **Step 7: Typecheck**

Run: `docker compose exec -T core npm run -w core typecheck`
Expected: 0 errors

- [ ] **Step 8: Commit**

```bash
git add core/src/server.ts core/src/logical/runtime.ts core/test/logical-vertical.test.ts core/test/logical-v3-vertical.test.ts core/test/logical-runtime.test.ts core/test/migration-cutover.test.ts core/test/logical-v4-vertical.test.ts core/test/push-in.test.ts core/test/logical-push.test.ts core/test/logical-push-callbacks.test.ts
git rm core/src/domain/push-in.ts
git commit -m "core: delete server.ts's v1 branch, push-in.ts, compose(), assertLegacyStartupAllowed

V4 Task 11 step 2-3 of 3 for push-in.ts (see prior task): server.ts's
composition is now unconditional — no workers, no compose(), no v1 pushIn
instance, no legacy poll loop (v2's scheduler, started by runtime.ready, is
the only acquisition path). push-in.ts's v1 runtime (createPushIn,
runPollCycle, PushIn, PushInDeps) is deleted along with the file; its pure
helpers already live in logical/push.ts (prior task). The Task 8 startup
tripwire (assertLegacyStartupAllowed) and its offFlagApp() test harness
retire with the branch they guarded.

developed with the help of AI tools"
```

---

## Task 7: Split `domain/ingest.ts`, `domain/opml.ts`, `domain/subscribe.ts`; remove now-dead `service.ts` methods

**Full read of `service.ts` closes the dependency chain:** `mintRemoteUser`
(`subscribe.ts`) has exactly one caller — `service.ts:234`, inside
`subscribeByUrl` — which itself has exactly one caller — `app.ts:662`, the v1
`POST /me/subscriptions` handler Task 5 deleted. `service.addRemoteUser`
(`service.ts:49-51`) has exactly two callers — `app.ts:188` (`POST /users`)
and `app.ts:625` (v1 OPML import's `ImportDeps.addRemoteUser`) — both also
deleted by Task 5. So `subscribeByUrl` and `addRemoteUser` are now themselves
fully orphaned and must go too, which is what finally makes `mintRemoteUser`
deletable. `importFollowingOpml`'s only caller was `app.ts:618-636` (deleted
Task 5). `ingestItems`/`ingestRemoteUser`/`pollAll`'s only production caller
was `push-in.ts` (deleted Task 6); their remaining callers are the direct-call
tests handled in this task's Step 4.

**Files:**
- Modify: `core/src/domain/ingest.ts` (delete `ingestItems`, `ingestRemoteUser`
  — which takes its private helper `ingestViaDiscovery` with it — and `pollAll`)
- Modify: `core/src/domain/opml.ts` (delete `importFollowingOpml`)
- Modify: `core/src/domain/subscribe.ts` (delete `mintRemoteUser`)
- Modify: `core/src/domain/service.ts` (delete `addRemoteUser` at :49-51,
  `subscribeByUrl` at :227-247, and `listTextcastingPeers` at :185-187;
  remove the now-unused `mintRemoteUser` import at :6, keep `slugBase` if
  anything still calls it — see Step 3)
- Modify: `core/src/domain/repository.ts` (delete the `listTextcastingPeers`
  interface member at :14) and `core/src/storage/sqlite.ts` (delete its
  implementation at :290) — orphaned by Task 5 Step 5b's `/peers` collapse
- Modify: `core/src/domain/repository.ts:53-56` (delete `upsertPushSubscription`,
  `findPushSubscription`, `listRenewablePushSubscriptions`,
  `deletePushSubscription`), `core/src/storage/sqlite.ts:631-646` (their
  implementations), and `core/src/domain/repository-contract.ts:232-274` (their
  shared contract tests) — **added, found in Task 6's review**: `push-in.ts`
  was their sole production caller (`migration/convert.ts` reads the legacy
  `push_subscriptions` table by raw SQL, not through these methods, and that
  table itself is NOT dropped — see Non-goals). Verify with
  `grep -rn "upsertPushSubscription\|findPushSubscription\|listRenewablePushSubscriptions\|deletePushSubscription" core/src core/test`
  before deleting — confirm zero callers besides the three sites named above.
- Modify: `core/test/ingest.test.ts` (delete the ~15 direct-call tests named
  in Part 0's table; keep the 9 pure-parser ones)

**Interfaces:**
- Consumes: Task 5 (app.ts's v1 routes gone) AND Task 6 (push-in.ts gone) both
  complete.
- Produces: nothing new; `parseFeedWithMeta`, `mergeDiscovery`, `toParsedItem`,
  `ParsedItem`, `FeedDiscovery`, `FETCH_TIMEOUT_MS` continue unchanged from
  `ingest.ts`; `buildFollowingOpml`, `localHandleForUrl` continue from
  `opml.ts`; `slugBase` continues from `subscribe.ts` if Step 3 confirms
  another caller, else it is deleted too.

GAP 2 note: `ingestViaDiscovery` (the HTML-autodiscovery fallback) is
module-private to `ingestRemoteUser` and is deleted along with it — this is
correct, not an accidental loss of the backlogged feature. GAP 2 (Task 15)
backlogs REBUILDING this capability for v2; it does not require preserving the
v1 implementation, which would be untested and unreachable dead code the
moment this task's Step 4 removes its test coverage too.

- [ ] **Step 1: Confirm zero remaining production callers**

Run: `grep -rn "ingestItems\|ingestRemoteUser\b\|pollAll\b\|importFollowingOpml\|mintRemoteUser" core/src --include=*.ts`
Expected: only definitions in `ingest.ts`/`opml.ts`/`subscribe.ts` and (until
this task's Step 2 runs) their callers in `service.ts` — no `app.ts` or
`push-in.ts` hits (both already gone).

- [ ] **Step 2: Delete `service.ts`'s orphaned methods (including `listTextcastingPeers`)**

Also delete `listTextcastingPeers` (`service.ts:185-187`), its interface member
(`core/src/domain/repository.ts:14`) and its implementation
(`core/src/storage/sqlite.ts:290`) — orphaned by Task 5 Step 5b. Confirm first:
`grep -rn "listTextcastingPeers" core/src core/test --include=*.ts` should show
only these three definition sites (its only test, `peers.test.ts:60`, was
deleted in Task 8b per Part 0 §0.3).


```typescript
// DELETE from core/src/domain/service.ts (lines 49-51)
async addRemoteUser(input: NewRemoteUser) {
  return repo.createRemoteUser({ ...input, handle: normalizeHandle(input.handle) })
},
```

```typescript
// DELETE from core/src/domain/service.ts (lines 227-247)
async subscribeByUrl(user: User, url: string, type: 'person' | 'webfeed'): Promise<{ user: User; followed: boolean; created: boolean } | { error: 'cap' }> {
  const existing = await repo.getRemoteUserByFeedUrl(url)
  if (existing) return { user: existing, followed: await followUnlessExcluded(repo, user.id, existing), created: false }
  const cap = Number(await repo.getSetting('max_subs_per_user') ?? '500')
  if (await repo.countRemoteSubscriptions(user.id) >= cap) return { error: 'cap' }
  const base = slugBase(new URL(url).host)
  const target = await mintRemoteUser((i) => repo.createRemoteUser(i), base, url, url, type)
  if (!target) {
    const raced = await repo.getRemoteUserByFeedUrl(url)
    if (raced) return { user: raced, followed: await followUnlessExcluded(repo, user.id, raced), created: false }
    throw new DomainError('could not allocate a handle')
  }
  await repo.addFollow(user.id, target.id)
  return { user: target, followed: true, created: true }
},
```

At `service.ts:6`, remove `mintRemoteUser` from the import (keep `slugBase` for
now — Step 3 decides its fate): `import { slugBase, mintRemoteUser } from './subscribe.ts'`
→ `import { slugBase } from './subscribe.ts'` (revisit after Step 3).

Also remove `NewRemoteUser` from `service.ts`'s type imports if it becomes
unused (`grep -n "NewRemoteUser" core/src/domain/service.ts` after this step —
if only the now-deleted methods used it, drop it from the import at line 5).

- [ ] **Step 3: Delete `ingestItems`, `ingestRemoteUser`, `pollAll` from `ingest.ts`**

Delete `ingestItems` (lines 157-198), `ingestRemoteUser` (232-249, which takes
its private helper `ingestViaDiscovery`, lines 264-297, with it since nothing
else calls it), and `pollAll` (299-304). Leave `FETCH_TIMEOUT_MS`,
`parseFeedWithMeta`, `mergeDiscovery`, `toParsedItem`, `ParsedItem`,
`FeedDiscovery`, `fallbackGuid`, `toIsoOrNow`, `itemInReplyTo`, `httpOnly`,
`linksToDiscovery`, `parseLinkHeader`, `fetchFeedBody`, `looksLikeHtml` —
verify each survivor is still exported/used by running
`docker compose exec -T core npm run -w core typecheck` after this step (an unused-but-kept helper is a
type error only if it becomes genuinely orphaned; if `fetchFeedBody`/
`looksLikeHtml` become unused now that their only caller `ingestRemoteUser` is
gone, delete them too — check with
`grep -n "fetchFeedBody\|looksLikeHtml" core/src/domain/ingest.ts` first).

- [ ] **Step 4: Delete `importFollowingOpml` from `opml.ts`; delete `mintRemoteUser` from `subscribe.ts`; decide `slugBase`'s fate**

Delete `importFollowingOpml` (opml.ts:79-158) and its now-unused
`ImportDeps` interface/`isHttpUrl`/`flatten`/`Outline` helpers if nothing else
uses them (verify each with a grep first — `buildFollowingOpml`/
`localHandleForUrl`/`escapeXml` must survive, they're used elsewhere).

Delete `mintRemoteUser` from `subscribe.ts` (its only caller,
`service.subscribeByUrl`, is gone per Step 2).

Run: `grep -rn "slugBase" core/src --include=*.ts`
Expected: if the only remaining reference is `subscribe.ts`'s own definition
(both `service.ts:subscribeByUrl` and `opml.ts:importFollowingOpml` — its two
known callers — are now deleted), delete `slugBase` too and remove
`subscribe.ts`'s import of it from `service.ts:6` entirely. If the grep shows
another caller, keep it and note that caller here for the record.

- [ ] **Step 5: Trim `ingest.test.ts` to its 9 surviving pure-parser tests**

Per Part 0's table, delete every test calling `ingestRemoteUser`, `ingestItems`,
or `pollAll` (15 tests, including the already-fence-removed one from Task 3).
Keep only: "an item-level `<source>`…", "a non-http(s) item link…", "fallback
guids for (ab,c) and (a,bc)…", "a BOM-prefixed JSON Feed…", both
"parseFeedWithMeta yields/discovery…" tests, both `parseLinkHeader` tests, "RSS
permalink guid is the item url…" — all of which call only
`parseFeedWithMeta`/`parseLinkHeader`, never an ingest function. Remove the now
unused `ingestRemoteUser, pollAll, ingestItems` from the file's import line 4,
keeping `parseFeedWithMeta, parseLinkHeader, toParsedItem`.

- [ ] **Step 6: Run the full core suite**

Run: `docker compose exec -T core npm run -w core test`
Expected: PASS

- [ ] **Step 7: Typecheck**

Run: `docker compose exec -T core npm run -w core typecheck`
Expected: 0 errors

- [ ] **Step 8: Commit**

```bash
git add core/src/domain/ingest.ts core/src/domain/opml.ts core/src/domain/subscribe.ts core/src/domain/service.ts core/test/ingest.test.ts
git commit -m "core: delete v1-only functions from ingest.ts, opml.ts, subscribe.ts, service.ts

V4 Task 11: with app.ts's v1 routes (prior-prior task) and push-in.ts (prior
task) both gone, ingestItems/ingestRemoteUser/pollAll (ingest.ts),
importFollowingOpml (opml.ts), mintRemoteUser (subscribe.ts), and
addRemoteUser/subscribeByUrl (service.ts) all lose their last caller.
ingestViaDiscovery (GAP 2's v1 autodiscovery implementation) is
module-private to ingestRemoteUser and is deleted with it — the FEATURE is
backlogged (Task 15), not this untested v1 code. ingest.test.ts trims from
~24 to 9 tests (the pure parseFeedWithMeta/parseLinkHeader coverage, which
survives). Every other export (parseFeedWithMeta, mergeDiscovery,
buildFollowingOpml, etc.) is live v2 code and is untouched.

developed with the help of AI tools"
```

---

## Task 8a: Convert unbranched core test files (trivial signature fix)

**Files:**
- Modify: `core/test/admin-overview.test.ts`, `core/test/admin-users.test.ts`,
  `core/test/admin.test.ts`, `core/test/moderation.test.ts`,
  `core/test/multi-session.test.ts`, `core/test/posts-edit.test.ts`,
  `core/test/service.test.ts`, `core/test/logical-reply-target.test.ts`

**Interfaces:**
- Consumes: Task 5's required `createApp({sources: {service, repo}, logical, ...})`
  shape (note: `sources` is an object, not a bare repository — a real bug in
  an earlier draft of this plan, corrected here).

- [ ] **Step 1: For each file, add `sources`/`logical` to its `createApp` call — by mirroring an already-passing v2-aware test file, not by inventing the construction**

Do not guess the exact `SourceService`/`SourceRepository` construction from
partial knowledge — copy the working pattern from an existing test that
already exercises this required shape correctly, e.g.
`core/test/source-admin-api.test.ts` or `core/test/peers.test.ts` (read
whichever one first — both already pass `sources: {service, repo}` and
`logical` to `createApp`, since they are v2-aware and predate this plan).
Apply that exact construction to each of the eight files listed above,
alongside their existing `repo`/`bus`/`config`/`auth` setup.

- [ ] **Step 2: Run each file individually**

Run: `docker compose exec -T core npm run -w core test -- admin-overview.test.ts admin-users.test.ts admin.test.ts moderation.test.ts multi-session.test.ts posts-edit.test.ts service.test.ts logical-reply-target.test.ts`
Expected: PASS for all eight.

- [ ] **Step 3: Typecheck**

Run: `docker compose exec -T core npm run -w core typecheck`
Expected: 0 errors in these eight files (others still pending Task 8b).

- [ ] **Step 4: Commit**

```bash
git add core/test/admin-overview.test.ts core/test/admin-users.test.ts core/test/admin.test.ts core/test/moderation.test.ts core/test/multi-session.test.ts core/test/posts-edit.test.ts core/test/service.test.ts core/test/logical-reply-target.test.ts
git commit -m "test: supply required sources/logical to eight unbranched createApp calls

V4 Task 11: these files test functionality unrelated to the source model
(auth, local admin, local posting) and need only the mechanical
sources/logical addition Task 5's signature change requires — construction
mirrored from an existing v2-aware test file, not invented.

developed with the help of AI tools"
```

---

## Task 8b: Convert v2-response-shape core test files

**Files:**
- Modify: `core/test/admin-feeds.test.ts` (delete legacy assertions —
  per Part 0, fully superseded, likely reduces to nothing or is deleted
  outright if `source-admin-api.test.ts`/`source-control-integration.test.ts`
  already cover every case it exercised)
- Modify: `core/test/admin-settings.test.ts`, `core/test/api-follows.test.ts`,
  `core/test/api-threading.test.ts`, `core/test/api.test.ts`,
  `core/test/auth.test.ts`, `core/test/federation-following.test.ts`,
  `core/test/federation-threading.test.ts`, `core/test/feed.test.ts`,
  `core/test/revisions.test.ts`, `core/test/unfollow-cleanup.test.ts`
- Modify: `core/test/peers.test.ts`, `core/test/source-capability-api.test.ts`,
  `core/test/source-control-integration.test.ts`,
  `core/test/source-ops-api.test.ts`, `core/test/subscriptions-api.test.ts` —
  **added, found in Task 7's review**: Part 0 §0.3/§0.4 describe exactly what
  each needs (delete the flag-off test named in §0.3, keep the v2 test, add
  the required `sources`/`logical` deps) but none of these five files was
  actually claimed by any task's file list before this correction. Specifics
  per §0.3: `peers.test.ts:60` **already deleted in Task 7** (found there
  before this correction landed — nothing left to do for this file except
  add `sources`/`logical` to its remaining v2 test if not already present);
  `source-capability-api.test.ts`
  delete `:71,:86` and rewrite `:61` to assert the now-constant capabilities
  shape; `source-control-integration.test.ts` delete `:85`;
  `source-ops-api.test.ts` delete `:61`; `subscriptions-api.test.ts` delete
  `:25,42,56,66,77,88` (all POST the v1 `{url,type}` body), keep only the v2
  test at `:153`.

**Interfaces:**
- Consumes: Task 5's required deps shape; Task 7's deleted `mintRemoteUser`/
  `importFollowingOpml` (assertions against v1 subscribe/import shapes must
  become v2 assertions).

- [ ] **Step 1: `admin-feeds.test.ts` — verify full supersession, then delete or trim**

Compare its assertions one-by-one against `core/test/source-admin-api.test.ts`
and `core/test/source-control-integration.test.ts`. If every case is already
covered, delete the file:

```bash
git rm core/test/admin-feeds.test.ts
```

If any case is NOT covered (e.g. an assertion about a response field neither
v2 file checks), port that single case into `source-admin-api.test.ts` first,
then delete `admin-feeds.test.ts`.

- [ ] **Step 2: `admin-settings.test.ts` — update the `/me/subscriptions` assertion**

Its `POST /me/subscriptions` call now hits the v2 handler (v1 deleted in Task
7). Update the request body and expected response to the v2 shape: request
`{url, commandId}` (no `type` field per P4), response matches
`source-service.ts:98`'s `SubscribeResult` shape (check the real type before
writing the assertion). Add `sources`/`logical` to its `createApp` call per
Task 8a's pattern.

- [ ] **Step 3: `api-follows.test.ts` — update OPML import and follows-list assertions**

`POST /me/follows/opml` now hits `source-service.ts:130`'s `importOpml` (v2) —
update the fixture OPML and expected outcome to whatever v2's import produces
(subscriptions in `source_subscriptions_v2`, not legacy `follows` rows —
verify the exact expected shape by reading `importOpml`'s implementation).
`GET /users/:handle/follows` now hits `publicFollowing` (v2, `app.ts:334`) —
update the expected response shape to match (verify by reading
`publicFollowing`'s return type). Add `sources`/`logical` per the pattern.

- [ ] **Step 4: `api-threading.test.ts` — verify bounded-thread behavior (P6)**

`GET /post/:id/thread` now returns v2's bounded thread with placeholder
ancestor nodes (per P6) instead of v1's unbounded thread. Read
`core/test/logical-outbound-threading.test.ts` for the established assertion
pattern on placeholder nodes and mirror it here if this file's existing
assertions expect an unbounded thread. Add `sources`/`logical` per the pattern.

- [ ] **Step 5: `api.test.ts` — rework the `POST /users` fixture, keep the rest**

Its `/users` call is fixture setup (per Part 0), not the assertion under test.
Replace it with the same v2 seeding approach Task 9 establishes for
`smoke.ts` — read Task 9's `POST /ops/sources/federation` call shape and reuse
it here for fixture setup, OR (simpler, if this test only needs a row in
`users`/`remote_sources_v2` to exist) use `repo.createRemoteUser` directly if
that's all the downstream assertions require — check what the test actually
asserts about the created fixture before choosing. Add `sources`/`logical`.

- [ ] **Step 6: `auth.test.ts` — rework the two `/users` call sites**

Lines ~136,143 (`POST /users`) — these routes are gone. If the test's purpose
was checking auth-gating on an admin-only route, substitute an equivalent
still-existing admin route (e.g. `POST /admin/sources`) for the same
assertion (unauthenticated → 401/403). If the purpose was purely fixture
setup, use `repo.createRemoteUser` directly instead. Add `sources`/`logical`.

- [ ] **Step 7: `federation-following.test.ts`, `federation-threading.test.ts`, `feed.test.ts`, `revisions.test.ts` — add required deps, update response-shape assertions**

Each hits a same-path v2 registration. Read each file's current assertions
against the corresponding v2 handler's actual return shape (per Part 0:
`app.ts:340` for following.opml, `app.ts:334` for follows-list,
`logical-routes.ts:437,456,466` for the feed builders,
`logical-routes.ts:419` `projectHistory` for revisions — the last one
explicitly covers BOTH local and remote per the parity audit, so its
assertions may need a broader fixture, not a narrower one). Add
`sources`/`logical` per the pattern.

- [ ] **Step 8: `unfollow-cleanup.test.ts` — verify the cleanup path is shared, not v1-specific**

Before touching assertions, determine whether the orphan-cleanup logic this
file exercises (triggered via `repo.createRemoteUser` fixtures + an unfollow
action) is the same code path v2's own orphan handling uses, or a v1-specific
branch that Task 5/6 already removed access to. If it is shared code, add
`sources`/`logical` and confirm the test still passes unchanged. If it was
v1-specific and is now dead, confirm equivalent v2 orphan-cleanup coverage
exists elsewhere (search `core/test/` for `reapSourceIfOrphaned` or
`reapSource` test coverage) before deleting any assertion here — do not
delete cleanup-behavior coverage without a confirmed v2 replacement.

- [ ] **Step 9: Run the full core suite**

Run: `docker compose exec -T core npm run -w core test`
Expected: PASS, zero failures, zero `test.fails()`.

- [ ] **Step 10: Typecheck**

Run: `docker compose exec -T core npm run -w core typecheck`
Expected: 0 errors.

- [ ] **Step 11: Commit**

```bash
git add -A core/test/admin-settings.test.ts core/test/api-follows.test.ts core/test/api-threading.test.ts core/test/api.test.ts core/test/auth.test.ts core/test/federation-following.test.ts core/test/federation-threading.test.ts core/test/feed.test.ts core/test/revisions.test.ts core/test/unfollow-cleanup.test.ts
git add core/test/admin-feeds.test.ts 2>/dev/null || true
git commit -m "test: convert remaining core createApp callers to v2 response shapes

V4 Task 11: these files hit routes whose v1 handler is now gone and whose
v2 handler survives at the same path (or, for admin-feeds.test.ts, is fully
superseded and deleted). Updates assertions to v2 response shapes: OPML
import/follows-list, bounded thread with placeholders, subscribe without a
type field, and history covering local+remote. Suite is fully green with
zero test.fails() markers.

developed with the help of AI tools"
```

---

## Task 8c: Fix a live production bug — the housekeeping sweep silently fails on any v2 account that has posted

> ⚠ **Found during Task 8b, confirmed independently by the operator, added to
> this release by explicit decision — this is not in the original plan.**
> `logical_local_origins_v2.post_id` is `NOT NULL UNIQUE REFERENCES posts(id)
> ON DELETE RESTRICT` (`core/src/logical/schema.ts:66`). `deleteUserCascade`
> (`core/src/storage/sqlite.ts:609-625`) does `DELETE FROM posts WHERE
> author_id=?` with nothing clearing that table first. `sweepAnonymousUsers`
> (`sqlite.ts:1224-1250`) calls `this.deleteUserCascade(...)` for BOTH the
> idle-anonymous branch and the orphaned-core-user branch, and **both calls sit
> inside one `raw.transaction()`** — so a single FK violation rolls back the
> **entire sweep batch** for that hourly cycle, not just the offending account.
> This has been silently firing on all four production instances every hour
> since the v2 flip (2026-07-25): any idle anonymous account that posted at
> least once causes that cycle's whole housekeeping sweep to throw, caught by
> `server.ts`'s `try/catch` (from Task 1), logged, and forgotten. No data loss,
> no user-facing outage — accounts simply never get reaped.
>
> **The fix already exists and is proven correct**: `service.deleteLocalAccount`
> (`core/src/domain/service.ts:193-208`) already branches — when `logical` is
> present, it calls `logical.deleteLocalAccount({accountId, actorId, now})`
> (`core/src/logical/store.ts:374-375` → `core/src/logical/local.ts:269-283`),
> which runs `terminallyDelete(tx, p.id, now)` **per post** before touching
> `users` — this respects the FK. Route the sweep through the same call.

**Files:**
- Modify: `core/src/storage/sqlite.ts` (`sweepAnonymousUsers`, `:1224-1250`) —
  accept an optional deletion-strategy override so both branches can route
  through `logical.deleteLocalAccount` instead of `this.deleteUserCascade`
- Modify: `core/src/housekeeping.ts` (`sweepHousekeeping`) — thread a
  `LogicalStore`-shaped parameter through to `repo.sweepAnonymousUsers`
- Modify: `core/src/server.ts` (the `sweepLoop` call site) — pass the
  already-unconditionally-constructed `logicalStore` (Task 6 made this
  non-optional; there is no longer a "no logical" case in production)
- Test: `core/test/housekeeping.test.ts` (extend with the failing-then-passing
  reproduction)

**Interfaces:**
- Consumes: `LogicalStore.deleteLocalAccount(input: {accountId: string; actorId: string; now: string}): void`
  (`core/src/logical/store.ts:374-375` — verify the exact signature by reading
  it fresh; do not assume).
- Produces: nothing new for later tasks; this is a self-contained fix.

- [ ] **Step 1: Write the failing test — reproduce the actual FK violation**

Read `core/test/housekeeping.test.ts`'s current shape first (it already tests
GAP 1's purge). Extend it with a new test that:
1. Constructs a real `logical` (`createDatabaseContext(repo.raw)` +
   `createLogicalStore(db)` — the same pattern Task 1's and Task 2's own tests
   already use).
2. Creates an anonymous local user, backdates their session/creation so
   `sweepAnonymousUsers`'s idle check matches, and has them create a post
   THROUGH THE V2 PATH (`store.createLocalPost({...})` — the same call
   `service.createLocalPostAs`'s v2 branch makes — NOT `repo.insertPost`
   directly, which would not populate `logical_local_origins_v2` and would
   fail to reproduce the bug).
3. Calls `sweepHousekeeping(repo, config, logical)` (or however Step 2/3
   below end up shaping the call) and asserts it does **not** throw.
4. Asserts the user row is actually gone afterward (the sweep genuinely
   reclaimed the account, not just avoided crashing).

- [ ] **Step 2: Run it, confirm it fails for the RIGHT reason**

Run: `docker compose exec -T core npm run -w core test -- housekeeping.test.ts`
Expected: FAIL with `SqliteError: FOREIGN KEY constraint failed` (or the
transaction-wrapped equivalent) — NOT a different error. If it fails for any
other reason, your fixture doesn't reproduce the real bug yet; fix the
fixture before proceeding.

- [ ] **Step 3: Implement the fix**

Read `core/src/storage/sqlite.ts:1224-1250` (`sweepAnonymousUsers`) and
`core/src/domain/service.ts:193-208` (`deleteLocalAccount`, the pattern to
mirror) fresh — do not work from the line numbers/snippets above without
confirming them, prior tasks in this release repeatedly found drift between
a brief's citations and the real file. Modify `sweepAnonymousUsers` so BOTH
the idle-anonymous branch (`core: this.deleteUserCascade(core.id)`) and the
orphaned-core-user branch (`this.deleteUserCascade(o.id)`) route through
`logical.deleteLocalAccount({accountId: id, actorId: id, now})` when a
`logical` reference is available, falling back to `this.deleteUserCascade(id)`
only when it is not. `sqlite.ts` already imports from `../logical/schema.ts`,
`../logical/journal.ts`, `../logical/fanout.ts` — importing from
`../logical/local.ts` or typing the parameter against `LogicalStore` follows
existing precedent, it is not a new architectural direction.

Thread the parameter through `housekeeping.ts`'s `sweepHousekeeping` and
`server.ts`'s call site (which already holds `logicalStore` unconditionally,
per Task 6).

- [ ] **Step 4: Verify `deleteUserCascade`'s remaining callers precisely — do not assert, check**

Run: `grep -rn "deleteUserCascade" core/src --include=*.ts`
Expected: three remaining callers in `service.ts` (`removeFollow`'s
orphaned-self-serve-feed reap, `removeRemoteFeed`, and `deleteLocalAccount`'s
own `else`/flag-off branch). **Determine whether the first two (remote-feed
deletions) are actually subject to the same FK hazard** — a remote user's
posts are not necessarily materialized into `logical_local_origins_v2` the
same way a local user's are, but verify this from the schema/write paths
rather than assume it. If they ARE at risk, say so explicitly in your report
as a finding, not a fix (this task's scope is the housekeeping sweep only —
do not silently expand scope to fix a different call site without flagging
it). Write the comment on `deleteUserCascade` to accurately reflect what you
find, not the assumption in this brief.

- [ ] **Step 5: Run the test again — must now pass**

Run: `docker compose exec -T core npm run -w core test -- housekeeping.test.ts`
Expected: PASS — no FK error, and the account is confirmed gone.

- [ ] **Step 6: Run the full core suite + typecheck**

Run: `docker compose exec -T core npm run -w core test`
Run: `docker compose exec -T core npm run -w core typecheck`
Expected: `core/src` 0 errors; the suite should return to the Task 8b baseline
(957 passed / 1 failed — the one known `smoke.test.ts` failure Task 9 owns)
plus your new passing test, with no new failures anywhere.

- [ ] **Step 7: Commit**

```bash
git add core/src/storage/sqlite.ts core/src/housekeeping.ts core/src/server.ts core/test/housekeeping.test.ts
git commit -m "core: route the housekeeping sweep through logical.deleteLocalAccount

Found during Task 8b of the V1 retirement, confirmed against schema.ts and
sqlite.ts, and added to this release by explicit operator decision (same
class of finding as GAP 1 -- a live, silently-failing production defect
surfaced mid-implementation, with a bounded fix reusing already-proven v2
machinery).

logical_local_origins_v2.post_id is ON DELETE RESTRICT; deleteUserCascade's
raw DELETE FROM posts violates it whenever the deleted account has posted
under v2. sweepAnonymousUsers called deleteUserCascade for both its
idle-anonymous and orphaned-core-user branches inside ONE transaction, so a
single FK violation rolled back the entire hourly sweep batch, silently,
since the v2 flip (2026-07-25) -- caught by server.ts's try/catch, logged,
and never retried correctly. Routes both branches through
logical.deleteLocalAccount instead, mirroring service.deleteLocalAccount's
own existing v2 branch exactly.

developed with the help of AI tools"
```

---

## Task 9: Close GAP 3 — re-point `smoke.ts` and `federation-demo.mjs`

**Files:**
- Modify: `core/src/smoke.ts:26`
- Modify: `scripts/federation-demo.mjs:83`
- Modify: `core/test/smoke.test.ts` (pairs with the `smoke.ts` change)

**Interfaces:**
- Consumes: `POST /ops/sources/federation` (`core/src/api/app.ts:426`,
  `bearerAuth(token)`, body `{url, attributionMode, category, commandId}`,
  returns 201 on `established`).

- [ ] **Step 1: Re-point `smoke.ts`**

Read `core/src/smoke.ts` around line 26 (current: `POST /users`). Replace with
a call to `POST /ops/sources/federation`:

```typescript
// BEFORE (representative — confirm exact current body against the real file)
const seed = await app.request('/users', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ handle: 'seed', displayName: 'Seed', feedUrl: 'https://example.com/feed.xml' }),
})
```

```typescript
// AFTER
const seed = await app.request('/ops/sources/federation', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    url: 'https://example.com/feed.xml',
    attributionMode: 'aggregate',
    category: 'operator_policy',
    commandId: crypto.randomUUID(),
  }),
})
```

Update `smoke.ts`'s subsequent assertions (whatever verifies `seed`'s response)
to expect 201 + the `established` outcome shape instead of a created user.

- [ ] **Step 2: Re-point `scripts/federation-demo.mjs:83`**

Same substitution — read the current call at line 83, replace with the
identical `POST /ops/sources/federation` body shape as Step 1.

- [ ] **Step 3: Update `core/test/smoke.test.ts` to match**

- [ ] **Step 4: Run**

Run: `docker compose exec -T core npm run -w core test -- smoke.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/src/smoke.ts core/test/smoke.test.ts scripts/federation-demo.mjs
git commit -m "core: re-point smoke.ts and federation-demo.mjs off the deleted POST /users

GAP 3 (V4 Task 11 parity audit): both scripts seeded through the now-deleted
legacy remote-user route. Re-point to POST /ops/sources/federation, the
existing bearer-authenticated v2 equivalent.

developed with the help of AI tools"
```

---

## Task 10: Remove the `RSC_SOURCE_MODEL_V2` flag from `config.ts`

**Files:**
- Modify: `core/src/config.ts`
- Test: `core/test/config.test.ts` (or wherever `loadConfig` tests live —
  confirm the existing file before creating a new one)

**Interfaces:**
- Consumes: Tasks 4-9 complete (no code anywhere still branches on
  `config.sourceModelV2`).

- [ ] **Step 1: Confirm zero remaining references**

Run: `grep -rn "sourceModelV2" core/src --include=*.ts`
Expected: only `config.ts` itself (about to be deleted) — if anything else
appears, STOP and resolve it before proceeding (a missed branch here means an
earlier task is incomplete).

- [ ] **Step 2: Write the regression test FIRST (red)**

```typescript
// core/test/config.test.ts (add to existing file, or create if none exists — check first)
import { test, expect } from 'vitest'
import { loadConfig } from '../src/config.ts'

test('a stale RSC_SOURCE_MODEL_V2 env var does not prevent boot', () => {
  // Deploy-safety guarantee (V4 Task 11 §C): the unset-var-first deploy order
  // is belt-and-braces, not the only guard — loadConfig must never fail on an
  // env var it no longer reads.
  expect(() => loadConfig({ ...process.env, RSC_SOURCE_MODEL_V2: 'on' })).not.toThrow()
})
```

- [ ] **Step 3: Run to verify it currently PASSES (baseline — confirms the claim is already true before removal, since `loadConfig` has no unknown-key rejection)**

Run: `docker compose exec -T core npm run -w core test -- config.test.ts`
Expected: PASS (the claim holds even before Step 4 — this is a regression
guard for the removal about to happen, not a red-green step for new logic).

- [ ] **Step 4: Remove the flag from `config.ts`**

```typescript
// BEFORE (config.ts:13, in the Config interface)
  sourceModelV2: boolean
```
```typescript
// AFTER — delete the line entirely
```

```typescript
// BEFORE (config.ts:72-74)
  const rawSourceModelV2 = env.RSC_SOURCE_MODEL_V2 ?? 'off'
  if (rawSourceModelV2 !== 'on' && rawSourceModelV2 !== 'off') throw new Error(`RSC_SOURCE_MODEL_V2 must be "on" or "off", got "${rawSourceModelV2}"`)
  const sourceModelV2 = rawSourceModelV2 === 'on'
```
```typescript
// AFTER — delete all three lines
```

```typescript
// BEFORE (config.ts:103, in the returned object)
    sourceModelV2,
```
```typescript
// AFTER — delete the line entirely
```

- [ ] **Step 5: Run the test again (still green — proves removal didn't break the guarantee)**

Run: `docker compose exec -T core npm run -w core test -- config.test.ts`
Expected: PASS

- [ ] **Step 6: Run the full core suite**

Run: `docker compose exec -T core npm run -w core test`
Expected: PASS

- [ ] **Step 7: Typecheck**

Run: `docker compose exec -T core npm run -w core typecheck`
Expected: 0 errors

- [ ] **Step 8: Commit**

```bash
git add core/src/config.ts core/test/config.test.ts
git commit -m "core: remove the RSC_SOURCE_MODEL_V2 flag

V4 Task 11: v2 is now the only model; the flag and its parsing are deleted.
loadConfig reads only explicitly named env keys with no unknown-key
rejection, so a stale RSC_SOURCE_MODEL_V2=on left on an instance cannot
crash boot — pinned with a regression test. The unset-first deploy order
(see the plan's Global Constraints / Rollout section) remains belt-and-braces.

developed with the help of AI tools"
```

---

## Task 11a: Web — `lib/api.ts` + `lib/types.ts`

**Files:**
- Modify: `web/src/lib/api.ts:280-300`
- Modify: `web/src/lib/types.ts:5-7`
- Test: `web/src/lib/api.test.ts` (adjust capability-probe tests)

**Interfaces:**
- Produces: `Capabilities` becomes a single non-discriminated shape:
  `{model: 'logical-v2', journalCursorVersion: number, streamProtocolVersion: number}`
  — every later web task (11b-11e) reads this new shape.

- [ ] **Step 1: Collapse `Capabilities` in `lib/types.ts`**

```typescript
// BEFORE (types.ts:5-7)
export type Capabilities =
	| { sourceModelV2: false }
	| { sourceModelV2: true; model: 'logical-v2'; journalCursorVersion: number; streamProtocolVersion: number }
```

```typescript
// AFTER
export interface Capabilities {
	model: 'logical-v2'
	journalCursorVersion: number
	streamProtocolVersion: number
}
```

- [ ] **Step 2: Simplify `getCapabilities` in `lib/api.ts`**

```typescript
// BEFORE (api.ts:283-300)
let capabilities: Capabilities | null = null
export async function getCapabilities(f: typeof fetch): Promise<Capabilities> {
	if (capabilities) return capabilities
	try {
		const res = await f(`${base()}/capabilities`)
		if (!res.ok) return { sourceModelV2: false }
		const body = (await res.json()) as { sourceModelV2?: unknown; journalCursorVersion?: unknown; streamProtocolVersion?: unknown }
		if (body.sourceModelV2 !== true) return (capabilities = { sourceModelV2: false })
		return (capabilities = {
			sourceModelV2: true,
			model: 'logical-v2',
			journalCursorVersion: typeof body.journalCursorVersion === 'number' ? body.journalCursorVersion : 1,
			streamProtocolVersion: typeof body.streamProtocolVersion === 'number' ? body.streamProtocolVersion : 1
		})
	} catch {
		return { sourceModelV2: false }
	}
}
```

```typescript
// AFTER — /capabilities always reports the v2 shape now (core Task 5); a
// probe failure (core down, pre-deploy blip) still degrades gracefully by
// returning safe defaults rather than throwing, but there is no legacy mode
// to degrade INTO anymore — callers that previously branched on
// cap.sourceModelV2 now just use the fields directly.
let capabilities: Capabilities | null = null
export async function getCapabilities(f: typeof fetch): Promise<Capabilities> {
	if (capabilities) return capabilities
	const defaults: Capabilities = { model: 'logical-v2', journalCursorVersion: 1, streamProtocolVersion: 1 }
	try {
		const res = await f(`${base()}/capabilities`)
		if (!res.ok) return defaults
		const body = (await res.json()) as { journalCursorVersion?: unknown; streamProtocolVersion?: unknown }
		return (capabilities = {
			model: 'logical-v2',
			journalCursorVersion: typeof body.journalCursorVersion === 'number' ? body.journalCursorVersion : 1,
			streamProtocolVersion: typeof body.streamProtocolVersion === 'number' ? body.streamProtocolVersion : 1
		})
	} catch {
		return defaults
	}
}
```

Also update `peekCapabilities` (the synchronously-memoized reader, referenced
just below this block per the earlier read) — it no longer needs to check
`.sourceModelV2` for anything; read its current body before editing and strip
any now-meaningless branch.

- [ ] **Step 3: Update `lib/api.test.ts`**

Read the existing capability-probe tests; update expectations to the new
non-discriminated shape (no more asserting `{sourceModelV2:false}` on a
probe failure — assert the `defaults` object instead).

- [ ] **Step 4: Run web tests in-container**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- api.test.ts`
Expected: PASS

- [ ] **Step 5: svelte-check**

Run: `docker compose exec -T web npm run check -w web`
Expected: errors in every file that still reads `.sourceModelV2` — this is
expected; Tasks 11b-11e fix them next. Do NOT fix other files in this task.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/api.ts web/src/lib/types.ts web/src/lib/api.test.ts
git commit -m "web: collapse the Capabilities union — v2 is the only model

V4 Task 11: getCapabilities no longer returns a discriminated
{sourceModelV2:false} legacy variant; a probe failure degrades to safe v2
defaults instead. Every downstream page's cap.sourceModelV2 branch becomes
a type error until the next four tasks remove it — that is the intended
signal for what remains to convert.

developed with the help of AI tools"
```

---

## Task 11b: Web — `+page.server.ts` (home) + `stream/+server.ts`

**Files:**
- Modify: `web/src/routes/+page.server.ts`
- Modify: `web/src/routes/stream/+server.ts`
- Test: `web/src/routes/page.load.test.ts`,
  `web/src/routes/page.load.coldpod.test.ts`,
  `web/src/routes/stream/server.test.ts`

**Interfaces:**
- Consumes: Task 11a's collapsed `Capabilities`.
- Produces: the home load no longer has a `v1P`/cold-pod-alongside-call path;
  `journalCursor` and `sourceModelV2` (renamed away) simplify.

**This is the highest-risk web task** (largest v1 branch; `stream/+server.ts`
is keyed on `?v2=1`, not `sourceModelV2`, so it was invisible to a grep-based
inventory — do not skip it).

- [ ] **Step 1: Simplify `+page.server.ts`'s load**

```typescript
// BEFORE (full current file — see plan research; key lines 3,10-18,20-99)
import { getTimeline, getPeers, getFollowing, createPost, subscribeToFeed, deletePost, getCapabilities, peekCapabilities, subscribeToSource } from '$lib/api'
import { getLogicalTimeline, type V2Lens } from '$lib/logical-api'
// ... tabLens defined ...
export const load: PageServerLoad = async ({ fetch, url, parent }) => {
	// ...
	try {
		const known = peekCapabilities()
		const v1P = known?.sourceModelV2 ? null : getTimeline(fetch, { before, topLevel: true, ...tabFilter(tab, me?.user.handle) })
		v1P?.catch(() => {})
		const followingP = tab === 'personal' && isFirstPage && me ? getFollowing(fetch, me.user.handle) : Promise.resolve(null)
		followingP.catch(() => {})
		const cap = await getCapabilities(fetch)
		let timeline, nextCursor
		let journalCursor: string | null | undefined
		if (cap.sourceModelV2) {
			;({ entries: timeline, nextCursor, journalCursor } = await getLogicalTimeline(fetch, { before, ...tabLens(tab, me?.user.handle) }))
		} else {
			;({ timeline, nextCursor } = await v1P!)
		}
		// ...
		const followIds = following && me ? [me.user.id, ...(cap.sourceModelV2 ? (following as unknown as PublicFollowingEntry[]).filter((e) => e.kind === 'local').map((e) => e.id) : following.filter((u) => u.feedType !== 'instance').map((u) => u.id))] : undefined
		return { /* ... */ sourceModelV2: cap.sourceModelV2 || undefined, journalCursor, subscribeCommandId: cap.sourceModelV2 ? crypto.randomUUID() : undefined }
	} catch { /* ... */ }
}
```

```typescript
// AFTER — no capability branch, no v1 alongside-call, no cold-pod hazard
// (that machinery existed solely to race a legacy call against a probe that
// might report v1; with only one model there is nothing to race).
import { getPeers, getFollowing, createPost, deletePost, subscribeToSource } from '$lib/api'
import { getLogicalTimeline, type V2Lens } from '$lib/logical-api'
// ... tabLens unchanged (already v2-only, per its own comment) ...
export const load: PageServerLoad = async ({ fetch, url, parent }) => {
	// ... before/addedFeed/sub/subscribed/isFirstPage/me/tab unchanged ...
	try {
		const followingP = tab === 'personal' && isFirstPage && me ? getFollowing(fetch, me.user.handle) : Promise.resolve(null)
		followingP.catch(() => {})
		const { entries: timeline, nextCursor, journalCursor } = await getLogicalTimeline(fetch, { before, ...tabLens(tab, me?.user.handle) })
		const following = await followingP
		const peers = await getPeers(fetch).catch(() => [])
		const followIds = following && me
			? [me.user.id, ...(following as unknown as PublicFollowingEntry[]).filter((e) => e.kind === 'local').map((e) => e.id)]
			: undefined
		return {
			timeline: enrichEntries(timeline), nextCursor, isFirstPage, peers, addedFeed, subscribed, tab, followIds,
			journalCursor,
			subscribeCommandId: crypto.randomUUID()
		}
	} catch {
		return { timeline: [], nextCursor: null, isFirstPage, coreDown: true, peers: [], addedFeed, tab }
	}
}
```

In the `actions.subscribe` action, remove the `getCapabilities(...).sourceModelV2`
branch — keep only the v2 body (the `commandId`/`subscribeToSource` path); delete
the `type`-select fallback entirely (Global reminder: this is the P1 caveat
already recorded in the spec, not a new decision).

- [ ] **Step 2: Simplify `stream/+server.ts`**

```typescript
// BEFORE (lines 15-21,47-65,95)
const url = new URL(request.url)
const v2 = url.searchParams.get('v2') === '1'
// ...
const upstreamUrl = `${base()}${v2 ? '/stream' : '/timeline/stream'}`
// ... enrichV1 defined (lines 47-64) ...
const enrichFrame = v2 ? enrichV2 : enrichV1
```

```typescript
// AFTER — always the v2 journal stream; enrichV1 deleted entirely
const url = new URL(request.url)
const upstreamUrl = `${base()}/stream`
// ... (enrichV1 function body deleted)
const enrichFrame = enrichV2
```

The client no longer needs to pass `?v2=1` — but leave the query param
tolerant (harmless if present) rather than making it an error, since Task 11c
(the `+page.svelte` effect) is what actually stops sending it; sequence-safe
either order.

- [ ] **Step 3: Update tests**

`web/src/routes/page.load.test.ts` and `page.load.coldpod.test.ts` — the
cold-pod test file's entire premise (racing a legacy call against a capability
probe) no longer applies; delete it if every case it covers is now moot, or
convert surviving cases (e.g. "core down entirely" still needs a coreDown
test) into `page.load.test.ts`. `stream/server.test.ts` — remove any
`enrichV1`/non-`v2=1` test cases, keep the v2 frame-translation cases.

- [ ] **Step 4: Run in-container**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- page.load.test.ts stream/server.test.ts`
Expected: PASS

- [ ] **Step 5: svelte-check**

Run: `docker compose exec -T web npm run check -w web`
Expected: fewer errors than Task 11a's end-state; remaining errors are in
Tasks 11c-11e's files.

- [ ] **Step 6: Commit**

```bash
git add web/src/routes/+page.server.ts web/src/routes/stream/+server.ts web/src/routes/page.load.test.ts web/src/routes/stream/server.test.ts
git rm -f web/src/routes/page.load.coldpod.test.ts 2>/dev/null || true
git commit -m "web: remove the cold-pod v1-alongside-call from the home load; stream proxy always serves v2

V4 Task 11: the home load's peekCapabilities()/v1P racing machinery existed
only to avoid running a legacy call ahead of a slow capability probe — with
one model there is nothing to race. stream/+server.ts's ?v2=1 branch (keyed
independently of sourceModelV2, and invisible to a grep-based flag
inventory) collapses to always proxying /stream and always using enrichV2.

developed with the help of AI tools"
```

---

## Task 11c: Web — river surfaces (`+page.svelte`, `following/*`)

**Files:**
- Modify: `web/src/routes/+page.svelte`
- Modify: `web/src/routes/u/[handle]/following/+page.server.ts`,
  `web/src/routes/u/[handle]/following/+page.svelte`
- Test: `web/src/routes/page.actions.test.ts`,
  `web/src/routes/u/[handle]/following/following.actions.test.ts`

**Interfaces:**
- Consumes: Task 11a/11b's simplified capability + stream contract.

- [ ] **Step 1: `+page.svelte` — remove the v1 `<LiveTimeline>` mount and the `type`-select fallback**

```svelte
<!-- BEFORE (lines 143-147) -->
<!-- V1 uses the legacy `event: post` firehose; V2 wires its own upsert/remove/
     reset stream in the effect above. Mount at most one. -->
{#if data.isFirstPage && !data.sourceModelV2}
	<LiveTimeline {onPost} />
{/if}
```

```svelte
<!-- AFTER — delete the block entirely; the journal-stream $effect (already
     present above, lines 57-107) is the only live mechanism now. -->
```

Remove the now-unused `LiveTimeline` import and `onPost` function if nothing
else references them (check: `onPost` at line 41 feeds `applyRiverEvent` —
confirm whether the `$effect`'s own `onFrame` handler at lines 70-86 already
covers everything `onPost` did, or whether `onPost` is still called from
elsewhere before deleting it).

```svelte
<!-- BEFORE (lines 170-180) -->
{#if data.sourceModelV2}
	<input type="hidden" name="commandId" value={data.subscribeCommandId} />
{:else}
	<label class="visually-hidden" for="sub-type">Subscription type</label>
	<select id="sub-type" name="type">
		<option value="webfeed" selected>a site or publication</option>
		<option value="person">an individual</option>
	</select>
{/if}
```

```svelte
<!-- AFTER -->
<input type="hidden" name="commandId" value={data.subscribeCommandId} />
```

Simplify the `$effect` at line 61 — drop the `data.sourceModelV2` check from
`if (!data.sourceModelV2 || !data.isFirstPage || !data.journalCursor) return`,
leaving `if (!data.isFirstPage || !data.journalCursor) return`.

- [ ] **Step 2: `u/[handle]/following/+page.server.ts` and `+page.svelte` — delete the v1 arm**

Read both files in full (not yet read in this planning pass — confirm exact
current shape before editing). Per the spec's inventory (`+page.server.ts`
lines 44,54,61,135; `+page.svelte` line 53), delete each `{:else}`/`else`
v1 arm (legacy river, `getFollowing`, `importOpml`) keeping only the v2 arm
(v2 river, `getOwnerFollowing`/`publicFollowing`, `importOpmlV2`,
`unsubscribeSource`). The `<LiveTimeline>` mount at `+page.svelte:53` is
deleted outright (per P3 — this page never got the v2 journal stream; that
restoration is explicitly out of scope, see Task 15/ideas.md).

- [ ] **Step 3: Update tests**

`page.actions.test.ts` — remove the `type`-select subscribe assertion, keep
only the v2 `commandId` form assertion. `following.actions.test.ts` — remove
v1-arm assertions, keep v2.

- [ ] **Step 4: Run in-container**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- page.actions.test.ts following.actions.test.ts`
Expected: PASS

- [ ] **Step 5: svelte-check**

Run: `docker compose exec -T web npm run check -w web`
Expected: fewer remaining errors (Tasks 11d-11e's files only).

- [ ] **Step 6: Commit**

```bash
git add web/src/routes/+page.svelte "web/src/routes/u/[handle]/following/+page.server.ts" "web/src/routes/u/[handle]/following/+page.svelte" web/src/routes/page.actions.test.ts "web/src/routes/u/[handle]/following/following.actions.test.ts"
git commit -m "web: delete v1 river arms — home LiveTimeline, subscribe type-select, following page

V4 Task 11: the home page's legacy event:post firehose mount, the
subscribe form's person/webfeed select, and the following page's v1
river/OPML-import/LiveTimeline arms are all dead once the v1 model is
gone. P3 (no live prepend on this page under v2) is a pre-existing,
already-live limitation — not addressed here, tracked separately.

developed with the help of AI tools"
```

---

## Task 11d: Web — item surfaces (`post/[id]/*`, `p/[publisherId]`, `u/[handle]/*`)

**Files:**
- Modify: `web/src/routes/post/[id]/+page.server.ts`,
  `web/src/routes/post/[id]/+page.svelte`,
  `web/src/routes/post/[id]/edit/+page.server.ts`,
  `web/src/routes/post/[id]/history/+page.server.ts`,
  `web/src/routes/post/[id]/thread.json/+server.ts`,
  `web/src/routes/u/[handle]/+page.server.ts`,
  `web/src/routes/u/[handle]/+page.svelte`,
  `web/src/routes/p/[publisherId]/+page.server.ts` (**was missing from an
  earlier draft** — it carries a real branch at `:16-17`, see Step 5b),
  `web/src/routes/admin/sources/[sourceId]/+page.server.ts` (dead v2-only
  guard cleanup only — see Step 5)
- Test: `web/src/routes/post/[id]/edit/edit.actions.test.ts`,
  `web/src/routes/post/[id]/history/history.load.test.ts`,
  `web/src/routes/post/[id]/thread.render.test.ts`,
  `web/src/routes/u/[handle]/u-page.test.ts`,
  `web/src/routes/p/[publisherId]/publisher.load.test.ts`

**Interfaces:**
- Consumes: Task 11a's collapsed `Capabilities`.

- [ ] **Step 1: `post/[id]/+page.server.ts`**

```typescript
// BEFORE (full current file, lines 8-26)
export const load: PageServerLoad = async ({ fetch, params }) => {
	try {
		const cap = await getCapabilities(fetch)
		if (cap.sourceModelV2) {
			const t = await getLogicalThread(fetch, params.id)
			return { postId: params.id, thread: enrichEntries(t?.entries ?? []), rootId: t?.rootId ?? params.id, sourceModelV2: true }
		}
		const thread = await getThread(fetch, params.id)
		return { postId: params.id, thread: enrichEntries(thread), rootId: thread[0]?.id ?? params.id }
	} catch {
		return { postId: params.id, thread: [], rootId: params.id, coreDown: true }
	}
}
```

```typescript
// AFTER
import type { PageServerLoad, Actions } from './$types'
import { fail, redirect } from '@sveltejs/kit'
import { createPost, deletePost } from '$lib/api'
import { getLogicalThread } from '$lib/logical-api'
import { enrichEntries } from '$lib/server/render'
import { authedFetch, cookieHeader, ensureSessionFetch } from '$lib/server/session'

export const load: PageServerLoad = async ({ fetch, params }) => {
	try {
		const t = await getLogicalThread(fetch, params.id)
		return { postId: params.id, thread: enrichEntries(t?.entries ?? []), rootId: t?.rootId ?? params.id }
	} catch {
		return { postId: params.id, thread: [], rootId: params.id, coreDown: true }
	}
}
// actions block unchanged
```

- [ ] **Step 2: `post/[id]/+page.svelte`**

Delete the `<LiveTimeline>` v1 arm at line 76 (same P3 caveat as Task 11c —
already-live, out of scope to restore).

- [ ] **Step 3: `post/[id]/edit/+page.server.ts`, `history/+page.server.ts`, `thread.json/+server.ts`**

Read each file in full; delete the `if (cap.sourceModelV2) {...} else {...}`
pattern (or, per `thread.json/+server.ts:16-17`, its equivalent branch),
keeping the v2 arm.

- [ ] **Step 4: `u/[handle]/+page.server.ts`**

```typescript
// BEFORE (full current file, lines 1-53)
import { getTimeline, getCapabilities, peekCapabilities } from '$lib/api'
// ...
export const load: PageServerLoad = async ({ fetch, params, url }) => {
	const before = url.searchParams.get('before') ?? undefined
	const isFirstPage = !before
	try {
		const known = peekCapabilities()
		const v1P = known?.sourceModelV2 ? null : getTimeline(fetch, { before, author: params.handle })
		v1P?.catch(() => {})
		const cap = await getCapabilities(fetch)
		let timeline, nextCursor
		if (cap.sourceModelV2) {
			const publisherId = await reservedPublisher(fetch, params.handle)
			if (publisherId) throw redirect(308, `/p/${publisherId}`)
			;({ entries: timeline, nextCursor } = await getLogicalRiverOrEmpty(fetch, { before, author: params.handle }))
		} else {
			;({ timeline, nextCursor } = await v1P!)
		}
		return { handle: params.handle, timeline: enrichEntries(timeline), nextCursor, isFirstPage, sourceModelV2: cap.sourceModelV2 || undefined }
	} catch (e) {
		if (isRedirect(e)) throw e
		return { handle: params.handle, timeline: [], nextCursor: null, isFirstPage, coreDown: true }
	}
}
```

```typescript
// AFTER
import type { PageServerLoad } from './$types'
import { redirect, isRedirect } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { getLogicalRiverOrEmpty } from '$lib/logical-api'
import { enrichEntries } from '$lib/server/render'

async function reservedPublisher(f: typeof fetch, handle: string): Promise<string | null> {
	const res = await f(`${env.CORE_API_URL ?? 'http://localhost:8787'}/handles/${encodeURIComponent(handle)}`)
	if (!res.ok) return null
	const body = (await res.json()) as { reserved?: unknown; publisherId?: unknown }
	return body.reserved === true && typeof body.publisherId === 'string' ? body.publisherId : null
}

export const load: PageServerLoad = async ({ fetch, params, url }) => {
	const before = url.searchParams.get('before') ?? undefined
	const isFirstPage = !before
	try {
		const publisherId = await reservedPublisher(fetch, params.handle)
		if (publisherId) throw redirect(308, `/p/${publisherId}`)
		const { entries: timeline, nextCursor } = await getLogicalRiverOrEmpty(fetch, { before, author: params.handle })
		return { handle: params.handle, timeline: enrichEntries(timeline), nextCursor, isFirstPage }
	} catch (e) {
		if (isRedirect(e)) throw e
		return { handle: params.handle, timeline: [], nextCursor: null, isFirstPage, coreDown: true }
	}
}
```

- [ ] **Step 5b: `p/[publisherId]/+page.server.ts` — the v2-only 404 guard becomes dead**

```typescript
// BEFORE (p/[publisherId]/+page.server.ts:3,16-17)
import { getCapabilities } from '$lib/api'
// ...
	const cap = await getCapabilities(fetch)
	if (!cap.sourceModelV2) throw error(404, 'no such page')
```

```typescript
// AFTER — the guard's condition is now always false; the page is
// unconditionally available. Delete both lines and the now-unused
// getCapabilities import (keep the `error` import — the load still 404s on an
// unknown publisher further down; verify by reading the rest of the file).
```

Update `web/src/routes/p/[publisherId]/publisher.load.test.ts` accordingly:
delete any case asserting the flag-off 404, keep the unknown-publisher 404.

- [ ] **Step 5: `u/[handle]/+page.svelte`, `admin/sources/[sourceId]/+page.server.ts`**

Delete the `<LiveTimeline>` v1 arm in the former (line ~80, same P3 caveat).
In the latter, the v2-only 404 guard at lines 67-68 becomes dead (always
true) — simplify to remove the now-meaningless condition, keeping the guard's
actual 404 behavior for an unknown source id.

- [ ] **Step 6: Update tests**

Update each of the four named test files, removing v1-arm assertions and any
`sourceModelV2` echoing in expected load-return shapes.

- [ ] **Step 7: Run in-container**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- edit.actions.test.ts history.load.test.ts thread.render.test.ts u-page.test.ts publisher.load.test.ts`
Expected: PASS

- [ ] **Step 8: svelte-check**

Run: `docker compose exec -T web npm run check -w web`
Expected: only Task 11e's admin files remain as errors.

- [ ] **Step 9: Commit**

```bash
git add "web/src/routes/post/[id]/+page.server.ts" "web/src/routes/post/[id]/+page.svelte" "web/src/routes/post/[id]/edit/+page.server.ts" "web/src/routes/post/[id]/history/+page.server.ts" "web/src/routes/post/[id]/thread.json/+server.ts" "web/src/routes/u/[handle]/+page.server.ts" "web/src/routes/u/[handle]/+page.svelte" "web/src/routes/admin/sources/[sourceId]/+page.server.ts" "web/src/routes/post/[id]/edit/edit.actions.test.ts" "web/src/routes/post/[id]/history/history.load.test.ts" "web/src/routes/post/[id]/thread.render.test.ts" "web/src/routes/u/[handle]/u-page.test.ts" "web/src/routes/p/[publisherId]/+page.server.ts" "web/src/routes/p/[publisherId]/publisher.load.test.ts"
git commit -m "web: delete v1 arms from post/thread/user-page surfaces

V4 Task 11: post/[id], its edit/history sub-pages, thread.json, and
u/[handle] all keep only their v2 arm. Two more LiveTimeline mounts
removed (P3, already-live limitation, unchanged). The reserved-handle
redirect and getLogicalRiverOrEmpty river are unaffected — they were
already v2-only.

developed with the help of AI tools"
```

---

## Task 11e: Web — admin surfaces (trivial tail)

**Files:**
- Modify: `web/src/routes/admin/feeds/+page.server.ts`,
  `web/src/routes/admin/feeds/+page.svelte`,
  `web/src/routes/admin/items/[id]/+page.server.ts`,
  `web/src/routes/admin/sources/[sourceId]/runs/+page.server.ts`
- Test: `web/src/routes/admin/feeds/source-actions.test.ts`

**Interfaces:**
- Consumes: Task 5 (core) already deleted `GET /admin/feeds`, `POST /users`,
  `DELETE /users/:handle`; this task deletes web's now-unreachable legacy UI.

- [ ] **Step 1: `admin/feeds/+page.server.ts` and `+page.svelte`**

Per the spec's confirmed finding (§D — the legacy add/remove forms live inside
`{:else}` at `+page.svelte:179-215`, already unreachable in v2 mode with no
replacement work needed): delete the entire `mode: 'legacy'` branch from the
load (`+page.server.ts:109`, the `listAdminFeeds` call and its `feeds` return
shape), delete the `add`/`remove` actions (`:141,155`) and their `$lib/api`
imports (`listAdminFeeds`, `addRemoteUser`, `removeRemoteFeed`), and delete
the `{:else}` markup block in `+page.svelte:179-215` along with its enclosing
`{#if data.mode === 'v2'}` (the condition is now always true — remove the
conditional, keep its body unconditionally).

- [ ] **Step 2: `admin/items/[id]/+page.server.ts`, `admin/sources/[sourceId]/runs/+page.server.ts`**

Read each file; these are v2-only pages whose only "legacy" trace is a 404
guard for the flag-off case — simplify away the now-always-false branch,
keeping the real 404-on-missing-id behavior.

- [ ] **Step 3: Update `source-actions.test.ts`**

Remove every assertion targeting the deleted `add`/`remove` legacy actions and
`mode: 'legacy'` load path; keep the v2 `establish`/`source`/`tombstone`
action assertions (unaffected by this task).

- [ ] **Step 4: Run in-container**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- source-actions.test.ts`
Expected: PASS

- [ ] **Step 5: svelte-check — full web suite should now be clean**

Run: `docker compose exec -T web npm run check -w web`
Expected: 0 errors, repo-wide.

- [ ] **Step 6: Full web test suite**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web`
Expected: PASS, no regressions.

- [ ] **Step 7: Commit**

```bash
git add "web/src/routes/admin/feeds/+page.server.ts" "web/src/routes/admin/feeds/+page.svelte" "web/src/routes/admin/items/[id]/+page.server.ts" "web/src/routes/admin/sources/[sourceId]/runs/+page.server.ts" web/src/routes/admin/feeds/source-actions.test.ts
git commit -m "web: delete admin/feeds' unreachable legacy add/remove UI

V4 Task 11: the {:else} legacy arm at admin/feeds/+page.svelte:179-215 was
already unreachable in v2 mode with no replacement needed (P1's operator
add/remove caveat is inherited, not created here). Full web suite and
svelte-check are clean.

developed with the help of AI tools"
```

---

## Task 12: Retire env and docs surface

**Files:**
- Modify: `/.env.example:33`, `core/.env.example:22`
- Modify: `docs/superpowers/documentation/RUNNING.md` (remove `:167` RSC_TOKEN
  row's v1 note, `:176` env table row, the entire `## Source model v2` runbook
  section `:524-680`, `:815`, `:916`; correct `:167` and `:554-562` for **P2**
  — the ops token no longer has ANY destructive feed-removal reach, since
  `DELETE /users/:handle` is gone and every `/admin/*` route is
  session-admin-only)
- Modify: `docs/superpowers/documentation/2026-07-25-user-journey-checklist.md:12,145`
- Modify: `.claude/skills/hono/SKILL.md` (**added — found in Task 5's review,
  not in the original plan**: this skill is MANDATORY reading per root
  CLAUDE.md for any future `core/` routing work, and it currently teaches
  deleted v1 patterns as canonical examples — `/timeline/stream` as the SSE
  example, `isValidFeedUrl` as the validation example, `adminOrToken`. Update
  every example to a surviving v2 route before this release ships, or a
  future task will be misled by its own mandatory reference doc.)

**Interfaces:** none — documentation only.

- [ ] **Step 1: Remove `RSC_SOURCE_MODEL_V2` from both `.env.example` files**

Delete line 33 in the root file and line 22 in `core/.env.example`.

- [ ] **Step 2: Remove the RUNNING.md runbook section and stale references**

Delete the `## Source model v2` section (lines 524-680) in full, and the
references at `:167,176,815,916`.

- [ ] **Step 3: Correct RUNNING.md for P2**

At the former `:167` and `:554-562`, add or correct a note: the ops token's
`Authorization: Bearer $RSC_TOKEN` no longer reaches any destructive
feed-removal operation — `DELETE /users/:handle` is gone, and blocking/purging
a source now requires session-admin auth (`/admin/*`). This is a security
improvement but changes any operator runbook that assumed token-based removal.

- [ ] **Step 4: Update the user-journey checklist**

Remove or update the two referenced lines to reflect v2-only operation.

- [ ] **Step 5: Commit**

```bash
git add .env.example core/.env.example docs/superpowers/documentation/RUNNING.md "docs/superpowers/documentation/2026-07-25-user-journey-checklist.md"
git commit -m "docs: retire the RSC_SOURCE_MODEL_V2 runbook and env references

V4 Task 11: the flag and its whole runbook section are gone. Corrects
RUNNING.md's ops-token documentation for P2 — the token's destructive
feed-removal reach (DELETE /users/:handle) no longer exists; block/purge
requires session-admin auth.

developed with the help of AI tools"
```

---

## Task 13: Document the migration machinery as LIVE — delete nothing but the CLI

> ⚠ **This task's premise is the REVERSE of the spec's §H draft, and of this
> plan's own earlier draft.** Both claimed the migration machinery was
> retireable "since all four instances are converted." **That is false**, and
> the error came from a path-pattern grep (`from './preflight`) that cannot
> match the real import (`from '../migration/preflight.ts'`). Verified facts:
>
> - `core/src/logical/runtime.ts:19-20` imports `loadManifest`, `runPreflight`
>   and the `Manifest` type from `../migration/preflight.ts`.
> - `core/src/logical/runtime.ts:21` imports `runConversion` from
>   `../migration/convert.ts`.
> - `convertLegacy` calls `loadManifest` at `:273` and `runPreflight` at
>   `:282`, then `runConversion` at `:286` — **unconditionally**, on the
>   `never_activated` path, which is exactly the path a brand-new Cloudron
>   install takes on its first boot.
> - `core/package.json:10` wires `"preflight": "node src/migration/preflight-cli.ts"`
>   as an npm script, so `preflight-cli.ts` is not orphaned either — it is an
>   operator-invocable tool.
> - `core/test/migration-preflight.test.ts` and
>   `core/test/migration-convert.test.ts` therefore test **live production
>   code**, not dead code. The "~1,400 deletable test lines" from the ledger
>   scan is wrong for the same reason.
>
> **Deleting `preflight.ts` or `convert.ts` would break the first boot of every
> new install** — the precise scenario Task 2's fresh-install test exists to
> protect, and one that no test against the four already-converted production
> instances could ever catch.

**Files:**
- Modify: `docs/superpowers/specs/2026-07-25-v1-retirement-design.md` (§H must
  be corrected — it currently records the false premise)
- Modify: `core/src/logical/runtime.ts` (add the clarifying comment in Step 3)
- **Delete NOTHING** in `core/src/migration/` except, optionally, Step 4's CLI.

**Interfaces:**
- Consumes: **Task 2's fresh-install test must exist and pass BEFORE this task
  starts** — it is the concrete guard proving the machinery is live.
- Produces: no code deletion; a corrected spec and a durable code comment so a
  future reader does not re-derive the same wrong conclusion.

- [ ] **Step 1: Confirm the fresh-install test passes (pre-condition)**

Run: `docker compose exec -T core npm run -w core test -- fresh-install.test.ts`
Expected: PASS. If not, STOP — return to Task 2.

- [ ] **Step 2: Re-confirm the live-import chain with a SYMBOL grep (not a path grep)**

Run: `grep -rn "loadManifest\|runPreflight\|runConversion" core/src --include=*.ts`
Expected: hits in `core/src/logical/runtime.ts` (lines 19, 21, 273, 282, 286),
`core/src/migration/preflight.ts`, `core/src/migration/convert.ts`, and
`core/src/migration/preflight-cli.ts`. The `runtime.ts` hits are the proof
that this machinery is live on the fresh-install path. If this grep ever
returns NO `runtime.ts` hits, the situation has changed and this task must be
re-derived from scratch.

- [ ] **Step 3: Record the finding in code, so it is not re-derived wrongly**

Add above `convertLegacy` in `core/src/logical/runtime.ts` (adjacent to the
existing "Preflight + conversion, inside the caller's write transaction"
comment at `:266-269`):

```typescript
// LIVE ON THE FRESH-INSTALL PATH — do not "retire" this as cutover-only
// machinery. activateLogicalV2 reaches convertLegacy whenever activation state
// is `never_activated`, which is every brand-new install's FIRST BOOT, not just
// a legacy cutover. loadManifest/runPreflight (migration/preflight.ts) and
// runConversion (migration/convert.ts) all run there, trivially, over zero
// legacy rows. Deleting either module would break first boot for every new
// install while leaving already-converted instances working — a regression no
// test against existing production can catch. core/test/fresh-install.test.ts
// is the guard; keep it green.
```

- [ ] **Step 4: Decide the CLI (the ONLY candidate, and it is optional)**

`core/src/migration/preflight-cli.ts` + its `core/package.json:10` script are
the sole genuinely-retireable piece: they exist for an operator to dry-run
preflight against a legacy database BEFORE a cutover, and no future cutover
will happen (the flag is gone after Task 10). It imports `preflight.ts`, which
stays regardless.

**Default: KEEP it.** It is ~15 lines, costs nothing, imports only live code,
and a read-only diagnostic against a restored old backup is exactly the kind of
tool that is missed the day it is wanted. Delete it only on an explicit
operator instruction; if deleted, remove `core/package.json:10` in the same
commit.

- [ ] **Step 5: Correct the spec's §H**

In `docs/superpowers/specs/2026-07-25-v1-retirement-design.md`, replace §H's
"(a) keep the trivial fresh-activation path / (b) proven no-op" framing with
the verified finding above: the migration machinery is **live**, nothing in
`core/src/migration/` is deleted, and the backup caveat is **withdrawn** — a
pre-cutover backup remains convertible precisely because the converter stays.

- [ ] **Step 6: Re-run the fresh-install test — must still pass**

Run: `docker compose exec -T core npm run -w core test -- fresh-install.test.ts`
Expected: PASS, unchanged from Step 1 (this task changes no behaviour).

- [ ] **Step 7: Run the full core suite + typecheck**

Run: `docker compose exec -T core npm run -w core test && npm run -w core typecheck`
Expected: PASS, 0 errors.

- [ ] **Step 8: Commit**

```bash
git add core/src/logical/runtime.ts docs/superpowers/specs/2026-07-25-v1-retirement-design.md
git commit -m "docs+core: record that the migration machinery is LIVE, not retireable

V4 Task 11 §H reversal. The spec and an earlier plan draft both claimed
migration/preflight.ts + convert.ts were dead once every instance was
converted. They are not: runtime.ts:19-21 imports loadManifest/runPreflight/
runConversion and convertLegacy calls all three unconditionally on the
never_activated path — every NEW install's first boot. Deleting them would
break first boot for new installs while leaving converted instances working,
which no test against current production could catch. Nothing under
core/src/migration/ is deleted; the finding is recorded in code so it is not
re-derived wrongly, and the spec's backup caveat is withdrawn.

developed with the help of AI tools"
```

---

## Task 14 (SEPARATE — own review gate): Collapse the five lockstep duplications

**This task is deliberately its own gate, not folded into any deletion task's
tail.** It touches five files across three subsystems (write path, projection
overlay, admin store) purely for debt reduction — a distinct kind of change
from everything above and worth an independent review, even though it is
sequenced last.

**Files:**
- Create: `core/src/logical/roots.ts`
- Modify: `core/src/logical/local.ts` (delete `deriveRoot`, import from
  `roots.ts`), `core/src/logical/runtime.ts` (delete `deriveRoot`, import),
  `core/src/logical/store.ts` (delete `adminDeriveRoot`, import `deriveRoot`
  as `adminDeriveRoot` or re-export under that name — verify which callers
  expect which name before choosing)
- Modify: `core/src/logical/acquisition.ts` (delete `normalizePermalink`,
  import from a shared home), `core/src/logical/reconcile.ts` (delete
  `normalizePermalink`, import)
- Delete: `core/test/logical-lockstep.test.ts`

**Interfaces:**
- Produces: `deriveRoot(tx: ReadTx, id: string): string` from
  `core/src/logical/roots.ts` (note: `WriteTx` and `ReadTx` are the same
  type alias per `core/src/logical/database.ts` — a `WriteTx` argument is
  assignable where `ReadTx` is expected, so ONE signature serves all three
  former callers, including `local.ts`'s which previously typed its parameter
  as `WriteTx`). `normalizePermalink(raw: string | null): string | null` —
  the more general of the two prior signatures (reconcile.ts's, which accepts
  null; per its own comment, "acquisition's callers guard on truthiness, so
  that difference is benign").

- [ ] **Step 1: Create the shared `deriveRoot`**

```typescript
// core/src/logical/roots.ts
import type { ReadTx } from './database.ts'

// The derived root of the chain ending at `id` (inclusive) — the topmost
// ancestor. Roots are derived, never stored authority (spec §4.1).
//
// Formerly three hand-duplicated copies (local.ts, runtime.ts as deriveRoot,
// store.ts as adminDeriveRoot) — staged-path isolation during the v1/v2
// verticals forbade a shared import; that reason ended with V4 Task 11.
// projector.ts's remoteThreadRoot is a DIFFERENT parent-chain walk,
// deliberately NOT folded in here: it stops at the first non-`resolved`
// parent_state, so it must NOT agree with this one.
export function deriveRoot(tx: ReadTx, id: string): string {
  const parentOf = tx.prepare(`SELECT parent_logical_item_id FROM logical_items_v2 WHERE id = ?`)
  let root = id
  let cur: string | null = id
  for (let i = 0; i < 1000 && cur; i++) {
    root = cur
    const row = parentOf.get(cur) as { parent_logical_item_id: string | null } | undefined
    cur = row ? row.parent_logical_item_id : null
  }
  return root
}
```

- [ ] **Step 2: Re-point the three callers**

In `local.ts`, `runtime.ts`, `store.ts`: delete each file's own `deriveRoot`/
`adminDeriveRoot` definition; add `import { deriveRoot } from './roots.ts'`
(in `store.ts`, alias on import if the exported name `adminDeriveRoot` must be
preserved for external callers: `import { deriveRoot as adminDeriveRoot } from './roots.ts'`
— check `store.ts`'s own exports for whether `adminDeriveRoot` is
re-exported and used by name elsewhere before deciding).

- [ ] **Step 3: Create the shared `normalizePermalink`**

Add to `core/src/logical/roots.ts` (or a new `permalink.ts` if keeping
`roots.ts` single-purpose is preferred — pick one file, do not create both):

```typescript
// Normalize a permalink: http(s) only, lowercase scheme+host (URL does the
// host), strip the fragment. Path/query case is preserved (opaque to us).
// Formerly two hand-duplicated copies (acquisition.ts, reconcile.ts) —
// reconcile's accepted `string | null`; acquisition's callers already guard
// on truthiness, so the wider signature is adopted as the one shared copy.
export function normalizePermalink(raw: string | null): string | null {
  if (!raw) return null
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    u.hash = ''
    return u.toString()
  } catch {
    return null
  }
}
```

(Read the full body of both existing implementations before finalizing this
— the snippet above is reconstructed from the fragments read during planning;
confirm no other normalization step differs between the two before deleting
either.)

- [ ] **Step 4: Re-point `acquisition.ts` and `reconcile.ts`**

Delete each file's own `normalizePermalink`; import the shared one.

- [ ] **Step 5: Delete the drift canary**

```bash
git rm core/test/logical-lockstep.test.ts
```

- [ ] **Step 6: Run the full core suite**

Run: `docker compose exec -T core npm run -w core test`
Expected: PASS — every test that previously exercised `deriveRoot`/
`normalizePermalink` behavior through their five call sites now exercises the
one shared implementation; no behavior change, only fewer copies.

- [ ] **Step 7: Typecheck**

Run: `docker compose exec -T core npm run -w core typecheck`
Expected: 0 errors

- [ ] **Step 8: Commit**

```bash
git add core/src/logical/roots.ts core/src/logical/local.ts core/src/logical/runtime.ts core/src/logical/store.ts core/src/logical/acquisition.ts core/src/logical/reconcile.ts
git rm core/test/logical-lockstep.test.ts
git commit -m "core: collapse the five lockstep-duplicated deriveRoot/normalizePermalink copies

V4 Task 11 (debt ledger): staged-path isolation during the v1/v2 verticals
required deriveRoot (local.ts, runtime.ts, store.ts as adminDeriveRoot) and
normalizePermalink (acquisition.ts, reconcile.ts) to exist as hand-verified
identical copies, checked by a dedicated drift canary. That isolation
requirement ended with v1's retirement. Both collapse into
logical/roots.ts; the canary (logical-lockstep.test.ts) retires with them.
This is the single largest debt reduction in the retirement, and is kept
as its own commit/review gate rather than folded into any deletion task.

developed with the help of AI tools"
```

---

## Task 15: Record GAP 2 in the ideas backlog

**Files:**
- Modify: `docs/superpowers/ideas.md`

**Interfaces:** none — documentation only, per the project's
`docs/superpowers/` layout convention (a single running backlog).

- [ ] **Step 1: Append an entry**

Add to `docs/superpowers/ideas.md` (following its existing name · mechanism ·
why-novel · grounding · tradeoff · status format): HTML `rel=alternate` feed
autodiscovery for v2 subscribe (GAP 2 from the V4 Task 11 parity audit) —
pasting a site homepage into Subscribe worked under v1 (`ingestViaDiscovery`,
one-hop follow + URL rewrite) and silently delivers nothing under v2
(`extractRawItems` falls back only to h-feed). Already live since the v2
cutover; not caused by this retirement. Needs its own brainstorm→spec: the
fix touches source identity (`canonicalUrl`), redirect-proof/alias rules, and
the tombstone gate — not a simple rewiring.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/ideas.md
git commit -m "docs: backlog v2 feed-autodiscovery gap (V4 Task 11 parity audit GAP 2)

developed with the help of AI tools"
```

---

## Final verification (after all 15 tasks)

- [ ] `docker compose exec -T core npm run -w core test` — full suite, zero `test.fails()`, zero failures
- [ ] `docker compose exec -T core npm run -w core typecheck` — 0 errors
- [ ] `docker compose exec -T web env -u CORE_API_URL npm test -w web` — full suite passes
- [ ] `docker compose exec -T web npm run check -w web` — 0 errors
- [ ] `grep -rn "sourceModelV2\|SOURCE_MODEL_V2" core/src web/src` — no output
- [ ] Manual smoke on the dev stack: timeline loads, a post round-trips, SSE
      live-prepend works on the home page, `/admin/feeds` establish +
      block/quarantine work, a fresh `docker compose down -v && up` boots
      clean (exercises the real fresh-install path, not just the test)

## Rollout (unchanged from spec Part 5)

1. Unset `RSC_SOURCE_MODEL_V2` on all four instances first.
2. Build `rmdes/rsc:<tag>` (CloudronManifest.json + logo.png symlinked at CWD).
3. `cloudron update --app <domain> --image …` per instance.
4. Verify per instance: running, timeline + permalink + `/admin/feeds` 200,
   SSE connects, no boot errors.
5. Roll one at a time: alice or bob first, then rsc.rmdes.be, then
   rsc.rmendes.net.
