# Instance-governed members — design

**Date:** 2026-07-25
**Status:** rev 3 — rev 2 inverted the mechanism to a write-side cascade
(hybrid storage per maintainer adjudication; veto V1 accepted: unblock is not
lossless); rev 3 folds the fresh-eyes rev-2 pass (15 findings, all accepted —
the four that made rev 2 unimplementable: cascade the ACTION not the value;
the cascade lives in BOTH transition() and establishFederation();
activatePendingSubscriptions restored on a corrected premise; the DTO does
gain one field). Review trail:
`../reviews/2026-07-25-instance-governed-members-spec-review.md`. Ready for
maintainer spec review, then plan.
**Trigger:** live-operations find on rsc.rmdes.be — federating one rss.chat
instance minted dozens of per-author `origin_verification` sources that (a)
required one-by-one manual approval after the migration and (b) render in the
admin UI indistinguishably from deliberately-subscribed feeds.

## Root causes (verified in code)

1. **Governance inheritance is frozen at mint** (`verification.ts:297-302`):
   a minted origin inherits the asserting aggregate's governance at mint
   time; nothing later propagates instance-level decisions to members.
2. **No membership representation, and the web page ignores provenance.**
   The admin DTO already carries `provenance` over the wire
   (`types.ts:123`); the web page drops it deliberately. The UI fix is two
   lines of web mapping — no DTO change.

## Decided model

Precedence (maintainer): **explicit wins downward only** — a per-member
decision is sticky through ordinary instance changes; an instance **block is
absolute** (overrides included). Unblock lands all members at `quarantined`
(the matrix's only exit from blocked) — **V1 accepted: no lossless restore**.

**Membership predicate — ONE definition used everywhere** (roll-up, group
exclusion, cascade, mint rule, heal): a source is a member of a federated
instance iff

- its `canonical_url` byte-prefix-matches the instance's
  `scheme://host[:port]/` (computed from the instance row; the range is
  written `canonical_url >= prefix AND canonical_url < prefix-with-last-
  byte-incremented` — NEVER `LIKE`, which scans under BINARY collation; the
  existing `canonical_url` UNIQUE autoindex serves it — **no
  `canonical_host` column**), and
- `provenance = 'origin_verification'`, and
- it is not the instance row itself, and
- the instance has `federation status = 'approved'` (federation status ALONE
  — not `attribution_mode`, which `set_attribution_mode` can flip without
  any cascade trigger and would silently mutate membership).

`ponytail:` http and https on one host do NOT group — split membership, one
instance row each (member URLs come from feed content, instance URLs from
the admin's paste; the ceiling is accepted and stated).

The predicate ships as ONE exported function used verbatim by the cascade,
the mint rule, the roll-up, the member reads, and the heal.

Deliberate subscriptions on a shared host are never members (multi-tenant
hosts stay safe); membership is derived, never asserted (cross-instance echo
minting cannot mislabel anyone); an aggregate is never its own member.

**One new column** (tail-append): `overridden INTEGER NOT NULL DEFAULT 1
CHECK (overridden IN (0,1))` — the house bit pattern. DEFAULT 1 because every
existing INSERT omits the column and every non-mint row is a deliberate act;
the mint (`verification.ts:300`) adds one explicit `0`. A DIRECT admin
transition on a member sets `1`, permanently. Recorded so it is not
relitigated: the zero-column alternative (derive overridden from admin audit
rows) was rejected ONLY because it cannot forgive the marathon-era
hand-approvals — the maintainer wants those members re-adopted by their
instance.

## Mechanics — write-side cascade, zero read-path changes

Stored governance IS effective governance. No read gate, no shared predicate
refactor, no hot-path EXISTS (the timeline query family stays untouched —
see the 2026-07-25 perf incident), and purge keeps working on members of
blocked instances (their own rows really are blocked).

**The cascade is ONE factored function called from BOTH governance+
federation write sites** — `transition()` (after the governance comparison,
`sqlite.ts:1250`, inside the same BEGIN IMMEDIATE opened at :1211) AND
`establishFederation()` (after `sqlite.ts:1187-1189`, which is the ONLY
runtime path that creates an approved instance — `'pending'` federation
exists solely from the legacy conversion, so `transition('approve')` fires
only for migration-era rows). Replay-safe by construction at both sites
(the ledger check returns before effects; a replayed commandId never
re-cascades). It fires when the instance's governance CHANGED (any
transition, `unblock` included) or on federation approval/establishment.

Per member, the cascade **re-runs the instance's ACTION through
`SOURCE_TRANSITIONS` against the member's own axes** (`approve` and
establishment re-run as `allow`) — the matrix is authoritative: a null cell
skips, so an instance `allow` never resurrects a member whose own row is
blocked, and `unblock` (blocked→quarantined) applies exactly to blocked
members. Cascading the ACTION, not the resulting value, is load-bearing:
value→cell has no legal mapping for unblock (`quarantine` is null from
`blocked` by pinned design). Ordinary cascades skip `overridden = 1`
members. **Block and unblock cascades hit ALL members, overridden included**
(absolute both directions; after unblock everyone is `quarantined` — V1).

