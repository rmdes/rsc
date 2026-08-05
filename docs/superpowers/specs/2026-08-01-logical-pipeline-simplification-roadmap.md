# Logical Pipeline Simplification — Program Roadmap

**Status:** Roadmap rev 4 (2026-08-05). **Phase B DONE (merged). Phase C AND
Phase D both DROPPED — for the same reason: they'd remove machinery the KEPT
verification feature depends on.** Phase C footprint review found verification
is the discovery-and-mint engine for the instance-governed-members federation
feature (`membership.ts`; `verification.ts:268/302` mints `origin_verification`
member sources). **Phase D brainstorm (2026-08-05) then found the publisher
attribution graph is 3/4 load-bearing for that same kept engine:** verification
mints `verified_origin` claims into `publisher_claims_v2` (verification.ts:414)
and alias bindings into `publisher_feed_aliases_v2` (verification.ts:443), both
FK→`remote_publishers_v2`; and `selectAuthor`'s evidence ranking is *how a
verified claim wins the byline* (the feature's visible payoff). Only
`publisher_names_v2` (the byline display-name) was verification-free — and the
byline-preservation bar was set to **keep today's behavior exactly** (the
cross-source name-fill must survive), so it stays too. Nothing removable.
Audit findings #1 and #3 were both wrong the same way, and are corrected in
place. Program's only remaining cut: **F** (+ optional A′). (Rev 2
had folded the roadmap review's 2 Criticals — converter not dead, C≠dependent-on-A;
both now moot since C is dropped.) This is a **program**, not a
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
- ~~C:~~ **(dropped — verification stays)** `verified_origin` and the whole
  origin-verification subsystem are KEPT: it is the engine of instance-governed-
  members. Nothing here is dropped by removing verification, because verification
  is not being removed.
- **D:** possibly cross-source author *merge* (same author via multiple feeds →
  one byline). The precise byline behavior that must survive is **Phase D's own
  brainstorm**; the roadmap commits only that a working byline stays.

## Phase sequence (dependency- and risk-ordered)

> **Roadmap-review correction (2026-08-01, `…-simplification-roadmap-review.md`,
> both Criticals verified in code):** the original "retire the dead converter as
> Phase A to unlock C" premise was WRONG on both counts.
> (1) `core/src/migration/convert.ts` is **NOT dead code** — `runtime.ts:248`
> carries a "LIVE ON THE FRESH-INSTALL PATH — do not retire" warning:
> `runConversion` runs on every brand-new install's first boot
> (`never_activated`, over zero legacy rows), guarded by
> `core/test/fresh-install.test.ts`. (2) `logical_activation_v2` is the **live
> v2 activation-state singleton** (read/written every boot, `runtime.ts:189/221`);
> only its `converted_at`/`conversion_findings_json` columns are bookkeeping —
> the table must never be dropped.
> **Crucially, C never needed A:** `convert.ts`'s only tie to `verification.ts`
> is the `EMPTY_COUNTERS` JSON constant (`verification.ts:239`, twin of
> `ZERO_COUNTERS`). **Relocating that one constant** (a trivial prep step folded
> into Phase C) removes the dependency — Critical 1 dissolves without touching
> the converter. So Phase C is independent and can lead.

Rev 3: **B is the lead phase** (C dropped). The old "Phase A" is demoted to an
optional, re-scoped startup simplification (A′).

