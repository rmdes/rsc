# V1 retirement (V4 Task 11) — delete the legacy path, remove the flag

Status: draft · 2026-07-25 · **rev 2** — reverses §H's false premise (the
migration machinery is LIVE on the fresh-install path, not retireable) and
withdraws the backup caveat that followed from it. Rev 1 reconciled the
operator's ponytail-debt ledger + perimeter scan, an inventory-verification
review, and a v1→v2 feature-parity audit. Executes V4 Task 11
(`docs/superpowers/plans/2026-07-22-rsc-migration-cutover.md:802`), with the
inventory fixed against the real tree as that task requires.

## Context and gate

V2 source-governance is live on all four instances (flag flipped 2026-07-25) and
has soaked through a full incident-response wave — nav-lag/FK indexes, the SSE
reset storm, poll-tick starvation, the WAL cap, and the observation-versions
purge — with v2 as the **only** live ingestion path throughout. The cutover
plan's soak gate is satisfied.

This release deletes the branch the flag kept dark. **No wire contract changes.
No migration. No table dropped.**

Operator decisions taken (2026-07-25):
- **Full flag removal now** — `RSC_SOURCE_MODEL_V2` disappears entirely.
- **Deploy order: unset the env var FIRST**, then `cloudron update` (which takes
  its own backup and restarts the app).

## Goals

1. Delete the v1 runtime, its routes, and the web legacy branches.
2. Remove `RSC_SOURCE_MODEL_V2` and every `sourceModelV2` branch.
3. Extract the pure helpers v2 depends on out of the hybrid modules first, so
   deleting v1 breaks nothing.
4. Close **GAP 1** (below) — the one defect the deletion would otherwise create.
5. Leave the suite fully green with **zero** `test.fails()` markers.

## Non-goals

- **Dropping legacy tables.** `users`, `posts`, `post_revisions`, `follows`,
  `subscriptions`, `instance_settings` keep live v2/shared roles (see §Data
  reachability). Storage cleanup is a later batch.
- Closing **GAP 2** (feed autodiscovery) — it is already-live behaviour, gets its
  own task, and does not block this release.
- Restoring the live-prepend pages (**P3**) — already-live, intentional.
- The queued feature work (admin governance visibility; instance-governed
  members) stays on standby behind this.

---

# Part 1 — Feature parity: what v2 does NOT cover

The audit classified every v1 capability. **v2 covers essentially the whole v1
surface**, and is materially richer in acquisition (conditional GET/validators,
durable retry/backoff + `source_health_v2`, per-hop SSRF, redirect-proof and
ownership-collision detection — all of which v1 lacked entirely).

Everything below is **already live in production** (the flag is on). Deleting v1
makes these permanent rather than causing them.

## GAP 1 — expired *outbound* subscriber rows are never purged ⚠ MUST FIX HERE

`repo.purgeExpiredSubscriptions()` deletes from the **`subscriptions`** table —
people who subscribed to *our* feeds via WebSub/rssCloud
(`core/src/storage/sqlite.ts:619`). Its **only caller in the tree** is
`core/src/domain/push-in.ts:272`, inside `runPollCycle`.

The v2 scheduler's tail (`logical/scheduler.ts:116-117`) calls
`push.purgeExpired()`, but that is `store.purgeExpiredPushRows` →
**`push_subscriptions_v2`**, the *inbound* table. **Different table.**
(`convert.ts:382` documents the distinction, which is why it slipped.)

- **Consequence:** the table grows unbounded; `/admin/overview`'s federation
  counts are computed off it. Nothing breaks functionally —
  `listActiveSubscriptions`/`countActiveSubscriptions` already filter on
  `expires_at > now` (`sqlite.ts:609,613`).
- **Status:** already unpurged in production since the flip. Deleting
  `push-in.ts` removes the last caller permanently.
- **Fix (this release, one line):** add
  `void repo.purgeExpiredSubscriptions(new Date().toISOString())` to the existing
  hourly `sweepLoop` (`core/src/server.ts:178-186`) — already the housekeeping
  loop, so no new dependency and no new timer.

This is the single place where §A's "SPLIT, do not delete" analysis was
incomplete: deleting v1 removes the sole caller of a **still-needed shared
repository method**.

## GAP 2 — HTML `rel=alternate` feed autodiscovery is v1-only (own task, not this release)

