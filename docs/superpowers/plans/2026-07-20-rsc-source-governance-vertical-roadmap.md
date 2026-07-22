# RSC source-governance vertical roadmap

**Spec:** `docs/superpowers/specs/2026-07-20-rsc-source-governance-moderation-design.md` rev 3
**Revision:** 4 — folds in the third parallel plan review.

**Cutover strategy:** Build the new model behind `RSC_SOURCE_MODEL_V2=off` by
default. Do not dual-write. The final vertical performs the one atomic data
conversion and changes the default. This is a pre-release, single-user system:
do not add rollout percentages, distributed locks, shadow comparisons, or
multi-version rollback machinery.

## Vertical 1 — Source control plane

Plan: `2026-07-20-rsc-source-control-plane.md`

Deliver the inactive v2 source registry end to end: schema, URL resolution,
source subscriptions, operation/governance/federation axes, audit/idempotency,
admin APIs, and no-JS web management. Core exposes the capability state so web
keeps every legacy surface operational while v2 is off. No remote items use it
yet.

## Vertical 2 — Logical items and ordinary reads

Deliver v2 delivery observations/versions, durable reconciliation jobs,
publishers/claims, deterministic convergence and selection, resolve-once
threading, the central visibility projector, ordinary API representations,
source-based Personal membership, feeds, SSR pages, and semantic SSE payload
projection. It also delivers the minimal durable `upsert | remove | reset`
journal, monotonic replay cursor, atomic source-transition reset barrier, and
send-time policy projection. This is the first remote-item reader/writer, so no
v2 item is API-, feed-, or SSE-accessible before these protections land.

## Vertical 3 — Moderation, events, verification, and evidence review

Deliver hidden moderation, placeholders and structural tombstones, resumable
per-item policy fan-out, paused/blocked push behavior, bounded origin
verification, purge, conflicts, paginated evidence APIs, and administrator
review surfaces. It extends the Vertical 2 journal; it does not introduce the
first client-invalidation barrier.

*Scope note 2026-07-22:* the v2 push subsystem is deferred out of Vertical 3
(V3 spec rev 1, §3); "paused/blocked push behavior" survives only as a forward
constraint on whichever vertical ships push (Vertical 4 or its own).

## Vertical 4 — Migration and final cutover

Deliver the preflight command and versioned manifest, one atomic legacy-data
conversion, permanent compatibility aliases, exact push/follow preservation,
the durable migration report/reset, and full acceptance gates. Remove the v1
runtime branch only after every v2 reader and writer is ready. Migration is the
final cutover, not an early schema task.

## Review order

Each detailed plan receives the repository's parallel plan review before the
next plan locks signatures that depend on it. Review order is 1 → 2 → 3 → 4.
No implementation begins until its plan review is folded in.

Implementation of every vertical remains deferred until all four vertical
plans have passed repository review and a final cross-vertical contract review
has been completed. Execution then proceeds in order: Vertical 1, Vertical 2,
Vertical 3, and Vertical 4.
