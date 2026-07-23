# RSC Source Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a disabled v2 source registry and exercise source resolution, subscriptions, federation, and lifecycle management end to end without changing legacy ingestion or breaking the default-off web experience.

**Revision:** 5 — **status: reviewed-ready.** Folds the consolidated plan
review `../reviews/2026-07-22-v1-source-control-plane-review.md` (HIGH 1–3:
parallel non-sticky capability fetch with legacy fallback, the two omitted web
test files, admin authz 401 for sessionless ops actors; IMPORTANT 4–6: pinned
idempotency fingerprints, completed transition matrix, `jsonWrite` on every new
v2 POST; MEDIUM 7–8, the minors, and the maintainer's DEFER-all decision on the
~150 lines of forward surface) **as modified by the V4 §10 CHECK-vocabulary
pin** (`../specs/2026-07-22-rsc-migration-cutover-design.md` §10 item 1, dated
lockstep amendment in
`../specs/2026-07-22-rsc-moderation-events-verification-design.md` §1.2): SQL
CHECKs are created WIDE with the full foundation vocabulary while TS enums stay
narrowed to V1's used subset. See "Rev 5 fold notes" below for each deferral's
reintroduction pointer. Rev 4 added exact pending mutation responses,
subscription side effects on allow/approval, deterministic public labels,
verification-source retention, and smaller mutation substeps.

**Architecture:** Add expand-only v2 tables behind a repository whose mutation
commands each own one `BEGIN IMMEDIATE` transaction and one general command
ledger. Core exposes an always-available capability flag; web preserves its
current v1 loaders/actions while the flag is off and uses stable-ID v2 routes
only while it is on. No v2 remote items exist in this vertical.

**Tech Stack:** Node 22 native TypeScript, Hono, better-sqlite3/Kysely, Vitest,
SvelteKit/Svelte 5.

## Global Constraints

- Governing spec: `docs/superpowers/specs/2026-07-20-rsc-source-governance-moderation-design.md` rev 3.
- `RSC_SOURCE_MODEL_V2` accepts only `on | off` and defaults to `off`.
- No dual writes, rollout percentages, distributed locks, new dependencies, or remote-item migration.
- Normalize only scheme/host/default port and remove fragments; preserve path, query, trailing slash, and HTTP/HTTPS. Reject credentials and URLs longer than 2048 characters.
- Resolve canonical local-account feeds before applying the existing SSRF guard to remote URLs.
- Raw URLs are accepted only by resolution/creation endpoints. Later mutations use stable IDs.
- Core returns semantic JSON and never hidden administrative fields in ordinary DTOs. Web alone renders/sanitizes HTML.
- Core route work invokes `.claude/skills/hono/SKILL.md`; web work invokes the required Svelte/UI skills and follows `design-system/rsc/MASTER.md`.
- No TypeScript parameter properties in `core/src`.
- Stage explicit paths only. Every commit message ends with `developed with the help of AI tools`.
- During implementation, use Docker verification when the stack is running; otherwise use the host commands from `AGENTS.md`.

## Rev 5 fold notes — deferrals and the CHECK-vocabulary pin

**Deferred forward surface** (review decision 2026-07-22: defer all of it;
each item returns in the vertical that first writes it — these are the ONLY
intentional mentions of the deferred names in this plan):

- `source_aliases_v2` table (+ `SourceAlias` type, `listSourceAliases`,
  `aliasCount`, alias-resolution branches, `GET /admin/sources/:id/aliases`) —
  reintroduced in V2, whose redirect-identity handling is the first alias
  writer.
- `blocked_source_tombstones_v2` table (+ tombstone-resolution branches in
  subscribe/federation) — reintroduced in V3; purge is the first writer
  (V3 §5.1–5.2).
- `policy_generation` column (+ `RemoteSource.policyGeneration`, its
  transition increment, and its DTO/redaction-test references) — added by
  V2's plan, whose fan-out first reads it (V2 §2.3/§3.7; V4 §10 item 2).
  Verified safe: the ledger stores `result_json` opaquely, so old rows replay
  their stored shape and V2 adds the field without a persisted-format break.
- `SourceSummary.push` / `.health` / `.itemCount` / `.deliveryCount` — `push`
  is first written in V4 (V4 §10 item 5, narrowed to the two-state union);
  health and the counters arrive with V2 acquisition (V2 §6).
- The `origin_verification` retention branch in last-subscription cleanup —
  reintroduced in V3 with real retained verification evidence; V1 keeps the
  provenance value in the enum and CHECK (no V1 writer creates it).
- `POST /ops/sources/federation` — owned by V4, which adopts this plan's
  former Task 7 Step 3 contract verbatim (V4 §6) when the legacy
  `POST /users` token job retires. V1 ships no ops route; the TS-side
  `operator_token` actor kind and `ops` ledger scope go with it.
- `AuditCategory` values `migration_review` / `false_positive` / `remediated`
  — removed from the TS enum only (no V1 emitter); V3 re-adds
  `false_positive`/`remediated`, V4 `migration_review`.

**CHECK-vocabulary pin (V4 §10 item 1; lockstep amendment 2026-07-22 in V3
§1.2) — overrides the review's schema-side removals:** SQLite cannot widen a
CHECK without a table rebuild, so the SQL CHECKs are created WIDE with the
full foundation vocabulary — `source_audit_v2.category` keeps **all nine**
audit categories, `source_audit_v2.actor_kind` keeps `operator_token`, and
`command_ledger_v2.actor_scope` keeps `ops` — while the TS enums stay
narrowed to each vertical's used subset (V1: six categories,
`administrator | system`, no `ops` scope). Nothing ever widens
`source_audit_v2` **after creation** because it is created wide.

**Capability-shape widening site (V2 §5.6, review C5):** V2 deliberately
supersedes `{sourceModelV2: boolean}` with a discriminated shape
(`{sourceModelV2:false} | {sourceModelV2:true; model:'logical-v2';
journalCursorVersion; streamProtocolVersion}`). This plan's exact-equality
capability test (`toEqual({sourceModelV2:true})`, Task 7) is a **known
widening site** that V2's plan updates — implement it as written here; do not
pre-widen.

**Deploy ordering (Finding 1):** `/capabilities` must be live on all core
instances before the new web is promoted; web degrades to the legacy path on
any capability-fetch failure and never below today's behavior (Task 8,
Task 10 RUNNING.md note).

## Shared contracts

Define these once in `core/src/domain/types.ts`; later tasks use the names
verbatim:

