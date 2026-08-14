# Delete propagation between federated instances — design

**Status:** rev 3, ready to plan · **Date:** 2026-08-14 · **Grounded at HEAD `feccb85`**

**Problem.** rsc.rmdes.be, alice.rmdes.be and bob.rmdes.be federate by polling
each other's firehose. When a post is removed on its origin — by its author or
by an admin acting on moderation — the peers never learn. Their copies stay
visible, with full content, permanently.

**Requirement.** Deleted at the source means deleted at the reader. Peers obey;
they do not hide or override. Threads continue under a removed post.

**Altitude.** This spec names seams, decisions and constraints. It does **not**
prescribe SQL orderings, cursor codecs or call sequences — two review rounds
were spent catching invented implementation detail sitting next to house
functions that already did the job. Where a house function exists, it is named
and the plan follows it.

---

## 1. What exists today (verified at `feccb85`)

**Deletion on the origin.** `DELETE /admin/posts/:id` and the self-serve route
are the same path (`api/app.ts:618-622` → `domain/service.ts:147-153` →
`deleteLocalPost`). `terminallyDelete` destroys content, revisions and the
`posts` row, keeps the `logical_items_v2` row, and writes a permanent marker
`(logical_item_id, canonical_permalink, deleted_at)` with **no author and no
reason** (`logical/local.ts:204-219`). Account deletion loops it with one shared
`now`, so N posts yield N markers with an identical timestamp (`:234-236`).
Markers are never swept and `canonical_permalink` is UNIQUE, checked before the
ordinary identity lookup, so a deleted permalink can never be re-owned
(`logical/schema.ts:70`, `logical/reconcile.ts:216-227`).

Markers store `cur.url ?? permalinkFor(id)`, and `permalinkFor` is the
**relative** `/post/${id}` — the absolute form exists only when `publicUrl` was
set at creation (`logical/local.ts:33,147,207`).

**Deletion publishes no sequence hint.** `hint()` fires only from the acquisition
drains (`logical/runtime.ts:400,415`) and `server.ts:106` emits one only on
`new-post`; `deleteLocalPost` never reaches the runtime. Open SSE clients learn
of a deletion on their heartbeat catch-up (`api/logical-routes/public.ts:112`).
The bus lives at the **service** layer — `logical/local.ts` is tx-level and has
no bus; `bus.emitNewPost` is called after the write returns
(`domain/service.ts:46,53`).

**Removal machinery on the consumer side.** `convertToStructuralTombstone`
strips identity keys, claims, conflicts and verification checks and nulls the
selection — it deletes **no** deliveries, observation versions or presentation
entries, and emits no journal effect (`logical/threading.ts:293-299`). It is the
tail of a two-step operation: both existing callers delete evidence first
(`logical/tombstones.ts:117-124`, `:271-274`). **`deleteObservationVersions`
(`logical/tombstones.ts:205-213`) is the house function for that step** and
handles the RESTRICT ordering; `foreign_keys = ON` (`storage/sqlite.ts:1713`),
so that ordering is load-bearing.

A tombstoned item projects as a thread placeholder, so replies beneath it
survive and render (`logical/projector.ts:803`, `logical/threading.ts:429-433`,
`web/src/lib/ThreadPlaceholder.svelte`). `sweepStructuralTombstones` collapses a
childless tombstone and every existing producer sweeps immediately
(`logical/threading.ts:306-315`, `logical/tombstones.ts:168,324`) — note it
routes through `deleteLogicalNode`, which **deletes `item_audit_v2` rows for
that item** (`logical/threading.ts:282`).

**Resurrection.** `reconcile` homes a version via `identityOwner('delivery', …)`
(`logical/reconcile.ts:276`), and the code states the consequence verbatim:
*"A NEW delivery cannot reach here — a tombstone's identity keys are stripped,
so convergence creates a fresh item"* (`:388`). The stripped key is the cause;
deleting the `deliveries_v2` row does not change it.

**Identity keys are normalized**, `ref` is not: keys hold
`normalizePermalink(...)` (`logical/roots.ts:34-44`) while a marker holds the raw
`cur.url`.

**Push transport.** A fat WebSub ping's body *is* the document and skips the
fetch (`logical/push.ts:305-323`, `logical/acquisition.ts:870-884`); a thin
rssCloud ping re-fetches behind a 30s floor (`logical/push.ts:341-347`). Push has
one trigger, `onLocalPost(entry)`, wired to `new-post` (`domain/push.ts:200`,
`server.ts:110`) — it derives topics from `entry.author` and in `self` mode
regenerates the per-author body. Deletion fires nothing. Run evidence is read
with an outcome filter (`logical/push.ts:221-228`); runs are inserted
`processing`/`pending` **before** the fetch (`logical/acquisition.ts:506-508`)
and `verification.ts:363-367` mints synthetic terminal runs.
`remote_sources_v2.canonical_url` is never rewritten on a permanent redirect
(`logical/acquisition.ts:876-881`). Only feeds and federation callbacks reach
core directly (`Caddyfile:23-31`, `cloudron/nginx.conf:30-38`).

