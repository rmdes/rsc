# Admin source & user governance visibility (v2)

Status: draft · 2026-07-25 · rev 1 (folded spec-review findings — see Revision
history). Source/orphan/attribution parts are v2-only (gated by `sourceModelV2`);
**users pagination is mode-agnostic** (users exist in both modes) — see §1.

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
- **`addedBy`** (`{ handle, displayName }[]`, first 3) — resolved for the whole
  page in **one batched query** joining `source_subscriptions_v2.owner_id →
  users` (the CORE `users` table with handle/display_name, `sqlite.ts:875` — NOT
  the auth `user` table), keyed by source_id (no N+1). The count comes from the
  already-computed `subscriptionCounts.active`, not a second query. Empty for
  orphans. This is a NEW disclosure (the existing subscriptions endpoint returns
  only opaque `ownerId`), justified: admin-only, moderation purpose. [review M9/M10/M11]

`listUsers` → **`listUsers(cursor, limit)`**, mode-agnostic:
- Add `id` to the SELECT and make the ORDER BY `created_at DESC, id DESC`
  (currently created_at-only, no id — the `(created_at,id)` cursor needs both,
  `sqlite.ts:705-713`).
- Route `/admin/users?cursor=&limit=` returns `{ items, nextCursor }` (was
  `{ users }`). Update callers: `web/src/lib/api.ts:177` `listAdminUsers`,
  `web/src/lib/api.test.ts:123`, `web/src/routes/admin/users/+page.server.ts:8`.
  [review M8]

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

### 3. Auto-reap leak fix — `core/src/logical/local.ts`

Root cause (identified, not just suspected): in v2 mode, account deletion routes
`service.deleteLocalAccount` → `logical/store.ts:374` → `local.ts:279`, which
does `DELETE FROM users WHERE id=?` and **never calls reap**; subscriptions
cascade via `owner_id … ON DELETE CASCADE`, orphaning any source that loses its
last subscriber. The v1 path (`deleteUserCascade`, `sqlite.ts:664/670`) captures
source ids and reaps; the v2 path does not. Fix at `local.ts:279`: capture the
user's `source_id`s before the `DELETE FROM users`, then `reapSource(tx, id,
{force:false})` per source — mirroring `sqlite.ts:664/670`. Used by moderation
hard-removal (`DELETE /admin/users/:handle`) and self-serve deletion. Failing
test first (delete a user who was a source's last subscriber → source must be
gone), then the fix. [review I4]

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
  — C1 regression); URL search (match/no-match/256-cap); batched `addedBy`
  (0/1/many subs; assert single query — no N+1); `retention` (each of 4 labels,
  incl. admin_retained); reap (refuse: non-allowed governance / any-state sub /
  federation; evidence refuse-then-force; audit + admin_retained override;
  idempotent replay; force-retry uses a new commandId; unknown→refused);
  auto-reap leak (v2 account-delete failing-then-fixed); `listUsers` pagination
  (id in cursor, ordering).
- **Web**: extend `admin/feeds/source-actions.test.ts` — search round-trip,
  orphan group render + paginate, reap incl. force-confirm-second-form, `addedBy`
  render, prev/next. New `admin/users` pagination test. Web tests in-container
  (`-w web`, `env -u CORE_API_URL`); run `tsc` + `svelte-check` (native
  type-stripping ⇒ vitest passes on type errors).

## Rollout

No migration — reads + one idempotent command + a UI + the `local.ts` leak fix.
Ship via SDD, whole-branch review on the most capable model, then build +
`cloudron update` to all 4 instances (image `rmdes/rsc:<tag>`,
CloudronManifest.json + logo.png symlinked at CWD per the deploy runbook). Verify
`/admin/feeds` search + orphan group + `/admin/users` pagination on rsc.rmdes.be
before the other three.

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
