# logical-routes.ts Module Split — Design

**Status:** Rev 3 (2026-08-05; second clean-context ponytail round folded). The
hand-traced `shared.ts` partition was wrong in both review rounds (symbol-name
collisions + comment matches), so rev 3 stops asserting an exact membership list
and makes **`tsc` the authority** for `shared.ts` (extract → compile → promote
unresolved). Rev 2 had set the barrel to `export *` wildcard re-exports (kept). A
behavior-preserving structural refactor: split
the 1317-line `core/src/api/logical-routes.ts` into a barrel + one module per
route group. No behavior, signature, or route change. First of a possible series
of large-file splits (the codebase's largest files are its actively-developed
heart — see the 2026-08-05 health assessment); this one is the safest because the
file is *already* organized as 7 self-contained `mount*Routes` functions.

## Goal

`logical-routes.ts` (1317 loc) → the barrel `logical-routes.ts` (thin re-export)
plus `logical-routes/{shared,write,read,personal,admin,public}.ts`, each ≤ ~300
loc and holdable in one context. **Zero behavioral change; zero churn on
consumers.**

## Why this is safe / why now

- The file is already 7 independent `mount*Routes` functions separated by banner
  comments, each carrying its own deps interface, local constants, and helpers.
  The seams are pre-drawn.
- Route behavior is covered by existing `app.request` route test suites — the
  safety net for a pure move.
- Chosen over `sqlite.ts` (97 commits/30d) / `app.ts` (89/30d): `logical-routes.ts`
  is less hot (30/30d), and it splits cleanly where the others don't. Contention
  is still real (shared checkout, parallel sessions) — mitigated by isolation +
  fast merge (see Coordination).

## Non-goals (explicit)

- **No logic changes.** No signature changes, no route additions/removals, no
  response-shape changes, no "while I'm here" fixes. A bug spotted mid-move is
  noted, not fixed.
- Not splitting any other file. Not touching `app.ts` / `server.ts` beyond what
  the barrel guarantees (which is nothing).
- No new dependencies. No new tests beyond what proves the move preserved behavior
  (the existing route suites already do).

## Strategy — barrel keeps the import path stable

Consumers import from `'./logical-routes.ts'` (app.ts: `mountLogicalRoutes`,
`mountLogicalReadRoutes`, `mountPersonalApiRoutes`, `mountAdminApiRoutes`,
`type LogicalRouteDeps`) and `'./api/logical-routes.ts'` (server.ts:
`mountLogicalStreamRoute`, `mountLogicalHandleRoute`, `mountPublicFirehoseRoute`).

**`logical-routes.ts` stays at its exact path as a thin re-export barrel**, one
`export * from './logical-routes/<mod>.ts'` line per submodule (wildcard, so it
self-syncs with whatever each submodule exports — no named list to drift). Result:
`app.ts` and `server.ts` diffs are **empty**.

The barrel is kept as the route layer's permanent public entry point, not a
transitional shim. Rationale (ponytail review folded): the point is not to dodge
editing two imports once — it's that `app.ts` (89 commits/30d, the single hottest
file in the repo) and `server.ts` stay at **zero diff** through this split *and*
through any future internal reshuffle of the route modules. Collapsing the barrel
later would re-introduce churn against exactly that file, for no gain. A ~7-line
wildcard barrel is the cheaper permanent trade.

## Target structure

```
core/src/api/
  logical-routes.ts              barrel — `export *` per submodule (path unchanged)
  logical-routes/
    shared.ts                    small neutral module of cross-group helpers (tsc-discovered)
    write.ts                     mountLogicalRoutes        (moderation/write)
    read.ts                      mountLogicalReadRoutes     (timeline/feeds)
    personal.ts                  mountPersonalApiRoutes
    admin.ts                     mountAdminApiRoutes
    public.ts                    mountLogicalHandleRoute + mountLogicalStreamRoute + mountPublicFirehoseRoute
```

7 mount fns → 5 route modules (the three small public/stream/handle routes fold
into `public.ts`), plus `shared.ts` and the barrel.

