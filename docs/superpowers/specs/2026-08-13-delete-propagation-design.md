# Delete propagation between federated instances — design

**Status:** rev 2, specced, not yet planned · **Date:** 2026-08-13 ·
**Grounded at HEAD `883935b`**

Rev 1 was reviewed against source and had a false foundation fact plus a central
mechanism that did not do what it claimed. All fifteen findings are folded in;
the changes are recorded in §8. Written under
`docs/superpowers/documentation/spec-authoring-prompt.md`. Everything we intend
to build is marked **PROPOSED**.

**Problem.** rsc.rmdes.be, alice.rmdes.be and bob.rmdes.be federate by polling
each other's firehose. When a post is removed on its origin — by its author or
by an admin acting on moderation — the other instances never learn. Their copies
stay visible, with full content, permanently.

**Requirement (decided).** Deleted at the source means deleted at the reader.
Peers obey; they do not hide, negotiate, or override. Threads continue under a
removed post.

---

## 1. What exists today (verified)

### 1.1 Deletion on the origin

| # | Fact | Source |
|---|---|---|
| F1 | Admin removal and self-serve removal are **the same path**: `DELETE /admin/posts/:id` → `service.deletePost` → `deleteLocalPost` | `api/app.ts:618-622`, `domain/service.ts:147-153` |
| F2 | `terminallyDelete` destroys content, revisions and the `posts` row; keeps the `logical_items_v2` row; inserts a marker `(logical_item_id, canonical_permalink, deleted_at)` carrying **no author and no reason** | `logical/local.ts:204-219` |
| F3 | Account deletion loops F2 per post **passing one shared `now`**, so N posts produce N markers with an identical `deleted_at` | `logical/local.ts:234-236` |
| F4 | Markers are permanent and never swept; `canonical_permalink` is `NOT NULL UNIQUE` and is checked **before** the ordinary identity lookup, so a deleted permalink can never be re-owned | `logical/schema.ts:70`, `logical/reconcile.ts:216-227` |
| F5 | Deletion commits a journal `remove` effect — **but publishes no sequence hint.** `hint()` is called only from the acquisition drains (`runtime.ts:400,415`), and `server.ts:106` emits a hint only on `new-post`. `deleteLocalPost` goes `store.ts:359-360 → db.write` and never reaches the runtime | `logical/local.ts:230`, `logical/runtime.ts:400,415`, `server.ts:106` |
| F6 | Open SSE clients therefore learn of a deletion on their **heartbeat** catch-up, not immediately | `api/logical-routes/public.ts:112` |
| F7 | The item then simply vanishes from the feed — feeds render from the `posts` table | `logical/projector.ts:891-894` |
| F8 | Markers store `cur.url ?? permalinkFor(id)`, and `permalinkFor` is the **relative** `/post/${id}`; the absolute form exists only when `publicUrl` was set at creation time | `logical/local.ts:33,207,147` |

### 1.2 Removal machinery on the consumer side

| # | Fact | Source |
|---|---|---|
| F9 | Ingest is purely additive. Nothing treats an item's disappearance from a feed as meaningful | no such path in `logical/acquisition.ts` |
| F10 | `convertToStructuralTombstone` strips identity keys, publisher claims, conflicts and verification checks and nulls the selection. It does **not** delete deliveries, observation versions or presentation entries, and does **not** emit a journal effect | `logical/threading.ts:293-299` |
| F11 | It is the **tail of a two-step operation**, never a standalone primitive: both existing callers delete delivery- and observation-scoped rows *first*, with an explicit comment that the ordering is required | `logical/tombstones.ts:117-124`, `:271-274` |
| F12 | `reconcile` homes a version via `identityOwner(tx,'delivery', v.delivery_id)`; the `deliveries_v2` row survives tombstoning (nothing in `threading.ts` touches that table), so a later version for the same delivery finds no home and **mints a fresh item with full content** | `logical/reconcile.ts:276`, `logical/threading.ts:293-299` |
| F13 | A tombstoned item is not ordinary-visible, so it projects as a thread **placeholder** — replies beneath it survive and render | `logical/projector.ts:803`, `logical/threading.ts:429-433`, `web/src/lib/ThreadPlaceholder.svelte` |
| F14 | `sweepStructuralTombstones` collapses a childless tombstone; every existing producer sweeps immediately | `logical/threading.ts:306-315`, `logical/local.ts:229`, `logical/tombstones.ts:168,324` |
| F15 | `materializeLocalItem` inserts a `('permalink', …)` identity key for **local** items too, so a permalink lookup can return a local item | `logical/local.ts:61` |

### 1.3 Push transport

