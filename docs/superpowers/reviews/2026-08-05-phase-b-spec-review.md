# Phase B spec review — Remove remote version-history

**Reviewed:** `docs/superpowers/specs/2026-08-05-phase-b-remove-remote-version-history-design.md`
(clean-context, against the real code). **Date:** 2026-08-05.

## Verdict

**Sound to plan from once two write-path mechanics are pinned first.** The
consumer trace is genuinely COMPLETE — I grepped the whole tree and no feed,
federation, SSE, DTO, threading, moderation, or visibility reader iterates more
than one observation version or presentation entry per delivery; the only
multi-row (chain) readers are exactly the three the spec names (the
`projectHistory` REMOTE branch `projector.ts:750-764`, the remote "edited"
marker, the admin item-detail versions list/count `store.ts:261,282`). The
under-stated load-bearing detail here is NOT a missed chain consumer — it is the
WRITE path the collapse depends on. Two DB `UNIQUE` constraints make the spec's
literal "overwrite in place + enqueue one job" throw on every content change
(Critical 1), and the "arrival/run in place" clause silently mutates the
durable first-arrival tuple that cross-delivery/cross-claim selection sorts on
(Important 2). Both must be resolved in the spec before `writing-plans`.
Everything else (migration ordering authority, survivor selection, verification
insert path) is basically right, with the caveats below.

## Findings

### Critical

**C1 — "Enqueue one reconciliation job" + "upsert one presentation entry" both hit `UNIQUE` under same-id overwrite. MUST-FIX-BEFORE-PLANNING.**
The spec (decision 1; footprint `acquisition.ts` bullet) says on a changed
fingerprint "UPDATE the delivery's single row in place ... enqueue one
reconciliation job ... No new row." But the in-place UPDATE keeps the same
`observation_versions_v2.id`, and:
- `reconciliation_jobs_v2.observation_version_id` is **`UNIQUE`** (`schema.ts:176`).
  The existing `insertJob` (`acquisition.ts:596`) INSERTs a job for that
  version id — a job already exists (status `reconciled`) — so a second INSERT
  throws `UNIQUE`. The forward path must **reset the delivery's existing
  observation job to `pending`** (a status UPDATE), not enqueue a new one, so
  `drainReconciliation` re-drives it.
- `presentation_entries_v2.observation_version_id` is **`UNIQUE`** (`schema.ts:98`).
  On re-reconcile, `applyPresentation` (`reconcile.ts:416`) INSERTs a new entry
  for `v.version_id` — that version already backs an entry — so it throws
  `UNIQUE` too. It must **UPDATE/upsert the single entry** for the delivery.

An implementer following the spec's wording literally produces two `UNIQUE`
violations on the first real edit. **Fix:** rewrite decision 1 / the
`acquisition.ts` + `reconcile.ts` bullets to say explicitly: overwrite the
version row in place, **reset its existing observation job to `pending`**, and
have `applyPresentation` **upsert the delivery's one presentation entry** (keyed
by `delivery_id`, not append a sequence). File refs: `acquisition.ts:595-596,667-674`,
`reconcile.ts:401-421`, `schema.ts:98,176`.

### Important

**I2 — In-place `arrival`/`run` overwrite mutates the durable first-arrival tuple that selection sorts on. MUST-ADDRESS-BEFORE-PLANNING.**
The footprint says UPDATE "(material, fingerprint, arrival, run) in place."
`compareFirstArrival` (`projector.ts:42`) keys on
`(acquisitionCommittedAt, runId, wireOrdinal, versionId)`, and `committed_at`
is derived by joining `acquisition_runs` on the **version's** `run_id`
(`reconcile.ts:242-246`, `projector.ts:309-311`). So:
- Overwrite `run_id` → the version's `committed_at` moves to change-time. That
  is needed to show a correct `updatedAt` (projectRemote reads the presentation
  entry's `effective_updated_at`, which `applyPresentation` sets from the run's
  `arrival`), BUT it also shifts the version's first-arrival tuple used by
  cross-delivery display selection (`selectDisplayDelivery`), cross-claim author
  selection (`selectAuthor`), and threading's `awaitedReference` ordering
  (`threading.ts:140-147`).
- NOT overwriting `run_id` keeps first-arrival stable but shows a stale
  `updatedAt` on the change.

You cannot have both with one mutable version row and the current run-join
derivations. In practice selection is mostly protected by the sticky
`selected_delivery_id`/`selected_publisher_id` hints (retained-when-eligible,
`projector.ts:77,100`), so the blast radius is narrow (multi-delivery items
where the hint lapses). The spec must (a) pick and state which columns overwrite,
and (b) require the plan to test that display-delivery/author stay stable across
an in-place change and that `updatedAt` reflects the change. Do not ship
"arrival, run in place" unqualified.

