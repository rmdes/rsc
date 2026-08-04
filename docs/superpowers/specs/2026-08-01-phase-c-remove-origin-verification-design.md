# Phase C — Remove Origin Verification (design)

**Status:** ⛔ WITHDRAWN 2026-08-04. The footprint review (done inline after the
review subagent hit a usage limit) found that origin verification is **not
unearned** — it is the discovery-and-mint engine for the **instance-governed-
members** federation feature: on a verification containment match,
`resolveVerificationBatch`→`persistVerifiedDelivery`→`findOrCreateOriginSource`
(`verification.ts:268/302`) MINTS a per-publisher `provenance='origin_verification'`
source that nests under its asserting aggregate instance and inherits its
governance (`membership.ts`, the admin "member" nesting UI). The mint is coupled
to the async check — you cannot keep the feature without the subsystem. Removing
it would DELETE a real governed-federation feature, violating the program's
"preserve federation / essentially same service" contract. **The audit's
finding #1 was wrong** (it saw only the reap guard + author tiebreak, missing the
mint/membership engine). Phase C is dropped; verification is kept. The
simplification program refocuses on the genuinely-unearned cuts (B/D/F). This doc
is retained as a record of why verification stays. See the corrected audit +
roadmap rev 3.

---

*(original draft below, superseded)*

**Goal:** Delete the origin-verification subsystem and the `verified_origin`
evidence level entirely, preserving all user-facing features. Attribution keeps
its three natural evidence levels; the publisher/claim graph is otherwise
untouched (Phase D simplifies that later).

## Background

Origin verification (`verification.ts`, 417 LOC + `verification_checks_v2` + a
reconciliation-job kind + an async runner + the `verified_origin` evidence rung)
exists to prove a claimed origin by fetching the live feed — an anti-byline-
spoofing signal for aggregate firehoses. Its entire consumed output is two
things, both being removed here:
- an author-selection tiebreak (`verified_origin` = rank 0 in the projector's
  `LEVEL_RANK`); and
- a source-reap guard (`source-repository.ts:265`, `sqlite.ts:617`).

The audit and the parked spec (`2026-07-31-remote-content-simplification-design.md`
§5) both flag it as unearned; the maintainer's decision (2026-07-31) is to remove
it entirely. The retention/version-churn incidents it was entangled with are
already fixed (`00bc235`, Phase 1).

## Decisions locked

1. **Remove the origin-verification subsystem entirely** (subsystem + table +
   job kind + async runner + evidence rung).
2. **Drop the `verified_origin` reap guard outright — NO `admin_retained`
   migration.** Rationale: the guard (`source-repository.ts:262-265`) protects a
   source *because its deliveries are current verification evidence*; once
   verification is gone, that reason evaporates. Auto-flipping `admin_retained`
   would fabricate an admin decision nobody made and pollute that flag's meaning.
   The only behavior change is that an orphaned-*and*-verified source (a set that
   is realistically empty — verified sources are subscribed/federated, not
   orphans) would be auto-cleaned like any other orphan, which is correct.
3. **Attribution keeps its three natural levels** — the publisher/claim graph is
   otherwise intact; Phase D owns simplifying it.

## Prep — relocate `EMPTY_COUNTERS` (dissolves roadmap Critical 1)

`core/src/migration/convert.ts:9` is the only non-verification importer of
`verification.ts`, and only for the `EMPTY_COUNTERS` JSON constant
(`verification.ts:239`, the twin of `ZERO_COUNTERS` at `acquisition.ts:461`).
Move `EMPTY_COUNTERS` to a neutral home (alongside `ZERO_COUNTERS` in
`acquisition.ts`, or a small shared constants module) and repoint `convert.ts`'s
import. After this, `verification.ts` has no importers outside the verification
subsystem itself → it becomes freely deletable. `convert.ts` and the fresh-
install path are otherwise untouched (they are NOT being retired — see roadmap A′).

## Removal footprint

**Core:**
- Delete `core/src/logical/verification.ts` (`createVerificationRunner`,
  `scheduleVerification`, `resolveVerificationBatch`, `persistVerifiedDelivery`,
  `EMPTY_COUNTERS` after relocation).
- Remove importers/callers (roadmap Critical 4 "under-removed" sweep):
  - `reconcile.ts:8` `scheduleVerification` import + its call site (where reconcile
    schedules verification after creating an item).
  - `store.ts:17` `scheduleVerification`, `resolveVerificationBatch` imports + uses.
  - `runtime.ts:17` `createVerificationRunner` + the `drainVerification` wiring
    (remove the dep entirely — do NOT make it optional; the required-not-optional
    pattern was a no-op guard, so deletion is correct).
  - `scheduler.ts` `drainVerification` dep + call site.
