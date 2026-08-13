# Delete propagation between federated instances — design

**Status:** specced, not yet planned · **Date:** 2026-08-13 · **Grounded at HEAD `0715711`**

Written under `docs/superpowers/documentation/spec-authoring-prompt.md`. Every
claim in §1 was read from source in the authoring session; everything we intend
to build is marked **PROPOSED**. Supersedes the reverted `056445b`, which rested
on unverified claims.

**Problem.** rsc.rmdes.be, alice.rmdes.be and bob.rmdes.be federate by polling
each other's firehose. When a post is removed on its origin — by its author or
by an admin acting on moderation — the other instances never learn. Their copies
stay visible, with full content, permanently.

---

## 1. What exists today (verified)

### 1.1 Deletion on the origin

| # | Fact | Source |
|---|---|---|
| F1 | Admin removal and self-serve removal are **the same path**: `DELETE /admin/posts/:id` → `service.deletePost` → `deleteLocalPost` | `api/app.ts:618-622`, `domain/service.ts:147-153` |
| F2 | `terminallyDelete` destroys content, revisions and the `posts` row; keeps the `logical_items_v2` row; inserts a marker `(logical_item_id, canonical_permalink, deleted_at)` carrying **no author and no reason** | `logical/local.ts:204-219` |
| F3 | Account deletion loops F2 per post, then drops follows, push subs and the `users` row, under **one** journal `reset` barrier | `logical/local.ts:233-254` |
| F4 | Markers are permanent and never swept; `canonical_permalink` is `NOT NULL UNIQUE` and is checked before the ordinary identity lookup, so a deleted permalink can never be re-owned | `logical/schema.ts:70`, `logical/reconcile.ts:216-227` |
| F5 | Deletion commits a journal `remove` effect, which publishes an ordered sequence hint | `logical/local.ts:230`, `server.ts:43` |
| F6 | The item then simply vanishes from the feed — feeds render from the `posts` table | `logical/projector.ts:891-894` |

### 1.2 Consumption

| # | Fact | Source |
|---|---|---|
| F7 | Ingest is purely additive. Nothing treats an item's disappearance from a feed as meaningful | no such path in `logical/acquisition.ts` |
| F8 | `convertToStructuralTombstone` strips identity keys, publisher claims, conflicts and verification checks, nulls the selected delivery/publisher, and **keeps the row, its parent edge and sort key** | `logical/threading.ts:293-299` |
| F9 | A tombstoned item is not ordinary-visible, so it projects as a thread **placeholder** — replies beneath it survive and render | `logical/projector.ts:803`, `logical/threading.ts:429-433`, `web/src/lib/ThreadPlaceholder.svelte` |
| F10 | `sweepStructuralTombstones` collapses a tombstone once it has no children left | `logical/threading.ts:306-315` |
| F11 | It is already used exactly this way for items whose source is blocked or purged | `logical/tombstones.ts:166,323` |

### 1.3 Push transport

| # | Fact | Source |
|---|---|---|
| F12 | A fat WebSub ping's **body is the document**: `websubDeliver` verifies HMAC then calls `acquireSource(id, {kind:'push', document: body})` | `logical/push.ts:305-323` |
| F13 | That path **skips the HTTP fetch** and commits the delivered body through the same bounds profile as a poll | `logical/acquisition.ts:870-884` |
| F14 | A thin rssCloud ping calls the same entry with `document: null` → normal fetch, behind a 30s per-topic floor | `logical/push.ts:341-347` |
| F15 | Outbound push has exactly one trigger, `onLocalPost(entry)`, wired to the single `new-post` bus event. **Deletion fires nothing** | `domain/push.ts:200`, `server.ts:110`, `domain/bus.ts:5-18` |
| F16 | Fat pings are bounded at 5 MB; rssCloud forms at 64 KB | `api/app.ts:147-148` |
| F17 | Only feeds and federation callbacks reach core directly; everything else goes through web | `Caddyfile:23-31`, `cloudron/nginx.conf:30-38` |

