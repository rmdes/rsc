# RSC Source Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the disabled v2 source registry and let administrators and users exercise source resolution, subscriptions, and lifecycle management end to end without changing legacy ingestion.

**Architecture:** Add expand-only v2 tables to the existing SQLite migration array and isolate their domain surface behind `SourceRepository` and `createSourceService`. `RSC_SOURCE_MODEL_V2` switches source/subscription/admin routes between legacy and v2 behavior; it defaults off and performs no dual writes. Core remains policy authority, while web provides no-JS forms over explicit stable-ID endpoints.

**Tech Stack:** Node 22 native TypeScript, Hono, Kysely/better-sqlite3, Vitest, SvelteKit/Svelte 5.

## Global Constraints

- Governing spec: `docs/superpowers/specs/2026-07-20-rsc-source-governance-moderation-design.md` rev 2.
- `RSC_SOURCE_MODEL_V2` accepts only `on | off` and defaults to `off`.
- No dual writes, rollout percentages, new dependencies, or remote-item migration in this vertical.
- URL normalization changes only scheme/host/default port and fragment; preserve path, query, trailing slash, and HTTP/HTTPS. Reject credentials and URLs longer than 2048 characters.
- Browsers talk only to web. Core returns semantic JSON, never rendered HTML.
- Core route work must use `.claude/skills/hono/SKILL.md`. Web implementation must use the available UI/Svelte skills and `design-system/rsc/MASTER.md`.
- No TypeScript parameter properties in `core/src`.
- Stage explicit paths only. Every commit message ends with `developed with the help of AI tools`.
- During implementation, use Docker verification when the stack is running; otherwise use the host commands from `AGENTS.md`.

---

### Task 1: Feature switch and source-control schema

**Files:**
- Modify: `core/src/config.ts`
- Modify: `core/src/domain/types.ts`
- Create: `core/src/domain/source-repository.ts`
- Modify: `core/src/storage/sqlite.ts`
- Modify: `core/test/config.test.ts`
- Create: `core/test/source-schema.test.ts`

**Interfaces:**
- Produces `Config.sourceModelV2: boolean`.
- Produces `SourceRepository`, `RemoteSource`, `FederationRelationship`, `SourceSubscription`, `SourceAuditEvent`, and `BlockedSourceTombstone`.
- Adds expand-only tables; legacy tables and methods remain unchanged.

- [ ] **Step 1: Add failing config tests**

In `core/test/config.test.ts`, append:

```ts
test('RSC_SOURCE_MODEL_V2 defaults off and accepts only on/off', () => {
  const base = { RSC_TOKEN: 't', RSC_AUTH_SECRET: 's' }
  expect(loadConfig(base).sourceModelV2).toBe(false)
  expect(loadConfig({ ...base, RSC_SOURCE_MODEL_V2: 'on' }).sourceModelV2).toBe(true)
  expect(() => loadConfig({ ...base, RSC_SOURCE_MODEL_V2: 'yes' })).toThrow('RSC_SOURCE_MODEL_V2')
})
```

- [ ] **Step 2: Add failing schema tests**

Create `core/test/source-schema.test.ts` and assert the new tables and constraints through `repo.raw`:

```ts
test('v2 source-control tables exist with unique canonical identifiers', async () => {
  const repo = await createSqliteRepository(':memory:')
  const tables = repo.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
  expect(tables.map((r) => r.name)).toEqual(expect.arrayContaining([
    'remote_sources_v2', 'source_aliases_v2', 'federation_relationships_v2',
    'source_subscriptions_v2', 'source_audit_v2', 'blocked_source_tombstones_v2',
  ]))
  repo.close()
})
```

Add a second test inserting duplicate `canonical_url`, duplicate alias URL, and duplicate `(owner_id, source_id)` and assert `SQLITE_CONSTRAINT_UNIQUE`.

- [ ] **Step 3: Run the focused tests and verify failure**

Run: `npm test -w core -- config source-schema`

Expected: config assertions fail because the field is absent; schema assertions fail because the tables do not exist.

- [ ] **Step 4: Define exact domain types and repository interface**

Add to `core/src/domain/types.ts`:

```ts
export type AttributionMode = 'single_publisher' | 'aggregate'
export type SourceOperation = 'enabled' | 'paused'
export type SourceGovernance = 'allowed' | 'quarantined' | 'blocked'
export type FederationStatus = 'pending' | 'approved'
export type SourceSubscriptionState = 'active' | 'pending' | 'pending_review'

export interface RemoteSource {
  id: string
  canonicalUrl: string
  attributionMode: AttributionMode
  operation: SourceOperation
  governance: SourceGovernance
  policyGeneration: number
  provenance: 'user_subscription' | 'opml' | 'admin_federation' | 'origin_verification' | 'migration'
  provenanceNote: string | null
  adminRetained: boolean
  createdAt: string
}
```

Add these exact interfaces:

```ts
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

export interface SourceAuditEvent {
  id: string
  sourceId: string
  commandId: string
  actorId: string | null
  actorKind: 'administrator' | 'system'
  action: string
  category: string | null
  note: string | null
  resultJson: string
  createdAt: string
}

export interface BlockedSourceTombstone {
  id: string
  canonicalUrl: string
  blockCategory: string
  blockActorId: string | null
  blockNote: string | null
  blockedAt: string
  purgeCategory: string
  purgeActorId: string | null
  purgeNote: string | null
  purgedAt: string
}

export interface SourceTransitionWrite {
  sourceId: string
  commandId: string
  actorId: string | null
  actorKind: 'administrator' | 'system'
  action: 'pause' | 'resume' | 'quarantine' | 'allow' | 'approve' | 'reject' | 'revoke' | 'block' | 'unblock' | 'set_attribution_mode'
  category: string | null
  note: string | null
  nextOperation?: SourceOperation
  nextGovernance?: SourceGovernance
  nextFederation?: FederationStatus | 'none'
  nextAttributionMode?: AttributionMode
  createdAt: string
}

export type SourceTransitionResult =
  | { kind: 'applied' | 'replayed'; source: RemoteSource; audit: SourceAuditEvent }
  | { kind: 'conflict' | 'unknown' }
```

In `source-repository.ts`, define focused methods used in Tasks 2–3:

```ts
export interface SourceRepository {
  findSourceByUrl(url: string): Promise<RemoteSource | undefined>
  findBlockedSourceUrl(url: string): Promise<boolean>
  createSource(source: RemoteSource): Promise<void>
  addSourceAlias(sourceId: string, url: string): Promise<void>
  getSource(id: string): Promise<RemoteSource | undefined>
  listSources(cursor: { createdAt: string; id: string } | undefined, limit: number): Promise<RemoteSource[]>
  createSourceSubscription(row: SourceSubscription, cap: number): Promise<'created' | 'exists' | 'cap'>
  getSourceSubscription(ownerId: string, sourceId: string): Promise<SourceSubscription | undefined>
  deleteSourceSubscription(ownerId: string, sourceId: string): Promise<void>
  transitionSource(input: SourceTransitionWrite): Promise<SourceTransitionResult>
}
```

- [ ] **Step 5: Add the config field and expand-only migration**

Parse the flag beside other on/off settings. Add one final migration entry in
`core/src/storage/sqlite.ts` creating the six tables named by the test. Use
text checks for modes/states, unique canonical/alias URLs, foreign keys to
`users(id)` for subscription owners, `policy_generation integer not null`, and
indexes for source list pagination and subscription owner/state queries.

Do not add v2 item/delivery tables yet. Implement the `SourceRepository`
methods on `SqliteRepository`; `createSourceSubscription` uses one
`BEGIN IMMEDIATE` transaction to count cap-consuming states (`active`,
`pending`, `pending_review`) and insert.

- [ ] **Step 6: Run focused tests and static checking**

Run: `npm test -w core -- config source-schema`

Expected: PASS.

Run: `npm run typecheck -w core`

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add core/src/config.ts core/src/domain/types.ts core/src/domain/source-repository.ts core/src/storage/sqlite.ts core/test/config.test.ts core/test/source-schema.test.ts
git commit -m "core: add disabled v2 source-control schema

