# Logical Pipeline Simplification — Program Roadmap

**Status:** Draft roadmap (brainstormed 2026-08-01). This is a **program**, not a
single spec: it sequences five independent simplification phases, each of which
gets its OWN brainstorm→spec→plan→SDD and its own independent deploy. This doc
governs sequencing, the feature-preservation contract, and how the known
Criticals are folded — it authorizes no code itself.

**Inputs:**
- Audit: `docs/superpowers/reviews/2026-08-01-logical-pipeline-audit.md` (`c7b32a2`) — ~36 `_v2` tables / 7.2k LOC; ranked cuts.
- Parked prior art: `docs/superpowers/specs/2026-07-31-remote-content-simplification-design.md` (`3bacf7f`) — did the deep design for Phases B & C and surfaced the 5 Criticals below.
- Context: [[remote-content-retention-milestone]], [[obs-versions-runaway-purge]], [[source-governance-verticals]].

## Goal

Cut ~1,100 LOC and ~6 tables of unearned complexity from `core/src/logical`
**while preserving essentially all user-facing service features.** The pipeline
should end up closer to what RSC actually is — fetch feeds → dedupe → timeline →
thread → federate — without the layers that back near-unused signals.

## Feature-preservation contract

**Kept, unchanged (the product):** timeline (local + remote), threading /
conversations over RSS, feeds (RSS/Atom/JSON + comments), SSE live updates,
moderation / `hidden` durability, governance / federation / source-audit,
**local post edit-history (`post_revisions`** — a separate system, untouched),
the retention age gate, sanitizer, no-JS first-class.

**Dropped (the debt — confirmed acceptable by the maintainer):**
- **B:** remote *feed-item* edit history (`/post/[id]/history` for remote items +
  the remote "edited" marker). Remote items show the publisher's latest.
- **C:** the `verified_origin` signal (anti-byline-spoofing tiebreak on aggregate
  firehoses + a source-reap-protection heuristic). Attribution keeps its lower
  evidence levels.
- **D:** possibly cross-source author *merge* (same author via multiple feeds →
  one byline). The precise byline behavior that must survive is **Phase D's own
  brainstorm**; the roadmap commits only that a working byline stays.

## Phase sequence (dependency- and risk-ordered)

Retiring the dead v1→v2 migration converter FIRST is the key that unlocks the
program: `core/src/migration/convert.ts` is the only thing making
`verification.ts` un-deletable (it imports `EMPTY_COUNTERS` and encodes
verification concepts). All four instances are already on v2 and V1 retirement
is done, so the converter is dead code — retiring it dissolves Critical 1.