```ts
export type AttributionMode = 'single_publisher' | 'aggregate'
export type SourceOperation = 'enabled' | 'paused'
export type SourceGovernance = 'allowed' | 'quarantined' | 'blocked'
export type FederationStatus = 'pending' | 'approved'
export type SourceSubscriptionState = 'active' | 'pending' | 'pending_review'
// TS enum narrowed to V1's emitters; the SQL CHECK keeps all nine foundation
// values (rev 5, V4 §10 pin). V3/V4 re-add the deferred members.
export type AuditCategory =
  | 'spam' | 'abuse' | 'illegal_content' | 'compromised_source'
  | 'operator_policy' | 'other'

export interface RemoteSource {
  id: string
  canonicalUrl: string
  attributionMode: AttributionMode
  operation: SourceOperation
  governance: SourceGovernance
  provenance: 'user_subscription' | 'opml' | 'admin_federation' | 'origin_verification' | 'migration'
  provenanceNote: string | null
  adminRetained: boolean
  createdAt: string
}
export interface FederationRelationship {
  sourceId: string
  status: FederationStatus
  provenanceNote: string | null
  createdAt: string
  updatedAt: string
}
export interface SourceSubscription {
  id: string
  ownerId: string
  sourceId: string
  state: SourceSubscriptionState
  createdAt: string
}
export interface CommandEnvelope {
  // TS narrowed for V1; the SQL CHECK keeps 'ops' (rev 5, V4 §10 pin)
  actorScope: 'owner' | 'administrator' | 'system'
  actorId: string
  commandId: string
  requestFingerprint: string
}
export interface SourceAuditEvent {
  id: string
  sourceId: string
  commandId: string
  actorId: string | null
  // TS narrowed for V1; the SQL CHECK keeps 'operator_token' (rev 5, V4 §10 pin)
  actorKind: 'administrator' | 'system'
  action: string
  category: AuditCategory | null
  note: string | null
  resultJson: string
  createdAt: string
}
export interface OwnerSourceFollow {
  sourceId: string
  url: string
  attributionMode: AttributionMode
  subscriptionState: SourceSubscriptionState
  availability: 'available' | 'awaiting_review' | 'unavailable'
}
export interface PublicLocalFollow {
  kind: 'local'
  id: string
  handle: string
  displayName: string
}
export interface PublicSourceFollow {
  kind: 'source'
  sourceId: string
  url: string
  displayName: string
}
export type PublicFollowingEntry = PublicLocalFollow | PublicSourceFollow
export interface OwnerFollowingView {
  localFollows: PublicLocalFollow[]
  sourceSubscriptions: OwnerSourceFollow[]
}
export interface Page<T> { items: T[]; nextCursor: string | null }
export interface SourceSummary {
  source: RemoteSource
  federationStatus: 'none' | FederationStatus
  subscriptionCounts: { active: number; pending: number; pendingReview: number }
}
export interface SourceDetail extends SourceSummary {
  latestAudit: SourceAuditEvent | null
}
export type SourceTransitionResult =
  | {kind:'applied'; source:RemoteSource; audit:SourceAuditEvent}
  | {kind:'unknown'|'conflict'}
```

Ordinary routes return only `OwnerSourceFollow` or `PublicFollowingEntry`.
`RemoteSource`, provenance, governance, operation, retention, audit, and
subscriber counts are restricted to authenticated administrative routes.

`PublicSourceFollow.displayName` is deterministic presentation data, not stored
source identity: use `new URL(canonicalUrl).hostname`; if URL construction fails
for already-retained corrupt evidence, fall back to the complete canonical URL.

---

### Task 1: Feature flag and expand-only schema

**Files:**
- Modify: `core/src/config.ts`
- Modify: `core/src/domain/types.ts`
- Modify: `core/src/storage/sqlite.ts`
- Modify: `core/test/config.test.ts`
- Create: `core/test/source-schema.test.ts`

**Interfaces:** Produces `Config.sourceModelV2` and the Shared contracts. Creates
v2 tables but no repository behavior.

- [ ] **Step 1: Add the failing flag test**

```ts
test('RSC_SOURCE_MODEL_V2 defaults off and accepts only on/off', () => {
  const base = { RSC_TOKEN: 't', RSC_AUTH_SECRET: 's' }
  expect(loadConfig(base).sourceModelV2).toBe(false)
  expect(loadConfig({ ...base, RSC_SOURCE_MODEL_V2: 'on' }).sourceModelV2).toBe(true)
  expect(() => loadConfig({ ...base, RSC_SOURCE_MODEL_V2: 'yes' })).toThrow('RSC_SOURCE_MODEL_V2')
})
```

- [ ] **Step 2: Add the failing schema test**

```ts
test('creates the five v2 source-control tables', async () => {
  const repo = await createSqliteRepository(':memory:')
  const rows = repo.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name:string}>
  expect(rows.map((r) => r.name)).toEqual(expect.arrayContaining([
    'remote_sources_v2', 'federation_relationships_v2',
    'source_subscriptions_v2', 'source_audit_v2', 'command_ledger_v2',
  ]))
  repo.close()
})
```

- [ ] **Step 3: Run red tests**

Run: `npm test -w core -- config source-schema`

Expected: FAIL because the config field and tables are absent.

- [ ] **Step 4: Add the field, Shared contracts, and one final migration**

**Append the new entry at the END of the `MIGRATIONS` array** — mid-array
insertion would renumber entries and corrupt `user_version` on populated
databases.

The SQL CHECKs below are deliberately WIDER than the V1 TS enums (rev 5, V4
§10 pin; lockstep amendment in V3 §1.2): `source_audit_v2.category` carries
all nine foundation categories while `AuditCategory` lists six; `actor_kind`
carries `operator_token`; `command_ledger_v2.actor_scope` carries `ops`.
SQLite cannot widen a CHECK without a table rebuild, so the vocabulary is
pinned wide at creation; nothing ever widens these tables after creation
because they are created wide.

Use this exact SQL through the migration's existing `CREATE TABLE` string style:

```sql
CREATE TABLE remote_sources_v2 (
 id TEXT PRIMARY KEY, canonical_url TEXT NOT NULL UNIQUE,
 attribution_mode TEXT NOT NULL CHECK(attribution_mode IN ('single_publisher','aggregate')),
 operation TEXT NOT NULL CHECK(operation IN ('enabled','paused')),
 governance TEXT NOT NULL CHECK(governance IN ('allowed','quarantined','blocked')),
 provenance TEXT NOT NULL CHECK(provenance IN ('user_subscription','opml','admin_federation','origin_verification','migration')),
 provenance_note TEXT, admin_retained INTEGER NOT NULL DEFAULT 0 CHECK(admin_retained IN (0,1)),
 created_at TEXT NOT NULL
);
CREATE TABLE federation_relationships_v2 (
 source_id TEXT PRIMARY KEY REFERENCES remote_sources_v2(id) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK(status IN ('pending','approved')),
 provenance_note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE source_subscriptions_v2 (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 source_id TEXT NOT NULL REFERENCES remote_sources_v2(id) ON DELETE CASCADE,
 state TEXT NOT NULL CHECK(state IN ('active','pending','pending_review')),
 created_at TEXT NOT NULL, UNIQUE(owner_id,source_id)
);
CREATE TABLE source_audit_v2 (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES remote_sources_v2(id) ON DELETE CASCADE,
 command_id TEXT NOT NULL, actor_id TEXT,
 actor_kind TEXT NOT NULL CHECK(actor_kind IN ('administrator','operator_token','system')),
 action TEXT NOT NULL,
 category TEXT CHECK(category IS NULL OR category IN ('spam','abuse','illegal_content','compromised_source','migration_review','operator_policy','false_positive','remediated','other')),
 note TEXT, result_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE command_ledger_v2 (
 actor_scope TEXT NOT NULL CHECK(actor_scope IN ('owner','administrator','ops','system')),
 actor_id TEXT NOT NULL, command_id TEXT NOT NULL, request_fingerprint TEXT NOT NULL,
 result_json TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(actor_scope,actor_id,command_id)
);
CREATE INDEX remote_sources_v2_page ON remote_sources_v2(created_at DESC,id DESC);
CREATE INDEX source_subscriptions_v2_owner_state ON source_subscriptions_v2(owner_id,state,source_id);
CREATE INDEX source_audit_v2_page ON source_audit_v2(source_id,created_at DESC,id DESC);
```