### 1.4 feedsmith — measured, not assumed

Probed against the installed `feedsmith@^2.9.6` during authoring.

| # | Result |
|---|---|
| F18 | An unknown channel-level element (`at:deleted-entry`) is **silently dropped**. Items either side of it parse intact — so emitting one is backward-compatible, but **unreadable by our own ingest** |
| F19 | feedsmith is **strictly schema-driven**: `source:markdown` survives, `source:someUnknownField`, `source:deletedEntry` and `atom:unknownThing` are all dropped, at channel and item level alike |
| F20 | **`atom:link` at channel level does survive**, as does `<source url>`, `source:inReplyTo` and `atom:updated` at item level |

**F19 is the decisive constraint: no vocabulary, standard or invented, can reach
our ingest through `parseRssFeed`.** Anything inside the feed document would
require a hand-rolled extractor over untrusted XML — next to a *demonstrated*
body-forgery exploit of exactly that class (`domain/feed.ts:262-270`).

### 1.5 Feed sizing

| # | Fact | Source |
|---|---|---|
| F21 | `FEED_LIMIT = 50` is hardcoded, used by the firehose and both per-user feed routes | `api/logical-routes/shared.ts:24`, `read.ts:142,163,173` |
| F22 | Admin settings are `Number(await service.getSetting(key) ?? default)` with a matching number input on `/admin/settings` | `api/app.ts:578-581`, `web/src/routes/admin/settings/+page.svelte:21-32` |

### 1.6 Known-broken, in scope because this milestone amplifies it

`replyCounts` (`projector.ts:486-505`) runs `if (!nodeVisible(tx, cid)) continue`
**before** pushing that node's children, so an invisible node removes its whole
subtree from the count.

A structural tombstone *is* invisible here — `eligibleDeliveries` reads delivery
identity keys (`:401-402`) and `convertToStructuralTombstone` deletes them
(`threading.ts:294`) — so this fires on every propagated deletion that lands
mid-thread, which is where federated replies live. Worked case:

```
A (root, rendered as a timeline card)
└─ B (reply)          ← deleted at origin, tombstoned here
   └─ C (reply)       ← still visible, still rendered in the thread
```

A's thread page shows A → "Post unavailable" → C. A's timeline card says
**"0 replies"**. The two disagree about the same conversation.

Pre-existing: the same happens today for a locally deleted mid-thread post (no
`posts` row ⇒ invisible). This milestone makes it routine and cross-instance.

**Fix:** count a node only when it would render, but descend into its children
regardless. One change, both directions.

Note the reply-target gate (`itemOrdinaryVisible`, `:464-466`) is **correct** for
tombstones — it refuses replies into one, which is what we want. The
`hidden_at` half of the 2026-08-13 review does not apply here, because D1 uses
tombstoning rather than `hideItem`. Full context:
`docs/superpowers/reviews/2026-08-13-deletion-visibility-findings.md`.

---

## 2. Decisions

**D1 — A received deletion deletes. It does not hide.**
The consumer calls `convertToStructuralTombstone` (F8): content, author, source
and evidence are destroyed; the row, parent edge and sort key remain so the
thread continues (F9). Alice and Bob are *readers* of rsc's feed — a moderation
decision at the source is obeyed, not negotiated.
*Rejected:* `hideItem`. Reversible hiding treats propagation as a rights dispute
between instances; it isn't. Also rejected: `deleteLogicalNode`, which would
orphan the replies underneath.

**D2 — Only the origin retracts.**
An instance emits deletions for **its own local posts only**. Alice removing her
copy of someone else's post is her own moderation of her own database; she is not
the source and emits nothing. Alice deleting *alice's* post propagates by the
identical mechanism, because there she is the source.

