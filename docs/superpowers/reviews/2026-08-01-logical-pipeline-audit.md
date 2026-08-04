# Logical Pipeline — Over-Engineering Audit (ponytail-audit)

**Scope:** `core/src/logical/` (7,176 LOC / 19 files) + its ~36 `_v2` tables.
**Method:** ponytail-audit — over-engineering only (not correctness/security/perf).
Ranked biggest cut first. Findings are candidates; each real cut is its own
brainstorm→spec, because blast radius here is large and tangled.

## The headline

**~36 tables and 7.2k LOC to do "fetch RSS, dedupe by id, show a timeline,
thread replies over RSS."** A plain reader is: `deliveries` (seen items) +
timeline query. Everything past that exists for one of three real goals —
cross-source dedup, cross-instance threading/attribution, moderation/governance —
or for two goals that **aren't earning their keep**: *origin verification* and
*remote-item version history*. Those two are the user-flagged "unearned
complexity," and the read-site evidence confirms it: they produce signals almost
nothing consumes.

## Findings (biggest cut first)

1. ⛔ **CORRECTED 2026-08-04 — THIS FINDING WAS WRONG; verification is EARNED, do NOT cut it.** Deeper footprint analysis (Phase C spec review) found origin verification is the discovery-and-mint engine for the **instance-governed-members** federation feature: a verification containment match MINTS a per-publisher `origin_verification` source that nests under its aggregate instance and inherits governance (`membership.ts`; `verification.ts:268/302`). The two heuristics below are real but are NOT its whole output — the mint/membership engine is. Removing it deletes a governed-federation feature. Finding withdrawn; Phase C dropped. The rest of this finding (below) stands only as the mistaken original.

   *(original, mistaken finding follows)* `delete:` **Origin-verification subsystem** — `verification.ts` (417) + the
   `verification_checks_v2` table + the `'verification'` reconciliation-job kind
   + `scheduleVerification`/`resolveVerificationBatch` + the async
   `verificationRunner` drain in `runtime.ts` + the `verified_origin` author-rung
   in `projector.ts`. **Its entire output is two minor heuristics:** (a) "don't
   reap a source that has a verified origin" (`source-repository.ts:264`,
   `sqlite.ts:617`) and (b) an author-selection tiebreak (`projector.ts` rung 0).
   Replacement: drop the rung; replace the reap-protection with the simpler
   admin-retained flag that already exists. **~550 LOC + 1 table + 1 job kind + a
   whole async runner.** ⚠️ Tangle: the migration converter references
   `verification.ts` (flagged Critical in `2026-07-31-...review.md`) — the cut
   must neutralize the converter's use first. Biggest single cut in the tree.

2. `delete:` **Remote-item version *history*** (NOT change-detection) — the
   observation-version *chain*: the `/post/[id]/history` page (web) +
   `projector.ts` `currentSequence`/chain logic (~479-762) + the per-delivery
   multi-version retention (the `MAX_VERSIONS_PER_DELIVERY = 5` cap we just
   added, `findVictims`, `deleteObservationVersions`). Feed items don't need a
   revision timeline; the user's intent was version history for *local* posts
   (`post_revisions`, untouched). Replacement: keep exactly ONE current
   observation per delivery for change-detection (fingerprint compare); drop the
   chain, the history page, and the version cap (which only exists to bound a
   history nobody reads). **~250 LOC + collapses `observation_versions_v2` to
   one-row-per-delivery.** Low tangle (change-detection keeps working on the
   single row).

3. `yagni:` **Publisher attribution graph** — `publisher_claims_v2`,
   `publisher_names_v2`, `remote_publishers_v2`, `publisher_feed_aliases_v2`
   (4 tables) + the projector's `selectAuthor`/`eligibleAuthorClaims`/evidence-
   level ranking (~248-525). This is a claims-and-evidence identity graph to
   attribute a feed item to a canonical publisher across sources. For the actual
   product (a byline: "@handle" or the feed's title) this is heavier than needed.
   Replacement: derive the byline from the delivery's source + the item's
   author field directly. **~300 LOC + 4 tables.** ⚠️ Medium tangle: byline
   rules + cross-source author merge are a real (if minor) feature — needs a
   spec to decide what attribution actually must survive.

4. `shrink:` **Reconciliation as a global async job queue** —
   `reconciliation_jobs_v2` + the claim/drain/orphan-work machinery
   (`store.ts` large parts, `runtime.ts` drains, `orphan_work_v2`). Ingestion
   writes an observation, then a *separate async job* later builds the
   `logical_item`. For a single-node reader this can be inline at commit.
   Replacement: reconcile inline in `commitAcquisition` for the common case;
   keep async only if cross-source ordering genuinely needs it. ⚠️ High tangle
   (the spine's concurrency model) — biggest LOC but riskiest; spec-only.

5. `yagni:` **Thin single-purpose tables** worth individually questioning:
   `redirect_observations_v2` (store every redirect hop — needed?),
   `source_validators_v2` (conditional-fetch ETags — keep, it's cheap and real),
   `handle_reservations_v2` + `tombstone_aliases_v2` + `blocked_source_tombstones_v2`
   (three tombstone flavors — could be one), `policy_fanout_v2`,
   `logical_activation_v2` (V4 migration bookkeeping — dead once migration is
   retired). Each is small; collectively a table-count and mental-model tax.

## Earned — do NOT cut

- `deliveries_v2` + the timeline query + `presentation_entries_v2` — the actual reader.
- Change-detection fingerprint (`canonicalMaterialFor`) — one row per delivery is enough.
- Threading (`threading.ts`, `parent_state`, reply resolution) — the product's whole point (conversations over RSS).
- Governance/moderation/federation (`remote_sources_v2`, `federation_relationships_v2`, `source_audit_v2`, `moderation.ts`) — real, admin-facing, in use.
- `journal_v2` + SSE — the live-timeline delivery mechanism.
- Retention age gate (just shipped) — the loop-breaker.

## Net & sequencing

**net: ~-1,100 LOC and -6 tables plausible** (verification ~550 + version-history
~250 + publisher-graph ~300, plus table drops), before any reconciliation-inline
shrink (which could be far larger but is the riskiest).

**Recommended order (low blast radius → high):**
1. **Version history (finding 2)** first — lowest tangle, immediate simplification, and it retires the version-cap complexity we just added.
2. **Origin verification (finding 1)** — biggest single cut; must sequence the migration-converter detangle first.
3. **Publisher graph (finding 3)** — needs a byline spec.
4. **Reconciliation-inline (finding 4)** — only if the audit-of-the-audit says cross-source ordering isn't load-bearing; highest risk, spec + heavy review.

Each is a brainstorm→spec→plan→SDD of its own. This report identifies; it changes nothing.