Keep legacy tables and methods unchanged.

- [ ] **Step 5: Run green tests and commit**

Run: `npm test -w core -- config source-schema && npm run typecheck -w core`

Expected: PASS and exit 0.

```bash
git add core/src/config.ts core/src/domain/types.ts core/src/storage/sqlite.ts core/test/config.test.ts core/test/source-schema.test.ts
git commit -m "core: add disabled v2 source schema

developed with the help of AI tools"
```

---

### Task 2: General command ledger and administrative reads

**Files:**
- Create: `core/src/domain/source-repository.ts`
- Modify: `core/src/storage/sqlite.ts`
- Create: `core/test/source-ledger.test.ts`
- Create: `core/test/source-reads.test.ts`

**Interfaces:** Produces the repository read methods and the transaction helper
used by every later mutation.

```ts
export interface SourceRepository {
  getSource(id: string): Promise<RemoteSource | undefined>
  listSourceSummaries(cursor: {createdAt:string;id:string}|undefined, limit:number): Promise<Page<SourceSummary>>
  getSourceDetail(id: string): Promise<SourceDetail | undefined>
  listSourceSubscriptions(sourceId:string, cursor:{createdAt:string;id:string}|undefined, limit:number): Promise<Page<SourceSubscription>>
  listSourceAudit(sourceId:string, cursor:{createdAt:string;id:string}|undefined, limit:number): Promise<Page<SourceAuditEvent>>
}
```

- [ ] **Step 1: Test ledger replay and conflict**

```ts
test('ledger returns the original result and rejects changed reuse', async () => {
  const first = await repo.testCommand(env('c1', 'hash-a'), () => ({kind:'written'}))
  const replay = await repo.testCommand(env('c1', 'hash-a'), () => ({kind:'wrong'}))
  const conflict = await repo.testCommand(env('c1', 'hash-b'), () => ({kind:'wrong'}))
  expect(first).toEqual({kind:'written'})
  expect(replay).toEqual(first)
  expect(conflict).toEqual({kind:'conflict'})
  expect(countLedger(repo)).toBe(1)
})
```

- [ ] **Step 2: Test DTO mapping and stable pagination**

Seed two sources plus audit/subscription rows with equal timestamps. Assert
`listSourceSummaries(undefined, 1)` returns one row plus a cursor; the second
page returns the other stable ID once. `SourceSummary` carries only the
source, federation status, and subscription counts (item/delivery counts,
push, and health are deferred — rev 5); never derive summary fields from
legacy remote-user state.

```ts
const first = await repo.listSourceSummaries(undefined, 1)
const second = await repo.listSourceSummaries(decodeCursor(first.nextCursor!), 1)
expect(new Set([...first.items, ...second.items].map((x) => x.source.id)).size).toBe(2)
expect(Object.keys(first.items[0]).sort()).toEqual(['federationStatus','source','subscriptionCounts'])
expect((await repo.getSourceDetail(first.items[0].source.id))!.latestAudit)
  .toMatchObject({id: newestSeededAudit.id}) // newest seeded audit row, not a list
```

- [ ] **Step 3: Run red tests**

Run: `npm test -w core -- source-ledger source-reads`

Expected: FAIL because the repository/helper/read mappings are absent.

- [ ] **Step 4: Implement the ledger helper**

The helper runs inside the caller's `BEGIN IMMEDIATE` transaction:

```ts
type LedgerCheck<T> = {kind:'new'} | {kind:'replay'; result:T} | {kind:'conflict'}
checkCommand<T>(tx: Database, command: CommandEnvelope): LedgerCheck<T>
storeCommand<T>(tx: Database, command: CommandEnvelope, result: T, now: string): void
```

Same key+fingerprint deserializes `result_json`; changed fingerprint conflicts.

- [ ] **Step 5: Implement administrative read queries**

Encode cursors as base64url JSON of the displayed timestamp and stable ID/URL,
order descending by both columns, fetch `limit + 1`, and cap limits to 1–100.

- [ ] **Step 6: Run green tests and commit**

Run: `npm test -w core -- source-ledger source-reads && npm run typecheck -w core`

Expected: PASS and exit 0.

```bash
git add core/src/domain/source-repository.ts core/src/storage/sqlite.ts core/test/source-ledger.test.ts core/test/source-reads.test.ts
git commit -m "core: add v2 command ledger and source reads

developed with the help of AI tools"
```

---

### Task 3: Canonical URL resolution and direct subscription

**Files:**
- Create: `core/src/domain/source-url.ts`
- Create: `core/src/domain/source-service.ts`
- Modify: `core/src/domain/source-repository.ts`
- Modify: `core/src/storage/sqlite.ts`
- Create: `core/test/source-subscribe.test.ts`
- Modify: `core/test/push-guard.test.ts`

**Interfaces:** Adds `followLocalAccount` and `resolveAndSubscribeSource`, each a
single ledger-backed transaction. Produces owner-projected subscription results.

```ts
export type SubscribeResult =
  | {kind:'source'; created:boolean; subscription:OwnerSourceFollow}
  | {kind:'local'; created:boolean; follow:PublicLocalFollow}
  | {kind:'unavailable'|'not_subscribable'|'cap'|'conflict'}
export interface SourceService {
  subscribeByUrl(owner:User, url:string, commandId:string): Promise<SubscribeResult>
}
```

- [ ] **Step 1: Test normalization and local-feed precedence**