| # | Fact | Source |
|---|---|---|
| F16 | A fat WebSub ping's **body is the document**: `websubDeliver` verifies HMAC then calls `acquireSource(id, {kind:'push', document: body})` | `logical/push.ts:305-323` |
| F17 | That path **skips the HTTP fetch** and commits the delivered body through the same bounds profile as a poll | `logical/acquisition.ts:870-884` |
| F18 | A thin rssCloud ping calls the same entry with `document: null` → normal fetch, behind a 30s per-topic floor | `logical/push.ts:341-347` |
| F19 | Outbound push has exactly one trigger, `onLocalPost(entry)`, wired to the single `new-post` bus event. **Deletion fires nothing** | `domain/push.ts:200`, `server.ts:110`, `domain/bus.ts:5-18` |
| F20 | `latestClaim` reads run evidence filtered to `outcome IN ('parsed','completed_truncated')` — a 304 run is invisible to it, deliberately | `logical/push.ts:221-228` |
| F21 | `remote_sources_v2.canonical_url` is **never** rewritten on a permanent redirect; only `source_aliases_v2` gains a row | `logical/acquisition.ts:876-881` |
| F22 | Fat pings are bounded at 5 MB; rssCloud forms at 64 KB | `api/app.ts:147-148` |
| F23 | Only feeds and federation callbacks reach core directly; everything else goes through web | `Caddyfile:23-31`, `cloudron/nginx.conf:30-38` |

### 1.4 feedsmith — measured, not assumed

| # | Result |
|---|---|
| F24 | An unknown channel-level element (`at:deleted-entry`) is **silently dropped**. Items either side of it parse intact |
| F25 | feedsmith is **strictly schema-driven**: `source:someUnknownField`, `source:deletedEntry` and `atom:unknownThing` are all dropped, channel and item level alike |

**F25 is decisive: no vocabulary, standard or invented, reaches our ingest
through `parseRssFeed`.** Anything inside the feed document would require a
hand-rolled extractor over untrusted XML, beside a *demonstrated* body-forgery
exploit of that class (`domain/feed.ts:262-270`).

### 1.5 Sources, membership, feed sizing

| # | Fact | Source |
|---|---|---|
| F26 | `remote_sources_v2` is **config-only** — no poll or cursor state | `storage/sqlite.ts:1475-1483` |
| F27 | `instancePrefix` returns `${protocol}//${host}/`, and http/https on one host deliberately **do not** group | `logical/membership.ts:7-15` |
| F28 | `FEED_LIMIT = 50` is hardcoded; `clampLimit` also defaults to it, and `/users/rss.xml` is a **synchronous** handler. `service` is already on `LogicalReadDeps`, so `service.getSetting` is reachable | `api/logical-routes/shared.ts:24-30`, `read.ts:18-24,141` |
| F29 | Admin settings are `Number(await service.getSetting(key) ?? default)` with a matching number input on `/admin/settings` | `api/app.ts:578-581`, `web/src/routes/admin/settings/+page.svelte:21-32` |

### 1.6 Known-broken, amplified by this milestone

`replyCounts` (`projector.ts:486-505`) runs `if (!nodeVisible(tx, cid)) continue`
**before** pushing that node's children, so an invisible node removes its whole
subtree from the count. `nodeVisible` is false for a tombstone, for an
admin-hidden item, and for any item whose source is not `governance='allowed'`
(`eligibleDeliveries`, `:401-412`). Worked case:

```
A (root, rendered as a timeline card)
└─ B (reply)          ← removed at origin, tombstoned here
   └─ C (reply)       ← still visible, still rendered in the thread
```

A's thread page shows A → "Post unavailable" → C. A's timeline card says
**"0 replies"**. Pre-existing; this milestone makes it routine.

The reply-target gate (`itemOrdinaryVisible`, `:464-466`) is **correct** for
tombstones — it refuses replies into one.

---

## 2. Decisions

**D1 — A received deletion destroys the content. It does not hide it.**
Peers are readers of the origin's feed; a removal at the source is obeyed.
*Implementation is a composed operation, not a single call* (F10, F11): delete
the item's presentation entries, observation versions and **its `deliveries_v2`
rows**, then `convertToStructuralTombstone`, then `sweepStructuralTombstones`.
Deleting the delivery rows is what makes the destruction real *and* closes F12.
*Rejected:* `hideItem` — reversible hiding treats propagation as a dispute
between instances. *Rejected:* calling `convertToStructuralTombstone` alone —
rev 1 did this and would have left the full post body in
`observation_versions_v2` indefinitely while claiming it was destroyed.