Each cascaded member runs `advancePolicyGeneration` (generation + fan-out
row) in the same transaction, and — for members landing `allowed` —
`activatePendingSubscriptions` (users CAN subscribe to member URLs:
`resolveAndSubscribeSource` refuses only aggregates/federated rows, and a
subscription to a quarantined member is written `'pending'`; skipping the
activation would strand those rows and reproduce the marathon symptom).
Members do NOT append their own journal reset — the instance's single
barrier reset (`sqlite.ts:1252`) covers the whole cascade; N per-member
resets would be N full client refetches for one click. Audit: **one
instance-level `source_audit_v2` row** (`action: 'instance_cascade'`, count
of members MOVED in `result_json`) — per-member rows would pin every member
against `reapSourceIfOrphaned`'s any-audit-history retention forever. No new
command kinds, no fingerprint inputs, no `SourceTransitionResult` widening.

`overridden` flips to 1 only when a DIRECT transition on a member has
`actorKind === 'administrator'` AND its applied patch changed `governance` —
`pause`/`resume` (operational axis) and `set_attribution_mode` are not
judgments and must not orphan a member from its instance.

**Mint rule fix** (one write site): `findOrCreateOriginSource`
(`verification.ts:294-304`) inherits governance via the SAME exported
membership predicate (byte-prefix, not "same host" — scheme/port drift would
mint members the instance can never cascade), same deterministic pick
(earliest `created_at`, then id) — except that, block being absolute, it
mints `blocked` if ANY matching approved instance is blocked. Falls back to
the asserting aggregate's governance as today when no approved instance
matches.

## Migration + one-time heal (tail-append; DDL in SQL, data in JS)

DDL: the one `ALTER TABLE ... ADD COLUMN overridden ... DEFAULT 1` and
nothing else. Data (a JS step beside the migration, per the `convert.ts`
precedent — no SQL URL parsing): (1) `overridden = 0` for ALL
`origin_verification` rows — **including the marathon hand-approvals**
(deliberate: they were workarounds, not judgments); (2) re-sync every
`overridden = 0` member (membership predicate above) to its instance's
current governance, **excluding blocked instances** and with the pick among
several approved same-host aggregates deterministic (earliest `created_at`,
then id). Flag-off byte-identical; v2 tables only. `migrations.test.ts` pins
`user_version` in four places — the plan updates all four.

## Admin UI (web-only)

- Federated instance rows gain a member roll-up ("N members ·
  n instance-governed · n overridden") backed by
  `GET /admin/sources/:id/members/counts` (bare grouped object, no cursor —
  matching the `:id/subscriptions` and `:id/audit` siblings; a literal path
  under `/admin/sources/` would be shadowed by the `:id` route, hence
  per-instance) — NOT by widening `?filter=governance`, whose 50/100 page
  cap would silently under-count. Member rows load lazily on expansion via
  `GET /admin/sources/:id/members` (standard `pageArgs` cursor page). Both
  inherit the existing `/admin/*` auth gate.
- `groupOf` excludes members from BOTH the `user` and `review` groups
  (quarantined members must not flood "Quarantine and pending federation" —
  that is the wall reborn). Members appear only under their instance.
- Members of non-federated hosts stay in the general list with a
  `via verification` hint.
- Wire: `provenance` is already carried; `overridden` is ONE new DTO field
  (`RemoteSource` + `rowToRemoteSourceV2` + the three inline row literals) —
  a small core change the web mapping then reads.

## Edges

- Federation revoked: the relationship row is deleted, so membership (which
  requires `approved`) dissolves — members keep their last state and appear
  in the general list until the instance is re-approved.
- Multiple approved aggregates on one host: cascades fire from the instance
  being transitioned (deterministic by construction); the heal's pick is
  pinned above.
- The 25-per-source verification mint cap, identity keys, attribution
  levels, and threading are untouched.
- The operation axis does not cascade: pausing an instance does not pause
  its members (polling members is verification-driven anyway).

## Testing (the money set)

1. Cascade-through-matrix in one transaction: instance allow flips
   instance-governed quarantined members; an explicitly-blocked member (null
   cell) and an `overridden = 1` member are both skipped; policy generation
   advances per moved member; a pending subscription on a member landing
   allowed ACTIVATES; exactly ONE journal reset for the whole cascade; one
   instance audit row with the moved count.
2. **Establishment cascades:** `establishFederation` on an instance whose
   echo-minted members are quarantined lifts them (the operator's actual
   path); `transition('approve')` on a migration-era pending row does the
   same (re-run as `allow`).
3. Block/unblock round-trip: block reaches ALL members including overridden;
   a member minted DURING the block is born blocked (mint rule); unblock
   lands every member `quarantined`; purge works on a blocked member.
4. Sticky flip: a direct administrator governance transition on a member
   sets `overridden = 1` and the next ordinary cascade skips it; a
   `pause`/`resume`/`set_attribution_mode` on a member does NOT set it.
5. The heal on a marathon-shaped fixture (hand-approved + stuck-quarantined
   members; one blocked instance excluded; two approved same-host aggregates
   exercising the deterministic pick).
6. Replay at BOTH call sites: re-sending the transition's or the
   establishment's commandId returns the stored result and cascades nothing.
7. The membership range query plans as SEARCH on the canonical_url
   autoindex (>=/< range, never LIKE) — asserted with EXPLAIN in the
   hot-lookup test.
8. Journey checklist gains: federate an instance → members appear under it;
   moderate one member; block the instance; unblock it — expected states at
   each step (publisher-page steps assert on navigation, not live — the
   stream mounts on the first-page river only).

## Non-goals

No read-path changes. No `canonical_host` column. No lossless unblock
restore (V1). No per-member cascade audit rows. No change to verification
volume, identity keys, fingerprints, command vocabulary, or any flag-off
path. Raw provenance still not exposed beyond the admin surface.

*developed with the help of AI tools*