```ts
expect(normalizeSourceUrl('HTTPS://Example.COM:443/feed/?x=1#f')).toBe('https://example.com/feed/?x=1')
expect(normalizeSourceUrl('http://example.com/feed/')).toBe('http://example.com/feed/')
expect(() => normalizeSourceUrl('https://u:p@example.com/feed')).toThrow('source URL invalid')
expect(() => normalizeSourceUrl(`https://example.com/${'x'.repeat(2049)}`)).toThrow('source URL invalid')
```

Subscribe to this instance's XML and JSON feed URLs and assert one local follow,
one ledger row, and zero v2 sources. Assert identical retry returns the stored
result and changed URL under the command ID conflicts.

- [ ] **Step 2: Test remote resolution and cap serialization**

Assert a new URL creates `single_publisher + enabled + allowed + federation
none + user_subscription`; paused retained sources are reused unchanged;
quarantined creates an `awaiting_review` pending projection; aggregate,
federation, and blocked targets return neutral results. Race two
final-slot subscriptions and expect one source result and one `cap`.

Inject the existing `checkCallbackUrl` guard and assert loopback, private,
link-local, and DNS-to-private remote URLs produce no v2 row. Local feeds bypass
that guard. Source creation performs no fetch; ingestion later rechecks every
redirect hop.

```ts
expect(await service.subscribeByUrl(owner, 'https://203.0.113.9/feed', 'c1'))
  .toMatchObject({kind:'source',created:true,subscription:{attributionMode:'single_publisher',subscriptionState:'active',availability:'available'}})
expect(await service.subscribeByUrl(owner, 'http://127.0.0.1/feed', 'c2')).toEqual({kind:'unavailable'})
const [a, b] = await Promise.all([
  service.subscribeByUrl(finalSlotOwner, 'https://203.0.113.10/a', 'c3'),
  service.subscribeByUrl(finalSlotOwner, 'https://203.0.113.11/b', 'c4'),
])
expect([a.kind,b.kind].sort()).toEqual(['cap','source'])
const existing = await service.subscribeByUrl(owner, 'https://203.0.113.9/feed', 'c5')
expect(existing).toMatchObject({kind:'source',created:false})
```

- [ ] **Step 3: Run red tests**

Run: `npm test -w core -- source-subscribe push-guard`

Expected: FAIL because normalization and commands are absent.

- [ ] **Step 4: Implement command entry and ledger replay**

```ts
followLocalAccount(input:{command:CommandEnvelope;ownerId:string;targetId:string;now:string}): Promise<SubscribeResult>
resolveAndSubscribeSource(input:{command:CommandEnvelope;ownerId:string;canonicalUrl:string;cap:number;now:string}): Promise<SubscribeResult>
```

`SourceService.subscribeByUrl` owns the raw-URL dispatch: it resolves
canonical local-account feed URLs first (reusing the `localHandleForUrl`
logic legacy runs inline at `core/src/api/app.ts:327`) and routes to
`followLocalAccount`, otherwise normalizes/SSRF-checks and routes to
`resolveAndSubscribeSource`. The `cap` argument is the SAME limit legacy
enforces — `max_subs_per_user`, default 500 (`core/src/domain/service.ts:173`)
— per design §4.

Each command performs ledger check, resolution, cap check where applicable,
writes, result storage, and commit in one `BEGIN IMMEDIATE`. Compute SHA-256
fingerprints from `[operation, normalizedUrl]`; never include secrets. First add
the transaction wrapper and return stored results or conflict before resolving.

- [ ] **Step 5: Implement resolution and mutation**

Resolve local feed or existing source by canonical URL, set `created` from
whether this
command inserted the follow/subscription, serialize the result, and commit. An
existing subscription reached with a different command ID returns
`created:false`; an identical replay returns its originally stored value.

- [ ] **Step 6: Run green tests and commit**

Run: `npm test -w core -- source-subscribe push-guard && npm run typecheck -w core`

Expected: PASS and exit 0.

```bash
git add core/src/domain/source-url.ts core/src/domain/source-service.ts core/src/domain/source-repository.ts core/src/storage/sqlite.ts core/test/source-subscribe.test.ts core/test/push-guard.test.ts
git commit -m "core: resolve and subscribe to v2 sources

developed with the help of AI tools"
```

---

### Task 4: Transactional OPML import

**Files:**
- Modify: `core/src/domain/source-service.ts`
- Modify: `core/src/domain/source-repository.ts`
- Modify: `core/src/storage/sqlite.ts`
- Modify: `core/test/opml.test.ts`

**Interfaces:** Adds one mixed local/remote import command.

```ts
export interface ImportSourcesResult {
  localFollowed:number; active:number; pending:number
  unavailable:number; notSubscribable:number; capSkipped:number
}
importOpml(owner:User, xml:string, commandId:string): Promise<ImportSourcesResult|{kind:'conflict'}>
```

- [ ] **Step 1: Add the mixed-import red test**

Import XML containing one canonical local feed, one public remote URL, one
private URL, one duplicate, and one existing quarantined source. Assert exactly
one local follow, one active, one pending, one unavailable, and no duplicate.
Retry the same bounded XML/command ID and expect byte-equivalent counts and no
new rows; changed XML under that ID conflicts.

```ts
const result = await service.importOpml(owner, mixedXml, 'import-1')
expect(result).toEqual({localFollowed:1,active:1,pending:1,unavailable:1,notSubscribable:0,capSkipped:0})
expect(await service.importOpml(owner, mixedXml, 'import-1')).toEqual(result)
expect(await service.importOpml(owner, changedXml, 'import-1')).toEqual({kind:'conflict'})
```

- [ ] **Step 2: Add the cap/concurrency red test**

Seed one remaining subscription slot and import two new remote URLs. Assert the
transaction creates one subscription, reports one `capSkipped`, and counts
active/pending/pending_review toward the cap.

```ts
expect(await service.importOpml(ownerAtFinalSlot, twoRemoteXml, 'import-2'))
  .toMatchObject({active:1,capSkipped:1})
expect(await countSubscriptions(repo, ownerAtFinalSlot.id)).toBe(cap)
```

- [ ] **Step 3: Run red test**

Run: `npm test -w core -- opml`

Expected: FAIL in the v2 import cases.

- [ ] **Step 4: Implement bounded parse and partition**

Bound to 1000 flattened outlines and the existing request-body cap. Resolve
local feeds first; normalize and SSRF-check each remaining URL; pass
`localTargetIds`, approved canonical URLs, and `unavailableCount` to one
`importSourceSubscriptions` command. Fingerprint `["import-opml", boundedXml]`.

- [ ] **Step 5: Implement the import write transaction**

Perform ledger check, insert local follows, resolve/create sources, enforce the
cap, store the serialized result, and commit as explicit sequential substeps in
one transaction.

- [ ] **Step 6: Run green test and commit**

Run: `npm test -w core -- opml && npm run typecheck -w core`

Expected: PASS and exit 0.

```bash
git add core/src/domain/source-service.ts core/src/domain/source-repository.ts core/src/storage/sqlite.ts core/test/opml.test.ts
git commit -m "core: import v2 source subscriptions