`domain/ingest.ts:264-297` (`ingestViaDiscovery`): when a fetched body is not a
parseable feed but is HTML, v1 runs `discoverFeed`, follows the first
`<link rel="alternate" type="application/rss+xml">` one hop, ingests it, and
**rewrites the stored feed URL** (`repo.updateFeedUrl`, `:284`). v2's
`extractRawItems` (`logical/acquisition.ts:200-209`) falls back only to
`extractHfeed`; with no h-entries the run terminalizes as
`operational_failure/feed_parse` (`:706`).

- **Who notices: end users.** Pasting a site homepage (`https://example.com/`)
  into Subscribe works on v1 and silently never delivers on v2 unless the page
  carries an h-feed. **The most likely user-reported regression from the
  cutover.**
- **Why it is not a rewiring:** it interacts with source identity
  (`canonicalUrl`), the redirect-proof/alias rules (`acquisition.ts:624`) and the
  tombstone gate. Options: (a) an acquisition finding recording the discovered
  URL + an owner/admin-visible "this source has moved" prompt, or (b) a one-hop
  follow writing a `source_aliases_v2` row.
- **Decision: separate task, tracked in `docs/superpowers/ideas.md`.** It must
  NOT be silently closed as "covered" — this spec records it as a known,
  already-live regression.

## GAP 3 — `scripts/federation-demo.mjs:83` still seeds via `POST /users`

The tool RUNNING.md cites as the production-verified `cloudron exec` driver.
Already inert under v2 (the row it creates has no v2 reader, RUNNING.md:554) and
will **hard-404** after deletion. Missing from the earlier inventory.
**Fix:** repoint to `POST /ops/sources/federation` — same bearer token, same 201,
body `{url, attributionMode, category, commandId}`.

## PARTIAL — behavioural differences to record (operator decisions)

**P1 — operator "add a feed" changes shape.** v1 `POST /users {handle,
displayName, feedUrl}` created a remote user with a **chosen handle and display
name**, its own `/u/:handle` page, in the federated tab. v2 offers
`POST /admin/sources` (web "Establish federation") — **URL only**, no handle, no
display name; the form hard-codes `attributionMode:'aggregate'` +
`category:'operator_policy'` (`admin/feeds/+page.server.ts:215-216`).
**Genuinely lost:** the operator-chosen handle/display name, and the
"instance-wide feed that is *not* a federation peer" middle category. Federation
is now the only operator-add reaching the federated tab. *(Inherited from the
2026-07-24 maintainer call, not decided here — but recorded.)*

**P2 — operator "remove a feed" is 2–3 steps, and the ops token loses it.**
v1 `DELETE /users/:handle` → `deleteUserCascade`: feed + posts gone, URL
immediately reusable, reachable with `Authorization: Bearer $RSC_TOKEN`.
v2: **block** → **purge** (leaves a **tombstone reserving the URL**, which must
be unblocked from `/admin/feeds` to re-add). Two sub-facts that matter:
- **`revoke` federation is NOT removal** — it leaves `governance='allowed'`, so
  items stay in the public lens forever. Only `block` changes visibility.
- **The ops token cannot block or purge.** Every `/admin/*` route sits behind
  `app.use('/admin/*', authed, requireAdmin())` (`app.ts:249`). So
  `DELETE /users/:handle` is the token's **last destructive reach** — deleting it
  is a **security improvement**, but any script relying on it breaks.
  **RUNNING.md:167 and :554-562 must be updated to match.**

**P3 — live prepends exist on three pages under v1, none under v2.**
`/post/[id]` (`+page.svelte:76`), `/u/[handle]` (`:80`),
`/u/[handle]/following` (`:53`) mount `<LiveTimeline>` in the v1 arm and nothing
in v2 — documented as intentional ("snapshot-only under v2, spec §5.7"). Only the
home river got the v2 journal stream. **The largest user-visible thing v1 does
that v2 does not.** Restoring it later is: plumb `journalCursor` through those
loads (`u/[handle]/+page.server.ts:42` currently discards it) + reuse the home
effect with the page's lens. Not required for deletion — recorded so the deletion
is not the moment it is forgotten.

