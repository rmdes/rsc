# Admin source & user governance visibility (v2)

Status: rev 2 (2026-07-28) — folds the 2026-07-25 spec review
(`docs/superpowers/reviews/2026-07-25-admin-governance-visibility-spec-review.md`,
verdict NOT READY) and re-verifies every code reference against the current
tree (three days of active development since rev 1: `RSC_SOURCE_MODEL_V2` is
gone, v2 is unconditionally the only model — drop "gated by sourceModelV2"
throughout this doc, it's now vacuous). **Maintainer decision (2026-07-28):
full scope ships together, not the review's ship-now/deferred split** — see
§Revision history rev 2 for why.

## Motivation

The 2026-07-25 `observation_versions_v2` runaway ([obs-versions incident];
one per-user Gutenberg feed churned 763k versions / 2.6GB on rsc.rmendes.net)
exposed a governance blind spot: the operator could not **find** the offending
feed in `/admin/feeds`. It was never filtered out — the page loads all sources
(`filter` none → `1=1`) into an "Allowed user sources" group — but with 122
sources on the main instance and only cursor pagination (no search, no prev/next
controls), it was buried pages deep and effectively invisible.

Live audit across the 4 instances (2026-07-25):

| Instance | Total sources | Invisible-in-practice | 0-subscriber "orphans" |
|---|---|---|---|
| rsc.rmdes.be | 129 | 122 | 49 |
| rsc.rmendes.net | 89 | 86 | 22 |
| bob.rmdes.be | 20 | 2 | 2 |
| alice.rmdes.be | 19 | 1 | 1 |

Crucial nuance from the diagnostic: of the 49 orphans on main, **46 are
retained by design** — they back a `verified_origin` publisher claim (reap spec
§2.4/§7 evidence retention); `reapSourceIfOrphaned` correctly refuses them.
Only ~2-3 per instance are genuine leaks. So this feature is **visibility +
attribution + operator-reap**, NOT a mass cleanup.

**Scope honesty (rev 2, review BLOCKER #1 — folded, not resolved by building
around it):** the motivating incident itself — a per-user Gutenberg feed with
an active subscriber — is, by this spec's own always-enforced reap guard
(`COUNT(*)>0` on subscriptions, any state), **never** reachable via the orphan
group or the reap command. Goals 3-5 (orphan visibility, operator reap, close
the auto-reap leak) cannot re-find or re-remove that specific incident; only
Goal 1 (`?q=` search) and Goal 2 (`addedBy`) would have helped an operator
locate it faster among 122 buried sources. This spec is still worth building
for that reason (findability of ANY buried source, genuine 2-3-per-instance
orphan leaks, and the auto-reap gap — see below) — it is not, and was never,
a fix for the churn mechanism itself. That mechanism has no fix and no
backlog entry anywhere; recorded as its own `ideas.md` entry alongside this
rev (see Rollout).

## Goals

1. **Findability** — locate any source or user regardless of pagination (URL
   search + real prev/next controls on both `/admin/feeds` and `/admin/users`).
2. **Attribution** — every source shows **who added it** (subscriber handles) —
   moderation governance.
3. **Orphan visibility** — an always-shown, paginated "Orphaned sources" group,
   each row **labeled with why it is retained** (verified-origin evidence /
   audit history / admin-retained / reapable), so the operator understands
   before acting.
4. **Operator reap** — a one-click override that removes a 0-subscriber source
   the conservative auto-reap won't (audit-row / admin_retained guards), while
   still protecting structural guards and evidence.
5. **Close the auto-reap leak** — the genuinely-clean orphans that should have
   auto-reaped but didn't.

## Non-goals

- Poll-scheduling changes. Verified-origin sources with no followers are still
  polled; that resource cost is a **storage-hardening backlog** item, not here.
- Touching the 46 evidence-backed retained sources — that retention is correct.
- Legacy (flag-off) source admin: unchanged. Only users-pagination touches
  both modes.

## Terminology — "orphan" (pinned)

A source is an **orphan** iff: `governance='allowed'` AND **no** federation
relationship AND `SELECT COUNT(*) FROM source_subscriptions_v2 WHERE
source_id=? = 0` — i.e. **zero subscriptions of ANY state** (`active`,
`pending`, `pending_review`). This matches `reapSourceIfOrphaned`'s own
subscription predicate verbatim (`source-repository.ts:228`), which is a plain
`COUNT(*)`, not an active-only count. A source carrying only `pending_review`
subscribers (aggregate conversion `sqlite.ts:1242`; migration `convert.ts:341`)
is **not** an orphan and must never be reaped. [review C1]

## Components

### 1. Core reads — `core/src/storage/sqlite.ts`, `core/src/api/app.ts`

`listSourceSummaries(cursor, limit, filter?, q?)` extends the existing method:

- **`q`** (URL search): `AND canonical_url LIKE '%'||?||'%'` — bound param
  (injection-safe); composes with any filter and the existing created_at cursor
  pagination unchanged. Route `/admin/sources?q=`; reject `q` > 256 chars with
  `c.json({error},400)`. Note: `%`/`_` in `q` act as LIKE wildcards — acceptable
  (admin-only); do not escape. [review M11]
- **`filter=orphan`**: the Terminology predicate above. Sits beside the existing
  `filter=governance`; extend the route filter enum to `governance|orphan`
  (`app.ts:360`). It is a plain WHERE narrowing over the same cursor pagination,
  so the orphan group **paginates** — no fixed cap (the group already holds 49
  on main, so a 50-cap would truncate the exact case this spec targets). [review I7]

`SourceSummary` gains:

- **`retention`** (`'verified_origin' | 'audit_history' | 'admin_retained' |
  'reapable' | null`): non-null only for orphans; the ladder mirrors **every**
  reaper guard in order — `publisher_claims_v2 … evidence_level='verified_origin'`
  → `verified_origin`; else `admin_retained=1` → `admin_retained`; else
  `source_audit_v2` exists → `audit_history`; else `reapable`. (admin_retained
  must be in the ladder or an admin-retained orphan is mislabeled reapable.)
  `null` for non-orphans. [review I3]
- **`addedBy`** (`{ handle, displayName }[]`, first 3) — **rev 2 (review
  BLOCKER #3 simplification): a plain per-row lookup, NOT a batched query.**
  `sqlite.ts` already has an accepted precedent for exactly this shape —
  `pushFor` (currently `sqlite.ts:508-518`, `ponytail:` comment at :506-507:
  "one small indexed lookup per listed source (the page is clamped to ≤50);
  fold into the list query only if a page read ever shows up in a profile").
  `addedBy` follows the same pattern: one indexed `SELECT ... FROM
  source_subscriptions_v2 JOIN users ... WHERE source_id = ? LIMIT 3` per
  listed row, inside `listSourceSummaries`'s existing per-row map (currently
  `sqlite.ts:465-468`, alongside the existing `federationStatusFor`/
  `subscriptionCountsFor`/`pushFor` per-row calls it already makes). No
  batched join, no query-count assertion in tests — matching the file's own
  established convention, not inventing a new one. The count comes from the
  already-computed `subscriptionCounts.active`, not a second query. Empty for
  orphans. This is a NEW disclosure (the existing subscriptions endpoint
  returns only opaque `ownerId`), justified: admin-only, moderation purpose.
  [review M9/M10/M11, simplified per review BLOCKER #3]

`listUsers` → **`listUsers(cursor, limit)`**, mode-agnostic:
- Add `id` to the SELECT and make the ORDER BY `created_at DESC, id DESC`
  (currently created_at-only, no id — the `(created_at,id)` cursor needs both;
  re-verify the exact current line range in `sqlite.ts` at implementation
  time, it has shifted since rev 1).
- Route `/admin/users?cursor=&limit=` returns `{ items, nextCursor }` (was
  `{ users }`). **Rev 2 correction (review BLOCKER #3: rev 1 named 3 call
  sites, the real count is ~9 — re-verified 2026-07-28):**
  - `core/src/domain/repository.ts` — `listUsers()` interface signature.
  - `core/src/storage/sqlite.ts:400` — implementation.
  - `core/src/domain/service.ts:122` — service-layer wrapper (`listUsers()
    { return repo.listUsers() }`).
  - `core/src/api/app.ts:419` — the route (`app.get('/admin/users', ...)`),
    response shape changes from `{ users }` to `{ items, nextCursor }`.
  - `web/src/lib/api.ts` (`listAdminUsers`, ~line 97-101) — client function,
    needs cursor/limit params and the new response shape.
  - `web/src/routes/admin/users/+page.server.ts` (~line 3, 8) — load function,
    needs cursor param + prev/next.
  - `web/src/lib/api.test.ts` (~line 61-63) — test.
  - `core/test/admin-users.test.ts:33` — test, calls `repo.listUsers()`
    directly with no args; needs updating for the new required params.
  - `core/test/source-capability-api.test.ts:93` — test, calls
    `repo.listUsers()` incidentally (asserting on `feedUrl`, not users
    pagination); needs updating for the new signature too, even though its
    own subject is unrelated.
  All 9 must move together or the build fails at `tsc --noEmit`. [review M8,
  corrected per review BLOCKER #3]

### 2. Core write — operator reap — `app.ts`, `core/src/domain/source-repository.ts`

Route: **`POST /admin/sources/:id/reap`** — registered **before** the
`/admin/sources/:id/:action` transition handler (Hono matches in registration
order; the in-repo precedent mounts logical routes before `:action` "so
`/refresh` matches the refresh route, not the transition matrix", `app.ts:253-254`).
Otherwise `:action='reap'` is swallowed as an invalid transition. [review I5]
Auth: `requireAdmin` (session-admin; ops-token 401s — same as all `/admin/*`).
Body: **`{ commandId, force? }`**. [review I6]

Wrapping repository method (matches transition/establish/purge): `BEGIN
IMMEDIATE` → `checkCommand(tx, cmd)` (replay/conflict) → `reapSource(tx, id,
{force})` → `storeCommand(tx, cmd, result)`. `CommandEnvelope`:
`actorScope='administrator'` (valid — `types.ts:144`), `actorId` = admin user id,
`requestFingerprint = fingerprintRequest(['reap', id])`. No moderation category —
reap is cleanup, writes no tombstone, URL stays re-addable. [review M12]

New `reapSource(tx, sourceId, { force })` (refactor of `reapSourceIfOrphaned`):

- **Always-enforced guards** (return refused regardless of `force`):
  `governance !== 'allowed'` [review C2] · any subscription exists (`COUNT(*)>0`,
  any state) [review C1] · a federation relationship exists · a `verified_origin`
  publisher claim exists **unless `force`** (see below).
  → blocked source: refuse (use **purge**, which writes a tombstone,
  `tombstones.ts:189`); quarantined: refuse (not orphan cleanup).
- **Verified-origin evidence**: refuse unless `force`. Route maps this refuse →
  `409` with a body naming the consequence; the UI sends `force=true` only after
  the operator confirms "removes verification evidence for @publisher."
- **Operator-overridden guards** (ignored when this command runs — this is the
  override auto-reap lacks): `source_audit_v2` row, `admin_retained`.
- On success: reuse `removeSourceEvidence` (the tested cascade purge uses,
  `tombstones.ts:94`) + the conditional journal reset. Result
  `{ kind:'reaped' } | { kind:'refused', reason }`.

`reapSourceIfOrphaned` becomes `reapSource(tx, id, { force:false })` — auto-reap
is **byte-for-byte unchanged**: every current guard (governance, any-state subs,
federation, audit, admin_retained, verified_origin) still refuses. [review C1]

### 3. Auto-reap leak fix — `core/src/logical/local.ts` — **ALREADY SHIPPED, no work needed**

**Rev 2: this component is done.** Independently of this spec, commit
`d4bea7d` ("core: reap orphaned v2 sources on deleteLocalAccount",
2026-07-26) fixed exactly this bug: `deleteLocalAccount` (`local.ts:250-271`)
now reads `source_subscriptions_v2` for the account's subscribed source ids
(`local.ts:260`) before the deletes, and calls `reapSourceIfOrphaned(tx,
sourceId, now)` for each one afterward (`local.ts:268`), inside the same
transaction, mirroring `deleteUserCascade`'s proven pattern — with real test
coverage added in `core/test/housekeeping.test.ts` (+37 lines). Verified by
reading the current `local.ts` source directly, not assumed from the commit
message. Rev 1's root-cause description above (dated line references,
`store.ts:374`/`local.ts:279`) is historical — kept for context, not because
it still describes a bug. **No implementation task for this component in the
plan that follows this spec.**

**Distinct class, NOT this fix:** migration (`convert.ts`) and admin
`establishFederation` can create sources that are *born* with zero subscribers —
never subject to a removal-triggered reap. Those are pre-existing data the
**operator reap** (§2) cleans, not the leak patch. (Note: establish-created
sources carry a federation relationship, so they're excluded from `filter=orphan`
anyway; migration instance-follows carry `pending_review` subs, so with the C1
definition they're not orphans either.) [review I4]

### 4. Web UI — `web/src/routes/admin/feeds/`, `web/src/routes/admin/users/`

`/admin/feeds` (`+page.server.ts` load + `+page.svelte`):

- **Search box**: no-JS `<form method="GET">` writing `?q=`; load passes `q`
  through to `listSources`; box echoes `q` with a "clear" link.
- **"Orphaned sources" group**: fetched via a second `listSources(filter=orphan)`
  call, **paginated** with its own cursor param (not the ordinary-list cursor).
  Each row: `retention` label + a **Reap** form + a link to `/admin/sources/[id]`
  for block/purge. Reap on a `verified_origin` row is a **two-step confirm**: the
  first form refuses (409, consequence shown); the confirm form is a **separate
  form carrying its own distinct `commandId`** and `force=true` (a same-id retry
  would fingerprint-conflict). [review I6]
  **Rev 2 note (maintainer decision, full scope):** on the main instance today,
  ~46 of ~49 rows in this group are `origin_verification`-provenance sources
  (per-author members of a federated instance) that `instance-governed-members`
  (spec rev 3 + plan rev 2, unblocked but **not yet implemented** — no
  `overridden` column, no cascade code exists in the tree as of this rev)
  would eventually want to roll up under its own instance-member UI instead of
  listing flat here. Shipping this group now, before that feature exists, is a
  deliberate choice: it's real value today (findability + reap for genuine
  leaks), accepted as a known, revisit-later situation — when
  `instance-governed-members` actually ships its member roll-up, those rows'
  presentation here will need to be reconciled with it (most likely: excluded
  from this flat list once they have a real home). Not a blocker to building
  this now.
- **`addedBy`** on each user-source row: "Added by @handle (+N)".
- **Pagination controls**: prev/next `<a>`s carrying the cursor (no-JS) on the
  ordinary-sources list AND the orphan group.

`/admin/users`: consume the paginated route; render prev/next controls.

UI follows `design-system/rsc/MASTER.md` + any `pages/admin*.md`; build invokes
`ui-ux-pro-max`. New reap/search markup is v2-only where it depends on v2 reads;
each mutation form carries its own `commandId` (existing source/tombstone
pattern).

## Data flow & privacy

`addedBy` is a **new** admin disclosure: it resolves subscriber `ownerId` →
handle/displayName (the existing `/admin/sources/:id/subscriptions` returns only
opaque `ownerId`). Exposed only inside `requireAdmin`, solely for moderation —
consistent with the admin model (which already shows per-source subscription
counts), but not previously surfaced. Documented as intentional. [review M9]

## Testing

- **Core**: orphan filter (incl. a `pending_review`-only source is NOT an orphan
  — C1 regression); URL search (match/no-match/256-cap); `addedBy` (0/1/many
  subs) as a plain per-row lookup test (rev 2: **no** query-count/no-N+1
  assertion — that was rev 1's now-dropped batched-query design, see
  Component 1); `retention` (each of 4 labels, incl. admin_retained); reap
  (refuse: non-allowed governance / any-state sub / federation; evidence
  refuse-then-force; audit + admin_retained override; idempotent replay;
  force-retry uses a new commandId; unknown→refused); `listUsers` pagination
  (id in cursor, ordering, all 9 call sites compiling — see Component 1).
  **Rev 2: the auto-reap-leak test is NOT part of this plan** — it already
  exists (`core/test/housekeeping.test.ts`, added by `d4bea7d`), Component 3
  is done.
- **Web**: extend `admin/feeds/source-actions.test.ts` — search round-trip,
  orphan group render + paginate, reap incl. force-confirm-second-form, `addedBy`
  render, prev/next, **and the frozen privacy-guard regex re-confirmed to still
  exclude only `provenance`/`adminRetained`/item/deliver fields, not the new
  `retention`/`addedBy` fields this spec deliberately exposes** (see review
  finding 4, folded above). New `admin/users` pagination test. Web tests
  in-container (`-w web`, `env -u CORE_API_URL`); run `tsc` + `svelte-check`
  (native type-stripping ⇒ vitest passes on type errors).

## Rollout

No migration — reads + one idempotent command + a UI + (rev 2: NOT the
`local.ts` leak fix, already shipped separately). Ship via SDD, whole-branch
review on the most capable model, then build + `cloudron update` to all 4
instances (image `rmdes/rsc:<tag>`, CloudronManifest.json + logo.png
symlinked at CWD per the deploy runbook). Verify `/admin/feeds` search +
orphan group + `/admin/users` pagination on rsc.rmdes.be before the other
three.

**Rev 2 companion (review BLOCKER #2 — the churn bug's missing home):** add
an `ideas.md` backlog entry, in the same commit as this rev, naming the
763k-version/2.6GB `rsc.rmendes.net` Gutenberg-feed incident, the candidate
mechanisms (a per-delivery version-retention cap; or an
`acquisition_findings_v2` churn finding + auto-pause), and a concrete
promotion trigger (e.g. "any single source's `observation_versions_v2` count
crosses N"). Per-instance operational memory already records the incident
was hand-purged via `purgeSource` on 2026-07-25 — this entry is about the
*mechanism* that let it happen, not a repeat of the incident record. Whether
this becomes a task now or stays backlog-with-trigger is a separate maintainer
call from this spec's own scope.

## Open questions

None blocking. `addedBy` display cap (first 3 + count) set here.

## Revision history

- **rev 1 (2026-07-25):** folded sub-agent spec review. C1 — orphan/reap
  subscription predicate is any-state `COUNT(*)`, not active (prevents deleting
  `pending_review` subs / preserves byte-for-byte auto-reap). C2 —
  `governance='allowed'` is an always-enforced reap guard (force can't un-block
  without a tombstone). I3 — `admin_retained` added to the retention ladder. I4 —
  leak root-caused to `local.ts:279` (v2 account delete); born-orphans separated
  to operator reap. I5 — reap route registers before `:action`. I6 — reap body
  `{commandId, force?}`; force-confirm uses a distinct commandId. I7 — orphan
  group paginates (no 50-cap). M8 — users-pagination is mode-agnostic + needs
  `id` in cursor + web call-site updates. M9/M10/M11/M12 — addedBy is a new
  disclosure, joins core `users`, reuses `subscriptionCounts` for count, wildcard
  behaviour noted; ledger wrapping + fingerprint pinned.
- **rev 2 (2026-07-28):** folds
  `docs/superpowers/reviews/2026-07-25-admin-governance-visibility-spec-review.md`
  (verdict: NOT READY). Every code reference re-verified against the current
  tree, not transcribed from rev 1 — three days of active development
  (`RSC_SOURCE_MODEL_V2` fully retired, v2 unconditional) had already made
  some of rev 1 stale independent of the review. Changes:
  - Scope-honesty caveat added to Motivation (review BLOCKER #1): the
    motivating incident is structurally unreachable by the orphan/reap
    surface; the spec is still worth building for other reasons, stated
    explicitly rather than implied.
  - `addedBy` simplified from a batched join to a plain per-row lookup,
    matching the existing accepted `pushFor` precedent (`sqlite.ts:506-518`)
    — no query-count test (review BLOCKER #3 simplification).
  - `listUsers` call-site count corrected from rev 1's 3 to the real ~9,
    enumerated precisely (review BLOCKER #3 correction).
  - **Component 3 (auto-reap leak fix) marked done** — shipped independently
    as `d4bea7d` (2026-07-26), verified against current `local.ts` source,
    with existing test coverage in `housekeeping.test.ts`. No task for it in
    the plan.
  - Frozen-guard note added with the actual current guard location and regex
    (`source-actions.test.ts:89-91`), correcting a stale line reference in
    the review itself (review finding 4).
  - Cross-spec note on `instance-governed-members`' one-audit-row rationale
    recorded here (review finding 5), since that spec's own docs aren't this
    spec's territory to edit.
  - `ideas.md` churn-bug backlog entry specified as a rollout companion
    (review BLOCKER #2).
  - **Full scope retained, not the review's ship-now/deferred split**
    (maintainer decision, 2026-07-28): the orphan group + reap command ship
    together with search/addedBy/pagination in one plan, accepting the
    `instance-governed-members` overlap (~46 of ~49 orphan rows on the main
    instance) as a known, revisit-later situation rather than a sequencing
    blocker — `instance-governed-members` itself is unblocked at the planning
    stage (plan folded to rev 2, `d132b0d`) but has no shipped code yet, so
    waiting for it has no defined end point right now.