developed with the help of AI tools"
```

---

### Task 5: Owner/public following and last-subscription cleanup

**Files:**
- Modify: `core/src/domain/source-service.ts`
- Modify: `core/src/domain/source-repository.ts`
- Modify: `core/src/storage/sqlite.ts`
- Create: `core/test/source-following.test.ts`
- Create: `core/test/source-cleanup.test.ts`

**Interfaces:** Adds ordinary projections and stable-ID unsubscribe.

```ts
ownerFollowing(ownerId:string): Promise<OwnerFollowingView>
publicFollowing(ownerId:string): Promise<PublicFollowingEntry[]>
unsubscribe(ownerId:string, sourceId:string, commandId:string): Promise<{kind:'removed';sourceRemoved:boolean}|{kind:'unknown'|'conflict'}>
```

- [ ] **Step 1: Test projection boundaries**

Seed active, pending, and pending_review subscriptions. Assert owner JSON has
only source ID, URL, attribution mode, subscription state, and neutral
availability. A `pending_review` subscription (e.g. from aggregate
conversion) projects `availability:'awaiting_review'` regardless of source
governance (rev 5, review minor — this cell was previously undefined).
Assert public JSON and OPML include only active subscriptions on
allowed sources and contain no governance, operation, provenance, note,
generation, or retention keys.

```ts
const ownerView = await service.ownerFollowing(owner.id)
expect(ownerView.sourceSubscriptions[0]).toEqual({
  sourceId: allowed.id, url: allowed.canonicalUrl,
  attributionMode:'single_publisher', subscriptionState:'active', availability:'available',
})
const publicJson = JSON.stringify(await service.publicFollowing(owner.id))
for (const key of ['governance','operation','provenance','provenanceNote','adminRetained'])
  expect(publicJson).not.toContain(key)
expect(publicJson).not.toContain(pending.id)
expect((await service.publicFollowing(owner.id)).find((x) => x.kind === 'source'))
  .toMatchObject({displayName:'example.test'})
```

- [ ] **Step 2: Test cleanup matrix**

Unsubscribe the final subscriber and assert an allowed self-service source is
removed outright only when it has no federation relationship and no
admin-retention flag (the `origin_verification` retention branch is deferred
to V3 — rev 5). Assert quarantined, blocked, federated, shared, and
admin-retained sources survive. Retry the command and receive the original
`{kind:'removed',sourceRemoved}` result from the ledger; reusing the command
ID against a DIFFERENT source conflicts (rev 5, review Finding 4).

```ts
const removed = await service.unsubscribe(owner.id, orphan.id, 'unsub-1')
expect(removed).toEqual({kind:'removed',sourceRemoved:true})
expect(await service.unsubscribe(owner.id, orphan.id, 'unsub-1')).toEqual(removed)
expect(await service.unsubscribe(owner.id, quarantined.id, 'unsub-1')).toEqual({kind:'conflict'})
for (const retained of [quarantined, blocked, federated, adminRetained])
  expect((await service.unsubscribe(owner.id, retained.id, `unsub-${retained.id}`))).toEqual({kind:'removed',sourceRemoved:false})
```

- [ ] **Step 3: Run red tests**

Run: `npm test -w core -- source-following source-cleanup`

Expected: FAIL because projection and cleanup commands are absent.

- [ ] **Step 4: Implement projected reads**

Project with explicit column selection, never object spreading. Compute public
source display name from normalized hostname, falling back to canonical URL.

- [ ] **Step 5: Implement cleanup transaction**

Add ledger check, delete the subscription, evaluate retention, store the result,
and commit as explicit sequential substeps in one `BEGIN IMMEDIATE`. The
`unsubscribe` request fingerprint is `["unsubscribe", sourceId, actorId]`
(rev 5, review Finding 4 — the `[command, resource, actor]` pattern later
verticals pin, V2 §6.2). Retention in V1 evaluates only federation
relationship and the admin-retention flag; the verification-evidence
retention branch arrives in Vertical 3 with its first real evidence writer
(rev 5 deferral). Vertical 2 extends the same command with
shared-item/structural-tombstone handling when v2 items exist.

- [ ] **Step 6: Run green tests and commit**

Run: `npm test -w core -- source-following source-cleanup && npm run typecheck -w core`

Expected: PASS and exit 0.

```bash
git add core/src/domain/source-service.ts core/src/domain/source-repository.ts core/src/storage/sqlite.ts core/test/source-following.test.ts core/test/source-cleanup.test.ts
git commit -m "core: project and clean up v2 subscriptions

developed with the help of AI tools"
```

---

### Task 6: Federation establishment and lifecycle transitions

**Files:**
- Modify: `core/src/domain/source-service.ts`
- Modify: `core/src/domain/source-repository.ts`
- Modify: `core/src/storage/sqlite.ts`
- Create: `core/test/source-federation.test.ts`
- Create: `core/test/source-lifecycle.test.ts`

**Interfaces:** Adds audited federation establishment and complete transition
matrix. No HTTP routes yet.

```ts
establishFederation(input:{url:string;attributionMode:AttributionMode;category:AuditCategory;note:string|null;commandId:string;actorId:string;actorKind:'administrator'}): Promise<{kind:'established';source:RemoteSource;federation:FederationRelationship}|{kind:'exists'|'unavailable'|'conflict'}>
transition(input:{sourceId:string;action:'pause'|'resume'|'quarantine'|'allow'|'approve'|'reject'|'revoke'|'block'|'unblock'|'set_attribution_mode';category:AuditCategory|null;note:string|null;attributionMode?:AttributionMode;commandId:string;actorId:string;actorKind:'administrator'|'system'}): Promise<SourceTransitionResult>
```

- [ ] **Step 1: Test new and retained federation establishment**

For a new URL, assert administrator-selected mode plus enabled/allowed/approved.
For a retained allowed source, assert its mode and operation are unchanged and
an approved relationship is added. For retained quarantined, assert approval
sets allowed; for blocked, assert unavailable. Every success requires
an `AuditCategory`, writes one audit/ledger row, and identical retry returns the
stored result; reusing the command ID with a changed URL or mode conflicts
(rev 5, review Finding 4). Concurrent different commands converge to one
relationship. The `establishFederation` request fingerprint is
`["federation", normalizedUrl, attributionMode]` (pinned; V4 §6 adopts it
verbatim for the deferred ops route).

```ts
const established = await service.establishFederation({url:retained.canonicalUrl,
  attributionMode:'aggregate',category:'operator_policy',note:null,
  commandId:'fed-1',actorId:admin.id,actorKind:'administrator'})
expect(established).toMatchObject({kind:'established',source:{id:retained.id,
  attributionMode:retained.attributionMode,operation:retained.operation},federation:{status:'approved'}})