developed with the help of AI tools"
```

---

### Task 2: Canonical source resolution and source subscriptions

**Files:**
- Create: `core/src/domain/source-url.ts`
- Create: `core/src/domain/source-service.ts`
- Modify: `core/src/api/app.ts`
- Modify: `core/src/server.ts`
- Create: `core/test/source-service.test.ts`
- Modify: `core/test/subscriptions-api.test.ts`
- Modify: `core/test/opml.test.ts`

**Interfaces:**
- Consumes `SourceRepository` from Task 1 and existing `localHandleForUrl`.
- Produces `normalizeSourceUrl(raw): string` and `createSourceService(repo, deps)`.
- Produces v2 results `active | pending | unavailable | not_subscribable | cap`.

- [ ] **Step 1: Write URL normalization and rejection tests**

Create `source-service.test.ts` with exact expectations:

```ts
expect(normalizeSourceUrl('HTTPS://Example.COM:443/feed/?x=1#frag')).toBe('https://example.com/feed/?x=1')
expect(normalizeSourceUrl('http://Example.COM:80/feed')).toBe('http://example.com/feed')
expect(normalizeSourceUrl('http://example.com/feed/')).toBe('http://example.com/feed/')
expect(() => normalizeSourceUrl('https://user:pass@example.com/feed')).toThrow('source URL invalid')
expect(() => normalizeSourceUrl('file:///tmp/feed')).toThrow('source URL invalid')
expect(() => normalizeSourceUrl(`https://example.com/${'x'.repeat(2049)}`)).toThrow('source URL invalid')
```

Add service tests proving new user sources use the exact defaults, an existing
paused source is reused unchanged, aliases resolve, aggregate/federation sources
return `not_subscribable`, quarantined creates `pending`, blocked/tombstone
returns `unavailable`, and two concurrent final-cap attempts yield one create
and one cap result.

- [ ] **Step 2: Add failing API/OPML tests**

Under v2-on app configuration, test:

- canonical local feed URL creates a local follow and zero v2 source rows;
- a remote URL returns active or neutral pending JSON;
- aggregate/federation returns the same neutral not-subscribable response;
- blocked/tombstone returns generic unavailable and creates nothing;
- unsubscribe removes pending normally;
- OPML uses identical local/source resolution and does not expose pending in
  public export.

- [ ] **Step 3: Run focused tests and verify failure**

Run: `npm test -w core -- source-service subscriptions-api opml`

Expected: FAIL because v2 resolver/service and route branch do not exist.

- [ ] **Step 4: Implement the resolver and service**

`source-url.ts` owns the one normalizer. `source-service.ts` exposes:

```ts
export interface ResolveSourceInput {
  url: string
  provenance: 'user_subscription' | 'opml' | 'admin_federation' | 'origin_verification'
  attributionMode: AttributionMode
  governance: SourceGovernance
  federation: 'none' | 'approved'
  provenanceNote?: string
}

export interface SourceService {
  resolve(input: ResolveSourceInput): Promise<{ kind: 'source'; source: RemoteSource; created: boolean } | { kind: 'local'; user: User } | { kind: 'unavailable' }>
  subscribeByUrl(owner: User, url: string, provenance: 'user_subscription' | 'opml'): Promise<{ kind: 'active' | 'pending'; source: RemoteSource } | { kind: 'local'; user: User; followed: boolean } | { kind: 'unavailable' | 'not_subscribable' | 'cap' }>
  unsubscribe(ownerId: string, sourceId: string): Promise<void>
}

export type CreateSourceService = (repo: SourceRepository, deps: {
  publicUrl: string | null
  getLocalByHandle(handle: string): Promise<User | undefined>
  addLocalFollow(owner: User, target: User): Promise<boolean>
  getSubscriptionCap(ownerId: string): Promise<number>
}) => SourceService
```

Export `createSourceService` with this exact function type and implement its
three methods using the rules in Steps 4–5.

Implement find-or-create by normalized URL in a transaction-backed repository
method. Check canonical local feeds before remote resolution. Preserve every
axis on reuse. New URL/OPML sources use Task 1 defaults. Only non-federation
single-publisher sources are subscribable.

- [ ] **Step 5: Wire the disabled route branch**

Pass `sourceModelV2` and `sourceService` through `server.ts` into `createApp`.
When off, current routes are byte-for-behavior unchanged. When on,
`POST /me/subscriptions`, unsubscribe, and OPML import/export call the v2
service. Do not write legacy remote users/follows in the v2 branch.

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test -w core -- source-service subscriptions-api opml`