| Phase | Cut (audit ref) | Depends on | Risk |
|---|---|---|---|
| **A** | Retire v1→v2 migration converter (`convert.ts`, `logical_activation_v2`, related bookkeeping) | — | Low (dead-code removal) |
| **B** | Remove remote version-history (audit #2; parked §1–4) | — (independent of A) | Medium (live version-collapse migration) |
| **C** | Remove origin verification (audit #1; parked §5) | **A** (detangles the converter import) | Medium |
| **D** | Simplify the publisher attribution graph (audit #3) | after C (verified_origin rung already gone) | Medium-high (byline design) |
| **F** | Consolidate thin tables (audit #5) | after A (drops bookkeeping A subsumes) | Low (cleanup) |

A and B are independent and may run in either order / in parallel sessions with
coordination. C requires A. D is cleanest after C. F is last.

**Deferred — NOT in this program:** Phase E (reconciliation async→inline, audit
#4). It touches the spine's concurrency model and the async queue may enable
cross-source ordering federation relies on. Revisit as a separately-decided
item once the tree is smaller and clearer; it is explicitly out of scope here.

## The 5 Criticals — mapped to the phase that must fold them

From the parked spec's 2-lens review (must be folded into the owning phase's spec):
1. **Converter dependency** — deleting `verification.ts` breaks `convert.ts` (`EMPTY_COUNTERS` import). → **Owned by Phase A** (retiring the converter removes the dependency before Phase C runs).
2. **FK-RESTRICT delete order** — the version-collapse cannot "rewire" FKs; it must DELETE children in dependency order (`presentation_entries_v2` is UNIQUE + RESTRICT; also `publisher_claims_v2`, `logical_conflicts_v2`, `reconciliation_jobs_v2`). → **Owned by Phase B** (the migration is its central, most-tested task).
3. **Live `verified_origin` rows** — existing `evidence_level='verified_origin'` claim rows feed `undefined` into the author comparator once the rung is removed. → **Owned by Phase C** (migrate/collapse those rows before narrowing the comparator).
4. **Under-removed footprint** — the parked removal missed `reconcile.ts` / `store.ts` / `tombstones.ts` / web + enum members. → **Owned by Phases B & C** (each phase's clean-context spec + plan reviews enumerate the full footprint before SDD).
5. **Survivor-selection / "show latest"** — the version collapse must pick the row backing the current display presentation and emit the correct ordinary journal upsert (SSE refresh, no "edited" semantic). → **Owned by Phase B**.

## Per-phase briefs (each expands into its own spec)

**Phase A — Retire the v1→v2 migration converter.** Remove `core/src/migration/convert.ts` and its tests, `logical_activation_v2` and the conversion-findings bookkeeping, and any migration-only code paths now unreachable (all instances on v2, V1 retired). Verify nothing on the live path imports the converter except the (also-removed) migration entrypoint. Net: the converter's LOC + 1 bookkeeping table + the `verification.ts` import tangle gone. **Deploy note:** no data migration (removing dead code); confirm no instance still needs a v1→v2 run (they don't — all converted 2026-07-25).

**Phase B — Remote items become current-only.** Per parked spec §1–5: one current observation per delivery; on a real change, overwrite in place + one reconciliation job + the ordinary "updated" journal effect; remove the remote `/post/[id]/history` route and the remote "edited" marker; keep the (already-fixed) change-detection fingerprint. Central task = the version-collapse migration (Criticals 2 & 5). Keep `post_revisions` untouched.

**Phase C — Remove origin verification.** Delete `verification.ts` + `createVerificationRunner` + `verification_checks_v2` + the `'verification'` reconciliation-job kind + `verification_batch_key` + the `verified_origin` comparator rung + runtime/scheduler `drainVerification` wiring. Migrate live `verified_origin` claim rows down to the next evidence level first (Critical 3). Depends on Phase A.

**Phase D — Simplify the publisher attribution graph.** Audit #3: the 4 publisher tables (`publisher_claims_v2`, `publisher_names_v2`, `remote_publishers_v2`, `publisher_feed_aliases_v2`) + the projector's `selectAuthor`/evidence-ranking. Its brainstorm decides the byline-preservation bar (cross-source merge vs source/author-field byline) before any removal. Cleanest after C (the `verified_origin` evidence level is already gone).

**Phase F — Consolidate thin tables.** Audit #5: fold the three tombstone flavors (`blocked_source_tombstones_v2`, `tombstone_aliases_v2`, `handle_reservations_v2`) where they overlap; drop `policy_fanout_v2` / migration bookkeeping if unreferenced post-A; keep cheap real ones (`source_validators_v2` conditional-fetch). Low-risk cleanup, last.

## Cross-cutting execution rules

- **Each phase is independent:** its own brainstorm→spec→(clean-context spec review)→writing-plans→(clean-context plan review)→subagent-driven-development→whole-branch review→independent deploy. No phase blocks on a later one.
- **Shared checkout / parallel sessions.** Parallel sessions actively work in `core/src/logical/*`. Each phase must coordinate before SDD (it removes tables/columns/enum members other in-flight work may assume). Stage explicit paths; never `git add -A`.
- **Forward-only migrations, backup-before-flip** (RUNNING.md posture) for B, C, D (F if it drops tables). A is dead-code removal (no data migration).
- **Completion gate per phase:** core Vitest, `tsc`, web Vitest, `svelte-check`, web build — all green before deploy.
- **Sequencing gate:** do NOT start Phase C before Phase A is merged (Critical 1). B may precede or parallel A. D after C. F after A.

## Non-goals

- Phase E (reconciliation inline) — deferred, see above.
- Any change to the timeline/threading/feeds/moderation/local-history behavior beyond the explicit drops in the feature-preservation contract.
- Rewriting the sanitizer twins, auth, or the web UI beyond removing the dropped affordances (remote history page, "edited" marker, verified badge).

## Next

Roadmap → user review → begin **Phase A** as its own brainstorm→spec cycle
(lowest risk, unlocks C). Phases B/F can run in parallel sessions with
coordination. This document is the index the per-phase specs point back to.