expect(await countFederationRows(repo, retained.id)).toBe(1)
expect(await countAuditRows(repo, retained.id)).toBe(1)
```

Seed a quarantined single-publisher source with one `pending` and one
`pending_review` subscription. After establishment, assert governance allowed,
pending active, and pending_review unchanged. Seed an already-allowed
single-publisher source with an active subscription and assert establishment
preserves it as active.

- [ ] **Step 2: Test the complete transition table**

```ts
const success = [
  ['pause', 'enabled', 'paused'], ['resume', 'paused', 'enabled'],
  ['quarantine', 'allowed', 'quarantined'], ['allow', 'quarantined', 'allowed'],
  ['approve', 'pending', 'approved'], ['reject', 'pending', 'none'],
  ['revoke', 'approved', 'none'], ['block', 'allowed', 'blocked'],
  ['block', 'quarantined', 'blocked'], ['unblock', 'blocked', 'quarantined'],
] as const
```

The matrix is complete (rev 5, review Finding 5 — previously undefined cells
are now explicit):

- **permit** `block` from `quarantined` (design §5: block applies regardless
  of operation and is not restricted to `allowed` — the moderation-escalation
  path above);
- **conflict** on `quarantine` and `allow` from `blocked` (design: the only
  source-governance exits from blocked are explicit unblock or purge);
- `reject`/`revoke` when federation is `none` → `{kind:'conflict'}` (no
  relationship to act on);
- **permit** `pause`/`resume` while `blocked` (the operation axis is
  independent; governance is unchanged — consistent with reject/revoke
  succeeding while blocked).

Also assert `set_attribution_mode` requires `attributionMode` and moves active
and pending subscriptions to pending_review when changing to aggregate;
reject/revoke succeed while blocked; approve while blocked and allow directly
from blocked conflict. Governance/federation/block/unblock/mode actions require
an enum category; pause/resume allow null. Each successful mutation writes one
audit/ledger record (`policy_generation` is deferred to V2's plan — rev 5).
The `transition` request fingerprint is
`[action, sourceId, actorId, attributionMode ?? '']` (rev 5, review Finding 4
— the `[command, resource, actor]` pattern plus the one payload field that
changes semantics); assert a reused command ID with a changed action or mode
returns `{kind:'conflict'}`.

For both `allow` and `approve`, seed a single-publisher source with pending and
pending_review subscriptions; assert pending becomes active atomically when the
source becomes allowed and pending_review is unchanged.

- [ ] **Step 3: Run red tests**

Run: `npm test -w core -- source-federation source-lifecycle`

Expected: FAIL because commands are absent.

- [ ] **Step 4: Implement federation ledger entry and source resolution**

Federation establishment resolves the canonical URL, creates or
reuses the source, and returns replay/conflict before mutation.

- [ ] **Step 5: Implement federation mutation and subscription effects**

Establish approved status, apply quarantined-to-allowed, activate ordinary
pending subscriptions only for single-publisher sources, preserve
pending_review and already-active subscriptions, then write audit/result and
commit once.

- [ ] **Step 6: Implement lifecycle transitions and subscription effects**

Apply the transition while preserving unmentioned axes. `allow` and `approve`
activate ordinary pending subscriptions when the resulting source is allowed
and single-publisher. Aggregate conversion moves active and pending to
pending_review. Store audit/result before commit. No item journal exists here
because no v2 item is publishable; Vertical 2 adds the reset barrier before its
first item route or stream.

- [ ] **Step 7: Run green tests and commit**

Run: `npm test -w core -- source-federation source-lifecycle && npm run typecheck -w core`

Expected: PASS and exit 0.

```bash
git add core/src/domain/source-service.ts core/src/domain/source-repository.ts core/src/storage/sqlite.ts core/test/source-federation.test.ts core/test/source-lifecycle.test.ts
git commit -m "core: establish and govern v2 federation sources

developed with the help of AI tools"
```

---

### Task 7: Core capability, ordinary, and admin APIs

**Files:**
- Modify: `core/src/api/app.ts`
- Modify: `core/src/server.ts`
- Create: `core/test/source-capability-api.test.ts`
- Modify: `core/test/subscriptions-api.test.ts`
- Create: `core/test/source-admin-api.test.ts`

**Interfaces:** Produces an always-available capability endpoint and v2-only
ordinary/admin routes. The off branch leaves every legacy route unchanged.
`POST /ops/sources/federation` is NOT built here — it is deferred to V4,
which adopts this plan's former ops contract verbatim (V4 §6) when the legacy
`POST /users` token job retires (rev 5 deferral).

- [ ] **Step 1: Test capability and off/on route behavior**

```ts
expect(await json(appOff, '/capabilities')).toEqual({sourceModelV2:false})
expect(await json(appOn, '/capabilities')).toEqual({sourceModelV2:true})
expect((await appOff.request('/admin/feeds', admin)).status).toBe(200)
expect((await appOff.request('/admin/sources', admin)).status).toBe(404)
expect((await appOn.request('/admin/sources', admin)).status).toBe(200)
```

The two `toEqual` capability assertions are a known widening site: V2 §5.6
supersedes the enabled shape with a discriminated union carrying `model`,
`journalCursorVersion`, and `streamProtocolVersion`, and V2's plan updates
these exact-equality tests then (review C5). Implement them as written here;
do not pre-widen.

Repeat for legacy following/subscribe/OPML routes off and v2 owner/public routes
on. Assert active subscribe JSON contains `OwnerSourceFollow`, never
`RemoteSource`. Assert pending mutation responses are exactly the two allowed
keys and never contain the owner projection:

```ts
expect(await postSubscription(appOn, quarantinedUrl, 'pending-1')).toEqual({
  status:202,
  body:{subscription:'pending',message:'This source is awaiting review.'},
})
expect(await postSubscription(appOn, quarantinedUrl, 'pending-2')).toEqual({
  status:200,
  body:{subscription:'pending',message:'This source is awaiting review.'},
})
```

- [ ] **Step 2: Test admin authorization/redaction matrix**

Use actors unauthenticated, anonymous, registered, admin, valid bearer token,
invalid bearer token. Admin list/detail/subscribers/audit/mutations succeed
for the admin; every other actor fails. The two bearer-token columns are
**401, not 403** (rev 5, review Finding 3): a request carrying only
`Authorization: Bearer <RSC_TOKEN>` has no better-auth session, so the house
`sessionAuth` middleware returns
`c.json({error:'authentication required'}, 401)`
(`core/src/api/auth.ts:64-66`) before `requireAdmin`'s 403 is ever reached.
The token grants no administrative read (design §11); its whole authorized
surface is the V4-deferred ops route. Assert serialized success/error bodies
contain none of seeded secret, callback token, auth header, or the raw
`RSC_TOKEN`.

```ts
const expected = {
  list:[401,403,403,200,401,401], detail:[401,403,403,200,401,401],
  audit:[401,403,403,200,401,401], mutate:[401,403,403,200,401,401],
} as const
for (const [route, statuses] of Object.entries(expected))
  expect(await statusesFor(route, actors)).toEqual(statuses)
for (const body of await allBodies())
  for (const secret of [callbackToken,pushSecret,authorizationHeader,opsToken]) expect(body).not.toContain(secret)
