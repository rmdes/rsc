# Instance-governed members — design

**Date:** 2026-07-25
**Status:** rev 2 — the mechanism INVERTED from rev 1's read-layer gates to a
write-side cascade after three convergent reviews (ponytail rev-1 fold
`8502879`; the dual-pass review and the orchestrator correctness appendix in
`../reviews/2026-07-25-instance-governed-members-spec-review.md`). Maintainer
adjudicated the storage fork: **hybrid** — cascade-through-the-matrix plus ONE
stored `overridden` bit. Maintainer-accepted veto V1: unblock is NOT lossless
(members land `quarantined` per the matrix; real judgments are one click to
re-establish). Ready for maintainer spec review, then plan.
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
  `scheme://host[:port]/` (computed from the instance row; range query on the
  existing `canonical_url` UNIQUE index — **no `canonical_host` column**), and
- `provenance = 'origin_verification'`, and
- it is not the instance row itself, and
- the instance is a federated aggregate with `federation status = 'approved'`.

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

**The cascade lives inside `transition()`** (`sqlite.ts`, after the
governance comparison at :1250; replay-safe by construction — the ledger
check at :1212-1214 returns before effects, so a replayed commandId never
re-cascades). It fires when:

- the instance's governance CHANGED (any transition, `unblock`'s
  blocked→quarantined included), **or**
- the transition is a federation **approval** (which usually changes no
  governance — the pending path already forced `allowed`,
  `sqlite.ts:1175-1183` — but is the moment membership first becomes
  derivable; the cascade applies the implied `allow`).

Per member, the cascade applies the instance's new governance **through
`SOURCE_TRANSITIONS` against the member's own axes** — a null cell skips
(an instance `allow` never resurrects a member whose own row is blocked).
Ordinary cascades skip `overridden = 1` members. **Block and unblock
cascades hit ALL members, overridden included** (absolute in both
directions; after unblock everyone is `quarantined` and real judgments are
re-established by hand — V1).

Each cascaded member runs `advancePolicyGeneration` (generation + fan-out
row) in the same BEGIN IMMEDIATE transaction. `activatePendingSubscriptions`
is NOT routed — members carry no subscription rows (dead code for them).
Audit: **one instance-level `source_audit_v2` row** for the cascade with the
member count in its `result_json` — per-member rows would pin every member
against `reapSourceIfOrphaned`'s any-audit-history retention forever. No new
command kinds, no fingerprint inputs, no `SourceTransitionResult` widening.

**Mint rule fix** (one write site): `findOrCreateOriginSource` inherits
governance from a same-host **approved federated** aggregate when one
exists, falling back to the asserting aggregate as today — so members minted
during a block are born blocked, and members of an approved instance are
born allowed regardless of which echo asserted them.

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
  n instance-governed · n overridden") backed by one grouped-count read (a
  small admin endpoint: GROUP BY instance/governance/overridden over the
  membership predicate) — NOT by widening `?filter=governance`, whose 50/100
  page cap would silently under-count. Member rows load lazily on expansion.
- `groupOf` excludes members from BOTH the `user` and `review` groups
  (quarantined members must not flood "Quarantine and pending federation" —
  that is the wall reborn). Members appear only under their instance.
- Members of non-federated hosts stay in the general list with a
  `via verification` hint.
- Web mapping adds `provenance` and `overridden` (two small lines; the wire
  already carries provenance).

## Edges

- Federation revoked: the relationship row is deleted, so membership (which
  requires `approved`) dissolves — members keep their last state and appear
  in the general list until the instance is re-approved.
- Multiple approved aggregates on one host: cascades fire from the instance
  being transitioned (deterministic by construction); the heal's pick is
  pinned above.
- The 25-per-source verification mint cap, identity keys, attribution
  levels, and threading are untouched.

## Testing (the money set)

1. Cascade-through-matrix in one transaction: instance allow flips
   instance-governed quarantined members; an explicitly-blocked member (null
   cell) and an `overridden = 1` member are both skipped; policy generation
   advances per moved member; one instance audit row with the count.
2. **Approve-cascades-implied-allow:** federate an instance whose echo-minted
   members are quarantined; approval alone lifts them (the rev-1 gap).
3. Block/unblock round-trip: block reaches ALL members including overridden;
   a member minted DURING the block is born blocked (mint rule); unblock
   lands every member `quarantined`; purge works on a blocked member.
4. Sticky flip: a direct member transition sets `overridden = 1` and the next
   ordinary cascade skips it.
5. The heal on a marathon-shaped fixture (hand-approved + stuck-quarantined
   members; one blocked instance excluded; two approved same-host aggregates
   exercising the deterministic pick).
6. Replay: re-sending the instance transition's commandId returns the stored
   result and cascades nothing.
7. Journey checklist gains: federate an instance → members appear under it;
   moderate one member; block the instance; unblock it — expected states at
   each step (publisher-page steps assert on navigation, not live — the
   stream mounts on the first-page river only).

## Non-goals

No read-path changes. No `canonical_host` column. No lossless unblock
restore (V1). No per-member cascade audit rows. No change to verification
volume, identity keys, fingerprints, command vocabulary, or any flag-off
path. Raw provenance still not exposed beyond the admin surface.

*developed with the help of AI tools*
