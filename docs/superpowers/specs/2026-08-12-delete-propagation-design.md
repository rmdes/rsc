# Delete propagation across RSC federation — design

**Status:** specced, not yet planned · **Date:** 2026-08-12 · **Grounded at HEAD `653b5e9`**

Promotes the `ideas.md` entry *"Delete propagation — an origin-side tombstone
already exists; nothing broadcasts it and nothing consumes it"* (investigated
2026-07-27 at `6e45e3e`) into an implementable design. That entry's line
numbers have drifted; three of its claims are corrected below.

---

## 1. Problem

When a local post is deleted, `terminallyDelete` removes its content and keeps
a permanent marker. Nothing puts that fact on the wire, and nothing on the
receiving side detects it. Our own instances — rsc.rmdes.be, alice.rmdes.be,
bob.rmdes.be — federate by polling each other's firehose, so a post deleted on
one instance stays visible on the other two indefinitely.

RSS 2.0 and JSON Feed have no deletion concept. Atom does: **RFC 6721**'s
`at:deleted-entry`. This design adopts it rather than inventing vocabulary.

---

## 2. What already exists (verified at `653b5e9`)

Every claim here was read from source during the design session.

**The origin-side tombstone.** `terminallyDelete` (`core/src/logical/local.ts:204-219`)
drops content, revisions and the origin-bridge row, keeps the `logical_items_v2`
row, and inserts `logical_deleted_local_v2 (logical_item_id, canonical_permalink,
deleted_at)`. §2.6's "no content/author/source/remote attribution survives" is
literally true — see §4 for what that costs.

**Permalinks can never be re-owned.** `canonical_permalink` is `NOT NULL UNIQUE`
(`core/src/logical/schema.ts:70`), and `localPermalinkOwner`
(`core/src/logical/reconcile.ts:216-227`) checks the marker table *before* the
ordinary identity lookup, so a deleted permalink can never be resurrected — not
even by a remote echo of our own item.

**Threads already render deletions.** `projectThread`
(`core/src/logical/threading.ts:338-383`) builds its node set purely from
`logical_items_v2`, never touching `posts` or the marker table. A deleted item
keeps its row, receives no DTO, and falls to the placeholder branch
(`:428-433`); `web/src/lib/ThreadPlaceholder.svelte` renders it as
"Post unavailable". **`ideas.md`'s claim that no deleted-state handling exists
is wrong at current HEAD.**

**Membership is a URL-prefix derivation, not a table.** `instancePrefix` /
`prefixUpperBound` / `approvedInstanceFor` (`core/src/logical/membership.ts:9-23`)
define a member as any `remote_sources_v2` row whose `canonical_url` falls under
an approved instance's prefix. Range-queried, EXPLAIN-plan-tested (`:37-40`),
migration-healed (`:103`). Two inherited nuances: http and https on one host
deliberately **do not** group (`:8`), and a row that is itself approved-federated
governs itself and is never a member (F14, `:42-47`).

**Aggregate items still get publisher claims.** `reconcile.ts:370-372` writes
`publisher_claims_v2` rows at `evidenceLevelFor(attribution_mode)`, and
`applySelectionHints` (`:471-496`) recomputes `selected_publisher_id` from those
claims filtered on `governance='allowed'`. It can legitimately be NULL when
governance was revoked.

**The moderation primitive is ready.** `hideItem` / `restoreItem`
(`core/src/logical/moderation.ts:86,89`), `appendItemAudit` (`:54`), and an
`actor_kind` CHECK already admitting `'system'` (`schema.ts:229`). The module
comment (`:18-19`) names "the system-actor emitters" as anticipated callers.
`hideItem`/`restoreItem` currently hardcode `'administrator'` (`:116,127`).

**The injector precedent.** `injectItemElements` (`core/src/domain/feed.ts:271-298`)
injects namespaced elements into `<item>`, keyed by guid, hardened with a
CDATA-blanked search copy against a **demonstrated** body-forgery exploit
(`:262-270`), and tops up `xmlns:source` when absent (`:294-296`).

---

