# Phase B — Remove Remote Version-History (design)

**Status:** Draft (brainstormed 2026-08-05). Lead phase of the simplification
program — `docs/superpowers/specs/2026-08-01-logical-pipeline-simplification-roadmap.md`
(rev 3). Independent. Authorizes no code (→ clean-context spec review → plan).

**Goal:** Remote feed items keep **one current observation per delivery** instead
of an unbounded/capped version chain. Removes the remote revision-history page,
the remote "edited" marker, and the per-delivery version cap. All load-bearing
behavior — timeline, threading, moderation, feeds, visibility, verification,
local post edit-history — is preserved.

## Background & consumer trace (Phase-C lesson applied)

`observation_versions_v2` serves two jobs: (a) **change-detection** — one
fingerprint per delivery, to skip unchanged re-polls (load-bearing, KEPT); and
(b) a **retained version chain** rendered as revision history (over-built). The
consumer trace (independently verified, since the parked spec `2026-07-31-...`
§3 under-stated it):

- **Chain consumers — all low-value, all removed here:** the public
  `/post/[id]/history` page (`projectHistory` REMOTE branch, `projector.ts:750-764`,
  building a sequence from `presentation_entries_v2`); the remote **"edited"**
  marker; the admin item-detail **versions list + count** (`store.ts:282`, `:261`).
- **Load-bearing readers use only ONE version and survive the collapse:**
  `REMOTE_VISIBLE` (`projector.ts:663`, `EXISTS` one reconciled version),
  threading (`threading.ts:144`, per-claim join), the current-version projector,
  and the **KEPT verification** subsystem (`persistVerifiedDelivery`,
  `verification.ts:324`, inserts exactly one version per verified delivery — it
  already fits "one per delivery").
- **Local `post_revisions` is a separate system** (`projectHistory` LOCAL branch,
  `projector.ts:737-749`) — untouched.

The runaway/churn this history layer caused is already fixed (`00bc235` + Phase 1);
Phase B is now pure simplification, not a bugfix.

## Decisions locked

1. **Remote items keep one current observation per delivery.** On a real content
   change, **overwrite that row's material + fingerprint in place**, enqueue one
   reconciliation job, emit the ordinary "updated" journal effect. No new row.
2. **`presentation_entries_v2` collapses to one per delivery** (it IS the revision
   sequence the history chain reads).
3. **Keep the change-detection fingerprint** (already fixed to ignore volatile
   fields).
4. **Remove the remote revision-history route + page + "edited" marker.** Local
   `post_revisions` history stays.
5. **Verification is untouched** (it's the instance-governed-members engine, kept
   — Phase C dropped). Its one-version-per-delivery insert must keep working.

## Removal / change footprint

**Core:**
- `acquisition.ts` — the observation-commit loop (~593-658): on a changed
  fingerprint, UPDATE the delivery's single `observation_versions_v2` row
  (material, fingerprint, arrival, run) in place + enqueue one job + emit
  "updated"; do NOT insert a second row. Delete the version-cap machinery
  (`MAX_VERSIONS_PER_DELIVERY`, `findVictims`, the eviction call). Keep the
  fingerprint compare (unchanged → bump `last_seen`).
- `reconcile.ts` / presentation writing — ensure a delivery keeps ONE
  `presentation_entries_v2` row (overwrite/upsert the current, not append a
  sequence). Confirm `selectedDeliveryFor` / current-version selection still
  resolves.
- `projector.ts` — remove the REMOTE branch of `projectHistory` (`:750-764`);
  remote returns current-only (or the route 404s for remote), LOCAL branch
  (`:737-749`) kept. Remove `currentSequence`-chain assumptions for remote.
- `store.ts` — remove the admin item-detail version-list read (`:282`) and the
  version count (`:261`), or reduce to a single-current shape.
- Remove the remote "edited" marker source (the `updatedAtProvenance`/edited
  signal for remote items) — local keeps its edited/revisions affordance.

**Web:**
- `/post/[id]/history` — remove the remote-item history affordance (the page/link
  renders only for local posts, mirroring the core change). Remove the remote
  "edited" marker in `EditedMarker`/`PostBody` display for remote items.
- Admin item-detail (`/admin/items/[id]`) — remove the versions list/count
  section (the DTO field it renders).

## Migration (forward-only, 4 live instances) — folds Criticals 2 & 5

The sharp edge. One migration, children-first (FK dependency order — do NOT
"rewire"):
1. **Per delivery, pick the survivor** = the `observation_versions_v2` row backing
   the current display `presentation_entries_v2` (Critical 5). 
2. **Delete non-survivor versions and their FK children in order** (Critical 2):
   `presentation_entries_v2` (UNIQUE + RESTRICT), `publisher_claims_v2`,
   `publisher_names_v2`, `logical_conflicts_v2`, `reconciliation_jobs_v2`
   referencing the doomed `observation_version_id`, then the versions — reuse the
   existing `deleteObservationVersions` cascade helper (`tombstones.ts`) as the
   ordering authority. Collapse `presentation_entries_v2` to the single survivor
   per delivery.
3. Verify one version + one presentation entry per delivery afterward; the
   current display + author selection are unchanged (survivor = current).
- `post_revisions`, `posts`, local path, threading, moderation, deliveries,
  verification rows: untouched. Backup-before-flip; forward-only.

## Preserved (explicit non-goals of removal)

Change-detection fingerprint; timeline (local + remote current); threading;
moderation/`hidden`; feeds (RSS/Atom/JSON + comments); SSE journal;
`REMOTE_VISIBLE` visibility; verification + instance-governed-members;
local `post_revisions` edit-history; the retention age gate (Phase 1); sanitizer;
no-JS.

## Testing / acceptance

- **One row invariant:** after a real content change on a remote item, the
  delivery has exactly ONE `observation_versions_v2` row (overwritten) and ONE
  `presentation_entries_v2` row; the timeline shows the latest. Re-poll unchanged
  → bump only.
- **No remote history:** `/posts/:id/revisions` returns current-only / not-found
  for remote; local `post_revisions` history byte-unchanged.
- **No remote "edited":** a remote content change updates display without an
  "edited" badge; local edited/revisions affordance intact.
- **Visibility/threading/verification unaffected:** `REMOTE_VISIBLE` still shows
  a reconciled remote item; a verification-minted delivery still resolves; a
  reply still threads.
- **Migration correctness:** on a delivery with N pre-existing versions, the
  collapse keeps the current survivor + its presentation entry, deletes the rest
  and all FK children with no RESTRICT violation; idempotent re-run is a no-op.
- **Completion gate:** core Vitest, `tsc`, web Vitest, `svelte-check`, web build.

## Risks & coordination

- **The version-collapse migration on live data is the sharp edge** (Criticals
  2 & 5). Backup-before-flip is the only rollback.
- **Shared checkout / parallel sessions** in `core/src/logical/*` — coordinate
  before SDD; stage explicit paths, never `git add -A`.
- Independent of D/F/A′; do not block on them.

## Sequencing

Spec → clean-context spec review (fold as revs) → `writing-plans` → clean-context
plan review → `subagent-driven-development` with a whole-branch review →
independent deploy. No code authorized by this document.
