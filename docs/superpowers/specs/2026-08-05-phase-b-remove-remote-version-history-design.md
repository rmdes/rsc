# Phase B — Remove Remote Version-History (design)

**Status:** Rev 2 (2026-08-05; clean-context spec review folded — consumer trace
confirmed COMPLETE; 1 Critical + 3 Important write-path mechanics fixed, see
`docs/superpowers/reviews/2026-08-05-phase-b-spec-review.md`). Lead phase of the simplification
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
   change, **overwrite that row's material + fingerprint IN PLACE (same `id`)** —
   then (review C1: `presentation_entries_v2.observation_version_id` schema.ts:98
   and `reconciliation_jobs_v2.observation_version_id` schema.ts:176 are both
   **UNIQUE**, so a fresh INSERT collides) **reset the existing observation job to
   `pending`** (re-reconcile) and **UPSERT the single presentation entry**, never
   insert new ones. Emit the ordinary "updated" journal effect. No new version row.
   **Do NOT overwrite the version's first-arrival tuple** (`arrival_at`/`run_id`)
   — review I2: cross-delivery/claim selection and threading sort on
   `compareFirstArrival` (projector.ts:42), so first-arrival must stay stable; the
   *updated* display time lives in `presentation_entries_v2.effective_updated_at`
   (already), not the version's arrival.
2. **`presentation_entries_v2` collapses to one per delivery** (it IS the revision
   sequence the history chain reads).
3. **Keep the change-detection fingerprint** (already fixed to ignore volatile
   fields).
4. **Remove the remote revision-history route + page + "edited" marker.** Local
   `post_revisions` history stays.
5. **Verification stays** (instance-governed-members engine — Phase C dropped),
   but its `persistVerifiedDelivery` (`verification.ts:28,349-383`) is itself a
   SECOND version-inserter — on changed origin material it appends a version
   (review I4). To honor the one-per-delivery invariant everywhere, apply the same
   overwrite-in-place + reset-job + upsert-presentation there too (do not append).

## Removal / change footprint

**Core:**
- `acquisition.ts` — the observation-commit loop (~593-658): on a changed
  fingerprint, UPDATE the delivery's single `observation_versions_v2` row's
  **material + fingerprint** in place (same `id`; NOT `arrival_at`/`run_id` — I2),
  **reset the existing `kind='observation'` job to `pending`** (never insert — C1),
  and let reconcile UPSERT the single presentation entry; emit "updated". Delete
  the version-cap machinery (`MAX_VERSIONS_PER_DELIVERY`, `findVictims`, the
  eviction call). Keep the fingerprint compare (unchanged → bump `last_seen`).
- `verification.ts` (~324-383) — `persistVerifiedDelivery`: same overwrite-in-
  place + reset-job + upsert-presentation on changed origin material (I4), so a
  verified delivery also holds exactly one version.
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
3. **Byline: accept realignment-to-current (review I3 → plan-review C-C reversed
   this).** The plan review found the re-point idea was both wrong and fragile:
   `selectAuthor` (projector.ts:95) is EVIDENCE-LEVEL-first, not earliest-arrival,
   and it already prefers the RETAINED current author — so the survivor's own
   claim/name is a fine byline and the "move the earliest claim" step is
   unnecessary complexity that could corrupt name selection. Delete the
   non-survivors' native claim/name rows with their versions; the byline realigns
   to the current-display survivor's claim. Negligible real impact; NOT a feature
   loss (byline still shows).
4. **Idempotent claim/name writes (plan-review C-B, load-bearing):** with the
   version cap deleted and jobs re-pended on every edit, `reconcileClaim`
   (`reconcile.ts:332-335`) and verification's claim/name INSERTs must become
   idempotent (one row per version, natural-key upsert) — else unbounded
   claim/name growth reintroduces the July runaway class on new tables.
5. Verify one version + one presentation entry per delivery afterward; the item
   still resolves a byline; claim/name counts bounded.
- `post_revisions`, `posts`, local path, threading, moderation, deliveries,
  verification rows: untouched. Backup-before-flip; forward-only.

## Preserved (explicit non-goals of removal)

Change-detection fingerprint; timeline (local + remote current); threading;
moderation/`hidden`; feeds (RSS/Atom/JSON + comments); SSE journal;
`REMOTE_VISIBLE` visibility; verification + instance-governed-members;
local `post_revisions` edit-history; the retention age gate (Phase 1); sanitizer;
no-JS.

## Testing / acceptance

- **One row invariant + no UNIQUE collision (C1):** after a real content change
  on a remote item, the delivery has exactly ONE `observation_versions_v2` row
  (overwritten, same id), ONE `presentation_entries_v2` row, ONE re-`pending`ed
  observation job — no `UNIQUE` throw; the timeline shows the latest. Same for a
  verification-refreshed delivery (I4). Re-poll unchanged → bump only.
- **Selection stickiness (I2):** overwriting content does NOT reorder the item vs
  its cross-source/cross-claim peers (first-arrival tuple preserved).
- **Byline preserved (I3):** after the collapse migration, a remote item whose
  earliest claim differed from its current-display version keeps its ORIGINAL
  byline (earliest claim/name re-pointed to the survivor).
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