```

- [ ] **Step 3: Run red API tests**

Run: `npm test -w core -- source-capability-api subscriptions-api source-admin-api`

Expected: FAIL because route branches are absent.

- [ ] **Step 4: Implement capability and ordinary endpoints**

Always serve `GET /capabilities`. Add the ordinary routes and exact response
projection/status rules while v2 is on:

| Endpoint | Result |
|---|---|
| `POST /me/subscriptions` `{url,commandId}` | active/local: owner projection, 201 when `created`, otherwise 200; pending: exact neutral payload, 202 when `created`, otherwise 200 |
| `DELETE /me/subscriptions/:sourceId` `{commandId}` | removal result |
| `POST /me/follows/opml` + `x-rsc-command-id` | import counts |
| `GET /me/following` | `OwnerFollowingView` |
| `GET /users/:handle/follows` | `PublicFollowingEntry[]` |
| `GET /users/:handle/following.opml` | active/allowed entries only |

Non-success statuses (rev 5, review minor — previously undefined rows):
unavailable/not-subscribable are the same neutral 409 body; cap is 429;
`{kind:'unknown'}` from transition or unsubscribe is 404; changed command
reuse is 409 `{error:'idempotency conflict'}`, and an illegal transition is
409 `{error:'invalid transition'}` — the two 409 bodies are distinct.
Route action segments use hyphens: `:action=attribution-mode` maps to domain
action `set_attribution_mode`; every other segment equals its domain action
verbatim (rev 5, review minor). `attribution-mode` rejects a missing
`attributionMode`. While off, do not register v2 routes and preserve legacy
behavior. While ON, v2 shares paths with legacy — Hono first-match wins, so
verify v2 registration actually supersedes the legacy handlers when the flag
is on.

> **Correction 2026-07-23 (Task 7 implementation):** this paragraph named
> `POST /me/subscriptions` / `GET /me/following` as the shared pair. **There is
> no legacy `GET /me/following` route in core** (legacy owns `/me/follows`,
> `/me/follows/:target`, `/me/follows/opml`, `POST /me/subscriptions`), so
> `GET /me/following` is v2-only and 404s while off. The genuinely shared paths
> — all four verified as superseded while ON — are `POST /me/subscriptions`,
> `POST /me/follows/opml`, `GET /users/:handle/follows`, and
> `GET /users/:handle/following.opml`.

**Every new v2 POST composes the house `jsonWrite` guard positionally**
(rev 5, review Finding 6): reuse
`jsonWrite = bodyLimit({ maxSize: MAX_JSON_BYTES, onError: rejectOversized })`
at `core/src/api/app.ts:65` (`MAX_JSON_BYTES = 512 * 1024` at `:63`) exactly
as every existing authed JSON write does — do not reinvent it.

- [ ] **Step 5: Implement administrative endpoints**

| Endpoint | Result |
|---|---|
| `GET /admin/sources`, `GET /admin/sources/:id` | paginated summary/detail |
| `GET /admin/sources/:id/{subscriptions,audit}` | paginated subresource |
| `POST /admin/sources` | `{url,attributionMode,category,note,commandId}` |
| `POST /admin/sources/:id/:action` | `{category,note,commandId,attributionMode?}` |

Both admin POSTs compose `jsonWrite` (Step 4 note). Reuse the house
`app.use('/admin/*', authed, requireAdmin())` composition. Wire the
authorization matrix and hand validators separately from the ordinary
route branch.

- [ ] **Step 6: Run green API tests and commit**

Run: `npm test -w core -- source-capability-api subscriptions-api source-admin-api && npm test -w core && npm run typecheck -w core`

Expected: PASS and exit 0.

```bash
git add core/src/api/app.ts core/src/server.ts core/test/source-capability-api.test.ts core/test/subscriptions-api.test.ts core/test/source-admin-api.test.ts
git commit -m "core: expose gated v2 source APIs

developed with the help of AI tools"
```

---

### Task 8: Capability-aware following and subscription web surfaces

**Files:**
- Modify: `web/src/lib/api.ts`
- Modify: `web/src/lib/types.ts`
- Modify: `web/src/routes/+page.server.ts`
- Modify: `web/src/routes/+page.svelte`
- Modify: `web/src/routes/page.load.test.ts`
- Modify: `web/src/routes/page.actions.test.ts`
- Modify: `web/src/routes/u/[handle]/following/+page.server.ts`
- Modify: `web/src/routes/u/[handle]/following/+page.svelte`
- Modify: `web/src/routes/u/[handle]/following/following.actions.test.ts`
- Modify: `web/src/lib/api.test.ts`

**Interfaces:** Adds `getCapabilities(fetch)` and selects existing v1 or new v2
API wrappers per request. **Failure semantics (rev 5, review Findings 1+8):**
the capability fetch runs in PARALLEL with the existing legacy call, never
serially ahead of it; a capability-fetch failure (non-200 or throw) degrades
to the LEGACY path for that request — legacy is exactly what OFF is — never
to `coreDown`; only a successful reading is memoized for the web-process
lifetime, a failure is never cached as sticky state and is retried on the
next request. **Deploy ordering:** `/capabilities` must be live on all core
instances before this web change is promoted (core before web).

- [ ] **Step 1: Test all changed ordinary pages/actions off and on**

With `{sourceModelV2:false}`, assert home subscribe and following load/actions
call the existing legacy endpoints and render the existing user/feed rows. With
`true`, assert they call v2 owner/public endpoints, show active/pending neutral
states to the owner, hide pending from visitors, and unsubscribe by stable
source ID. Assert a capability fetch failure falls back to the legacy path for
that request (rev 5 — NOT `coreDown`; `coreDown` remains reserved for the
legacy call itself failing, exactly as today) and is not memoized: the next
request fetches `/capabilities` again.

```ts
expect(await loadFollowingWith({sourceModelV2:false})).toMatchObject({api:'legacy'})
expect(await loadFollowingWith({sourceModelV2:true})).toMatchObject({api:'v2'})
expect(await loadFollowingWith('capability-error')).toMatchObject({api:'legacy'})
expect(capabilityFetchCountAfter('capability-error', 2)).toBe(2) // failure never cached
```

The OFF path must be byte-identical to today, not merely branch-labelled
legacy (rev 5, review Finding 2): the pre-existing assertions in
`page.load.test.ts` (first fetch is the timeline call — `calls[0]` contains
`before=`; exact `coreDown` object shape) and `page.actions.test.ts` (429 on
every fetch still surfaces the cap error) must pass **unmodified** — with the
parallel fetch and legacy fallback they do, which is the cleanest proof that
OFF is zero-diff. Extend both files with the on/failure cases; do not weaken
their existing assertions.

- [ ] **Step 2: Run red web tests**

Run: `npm test -w web -- api page.load page.actions following.actions`

Expected: FAIL in capability/v2 cases; existing off assertions remain green.

- [ ] **Step 3: Implement capability-aware API wrappers**

```ts
export async function getCapabilities(f:typeof fetch): Promise<{sourceModelV2:boolean}>
```

(V2 §5.6 later widens this return type to the discriminated shape — known
supersession, review C5; implement the boolean shape here.)

Fire the capability fetch in parallel with the existing legacy call
(`Promise.all`), never serially ahead of it. Memoize ONLY a successful (200)
reading for the web-process lifetime — the value is process-immutable on
core, so one call per pod lifetime suffices (Finding 8); a non-200 or thrown
fetch is never memoized. Explicit off and capability failure both use the
current code paths unchanged (the already-in-flight legacy result); on uses
owner/public projections.

- [ ] **Step 4: Implement ordinary loaders, actions, and markup**

Generate mutation command IDs with `crypto.randomUUID()` and retain them through
no-JS form submission/retry. Render pending neutral state only in owner
management; do not render governance, operation, provenance, or retention state.

- [ ] **Step 5: Run green web tests and commit**

Run: `npm test -w web -- api page.load page.actions following.actions && npm run check -w web`

Expected: PASS and exit 0, with the pre-existing `page.load.test.ts` /
`page.actions.test.ts` OFF assertions unmodified.

```bash
git add web/src/lib/api.ts web/src/lib/types.ts web/src/routes/+page.server.ts web/src/routes/+page.svelte web/src/routes/page.load.test.ts web/src/routes/page.actions.test.ts 'web/src/routes/u/[handle]/following/+page.server.ts' 'web/src/routes/u/[handle]/following/+page.svelte' 'web/src/routes/u/[handle]/following/following.actions.test.ts' web/src/lib/api.test.ts
git commit -m "web: branch source subscriptions by capability