## 3. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | A received deletion **hides** the item — `hideItem` + system-actor audit, reversible | Reuses V3 moderation; no second erasure path; a forged signal is undoable |
| D2 | Trust is anchored on **membership**, not on wire-carried attribution | Consumer already knows the roster; emitter needs to attribute nothing |
| D3 | Emission window: **30 days default, admin-settable, hard cap 25, newest first** | Bounded bytes; a peer down for a weekend still catches up |
| D4 | A withdrawn account's feed returns **200 with a retired marker**, no entries | It cannot enumerate its own deletions (§4); handle is retired permanently |

**D4 in full.** `GET /users/<handle>/feed.xml` for a withdrawn handle returns
`200` with a well-formed channel whose `<title>` marks it withdrawn, a
`<description>` saying the account was removed, **zero `<item>` elements and zero
`at:deleted-entry` elements**. No display name, no dates beyond `withdrawn_at`, no
post count. A handle that never existed still returns `404` — withdrawal is
distinguishable from absence, deliberately, because a subscriber needs to know to
stop expecting items.
| D5 | Handles are **reserved permanently** after account deletion | Forecloses impersonation-by-handle-reuse |
| D6 | Restore is **sticky** | Costs nothing: a ref is deletable exactly once, ever (§2) |
| D7 | Idempotency keys on `ref` alone, never `(ref, when)` | Otherwise a compromised instance defeats D6 by bumping the timestamp |

---

## 4. The attribution constraint

`logical_items_v2` has no author column (`schema.ts:54-63`); local authorship
lived through `logical_local_origins_v2 → posts.author_id`, and
`terminallyDelete` deletes both. **Authorship is unrecoverable after deletion.**

Consequences, accepted rather than worked around:

- Per-user `feed.xml` **cannot** carry deletions — there is no author to filter on.
- A withdrawn account's feed cannot enumerate its deletions (hence D4).
- The parent edge **does** survive (`materializeLocalItem`, `local.ts:57-59`, runs
  before the delete and nothing nulls it), so `comments.xml` **can** carry
  deletions of direct replies via a plain join.

The alternative — adding `author_handle` to the marker — was rejected: it
reverses an invariant asserted in the V3 spec and several code comments, to buy
per-author deletion feeds that our firehose topology does not use.

---

## 5. Wire format

```xml
<at:deleted-entry ref="https://rsc.rmdes.be/post/abc"
                  when="2026-08-12T18:25:00Z"/>
```

Channel-level, sibling of `<item>`. Namespace `http://purl.org/atompub/tombstones/1.0`,
declared on `<rss>` by the same top-up trick as `xmlns:source`. No `atom:source`,
no `at:by`, no `at:comment` — the consumer derives attribution from membership.

**`ref` is the emitted `<guid>`.** For local posts `localGuid`
(`core/src/domain/feed.ts:64-66`) emits `p.url`, which is the absolute permalink
`${publicUrl}/post/${id}` (`local.ts:147`) — byte-identical to the marker's
`canonical_permalink`.

> **Invariant (load-bearing).** This identity holds **only when `publicUrl` is
> configured**. Without it, `posts.url` is NULL, the marker stores the *relative*
> `permalinkFor(id)` = `/post/${id}` (`local.ts:33`) while the feed emits
> `p.guid` — refs no subscriber can match, failing silently.
> **Therefore: emit `at:deleted-entry` only when `publicUrl` is set.**
> `push.ts:207` already gates on the same condition.

`when` is informational only (D7).

---

## 6. The trust gate

Applied per `{ref, when}` on the consuming side. All must pass.

| # | Check | Backed by |
|---|---|---|
| 1 | asserting source holds an approved federation relationship, `governance='allowed'` | existing governance |
| 2 | item's `selected_publisher_id` resolves to a publisher whose `canonical_feed_url` is a **member** of that instance | `approvedInstanceFor` |
| 3 | `ref` falls under that same instance prefix | `instancePrefix` + `prefixUpperBound` |
| 4 | `selected_publisher_id` is **not NULL** | `applySelectionHints` may null it on revoked governance |

A source that merely *relayed* an item cannot retract it: the publisher's URL is
not under its prefix. A news feed with no federation relationship fails gate 1.

**Unknown `ref` → silent no-op, no audit row.** Auditing unknown refs would let a
peer write unbounded rows into `item_audit_v2`.