**D3 — The signal travels in a separate JSON document, not inside the feed.**
Forced by F19. RFC 6721 explicitly permits standalone Deleted Entry Documents, so
this stays within the spirit of the standard while being parseable with
`JSON.parse` instead of a bespoke XML extractor.
*Rejected:* `at:deleted-entry` inside the RSS channel — correct vocabulary, but
F18/F19 mean we would have to hand-roll XML extraction over untrusted input in
the most exploit-prone part of this codebase, to serve third-party readers that
almost certainly do not implement RFC 6721.

**D4 — No discovery mechanism. The URL is derived.**
`instancePrefix(source.canonical_url)` already returns `${protocol}//${host}/`
(`membership.ts:9-15`) and is computed anyway for the gate, so the endpoint is
`instancePrefix(...) + 'deletions.json'` — one line, from data the consumer
already stores.
*Rejected:* advertising it via a channel-level `atom:link` (which F20 shows
feedsmith would surface). Between instances we control, that is an
advertisement, a parse and a persistence step to transmit a string both sides
can compute.

**D5 — No window, no cap. A `?since=` cursor.**
Because the document is separate from the feed it competes with nothing, and
`logical_deleted_local_v2` already retains every marker permanently with
`deleted_at` (F2, F4). A consumer stores its cursor and asks for deletions after
it, so nothing is ever dropped.
*Rejected:* a retention window with an item cap — the previous design's cap of 25
silently lost every deletion beyond the 25th, which an account deletion (F3)
exceeds by construction.

**D6 — Emission rides the existing journal signal.**
Deletion already publishes an ordered sequence hint (F5); push simply does not
subscribe (F15). No new bus event.

**D7 — `FEED_LIMIT` becomes an admin setting** (F21, F22), independent of
deletion. Applies to the firehose and per-user feeds.

**D8 — Ordinary users can delete their own posts from the web UI.**
Today both delete surfaces are `isAdmin`-gated (`web/src/routes/+page.svelte:231`,
`web/src/routes/post/[id]/+page.svelte:104`) and the self-serve
`DELETE /me/posts/:id` is API-key-only with no `web/` caller
(`api/logical-routes/personal.ts:137-145`). Deletion must be a user action, not
only an admin one — otherwise this milestone federates something most people
cannot do.

**D9 — Fix the reply-count subtree bug (§1.6) first.**
It is pre-existing, but every propagated deletion landing mid-thread triggers it,
so shipping propagation without it means shipping a visible contradiction between
each timeline card and its own thread.

---

## 3. What we build — all PROPOSED

### 3.1 Origin side

- **`GET /deletions.json`** *(PROPOSED)* — public, unauthenticated, in
  `api/logical-routes/read.ts` beside the feed routes. Accepts `?since=<ISO>`;
  returns deletions strictly after it, ascending by `(deleted_at, logical_item_id)`.
  House style: `c.json(...)`, hand-rolled param validation, no zValidator, no
  HTTPException.
  ```json
  { "deletions": [ { "ref": "https://rsc.rmdes.be/post/abc",
                     "deletedAt": "2026-08-13T08:00:00Z" } ] }
  ```
  No `nextSince` and no `instance` field: the next cursor is the max `deletedAt`
  the client just received, and the client knows which host it fetched.

  `ref` is the emitted `<guid>` — for local posts `localGuid` emits `p.url`
  (`feed.ts:64-66`), the absolute permalink stored as `canonical_permalink`.
  **Invariant:** that identity holds only when `publicUrl` is set (`local.ts:147`);
  without it the marker stores a relative path. Serve an empty list when unset.
- **Index on `logical_deleted_local_v2(deleted_at)`** *(PROPOSED)* — none exists
  (`schema.ts:68-71`); the cursor query needs it.
- **Proxy exposure** *(PROPOSED)* — add `/deletions.json` to the `@core` matcher
  in `Caddyfile` **and** a `location` in `cloudron/nginx.conf` (F17). Without
  both, peers cannot reach it in production and only in production.