**D2 — Only the origin retracts.** An instance emits deletions for its own local
posts only. A peer removing its copy of someone else's post is local moderation
and emits nothing.

**D3 — The signal travels in a separate JSON document, not inside the feed.**
Forced by F25. RFC 6721 permits standalone Deleted Entry Documents, so this stays
within the spirit of the standard while being parseable with `JSON.parse`.

**D4 — No discovery mechanism; the URL is derived** from the source's own
scheme and host, which the consumer already stores.
*Rejected:* advertising it via `atom:link`. Between instances we control, that is
an advertisement, a parse and a persistence step to transmit a computable string.

**D5 — An opaque tuple cursor with server-side paging.**
F3 means an account deletion writes many markers sharing one `deleted_at`, so a
scalar timestamp cursor cannot page inside that group without either skipping the
remainder or looping. The cursor encodes `(deleted_at, logical_item_id)`, the
endpoint pages, and the response carries an explicit next cursor and a
`hasMore` flag.
*Rejected:* rev 1's scalar `?since=<ISO>` with no `nextSince` — a ponytail cut
that was wrong: without paging, an origin's lifetime deletion list eventually
exceeds the consumer's response-size cap and **no new peer can ever bootstrap**.

**D6 — A deletion-specific bus event.**
There is nothing existing to subscribe to (F5), and subscribing push to
`onSequenceHint` would fire the outbound ping on *every* journal effect —
including every remote item ingested, which between peers is a feedback loop.
Add a third bus event alongside `new-post` and `seq-hint`, emitted by the
deletion paths, and wire push to it.
*Rejected:* rev 1's "the signal already exists, push just doesn't subscribe."

**D7 — Cursor advances only on successful application**, never merely on fetch.
Gate rejections are transient (membership is derived over time), while a cursor
advance is permanent.

**D8 — `FEED_LIMIT` becomes an admin setting**, independent of deletion.

**D9 — Ordinary users can delete their own posts from the web UI.**
Today both surfaces are `isAdmin`-gated and `DELETE /me/posts/:id` is
API-key-only with no `web/` caller. Deletion must be a user action, or this
milestone federates something most people cannot do.

**D10 — Fix the reply-count subtree bug (§1.6) first**, and **descend
unconditionally**. This also makes replies under admin-hidden and
blocked-source parents count toward a visible ancestor. That is deliberate: a
reply that renders in the thread should be counted by the card above it,
whatever happened to its parent.

---

## 3. What we build — all PROPOSED

### 3.1 Origin side

- **`GET /deletions.json`** *(PROPOSED)* — public, unauthenticated, in
  `api/logical-routes/read.ts` beside the feed routes. Accepts `?cursor=<opaque>`
  and pages by `(deleted_at, logical_item_id)`. House style: `c.json(...)`,
  hand-rolled param validation, no zValidator, no HTTPException.
  ```json
  { "deletions": [ { "ref": "https://rsc.rmdes.be/post/abc",
                     "deletedAt": "2026-08-13T08:00:00Z" } ],
    "nextCursor": "…", "hasMore": false }
  ```
  `ref` is the emitted `<guid>` — `localGuid` emits `p.url` (`feed.ts:64-66`),
  the absolute permalink stored as `canonical_permalink`.
- **Filter markers to this instance's own absolute permalinks** *(PROPOSED)* —
  `canonical_permalink LIKE publicUrl || '/post/%'`. F8 means historical markers
  can be relative, or carry a previous domain; peers would silently drop those at
  the gate. An instance-wide "is `publicUrl` set" check is not enough.
- **Index on `logical_deleted_local_v2(deleted_at, logical_item_id)`**
  *(PROPOSED)* — none exists (`schema.ts:68-71`); the paging query needs it.
- **Proxy exposure** *(PROPOSED)* — add `/deletions.json` to the `@core` matcher
  in `Caddyfile` **and** a `location` in `cloudron/nginx.conf` (F23). Without
  both, peers cannot reach it — and only in production.
- **Deletion bus event + ping** *(PROPOSED)* — emit from `deleteLocalPost` and
  once from `deleteLocalAccount` (F3 commits a single barrier, and
  `push.ts:198-199` documents the no-coalescing hazard). Push fires the existing
  firehose ping on it. This also fixes the origin's own delayed SSE update (F6).

### 3.2 Consumer side

- **Fetch, for approved federated sources only** *(PROPOSED)* — gate on an
  approved `federation_relationships_v2` row. Fetching for *every* remote source
  would issue an outbound request per poll to arbitrary third-party hosts
  (podcasts, blogs) that will 404.