## Shared-vs-local partition (traced, not guessed)

**Governing principle & mechanism.** A symbol belongs in `shared.ts` iff **≥2
route modules reference it** (directly or transitively). Exact membership is
**discovered by `tsc`, not by hand**: extract a module, run `tsc`; every symbol it
can't resolve gets promoted to `shared.ts`; repeat until the set compiles clean.
`tsc` is the authority — any prose list here is a hint, never the contract.

Why the mechanism instead of a table: this partition was hand-traced across two
review rounds and was **wrong both times**. `grep` collided distinct symbols
(`IDEMPOTENCY_CONFLICT` vs `SUB_IDEMPOTENCY_CONFLICT` vs the app.ts
`SOURCES_IDEMPOTENCY_CONFLICT` alias; local `isAuditCategory` vs the app.ts
`isSourceGovernanceCategory` alias) and matched names inside comments. A
behavior-preserving move does not need a provably-correct hand audit — it needs
the compiler to close the set, which it does deterministically.

**Expected shape (illustrative, not exhaustive):** `shared.ts` ends up a small
neutral module — on the order of ~7 tiny symbols. Cross-group members surfaced so
far: `isString`, `readJsonBody`, `MODEL`, `NEUTRAL_404`, the cursor helpers
`clampLimit`/`decodeBeforeCursor` (read + personal), and the `ApiKeyCreation` cast
interface (personal + admin). Everything else is group-local: each route module
carries **its own** deps interface, constants, and helpers, cut verbatim with its
mount fn — and whatever `tsc` then reports as cross-referenced moves to
`shared.ts`. The deps interfaces (`LogicalRouteDeps`, `LogicalReadDeps`,
`PersonalApiDeps`, `AdminApiDeps`, and the public trio's) live with their mount
fn's module and are re-exported by the barrel.

## The one real mechanical risk: import-path depth

Every moved module sits one level deeper (`api/logical-routes/*.ts`), so all
relative imports shift by one segment:
- `'./app.ts'` → `'../app.ts'`, `'./auth.ts'` → `'../auth.ts'`
- `'../domain/…'` → `'../../domain/…'`, `'../logical/…'` → `'../../logical/…'`, `'../auth.ts'` → `'../../auth.ts'`

Explicit `.ts` extensions + Node type-stripping mean a wrong path is an immediate
`tsc`/runtime failure — caught by the per-module gate, not silently. Each module
imports only what it uses (from `./shared.ts` for the shared module, from the
adjusted source paths for the rest).

## Safety protocol

- **Pure move.** Cut a group verbatim into its module; adjust only import paths
  and add `import` of the shared module where used. No other edits.
- **Per-module gate:** after each module extraction — `tsc` clean + run that
  group's route test suite green + commit. One commit per module → bisectable.
- **Barrel last / incremental:** as each group moves out, the barrel re-exports
  from the new module; `logical-routes.ts` shrinks to pure re-exports at the end.
- **Acceptance (whole):** `git diff` on `app.ts` and `server.ts` is empty; full
  core Vitest green; `tsc` 0; every route responds identically (the route suites
  are the proof); the barrel's export surface is unchanged.

## Coordination (shared checkout)

- Executed on the `refactor-logical-routes-split` worktree branch (from `main`
  `bf16247`). In-container tests via an isolated Docker stack on the worktree.
- Stage explicit paths, never `git add -A` (parallel sessions on `main`).
- `logical-routes.ts` is 30 commits/30d — before merging, re-check it hasn't
  moved on `main`; if it has, the barrel-first structure makes re-deriving the
  extraction straightforward (the groups are verbatim cuts). Merge promptly to
  keep the window small.

## Sequencing

Spec → clean-context spec review (fold as revs) → `writing-plans` (one task per
module extraction + a final barrel-collapse/whole-file verification task) →
clean-context plan review → `subagent-driven-development` with a whole-branch
review → merge to `main` → optional deploy. No code authorized by this document.
