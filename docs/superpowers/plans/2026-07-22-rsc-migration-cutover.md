# RSC Migration and Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the v2 inbound push subsystem V3 deferred, the preflight command
and versioned manifest, the one atomic marker-guarded legacy conversion with
exact ID/permalink/follow/push preservation, the two cutover tripwires, the
ops-token compatibility route, the operator runbook, and — as a separate
soaked release — legacy retirement. Everything stays behind startup-immutable
`RSC_SOURCE_MODEL_V2=off` until the operator flips it per instance.

**Architecture:** The v2 push subsystem is v1's two-state runtime shape
rebuilt over sources: registration/renewal ride V2's one poll loop, callbacks
reuse the existing public routes with handlers supplied by the v2 branch, and
the parse-time capability claim on `acquisition_runs_v2` is the durable fact.
Conversion is one pre-listen write transaction extending V2 §7.1's activation
barrier, guarded by a durable marker on `logical_activation_v2`; findings are
log lines plus per-kind counts in the marker. No new loops, no new command
idiom, no rollback machinery beyond the pre-flip backup.

**Tech Stack:** Node 22 native TypeScript, Hono, better-sqlite3/Kysely,
feedsmith, Vitest, SvelteKit 2, Svelte 5.

**Revision:** 2 — folds the dual plan review (correctness FC1-5 + ponytail
PT1-5; adjudications in
`docs/superpowers/reviews/2026-07-22-v4-migration-spec-review.md`, section
"PLAN REVIEW (2026-07-23): V4 plan draft dual pass → V4 rev 2 + V2 rev 6
instructions"). All five risky calls were upheld (the two-column marker with
its inline dev-reset note; no-FK reservations + repo-layer guard as
root-cause placement; the push CASCADE; the 202 in-flight discard; the
token-only ops route — with its over-strong spec citation trimmed).
Applied: **FC1 — former lockstep amendment 1 is DELETED, not relocated**:
push provenance takes the additive path — a nullable V4-owned mechanism
column on `acquisition_runs_v2` added by this plan's own tail migration
(Appendix A; Tasks 1/3) — so the plan-invented reason value is gone
everywhere and `acquisition_runs_v2.reason` keeps V2's two values; FC2
(Task 6 pins the synthetic observation-evidence contract); FC3+PT1 (former
amendment 3 reframed as a NON-BLOCKING shape pin and removed from the
refuse-execution set; defensive-parse wording deduped into Task 2; the
stale-pointer directive deduped into Task 12, naming both V2 occurrences
per FC4); FC5 (the ops-route example now byte-matches spec §6's binding
block); PT2 (Task 10 Step 2 asserts composition only); PT3 (Appendix D
trimmed to the push column loop + the two tripwire matchers); PT4
(Appendix B's integration-points table deleted; its fault-injection
directive moved into Task 8).

Revision 1 was the initial draft against spec rev 1
(`docs/superpowers/specs/2026-07-22-rsc-migration-cutover-design.md`). The
spec's settled decisions (one-transaction conversion inside V2's pre-listen
activation; startup-error flip-back; two-state push runtime with
delete-on-denial/purge-expired; findings as log lines + marker counts;
gate-assertion off-flag coverage; run-claim on `acquisition_runs_v2`; no
post-purge reservation branch; the active-without-marker tripwire) are
**do-not-relitigate**.

**Status:** READY — gated on the Task 12 cross-vertical contract review.
Execution of Tasks 1–10 is gated on V1–V3 being implemented and reviewed;
Task 11 is a separate post-soak release; Task 12 executes FIRST in
wall-clock order (it gates every vertical's implementation).

## Global Constraints

- Governing spec: `docs/superpowers/specs/2026-07-22-rsc-migration-cutover-design.md` rev 1. Foundation: `2026-07-20-rsc-source-governance-moderation-design.md` rev 3 + its two 2026-07-22 amendments.
- Prerequisites: V1 plan rev 5, V2 plan rev 6 (rev 5 **plus the lockstep provenance-CHECK amendment below**), and V3 plan rev 2, all implemented and reviewed. Refuse execution only if that amendment did not land in V2's execution — it is the one genuinely blocking item (a CHECK cannot be widened post-creation); the shape pin below is non-blocking.
- `RSC_SOURCE_MODEL_V2` stays startup-immutable, default off. With v2 off no V4 route, worker, or write path is active; legacy behavior — including legacy push-in — is byte-identical and covered by the existing legacy suites (spec rev 1 WP1/WP3: no duplicated legacy suite, no third/fourth push state).
- **No new environment variable for push**: v2 inbound push is effective exactly when `RSC_PUSH_IN=on` and `RSC_PUBLIC_URL` is set — the existing `pushInEffective` rule (`core/src/domain/push-in.ts:48-50`, `core/src/config.ts:60-62`). The only new variable is `RSC_MIGRATION_MANIFEST` (optional manifest path, Task 4).
- **No new scheduling loop**: registration rides the poll pass after each successful acquisition commit; one renewal sweep plus expired-row purge ends each pass, exactly as v1's `runPollCycle` does today (`push-in.ts:271-272`).
- Conversion sends **no network requests** and runs at most once, marker-guarded, inside the single pre-listen activation transaction. Migrations stay strictly tail-appended to the `user_version`-indexed `MIGRATIONS` array (`core/src/storage/sqlite.ts:566`, applied ascending at `:706-709`).
- Outbound push (`core/src/domain/push.ts`, the `subscriptions` table, migration 2 at `sqlite.ts:592-604`) is untouched in every task.
- One SQLite `BEGIN IMMEDIATE` write transaction per mutation via the V2 `DatabaseContext.write()` idiom. Reuse V2's exported helpers by exact name: `createDatabaseContext`, `createLogicalStore`, `LogicalReadTx`, `appendJournal`, `encodeCursor`/`decodeCursor`, `AdminPage<T>`, and the exported `jsonWrite` guard (`core/src/api/app.ts`, `MAX_JSON_BYTES` at `:63`) — compose by import, never redefine. Command IDs travel only as the `commandId` JSON body field.
- Core route tasks must invoke `.claude/skills/hono/SKILL.md`. Web tasks must invoke the repository UI/Svelte skills and follow `design-system/rsc/MASTER.md`.
- No TypeScript parameter properties in `core/src`; no new dependency.
- Stage explicit paths only. Every commit ends with `developed with the help of AI tools`.
- Test commands follow `docs/superpowers/documentation/TESTING.md`: in-container when the dev stack is running, otherwise host commands as written.

## Lockstep amendment to the V2 plan (rev 6, REQUIRED before any execution)

Same mechanism as the V4 §10 CHECK pin (amending V1 rev 5) and V3's three
amendments (applied in V2 rev 5). SQLite cannot widen a CHECK without a
table rebuild, so this must land in V2's plan **before V2 executes**; the
Task 12 review re-verifies it. This plan refuses execution if V2's executed
revision predates it.

1. **`presentation_entries_v2.provenance` CHECK is created WIDE.** V2's
   Appendix A pins `CHECK(provenance IN('explicit','arrival'))`, but spec
   §3.2 converts legacy revisions with provenance `legacy_unknown`. The
   CHECK becomes `IN('explicit','arrival','legacy_unknown')`; V2's TS
   provenance type stays two-valued until V4's declared wire widening
   (spec §10 item 6 — V2's provenance tests already assert membership, not
   exhaustive equality).

**Non-blocking shape pin**, folded into V2 rev 6 alongside the amendment but
NOT part of the refuse-execution set: `push_capability_json` (written inert
by V2; V4 is its only reader) stores `JSON.stringify` of the
`choosePushTarget` result shape — `{mode:'websub'|'rsscloud',
endpoint:string, topic:string}` — or SQL NULL when the feed advertises
nothing. Any stored shape is forward-safe regardless (Task 2's defensive
parser), which is why this pin cannot block execution.

There is no reason-CHECK amendment: push provenance needs no enum widening.
This plan's own tail migration records it additively on `acquisition_runs_v2`
(Appendix A), and fat/thin ping runs use the existing V2 reason vocabulary
per spec §1.4.

## File map and shared interfaces

Create focused modules; extend — never fork — the V2 store, scheduler,
runtime, and routes:

```text
core/src/logical/push.ts           v2 push: lifecycle, registration, renewal, callbacks
core/src/migration/preflight.ts    read-only checks + manifest loading/validation
core/src/migration/preflight-cli.ts  tiny CLI entry (npm run preflight -w core)
core/src/migration/convert.ts      the one-transaction conversion + marker
```

Modified: `core/src/logical/{schema,types,store,scheduler,runtime}.ts`,
`core/src/api/{app,logical-routes}.ts`, `core/src/domain/types.ts`,
`core/src/storage/sqlite.ts`, `core/src/config.ts`, `core/src/server.ts`,
plus the small web surfaces named per task.

`core/src/domain/types.ts` — intentional TS supersessions (SQL CHECKs are
already wide; V1 rev 5 pin):

```ts
export type AuditCategory = /* V3's eight */ | 'migration_review' // first emitter: conversion (Task 5)
// SourceAuditEvent.actorKind widens: 'administrator' | 'operator_token' | 'system'
// CommandEnvelope.actorScope widens: 'owner' | 'administrator' | 'ops' | 'system'
// establishFederation input actorKind widens: 'administrator' | 'operator_token'
export interface SourceSummary { /* V1 fields */ push: PushSummary } // V1-deferred, first written here
export interface PushSummary {
  mode: PushProtocol | null
  state: 'pending' | 'active' | null            // two-state union (spec 1.2/1.5)
  endpointFingerprint: string | null            // sha256(endpoint) first 16 hex — non-secret
}
// SourceDetail gains pushExpiresAt: string | null (admin page shows expiry)
```

`core/src/logical/push.ts` exports:

```ts
export type PushClaim = PushTarget // {mode: PushProtocol; endpoint: string; topic: string} — reused from push-in.ts
export function parsePushCapability(json: string | null): PushClaim | null // contract pinned in Task 2 Step 1
export interface PushRowV2 {
  id: string; sourceId: string; mode: PushProtocol; endpoint: string; topic: string
  callbackToken: string; secret: string | null
  state: 'pending' | 'active'; expiresAt: string; createdAt: string
}
export function createLogicalPush(deps: {
  db: DatabaseContext; store: ReturnType<typeof createLogicalStore>
  sourceRepository: SourceRepository; config: Config
  fetchFn?: typeof fetch; lookupFn?: LookupFn
}): {
  maybeRegister(sourceId: string, claim: PushClaim | null): Promise<void>
  renewDue(): Promise<void>
  hasActivePush(sourceId: string, now: string): boolean
  handleWebSubVerification(token: string, query: Record<string, string>): Promise<{status: number; body: string}>
  handleFatPing(token: string, body: string, signatureHeader: string | null): Promise<number>
  handleRssCloudChallenge(url: string, challenge: string): Promise<{status: number; body: string}>
  handleThinPing(url: string): Promise<number>
}
```

The pure v1 helpers are **imported, not rewritten**: `verifySignature`,
`choosePushTarget`, `pushInEffective`, and the constants
`PENDING_TTL_MS`/`WEBSUB_LEASE_SECONDS`/`WEBSUB_RENEW_HORIZON_MS`/
`RSSCLOUD_TTL_MS`/`RSSCLOUD_RENEW_HORIZON_MS`/`RENEW_RETRY_FLOOR_MS`
(`core/src/domain/push-in.ts:16-26,30-39,41-46,48-50`). Task 11 (retirement)
moves them into `logical/push.ts` when the v1 module dies; until then the v1
module is their home and stays byte-identical.

`createLogicalStore(db)`'s returned object gains (implementation in
`store.ts` over `push_subscriptions_v2`; same idiom as the legacy repo
methods at `core/src/domain/repository.ts:51-55`):