Expected: PASS.

Run: `npm test -w core` and `npm run typecheck -w core`

Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add core/src/domain/source-url.ts core/src/domain/source-service.ts core/src/api/app.ts core/src/server.ts core/test/source-service.test.ts core/test/subscriptions-api.test.ts core/test/opml.test.ts
git commit -m "core: resolve v2 sources and subscriptions

developed with the help of AI tools"
```

---

### Task 3: Source lifecycle, federation, audit, and idempotency

**Files:**
- Modify: `core/src/domain/source-service.ts`
- Modify: `core/src/api/app.ts`
- Create: `core/test/source-lifecycle.test.ts`
- Create: `core/test/source-admin-api.test.ts`

**Interfaces:**
- Produces stable-ID `/admin/sources` list/detail/create endpoints.
- Produces stable-ID pause/resume/quarantine/allow/approve/reject/revoke/block/unblock endpoints.
- Every command consumes `commandId`; retry returns the original result.

- [ ] **Step 1: Write lifecycle matrix tests**

Test valid transitions and these invalid cases: approve while blocked, allow
directly from blocked, automatic `pending_review` activation, and mode change
without demoting active plus pending subscriptions. Assert policy generation
increments once, audit writes once, and command retry returns the first result.

Test `single_publisher -> aggregate` moves active and pending subscriptions to
`pending_review`; `quarantined -> allowed` activates only ordinary pending;
blocked subscriptions never qualify as active audience state.

- [ ] **Step 2: Write API authorization/redaction tests**

For every endpoint, exercise unauthenticated, anonymous, registered non-admin,
verified admin, valid ops token, and invalid ops token. Admin succeeds; ops
token succeeds only on an explicitly retained compatibility create operation.
Assert no response or error contains callback tokens, secrets, or auth data.

- [ ] **Step 3: Run and verify failure**

Run: `npm test -w core -- source-lifecycle source-admin-api`

Expected: FAIL because lifecycle methods and routes are absent.

- [ ] **Step 4: Implement transition methods**

Add one `sourceService.transition(input)` dispatcher using
`repo.transitionSource`. Require category for governance/federation actions;
pause/resume category remains optional. Enforce the approved transition matrix,
monotonic `policyGeneration`, subscription state changes, and system/admin actor
rules in the same transaction as audit/idempotency result.

Do not add item fan-out or journal tables in this vertical; return a typed
`needsItemReset` flag for Vertical 3 to consume once v2 items exist.

- [ ] **Step 5: Add explicit admin routes**

Add v2-on routes under `/admin/sources`, all addressed by source ID. Retire
nothing while the switch defaults off. Use stable cursor parsing for list,
limit 1–100, and summary-only JSON. Keep ops-token compatibility separate and
narrow.

- [ ] **Step 6: Run full core verification**

Run: `npm test -w core` and `npm run typecheck -w core`

Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add core/src/domain/source-service.ts core/src/api/app.ts core/test/source-lifecycle.test.ts core/test/source-admin-api.test.ts
git commit -m "core: add v2 source lifecycle and admin API

developed with the help of AI tools"
```

---

### Task 4: No-JS source administration and subscription states

**Files:**
- Modify: `web/src/lib/api.ts`
- Modify: `web/src/lib/types.ts`
- Modify: `web/src/routes/+page.server.ts`
- Modify: `web/src/routes/+page.svelte`
- Modify: `web/src/routes/admin/feeds/+page.server.ts`
- Modify: `web/src/routes/admin/feeds/+page.svelte`
- Create: `web/src/routes/admin/feeds/source-actions.test.ts`
- Modify: `web/src/lib/api.test.ts`

**Interfaces:**
- Consumes Task 2 subscription results and Task 3 stable-ID admin endpoints.
- Produces SSR/no-JS source lists grouped by governance/federation state.

