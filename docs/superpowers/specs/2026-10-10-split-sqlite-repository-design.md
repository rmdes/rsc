# Split `SqliteRepository` along its two interfaces — Design

**Status:** Rev 1, 2026-10-10. Approved section-by-section in brainstorming
(approach A of three: composition).
**Origin:** item 3 of the recommended order in
`docs/superpowers/reviews/2026-08-06-architecture-debt-review.md`.

## Problem

`core/src/storage/sqlite.ts` (1,801 lines) holds one class,
`SqliteRepository implements Repository, SourceRepository`. It carries two
unrelated persistence concerns: users/posts/settings/subscriptions
(`Repository`, 29 methods) and remote sources, federation, following and
transitions (`SourceRepository`, 17 methods). Because one object implements
both, consumers are typed `Repository & SourceRepository`, and the type system
treats the two concerns as one.

## What exploration established (verified 2026-10-10)

| Question | Answer |
|---|---|
| Do the halves call each other? | **No.** Zero `this.`-calls across the seam in either direction. They share only the connection: `this.db` (Kysely) and `this.sqlite`/`this.raw`. |
| Where is the source half? | One contiguous block, `sqlite.ts:524-1242`: 17 public methods plus 7 private helpers (`federationStatusFor`, `subscriptionCountsFor`, `pushFor`, `retentionFor`, `memberExclusionClause`, `addedByFor`, `localFollowsFor`). |
| Module-level helpers | Each is used by **exactly one** half. Source-only: `journalPolicyReset`, `advancePolicyGeneration`, `cascadeInstanceAction`, `rowToRemoteSourceV2`, `rowToSourceSubscriptionV2`, `sourceDisplayName`, `NO_PUSH`, `PushRowV2Read`, `rowToSourceAuditV2`, `insertAudit`, `activatePendingSubscriptions`, `RemoteSourceV2Row`, `SourceSubscriptionV2Row`, `SourceAuditV2Row`. Repository-only: `rowToUser`, `rowToPost`, `rowToSubscription`, `joinedRowToEntry`. **The only shared item is `DB`**, Kysely's table-type interface, which is a type. |
| How do consumers reach the source half? | Production goes through **one** wiring point, `createSourcePlane(repo, …)` (`core/src/domain/source-service.ts:76`). Everything downstream (`api/app.ts`, `api/logical-routes/admin.ts`) is already typed plain `SourceRepository`. |
| What does the source service need from `Repository`? | Only `getUserByHandle` (`source-service.ts:102`, `:146`) and `getSetting` (`:118`, `:165`). |
| Callers of `createSourcePlane` / `createSourceService` | 110 call sites: 107 pass `repo`, 3 pass `deps.repo`. All are concrete `SqliteRepository` values; none is a hand-built stub. |
| Tests | 94 files construct the repository. Only **9** call source methods on it directly (69 call sites). Two more spots hand-wire it as a `SourceRepository`: `core/test/logical-v3-vertical.test.ts:176` and `core/test/api-key-cap.test.ts:53`. |
| Contract harness | `core/src/domain/repository-contract.ts` covers no source method, so it is unaffected. |
| Live docs | None describes the class's shape. `TESTING.md:98` mentions `SqliteRepository` only as an example LSP message, which stays true. |

## Design

### Ground rule: a pure move

Method and helper bodies move **byte-for-byte**, except for indentation where it
changes. No query, schema, transaction-boundary or behaviour change. Proof is
the existing suite passing unchanged.

### New file `core/src/storage/source-sqlite.ts`

```ts
export class SqliteSourceRepository implements SourceRepository {
  private db: Kysely<DB>
  private sqlite: InstanceType<typeof Database>
  constructor(db: Kysely<DB>, sqlite: InstanceType<typeof Database>) {
    this.db = db
    this.sqlite = sqlite
  }
  // + a `raw` getter if the moved bodies use `this.raw` (they do: 34 uses)
  // the 17 SourceRepository methods + 7 private helpers, moved verbatim
}
```

- Plain field assignment, no parameter properties: core runs on Node native
  type stripping, which cannot erase them (CLAUDE.md).
- The file also receives every **source-only** module-level helper and row
  type listed above.
- If code that stays in `sqlite.ts` still needs one of them, the helper is
  **exported** from `source-sqlite.ts` and imported back, never duplicated.
  This applies to the migrations and heals (`collapseVersionHistory`,
  `healStrandedMembers`, …) and to anything exported for other modules,
  e.g. `insertAudit`.

