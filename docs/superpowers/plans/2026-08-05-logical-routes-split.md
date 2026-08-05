# logical-routes.ts Module Split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `core/src/api/logical-routes.ts` (1317 loc) into a same-path barrel + `logical-routes/{shared,write,read,personal,admin,public}.ts`, with **zero behavior change and zero diff on consumers** (`app.ts`, `server.ts`).

**Architecture:** The file is already 7 self-contained `mount*Routes` functions separated by banner comments, each with its own deps interface + local constants + helpers. Each route group moves verbatim into its own module; genuinely cross-group helpers move to `shared.ts`; `logical-routes.ts` becomes a thin `export *` barrel at its original path so the two hot consumers never change. `tsc` is the authority for `shared.ts` membership (extract → compile → promote unresolved).

**Tech Stack:** Node 22 native type-stripping (no build step), Hono, better-sqlite3/Kysely, Vitest. Spec: `docs/superpowers/specs/2026-08-05-logical-routes-split-design.md` (rev 3).

## Global Constraints

- **Pure move. No behavior/signature/route/response changes. No "while I'm here" fixes** — a bug spotted mid-move is noted in the task report, never fixed here.
- **No new dependencies.**
- **`tsc` is mandatory** — native type-stripping runs tests even with type errors, so every task runs `npm run typecheck -w core` (expect `0` errors) as a gate, not just Vitest.
- **Behavior net = the full core suite.** Every task ends green on `npm test -w core` (currently 1115 passing) — for a pure move, a route regression can surface in any suite, so run all of it, not a subset.
- **Preserve the public export surface.** Each route module `export`s **only** what `logical-routes.ts` exported before (its `mount*` fn + its deps interface). Helpers that were module-private stay **unexported**. `shared.ts` is **internal** — the barrel does NOT `export *` from it.
- **Barrel form:** `logical-routes.ts` ends as only `export * from './logical-routes/<mod>.ts'` lines for the **5 route modules** (not shared). Path stays `core/src/api/logical-routes.ts`.
- **Import-path depth:** modules sit one level deeper (`api/logical-routes/*.ts`), so relative imports gain one `../` (`'./app.ts'`→`'../app.ts'`, `'../domain/…'`→`'../../domain/…'`); siblings use `'./shared.ts'`. A wrong path is an immediate `tsc` failure.
- **Shared checkout:** stage explicit paths, **never `git add -A`**. End every commit message with `developed with the help of AI tools`.
- **Tests run in the project's in-container test environment** (isolated Docker stack on this worktree); commands below are the workspace-relative invocations.

## File Structure

```
core/src/api/
  logical-routes.ts              barrel — export * from the 5 route modules (path unchanged)
  logical-routes/
    shared.ts                    internal: the small set of cross-group helpers/constants
    write.ts                     mountLogicalRoutes + LogicalRouteDeps + write-local helpers
    read.ts                      mountLogicalReadRoutes + LogicalReadDeps + read-local helpers
    personal.ts                  mountPersonalApiRoutes + PersonalApiDeps + personal-local helpers
    admin.ts                     mountAdminApiRoutes + AdminApiDeps + admin-local helpers
    public.ts                    mountLogicalHandleRoute + mountLogicalStreamRoute + mountPublicFirehoseRoute + their deps
```

**Group boundaries in the current file** (cut on the `// ====` banners; `tsc` confirms the exact symbol set):
- write: preamble L30–135 (minus what Task 1 moves to shared) + `mountLogicalRoutes` L136–298
- read: L306–368 preamble + `mountLogicalReadRoutes` L369–505
- personal: L518–575 preamble + `mountPersonalApiRoutes` L578–815
- admin: L876–1034 (`mountAdminApiRoutes`)
- public: `mountLogicalHandleRoute` L1049–1059 + `mountLogicalStreamRoute` L1079–1148 + `mountPublicFirehoseRoute` L1198–end

**Consumers that must end at zero diff:** `core/src/api/app.ts` (imports `mountLogicalRoutes`, `mountLogicalReadRoutes`, `mountPersonalApiRoutes`, `mountAdminApiRoutes`, `type LogicalRouteDeps`), `core/src/server.ts` (imports `mountLogicalStreamRoute`, `mountLogicalHandleRoute`, `mountPublicFirehoseRoute`).

---

## Extraction Procedure (Tasks 2–6 all follow this)

Each extraction task has the same shape. Parameters per task: **module name**, **the `mount*` fn(s) to move**, its **deps interface**, and its **local helpers/constants**.

