# User-journey checklist — the flag-on gate artifact

**Status:** living gate artifact. Born from the V2 seam sweep
(`docs/superpowers/reviews/2026-07-25-v2-seam-sweep.md`), whose lesson was:
the layered process verified *contracts*, not *journeys*. Eight defects in two
days were all one class — seams between individually-correct layers that no
spec, plan, per-task review, or integration test crossed, because no artifact
enumerated **user journeys under flag-on**, and none had an **outbound-mirror**
column (what a remote peer sees).

**How to use it.** Before any vertical or milestone claims completion, walk
every journey below through the front door, and for each, check BOTH columns:
the in-app result AND the outbound mirror (fetch the actual feed a peer would
poll and read the bytes). A journey isn't done until its outbound mirror is
correct. This is a checklist to *exercise*, not a doc to read — the value is
in actually doing each row against a live instance.

The **Would have caught** column maps each check back to the sweep finding it
would have surfaced at V2's gate — evidence the column earns its place.

---

## Why the outbound mirror is load-bearing

RSC is feeds-native: a post/reply/edit is only "done" when the RSS a peer polls
reassembles the conversation on the peer's side. Every seam that shipped
(O1–O5) was invisible in-app and only wrong on the wire:

- O1/O2/O3 — replies left the instance **parentless** (`inReplyTo` null, bare
  UUID guid, no `<link>`); in-app the thread looked fine.
- O4 — a remote reply re-emitted under **our internal UUID**, so its origin
  instance couldn't dedupe its own item back.
- O5 — the WebSub **fat-ping body disagreed with the pull body** for the same
  topic (reply count present in one, absent in the other).

In-app assertions pass on all five. Only reading the emitted feed catches them.

---

## The journeys

Legend: **FD** = front-door action (flag-on). **In-app** = what the actor
sees. **Outbound mirror** = fetch the feed a peer polls and assert on the bytes.

### 1. Post (local, top-level)
- [ ] **FD:** compose + publish a local post.
- [ ] **In-app:** appears in the author's timeline and the home river.
- [ ] **Mirror:** `GET /users/:handle/feed.xml` — the item carries an
      **absolute permalink `<guid>`** (bare, rss.chat convention) and a
      matching `<link>`; `GET /users/rss.xml` (firehose) carries it too.
      *(Would have caught: the identity half of O1 — a v2 local post stored a
      relative permalink → bare-UUID guid, no `<link>`.)*

### 2. Reply (local → local, and local → remote)
- [ ] **FD:** reply to a local post; reply to an ingested remote post.
- [ ] **In-app:** the reply nests under its parent in the thread view.
- [ ] **Mirror:** the reply's feed item carries `<source:inReplyTo>` = the
      parent's **absolute permalink/guid** (for a remote parent, the parent's
      origin wire guid, incl. the opaque-only case). A peer's threadwalker
      reassembles the conversation by string-comparing that guid.
      *(Would have caught: O1/O2 outbound threading dead; T1's opaque-parent
      regression.)*

### 3. Thread (multi-hop, cross-instance)
- [ ] **FD:** build A→B→A→B across two instances (or one + a fixture peer).
- [ ] **In-app:** the full chain renders; unavailable ancestors show a
      placeholder marker, not an empty page.
- [ ] **Mirror:** `GET /post/:id/comments.xml` enumerates replies; each
      **remote** reply's `<guid>` is its **origin wire guid**, not our UUID.
      *(Would have caught: O4 comments.xml UUID guid; D11 placeholder subtrees
      dropped by the web / a placeholder root claiming "no such conversation".)*

### 4. Edit (local post)
- [ ] **FD:** edit a local post one or more times.
- [ ] **In-app:** the post updates; `/post/:id/history` shows each version
      with an honest label (oldest untimed = "created"), distinct rows for a
      **title-only** change and an **enclosure swap**, and no duplicate-key
      crash.
- [ ] **Mirror:** the feed item's `<pubDate>`/updated reflects the edit;
      provenance is "explicit", not arrival.
      *(Would have caught: D14 history-page crash; D15/D16 title+enclosures
      dropped from history; D5/D17 provenance.)*

### 5. Delete / moderate (post, user)
- [ ] **FD:** delete own post; admin removes a post/user.
- [ ] **In-app:** gone from timelines; thread shows a tombstone where required,
      not a broken node.
- [ ] **Mirror:** the item stops appearing in the feed; a structural tombstone
      never resurrects or gets re-adopted by an arriving delivery.

### 6. Subscribe / follow (a remote feed)
- [ ] **FD:** subscribe to a remote feed by URL.
- [ ] **In-app:** its items enter the correct timeline tab; the **federated**
      and **personal** live tabs fill on live upsert, not only on reload.
- [ ] **Mirror:** WebSub/rssCloud subscription is established; a peer's ping
      triggers ingest. `/peers` and `/admin/overview` reflect the v2 corpus
      (sources, remote items), not just v1 tables.
      *(Would have caught: D2/D3 live-tab client filters on v2-null fields;
      W3 /peers empty on v2 [deferred]; W4 admin counts omit the v2 corpus.)*

### 7. Import (OPML)
- [ ] **FD:** import an OPML file — including **after a core blip during the
      page load** (reload the page while core restarts, then submit).
- [ ] **In-app:** sources subscribe; no 400. The import path is chosen by
      **capabilities**, not by whether the load happened to mint a commandId.
      *(Would have caught: W5 OPML import falling to the legacy branch → v2
      400 `commandId invalid`.)*

### 8. Listen (enclosures / audio)
- [ ] **FD:** open a remote item that carries an audio enclosure; open its
      history after the publisher swaps the audio.
- [ ] **In-app:** the enclosure renders (reusing the one enclosure component);
      a swapped enclosure shows as a distinct history row.
- [ ] **Mirror:** the emitted feed item carries the `<enclosure>` with correct
      url/type/length.
      *(Would have caught: the fixed enclosure-rendering bug; D16.)*

### 9. Federate (the real-time loop)
- [ ] **FD:** A posts; B is subscribed to A via the self-hub.
- [ ] **In-app (B):** B's live timeline shows A's post without polling.
- [ ] **Mirror:** the **fat-ping body B receives is byte-equal to a pull** of
      the same topic — same items, same `<guid>`s, same `source:comments`
      counts (counts include remote replies).
      *(Would have caught: O5 push/pull count disagreement.)*

### 10. Byline / attribution (remote author)
- [ ] **FD:** view a remote item from a publisher with, and without, a
      navigable profile.
- [ ] **In-app:** a navigable publisher links to `/p/:id`; a non-navigable one
      renders **plain display-name text** (never `<a href="/u/">@</a>` or a
      `/u//feed.xml` icon link).
      *(Would have caught: D1 empty-handle byline; and the individualized
      byline / publisher-naming fixes.)*

---

## Minimum outbound-mirror toolkit

- `curl -s $PUB/users/:handle/feed.xml` and `.../rss.xml` — inspect `<guid>`,
  `<link>`, `<source:inReplyTo>`, `<enclosure>`, `<source:comments>`.
- `curl -s $PUB/post/:id/comments.xml` — remote reply guids.
- The in-process bridge harness (`core/test/federation-live.test.ts`,
  `makeInstance`/`makeBridge`) — the real WebSub loop end to end, and the
  place to assert fat-ping-equals-pull.
- There is no flag anymore — v2 is the only model, on every instance. No
  legacy `off` comparison to maintain.

---

*developed with the help of AI tools*