```ts
findPushRow(filter: {token?: string; sourceId?: string; mode?: PushProtocol; topic?: string},
            opts?: {unexpiredAt?: string; state?: 'pending' | 'active'}): PushRowV2 | undefined
upsertPushRow(tx: WriteTx, row: PushRowV2): void
deletePushRow(tx: WriteTx, id: string): void
listRenewablePushRows(horizon: string): PushRowV2[]
purgeExpiredPushRows(tx: WriteTx, now: string): void
```

`core/src/migration/preflight.ts` / `convert.ts`:

```ts
export interface ManifestEntry {sourceId: string; feedUrl: string; attributionMode: AttributionMode; note: string}
export interface Manifest {schemaVersion: 1; entries: ManifestEntry[]}
export function loadManifest(path: string | null): Manifest | null // throws named diagnostics on every abort class
export interface PreflightFinding {kind:
  | 'invalid_url' | 'url_collision' | 'manifest_invalid' | 'manifest_unknown_entry'
  | 'manifest_mismatch' | 'manifest_duplicate' | 'handle_reservation_collision'
  detail: string}
export function runPreflight(raw: BetterSqlite3.Database, manifest: Manifest | null): PreflightFinding[] // [] = clean; READ-ONLY

export type ConversionCounts = Record<ConversionFindingKind, number>
export type ConversionFindingKind =
  | 'default_person' | 'default_webfeed' | 'instance_quarantined' | 'manifest_approved'
  | 'attribution_conflict' | 'unresolved_reference' | 'permalink_collision' | 'guid_collision'
  | 'push_preserved' | 'push_expired' | 'push_invalid' | 'over_cap_grandfathered'
export function runConversion(tx: WriteTx, input: {
  manifest: Manifest | null; now: string; log: (line: string) => void
}): ConversionCounts // marker + reset written by the caller (runtime), same transaction
```

---

### Task 1: V4 schema, widened TS contracts, and the amendment tripwire

**Files:** Modify `core/src/logical/schema.ts`, `core/src/logical/types.ts`,
`core/src/domain/types.ts`, `core/src/storage/sqlite.ts`,
`core/src/config.ts`; create `core/test/v4-schema.test.ts`; modify
`core/test/config.test.ts`.

**Interfaces:** Produces the Appendix A tables/columns, the TS widenings from
the shared-interfaces block, and `Config.migrationManifestPath`. No behavior.

