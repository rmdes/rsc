# Split `SqliteRepository` along its two interfaces — Design

**Status:** Rev 3, 2026-10-10. Rev 3 corrects three facts measured by dry-running the implementation plan on a throwaway copy (see "Rev 3 changes"). Rev 2: Rev 1 was approved section-by-section in
brainstorming (approach A of three: composition). Rev 2 folds a clean-context
review (verdict on rev 1: READY WITH CHANGES; 4 Important). Every folded
finding was re-verified against the code first. See "Rev 2 changes" at the end.
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
| Where is the source half? | One contiguous block, `sqlite.ts:524-1241`: 17 public methods plus 7 private helpers (`federationStatusFor`, `subscriptionCountsFor`, `pushFor`, `retentionFor`, `memberExclusionClause`, `addedByFor`, `localFollowsFor`). |
| What does the source half touch on the instance? | **Only `this.raw`** (34 uses). It uses `this.db` (Kysely) 0 times and `this.sqlite` 0 times. |
| Cross-seam calls | **Exactly one shared helper:** `private splitPage` (`sqlite.ts:518-522`). It is called by `listUsers` on the repository side (`:471`) and by three source methods (`:588`, `:733`, `:757`). Otherwise there are no `this.`-calls across the seam. `splitPage` depends only on `encodeCursor`, which already lives in `domain/source-repository.ts`. |
| Module-level helpers | Each is used by exactly one half. Source-only: `journalPolicyReset`, `advancePolicyGeneration`, `cascadeInstanceAction`, `rowToRemoteSourceV2`, `rowToSourceSubscriptionV2`, `sourceDisplayName`, `NO_PUSH`, `PushRowV2Read`, `rowToSourceAuditV2`, `insertAudit`, `activatePendingSubscriptions`, `RemoteSourceV2Row`, `SourceSubscriptionV2Row`, `SourceAuditV2Row`, and the `Db` type alias. Repository-only: `rowToUser`, `rowToPost`, `rowToSubscription`, `joinedRowToEntry`, `DB`. |
| External importers of source-only items | `migration/convert.ts:5` value-imports `insertAudit` from `storage/sqlite.ts`. `logical/membership.ts:2` type-imports `RemoteSourceV2Row` from it. Nothing else outside `sqlite.ts` imports a source-only item. |
| Migrations and heals | `migrate`, `collapseVersionHistory` and `healStrandedMembers` use **no** source-only helper, so they need nothing from the moved code. |
| How production reaches the source half | One wiring point, `createSourcePlane(repo, …)` (`domain/source-service.ts:76`). Downstream, `sources.repo` reaches `api/app.ts:336` (as `sourceRepo` into `logical-routes/admin.ts:24`), `app.ts:353` (`v2repo`) and `app.ts:688`. All three call only source methods and are already typed `SourceRepository`. |
| What the source service needs from `Repository` | Only `getUserByHandle` (`source-service.ts:102`, `:146`) and `getSetting` (`:118`, `:165`). |
| Callers of `createSourcePlane` / `createSourceService` | 110 call sites: 106 in tests plus `server.ts:56` pass `repo`; `logical-v3-vertical.test.ts:176/540/580` pass `deps.repo`, where `deps` is `Awaited<ReturnType<typeof fresh>>`, a real `SqliteRepository`. None is a hand-built stub. |
| Tests that use the repository **as** a source repository | 9 files make **69** direct source-method calls (`repo.X(`). Separately, **38** sites in **35** files hand the repository to `createApp` as its `SourceRepository`: 36 shorthand `sources: { service, repo }` sites in 33 files, plus `logical-v3-vertical.test.ts:176` (`repo: deps.repo`) and `api-key-cap.test.ts:53` (`sourceRepo: repo`). One assertion, `expect(on.repo).toBe(repo)` in `logical-tombstones.test.ts`, pins the plane returning the very object it was given. |
| Other test coupling | None. No test reaches a private field (`repo[...]`), uses `instanceof SqliteRepository`, or spreads or enumerates repository methods. The contract harness (`domain/repository-contract.ts:12`) takes `Repository & Pick<DatabaseContext,'raw'>` and calls no source method. `shutdown.ts:5` needs only `{ close(): void }`. |
| Live docs | None describes the class's shape (`TESTING.md:98` mentions it only as an example LSP message). |

**Note on test-type safety.** tsc does check `core/test/` (`core/tsconfig.json`
includes `test`), but vitest runs under type stripping and does **not**. A
missed call site would fail `typecheck` while some tests still passed at
runtime on the wrong object. So **core `typecheck` is the gate for this change,
not the test count.**

## Design

### Ground rule: a pure move

Method and helper bodies move **byte-for-byte**, except for indentation where it
changes. There is **one named exemption**: the four `this.splitPage(` call sites
become `splitPage(`. No query, schema, transaction-boundary or behaviour change.

### Shared: `splitPage` hoisted to `domain/source-repository.ts`