- **Ping on deletion** *(PROPOSED)* — subscribe push to the journal sequence hint
  (D6) and fire the existing firehose ping. One ping per account deletion, not
  one per post: F3 commits a single barrier, and `push.ts:198-199` already
  documents the no-coalescing hazard.

### 3.2 Consumer side

- **Fetch the deletions document** *(PROPOSED)* in the acquisition pass for
  sources that advertise the link, using the stored cursor. A ping means "go
  look" — F12/F14 both end in an acquisition, so this rides the existing trigger.
  **Reuse the secondary-fetch precedent**, don't invent one: origin verification
  already performs a gated fetch during acquisition using `isPrivateIp` from
  `domain/push-guard.ts`, an injected `lookupFn`, `AbortSignal.timeout`, and a
  `blocked_target` failure outcome (`logical/verification.ts:3,46,166-173,142`).
- **Bounds** *(PROPOSED)*: a response-size cap — which bounds `JSON.parse` and
  therefore the entry count, so no separate entries cap — plus rejection of any
  entry whose `ref` is not an absolute `http(s)` URL. Untrusted remote input.
- **Apply** *(PROPOSED)*: resolve `ref` via `logical_identity_keys_v2` kind
  `permalink`; unknown → no-op. Known → `convertToStructuralTombstone` (D1) plus
  a system-actor `item_audit_v2` row (`actor_kind` already admits `'system'`,
  `schema.ts:229`). Idempotent on `ref`.
- **Emit a journal effect** *(PROPOSED)* — **required, and easy to miss.**
  `convertToStructuralTombstone` writes none of its own; its existing caller
  emits a single `reset` barrier for a whole purge (`logical/tombstones.ts:353`).
  Without one here, the item tombstones silently and connected clients keep
  showing it until a reload. Append
  `{ kind: 'remove', logicalItemId, changeMask: 'presentation' }` — exactly what
  the origin emits for its own deletion (`logical/local.ts:230`) — **not** a
  `reset` barrier, which would make every client refetch its whole timeline for
  one item.
- **Gate** *(PROPOSED)*: accept only when the item's bound publisher is a member
  of the asserting instance, via `approvedInstanceFor`/`instancePrefix`
  (`membership.ts:9-23`), and the `ref` falls under that same prefix. A source
  may retract only what it published.
- **Cursor storage** *(PROPOSED)*: `remote_sources_v2` is **config-only** — no
  poll or cursor state (`storage/sqlite.ts:1475-1483`) — so the cursor rides
  `acquisition_runs_v2` as run evidence, the way `push_capability_json` already
  carries a feed-advertised capability (`logical/acquisition.ts:506`), reading
  the latest successful run's value. A lost or stale cursor costs a redundant
  refetch, never a skipped deletion.

### 3.3 Feed sizing

- **`feed_item_limit` setting** *(PROPOSED)*, default 50, replacing the constant
  at the three render call sites (F21) and surfaced on `/admin/settings`
  following the F22 pattern.

### 3.4 Self-serve deletion (D8)

- **Ungate the web delete surfaces** *(PROPOSED)*: show the control when the
  viewer is the post's author, not only when they are an admin
  (`+page.svelte:231`, `post/[id]/+page.svelte:104`). Admins keep their existing
  reach over any local post.
- **A session-authenticated delete path** *(PROPOSED)*: `DELETE /me/posts/:id`
  already enforces the right rule — local post, `post.authorId === me.id`, else
  403 (`personal.ts:141`) — but is mounted behind `apiKeyAuth`. Web needs the same
  ownership check reachable with a session. Follow the existing `authed`
  middleware-factory pattern rather than adding a parallel gate.
- **No new deletion semantics.** It routes to `service.deletePost` →
  `deleteLocalPost`, the same path admin removal already uses (F1), so
  propagation, journal effect and ping are identical for both.

### 3.5 Reply-count fix (D9)