- **Derive the URL** *(PROPOSED)* from the source's own scheme and host.
- **Reuse the secondary-fetch precedent** *(PROPOSED)* — origin verification
  already performs a gated fetch during acquisition using `isPrivateIp` from
  `domain/push-guard.ts`, an injected `lookupFn`, `AbortSignal.timeout` and a
  `blocked_target` outcome (`logical/verification.ts:3,46,142,166-173`).
- **Bounds** *(PROPOSED)*: a response-size cap — which bounds `JSON.parse` and
  therefore the entry count — plus rejection of any entry whose `ref` is not an
  absolute `http(s)` URL. Untrusted remote input.
- **Resolve** *(PROPOSED)*: `ref` → `logical_identity_keys_v2` kind `permalink`,
  **excluding `origin='local'`** (F15 — a permalink key exists for local items
  too, and F10 is explicitly not for them). `localPermalinkOwner`
  (`reconcile.ts:216-227`) is the existing precedent for that exclusion.
- **Gate** *(PROPOSED)*: the asserting source holds an approved federation
  relationship, and the `ref`'s **host** equals the source's host. Compare with
  `new URL` on both sides, not `startsWith` on a scheme-bearing prefix: F21 means
  a peer registered once as `http://` keeps that scheme forever, so prefix
  comparison against `https://` permalinks rejects every deletion. Host equality
  is a deliberate divergence from `instancePrefix`'s scheme-split semantics (F27),
  justified because the pairing is an explicitly approved federation
  relationship. It also normalizes `PEER`/`peer:443` forms; the trailing-slash
  protection against `peer.evil.com` is preserved by comparing hosts, not
  prefixes.
- **Apply** *(PROPOSED)*: D1's composed operation, plus a system-actor
  `item_audit_v2` row (`actor_kind` already admits `'system'`, `schema.ts:229`),
  plus `sweepStructuralTombstones(tx, [id], now)` — without the sweep, deleting a
  post that has no replies here leaves a permanent orphan row (F14).
- **Emit a journal effect** *(PROPOSED)* — `{ kind: 'remove', logicalItemId,
  changeMask: 'presentation' }`, matching the origin (`local.ts:230`). **Not** a
  `reset` barrier, which would make every client refetch its whole timeline for
  one item. `convertToStructuralTombstone` emits none of its own (F10).
- **Retraction record** *(PROPOSED)* — `retracted_permalinks_v2 (permalink,
  source_id, retracted_at)`, consulted before identity resolution, mirroring the
  origin's own marker (F4). D1's delivery-row deletion closes the same-delivery
  resurrection (F12); this closes a *new* delivery arriving for the same
  permalink from a cached or stale body. Earned by a verified mechanism, not
  speculation.
- **Cursor storage** *(PROPOSED)*: `remote_sources_v2` is config-only (F26).
  Carry the cursor on `acquisition_runs_v2` like `push_capability_json`, but
  **the reader must not copy `latestClaim`'s outcome filter** (F20): 304 is the
  steady state for a quiet peer, so a cursor invisible on 304 runs either never
  advances or is written where the reader never looks. A run that commits but
  whose deletions fetch failed carries the **previous** cursor forward, never
  NULL. If that proves awkward in the plan, a dedicated table is the fallback —
  decided there, with the reason recorded.

### 3.3 Feed sizing (D8)

- **`feed_item_limit` setting** *(PROPOSED)*, default 50, on `/admin/settings`
  per F29. Replaces the constant at the three render call sites **and in
  `clampLimit`** (F28) — otherwise the timeline default silently diverges from
  the feed setting. `/users/rss.xml` must become `async`; `service.getSetting` is
  already reachable from `LogicalReadDeps`.

### 3.4 Self-serve deletion (D9)

- **Ungate the web delete surfaces** *(PROPOSED)*: show the control when the
  viewer is the post's author, not only for admins
  (`+page.svelte:231`, `post/[id]/+page.svelte:104`). Admins keep their reach
  over any local post.
- **A session-authenticated delete path** *(PROPOSED)*: `DELETE /me/posts/:id`
  already enforces the right rule — local post, `authorId === me.id`, else 403
  (`personal.ts:141`) — but is mounted behind `apiKeyAuth`. Follow the existing
  `authed` middleware-factory pattern.
- **No new deletion semantics** — it routes to the same `service.deletePost` (F1),
  so propagation, journal effect and ping are identical for both.

### 3.5 Reply-count fix (D10)

- **Descend past invisible nodes** *(PROPOSED)* in `replyCounts`
  (`projector.ts:486-505`): keep the visibility test for whether a node is
  *counted*, always enumerate its children. Regression test: the §1.6 case must
  report 1, not 0 — plus explicit cases for admin-hidden and blocked-source
  parents, whose counts change deliberately (D10).