| Phase | Cut (audit ref) | Depends on | Risk |
|---|---|---|---|
| ~~**C**~~ | ~~Remove origin verification~~ — **DROPPED, verification is earned** (instance-governed-members engine) | — | — |
| **B** | Remove remote version-history (audit #2; parked §1–4) | — (independent) | Medium (live version-collapse migration) |
| ~~**D**~~ | ~~Simplify the publisher attribution graph (audit #3)~~ — **DROPPED (2026-08-05 brainstorm)**: 3/4 publisher tables + `selectAuthor` ranking are load-bearing for kept verification; the only free table (`publisher_names_v2`) stays because the byline bar was set to preserve today's behavior. Nothing removable. | — | — |
| **F** | Consolidate thin tables (audit #5) | — | Low (cleanup) |
| **A′** | *(optional, later)* Simplify the fresh-install activation path — collapse the zero-row conversion, drop ONLY the `converted_at`/`conversion_findings_json` columns; keep the `logical_activation_v2` table + `fresh-install.test.ts` green | — | Medium (startup-path refactor, NOT dead-code removal) |

C and B are independent and may run in either order / in parallel sessions with
coordination. D is cleanest after C. F any time. A′ is optional and no longer
gates anything — do it only if the modest fresh-install-path win is judged worth
a startup refactor.

**Deferred — NOT in this program:** Phase E (reconciliation async→inline, audit
#4). It touches the spine's concurrency model and the async queue may enable
cross-source ordering federation relies on. Revisit as a separately-decided
item once the tree is smaller and clearer; it is explicitly out of scope here.

## The 5 Criticals — mapped to the phase that must fold them

From the parked spec's 2-lens review (must be folded into the owning phase's spec):
1. **Converter dependency** — deleting `verification.ts` breaks `convert.ts` (`EMPTY_COUNTERS` import, `verification.ts:239`). → **Owned by Phase C, as a trivial prep step:** relocate `EMPTY_COUNTERS` (twin of `ZERO_COUNTERS`) to a neutral module (e.g. alongside `ZERO_COUNTERS` or a shared counters constant), so `convert.ts` no longer imports `verification.ts`. Phase A is NOT involved (the converter is not being retired). Firehose confirmed NOT a consumer of any removed structure (emits `origin='local'` only, `logical-routes.ts:740`).
2. **FK-RESTRICT delete order** — the version-collapse cannot "rewire" FKs; it must DELETE children in dependency order (`presentation_entries_v2` is UNIQUE + RESTRICT; also `publisher_claims_v2`, `logical_conflicts_v2`, `reconciliation_jobs_v2`). → **Owned by Phase B** (the migration is its central, most-tested task).
3. **Live `verified_origin` rows** — existing `evidence_level='verified_origin'` claim rows feed `undefined` into the author comparator once the rung is removed. → **Owned by Phase C** (migrate/collapse those rows before narrowing the comparator).
4. **Under-removed footprint** — the parked removal missed `reconcile.ts` / `store.ts` / `tombstones.ts` / web + enum members. → **Owned by Phases B & C** (each phase's clean-context spec + plan reviews enumerate the full footprint before SDD).
5. **Survivor-selection / "show latest"** — the version collapse must pick the row backing the current display presentation and emit the correct ordinary journal upsert (SSE refresh, no "edited" semantic). → **Owned by Phase B**.

## Per-phase briefs (each expands into its own spec)

**Phase A′ — Simplify the fresh-install activation path (optional, later).**
The converter is NOT dead — it runs on every fresh install's first boot over
zero legacy rows (`runtime.ts:248` warning; `fresh-install.test.ts` guard). The
only real simplification here is to collapse that zero-row conversion so a brand-
new install initializes v2 activation directly instead of running the full
preflight+convert machinery over nothing, and to drop ONLY the two bookkeeping
columns (`converted_at`, `conversion_findings_json`) — **never** the
`logical_activation_v2` table (it's the live activation-state singleton). Keep
`fresh-install.test.ts` green. This is a startup-path refactor (Medium risk),
modest win, and gates nothing — do it last, or not at all.

**Phase B — Remote items become current-only.** Per parked spec §1–5: one current observation per delivery; on a real change, overwrite in place + one reconciliation job + the ordinary "updated" journal effect; remove the remote `/post/[id]/history` route and the remote "edited" marker; keep the (already-fixed) change-detection fingerprint. Central task = the version-collapse migration (Criticals 2 & 5). Keep `post_revisions` untouched.

**Phase C — Remove origin verification (independent lead phase).** Prep step
first: relocate `EMPTY_COUNTERS` out of `verification.ts` so `convert.ts` no
longer imports it (dissolves Critical 1). Then delete `verification.ts` +
`createVerificationRunner` + `verification_checks_v2` + the `'verification'`
reconciliation-job kind + `verification_batch_key` + the `verified_origin`
comparator rung + runtime/scheduler `drainVerification` wiring + the two
reap-protection reads (`source-repository.ts:264`, `sqlite.ts:617`), which fall
back to the existing `admin_retained` flag (confirmed present). Migrate live
`evidence_level='verified_origin'` claim rows down to the next evidence level
FIRST (Critical 3), or the comparator gets `undefined`. Also sweep the
under-removed footprint (Critical 4: `reconcile.ts`, `store.ts`, `tombstones.ts`,
web, enum members). Independent — no dependency on any other phase.

**Phase D — Simplify the publisher attribution graph — DROPPED (2026-08-05 brainstorm).** Audit #3 proposed removing the 4 publisher tables (`publisher_claims_v2`, `publisher_names_v2`, `remote_publishers_v2`, `publisher_feed_aliases_v2`) + the projector's `selectAuthor`/evidence-ranking (~300 LOC). The brainstorm's producer/consumer trace found this premise wrong (the Phase C lesson again): **verification (kept) mints `verified_origin` claims into `publisher_claims_v2` (verification.ts:414-416) and alias bindings into `publisher_feed_aliases_v2` (verification.ts:435-443), both FK→`remote_publishers_v2`; and `selectAuthor`'s `LEVEL_RANK` is how a verified claim wins the byline** — the instance-governed-members feature's visible payoff. Only `publisher_names_v2` (the byline display-name + its cross-source name-fill) was verification-free. The byline-preservation bar was set to **keep today's behavior exactly**, so the cross-source name-fill must survive and that table stays too. Net removable: **nothing**. Phase D dropped; audit #3 corrected in place.

**Phase F — Consolidate thin tables.** Audit #5: fold the three tombstone flavors (`blocked_source_tombstones_v2`, `tombstone_aliases_v2`, `handle_reservations_v2`) where they overlap; drop `policy_fanout_v2` / migration bookkeeping if unreferenced post-A; keep cheap real ones (`source_validators_v2` conditional-fetch). Low-risk cleanup, last.

## Cross-cutting execution rules

- **Each phase is independent:** its own brainstorm→spec→(clean-context spec review)→writing-plans→(clean-context plan review)→subagent-driven-development→whole-branch review→independent deploy. No phase blocks on a later one.
- **Shared checkout / parallel sessions.** Parallel sessions actively work in `core/src/logical/*`. Each phase must coordinate before SDD (it removes tables/columns/enum members other in-flight work may assume). Stage explicit paths; never `git add -A`.
- **Forward-only migrations, backup-before-flip** (RUNNING.md posture) for B, D (F if it drops tables). A′ is a startup-path refactor (no data migration).
- **Completion gate per phase:** core Vitest, `tsc`, web Vitest, `svelte-check`, web build — all green before deploy.
- **Sequencing gate:** B is the independent lead; D and F are independent too (D keeps the `verified_origin` rung). A′ optional, last, gates nothing.

## Non-goals

- **Removing origin verification** — it's the instance-governed-members engine (earned). Phase C dropped.
- **Simplifying the publisher attribution graph** — 3/4 tables + `selectAuthor` ranking are load-bearing for that same kept verification engine; the 4th (`publisher_names_v2`) stays under the "keep byline behavior exactly" bar. Phase D dropped.
- Phase E (reconciliation inline) — deferred, see above.
- Any change to the timeline/threading/feeds/moderation/local-history behavior beyond the explicit drops in the feature-preservation contract.
- Rewriting the sanitizer twins, auth, or the web UI beyond removing the dropped affordances (remote history page, "edited" marker).

## Next

Roadmap (rev 4): **B done, C + D dropped.** The only remaining cut is
**Phase F** (consolidate thin tables — audit #5), its own brainstorm→spec→
plan→SDD cycle. A′ optional, last, gates nothing. This document is the index
the per-phase specs point back to.