- **Descend past invisible nodes** *(PROPOSED)* in `replyCounts`
  (`projector.ts:486-505`): keep the visibility test for whether a node is
  *counted*, but always enumerate its children. Regression test: the §1.6 worked
  case — a tombstoned B between visible A and C — must report 1, not 0.

---

## 4. What could go wrong

| Risk | Detection |
|---|---|
| A deletion is never applied because the consumer never fetches the document | Origin and consumer deletion counts diverge; assert in the live rollout step |
| Cursor skew loses deletions with identical `deleted_at` | Order and page by `(deleted_at, logical_item_id)`, never `deleted_at` alone |
| A hostile instance retracts items it did not publish | The §3.2 gate; log and count rejected assertions |
| Oversized or endless deletions document | The §3.2 bounds |
| A tombstoned item is re-created by a *second* source delivering the same permalink | Not reachable in this topology — no RSC feed relays another instance's items (`projector.ts:891-894`) and identity keys are stripped (F8). Becomes reachable only if an instance subscribes to an external aggregator carrying another instance's items under their original permalinks. One line, watched, not engineered around |
| Reply counts disagree with the thread after a tombstone lands | Pre-existing (§1.6) and **amplified** by this work — see open question O1 |

---

## 5. Testing

- **No feed bytes change at all.** With D4's derived URL, nothing is added to any
  feed document — the deletions endpoint is served alongside them. So the
  backward-compatibility risk that dominated the previous design is gone: an
  un-updated peer sees byte-identical feeds and simply never fetches the new
  endpoint. Assert this explicitly (golden-file feed output unchanged) rather
  than assuming it, since it is the claim the rollout rests on.
- **External validation** — valid.rss.chat on the firehose, to confirm the above:
  this repo has shipped green tests pinning wire-format bugs, so a passing unit
  suite is weak evidence here.
- **Cursor:** identical-timestamp paging; a consumer resuming from an old cursor;
  an empty result.
- **Gate:** each condition failing independently; a forged `ref` for another
  host; an unknown `ref`.
- **Thread continuity:** replies under a tombstoned parent still render, on the
  consumer, matching the origin's own placeholder.
- **Live update:** applying a deletion emits a journal `remove` effect, so an open
  SSE stream drops the item without a reload — and emits exactly one, not a
  `reset` barrier.
- Tests run **in the container**; type-stripping means vitest passes on type
  errors, so run `tsc --noEmit` too.

---

## 6. Rollout

1. **Reply-count fix (§3.5) and `feed_item_limit` (§3.3)** — purely local, no
   wire change, all five instances. The count fix must precede any propagation
   (D9).
2. **Self-serve deletion (§3.4)** — local, all instances. Deletion becomes a user
   action before it becomes a federated one.
3. **Origin side** (§3.1) to **rsc.rmdes.be only**. alice and bob, un-updated,
   must keep ingesting with no behaviour change.
4. **Consumer side** (§3.2) to **alice only**. Delete a post on rsc; it
   tombstones on alice; bob still shows it. That asymmetry proves gate and effect
   together, and step 1 means alice's reply counts stay honest while it happens.
5. bob, then rsc.rmendes.net and skyfleet.blue.

Push state, deploy state and per-instance state are three different things —
verify each instance rather than trusting a milestone note.

---

## 7. Open questions

- **O1 — is a deletion reason ever carried?** F2 stores none, so "removed by a
  moderator" and "deleted by its author" are indistinguishable by construction,
  on the origin as well as on peers. A `reason` column on the marker would let the
  placeholder say which. Not required by anything decided so far; raise it only if
  the placeholder wording needs to differ.
- **O2 — does an account deletion (F3) need anything beyond the per-post
  markers it already writes?** Each deleted post produces its own marker, so the
  cursor endpoint carries them like any other deletion. The remaining question is
  whether peers should also learn the *account* is gone, rather than only that N
  posts were deleted. Nothing in this design depends on the answer.