developed with the help of AI tools"
```

---

### Task 9: Capability-aware source administration web surface

**Files:**
- Modify: `web/src/routes/admin/feeds/+page.server.ts`
- Modify: `web/src/routes/admin/feeds/+page.svelte`
- Create: `web/src/routes/admin/feeds/source-actions.test.ts`

**Interfaces:** Preserves legacy feed administration off; renders v2 source
administration on.

- [ ] **Step 1: Test admin page/actions off and on**

Off: load calls `/admin/feeds`, renders the existing rows, and existing remove
action still works. On: load calls `/admin/sources`, groups approved,
quarantine/pending, allowed user, and blocked sources; forms post stable source
ID, enum category, optional note, command ID, and attribution mode where needed.
Test each action in both modes and assert no v2 request occurs off.

Add a capability-error case (rev 5, review Finding 7): a capability-fetch
failure degrades to the legacy admin load (same carve as Task 8), so a
genuine core outage still surfaces as today's throw-to-error-page. The admin
load must never swallow a capability failure into `feeds: []` — a
silently-empty admin page is worse than an error page.

```ts
expect(await loadAdminWith({sourceModelV2:false})).toMatchObject({mode:'legacy'})
expect(calls()).toContain('/admin/feeds')
expect(calls()).not.toContain('/admin/sources')
resetCalls()
expect(await loadAdminWith({sourceModelV2:true})).toMatchObject({mode:'v2'})
expect(calls()).toContain('/admin/sources')
resetCalls()
expect(await loadAdminWith('capability-error')).toMatchObject({mode:'legacy'})
await expect(loadAdminWith('capability-error-and-core-down')).rejects.toThrow() // today's error page, never feeds:[]
```

- [ ] **Step 2: Run red test**

Run: `npm test -w web -- source-actions`

Expected: FAIL in the v2 capability cases; legacy cases remain green.

- [ ] **Step 3: Implement the capability-aware admin load**

Use `getCapabilities`. On, render only safe `SourceSummary` fields and explicit
source groups; off, return the current legacy view model unchanged.

- [ ] **Step 4: Implement admin actions and markup branches**

On, render explicit no-JS forms and stable-ID actions; off, retain current
markup/actions. Block and unblock confirmations must state their distinct
consequences (design §10 — rev 5, review minor), not merely confirm. Follow
the 42rem editorial layout and tokenized colors. Do not
add item/delivery evidence UI.

- [ ] **Step 5: Run full web gate and commit**

Run: `npm test -w web && npm run check -w web && npm run build -w web`

Expected: PASS and exit 0.

```bash
git add web/src/routes/admin/feeds/+page.server.ts web/src/routes/admin/feeds/+page.svelte web/src/routes/admin/feeds/source-actions.test.ts
git commit -m "web: branch source administration by capability

developed with the help of AI tools"
```

---

### Task 10: Vertical integration gate and operator documentation

**Files:**
- Modify: `.env.example`
- Modify: `core/.env.example`
- Modify: `docs/superpowers/documentation/RUNNING.md`
- Create: `core/test/source-control-integration.test.ts`
- Create: `web/src/routes/source-control-integration.test.ts`

**Interfaces:** Proves both feature states end to end and documents that v2
remains disabled until migration.

- [ ] **Step 1: Add the off/on integration tests**

Off: legacy subscribe, following, OPML, admin feeds, and all changed web pages
still work; `/admin/sources` is absent. On: subscribe a user, observe its owner
projection, quarantine with no public exposure, allow, pause/resume, establish
federation on that retained source, unsubscribe, and verify idempotent retries
and audit. Assert ordinary bodies never contain admin-only field names.

```ts
await expectLegacySurface(appOff, webOff)
expect((await appOff.request('/admin/sources', adminRequest)).status).toBe(404)
const flow = await runV2ControlPlaneFlow(appOn, webOn)
expect(flow.auditActions).toEqual(['quarantine','allow','pause','resume','federation_establish'])
for (const body of flow.ordinaryBodies)
  for (const key of ['governance','operation','provenanceNote','adminRetained']) expect(body).not.toContain(key)
```

- [ ] **Step 2: Run integration tests red**

Run: `npm test -w core -- source-control-integration && npm test -w web -- source-control-integration`

Expected: FAIL until all wiring is complete.

- [ ] **Step 3: Document the switch exactly**

Add `RSC_SOURCE_MODEL_V2=off` to both env examples. State in RUNNING.md that
`on` is development-only, uses empty v2 tables, does not mirror legacy writes,
and web discovers the state through `/capabilities` rather than an independent
environment variable. Add the deploy-ordering rule (rev 5, review Finding 1):
deploy core (with `/capabilities`) to ALL instances before promoting the new
web; if web cannot reach `/capabilities` it degrades to the legacy path for
that request — never below today's behavior — and retries next request.

- [ ] **Step 4: Run the complete vertical gate**

Run core tests plus typecheck and web tests plus check/build using Docker when
running, otherwise host commands:

```bash
npm test -w core
npm run typecheck -w core
npm test -w web
npm run check -w web
npm run build -w web
```

Expected: all exit 0.

- [ ] **Step 5: Review and commit**

Run `/ponytail-review`, then request the whole-vertical review before Vertical 2.

```bash
git add .env.example core/.env.example docs/superpowers/documentation/RUNNING.md core/test/source-control-integration.test.ts web/src/routes/source-control-integration.test.ts
git commit -m "docs: gate the v2 source control plane

developed with the help of AI tools"
```
