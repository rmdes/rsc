# Instance-governed members — spec review (2026-07-25)

Target: `docs/superpowers/specs/2026-07-25-instance-governed-members-design.md`
(rev 0, `ee35879`, 129 lines; brainstormed + section-approved by the
maintainer). Dual pass: ponytail (P1–P11) + correctness (C1–C15), adjudicated.

**Verdict: the DECIDED MODEL survives — "explicit wins downward only, block is
absolute," derived membership, mint-time inheritance kept — but the MECHANISM
inverts: the two lenses independently converge on a write-side cascade riding
the existing `transition()` machinery, replacing read-layer gates and BOTH new
columns. The read-gate design is not just heavier; it is incorrect four ways
(C5 no choke point exists, C11 purge refuses non-blocked members, C2 stale
fan-out hints, C3 the approval-marathon symptom survives). Fold as rev 1.**

## The adjudicated mechanism (rev 1 core)

1. **Cascade on transition, through the matrix (P1 + C1).** An admin
   transition on a federated instance additionally applies to its minted
   members — each member evaluated through
   `SOURCE_TRANSITIONS[action]` against ITS OWN axes; `null` cells skip
   (an instance `allow` never resurrects a member the matrix says stays
   blocked). Zero read-path changes anywhere: stored governance IS
   effective governance, so every one of C5's ~15 un-named read sites,
   C11's purge gate, and the admin projections work unchanged.
2. **Cascade membership predicate (C4 — the over-capture fix):** same
   canonical-URL byte-prefix (`scheme://host[:port]/`, computed from the
   instance row — P4's range, which also settles C4's scheme/port
   sub-issue) AND `provenance = 'origin_verification'` AND not explicitly
   governed. Deliberate subscriptions on a shared host (rss.chat IS a
   hosted service) are never cascaded, never hidden, never blocked by an
   unrelated aggregate.
3. **Each cascaded member gets the full governance-write contract (C2 +
   P7):** `advancePolicyGeneration` (generation + fan-out enqueue per
   source) inside the same BEGIN IMMEDIATE transaction; journal reset
   semantics per the existing per-source contract (plan-level detail).
4. **`allow`/`approve` cascades run `activatePendingSubscriptions` per
   member (C3)** — this is the actual approval-marathon symptom; without
   it the spec fixes nothing user-visible.
5. **`block` cascades write `blocked` to members; `unblock` cascades
   `blocked → quarantined` per the matrix (C8, C11).** Purge-after-block
   works; the divergence C8 found dissolves.
6. **Mint-during-block (P3):** one write-site change —
   `findOrCreateOriginSource` prefers a same-host federated aggregate's
   governance over the asserting aggregate's, falling back as today.
7. **No new columns.** `canonical_host` → the byte-prefix range on the
   existing UNIQUE index (P4; `ponytail:` note the http/https non-grouping
   ceiling). `governed_by` → derived: explicitly-governed ≡
   `EXISTS(source_audit_v2 row with actor_kind='administrator')` (P5, the
   `reapSourceIfOrphaned` precedent). Dissolves C10 (CHECK class) and C13
   (DDL/defaults/insert sites) entirely; NO migration.
8. **Audit: ONE instance-level row per cascade** with the member count in
   its `result_json` (P6 + C9 — per-member rows would pin every member
   against reaping forever, contradicting the spec's own non-goal). The
   web layer derives any count it displays from its next load (P11; C14
   moot).
9. **Admin UI is web-only (P8 + C7):** one `groupOf` branch keyed on the
   membership predicate over data the load already has. Root cause #2 in
   the spec is FACTUALLY WRONG (C7): core's DTO already carries
   provenance (positively pinned by `source-admin-api.test.ts:147`); the
   exclusion is a narrow web-side interface. The declared supersession of
   a "no provenance-adjacent DTO fields" pin is DELETED — that pin does
   not exist, and the two web regexes don't match the proposed fields
   anyway. P9's cosmetic affordances (breakdown counts, `overridden`
   badge, `via verification` hint) are cut.
10. **Multi-aggregate-per-host rule deleted (P10 + C12):** the cascade
    fires from the instance being transitioned — deterministic, no rule
    needed. C12's predicate-precision question dissolves with it.
11. Citation fixes (C15): `core/src/logical/store.ts:686-694`;
    mint inheritance is `verification.ts:297` (the :220 cite is a comment).

## Maintainer veto points (approved semantics this fold changes)

- **V1 — Lossless unblock restore is traded away.** Rev 0's read-gate
  model restored per-member overrides byte-perfectly on unblock. The
  write-side cascade lands everyone in `quarantined` (the matrix's only
  exit from blocked) and the operator re-allows survivors — the spec's own
  "one click to re-establish a real judgment" argument, applied to
  unblock. If lossless restore is non-negotiable, say so: the fallback is
  keeping `governed_by` as a real column (veto V2) plus a pre-block
  snapshot, which is the machinery rev 0's Mastodon precedent implies and
  the single-operator reality argues against.
- **V2 — `governed_by` as a stored column vs derived.** Derivation loses
  one nicety: the migration heal cannot "forgive" the marathon-era manual
  approvals (those members carry admin audit rows, so they read as
  explicitly-governed and won't follow future instance transitions).
  Practical effect today: those rows sit at the state you clicked them to,
  which is also what explicit-wins-downward promises. If you want them
  re-adopted by the instance, keep the column (one column, not two) and
  the heal sets it.

## What the reviews verified clean (keep, do not re-litigate)

Derived membership over a mint-time parent column (the cross-instance echo
argument is CONFIRMED in code: the minted URL is instance B's, the asserter
is instance A); mint-time inheritance staying frozen; hosts lowercase on
both normalizer paths; tail-append discipline correctly stated (now moot);
`source_audit_v2.action` accepts `instance_cascade` freely; one command =
one ledger row with the cascade inside the existing BEGIN IMMEDIATE;
no fingerprint changes; the 25-mint cap untouched; the precedence rule as
one sentence.

## Handoff

Fold as rev 1 (this session or the implementation tab, whichever picks it
up), carrying the two veto points to the maintainer IN the rev note. Plan
follows only after the veto points are answered. Net rev-1 shape: zero
migrations, zero new columns, zero read-path changes, one write-site edit,
one cascade loop inside `transition()`, one web `groupOf` branch — and the
testing set shrinks to: cascade-through-matrix (incl. blocked-member skip),
activate-pending on cascade, block/unblock round-trip, mint-during-block,
and the journey-checklist federate row.