1. Create `core/src/api/logical-routes/<mod>.ts`.
2. **Cut verbatim** from `logical-routes.ts` into `<mod>.ts`: the group's `mount*` fn(s), its deps `interface`, and its local constants/helpers (everything between its banners that Task 1 did NOT move to `shared.ts`). Do not retype — move the exact code.
3. Fix imports in `<mod>.ts`: add one `../` to every relative path; add `import { … } from './shared.ts'` for shared symbols it uses. `export` only the `mount*` fn(s) + deps interface; leave helpers unexported.
4. In `logical-routes.ts`, delete the cut code and add `export * from './logical-routes/<mod>.ts'`.
5. **`tsc` gate:** run `npm run typecheck -w core`. For every "Cannot find name / has no exported member" on a symbol that now lives in a different module, **promote that symbol to `shared.ts`** (move its definition there, `export` it, import it where used). Repeat until `tsc` is `0`. This is how `shared.ts`'s exact membership is decided — not by a hand list.
6. **Test gate:** `npm test -w core` → all green. Then **commit** (explicit paths: `git add core/src/api/logical-routes.ts core/src/api/logical-routes/<mod>.ts core/src/api/logical-routes/shared.ts`).

---

## Task 1: Seed `shared.ts` with the known cross-group helpers

**Files:**
- Create: `core/src/api/logical-routes/shared.ts`
- Modify: `core/src/api/logical-routes.ts` (move helpers out, import them back)