- Schema: drop `verification_checks_v2` + its index (`schema.ts`); narrow
  `reconciliation_jobs_v2.kind` CHECK to `'observation'` only; remove the
  `verification_batch_key` column and its paired CHECK.
- `EvidenceLevel` (`projector.ts:16`): remove `'verified_origin'`; `LEVEL_RANK`
  becomes the original three (`bound_single_publisher`=0, `aggregate_assertion`=1,
  `source_scoped_fallback`=2). Remove the `verified_origin` rung comment/handling.
- Reap guard: delete the `hasVerifiedOrigin` check (`source-repository.ts:262-265`),
  the `'verified_origin_evidence'` member of `ReapResult['reason']`
  (`source-repository.ts:238`), and the mirror in `sqlite.ts:617`.

**Web:**
- Remove any `verified_origin` / `verified-origin evidence` affordance in the
  admin feeds view (surfaced in `feeds.render.test.ts` as a retention reason) and
  the corresponding reason label/badge.

## Migration (forward-only, 4 live instances) — folds Critical 3

Additive/destructive, in one migration, IN THIS ORDER:
1. **Re-level live `verified_origin` claim rows FIRST** (Critical 3):
   `UPDATE publisher_claims_v2 SET evidence_level = CASE WHEN <source is aggregate>
   THEN 'aggregate_assertion' ELSE 'bound_single_publisher' END WHERE
   evidence_level = 'verified_origin'` — join to `remote_sources_v2.attribution_mode`,
   matching `reconcile.ts:225`'s base-level logic. This must run before the enum/
   CHECK narrows, or the comparator would read an `evidence_level` no longer in
   `LEVEL_RANK` → `undefined`.
2. Delete `reconciliation_jobs_v2` rows with `kind='verification'`, then narrow
   the `kind` CHECK and drop `verification_batch_key`.
3. Drop `verification_checks_v2`.
- `post_revisions`, the local path, threading, moderation, deliveries, the
  timeline query: untouched. Backup-before-flip (RUNNING.md posture); forward-only.

## Preserved (explicit non-goals of removal)

Timeline (local + remote), threading/conversations, feeds (RSS/Atom/JSON +
comments), SSE journal, moderation/`hidden` durability, governance/federation/
source-audit, local `post_revisions`, the retention age gate (Phase 1), the
public firehose (confirmed emits `origin='local'` only — not a consumer of
verification, `logical-routes.ts:740`), the publisher/claim graph minus the
verified rung (Phase D owns the rest), sanitizer, no-JS.

## Testing / acceptance

- **Verification gone:** no `verification_checks_v2`, no `kind='verification'`
  jobs, `EvidenceLevel` is three-level, startup + scheduler run with no
  verification drain, `verification.ts` deleted.
- **Comparator sound after re-level:** an item whose author claim was
  `verified_origin` still resolves an author (now at its natural level) — no
  `undefined`, byline unchanged in the common single-publisher case.
- **Reap behavior:** a formerly verified-origin source is reapable by the normal
  guard chain (subscribers/federation/admin_retained/audit_history still enforced);
  no `verified_origin_evidence` refusal reason remains.
- **`EMPTY_COUNTERS` relocation:** `convert.ts` + the fresh-install path
  (`fresh-install.test.ts`) stay green; `verification.ts` has no external importer.
- **Migration idempotence + order:** re-level runs before the CHECK narrows; a
  re-run is a no-op.
- **Regression:** feeds/threading/visibility/moderation green; the projector
  `REMOTE_VISIBLE` path unaffected.
- **Completion gate:** core Vitest, `tsc`, web Vitest, `svelte-check`, web build.

## Risks & coordination

- **Deployed to 4 instances** with live `verified_origin` rows — the re-level
  migration is the sharp edge; backup-before-flip is the only rollback.
- **Shared checkout / parallel sessions** actively work in `core/src/logical/*`;
  this removes tables/columns/enum members other in-flight work may assume.
  Coordinate before SDD. Stage explicit paths; never `git add -A`.
- Independent of Phases A′/B/F; do not block on them.

## Sequencing

Spec → clean-context spec review (fold as revs) → `writing-plans` → clean-context
plan review → `subagent-driven-development` with a whole-branch review →
independent deploy. No code authorized by this document.