**P4** subscribe loses the `person`/`webfeed` select (v2 derives it) — cosmetic.
**P5** SSE contract differs (opaque journal cursor + generation + `reset` frames
vs v1's inclusive replay capped at 100) — already live.
**P6** thread reads are bounded with placeholder ancestors vs v1's whole thread —
already live.

## Data reachability — verified safe

No v1-only reader is the sole surface for any live data. Conversion moved
everything (`convert.ts:218-260,391-396,424`), preserving inbound push
token/secret. v2 still actively reads `posts` (local only), `post_revisions`,
`follows`, `users`, `instance_settings`, and `subscriptions` (outbound, via the
unbranched `server.ts:160` path). Rows that become unreachable —
`posts WHERE source='remote'`, legacy `push_subscriptions` — are already invisible
under v2 and their content lives in `logical_items_v2`.

---

# Part 2 — Inventory (verified against the real tree)

## §A. The perimeter is EXTRACTION, not file deletion

A `/ponytail-debt` scan (47 markers, all with live triggers — no rot) plus the
inventory review fix the perimeter. Several "legacy-looking" modules are
**load-bearing for v2** and must be **split**, not deleted:

| Module | Disposition |
|---|---|
| `domain/push-in.ts` | **SPLIT** — relocate `verifySignature`, `choosePushTarget`, `PushTarget`, the six constants, `pushInEffective`; delete `createPushIn`, `runPollCycle`, `PushIn`, `PushInDeps` |
| `domain/ingest.ts` | **SPLIT** — keep `FETCH_TIMEOUT_MS`, `parseFeedWithMeta`, `mergeDiscovery`, `toParsedItem`, `ParsedItem`, `FeedDiscovery` (used by `logical/acquisition.ts:6`, `logical/push.ts:10`, `domain/discovery.ts:3`); delete `ingestItems` (:157), `ingestRemoteUser` (:232), `pollAll` (:299) — **no v2 caller** |
| `domain/opml.ts` | **SPLIT** — delete `importFollowingOpml` (v1-only); keep `buildFollowingOpml`, `localHandleForUrl` (`app.ts:340,15`, `domain/source-service.ts:6`) |
| `domain/subscribe.ts` | **SPLIT** — delete `mintRemoteUser` (v1-only, via `service.ts:234`); keep `slugBase` |
| `domain/feed.ts` | **SURVIVES ENTIRELY** — shared renderer both models use |
| `domain/repository.ts` | **SURVIVES** — `posts`/`users` remain the local-content authority |
| `domain/service.ts` | **SURVIVES** — its logical branch is the live one |
| `domain/push-guard.ts`, `domain/push.ts` | **SURVIVE** — shared (`checkCallbackUrl`, `cloudScheme`, outbound publishing) |

**⚠ `pushInEffective` is on the v2 path.** `server.ts:14` imports it together
with `createPushIn`/`runPollCycle`, and calls it at **`server.ts:118`, OUTSIDE
the else branch** — it gates `pushInApi` for v2 too. Deleting that import line
wholesale leaves it undefined and **breaks boot**. It must be **re-pointed** to
`./logical/push.ts`.

**v2 importers of `push-in.ts` (complete):** `logical/push.ts:6,12-15`,
`logical/acquisition.ts:8`, **`server.ts:14`**. Test importers to update:
`logical-push.test.ts:14`, `logical-push-callbacks.test.ts:11`,
`logical-v4-vertical.test.ts:11`, `federation-live.test.ts:7`, `push-in.test.ts`.

`THIN_PING_FLOOR_MS`: **nothing to collapse** — `push-in.ts:75`'s copy is
module-private inside `createPushIn` and dies with it; `logical/push.ts:20`'s
value simply stays. Zero work (earlier drafts wrongly listed this as a step).

## §B. `core/src/server.ts`

Delete the v1 `else` branch, the `if (config.sourceModelV2)` conditional (logical
store/runtime construction becomes unconditional; the dynamic `await import`s can
become static), and the `assertLegacyStartupAllowed` call (`:68-69`).
**Re-point `pushInEffective`** per §A. **Delete `workers`** (`:41,60,77,127,175`)
— it becomes dead once `compose` goes. **Add the GAP 1 purge call** to
`sweepLoop` (`:178-186`).

## §C. `core/src/config.ts`

Remove `rawSourceModelV2` parsing, its validation throw, and the
`sourceModelV2: boolean` field (`:13,72-74,103`).

**Deploy-safety (VERIFIED TRUE):** `loadConfig` (`:47-113`) reads only explicitly
named `env.RSC_*` keys — no schema, no unknown-key rejection. After removal a
leftover `RSC_SOURCE_MODEL_V2=on` is **never read and cannot fail boot**. The
unset-first deploy order is belt-and-braces. Assert with a regression test.

## §D. `core/src/api/app.ts` — duplicate ROUTE REGISTRATIONS, not branches

The v1/v2 split is **duplicate route registrations shadowed by Hono registration
order**. With the flag gone these v1 registrations are unreachable dead code and
must be deleted: `/timeline` (:764), `/timeline/stream` (:842), `/post/:id/thread`
(:588), `/posts/:id/revisions` (:232), `/post/:id/comments.xml` (:595),
`/users/rss.xml` (:683), `/users/:handle/feed.xml` (:696), `/users/:handle/feed.json`
(:711), `/users/:handle/follows` (:558), `/users/:handle/following.opml` (:610),
`POST /me/follows/opml` (:618), `POST /me/subscriptions` (:642),
`GET /admin/feeds` (:500), plus `POST /users` (:179) and `DELETE /users/:handle`
(:505).

**Required signature change (was missing):** `deps.sources` and `deps.logical`
become **required** (`app.ts:133`) and the `if (sources)` (:268) /
`if (deps.logical)` (:161) wrappers disappear. This is the direct cause of the
test work in §G. `service.instanceStats(sources !== undefined)` (:478) collapses
to a constant.

`/capabilities` (:154-158) **stays permanently**, body becomes the constant v2
shape. **`sourceModelV2` is a wire field web reads** (`web/src/lib/api.ts:284-300`,
typed `web/src/lib/types.ts:6-7`) — **do not rename it in this release.**

**Legacy user routes are NOT blocked** (open question resolved): the add/remove
forms live inside `{:else}` (`admin/feeds/+page.svelte:179-215`), unreachable in
v2 mode; the actions (`+page.server.ts:141,155`) are dead. v2 equivalents already
ship — add → `?/establish` → `POST /admin/sources` (:411); remove → `?/source`
block/quarantine → (:428). Only `smoke.ts:26` and `federation-demo.mjs:83`
re-point (GAP 3).

## §E. `core/src/logical/runtime.ts`

**Delete `compose` entirely** (`:360`) — with the flag gone it returns a constant
`{legacyPoll:false, legacyPushIn:false}`. Six further call sites go with it:
`logical-vertical.test.ts:104,126`, `logical-v3-vertical.test.ts:644,656`,
`logical-runtime.test.ts:50,54,55`.
**Delete `assertLegacyStartupAllowed`** (`:247`) — verified unreachable after flag
removal (sole production caller is `server.ts:69`). Its tests
(`migration-cutover.test.ts:197,288,292-293`, `logical-v4-vertical.test.ts:94`) go
with it.

## §F. `web/` — 19 non-test files (4 more than earlier drafts)

Previously listed ~13. **Missing and material:**
- **`routes/+page.server.ts`** — the primary timeline load with the cold-pod
  "capability rides alongside, never ahead" machinery (`:32-42,36-37,55,76,90,94,126`).
  **The single largest v1 branch in web**; `routes/page.load.coldpod.test.ts`
  exists only for it.
- **`routes/stream/+server.ts`** — SSE proxy branching at `:21`
  (`${v2 ? '/stream' : '/timeline/stream'}`) and `:95` (`enrichV2 : enrichV1`).
  **It keys on `?v2=1`, NOT `sourceModelV2`, so a grep-based inventory cannot see
  it.** Load-bearing. Test: `routes/stream/server.test.ts`.
- `routes/post/[id]/thread.json/+server.ts:16-17`.
- `routes/admin/sources/[sourceId]/+page.server.ts:67-68` (v2-only guard becomes dead).
- `lib/types.ts:6-7` — the `Capabilities` union loses its `{sourceModelV2:false}` variant.

Plus the previously-listed: `lib/api.ts`, `routes/+page.svelte`,
`u/[handle]/{+page.server.ts,+page.svelte}`,
`u/[handle]/following/{+page.server.ts,+page.svelte}`,
`post/[id]/{+page.server.ts,+page.svelte,edit,history}`, `p/[publisherId]`,
`admin/{feeds,items/[id],sources/[sourceId]/runs}`. (`lib/logical-api.ts` is
comment-only — correctly excluded.) ~14 web test files follow their subjects.

**SDD split — by surface, five tasks** (fork distribution is uneven; `lib/api.ts`
is the shared client every other branch keys off):

1. **`lib/api.ts` + `lib/types.ts` alone** (9 refs) — probe simplification + type-union
   collapse. Everything downstream inherits it, so later tasks delete branches whose
   **types already say there is one path**.
2. **`+page.server.ts` + `stream/+server.ts`** — the cold-pod machinery and the
   `?v2=1`-keyed SSE proxy. Highest risk, isolated where a reviewer will look hard.
3. **River surfaces** (`+page.svelte`, `following/*`) — shared alongside-call and
   live-lens logic.
4. **Item surfaces** (`post/[id]/*` ×5, `p/[publisherId]`, `u/[handle]/*` ×4) —
   mechanical after 1–3.
5. **Admin surfaces** (4 files) — trivial tail.

## §G. Tests — the largest work item in the release

**24 of the 38** core test files that call `createApp` pass no `sources`/`logical`
— i.e. they exercise the v1 route surface being deleted, and will not even
construct once `deps.sources`/`deps.logical` become required (§D). Sampled:
`sse.test.ts` (v1 `/timeline/stream`), `timeline-tabs.test.ts`, `feed.test.ts`,
`api-follows.test.ts`, `admin-feeds.test.ts`, `api.test.ts`,
`federation*.test.ts`.

**Each needs a disposition: convert to a logical-store app, or delete as
superseded by the `logical-*.test.ts` equivalent.** This is the bulk of the
release and was invisible in the original plan. Produce the per-file table during
planning, not implementation.

**The two fences are DELETED, not flipped.** `ingest.test.ts:409` and
`federation-live.test.ts:152` invoke the v1 path directly (`ingestItems`;
`service.addRemoteUser` + `ingestRemoteUser`), so once §A's ingest split lands
they cannot run at all. Census verified: these are the **only two** live
`test.fails()` markers in the repo. The positive v2 guarantee stays
(`logical-vertical.test.ts:272-277`). **Net: −2 expected-fail; suite fully green.**

**Whole sections/files retire, not single lines:** `logical-v4-vertical.test.ts`'s
`offFlagApp()` harness (`:88-121`) and its flag-off Part A (`:123`);
`federation-live.test.ts`'s three other v1 push tests (`:37,:89,:101`) — the file
effectively retires. `push-in.test.ts` is rewritten against the relocated helpers.

## §H. Migration machinery — NOT retireable; it is live on the fresh-install path

> **Correction (rev 2).** Rev 1 of this section claimed the migration machinery
> was partly retireable and offered an (a)/(b) choice, and it carried a "backup
> caveat" that followed from deleting the converter. **All of that was wrong**,
> and the error is instructive: it came from a grep pattern (`from './preflight`)
> that cannot match the real import (`from '../migration/preflight.ts'`). A
> path-pattern grep answers *"what does this file import by that spelling"*; only
> a **symbol** grep answers *"what breaks when this module dies."* The rest of
> this section is the symbol-verified truth.

**Nothing under `core/src/migration/` is deleted by this release.** Verified:

- `core/src/logical/runtime.ts:19-20` imports `loadManifest`, `runPreflight` and
  the `Manifest` type from `../migration/preflight.ts`.
- `core/src/logical/runtime.ts:21` imports `runConversion` from
  `../migration/convert.ts`.
- `convertLegacy` calls `loadManifest` (`:273`), `runPreflight` (`:282`) and
  `runConversion` (`:286`) — **unconditionally**, on the `never_activated`
  branch that `activateLogicalV2` takes (`:316`).
- `never_activated` is not only the legacy-cutover state: it is the state of
  **every brand-new install on its first boot**. A fresh instance runs preflight
  and conversion trivially over zero legacy rows, then activates.
- `core/package.json:10` wires `"preflight": "node src/migration/preflight-cli.ts"`,
  so even the CLI is an operator-invocable tool, not orphaned code.
- Consequently `core/test/migration-preflight.test.ts` and
  `core/test/migration-convert.test.ts` cover **live production code**. The
  "~1,400 deletable test lines" from the debt-ledger scan is wrong for the same
  reason.

Deleting `preflight.ts` or `convert.ts` would **break the first boot of every new
install** while all four already-converted production instances kept working —
a regression structurally invisible to any test run against current production.
RSC is a public Cloudron package, so a new install is a real, expected scenario.

**Required guard:** a fresh-install test (new empty DB → boot → activation
`active`, capability reports v2, a post round-trips). It exists to prove this
boundary stays intact, and must be green before and after any future work in
this area.

**The only optional piece** is `preflight-cli.ts` plus its npm script — a
read-only dry-run tool whose pre-cutover use case ends with the flag. **Default:
keep it.** It is ~15 lines, imports only live code, and is exactly the sort of
diagnostic that is wanted the day an old backup is restored. Delete it only on
an explicit operator decision, removing `core/package.json:10` in the same commit.

**Backup caveat — WITHDRAWN.** Rev 1 warned that a pre-cutover backup would
become permanently unrestorable. That consequence followed only from deleting
the converter. Since the converter stays, a restored pre-cutover backup still
converts forward on boot exactly as it does today. §Rollout's "previous v2 image"
guidance is unchanged for ordinary rollback, but it is no longer a one-way door.

## §I. Collapse the staged-path duplications (ride this release)

Ledger markers pre-flagged as Task 11 work; their only reason to exist was
staged-path isolation during the verticals, which ends here:
- **`deriveRoot` trio** — `logical/local.ts:65`, `logical/runtime.ts:87`,
  `logical/store.ts:250` (as `adminDeriveRoot`).
- **`normalizePermalink` twins** — `logical/acquisition.ts:86`,
  `logical/reconcile.ts:168`.

Five hand-duplicated copies collapse into one shared module each; the **drift
canary (`core/test/logical-lockstep.test.ts`) retires with them**. The single
largest debt reduction in the retirement. Sequenced **last**, so it happens once
against the final shape.

*(Distinct from the markdown/sanitizer twins — `core/src/domain/markdown.ts` +
`web/src/lib/server/render.ts` — which are a deliberate cross-workspace
invariant and **stay**, canary included.)*

## §J. Ops, env and docs (was entirely absent)

`RSC_SOURCE_MODEL_V2` also appears in: `/.env.example:33`, `core/.env.example:22`,
`docs/superpowers/documentation/RUNNING.md` (`:167` RSC_TOKEN row, `:176` env
table, the **entire `## Source model v2` runbook `:524-680`**, `:815`, `:916`),
and `docs/superpowers/documentation/2026-07-25-user-journey-checklist.md:12,145`.
All retire with the flag. RUNNING.md `:167` and `:554-562` additionally need the
**P2** correction (the ops token no longer has a destructive feed-removal reach).

**Verified clean:** no `compose.yaml`, `compose.prod.yaml`, `docker/`, `cloudron/`
or `Caddyfile` reference.

---

# Part 3 — Sequencing (one branch, one release)

1. **Extract the pure helpers** from `push-in.ts`, `ingest.ts`, `opml.ts`,
   `subscribe.ts` into their v2 homes; re-point every importer **including
   `server.ts`'s `pushInEffective`**. Suite green.
2. **Close GAP 1** — `purgeExpiredSubscriptions` into `sweepLoop`, with a test.
3. **Make `deps.sources`/`deps.logical` required** (§D) and delete the ~15 v1
   route registrations. Re-point `smoke.ts` and `federation-demo.mjs` (GAP 3).
4. **Delete the v1 runtime** — `server.ts` branch, the v1 remainders of the split
   modules, `compose`, `assertLegacyStartupAllowed`, `workers`.
5. **Test dispositions** (§G) — the bulk. Convert or delete each of the 24 files
   per the planning table.
6. **Strip web branches** — the five-task split in §F, in order.
7. **Remove the flag** from `config.ts`; add the stale-variable-is-ignored test.
   Retire the env/docs surface (§J), including the P2 correction.
8. **Document the migration machinery as LIVE** (§H) — it is NOT retired; the
   fresh-install test is written FIRST and must be green before and after. The
   only deletion here is the optional `preflight-cli.ts`, and its default is keep.
9. **Collapse the five lockstep duplications** (§I); retire
   `logical-lockstep.test.ts`. Full gate.

# Part 4 — Testing

- `npm run -w core test` — full suite, **zero** `test.fails()`, zero failures.
- `npm run -w core typecheck` + `svelte-check` for web (native type-stripping
  means vitest passes on type errors — the type gate is mandatory).
- Web tests in-container: `docker compose exec -T web env -u CORE_API_URL npm test -w web`.
- **New tests required:** config parses with a stale `RSC_SOURCE_MODEL_V2=on`;
  GAP 1 purge runs from `sweepLoop`; **fresh-install activation** (§H).
- Manual smoke on the dev stack: timeline loads, post round-trips, SSE
  live-prepend works, `/admin/feeds` establish + block/quarantine work.

# Part 5 — Rollout

1. **Unset `RSC_SOURCE_MODEL_V2` on all four instances first** (rsc.rmdes.be,
   alice.rmdes.be, bob.rmdes.be, rsc.rmendes.net).
2. Build `rmdes/rsc:<tag>` (CloudronManifest.json + logo.png symlinked at CWD per
   the runbook; remove symlinks afterwards).
3. `cloudron update --app <domain> --image …` per instance — takes its own backup
   and restarts.
4. Verify per instance: running, timeline + permalink + `/admin/feeds` 200, SSE
   connects, no boot errors.
5. Roll one at a time: **alice or bob first** (lowest traffic), then rsc.rmdes.be,
   then rsc.rmendes.net.

**Rollback:** the previous **v2** image or the pre-update backup. A *pre-cutover*
database is not what any post-flag image expects, so ordinary rollback means the
previous v2 image — but it is **not** a one-way door: the converter stays (§H),
so a restored pre-cutover backup still converts forward on boot.

# Open questions

**None blocking.** The former open question (legacy add/remove-feed routes) is
resolved: not a blocker, the v2 replacements already ship (§D). §H's former
(a)-vs-(b) choice is **no longer a question at all** — the migration machinery is
live on the fresh-install path and nothing under `core/src/migration/` is deleted
(rev 2). The one remaining judgment call is whether to drop the optional
`preflight-cli.ts`, whose default is keep. GAP 2 is deliberately deferred to its
own task.

# Revision history

- **rev 2 (2026-07-25): §H reversed — the migration machinery is NOT
  retireable.** Rev 1 claimed `migration/preflight.ts` + `convert.ts` were partly
  dead "since all four instances are converted," offered an (a)/(b) deletion
  choice, and warned that deleting the converter would make pre-cutover backups
  unrestorable. Symbol-level verification shows the opposite:
  `logical/runtime.ts:19-21` imports `loadManifest`/`runPreflight`/`runConversion`
  and `convertLegacy` calls all three unconditionally at `:273/:282/:286` on the
  `never_activated` branch — **every new install's first boot**, not just a legacy
  cutover. `core/package.json:10` also wires `preflight-cli.ts` as an npm script,
  and `migration-preflight.test.ts`/`migration-convert.test.ts` therefore cover
  live code (invalidating the "~1,400 deletable test lines" figure). Nothing under
  `core/src/migration/` is deleted; the (a)/(b) open question is closed; the backup
  caveat is **withdrawn** (a restored pre-cutover backup still converts forward,
  because the converter stays). Root cause of the original error, recorded so it
  is not repeated: a path-pattern grep (`from './preflight`) that cannot match the
  real import (`from '../migration/preflight.ts'`). Path greps answer "what does
  this file import"; only symbol greps answer "what breaks when this module dies."
- **rev 1 (2026-07-25):** reconciles three sources.
  *From the operator's debt ledger + perimeter scan:* §A2 extraction perimeter,
  §I lockstep collapses, §H migration machinery + backup caveat, the by-surface
  web task split.
  *From the inventory review:* C1 `ingest.ts`/`opml.ts`/`subscribe.ts` are split
  files (and the earlier draft self-contradicted — the fences would NOT have
  died); C2 `pushInEffective` is on the v2 path and deleting `server.ts:14`
  breaks boot; C3 24-of-38 test files exercise the v1 route surface (the release's
  bulk, previously invisible); C4 app.ts is ~15 duplicate route registrations and
  `deps.sources`/`deps.logical` must become required; I1 four missing web files
  incl. the grep-invisible `stream/+server.ts` (`?v2=1`) and the cold-pod
  `+page.server.ts`; I2 delete `compose` outright; I3 whole test sections retire;
  I4 the add/remove-feed blocker dissolves; I5/§J the env+docs surface; M1–M6
  line-ref corrections (`loadConfig` not `parseConfig`; `THIN_PING_FLOOR_MS` needs
  no collapse; `PushTarget` is a separate type import; `cloudScheme` re-point).
  *From the parity audit:* Part 1 in full — GAP 1 (the one defect the deletion
  creates), GAP 2 (autodiscovery, already-live, deferred), GAP 3
  (`federation-demo.mjs`), P1–P6, and the data-reachability verification.
