# Fix: Instance-Governed Members Reaped As Orphans (+ recovery) — Design

**Status:** Rev 1 (2026-08-06). Root-caused via systematic-debugging against a
live instance (evidence below). Widespread: reproduces on most deployed RSC
instances (member counts decay to 0). Authorizes no code (→ clean-context spec
review → plan).

## Problem

An approved **aggregate** federation source (e.g. `https://rsc.rmdes.be/users/rss.xml`)
shows **0 members · 0 instance-governed** in `/admin/feeds`, even though the
instance has users whose per-user origin feeds should appear as members. Member
counts start correct and **decay to 0 over time** on every instance.

## Root cause (three-subsystem interaction)

The instance-governed-members feature (verification mints per-publisher
`origin_verification` sources nested under an approved aggregate) works — but the
minted members are silently deleted and never regenerate:

1. **Mint:** verification containment-matches an aggregate item against its origin
   feed (`normalized_json.originFeedUrl`), then `findOrCreateOriginSource` mints
   the member source and `persistVerifiedDelivery` writes its **only** protection:
   a `verified_origin` `publisher_claims_v2` row (`source_id = member`,
   `observation_version_id = <that item's version>`), and marks the
   `verification_checks_v2` row `state='verified'`.
2. **Protection is version-scoped and fragile:** `reapSource`
   (`source-repository.ts:264`) refuses to reap a source only if
   `SELECT 1 FROM publisher_claims_v2 WHERE source_id=? AND evidence_level='verified_origin'`
   exists. It checks **nothing about provenance or membership.**
3. **Retention/collapse deletes the claim:** as the aggregate's content ages,
   retention trims / the Phase-B collapse cascade delete observation versions and
   their claims (`removeSourceEvidence`, `tombstones.ts:126`:
   `DELETE FROM publisher_claims_v2 WHERE … observation_version_id IN <deleted>`).
   The member's `verified_origin` claim goes with them.
4. **Member becomes an indistinguishable orphan:** a member inherently has **0
   subscribers, 0 direct deliveries** (items arrive via the aggregate),
   `governance='allowed'`, and **no `federation_relationships_v2` row**. With its
   claim gone, every `reapSource` guard passes → `reapSourceIfOrphaned` (fired on
   unsubscribe, account deletion, and cleanup sweeps — `local.ts:268`,
   `sqlite.ts:401/1010`) **deletes it** (`tombstones.ts:181`).
5. **No regeneration:** the `verification_checks_v2` row stays `state='verified'`,
   and `resolveVerificationBatch` (`verification.ts:254`) only re-processes checks
   in `pending`/`unverified` → the member **never re-mints**.

**Evidence (live DB):** 100 `verification_checks` all `state='verified'` (86
current `rsc.rmdes.be` + 14 legacy `textcaster.app` permalinks); **all 19 distinct
origin-feed source rows those checks minted are missing**; **0 `origin_verification`
sources and 0 `verified_origin` claims DB-wide**; 60 verification jobs `reconciled`
(fetched the per-user feeds fine); `memberCounts`/`MEMBER_RANGE_SQL` is correct —
there is genuinely nothing to count.

## Goal

**Prevention + full recovery** (both decided):
1. Members stop being reaped, protected by their **membership**, not a transient
   claim.
2. Members already lost on existing instances re-mint immediately via a one-time
   boot heal that resets the stranded checks and lets the real verification path
   re-mint.

## Part 1 — Prevention: membership reap-guard

In `reapSource` (`core/src/domain/source-repository.ts`), add one guard, gated on
`!opts.force` (identical posture to the existing `admin_retained` / `audit_history`
/ `verified_origin_evidence` guards):

- **Refuse to reap a source that is a current member of an approved federated
  instance:** `provenance = 'origin_verification'` AND
  `approvedInstanceFor(tx, canonical_url) != null` (the same predicate
  `MEMBER_RANGE_SQL` / `memberCounts` already use). New `ReapResult` refused
  reason: **`'instance_member'`**.
- `reapSource`'s source `SELECT` must also read `canonical_url` and `provenance`
  (currently only `governance, admin_retained`).