**Failure → `appendItemAudit`** with `action:'remote_deletion_rejected'`,
`actorKind:'system'`, no state change.

**Pass → `hideItem`** with `actorKind:'system'`, `category:'other'` plus a note.
Riding `'other'` deliberately avoids widening the nine-value `category` CHECK and
its TS enum. This milestone's schema budget is spent on the two things that
cannot be avoided: the `deleted_at` index and the `withdrawn_accounts` table
(both §7). A third change, purely to name a category, is not worth it.

---

## 7. Phases

### Phase ① — local visibility (no wire change)

`projectItem` (`core/src/logical/projector.ts:795-805`) returns `undefined` for a
deleted-local item (line 802: `li.origin !== 'remote'`), so `/post/:id` 404s
instead of showing the placeholder threads already show.

> **Trap.** `projectThread` takes `projectItem` as an **injected callback**
> (`threading.ts:341`). Changing `projectItem`'s contract would also change
> thread rendering — deleted ancestors would stop being placeholders. **Fix the
> route, not the contract**, and regression-test that thread output is unchanged.

Concretely: `GET /post/:id` keeps calling `projectItem` and, on `undefined`,
makes one additional check — is there a `logical_deleted_local_v2` row for this
id? If yes it returns `200` with a deleted-state response carrying **only** the
logical id and `deleted_at` (no author, no content, no title — none of which
survive), which the page renders via `ThreadPlaceholder`. If no, the existing
`404` stands. `projectItem`'s signature and return type do not change, so no
other caller — `projectThread` and `projectLocalActivity` among them — is
affected.

Also settle, explicitly: `threading.ts:94` leaves an *inbound remote* reference to
a deleted post `missing` and adoptable — correct, keep. But `createLocalPost`
(`local.ts:154`) checks only `wouldCycle`, so a **local** reply can still attach to
a deleted item. Note the asymmetry; no change proposed.

### Phase ② — emission

- Index on `logical_deleted_local_v2(deleted_at)` — none exists today
  (`schema.ts:68-71`; PK is `logical_item_id`).
- `recentDeletions(tx, ctx)`: window + cap per D3, setting
  `remote_deletion_window_days` alongside the existing `max_remote_item_age_days`
  (`acquisition.ts:840`).
- `injectDeletions(xml, rows)`: channel-level insert before `</channel>`, using
  the **same CDATA-blanked search copy** as `injectItemElements` — a post body can
  legitimately contain `</channel>`, and the item-level equivalent was a
  demonstrated exploit.
- `withdrawn_accounts (handle, withdrawn_at)`, checked at registration (D5),
  serving the retired-marker feed (D4).
- `onLocalDelete()` — thin pings on the **firehose topic only**: `publishPing` in
  `external` mode, the rssCloud thin ping, and the firehose fat body (regenerable
  without an author). Per-user topics get nothing. **One call per account
  deletion**, not per post — account deletion emits a single reset barrier
  (`local.ts:253`), and `push.ts:200-201` already documents the no-coalescing
  thundering-herd hazard.

**Call sites — all of them, or the feature is broken in one place:**

| Site | File |
|---|---|
| `GET /users/rss.xml` | `core/src/api/logical-routes/read.ts:142` |
| firehose fat ping | `core/src/domain/push.ts:252-256` |
| `comments.xml` | `core/src/api/logical-routes/read.ts:181` |

