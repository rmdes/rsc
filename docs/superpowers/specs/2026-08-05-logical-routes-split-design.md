# logical-routes.ts Module Split — Design

**Status:** Rev 1 (2026-08-05). A behavior-preserving structural refactor: split
the 1317-line `core/src/api/logical-routes.ts` into a barrel + one module per
route group. No behavior, signature, or route change. First of a possible series
of large-file splits (the codebase's largest files are its actively-developed
heart — see the 2026-08-05 health assessment); this one is the safest because the
file is *already* organized as 7 self-contained `mount*Routes` functions.

## Goal

`logical-routes.ts` (1317 loc) → the barrel `logical-routes.ts` (thin re-export)
plus `logical-routes/{shared,write,read,personal,admin,public}.ts`, each ≤ ~270
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

**`logical-routes.ts` stays at its exact path as a thin re-export barrel that
re-exports every symbol the file currently exports (all current `export`s — the
7 mount fns + every deps interface).** Result: `app.ts` and `server.ts` diffs are
**empty**. This is the whole point — the hottest consumer (`app.ts`) is never
touched.

## Target structure

```
core/src/api/
  logical-routes.ts              barrel — re-exports all current public exports
  logical-routes/
    shared.ts                    MODEL, NEUTRAL_404, IDEMPOTENCY_CONFLICT, isString
    write.ts                     mountLogicalRoutes        (moderation/write)
    read.ts                      mountLogicalReadRoutes     (timeline/feeds)
    personal.ts                  mountPersonalApiRoutes
    admin.ts                     mountAdminApiRoutes
    public.ts                    mountLogicalHandleRoute + mountLogicalStreamRoute + mountPublicFirehoseRoute
```

7 mount fns → 5 route modules (the three small public/stream/handle routes fold
into `public.ts`), plus `shared.ts` and the barrel.

## Shared-vs-local partition (traced, not guessed)

**Governing principle:** a symbol belongs in `shared.ts` iff **≥2 route modules
reference it, directly or transitively** (a helper that a write route calls, which
itself calls `isAuditCategory`, makes `isAuditCategory` shared). Everything else is
group-local. This is mechanically enforced: after each extraction, `tsc` fails on
any symbol a module needs but can't see → promote it to `shared.ts`. The list
below is the traced starting point, not a substitute for that check.

Symbol usage was traced across the mount-fn line ranges (write 136 · read 369 ·
personal 578 · admin 876 · handle 1049 · stream 1079 · firehose 1198),
**following helper chains** (the naive first pass under-counted — `readModBody`
wraps `isAuditCategory`/`isString`/`readJsonBody`):

**`shared.ts`** — the cross-group symbols:
- `MODEL` (write + handle; embedded in the shared error objects)
- `NEUTRAL_404` (write + handle)
- `IDEMPOTENCY_CONFLICT` (write + personal + admin)
- `isString` (write + personal + admin)
- `readJsonBody` (write + personal + admin)
- `isAuditCategory` + `AUDIT_CATEGORIES` (write via `readModBody`, + admin at 979)

**Group-local (move with their mount fn):**
- `write.ts`: `REFRESH_COMMAND`, `INVALID_CURSOR`, `ITEM_UNAVAILABLE`,
  `LOCAL_ORIGIN`, `NOT_APPLICABLE`, `NOT_BLOCKED`, `DEFAULT_LIMIT`, `ModBody`,
  `readModBody`, `moderationResponse`, `parseTuplePage`, `parsePage`
  (imports `isString`/`readJsonBody`/`isAuditCategory`/`MODEL`/`NEUTRAL_404`/
  `IDEMPOTENCY_CONFLICT` from `./shared.ts`).
- `read.ts`: `LogicalReadDeps`, `FEED_LIMIT`, `XML`, `LensSpec`, `LENS_KEYS`,
  `FORBIDDEN_KEYS`, `parseLensSpec`, `clampLimit`, `decodeBeforeCursor`.
- `personal.ts`: `PersonalApiDeps`, `ALLOWED_KEY_PERMISSIONS`,
  `isValidKeyPermissions`, `ApiKeyCreation`, `SUB_NEUTRAL_UNAVAILABLE`,
  `SUB_IDEMPOTENCY_CONFLICT` (imports `isString`/`readJsonBody`/
  `IDEMPOTENCY_CONFLICT` from `./shared.ts`).
- `admin.ts`: `AdminApiDeps` (imports `isString`/`readJsonBody`/`isAuditCategory`/
  `IDEMPOTENCY_CONFLICT` from `./shared.ts`).
- `public.ts`: the handle/stream/firehose deps interfaces + their locals (imports
  `MODEL`/`NEUTRAL_404` from `./shared.ts`).

The deps interfaces each mount fn takes (`LogicalRouteDeps`, `LogicalReadDeps`,
`PersonalApiDeps`, `AdminApiDeps`, and the public trio's) live with their mount
fn's module and are re-exported by the barrel.

## The one real mechanical risk: import-path depth

Every moved module sits one level deeper (`api/logical-routes/*.ts`), so all
relative imports shift by one segment:
- `'./app.ts'` → `'../app.ts'`, `'./auth.ts'` → `'../auth.ts'`
- `'../domain/…'` → `'../../domain/…'`, `'../logical/…'` → `'../../logical/…'`, `'../auth.ts'` → `'../../auth.ts'`

Explicit `.ts` extensions + Node type-stripping mean a wrong path is an immediate
`tsc`/runtime failure — caught by the per-module gate, not silently. Each module
imports only what it uses (from `./shared.ts` for the shared four, from the
adjusted source paths for the rest).

## Safety protocol

- **Pure move.** Cut a group verbatim into its module; adjust only import paths
  and add `import` of the shared four where used. No other edits.
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