### `SqliteRepository` changes

- `implements Repository, SourceRepository` → `implements Repository`.
- It gains `readonly sources: SqliteSourceRepository`, constructed in its
  constructor over the **same** `db` and `sqlite`. That gives one connection and
  one `close()`, which stays on the repository.
- `sqlite.ts` drops to roughly 1,050 lines; `source-sqlite.ts` is roughly 750.

### Import direction (no runtime cycle)

- `sqlite.ts` imports `SqliteSourceRepository`, plus any moved helper its own
  module-level code still needs.
- `source-sqlite.ts` imports **only types** from `sqlite.ts` (`DB`, via
  `import type`). Type-only imports erase under type stripping, so there is no
  runtime import cycle. If the move would need a *value* from `sqlite.ts`, stop:
  that value belongs in `source-sqlite.ts` or in a third module.

### `source-service.ts`, the single wiring point

```ts
type SourceStore = Pick<Repository, 'getSetting' | 'getUserByHandle'> & { sources: SourceRepository }
```

- `createSourcePlane` and `createSourceService` take a `SourceStore` where they
  took `Repository & SourceRepository`.
- Inside, every source-method call becomes `store.sources.X(…)`. The four
  repository calls stay on `store`.
- `createSourcePlane` returns `repo: store.sources`, typed `SourceRepository`.
  Its one downstream consumer, `sources.repo.listApprovedFederationSources`,
  is a source method.
- **All 110 existing call sites still pass the repository unchanged**, because
  `SqliteRepository` satisfies `SourceStore`.

### Tests: mechanical edits only

- The 9 files that call source methods on the repository change `repo.X(` to
  `repo.sources.X(` (69 call sites): `logical-v3-vertical`,
  `instance-member-reap`, `migration-convert`, `smoke`,
  `logical-policy-events`, `source-cleanup`, `logical-fanout`,
  `source-cascade`, `source-reads`.
- `logical-v3-vertical.test.ts:176` changes `repo: deps.repo` to
  `repo: deps.repo.sources`, and `api-key-cap.test.ts:53` changes
  `sourceRepo: repo` to `sourceRepo: repo.sources`.
- **No assertion is edited and no test is added or removed.** The compiler
  lists the authoritative set of sites: once `SqliteRepository` stops
  implementing `SourceRepository`, every remaining use of it as one is a type
  error.

### Why one task

Removing the methods from `SqliteRepository` breaks `source-service.ts` and
these tests at the same moment. Staging the move would mean either red
intermediate commits, or a temporary delegating façade on `SqliteRepository`.
That façade is exactly the re-aggregation this change exists to remove. So the
move is a single atomic commit.

## Success criteria

1. core `npm run typecheck` exits 0.
2. Core suite **108 files / 1224 tests** passes unchanged, and web
   **56 files / 487 tests** is unaffected.
3. **Byte-identical bodies:** every moved method and helper diffs clean against
   its pre-move original, ignoring leading whitespace.
4. `SqliteRepository` no longer `implements SourceRepository` (grep).
   `SqliteSourceRepository implements SourceRepository`.
5. `source-sqlite.ts` has no value import from `sqlite.ts`; only `import type`
   lines refer to it (grep).
6. The dev stack's core boots healthy. `server.ts` wires through
   `createSourcePlane(repo, …)`.

No production-image check: there is no new workspace, dependency or
Dockerfile line. The new file lives under `core/src`, which the existing
`COPY . /app/code` already ships.

## Out of scope

- Any change to a query, schema, transaction, or the `SourceRepository` /
  `Repository` interfaces themselves.
- Narrowing other consumers of `Repository` (roadmap item 5 covers
  `LogicalStore`; this spec touches only the source wiring point).
- Splitting `SqliteRepository` further, or moving the migrations out of
  `sqlite.ts`.
- Renaming `createSqliteRepository` or changing its return type.

## Risks

| Risk | Mitigation |
|---|---|
| A moved body subtly changes during the move | Criterion 3: whitespace-insensitive diff of every moved body |
| A runtime import cycle between the two files | Criterion 5: `source-sqlite.ts` imports only types from `sqlite.ts` |
| A call site missed in tests | The compiler enumerates them; tsc 0 is the gate |
| Someone "fixes" the split later by re-adding delegating methods to `SqliteRepository` | The `SourceStore` type documents the real dependency; the commit message states why there is no façade |