- [ ] **Step 1:** Add `v4-schema.test.ts` asserting: `push_subscriptions_v2`
  and `handle_reservations_v2` exist with the Appendix A shapes after
  migration; `logical_activation_v2` accepts `converted_at` /
  `conversion_findings_json` writes; `push_subscriptions_v2.state` rejects
  any value outside `('pending','active')` (the two-state pin, spec 1.2) and
  enforces `UNIQUE(source_id, mode)` (mirror of legacy `UNIQUE(user_id,
  mode)`, `core/src/storage/sqlite.ts:618`); **the amendment tripwire** —
  `presentation_entries_v2` accepts `provenance='legacy_unknown'` (proves
  the V2 rev 6 amendment landed; refuse the task if it needs a rebuild);
  `acquisition_runs_v2.delivery_mechanism` exists nullable and accepts
  `'push'` and NULL (this plan's own tail migration — an additive
  `ALTER TABLE`, Appendix A; the `reason` CHECK stays V2's two values);
  no existing table is rebuilt (same `sql` text in `sqlite_master`
  before/after — the V3 rev 2 TP5 assertion, reused).
- [ ] **Step 2:** Add the config red test: `RSC_MIGRATION_MANIFEST` defaults
  to `null` and passes through as a path string; no validation beyond
  presence (the file is read/validated by preflight, not config).
- [ ] **Step 3:** Run `npm test -w core -- v4-schema config`; expect FAIL.
- [ ] **Step 4:** Append ONE migration entry at the END of `MIGRATIONS`
  calling `installV4Schema(raw)` in `schema.ts` with the exact Appendix A
  DDL. Add the TS widenings (`migration_review`, `operator_token`, `ops`,
  `SourceSummary.push`/`PushSummary`, `SourceDetail.pushExpiresAt`,
  `updatedAtProvenance` gains `'legacy_unknown'` in the wire type) and
  `Config.migrationManifestPath`.
- [ ] **Step 5:** Run `npm test -w core -- v4-schema config && npm run typecheck -w core`; expect PASS. Commit per Appendix C.

### Task 2: v2 push lifecycle — store, registration, renewal, cadence

**Files:** Create `core/src/logical/push.ts`,
`core/test/logical-push.test.ts`; modify `core/src/logical/store.ts`,
`core/src/logical/scheduler.ts`, `core/test/logical-scheduler.test.ts`.

**Interfaces:** Produces the `PushRowV2` store methods, `parsePushCapability`,
`maybeRegister`, `renewDue`, `hasActivePush`, and the poll-pass wiring: after
each successful acquisition commit for an eligible source the loop calls
`maybeRegister(sourceId, parsePushCapability(run.pushCapabilityJson))`; each
pass ends with one `renewDue()` sweep then `purgeExpiredPushRows` — v1's
`runPollCycle` tail (`push-in.ts:271-272`) rebuilt over sources. No callback
handling yet.

- [ ] **Step 1:** Add red claim tests: `parsePushCapability` round-trips the
  pinned `{mode,endpoint,topic}` shape, returns null for SQL NULL, and
  returns null (plus one log line) for malformed/unknown-shape JSON;
  registration acts only on the **latest successful run's** claim — a stale
  claim on an older run is inert (spec 1.1).
- [ ] **Step 2:** Add red registration tests (the v1 `maybeSubscribe` shape,
  `push-in.ts:149-164`, rebuilt): eligibility composes three axes — refused
  when operation is `paused`, when governance is `blocked`, or when the
  source is unschedulable (no active subscription, no pending/approved
  federation — reuse V2's schedulability predicate); **quarantined + enabled
  registers normally**; the `checkCallbackUrl` SSRF gate revalidates the
  claimed endpoint at use (private/loopback endpoint → no row, no request);
  an unexpired `pending|active` row blocks a new attempt EXCEPT the
  rsscloud-fallback-with-hub upgrade (`push-in.ts:156-157`); **R1**:
  re-registration against a surviving `(source, mode)` row reuses that row's
  token and secret — new material is generated only when no row exists at
  all (`push-in.ts:79-83` kept verbatim); websub rows are written `pending`
  with the 10-min TTL before the subscribe POST; rsscloud rows are written
  `pending` before register and flip `active` on 2xx with the 25 h TTL.
- [ ] **Step 3:** Add red renewal/purge tests: one sweep per poll pass over
  rows inside their renew horizons (constants imported from
  `push-in.ts:41-46` verbatim), filtered by **current** eligibility (no
  renewal while paused or blocked); the hourly per-row retry floor
  (`RENEW_RETRY_FLOOR_MS`, in-memory like v1 `push-in.ts:174-177`); expired
  rows purge at pass end; **no unsubscribe request is ever sent** — pause,
  block, unsubscribe-to-zero send nothing and the lease lapses (assert zero
  fetch calls).
- [ ] **Step 4:** Add red cadence tests in `logical-scheduler.test.ts`: a
  source with an `active` unexpired push row skips polling until
  `10 * baseInterval` past `lastPollAt` (the durable equivalent of v1's
  `tick % 10` skip, `push-in.ts:264`, composed with V2 §1.3's `lastPollAt`
  comparison — no tick state); `pending` rows do not reduce cadence; the
  claim capture itself stays inert when `pushInEffective` is false (rows are
  never written, sweep never runs — `RSC_PUSH_IN=off` or no public URL).
- [ ] **Step 5:** Run `npm test -w core -- logical-push logical-scheduler`; expect FAIL. Implement `push.ts` + store methods + the scheduler hook. (`ponytail: renewal rides the poll pass like v1; a dedicated scheduler only if lease counts ever make the sweep measurable`)
- [ ] **Step 6:** Run `npm test -w core -- logical-push logical-scheduler && npm run typecheck -w core`; expect PASS. Commit per Appendix C.

### Task 3: v2 callbacks, the pause/block matrix, and the admin push surface

**Files:** Modify `core/src/logical/push.ts`, `core/src/logical/store.ts`,
`core/src/logical/runtime.ts`, `core/src/server.ts`,
`core/src/domain/source-repository.ts`, `core/src/api/logical-routes.ts`;
create `core/test/logical-push-callbacks.test.ts`; modify
`core/test/source-admin-api.test.ts`,
`web/src/routes/admin/sources/[sourceId]/+page.server.ts`,
`web/src/routes/admin/sources/[sourceId]/+page.svelte`,
`web/src/routes/admin/sources/[sourceId]/source-detail.test.ts`.

**Interfaces:** Invoke `.claude/skills/hono/SKILL.md` (core) and the UI/Svelte
skills (web panel) first. The four public callback routes keep their exact
paths (`GET|POST /websub/callback/:token`, `GET|POST /rsscloud/notify`,
`core/src/api/app.ts:407,415,422,428` — Caddyfile exposure set unchanged);
under v2 the server composition supplies `pushInApi` from `createLogicalPush`
instead of `createPushIn` — the route code itself does not change. Produces
`SourceSummary.push` (first writer of the V1-deferred field, narrowed union)
and the admin source-page push block.

- [ ] **Step 1:** Add red verification-GET tests: state-agnostic token+topic
  match (renewal re-verifies while active, v1 `push-in.ts:196-211` shape);
  `hub.mode=denied` **deletes** the row (`push-in.ts:200-202` kept); success
  activates with the granted lease (integer guard on `hub.lease_seconds`);
  websub activation retires a surviving rsscloud fallback row
  (`push-in.ts:208-210`); a valid in-flight challenge completes even when the
  source is paused or blocked — but causes no acquisition and no renewal
  scheduling; unknown token/topic → 404.
- [ ] **Step 2:** Add red fat-ping tests: unknown token 404; bad/missing HMAC
  → silent 202 + log, never 4xx (v1 H2, `push-in.ts:218-221`;
  `verifySignature` imported); eligible source → the delivered body enters
  the same V2 acquisition path as a poll — fetch skipped, the body is the
  document — through the §1.5 bounds profile, observation writer,
  reconciliation jobs, and commit-time policy recheck; the run row uses the
  existing V2 reason vocabulary (spec §1.4) with `delivery_mechanism='push'`
  (no new reason value); a source with an active
  in-flight acquisition discards the ping at 202 + log (the per-source
  in-flight boolean; the next poll catches up); **paused or blocked**:
  authenticate, neutral 202, body neither parsed nor stored (assert zero
  observation/job rows); **quarantined + enabled**: ingests normally —
  governance alone makes the evidence admin-only, no push-specific branch.
- [ ] **Step 3:** Add red thin-ping/challenge tests: unknown topic → neutral
  200 no-op (no subscription-list oracle) and the 30-second per-topic floor
  (`push-in.ts:238-241` shape); known eligible topic → one acquisition run
  through the ordinary gate — the existing one-shot reason per spec §1.4,
  run row marked `delivery_mechanism='push'` — fire-and-forget;
  paused/blocked → 200 without fetching; rssCloud challenge confirms known
  topics and 404s unknown ones (`push-in.ts:231-234`). Resume-from-pause
  needs no test of its own machinery: V2 §1.3's ordinary next-pass poll IS
  the catch-up (assert only that a resumed source polls on the next pass).
- [ ] **Step 4:** Add red admin-surface tests (extend
  `source-admin-api.test.ts`): `SourceSummary.push` carries exactly
  `{mode, state, endpointFingerprint}` with the two-state union;
  `SourceDetail.pushExpiresAt`; the fingerprint is a stable sha256-prefix
  digest, not the endpoint; **redaction** — seeded `callbackToken` and
  `secret` appear in no list, detail, error, or audit body (extend the
  standing redaction loop over push rows).
- [ ] **Step 5:** Add red web panel tests (`source-detail.test.ts`): the
  admin source page shows push mode/state/expiry beside the acquisition
  health block; no push block renders when `push.mode` is null; no ordinary
  (non-admin) surface changes anywhere.
- [ ] **Step 6:** Run `npm test -w core -- logical-push-callbacks source-admin-api && npm test -w web -- source-detail`; expect FAIL. Implement: callback handlers in `push.ts`, the `pushInApi` v2/v1 branch in server composition (v1 handlers not routed under v2 — V2 §7.4), the summary/detail read join, the panel.
- [ ] **Step 7:** Run the Task 3 Appendix C row; expect PASS. Commit.

### Task 4: Preflight, the versioned manifest, and the operator CLI

**Files:** Create `core/src/migration/preflight.ts`,
`core/src/migration/preflight-cli.ts`, `core/test/migration-preflight.test.ts`;
modify `core/package.json` (script `preflight`), `core/src/config.ts` usage
only if needed.

**Interfaces:** Produces `loadManifest`, `runPreflight`, and the standalone
command `npm run preflight -w core` (run via `cloudron exec`; the CLI loads
config, opens the DB read-only, prints findings as diagnostics, exits
non-zero on any finding). The same `runPreflight` runs in-process before
conversion (Task 8). READ-ONLY: assert no write ever happens.

- [ ] **Step 1:** Add red URL tests: every remote `users.feed_url` must
  normalize under V1's narrow canonicalization (reuse `normalizeSourceUrl`
  from `core/src/domain/source-url.ts` — never a second normalizer);
  missing, malformed, credential-bearing, >2048-char, non-HTTP(S), and
  normalized-colliding URLs each produce an aborting finding naming the
  legacy row; a clean legacy set and a zero-row database both return `[]`.
- [ ] **Step 2:** Add red manifest tests, one per abort class: missing file
  at a configured path; wrong `schemaVersion`; entry keyed by unknown
  `sourceId`; entry whose `feedUrl` mismatches the row's exact legacy URL;
  entry for a non-`instance` row (`feed_type` from migration 11,
  `sqlite.ts:682-688`); duplicate entries; invalid `attributionMode`. No
  manifest configured → null → every instance row takes the unconfirmed
  default (asserted at conversion, Task 5).
- [ ] **Step 3:** Add red reservation tests: a legacy remote handle equal to
  an existing `handle_reservations_v2` handle is an aborting finding
  (re-running preflight after a partial restore must not silently plan a
  double reservation).
- [ ] **Step 4:** Run `npm test -w core -- migration-preflight`; expect FAIL.
  Implement; assert read-only via a write-counter (`raw` opened with
  `{readonly:true}` in the CLI; in-process callers pass the live handle and
  the function performs zero writes by construction — SELECTs only).
- [ ] **Step 5:** Run `npm test -w core -- migration-preflight && npm run typecheck -w core`; expect PASS. Commit per Appendix C.

### Task 5: Conversion I — sources, publishers, federation, follows, reservations

**Files:** Create `core/src/migration/convert.ts`,
`core/test/migration-convert.test.ts`; modify `core/src/storage/sqlite.ts`
(reservation guard), `core/src/domain/service.ts` (if the guard surfaces
there), `core/test/service.test.ts`.

**Interfaces:** Produces `runConversion` part 1 over legacy `users`
(`kind='remote'`) and `follows` (`sqlite.ts:623-628`), plus the permanent
reservation guard. Conversion is pure SQL-over-tx — no fetch, no ledger
command; audit rows share one synthetic `commandId` (`migration:<uuid>`),
actor kind `system`.

- [ ] **Step 1:** Add red source-mapping tests: each remote user becomes one
  `remote_sources_v2` row with **the same ID**, normalized canonical URL,
  provenance `migration`, `policy_generation` 0; each source gets a **new**
  publisher ID (never a recycled user ID); `person`/`webfeed` →
  `single_publisher + enabled + allowed + federation none`;
  manifest-approved instances → manifest mode, `allowed + approved`,
  manifest note as provenance; every unconfirmed instance → `aggregate +
  enabled + quarantined + pending`. Local accounts: IDs and handles
  untouched, still local authors.
- [ ] **Step 2:** Add red audit tests: one `migration_review` source-audit
  row (first emitter of the re-added category) for each quarantined instance
  and each manifest approval — and NONE for default person/webfeed
  conversions (those are finding counts only: `default_person`,
  `default_webfeed`). (`ponytail: audit the governance-bearing outcomes; the
  finding counts carry the bulk`)
- [ ] **Step 3:** Add red follow tests: local→local follows preserved
  unchanged; every valid local→remote follow becomes a
  `source_subscriptions_v2` row — `active` for person/webfeed, and
  **`pending_review` for every legacy instance follow regardless of source
  approval** (counts toward the cap, removable, no Personal exposure);
  over-cap users are grandfathered — all existing follows convert
  (`over_cap_grandfathered` counted once per user) and the cap check
  refuses new subscriptions until below `max_subs_per_user` (seeded 500,
  `sqlite.ts:690`).
- [ ] **Step 4:** Add red reservation tests: one `handle_reservations_v2`
  row per remote handle mapping to the converted source + publisher IDs;
  `repo.createLocalUser` and a handle-changing `updateUserProfile` refuse a
  reserved handle through the SAME guard (one check where all callers
  route — service `ensureLocalUser` at `service.ts:25-40`, the direct
  `createLocalUser`, and auth's guest allocation at
  `core/src/api/auth.ts:39-41` all pass through the repo), with the existing
  collision-shaped error (no reserved-vs-taken oracle); the reservation
  survives source deletion (no FK — Appendix A).
- [ ] **Step 5:** Run `npm test -w core -- migration-convert service`; expect
  FAIL. Implement part 1 + the guard. Zero-row conversion is the same code
  path, not a special case.
- [ ] **Step 6:** Run `npm test -w core -- migration-convert service && npm run typecheck -w core`; expect PASS. Commit per Appendix C.

### Task 6: Conversion II — items, deliveries, ancestry, revisions

**Files:** Modify `core/src/migration/convert.ts`,
`core/test/migration-convert.test.ts` (append this task's sections).

**Interfaces:** Converts legacy remote posts (`posts` with `source='remote'`,
migration 1 DDL at `sqlite.ts:576-587`) and `post_revisions`
(`sqlite.ts:667-675`). Converted legacy rows are left in place, **inert** —
no delete, no v2 reader touches them.

- [ ] **Step 1:** Add red identity tests: each remote post becomes one
  logical item **with the same post ID**, one delivery on the same-ID source
  keyed by the legacy `UNIQUE(author_id, guid)` tuple (`sqlite.ts:586` →
  `UNIQUE(source_id, key_kind, key)`), one observation version (synthetic
  `run_id = 'migration'` — no FK on `observation_versions_v2.run_id`, no
  run row), one claim, a selected publisher, and a retained preferred
  delivery; preserved exactly: GUID, permalink, content, `content_markdown`,
  published/arrival dates, reply context.
- [ ] **Step 1a:** Add red synthetic-evidence tests pinning the migration
  observation's evidence contract: `canonical_material`,
  `raw_evidence_json`, and `normalized_json` are BUILT from the converted
  post's fields, wrapped in a marked synthetic envelope (e.g.
  `{"synthetic":"migration", …}`) — never a fabricated feed document;
  `wire_ordinal` and the seen counts take defined synthetic values
  (`wire_ordinal` 0, `seen_count` 1, `last_seen_run_id` `'migration'`,
  `last_seen_at` = the conversion timestamp). Integrity holds because
  reconciliation reads `normalized_json` — which IS the correct converted
  content — and verification fetches live publisher URLs; stored evidence
  is never re-read as an authenticity proof.
- [ ] **Step 2:** Add red attribution tests: single-publisher sources select
  the bound publisher; a differing per-item `source_name`/`source_feed_url`
  becomes a `logical_conflicts_v2` row (`attribution_conflict` counted);
  aggregates resolve a provisional publisher from valid per-item attribution
  and fall back to the source-scoped unattributed publisher otherwise;
  quarantined instances' deliveries convert as retained admin evidence,
  ordinarily ineligible from the first read.
- [ ] **Step 3:** Add red ancestry tests: each resolved
  `in_reply_to_post_id` edge copies as a resolved logical parent edge as-is
  (V2 §4.1 permits skipping the retired global-uniqueness fallback); a local
  parent needed as an edge endpoint gets its `logical_local_origins_v2`
  bridge row materialized (V2 §2.6's explicit-backfill site); unresolved
  references convert to `missing` with their bounded asserted context
  (`unresolved_reference` counted); historical items are never merged —
  permalink or publisher+GUID collisions become counted findings
  (`permalink_collision`/`guid_collision`), both items kept.
- [ ] **Step 4:** Add red revision tests: `post_revisions` convert into the
  delivery's accepted presentation chain in `seen_at` order with timestamps
  preserved and provenance **`legacy_unknown`** (accepted by the widened
  CHECK — the V2 rev 6 amendment); `legacy_unknown` never initializes or
  advances the explicit-update watermark (a later explicit update starts the
  watermark fresh); the wire `updatedAtProvenance` for a converted item
  reads `legacy_unknown` (membership assertion — V2's tests already
  anticipate widening). Inertness: converted `posts`/`post_revisions` rows
  still exist untouched after conversion, and no v2 read joins them.
- [ ] **Step 5:** Run `npm test -w core -- migration-convert`; expect FAIL on
  the new sections. Implement part 2.
- [ ] **Step 6:** Run `npm test -w core -- migration-convert logical-projector && npm run typecheck -w core`; expect PASS (projector suite proves converted items project as ordinary logical items). Commit per Appendix C.

> **Correction 2026-07-24 (recorded during Task 6 execution) — the synthetic
> migration run.** Step 1's "no run row" cannot hold together with Step 6's
> "converted items project as ordinary logical items" and Task 8 Step 4's
> "a pre-cutover `/post/:id` permalink resolves to the same-ID logical item".
> Ordinary visibility is gated twice on facts a bare observation version
> cannot supply: every comparator and the whole ordinary projection JOIN
> `acquisition_runs_v2` for the first-arrival tuple
> (`projector.ts:311/353/371`, `reconcile.ts:437/460`), and
> `REMOTE_VISIBLE` (`projector.ts:626`) additionally requires a
> `reconciliation_jobs_v2` row in `reconciled`/`conflicted` — a table whose
> `run_id` FK is enforced (`foreign_keys=ON`). With no run row a converted
> item is invisible on every surface, and history older than the current feed
> window would never become visible at all.
>
> Task 6 therefore writes, per source that has posts, ONE terminal
> `acquisition_runs_v2` row plus one `reconciled` observation job per
> version — **exactly V3's `persistVerifiedDelivery` pattern**
> (`verification.ts:341-357`), the established house precedent for durable
> evidence no drain produced. `reason` stays `'scheduled'` (V2's two values,
> unwidened) and `delivery_mechanism` stays NULL. Because a run row belongs
> to ONE source, the pinned literal `run_id = 'migration'` is realized as
> **`migration:<sourceId>`**: still a marked synthetic value, still
> FK-free on `observation_versions_v2`, and now JOIN-able. Nothing else in
> the FC2 contract moves — the marked synthetic envelope, `wire_ordinal`,
> `seen_count`, `last_seen_run_id`, `last_seen_at` are as pinned (with
> `wire_ordinal` extending 0..n across a revision chain, since it is the only
> tuple component that can order one delivery's versions).
>
> Two further Task 6 clarifications, same date: (a) Step 2's "aggregates
> resolve a provisional publisher … fall back to the source-scoped
> unattributed publisher" is **superseded by the spec's 2026-07-24
> feed-anchored amendment** — there is exactly ONE publisher per source, both
> branches collapse onto it, and the item's claimed origin feed URL is
> retained in `normalized_json.originFeedUrl` for V3 verification to prove
> against the live web instead; the conflict case is a BOUND single-publisher
> source whose item claims a different origin feed. (b) `guid_collision` is
> implemented (one shared claim helper with `permalink_collision`) but is
> **structurally unreachable** given preflight: the opaque key is
> publisher-scoped, one publisher per source, and `posts_author_guid_uq`
> plus preflight's URL-collision check make two posts under one publisher
> with one guid impossible. Its count stays a truthful 0.

### Task 7: Conversion III — exact push preservation, findings, marker, reset

**Files:** Modify `core/src/migration/convert.ts`,
`core/test/migration-convert.test.ts` (append).

**Interfaces:** Completes `runConversion`: push rows, the findings contract
(log lines + per-kind counts), and the caller-visible counts the runtime
seals into the marker with the cutover reset (Task 8 owns the transaction
composition).

- [ ] **Step 1:** Add red push-preservation tests with **byte-exact column
  assertions**: every unexpired legacy `push_subscriptions` row
  (`sqlite.ts:607-620`) that passes revalidation (URL parse +
  `checkCallbackUrl` on the endpoint — no network) becomes one
  `push_subscriptions_v2` row on the same-ID source preserving exactly
  protocol, endpoint, topic, callback token, secret, state
  (`pending → pending`, `active → active`), expiry, and creation time
  (`push_preserved` counted); an expired row or one failing revalidation
  converts to **no live row** — one log line + `push_expired`/`push_invalid`
  count; quarantined sources retain their active leases. Conversion sends no
  subscribe/unsubscribe/verify/fetch (assert zero fetch calls across the
  whole conversion).
- [ ] **Step 2:** Add red findings tests: `runConversion` returns the
  complete per-kind counts; every non-aborting finding also emitted one log
  line through the injected `log` (spot-check one line per kind); there is
  NO findings relation and NO report route (`ponytail: add the queryable
  report if paging is ever requested`).
- [ ] **Step 3:** Run `npm test -w core -- migration-convert`; expect FAIL. Implement.
- [ ] **Step 4:** Run `npm test -w core -- migration-convert && npm run typecheck -w core`; expect PASS. Commit per Appendix C.

### Task 8: Cutover — activation extension, both tripwires, reserved-handle redirect

**Files:** Modify `core/src/logical/runtime.ts`, `core/src/server.ts`,
`core/src/api/logical-routes.ts`, `core/test/logical-runtime.test.ts`; create
`core/test/migration-cutover.test.ts`; modify
`web/src/routes/u/[handle]/+page.server.ts`,
`web/src/routes/u/[handle]/u-page.test.ts` (create if absent — verify the
existing test-file name for the `/u/:handle` load before creating; extend in
place if one exists).

**Interfaces:** Extends V2 §7.1's pre-listen activation transaction — never a
second barrier. Startup order for a configured-v2 process: migrations (already
applied by `createSqliteRepository`), then read activation state + conversion
marker **together**, then branch per spec §4.1, then V2's readiness components
plus the push callback handlers. Web: `/u/:handle` for a reserved handle
issues a permanent redirect to `/p/:publisherId` via the v2 handle lookup
(the lookup response gains a `{reserved: true, publisherId}` shape); no
post-purge branch — after purge the redirect target 404s through the ordinary
not-found path (spec WP5).

- [ ] **Step 1:** Add red sequencing tests in `migration-cutover.test.ts`:
  never-activated + no marker → in-process preflight runs; an aborting
  finding fails startup with diagnostics and **commits nothing** (schema and
  legacy data byte-identical after the failure; restart with flag off works);
  a clean preflight → ONE write transaction commits conversion, journal
  initialization with its first reset generation, the cutover `reset`, the
  marker (`converted_at` + `conversion_findings_json` per-kind counts),
  activation timestamps, and state `active` — fault injection anywhere
  before commit leaves a legacy-intact database that retries next start
  (fault-injection tests follow the V2 Appendix D pattern: throw
  immediately before marker, journal, and commit; assert the legacy tables
  and the v2 tables are all unchanged);
  marker present → conversion skipped, ordinary V2 §7.1 re-activation;
  conversion runs at most once across restarts.
- [ ] **Step 2:** Add red tripwire tests: **(a)** marker present +
  `RSC_SOURCE_MODEL_V2=off` → startup error naming the backup-restore
  procedure (same fail-loud pattern as the `database is newer than this
  build` guard, `sqlite.ts:696-697`); **(b)** activation `active` + NO
  marker → named startup error, never a silent skip (spec WC3). Together
  the pair is self-verifying in both directions. (Dev note: a dev database
  activated by V2/V3 before V4 ships trips (b) by design — delete dev data.)
- [ ] **Step 3:** Add red continuity tests: a legacy `push_subscriptions`
  row's callback token authenticates a post-conversion fat ping against the
  converted v2 row (lease continuity — token, secret, topic, and route
  paths all preserved); the first post-cutover renewal happens on the
  ordinary poll-pass sweep when the preserved lease enters its horizon;
  paced acquisition resumes after commit for enabled allowed AND enabled
  quarantined sources; paused and blocked sources stay inactive; the
  capability flip is core-only — `/capabilities` reports V2's exact enabled
  shape (V4 adds no field; exact-equality against V2's shape, the V3 Task 10
  pattern) and an already-deployed web on the memoized-success path follows
  without redeploy (web test may live with the existing capability suite).
- [ ] **Step 4:** Add red redirect tests: `/u/:handle` for a reserved handle
  308-redirects to `/p/:publisherId`; a live local handle renders as today;
  after purging the converted source+publisher the redirect still fires and
  `/p/:publisherId` 404s ordinarily (reservation outlives the target); a
  pre-cutover `/post/:id` permalink resolves to the same-ID logical item.
- [ ] **Step 5:** Run `npm test -w core -- migration-cutover logical-runtime && npm test -w web -- u-page`; expect FAIL. Implement: the runtime extension, the two guards, the lookup shape, the redirect.
- [ ] **Step 6:** Run the Task 8 Appendix C row; expect PASS. Commit.

### Task 9: The ops-token compatibility route

**Files:** Modify `core/src/api/logical-routes.ts` (or `app.ts` — wherever
the v2 route branch lives), `core/src/domain/source-service.ts`; create
`core/test/source-ops-api.test.ts`.

**Interfaces:** Invoke `.claude/skills/hono/SKILL.md` first. V4 is the first
consumer of the route the V1 review deferred; the contract is spec §6
verbatim (V1 plan rev 5 removed its former Task 7 Step 3 text — the spec's
inline block is the binding form):

```http
POST /ops/sources/federation
Authorization: Bearer <RSC_TOKEN>
{"url":"https://example.test/feed","attributionMode":"aggregate",
 "category":"operator_policy","note":"configured peer","commandId":"<uuid>"}
```

- [ ] **Step 1:** Add red contract tests: the route exists only under v2
  (off → 404); it invokes `establishFederation` only — same domain
  transition as the admin route, actor kind `operator_token`, actor ID
  `ops:` + first 16 hex of SHA-256(`RSC_TOKEN`) (`RSC_TOKEN` required,
  `core/src/config.ts:44-45`); ledger scope `ops` with the V1-pinned
  fingerprint `["federation", normalizedUrl, attributionMode]` — identical
  replay returns the stored result, changed URL/mode under the same command
  ID → 409 idempotency conflict; `jsonWrite` composed positionally by
  import; `commandId` accepted only in the body.
- [ ] **Step 2:** Add the red authorization matrix (V1 review Finding 3
  adopted): valid bearer succeeds HERE and receives **401 on every
  `/admin/*` route** (no better-auth session → `sessionAuth` 401,
  `core/src/api/auth.ts:64-66`, before `requireAdmin`'s 403 at `:82`);
  invalid bearer fails per the existing bearer contract; admin session on
  this route → 401 (bearer-only route, so a session 401s); no raw
  token in any success/error/audit body (the fingerprint only).
- [ ] **Step 3:** Run `npm test -w core -- source-ops-api`; expect FAIL.
  Implement: hand-rolled validator, `c.json({error}, status)`, the widened
  `establishFederation` actor kind. Not added to the public Caddy set —
  operators call core internally, exactly like `POST /users` today
  (RUNNING.md curl cheat sheet).
- [ ] **Step 4:** Run `npm test -w core -- source-ops-api source-admin-api && npm run typecheck -w core`; expect PASS. Commit per Appendix C.

### Task 10: Off-flag gates, whole-vertical integration, and the operator runbook

**Files:** Create `core/test/logical-v4-vertical.test.ts`; modify
`docs/superpowers/documentation/RUNNING.md`, `.env.example`,
`core/.env.example`.

**Interfaces:** Proves spec §11 end to end. Gate-assertion off-flag coverage
per WP3: routing assertions only — the existing legacy suites (including
`core/test/push-in.test.ts` and `core/test/push-guard.test.ts`) remain the
behavioral coverage; nothing is duplicated (§7 would delete a duplicate one
release later).

- [ ] **Step 1:** Add off-flag gate assertions: with the flag off, the four
  callback routes dispatch to the v1 handlers (v1 `pushInApi` wiring), the
  ops route and every V4 admin field are absent, preflight/conversion never
  run (no activation row, no marker), and no V4 module is loaded by the
  composition path (assert the v2 push factory and migration modules are
  referenced only inside the v2 branch — a composition-level assertion, not
  an import-graph scanner).
- [ ] **Step 2:** Add the on-flag integration test: seed a representative
  legacy dataset (person + webfeed + manifest-approved instance +
  unconfirmed instance, follows incl. one over-cap user, active + pending +
  expired + invalid push rows, replies with resolved/unresolved parents,
  revisions), flip on, start: assert **composition only** — one pass through
  the runbook's step-6 checks composes end to end (capability shape,
  SSR-projectable converted timeline, same-ID `/post/:id`, reserved-handle
  redirect data, sane marker counts, preserved push state, fat-ping lease
  continuity, resumed paced acquisition); field-level correctness of each
  converted output is already proven by Tasks 5–8 and is not re-asserted
  here.
- [ ] **Step 3:** Document: RUNNING.md gains the per-instance runbook (spec
  §8 verbatim: deploy dark → preflight via `cloudron exec npm run preflight
  -w core` → Cloudron backup as THE restore point → flip + restart → verify
  list → repeat per instance, alice → bob → main; retirement ships later);
  the rollback posture stated honestly (backup-restore + forward fixes, no
  downgrade path); `RSC_MIGRATION_MANIFEST` and the manifest schema; both
  env examples updated. Update the `RSC_TOKEN` row ("its one remaining job"
  becomes the ops route at cutover).
- [ ] **Step 4:** Run the completion gate (V2 §7.5 unchanged):
  `npm test -w core`, `npm run typecheck -w core`, `npm test -w web`,
  `npm run check -w web`, `npm run build -w web`; all exit 0. Run
  `/ponytail-review` on the branch diff. Commit per Appendix C and stop for
  the whole-vertical review. Cutover on live instances follows the runbook,
  not this plan's execution.

### Task 11: Legacy retirement — a SEPARATE release after cutover has soaked

**Files:** Modify `core/src/server.ts`, `core/src/config.ts`,
`core/src/api/app.ts`, `core/src/domain/push-in.ts` (delete/move),
`core/src/logical/push.ts`, the legacy web loader/action branches, affected
core/web tests; exact inventory fixed at execution time against the then-real
tree.

**Execution gate: do NOT execute with Tasks 1–10.** This task ships as its
own release only after all three instances have soaked on the flipped image
(runbook step 8). Nothing here changes wire contracts — it deletes the branch
the flag kept dark.

- [ ] **Step 1:** Delete the v1 runtime branch: legacy remote polling and v1
  push-in wiring (`createPushIn`/`runPollCycle`, `core/src/server.ts:25,63`),
  moving the pure helpers (`verifySignature`, `choosePushTarget`, constants,
  `pushInEffective`) into `core/src/logical/push.ts`; legacy remote-author
  routes (`POST /users`, `DELETE /users/:handle`); the legacy timeline/feed
  branches; web's v1 loader/action branches. The off-flag gate assertions
  from Task 10 retire with the branch they guarded.
- [ ] **Step 2:** Flip the default: `RSC_SOURCE_MODEL_V2` defaults `on`;
  the variable stays recognized for one release (`off` rejected on a
  converted database per the Task 8 tripwire; meaningless on a fresh one —
  a fresh database converts trivially and activates), then retires entirely
  in a later cleanup. `/capabilities` remains permanently.
- [ ] **Step 3:** Legacy tables are **not dropped**: `users`, `posts`,
  `post_revisions`, `follows`, `subscriptions`, `instance_settings` keep
  live v2/shared roles; legacy `push_subscriptions` and inert remote `posts`
  rows stay per spec 3.2/3.4 (`ponytail: dropping storage is a later cleanup
  batch with zero feature value now; the migration array only ever appends`).
- [ ] **Step 4:** Run the full completion gate; all exit 0. Commit per
  Appendix C; deploy as an ordinary image update to all three instances.

### Task 12: The final cross-vertical contract review gate

**Files:** Create `docs/superpowers/reviews/2026-07-23-cross-vertical-contract-review.md`;
fold resulting revs into the four plans as needed.

**Execution order: FIRST.** This review runs immediately after this plan's
own review, **before Task 1 of any vertical** (spec §11: the review must be
folded into all four plans before any implementation begins). It is listed
last because it is V4's completion-gate precondition. Dispatch it as its own
review in a clean sub-context (the standing `ponytail-review-specs-plans`
practice), over the four plan documents — not code. Checklist (spec §10, plus
this plan's additions):

- [ ] **CHECK vocabulary wide everywhere:** `source_audit_v2.category` nine
  values + `actor_kind` incl. `operator_token` + `command_ledger_v2.actor_scope`
  incl. `ops` (V1 rev 5 Task 1); `item_audit_v2` and
  `blocked_source_tombstones_v2` nine-wide (V3 rev 2 Appendix A);
  `presentation_entries_v2.provenance` three-wide (V2 rev 6, this plan's
  amendment) while `acquisition_runs_v2.reason` stays two-wide — V4 widens
  no reason enum (push provenance is this plan's own additive tail-migration
  column, Appendix A); TS enums narrowed per vertical everywhere.
- [ ] **Capability supersession chain frozen:** V1's boolean shape → V2's
  discriminated shape (§5.6) is the ONLY widening; V3 and V4 add no field;
  V1's exact-equality tests are superseded exactly once (V2 Task 5 Step 4a);
  the flip is a value change on the frozen shape, core-only.
- [ ] **Command conventions uniform:** body `commandId` only; fingerprints
  follow `[command, resource, actor, semantic-payload]` — verify every pinned
  fingerprint across the four plans, including this plan's ops route reusing
  V1's `["federation", normalizedUrl, attributionMode]`; `jsonWrite` composed
  by import everywhere (V2 rev 5 export pin).
- [ ] **Lockstep amendments landed:** V1 rev 5 CHECK pin; V2 rev 5's three
  (verification-ready jobs table, broadened interim cleanup,
  `source_aliases_v2` + writer); V2 rev 6's provenance-CHECK amendment plus
  its non-blocking `push_capability_json` shape pin (this plan); V3 §1.2's
  dated amendment; `policy_generation` owned by V2 (`ALTER TABLE`, V2
  Appendix A); `SourceSummary.push` deferred to V4 and narrowed to the
  two-state union in every mention. Verify BOTH V2 stale validation
  pointers now read Vertical **4** — Appendix A ~L574 AND Task 4 Step 1b
  ~L340 (fixed in V2 rev 6; push left V3 entirely).
- [ ] **Declared supersessions are declared, not drift:** `updatedAtProvenance`
  + `legacy_unknown` (V4), `AttributionLevel` four-level (V3),
  `ReconciliationClaim` union (V3),
  `establishFederation` actor-kind widening (V4), the capability shape (V2).
- [ ] **No vertical leaks:** each plan's off-flag isolation asserts its own
  additions only; no plan tests another vertical's surface; push code appears
  in no plan before V4; V4 adds no third scheduling loop, no findings
  relation, no new sanitizer path, no new dependency.
- [ ] Record findings in the review document; fold accepted items as
  numbered revs into the affected plans. Only then does Vertical 1's
  implementation begin. Commit per Appendix C.

## Appendix A: exact migration inventory

One migration entry appended at the tail of `MIGRATIONS`
(`core/src/storage/sqlite.ts:566`) calling `installV4Schema(raw)` in
`core/src/logical/schema.ts`. Timestamps are normalized UTC `TEXT`.
Conversion itself (Tasks 5–7) is **not** a migration entry: migrations run
unconditionally at startup; conversion is flag-triggered and marker-guarded.

```text
push_subscriptions_v2(
 id TEXT PRIMARY KEY,
 source_id TEXT NOT NULL REFERENCES remote_sources_v2(id) ON DELETE CASCADE,
 mode TEXT NOT NULL CHECK(mode IN('websub','rsscloud')),
 endpoint TEXT NOT NULL, topic TEXT NOT NULL,
 callback_token TEXT NOT NULL UNIQUE,
 secret TEXT,
 state TEXT NOT NULL CHECK(state IN('pending','active')),
 expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(source_id, mode))
CREATE INDEX push_subscriptions_v2_expires ON push_subscriptions_v2(state, expires_at)
handle_reservations_v2(
 handle TEXT PRIMARY KEY,
 source_id TEXT NOT NULL,      -- no FK: the reservation survives source
 publisher_id TEXT NOT NULL,   -- removal and purge (foundation §12)
 created_at TEXT NOT NULL)
ALTER TABLE logical_activation_v2 ADD COLUMN converted_at TEXT
ALTER TABLE logical_activation_v2 ADD COLUMN conversion_findings_json TEXT
ALTER TABLE acquisition_runs_v2 ADD COLUMN delivery_mechanism TEXT
                               -- 'push' when a ping created the run; NULL otherwise
```

Notes. The push CASCADE is deliberate (V3 §5.2: purge deletes push state with
the rest of the operational state) and keeps V3's `PRAGMA foreign_key_list`
purge-inventory test green — only RESTRICT edges must be inventoried. The
conversion marker extends V2's activation singleton instead of adding a table
(spec §9 offered the choice; `converted_at IS NOT NULL` is marker-present,
`conversion_findings_json` holds the per-kind counts). There is no findings
relation and no run-claim table: the parse-time capability claim binds to
`acquisition_runs_v2.push_capability_json` (V2 Appendix A, WP4). Push
provenance is the nullable `delivery_mechanism` column — `'push'` when a
ping created the run, NULL otherwise; `acquisition_runs_v2.reason` keeps
V2's two values (spec §1.4 records the mechanism, not a new reason). The
two-state `state` CHECK is the WP1 pin — deliberately narrower than nothing:
migration-time expired/invalid facts are findings, never rows.

## Appendix C: mandatory per-task commands and commits

A task is not complete until its row passes exactly. Red = same command
before implementation failing on the named absent symbol/behavior; green =
exit 0 after.

| Task | Red/green command | Explicit staged paths | Commit subject |
|---|---|---|---|
| 1 | `npm test -w core -- v4-schema config && npm run typecheck -w core` | `core/src/logical/schema.ts core/src/logical/types.ts core/src/domain/types.ts core/src/storage/sqlite.ts core/src/config.ts core/test/v4-schema.test.ts core/test/config.test.ts` | `core: add v4 push and cutover schema` |
| 2 | `npm test -w core -- logical-push logical-scheduler && npm run typecheck -w core` | `core/src/logical/push.ts core/src/logical/store.ts core/src/logical/scheduler.ts core/test/logical-push.test.ts core/test/logical-scheduler.test.ts` | `core: register and renew v2 push leases` |
| 3 | `npm test -w core -- logical-push-callbacks source-admin-api && npm run typecheck -w core && npm test -w web -- source-detail` | `core/src/logical/push.ts core/src/logical/store.ts core/src/logical/runtime.ts core/src/server.ts core/src/domain/source-repository.ts core/src/api/logical-routes.ts core/test/logical-push-callbacks.test.ts core/test/source-admin-api.test.ts web/src/routes/admin/sources/[sourceId]/+page.server.ts web/src/routes/admin/sources/[sourceId]/+page.svelte web/src/routes/admin/sources/[sourceId]/source-detail.test.ts` | `core: serve v2 push callbacks and admin push state` |
| 4 | `npm test -w core -- migration-preflight && npm run typecheck -w core` | `core/src/migration/preflight.ts core/src/migration/preflight-cli.ts core/package.json core/test/migration-preflight.test.ts` | `core: add migration preflight and manifest` |
| 5 | `npm test -w core -- migration-convert service && npm run typecheck -w core` | `core/src/migration/convert.ts core/src/storage/sqlite.ts core/src/domain/service.ts core/test/migration-convert.test.ts core/test/service.test.ts` | `core: convert legacy sources and follows` |
| 6 | `npm test -w core -- migration-convert logical-projector && npm run typecheck -w core` | `core/src/migration/convert.ts core/test/migration-convert.test.ts` | `core: convert legacy posts into logical items` |
| 7 | `npm test -w core -- migration-convert && npm run typecheck -w core` | `core/src/migration/convert.ts core/test/migration-convert.test.ts` | `core: preserve push leases across conversion` |
| 8 | `npm test -w core -- migration-cutover logical-runtime && npm run typecheck -w core && npm test -w web -- u-page` | `core/src/logical/runtime.ts core/src/server.ts core/src/api/logical-routes.ts core/src/migration/convert.ts core/test/migration-cutover.test.ts core/test/logical-runtime.test.ts web/src/routes/u/[handle]/+page.server.ts web/src/routes/u/[handle]/u-page.test.ts` | `core: run conversion inside v2 activation` |
| 9 | `npm test -w core -- source-ops-api source-admin-api && npm run typecheck -w core` | `core/src/api/logical-routes.ts core/src/domain/source-service.ts core/test/source-ops-api.test.ts` | `core: add the ops-token federation route` |
| 10 | full completion gate in Task 10 | `core/test/logical-v4-vertical.test.ts docs/superpowers/documentation/RUNNING.md .env.example core/.env.example` | `test: gate the v4 migration cutover vertical` |
| 11 | full completion gate (separate release) | exact inventory fixed at execution time | `core: retire the legacy v1 branch` |
| 12 | n/a (document review) | `docs/superpowers/reviews/2026-07-23-cross-vertical-contract-review.md` + any folded plan revs | `docs: fold the cross-vertical contract review` |

Every subject is committed with this exact final paragraph:

```text
developed with the help of AI tools
```

## Appendix D: representative executable tests

Use these exact assertions in the named red suites; expand table cases
without changing the contracts:

```ts
// core/test/migration-convert.test.ts — exact ID + byte-exact push preservation
const counts = db.write((tx) => runConversion(tx, {manifest: null, now: NOW, log}))
expect(get(raw, 'remote_sources_v2', legacyUser.id)).toMatchObject({
  id: legacyUser.id, provenance: 'migration', policy_generation: 0})
expect(get(raw, 'logical_items_v2', legacyPost.id)).toBeDefined()
const v2Push = raw.prepare('SELECT * FROM push_subscriptions_v2 WHERE source_id=?').get(legacyUser.id)
for (const [a, b] of [['mode','mode'],['endpoint','endpoint'],['topic','topic'],
  ['callback_token','callback_token'],['secret','secret'],['state','state'],
  ['expires_at','expires_at'],['created_at','created_at']])
  expect(v2Push[a]).toBe(legacyPushRow[b])           // byte-exact, per spec §11
expect(counts.push_expired).toBe(1)                   // the seeded expired row: no live row
expect(count(raw, 'push_subscriptions_v2')).toBe(1)

// core/test/migration-cutover.test.ts — the two tripwires
expect(() => startCore({sourceModelV2: false, db: convertedDb}))
  .toThrow(/converted database requires RSC_SOURCE_MODEL_V2=on.*restore the pre-flip backup/)
expect(() => startCore({sourceModelV2: true, db: activeButUnmarkedDb}))
  .toThrow(/activation active without conversion marker/)
```

## V3 execution handoff (2026-07-24, recorded after the V3 whole-branch review — 19 commits 18eefbc..b4144e2, READY WITH FOLLOW-UPS)

Facts the V3 execution produced that this plan's implementer must know. They
are recorded here because the next implementer starts from this plan, not
from V3's history.

1. **A pre-V4 fix wave gates this plan's start.** Three discoveries from the
   V3 whole-branch review are being fixed in the V3 lane BEFORE V4 begins:
   (I1) the verification drain (network I/O, worst-case minutes) was awaited
   on pre-listen `ready` and on the acquisition result path
   (`core/src/logical/runtime.ts`) — it moves to the background cadence;
   (n2) a verification job exhausted via `recordDrainFailure` never
   terminalized its pending `verification_checks_v2` rows, permanently
   consuming the per-source URL caps; (n1) `persistVerifiedDelivery`'s
   presentation write bypassed `applyPresentation` (null `updatedAt`, skipped
   rollback watermark). **Contract this plan inherits: pre-listen startup
   performs NO network I/O.** V4's conversion transaction extends the
   activation barrier — do not reintroduce an awaited network drain there.

   **Clarification (2026-07-24, from the I1 fix review — read the sentence
   above as this):** the binding contract is **no AWAITED network I/O before
   the process listens.** `runtime.ready` performs local DB work only and is
   awaited by `server.ts` before `listen`; nothing it awaits does network I/O.
   It is NOT true that zero network activity begins pre-listen: `ready` ends
   with `scheduler.start()`, which fires `void tick()` synchronously, so the
   poll loop's own acquisition fetches BEGIN (unawaited) inside
   `createLogicalRuntime()`. That is pre-existing, unchanged by I1, and does
   not delay listening — startup stays fast and deterministic because nothing
   awaited blocks the barrier. Verification specifically is off BOTH the
   startup and the request paths: it rides the scheduler tick only
   (`SchedulerDeps.drainVerification`, required since `6024d47`). V4 keeps the
   awaited half empty of network I/O; it need not keep the background loop
   from starting.
2. **The sync-drain regression canary must stay meaningful.**
   `core/test/logical-v3-vertical.test.ts` asserts that a runtime regressed
   to the synchronous drain leaves verification checks `pending`. After the
   I1 fix this proof drives the background path explicitly; any V4 runtime
   change must keep that assertion honest rather than satisfying it by
   re-awaiting the drain at startup.
3. **Flag-OFF isolation is behavioral, not load-level.**
   `core/src/domain/source-repository.ts` statically imports v2 logical
   modules, so they LOAD with the flag off (server.ts comments corrected in
   3f688f8). This plan's off-flag gate assertions (spec WP3) must assert
   routing/behavior, never module non-loading.
4. **The tombstone guard is wired by signature.** `createSourcePlane`
   (`core/src/domain/source-service.ts`) takes `logicalStore` as a REQUIRED
   positional parameter — omitting it is a compile error; explicit
   `undefined` is the flag-off posture. V4's cutover composition always
   passes the real store. Do not "clean up" the signature into an optional.
5. **Still-open chores this plan may batch into a fix round:** the OPML
   per-test timeout bump (two known load-timeout flakes under full-suite
   contention, carried since V2); the deriveRoot/permalink-normalizer
   drift canary for the 3× char-identical duplications (called for in the
   V2→V3 handoff, never added — verified absent 2026-07-24).
6. **Live-path backfill remains open.** Step 3 of the conversion covers the
   historical local-parent bridge rows; the LIVE-path variant (a local reply
   posted while the flag is on, to a remote parent not yet materialized)
   was carried from V2 and not addressed by V3 — verify during Task 6 or
   record it as a counted finding class.
7. **Accepted-and-tracked debt (do not re-litigate):** §2.4 display-axis
   `verified_origin` is exercised comparator-only (the integration wiring
   cannot yet produce it — named in b4144e2); the two v1 `test.fails()`
   orphaning markers stay fenced until THIS plan's cutover flips them.

## Plan correction (2026-07-24, Task 5 maintainer adjudication)

Task 5's step for `core/src/migration/convert.ts` said an aggregate source's
publisher gets the source-scoped fallback (spec §3.2). **It does not.** Every
converted source — single_publisher, manifest-approved aggregate, and
quarantined instance alike — mints its publisher as
`identity_level = 'feed_anchored'` with `canonical_feed_url` set to the
source's normalized canonical URL, keyed EXACTLY as `getOrCreatePublisher`
(`core/src/logical/reconcile.ts:196`) keys it.

Why the plan's original wording was wrong:

1. **The spec contradicts itself and the live stack already resolved it.**
   §3.2 asks for the fallback on aggregates; V3 §3.6 grants a publisher page
   only to a feed-anchored publisher and returns an ordinary `404` for a
   source-scoped fallback. `projector.ts`'s `resolvePublisher` is §3.6
   implemented faithfully, so honouring §3.2 literally produces rows the whole
   read stack refuses to serve — and §3.5's **permanent** `/u/:handle` →
   `/p/:publisherId` redirect for every converted instance handle becomes a
   permanent redirect to a 404. That is not one function's bug; it is two spec
   sections colliding. **§3.6 governs, because it is what every reader
   depends on.**
2. **V4's charter is preservation, not reform.** Changing live-path publisher
   semantics inside the migration vertical is out of scope; §2.4 attribution
   stays recorded, accepted debt (V3 execution handoff item 7 above).
3. **Homogeneity.** One rule mints every publisher row pre- and post-cutover,
   so the eventual §2.4 fix migrates one uniform population once rather than
   reconciling two populations minted under different regimes.

Consequences for later tasks:

- `handle_reservations_v2.publisher_id` now points at the same publisher the
  live reconcile resolves, so **Task 8's** `/u/:handle` → `/p/:publisherId`
  redirect resolves to a real publisher page. Task 8 carries a binding
  requirement for an end-to-end `200` proof of that redirect; it is not
  stubbed here.
- No count changed: publisher identity level was never a counted finding, and
  `zeroCounts()` is untouched.
- Pinned permanently by the convergence test in
  `core/test/migration-convert.test.ts` ("a converted AGGREGATE source
  reconciles onto its converted publisher — zero new mints"), which converts
  an aggregate, runs the real acquire + `drainReconciliation` over it, and
  asserts `COUNT(*) FROM remote_publishers_v2 = 1`. It fails against the
  pre-adjudication code with `expected 2 to be 1`.
- Recorded on the spec as a dated amendment beneath §3.2, and in
  `docs/superpowers/ideas.md` as the migrate-existing-rows obligation the
  §2.4 fix inherits.