- **Revoked/quarantined instance = correct cleanup for free:** `approvedInstanceFor`
  is live-computed against `isApprovedFederatedInstance`; if federation is revoked
  the member is no longer covered → becomes reapable. No extra code.
- **`force=true` still reaps** a member (operator override), like the other
  `!force` guards.
- **Keep** the existing `verified_origin_evidence` guard (complementary evidence-
  retention protection, spec §2.4/§7).
- Surface `'instance_member'` wherever reap reasons are returned to the admin
  (the `ReapResult` union + `ReapCommandResult` mapping + any UI copy).

## Part 2 — Recovery: one-time boot heal

A **version-gated imperative heal** (same pattern as `collapseVersionHistory` /
`healMembers` in `core/src/storage/sqlite.ts`: run once, gated by a schema-version
marker `MIGRATIONS` entry):

- **Identify stranded state:** `verification_checks_v2` rows with `state='verified'`
  whose `batch_key` has **no** matching `remote_sources_v2` row
  (`canonical_url = batch_key`) — i.e. the minted member is gone.
- **Reset:** those checks → `state='pending'`, `resolved_at=NULL`; and re-pend
  their verification jobs (`reconciliation_jobs_v2` `kind='verification'`,
  `verification_batch_key IN <those batch_keys>`): `status='pending'`,
  `attempts=0`, `next_attempt_at=now`, `failure_category=NULL`, `diagnostic=NULL`.
- The normal verification drain then re-fetches each origin feed and re-mints via
  the real path (`resolveVerificationBatch` → `findOrCreateOriginSource` →
  `persistVerifiedDelivery`), now protected by Part 1.
- **Self-correcting:** an author whose post is no longer in their origin feed
  correctly won't re-mint (fresh containment check).
- **Idempotent / one-time:** version-gated, so it recovers only today's bug damage
  and never re-runs — future intentional `force`-reaps stay reaped.

## Edge cases (decided)

- **Force-reap vs. heal:** the heal is one-time and version-gated, so it does not
  fight a later operator `force`-reap. (Pre-existing, out of scope: any source that
  keeps receiving new content re-mints from fresh `pending` checks — not introduced
  by this fix.)
- **Revoked instance:** handled by the live `approvedInstanceFor` predicate (above).

## Non-goals

- **Not** changing retention/collapse behavior. The `verified_origin` **claim** may
  still churn as versions are trimmed — that only affects a per-item **byline
  attribution rung**, a separate lesser issue; the member **source** now survives
  regardless, and new content re-mints its claim.
- **Not** touching `memberCounts` / `MEMBER_RANGE_SQL` (correct).
- No new dependencies.

## Testing / acceptance

- **Guard:** an `origin_verification` member whose `canonical_url` is covered by an
  approved instance is **not** reaped by `reapSourceIfOrphaned` (refused
  `instance_member`), even with **no** `verified_origin` claim present; **is**
  reaped with `force=true`; **becomes** reapable once its instance's federation is
  revoked (`approvedInstanceFor` → null).
- **Recovery heal:** given a `verified` check whose `batch_key` source is missing,
  the heal resets it + re-pends its job; a subsequent verification drain re-mints
  the member source + `verified_origin` claim; the member is then guard-protected.
  Idempotent re-run is a no-op (no stranded checks remain).
- **Regression:** ordinary orphan sources (non-member: no subscribers, not an
  `origin_verification` member) are still reaped as before.
- **Completion gate:** core Vitest, `tsc`, web Vitest (if the admin reason copy is
  touched), `svelte-check`.

## Files

- `core/src/domain/source-repository.ts` — the `reapSource` guard + `SELECT` widen
  + `ReapResult`/`ReapCommandResult` `'instance_member'` reason.
- `core/src/logical/membership.ts` — reuse `approvedInstanceFor` (no change
  expected; export already present).
- `core/src/storage/sqlite.ts` — the imperative recovery heal + a `MIGRATIONS`
  version-marker entry.
- Admin surface (web) — only if the new refused reason needs display copy.

## Sequencing

Spec → clean-context spec review (fold as revs) → `writing-plans` → clean-context
plan review → `subagent-driven-development` (worktree, per-task review, whole-branch
review) → merge. No code authorized by this document.