**feedsmith is strictly schema-driven** (measured): unknown channel elements,
`source:someUnknownField` and `atom:unknownThing` are all dropped, while sibling
items parse intact. **No vocabulary reaches our ingest through `parseRssFeed`.**

**Sources and sizing.** `remote_sources_v2` is config-only
(`storage/sqlite.ts:1475-1483`). `instancePrefix` returns `${protocol}//${host}/`
and http/https deliberately do not group (`logical/membership.ts:7-15`).
`FEED_LIMIT = 50` is hardcoded and `/users/rss.xml` is a **sync** handler
(`api/logical-routes/shared.ts:24`, `read.ts:141`). An opaque tuple-cursor codec
already exists (`domain/source-repository.ts:188-196`). Admin settings follow
`Number(await service.getSetting(key) ?? default)` (`api/app.ts:578-581`).
Web's delete helper posts to `/admin/posts/:id` (`web/src/lib/api.ts:151-152`),
and both UI surfaces are `isAdmin`-gated (`web/src/routes/+page.svelte:231`,
`post/[id]/+page.svelte:104`); `DELETE /me/posts/:id` enforces author-ownership
but is API-key-only with no web caller
(`api/logical-routes/personal.ts:137-145`).

**Known-broken, amplified here.** `replyCounts` skips an invisible node's whole
subtree (`logical/projector.ts:486-505`), and `nodeVisible` is false for a
tombstone, an admin-hidden item, and any non-`allowed` source. A card can read
"0 replies" above a thread that shows two. `COUNT_NODE_BOUND = 5000` bounds the
walk (`:483`).

---

## 2. Decisions

**D1 — A received deletion destroys the content.** Evidence first via
`deleteObservationVersions`, then `convertToStructuralTombstone`, then
`sweepStructuralTombstones`. The plan follows those functions' own contracts for
ordering. *Rejected:* `hideItem` (reversible hiding treats propagation as a
dispute); calling `convertToStructuralTombstone` alone (leaves the body on disk).

**D2 — Only the origin retracts.** An instance emits for its own local posts
only.

**D3 — The signal is a separate JSON document**, not in the feed. Forced by
feedsmith being schema-driven; RFC 6721 permits standalone Deleted Entry
Documents.

**D4 — The URL is derived** from the source's own scheme and host. No discovery
mechanism.

**D5 — Opaque tuple cursor, ascending, server-side paging**, using the existing
codec. Ascending is explicit: consumers drain forward, unlike every other cursor
here. Account deletions share one timestamp, so a scalar cursor cannot page.

**D6 — A deletion event on the bus, emitted at the service layer** (beside
`emitNewPost`), never from `logical/local.ts`, and never `onSequenceHint` —
which fires on every journal effect and would loop between peers. It carries the
author handle, captured before the delete, so the existing per-author and
firehose topics can both be pinged.

**D7 — Cursor outcomes are three-way**: applied → advance; permanently
inapplicable (unknown `ref`, failed host check, item never ingested or already
retention-trimmed) → advance; retryable (federation relationship not yet
approved) → hold. Two-way "advance only on success" wedges the cursor forever on
the first unknown ref, which is the common case.

**D8 — `feed_item_limit` is an admin setting** governing **feed rendering only**.
It does not touch `clampLimit`, which is API pagination with its own hard cap.

**D9 — Ordinary users can delete their own posts.** Web must route an author's
delete to the session-authed self-serve path while admins keep `/admin/posts/:id`
for others' posts.

**D10 — Fix the reply-count subtree bug first, descending unconditionally.**
Replies under admin-hidden and blocked-source parents will start counting; that
is deliberate — a reply that renders should be counted.

**D11 — The audit trail is best-effort.** `item_audit_v2` rows are destroyed by
`deleteLogicalNode` when the sweep collects a childless tombstone, and the FK is
RESTRICT so writing after the sweep throws. Accepted rather than adding a store
that outlives the node: the deletion is durable in the retraction record, and the
audit is a convenience.

**D12 — `retracted_permalinks_v2` carries no FK to the source.** A RESTRICT child
would block purge and orphan reap (`PURGE_INVENTORY`,
`logical/tombstones.ts:50-64`); adding it to the inventory would drop retraction
protection exactly when a source can be re-added. Store the source URL as plain
text.