---

## 4. What could go wrong

| Risk | Detection |
|---|---|
| A tombstoned item is resurrected by its own surviving delivery | Closed by D1 deleting `deliveries_v2` rows; assert no logical item is minted for a retracted permalink |
| A new delivery arrives for a retracted permalink from a stale body | Closed by the retraction record (§3.2) |
| Cursor skew loses deletions sharing one `deleted_at` | The tuple cursor (D5); test an account deletion of N > page-size posts |
| A fresh peer can never bootstrap | Server-side paging (D5); test a consumer starting with no cursor against an origin with more deletions than one page |
| Deletions silently rejected forever on a scheme mismatch | Host-equality comparison (§3.2); test an `http://`-registered peer emitting `https://` permalinks |
| Cursor advances past a transiently rejected deletion | D7 — advance on application, not fetch |
| A hostile instance retracts items it did not publish | The §3.2 gate; count and log rejections |
| Ping storm or peer-to-peer feedback loop | D6's dedicated event, never `onSequenceHint` |

---

## 5. Testing

- **No feed bytes change at all.** With D4's derived URL nothing is added to any
  feed document, so an un-updated peer sees byte-identical feeds. Assert it
  (golden-file feed output unchanged) rather than assuming — it is the claim the
  rollout rests on.
- **Destruction is real:** after applying a deletion, assert no rows remain in
  `observation_versions_v2`, `presentation_entries_v2` or `deliveries_v2` for
  that item. This is the assertion rev 1 would have failed.
- **Paging:** an account deletion of N > page-size posts sharing one timestamp
  drains completely across successive fetches.
- **Gate:** each condition failing independently; a forged `ref` for another
  host; an `http`/`https` mismatch; an unknown `ref`; a `ref` resolving to a
  local item (F15).
- **Live update:** applying a deletion emits exactly one journal `remove` effect,
  not a `reset` barrier.
- **Thread continuity:** replies under a tombstoned parent still render.
- **Sweep:** deleting a childless item leaves no orphan row.
- Tests run **in the container**; type-stripping means vitest passes on type
  errors, so run `tsc --noEmit` too.

---

## 6. Rollout

1. **Reply-count fix (§3.5) and `feed_item_limit` (§3.3)** — local, no wire
   change, all five instances. The count fix precedes any propagation (D10).
2. **Self-serve deletion (§3.4)** — local, all instances. Deletion becomes a user
   action before it becomes a federated one.
3. **Origin side** (§3.1) to **rsc.rmdes.be only**. alice and bob, un-updated,
   must keep ingesting with no behaviour change.
4. **Consumer side** (§3.2) to **alice only**. Delete a post on rsc; it is
   destroyed on alice; bob still shows it. That asymmetry proves gate and effect
   together.
5. bob, then rsc.rmendes.net and skyfleet.blue.

Push state, deploy state and per-instance state are three different things —
verify each instance.

---

## 7. Open questions

- **O1 — is a deletion reason ever carried?** F2 stores none, so "removed by a
  moderator" and "deleted by its author" are indistinguishable by construction.
  Nothing decided so far depends on it.
- **O2 — should peers learn an *account* is gone**, as distinct from N posts
  being deleted? Nothing in this design depends on the answer.

---

## 8. Changes from rev 1

Fifteen review findings, each verified against source before folding.

**Critical.** F5 was false — deletion publishes no sequence hint, so D6's premise
did not exist (now a dedicated bus event).

**Major.** `convertToStructuralTombstone` does not destroy content and is the
tail of a two-step operation, so rev 1 would have kept the full post body while
claiming deletion (D1 is now a composed operation) · the surviving
`deliveries_v2` row resurrects the item via `identityOwner` · a scalar ISO cursor
cannot page an account deletion's shared timestamp · no paging meant no peer
could ever bootstrap once the list exceeded the response cap · the
`acquisition_runs_v2` cursor read would have been blind to 304 runs · advancing
the cursor on fetch loses transiently rejected deletions · scheme-split prefix
comparison silently rejects every deletion from an `http://`-registered peer ·
subscribing push to `onSequenceHint` pings on every journal effect and loops
between peers · §3.2 still said "sources that advertise the link" after D4
removed discovery.

**Minor.** Permalink resolution could return a local item · no
`sweepStructuralTombstones` call left orphan rows · the `publicUrl` check was
instance-wide while markers are historical · `feed_item_limit` missed
`clampLimit` and the sync firehose handler · the count fix changes admin-hidden
and blocked-source subtrees too, now decided explicitly (D10).
