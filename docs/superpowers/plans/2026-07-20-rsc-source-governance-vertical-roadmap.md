# RSC source-governance vertical roadmap

**Spec:** `docs/superpowers/specs/2026-07-20-rsc-source-governance-moderation-design.md` rev 2

**Cutover strategy:** Build the new model behind `RSC_SOURCE_MODEL_V2=off` by
default. Do not dual-write. The final vertical performs the one atomic data
conversion and changes the default. This is a pre-release, single-user system:
do not add rollout percentages, distributed locks, shadow comparisons, or
multi-version rollback machinery.

## Vertical 1 — Source control plane

Plan: `2026-07-20-rsc-source-control-plane.md`

Deliver the inactive v2 source registry end to end: schema, URL resolution,
source subscriptions, operation/governance/federation axes, audit/idempotency,
admin APIs, and no-JS web management. No remote items use it yet.

## Vertical 2 — Logical items and ordinary reads

Deliver v2 delivery observations/versions, durable reconciliation jobs,
publishers/claims, deterministic convergence and selection, resolve-once
threading, the central visibility projector, ordinary API representations,
source-based Personal membership, feeds, SSR pages, and semantic SSE payload
projection. This is the first remote-item reader/writer, so visibility protection
lands in the same vertical.

## Vertical 3 — Moderation, events, verification, and evidence review

Deliver hidden moderation, placeholders and structural tombstones, source policy
generations and resumable fan-out, the atomic event journal and reset barrier,
paused/blocked push behavior, bounded origin verification, purge, conflicts,
paginated evidence APIs, and administrator review surfaces.

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