**D13 — `/deletions.json` is gated to approved federated peers.** It would
otherwise be a permanent, public, machine-readable list of every permalink the
instance ever deleted — including every post of an account that used
delete-my-account, which contradicts what that path promises.

**D14 — Host-level is the accepted retraction granularity**, stated rather than
inherited: any approved federated source on a host may retract any permalink on
that host. Acceptable because peers are one instance per host. Revisit if a
path-multiplexed peer is ever federated.

---

## 3. What we build — all PROPOSED

**Origin.** `GET /deletions.json`, gated to approved peers (D13), paging
ascending with the existing cursor codec, in `api/logical-routes/read.ts` beside
the feeds. Entries are `{ ref, deletedAt }`; `ref` must be **normalized the same
way identity keys are**, and only this instance's own absolute permalinks are
served — historical markers can be relative or carry a previous domain. Add the
path to `Caddyfile`'s `@core` matcher **and** `cloudron/nginx.conf`, or peers
cannot reach it in production only. Index the marker table for the paging query.
Emit the D6 event from `service.deletePost` and once per `deleteLocalAccount`,
and ping the affected per-author topic plus the firehose.

**Consumer.** For approved federated sources only, derive the URL and fetch it
during acquisition, reusing origin verification's gated-fetch pattern
(`isPrivateIp`, injected `lookupFn`, timeout, `blocked_target` outcome —
`logical/verification.ts`). Cap the response size. Normalize and resolve `ref`,
excluding `origin='local'` (a permalink key exists for local items too;
`localPermalinkOwner` is the precedent). Gate on an approved federation
relationship and host equality, compared with `new URL` — a peer registered as
`http://` keeps that scheme forever, so prefix comparison would reject
everything. Apply D1, write the retraction record, emit a journal `remove`
effect (not a `reset` barrier — `convertToStructuralTombstone` emits none), and
consult the retraction record before identity resolution so a later delivery
cannot resurrect the item. Advance the cursor per D7. Store the cursor as run
evidence, reading only runs that actually carry one — the newest run is often
the in-flight `pending` one or a synthetic verification run.

**Feed sizing.** `feed_item_limit` on `/admin/settings`, applied at the three
feed render sites; `/users/rss.xml` becomes async (`service.getSetting` is
already reachable).

**Self-serve deletion.** Ungate the two UI surfaces for the author, and branch
web's delete helper: author → session-authed self-serve, admin on someone else's
post → `/admin/posts/:id`. No new deletion semantics — both route to
`service.deletePost`.

**Reply counts.** Count a node only when it would render, but always enumerate
its children.

---

## 4. Testing

- **No feed bytes change** — golden-file feed output unchanged. The rollout rests
  on it.
- **Destruction is real** — no observation versions, presentation entries or
  deliveries remain for the item.
- **No resurrection** — a later delivery for a retracted permalink mints nothing.
- **Paging** — an account deletion of N > page-size posts sharing one timestamp
  drains completely.
- **Bootstrap** — a consumer with no cursor drains an origin with many deletions.
- **Cursor never wedges** — an unknown `ref` and a failed host check both advance;
  an unapproved relationship holds.
- **Gate** — each condition failing independently; a forged host; an `http`/`https`
  mismatch; a `ref` resolving to a local item.
- **Live update** — exactly one journal `remove` effect, not a `reset`.
- **Thread continuity** — replies under a tombstoned parent still render.
- **Sweep** — deleting a childless item leaves no orphan row.
- **Counts** — the §1 case reports 1 not 0; plus admin-hidden and blocked-source
  parents (changed deliberately) and a subtree large enough to test
  `COUNT_NODE_BOUND`.

Tests run in the container; type-stripping means vitest passes on type errors,
so run `tsc --noEmit` too.

---

## 5. Rollout

1. Reply counts + `feed_item_limit` — local, no wire change, all instances.
2. Self-serve deletion — local, all instances.
3. Origin side to **rsc.rmdes.be only**; alice and bob must keep ingesting
   unchanged.
4. Consumer side to **alice only**. Delete on rsc → destroyed on alice, still
   visible on bob. That asymmetry proves gate and effect together.
5. bob, then rsc.rmendes.net and skyfleet.blue.

Push state, deploy state and per-instance state are three different things.

---

## 6. Open questions

- Should a deletion carry a **reason**? Markers store none, so moderator removal
  and author deletion are indistinguishable by construction. Nothing here depends
  on it.
- Should peers learn an **account** is gone, distinct from N posts being deleted?
  Nothing here depends on it.