**I3 — Migration survivor = current-DISPLAY version, but the pre-migration BYLINE is chosen by EARLIEST arrival — so the collapse can move a byline. MUST-ACKNOWLEDGE.**
Spec migration step 3 asserts "the current display + author selection are
unchanged (survivor = current)." Display is fine, but **author selection is not
the same axis as display.** `selectAuthor` (`reconcile.ts:101`,
`projector.ts:101`) resolves ties by **earliest** arrival and returns the
earliest claim's `observationVersionId`; `itemAssertedName`
(`projector.ts:523-533`) then renders **that (earliest) version's** `<source>`
name. The live version cap deliberately keeps the FIRST version precisely to
hold that earliest byline (`acquisition.ts:604-609`). The migration deletes the
non-survivor (earliest) versions + their `publisher_claims_v2`/`publisher_names_v2`
rows, leaving only the survivor (latest) claim, so the rendered byline shifts to
the latest `<source>` name for any item whose publisher name changed across
versions. Narrow in practice (per-item `<source>` name rarely changes across a
delivery's versions) and it is CONSISTENT with the new current-only model, but
it is not "unchanged." **Fix:** either preserve the earliest-arrival
claim/name for the survivor delivery, or rewrite step 3 to acknowledge the
one-time byline realignment to current.

**I4 — Verification (KEPT) is a SECOND version inserter; "already fits one-per-delivery" is only mostly true. MUST-ADDRESS.**
`persistVerifiedDelivery` (`verification.ts:349-383`) resolves-or-creates a
version by `(delivery_id, fingerprint_version, fingerprint)` and, when origin
material has changed since a prior batch persisted it, **INSERTs a second
version** for that already-verified delivery (comment at `:334-338` says exactly
this). The "one observation version per delivery" invariant is NOT DB-enforced
(the only `UNIQUE` is on the fingerprint triple), so leaving verification
"untouched" lets a verified delivery still grow a short chain — which would
break the spec's own "exactly ONE observation_versions_v2 row" acceptance test
if applied to verified deliveries. **Fix:** either apply the same
overwrite-in-place to `persistVerifiedDelivery`'s changed-material branch, or
scope the one-row invariant/acceptance test to acquisition-origin deliveries and
say so. Note the shared `applyPresentation` upsert change (C1) must keep
verification's call at `verification.ts:382` working (it will: fresh delivery,
upsert = sequence-0 insert).

### Minor

**M5 — Preserve the explicit-watermark rollback guard when upserting the single presentation entry.**
`nextPresentationEntry` (`projector.ts:213-233`) refuses content whose explicit
`<updated>` is older-or-equal to the delivery's `MAX(effective_updated_at)`
watermark (`reconcile.ts:403`), returning `conflict:'rollback'` and writing no
entry. When `applyPresentation` collapses to one upserted entry, keep that
comparison (don't blind-overwrite), or a publisher decrementing `<updated>` can
roll displayed content backwards.

**M6 — `REMOTE_VISIBLE` blinks during the reset-to-`pending` window.**
`REMOTE_VISIBLE` (`projector.ts:663`) requires a `reconciled`/`conflicted` job
on the delivery. Resetting the single job to `pending` (C1) makes the item
briefly non-visible until `drainReconciliation` re-reconciles it — which runs
synchronously in the same `acquireSource` call (`runtime.ts:397-398,425`),
albeit in a separate write transaction. Practically invisible; call it out and
keep the drain-after-commit ordering.

**M7 — Migration must define the "delivery with versions but no presentation entry" case.**
A delivery whose jobs never reconciled (all `pending`/`failed`) has no
top-sequence entry, so "survivor = version backing current display" selects
nothing. Spec should say: leave such deliveries untouched (they are not
ordinary-visible anyway) so the migration stays idempotent and throws no
RESTRICT.

**M8 — `logical_conflicts_v2` is admin-audit-only; note the intentional drop.**
Grep confirms no projector/threading/visibility reader of conflicts — only
`store.ts` admin detail (`:263,294,299,607`) reads them; everything else
DELETEs. Collapsing deletes conflict rows on doomed versions; nothing
load-bearing consumes them (answers task Q6: no lost projector-visible conflict
state). Worth one sentence in the spec that superseded-version conflict evidence
is intentionally dropped.

**M9 — Overwriting `version.run_id` strands `reconciliation_jobs_v2.run_id` on the prior run.**
`job.run_id` is only used for delete-scoping (`tombstones.ts:121`), so this is
harmless bookkeeping drift, but the reset path should decide whether to also
refresh `job.run_id`.

### Nit

**N10 — `convert.ts` still writes multi-entry chains, but only over zero legacy rows on fresh installs** (roadmap: converter is live on the fresh-install path). Not load-bearing for Phase B; leaving it is fine — mention for footprint completeness.

## Correct-as-written / footprint complete for these

- **Consumer trace is COMPLETE.** The three named chain consumers
  (`projectHistory` REMOTE branch `projector.ts:750-764`, remote "edited"
  marker, admin versions list/count `store.ts:261,282`) are the only multi-row
  readers. No feed (RSS/Atom/JSON), federation output, SSE journal, DTO,
  threading, moderation, or `REMOTE_VISIBLE` path reads more than one version /
  presentation entry per delivery. `threading.ts:140-147` and every projector
  selection reader take exactly ONE (earliest) version.
- **Critical 2 (FK-RESTRICT delete order) is correctly delegated.**
  `deleteObservationVersions` (`tombstones.ts:205-215`) is the right ordering
  authority: it deletes all four RESTRICT children in order —
  `reconciliation_jobs_v2`, `presentation_entries_v2` (UNIQUE+RESTRICT),
  `publisher_claims_v2`, `logical_conflicts_v2` — plus `publisher_names_v2`
  (which is a plain column, not an FK, `schema.ts:48`) before the versions.
  Reusing it for the migration is sound and idempotent (a second run finds no
  non-survivors → no-op).
- **Survivor = top-sequence presentation entry's version is unambiguous.**
  `presentation_entries_v2.observation_version_id` is UNIQUE, so each version
  backs ≤1 entry and the top entry maps to exactly one survivor.
- **FKs stay valid under same-id overwrite** (Q2): the spec is explicit ("No new
  row", "in place"), so `presentation_entries_v2`/`publisher_claims_v2`/
  `logical_conflicts_v2`/`reconciliation_jobs_v2` references remain valid. The
  only ambiguity is the JOB semantics (C1), not the id.
- **Keeping verification, `post_revisions`, `REMOTE_VISIBLE`, threading,
  moderation, feeds, SSE untouched** is the right scope; none of them read the
  version chain.