`private splitPage` becomes an exported module-level function in
`core/src/domain/source-repository.ts`, beside `encodeCursor` and `clampLimit`,
with its body and doc comment unchanged. Both halves import it from there. It
does **not** go in `sqlite.ts`, because the new source file would then need a
value import from `sqlite.ts`.

### New file `core/src/storage/source-sqlite.ts`

```ts
export class SqliteSourceRepository implements SourceRepository {
  private raw: Database.Database
  // Plain assignment, not a parameter property: Node's native type stripping
  // can't erase parameter properties.
  constructor(raw: Database.Database) {
    this.raw = raw
  }
  // the 17 SourceRepository methods + 7 private helpers, moved verbatim
}
```

- **One field, `raw`.** The moved bodies use only `this.raw`, so they stay
  byte-identical. There's no Kysely, no `DB` type, and no `sqlite` field.
- The file also receives every source-only module-level helper, row type and
  the `Db` alias listed above, and the source-half header comments with them:
  the V2 logical-journal integration block (`sqlite.ts:19-32`) and the
  "v2 source-control plane administrative reads" header (`:511-513`).
- Items used outside the file are exported from it: `insertAudit` and
  `RemoteSourceV2Row`.
- Only the imports the moved code actually uses come with it.

### `SqliteRepository` changes

- `implements Repository, SourceRepository` → `implements Repository`.
- It gains `readonly sources: SqliteSourceRepository`, constructed in its
  constructor as `new SqliteSourceRepository(sqlite)`, the same connection.
  There is one `close()`, and it stays on the repository.
- Imports the moved code no longer needs are **pruned**. Nothing flags them:
  there is no `noUnusedLocals`, and `verbatimModuleSyntax` keeps unused imports
  as real runtime imports. Candidates: `createHash`, `checkCommand`,
  `storeCommand`, `reapSourceFn`, `SOURCE_TRANSITIONS`,
  `CATEGORY_OPTIONAL_ACTIONS`, `encodeCursor`, `appendJournal`,
  `scheduleFanout` and most `membership.ts` names. Still used:
  `reapSourceIfOrphaned`, `clampLimit`, `DEAD_SOURCE_FAILURES`, `healMembers`.
  Remove what is truly unused; the list above is a starting point, not a
  substitute for checking.
- `sqlite.ts` drops to 922 lines; `source-sqlite.ts` is 895 (measured in the dry run).

### Import direction

`source-sqlite.ts` imports **nothing** from `sqlite.ts`, so a cycle is
impossible. Its runtime imports are `node:crypto`,
`domain/source-repository.ts`, `logical/journal.ts`, `logical/fanout.ts` and
`logical/membership.ts`. None of them value-imports `sqlite.ts`; `membership.ts`
only type-imports it today, and it is repointed below.

### Repointed external importers

- `migration/convert.ts:5`: `insertAudit` now imported from
  `../storage/source-sqlite.ts`.
- `logical/membership.ts:2`: `RemoteSourceV2Row` now type-imported from
  `../storage/source-sqlite.ts`.
- No re-export shim is left behind in `sqlite.ts`.

### `source-service.ts`, the single wiring point

```ts
type SourceStore = Pick<Repository, 'getSetting' | 'getUserByHandle'> & { sources: SourceRepository }
```

- `createSourcePlane` and `createSourceService` take a `SourceStore` where they
  took `Repository & SourceRepository`. The **parameter keeps its name `repo`**,
  to avoid diff noise.
- Every source-method call inside becomes `repo.sources.X(…)`. The four
  repository calls stay on `repo`.
- `createSourcePlane` returns `repo: repo.sources`, typed `SourceRepository`.
- **All 110 existing call sites still pass the repository unchanged.**

### Tests: mechanical edits only

- The 9 files that call source methods directly change `repo.X(` to
  `repo.sources.X(` (69 call sites): `logical-v3-vertical`,
  `instance-member-reap`, `migration-convert`, `smoke`,
  `logical-policy-events`, `source-cleanup`, `logical-fanout`,
  `source-cascade`, `source-reads`.
- The 38 hand-wired sites (35 files) change `repo` to `repo.sources` where the
  repository is passed as a `SourceRepository`:
  - `sources: { service, repo }` becomes `sources: { service, repo: repo.sources }`
  - `repo: deps.repo` becomes `repo: deps.repo.sources` at `logical-v3-vertical.test.ts:176`
  - `sourceRepo: repo` becomes `sourceRepo: repo.sources` at `api-key-cap.test.ts:53`
- **Exactly one assertion changes.** In `logical-tombstones.test.ts`,
  `expect(on.repo).toBe(repo)` becomes `toBe(repo.sources)`. The plane now
  returns the source store, by design. The new form keeps the test's intent (the
  plane exposes the real store, not a copy). It passes in commit 1, where
  `repo.sources` *is* `repo`, and in commit 2.
- In total that's about 40 test files. No test is added or removed, and every
  other edit is a mechanical access-path change. The compiler lists the
  authoritative set of sites.

