# Instance-governed members — design

**Date:** 2026-07-25
**Status:** brainstormed with the maintainer; approved section-by-section; ready for plan
**Trigger:** live-operations find on rsc.rmdes.be — federating one rss.chat
instance minted dozens of per-author `origin_verification` sources that (a)
required one-by-one manual approval after the migration and (b) render in the
admin UI indistinguishably from deliberately-subscribed feeds.

## Root causes (verified in code)

1. **Governance inheritance is frozen at mint.** `verification.ts:220` — a
   minted origin source inherits the asserting aggregate's governance *at mint
   time*; approving the instance later does not lift already-minted members.
   That is the approval-marathon mechanism.
2. **No membership representation.** The minted source row
   (`verification.ts:300`) carries no link to its instance; `provenance` is
   deliberately excluded from the admin DTO (pinned by test), so the UI
   *cannot* distinguish a member from a subscription.

## Decided model

Precedence is the Mastodon domain-block shape, chosen explicitly:
**explicit wins downward only** — a per-member decision is sticky through
ordinary instance changes, but an instance **block is absolute** (overrides
included); unblocking restores overrides losslessly.

Two tail-append columns on `remote_sources_v2`:

- **`canonical_host`** (TEXT, backfilled from `canonical_url`, indexed — the
  FK/guardrail index test extends to cover it). Membership is DERIVED, never
  asserted: a source is a member of a federated instance iff its host equals
  the instance aggregate's host. Rationale: origins are frequently minted from
  cross-instance echoes (instance A's firehose asserts an item whose
  `<source>` is a user on instance B), so any mint-time parent column would be
  actively wrong; the host is truthy by construction and membership self-heals
  when federation is established later.
- **`governed_by`** (TEXT CHECK `('instance','explicit')`). Mints
  (`origin_verification`) start `'instance'`. Any DIRECT admin transition on a
  member flips it to `'explicit'`, permanently. Subscriptions, established
  federations, and migrated rows are `'explicit'` (deliberate acts).

## Mechanics

**Ordinary instance transitions cascade in the same transaction.**
`approve`/`allow`/`quarantine` on a federated aggregate also updates every
same-host source where `governed_by = 'instance'` to the instance's new
governance — one ledgered command (the instance transition), one system-actor
`source_audit_v2` row per moved member (`action: 'instance_cascade'`, the
command id shared), member count in the command result. No new command kinds,
no fingerprint changes.

**Instance block is enforced at the read layer, not by cascade.** Blocking an
aggregate rewrites NO member rows. The two read gates gain one indexed
`EXISTS`:

- scheduler eligibility (`store.ts:689` `listSchedulableSources`): a source is
  not schedulable if a blocked federated aggregate exists on its
  `canonical_host`;
- delivery eligibility (projector `eligibleDeliveries` /`REMOTE_VISIBLE`
  governance join): a delivery is ineligible under the same condition.

Consequences, all intended: the block silences members minted AFTER the
block; unblock is lossless (nothing was overwritten — explicit overrides and
instance-governed states resume as-is); no pre-block bookkeeping exists to
get wrong. Mint-time inheritance is kept (a new member of a quarantined
instance starts quarantined) but ceases to matter for tedium —
`governed_by='instance'` means the next cascade picks the member up.

## Migration + one-time heal (tail-append, next user_version)

Backfill `canonical_host` for every source. Set `governed_by`: `'instance'`
for ALL `origin_verification` rows — **including members the operator
hand-approved during the marathon** (deliberate call: those were workarounds
for the propagation hole, not per-member judgments; freezing them as
overrides would exclude them from future cascades — a real judgment is one
click to re-establish) — `'explicit'` for everything else. Then re-sync:
every instance-governed member adopts its same-host federated instance's
current governance. Flag-off byte-identical; v2 tables only.

## Admin UI

- Federated instance rows gain a member roll-up: "N members ·
  n instance-governed · n overridden", expandable to member rows showing
  effective state, an `overridden` badge, and Manage links.
- The "user sources" group excludes same-host members of federated instances
  — it finally lists only deliberate subscriptions.
- Members of non-federated hosts stay in the general list with a small
  `via verification` hint (no instance row exists to nest under).
- DTO: `SourceSummary` gains `governedBy` and
  `memberOfInstance: { sourceId, host } | null` (null when no federated
  aggregate shares the host) — a DECLARED supersession of the "no
  provenance-adjacent DTO fields" pin; raw `provenance` remains unexposed.

## Edges

- Federation revoked: grouping persists (host still matches); cascades stop;
  members keep their last state.
- Multiple federated aggregates on one host: cascade keys on any of them;
  block-absolute if ANY is blocked.
- The 25-per-source verification mint cap is unchanged.
- The per-source verification cap and orphan/threading machinery are
  untouched; this design changes governance propagation and presentation
  only.

## Testing (the money set)

1. Cascade-in-one-transaction: approve instance → every instance-governed
   member flips in the same tx; explicit members untouched; audit rows +
   count present.
2. Block-absolute: an overridden-allowed member goes dark at both read gates;
   a member minted DURING the block is dark; unblock restores overrides
   losslessly.
3. Sticky flip: a direct member transition sets `explicit` and survives the
   next instance cascade.
4. The heal migration on a marathon-shaped fixture (quarantined-minted +
   hand-approved members → all instance-governed, synced to the instance).
5. Guardrail: `canonical_host` index covered by the reflective FK/index test;
   both `EXISTS` gates proven SEARCH-not-SCAN.
6. Journey checklist gains: "federate an instance; moderate one member;
   block the instance; unblock it" with expected states at each step.

## Non-goals

No change to verification/minting volume, identity keys, attribution levels,
fingerprints, command vocabulary, or any flag-off path. No per-member
"pre-block governance" storage. No exposure of raw provenance to the UI.

*developed with the help of AI tools*