The fat-ping body **must** be byte-identical to the pulled body — this is the
exact bug `feed.ts` already guards for `source:comments` ("advertise
source:comments before signing, so a subscriber's fat-ping body matches a pull").
Follow the `emittedGuid` precedent (`feed.ts:68-71`): one query, one injector,
never open-coded.

**Not carried:** per-user `feed.xml` (§4), JSON feed (JSON Feed has no deletion
concept — per the `ideas.md` survey, not re-verified here).

### Phase ③ — consumption

- RSS adapter parses channel-level `at:deleted-entry` into
  `normalized.deletions: Array<{ref, when}>`.
- **Deletions are excluded from the content fingerprint**, same rule as
  `contentMarkdown` (`acquisition.ts:135-136`) — otherwise a stable deletion in a
  30-day window re-versions every observation, the failure mode behind the
  `obs-versions` runaway incident.
- Resolve `ref` via `logical_identity_keys_v2` kind `permalink`.
- Gate (§6) → hide or audit-reject.
- Idempotent on `ref` (D7); sticky restore (D6).
- Admin item view: audit trail entry + restore action.

---

## 8. Testing

A green core suite is **known-weak evidence** for this repo's feed and threading
wire format — several green tests have pinned wire-format bugs. Two external
checks are mandatory, not optional:

1. **Backward-compatibility gate, run before emission deploys anywhere.** Feed a
   deletion-carrying document through the *current* acquisition path; assert items
   still parse and reconcile unchanged. That feedsmith ignores unknown
   channel-level namespaced elements is an **assumption to test**, not a premise.
2. **valid.rss.chat** on a feed carrying deletions, including `xmlns:at`
   interacting with `finalizeRss`'s namespace rewrite and the `XML_ILLEGAL` strip
   (`feed.ts:168-175`).

Per phase: ① placeholder renders, thread output unchanged (the injected-callback
regression guard). ② injector unit tests — CDATA-forgery resistance, namespace
top-up, window/cap boundaries, ordering, fat-ping/pull byte equality; golden
files. ③ each gate failing independently, audit-on-rejection, sticky-restore
idempotency, re-observation no-op.

Tests run **in the container** when the dev stack is up, core included; native
type-stripping means vitest passes on type errors, so always run typecheck too.

---

## 9. Rollout

Deliberately asymmetric — the topology is the test rig.

1. Phase ① to all five instances. No wire change.
2. Phase ② to **rsc.rmdes.be only**. alice and bob stay un-updated and must keep
   ingesting the firehose with no behaviour change — the backward-compat gate
   proven live.
3. Phase ③ to **alice only**. Delete a post on rsc; it hides on alice; bob still
   shows it. That asymmetry is the clearest evidence gate and effect both work.
4. Then bob, then rsc.rmendes.net and skyfleet.blue.

**Rollback needs no new machinery.** Emission is additive and ignorable.
Consumption is per-item reversible via `restoreItem`; a globally misbehaving
source is stopped by moving its governance off `allowed`, which gate 1 already
reads. No kill-switch setting.

Push state, deploy state and per-instance state are three different things —
verify each instance rather than trusting a milestone note.

---

## 10. Out of scope

Changes to what `<item>` elements carry · remote **edit** semantics
(`[[Live edits over the wire]]` stands) · consuming deletions from sources
outside the membership graph · visual design of the deleted state beyond reusing
`ThreadPlaceholder.svelte` — that goes to the plan, where `ui-ux-pro-max` is
invoked per CLAUDE.md.

---

## 11. Corrections to `ideas.md`

1. "Nothing renders deleted state" — **wrong**; `projectThread` + `ThreadPlaceholder`
   already do. The gap is `/post/:id` only.
2. `projector.ts:624-628` — now `:795-805`; `threading.ts:293-311` — now `:278-315`.
3. Its `threading.ts` deleted-marker citation for reply detachment points at the
   orphan-**adoption** loop (`:244`), not the thread walk. The reply-resolution
   line is `:94`, and it governs inbound remote references only.

---

## Grounding index

`core/src/logical/local.ts:33,51-66,140-148,200-219,233-254` ·
`core/src/logical/schema.ts:54-71,222-230` ·
`core/src/logical/threading.ts:29,94,244,338-383,428-433` ·
`core/src/logical/projector.ts:372,795-805,891-897` ·
`core/src/logical/reconcile.ts:193-194,216-227,370-381,471-496` ·
`core/src/logical/membership.ts:8-23,37-48,103` ·
`core/src/logical/moderation.ts:18-19,54,86,89,116,127` ·
`core/src/logical/verification.ts:407-416` ·
`core/src/logical/acquisition.ts:132-142,840` ·
`core/src/domain/feed.ts:64-74,168-175,218-220,245,262-302,315-327` ·
`core/src/domain/push.ts:200-283` ·
`core/src/api/logical-routes/read.ts:142,150-181` ·
`core/src/api/logical-routes/shared.ts:24` ·
`core/src/storage/sqlite.ts:1347,1352-1366` ·
`web/src/lib/ThreadPlaceholder.svelte` · RFC 6721