**Interfaces produced:** `shared.ts` exports the cross-group helpers/constants that Tasks 2–6 import. Seed set (from the spec's illustrative list; Tasks 2–6 may promote more via the `tsc` gate): `MODEL`, `NEUTRAL_404`, `isString`, `readJsonBody`, `clampLimit`, `decodeBeforeCursor`, `ApiKeyCreation`.

- [ ] **Step 1: Create `shared.ts` and move the seed symbols into it.**
  Move these definitions **verbatim** out of `logical-routes.ts` into `core/src/api/logical-routes/shared.ts`, and `export` each: `MODEL` (L37), `NEUTRAL_404` (L41), `isString` (L65), `readJsonBody` (L68), `clampLimit` (L351), `decodeBeforeCursor` (L361), `ApiKeyCreation` (L565). Add to `shared.ts` whatever imports those defs need, at the corrected depth (`../../domain/…`, `../logical/…` → `../../logical/…`, etc.). `NEUTRAL_404` references `MODEL` — keep `MODEL` defined above it in `shared.ts`.

- [ ] **Step 2: Import them back into `logical-routes.ts`.**
  At the top of `logical-routes.ts` add `import { MODEL, NEUTRAL_404, isString, readJsonBody, clampLimit, decodeBeforeCursor, ApiKeyCreation } from './logical-routes/shared.ts'`. The file is otherwise unchanged and still monolithic — this task moves no routes.

- [ ] **Step 3: `tsc` gate.**
  Run: `npm run typecheck -w core`
  Expected: `0` errors. (If a moved helper needed another local symbol, either move that too or import it back — keep moving until clean.)

- [ ] **Step 4: Test gate.**
  Run: `npm test -w core`
  Expected: all green (1115 passing), no new failures.

- [ ] **Step 5: Commit.**
  ```bash
  git add core/src/api/logical-routes.ts core/src/api/logical-routes/shared.ts
  git commit -m "refactor(api): extract shared helpers of logical-routes into logical-routes/shared.ts

developed with the help of AI tools"
  ```

## Task 2: Extract `write.ts` (mountLogicalRoutes)

**Files:** Create `core/src/api/logical-routes/write.ts`; modify `logical-routes.ts` (and `shared.ts` if the `tsc` gate promotes a symbol).

**Interfaces:** Produces `export function mountLogicalRoutes(app, deps: LogicalRouteDeps): void` + `export interface LogicalRouteDeps`, re-exported via the barrel. Consumes from `./shared.ts`: `MODEL`, `NEUTRAL_404`, `isString`, `readJsonBody` (at least).

**Group specifics:** move `mountLogicalRoutes` (L136–298) + `LogicalRouteDeps` (L30) + write-local constants/helpers remaining in the L30–135 preamble after Task 1: `REFRESH_COMMAND`, `IDEMPOTENCY_CONFLICT`, `INVALID_CURSOR`, `ITEM_UNAVAILABLE`, `LOCAL_ORIGIN`, `NOT_APPLICABLE`, `NOT_BLOCKED`, `DEFAULT_LIMIT`, `AUDIT_CATEGORIES`, `isAuditCategory`, `ModBody`, `readModBody`, `moderationResponse`, `parseTuplePage`, `parsePage`. (`IDEMPOTENCY_CONFLICT`, `isAuditCategory`, `AUDIT_CATEGORIES` are write-only despite naive-grep noise — see spec.)

- [ ] **Step 1:** Apply the Extraction Procedure steps 1–3 for `write.ts` with the group specifics above.
- [ ] **Step 2 (`tsc` gate):** `npm run typecheck -w core` → `0`. Promote any cross-referenced symbol to `shared.ts` per the procedure.
- [ ] **Step 3 (test gate):** `npm test -w core` → all green.
- [ ] **Step 4 (commit):**
  ```bash
  git add core/src/api/logical-routes.ts core/src/api/logical-routes/write.ts core/src/api/logical-routes/shared.ts
  git commit -m "refactor(api): move mountLogicalRoutes into logical-routes/write.ts

developed with the help of AI tools"
  ```

## Task 3: Extract `read.ts` (mountLogicalReadRoutes)

**Files:** Create `core/src/api/logical-routes/read.ts`; modify `logical-routes.ts` / `shared.ts`.

**Interfaces:** Produces `export function mountLogicalReadRoutes(app, deps: LogicalReadDeps): void` + `export interface LogicalReadDeps`. Consumes from `./shared.ts`: `MODEL`, `clampLimit`, `decodeBeforeCursor` (moved in Task 1), plus any the gate promotes.

**Group specifics:** move `mountLogicalReadRoutes` (L369–505) + `LogicalReadDeps` (L306) + read-local: `FEED_LIMIT`, `XML`, `LensSpec`, `LENS_KEYS`, `FORBIDDEN_KEYS`, `parseLensSpec`. (`clampLimit`/`decodeBeforeCursor` already in `shared.ts`.)

- [ ] **Step 1:** Extraction Procedure steps 1–3 for `read.ts`.
- [ ] **Step 2 (`tsc` gate):** `npm run typecheck -w core` → `0`; promote as needed.
- [ ] **Step 3 (test gate):** `npm test -w core` → green.
- [ ] **Step 4 (commit):**
  ```bash
  git add core/src/api/logical-routes.ts core/src/api/logical-routes/read.ts core/src/api/logical-routes/shared.ts
  git commit -m "refactor(api): move mountLogicalReadRoutes into logical-routes/read.ts

developed with the help of AI tools"
  ```

## Task 4: Extract `personal.ts` (mountPersonalApiRoutes)

**Files:** Create `core/src/api/logical-routes/personal.ts`; modify `logical-routes.ts` / `shared.ts`.

**Interfaces:** Produces `export function mountPersonalApiRoutes(app, deps: PersonalApiDeps): void` + `export interface PersonalApiDeps`. Consumes from `./shared.ts`: `isString`, `readJsonBody`, `clampLimit`, `decodeBeforeCursor`, `ApiKeyCreation`.

**Group specifics:** move `mountPersonalApiRoutes` (L578–815) + `PersonalApiDeps` (L518) + personal-local: `ALLOWED_KEY_PERMISSIONS`, `isValidKeyPermissions`, `SUB_NEUTRAL_UNAVAILABLE`, `SUB_IDEMPOTENCY_CONFLICT`. (`ApiKeyCreation` already in `shared.ts` from Task 1.)

- [ ] **Step 1:** Extraction Procedure steps 1–3 for `personal.ts`.
- [ ] **Step 2 (`tsc` gate):** `npm run typecheck -w core` → `0`; promote as needed.
- [ ] **Step 3 (test gate):** `npm test -w core` → green.
- [ ] **Step 4 (commit):**
  ```bash
  git add core/src/api/logical-routes.ts core/src/api/logical-routes/personal.ts core/src/api/logical-routes/shared.ts
  git commit -m "refactor(api): move mountPersonalApiRoutes into logical-routes/personal.ts

developed with the help of AI tools"
  ```

## Task 5: Extract `admin.ts` (mountAdminApiRoutes)

**Files:** Create `core/src/api/logical-routes/admin.ts`; modify `logical-routes.ts` / `shared.ts`.

**Interfaces:** Produces `export function mountAdminApiRoutes(app, deps: AdminApiDeps): void` + `export interface AdminApiDeps`. Consumes from `./shared.ts`: `isString`, `readJsonBody`, `ApiKeyCreation`. Note: admin's category validation uses the **app.ts** `isSourceGovernanceCategory` import (`'../app.ts'`), not a local `isAuditCategory`.

**Group specifics:** move `mountAdminApiRoutes` (L876–1034) + `AdminApiDeps`.

- [ ] **Step 1:** Extraction Procedure steps 1–3 for `admin.ts`.
- [ ] **Step 2 (`tsc` gate):** `npm run typecheck -w core` → `0`; promote as needed.
- [ ] **Step 3 (test gate):** `npm test -w core` → green.
- [ ] **Step 4 (commit):**
  ```bash
  git add core/src/api/logical-routes.ts core/src/api/logical-routes/admin.ts core/src/api/logical-routes/shared.ts
  git commit -m "refactor(api): move mountAdminApiRoutes into logical-routes/admin.ts

developed with the help of AI tools"
  ```

## Task 6: Extract `public.ts` (handle + stream + firehose)

**Files:** Create `core/src/api/logical-routes/public.ts`; modify `logical-routes.ts` / `shared.ts`.

**Interfaces:** Produces `export function mountLogicalHandleRoute`, `mountLogicalStreamRoute`, `mountPublicFirehoseRoute` + their deps interfaces. Consumes from `./shared.ts`: `MODEL`, `NEUTRAL_404` (at least).

**Group specifics:** move all three: `mountLogicalHandleRoute` (L1049–1059), `mountLogicalStreamRoute` (L1079–1148), `mountPublicFirehoseRoute` (L1198–end), plus their deps interfaces and any locals between their banners. After this task, `logical-routes.ts` should contain **only** `export *` lines — remove the now-unused `shared.ts` import that Task 1 added.

- [ ] **Step 1:** Extraction Procedure steps 1–3 for `public.ts`.
- [ ] **Step 2 (`tsc` gate):** `npm run typecheck -w core` → `0`; promote as needed. Confirm `logical-routes.ts` has no leftover code (only `export *` lines) and no unused imports.
- [ ] **Step 3 (test gate):** `npm test -w core` → green.
- [ ] **Step 4 (commit):**
  ```bash
  git add core/src/api/logical-routes.ts core/src/api/logical-routes/public.ts core/src/api/logical-routes/shared.ts
  git commit -m "refactor(api): move handle/stream/firehose routes into logical-routes/public.ts; logical-routes.ts is now a barrel

developed with the help of AI tools"
  ```

## Task 7: Whole-file acceptance verification

**Files:** none changed (verification + any tiny cleanup only).

- [ ] **Step 1: Barrel is pure re-export.**
  `logical-routes.ts` is only `export * from './logical-routes/{write,read,personal,admin,public}.ts'` (5 lines, no other code, `shared.ts` NOT among them). Confirm by reading the file.

- [ ] **Step 2: Consumers are byte-unchanged.**
  Run: `git diff <merge-base> -- core/src/api/app.ts core/src/server.ts`
  Expected: **empty** (no consumer touched the whole branch).

- [ ] **Step 3: Public export surface unchanged.**
  The barrel still re-exports exactly the original 13 symbols (7 `mount*` fns + 6 deps interfaces) and nothing new (no leaked private helper). Spot-check: `app.ts`'s `import type { LogicalRouteDeps }` and `server.ts`'s three `mount*` imports still resolve.

- [ ] **Step 4: Full gate.**
  Run: `npm run typecheck -w core` (→ `0`) and `npm test -w core` (→ all green). No commit needed unless Step 1/3 required cleanup.

## Self-Review (author checklist — completed)

- **Spec coverage:** barrel-at-path (Global Constraints + Task 7) ✓; 5 route modules + shared (Tasks 1–6) ✓; `tsc`-driven shared membership (Extraction Procedure step 5, Task 1 note) ✓; import-depth shift (Global Constraints) ✓; export-surface preservation (Global Constraints + Task 7 Step 3) ✓; behavior-preserving pure move (Global Constraints) ✓; per-module tsc+test+commit gate (every task) ✓; zero-diff consumers (Task 7 Step 2) ✓; shared-checkout explicit-path staging (every commit) ✓.
- **Placeholder scan:** exact commands (`npm run typecheck -w core`, `npm test -w core`), exact file paths, exact symbol lists per task — no "TBD"/"handle edge cases"/"similar to Task N" (the Extraction Procedure is spelled out once and referenced with concrete per-task parameters).
- **Type/name consistency:** mount-fn names and deps-interface names match the current file's exports across all tasks; `shared.ts` seed set is consistent between Task 1 and the Consumes lines of Tasks 2–6.
