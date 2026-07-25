# Instance-governed members — design

**Date:** 2026-07-25
**Status:** rev 1 — folds the clean-context ponytail review (12 findings, all
accepted; two written decisions below). Ready for maintainer spec review.
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
   (`verification.ts:300`) carries no link to its instance. The admin DTO
   ALREADY carries `provenance` over the wire (`types.ts:123`,
   `source-ops-api.test.ts:75`) — the web page deliberately ignores it
   (`admin/feeds/+page.server.ts`); the "no provenance" pin is on the PUBLIC
   following DTO (`source-following.test.ts`), a different surface. So the UI
   fix is two lines of web mapping, not a DTO supersession.

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
- **`overridden`** (INTEGER NOT NULL DEFAULT 0 CHECK `(overridden IN (0,1))`
  — the house bit pattern, e.g. `admin_retained`; a two-value TEXT enum would
  violate the wide-CHECK rule and need a rebuild to widen). Mints
  (`origin_verification`) start 0 (instance-governed). Any DIRECT admin
  transition on a member sets 1, permanently. All non-member rows are 1
  (deliberate acts). Recorded so it is not relitigated: a zero-column
  alternative (derive overridden from administrator audit rows) is defeated
  ONLY by the heal's decision to erase the marathon hand-approvals.

  **Host rule (pinned, one implementation twice):** lowercase; strip port,
  userinfo, and trailing dot; `www.` is NOT stripped (distinct origins).
  Because migrations are SQL-only (`MIGRATIONS` exec'd verbatim,
  `sqlite.ts:1301`), the backfill implements this rule in SQL and the write
  path uses one exported JS helper; the fixture test feeds a mixed-case and a
  ported URL to both and asserts they agree.

## Mechanics

**Ordinary instance transitions cascade in the same transaction.** Whenever
a federated aggregate's transition CHANGES its governance to anything except
`'blocked'` (condition-based — the `sqlite.ts:1251` comparison — not an
action list, so `unblock`'s blocked→quarantined cascades too and members can
never end up more permissive than their instance), the same transaction
updates every same-host `origin_verification` source with `overridden = 0`,
routing each member through the SAME machinery the direct path uses:
`advancePolicyGeneration` + fan-out row, and `activatePendingSubscriptions`
on allow/approve (`sqlite.ts:32-39,163-166,1240`) — a bare governance UPDATE
would strand stale policy generations. One system-actor `source_audit_v2`
row per moved member (`action: 'instance_cascade'`, shared command id); ONE
`journalPolicyReset` (the instance's). No new command kinds, no fingerprint
changes, no widening of `SourceTransitionResult` (the member count is
readable from the shared-command-id audit rows).

**Instance block is enforced at the read layer, not by cascade.** Blocking an
aggregate rewrites NO member rows. The projector and repo filter
`governance = 'allowed'` verbatim at EIGHT sites (`eligibleDeliveries`,
`eligibleAuthorClaims` :359, `publisherName` :376, `itemAssertedName` :528,
`resolvePublisher` :650, the publisher lens :696, and the drains) — those
collapse into ONE exported "governance-effective" SQL fragment + JS
predicate, and the instance-block clause is added there once:

> a source is governance-effective iff its own governance is `allowed` AND
> NOT (it is an `origin_verification` row whose `canonical_host` carries a
> BLOCKED federated aggregate).

This makes "absolute" true everywhere — without it, an item visible on other
evidence would still take its byline/publisher from a blocked instance's
member (the attribution leak). Two scoping decisions, recorded:

- **Members only:** the clause keys on `provenance = 'origin_verification'`.
  A feed the operator DELIBERATELY subscribed to on the same host is a
  top-level explicit act and survives an instance block (also prevents
  collateral on multi-tenant hosts — substack.com et al.). Blocking it is
  its own one-click decision.
- **No scheduler gate.** Members carry no subscription or federation rows,
  so `listSchedulableSources` (`store.ts:686-692`) never schedules them —
  their deliveries arrive through verification batches, which already stop
  when the aggregate is blocked. A host clause there would be dead code for
  members and could ONLY silence deliberate subscriptions: cut.

Unblock is lossless (nothing was overwritten); members minted DURING a block
are dark by the same read clause. Mint-time inheritance is kept but ceases
to matter — `overridden = 0` means the next cascade picks the member up.

## Migration + one-time heal (tail-append, next user_version)

One ordered migration entry: (1) backfill `canonical_host` (SQL host rule
above); (2) `overridden = 0` for ALL `origin_verification` rows —
**including members the operator hand-approved during the marathon**
(deliberate call: workarounds for the propagation hole, not per-member
judgments; a real judgment is one click to re-establish) — `1` for
everything else; (3) re-sync: every instance-governed member adopts its
same-host federated instance's current governance, **excluding blocked
instances** (`AND i.governance != 'blocked'` — writing `blocked` onto member
rows would violate the block-rewrites-nothing invariant on day one), with a
deterministic pick when several federated aggregates share a host (earliest
`created_at`, then id). Flag-off byte-identical; v2 tables only.

## Admin UI

- Federated instance rows gain a member roll-up: "N members ·
  n instance-governed · n overridden", expandable to member rows showing
  effective state, an `overridden` badge, and Manage links.
- The "user sources" group excludes same-host members of federated instances
  — it finally lists only deliberate subscriptions.
- Members of non-federated hosts stay in the general list with a small
  `via verification` hint (no instance row exists to nest under).
- Wire: the admin DTO already carries `provenance`; the web page maps it
  (two lines) plus the new `overridden`. Membership/host derive client-side
  from `canonicalUrl` — no `memberOfInstance` field, no DTO supersession.
- The page's governance fetch (`?filter=governance`, added 2026-07-25)
  widens with one OR — rows whose `canonical_host` matches a federated
  aggregate's — so the roll-up counts and member expansion are complete on
  every page (the paginated page fetch alone cannot supply them).

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
2. Block-absolute through the ONE governance-effective predicate: an
   overridden-allowed member goes dark on timeline, byline, publisher name,
   AND publisher page; a member minted DURING the block is dark; a
   deliberate same-host subscription stays visible; unblock restores
   overrides losslessly.
3. Sticky flip: a direct member transition sets `explicit` and survives the
   next instance cascade.
4. The heal migration on a marathon-shaped fixture (quarantined-minted +
   hand-approved members → all instance-governed, synced to the instance).
5. The `canonical_host` index is proven by an `EXPLAIN QUERY PLAN`
   SEARCH-not-SCAN assertion in the existing hot-lookup test (NOT by the
   reflective FK guardrail — `canonical_host` is not a foreign key, and that
   test's value is being exception-free).
6. Journey checklist gains: "federate an instance; moderate one member;
   block the instance; unblock it" with expected states at each step.

## Non-goals

No change to verification/minting volume, identity keys, attribution levels,
fingerprints, command vocabulary, or any flag-off path. No per-member
"pre-block governance" storage. No exposure of raw provenance to the UI.

*developed with the help of AI tools*