## Staging: two green commits, no façade

1. **Migrate the call sites.** Add `get sources(): SourceRepository { return this }`
   to `SqliteRepository`. Change `source-service.ts` to `SourceStore` and
   `repo.sources`, and change all test sites to `.sources`. Everything stays
   green, `SqliteRepository` still implements both interfaces, and **no
   forwarding methods exist**, so this is not a delegating façade. It is the
   final access path pointing at the current object.
2. **The pure move.** Hoist `splitPage`, then create `source-sqlite.ts` with the
   moved code. In `SqliteRepository`, drop `implements SourceRepository`, turn
   the getter into the `readonly sources` field, and prune imports. Repoint
   `convert.ts` and `membership.ts`. This commit's diff contains **only** the
   move, which is what makes criterion 3 reviewable.

## Success criteria

1. Core `npm run typecheck` exits 0 after **each** commit. This is the
   authoritative gate (see the test-type safety note).
2. Core suite **108 files / 1224 tests** passes unchanged after each commit, and
   web **56 / 487** is unaffected.
3. **Byte-identical bodies:** every moved method and helper diffs clean against
   its pre-move original, ignoring leading whitespace. The only exemption is
   `this.splitPage(` → `splitPage(` at its four call sites.
4. `SqliteRepository` no longer `implements SourceRepository`, and
   `SqliteSourceRepository implements SourceRepository` (grep).
5. `source-sqlite.ts` contains no import from `sqlite.ts` (grep).
6. `sqlite.ts` keeps no import that nothing in it uses (grep each imported name).
7. The dev stack's core boots healthy.

No production-image check: there's no new workspace, dependency or Dockerfile
line. The new file lives under `core/src`, which the existing `COPY` already
ships.

## Out of scope

- Any change to a query, schema, transaction, or to the `SourceRepository` /
  `Repository` interfaces.
- Narrowing other `Repository` consumers (roadmap item 5 covers `LogicalStore`).
- Further splits of `SqliteRepository`, or moving the migrations out.
- Renaming `createSqliteRepository` or changing its return type.

## Risks

| Risk | Mitigation |
|---|---|
| A moved body changes during the move | Criterion 3: whitespace-insensitive diff, with one named exemption |
| A missed call site still type-checks wrongly but passes at runtime | Criterion 1: typecheck after each commit, not the test count |
| A runtime import cycle | Criterion 5: `source-sqlite.ts` imports nothing from `sqlite.ts` |
| Dead imports left as live runtime imports | Criterion 6 |

## Rev 2 changes

Each was re-verified against the code before folding.

- **`splitPage` crosses the seam (Important).** Rev 1 claimed zero cross-seam
  calls. `splitPage` is used by both halves; my method-listing regex missed it
  because of the generic `<R …>(`. It is now hoisted to
  `domain/source-repository.ts`, and its 4 call sites are the one named
  exemption from byte-identity.
- **39 hand-wired test sites, not 2 (Important).** Rev 1 grepped `repo:\s*x` and
  missed the `{ service, repo }` shorthand (37 sites, 34 files). Test churn is
  about 40 files, not 10.
- **External importers (Important).** `convert.ts` and `membership.ts` are
  repointed to the new file, with no re-export shim. Rev 1's clause that "the
  migrations and heals need moved helpers" was vacuous and is removed.
- **One field, `raw` (Important).** Rev 1 said the new class takes `db` and
  `sqlite` and a `raw` getter. I had misread a two-block `uniq` output: the
  source half uses only `this.raw`. That removes the `DB` import, and with it
  the whole import-direction concern.
- **Staging.** Rev 1 argued it had to be one atomic task, because staging would
  need a façade. That was wrong: `get sources() { return this }` gives a green
  intermediate state with no forwarding methods. It is now two commits, so the
  move's diff is only the move.
- Also: the `Db` alias and the source-half header comments move; stale imports
  are pruned (a new criterion); the downstream-consumer description is made
  precise; typecheck, not the test count, is named as the gate; the parameter
  name stays `repo`; the prose-only "someone re-adds a façade" risk row is cut.

## Rev 3 changes

The implementation plan was dry-run end to end, verbatim, on a throwaway copy.
The fully moved copy was type-checked and tested inside the core container
(typecheck 0, core 108 / 1224). That run corrected three facts:

- **Hand-wired sites: 38 in 35 files, not 39 in 36.** The shorthand grep had
  also matched `repo: deps.repo }`, an explicit site already counted separately.
- **One assertion must change.** `logical-tombstones.test.ts` pins
  `expect(on.repo).toBe(repo)`. After the move the plane returns
  `repo.sources`, a different object, so exactly that one test failed in the dry
  run (1223 / 1224). The assertion becomes `toBe(repo.sources)`, and the suite
  then passes 1224 / 1224. Rev 2's "no assertion is edited" was wrong.
- **Sizes:** 922 / 895 lines, not roughly 1,050 / 750.