- [ ] **Step 1: Write failing API wrapper and action tests**

Test exact wrappers for paginated source list, create, and every lifecycle
action. Test that home subscription renders the neutral pending message,
not-subscribable/unavailable errors remain neutral, and pending never appears
in public-facing data.

Test admin action forms submit stable source ID plus server-generated
`commandId`, category, and optional note. Retry the same command ID and assert
the UI receives the original state without duplicate feedback.

- [ ] **Step 2: Run and verify failure**

Run: `npm test -w web -- api source-actions`

Expected: FAIL because wrappers and actions are absent.

- [ ] **Step 3: Implement wrappers and server actions**

Add semantic types and wrappers in `api.ts`; never expose secrets. Update the
home subscribe action to distinguish active/pending while preserving no-JS
redirect/flash behavior. Generate command IDs server-side with `crypto.randomUUID()`
and place them in hidden inputs rendered by the load/action result.

- [ ] **Step 4: Replace the flat feed admin view**

Keep the existing 42rem editorial layout and tokenized colors. Group sources
as approved federation, quarantine/pending, allowed user sources, and blocked.
Show mode, axes, canonical URL, safe push state, subscriber/item counts, and
latest health summary. Provide plain forms for applicable transitions; do not
add delivery/item evidence UI yet.

- [ ] **Step 5: Run web verification**

When containers run:

```bash
docker exec rsc-web sh -c "cd /app && env -u CORE_API_URL npm test -w web"
docker exec rsc-web sh -c "cd /app && env -u CORE_API_URL npm run check -w web"
docker exec rsc-web sh -c "cd /app && env -u CORE_API_URL npm run build -w web"
```

Otherwise run `npm test -w web`, `npm run check -w web`, and
`npm run build -w web`.

Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/api.ts web/src/lib/types.ts web/src/routes/+page.server.ts web/src/routes/+page.svelte web/src/routes/admin/feeds/+page.server.ts web/src/routes/admin/feeds/+page.svelte web/src/routes/admin/feeds/source-actions.test.ts web/src/lib/api.test.ts
git commit -m "web: manage v2 sources and pending subscriptions

developed with the help of AI tools"
```

---

### Task 5: Vertical integration gate and operator documentation

**Files:**
- Modify: `.env.example`
- Modify: `core/.env.example`
- Modify: `docs/superpowers/documentation/RUNNING.md`
- Create: `core/test/source-control-integration.test.ts`

**Interfaces:**
- Proves switch-off legacy behavior and switch-on v2 source-control behavior.
- Documents that v2 remains disabled until Vertical 4 migration.

- [ ] **Step 1: Write the integration test**

Create one HTTP-level test that subscribes a registered user to a new remote
URL, sees it in Personal subscription management, quarantines it as admin,
observes pending/no public exposure, allows it, pauses/resumes it, and verifies
audit/idempotent retry. Run the same legacy subscription smoke test with v2 off
and assert the existing remote-user behavior remains unchanged.

- [ ] **Step 2: Run and verify failure**

Run: `npm test -w core -- source-control-integration`

Expected: FAIL until all v2 route wiring is complete.

- [ ] **Step 3: Document the switch**

Add `RSC_SOURCE_MODEL_V2=off` to both env examples. In RUNNING.md state that
`on` is development-only until the final migration plan, uses empty v2 tables,
and does not mirror legacy writes.

- [ ] **Step 4: Run the complete vertical gate**

Run core tests and typecheck plus web tests, check, and production build using
the commands in Global Constraints. Expected: all exit 0.

- [ ] **Step 5: Run the required review workflow**

Run `/ponytail-review` on the code diff. Then request a whole-vertical code
review before merging or starting Vertical 2. Fold all blocking findings into
a numbered revision of this plan's review record under
`docs/superpowers/reviews/`.

- [ ] **Step 6: Commit documentation and integration coverage**

```bash
git add .env.example core/.env.example docs/superpowers/documentation/RUNNING.md core/test/source-control-integration.test.ts
git commit -m "docs: gate the v2 source control plane

developed with the help of AI tools"
```
