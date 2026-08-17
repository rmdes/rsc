# Delete propagation between federated instances — design

**Status:** rev 4 — supersedes revs 1–3 entirely · **Date:** 2026-08-15

## Problem

When a post is removed on one RSC instance, the others never learn. Their copies
stay visible, with full content, forever.

## What the code actually does today (verified)

- **Instances exchange the firehose** (`/users/rss.xml`) as one source with
  `attribution_mode='aggregate'`. Per-user feeds are fetched only for origin
  verification and are never polled or subscribed.
- **A fat WebSub ping's body IS the whole feed document** — the last N posts, not
  a delta. `websubDeliver` hands it to `acquireSource(..., {kind:'push', document})`,
  which **skips the HTTP fetch** and commits that body through the identical path
  a poll takes (`core/src/logical/push.ts`, `core/src/logical/acquisition.ts`).
- **A changed item at a known guid is an edit.** The acquisition fingerprint
  covers title, content and `updated`; a difference overwrites the stored version
  **in place**, re-reconciles, and journals an upsert — the peer's copy updates
  live, keeping its id and timeline position.
- **Nothing treats absence as retraction.** Ingest is purely additive.
- **Nothing rejects empty or short content** on ingest. No minimum length exists.
- **feedsmith is strictly schema-driven**: it drops any element it has no schema
  for, at channel and item level alike. Measured, not assumed.

## The design

**A removal is an edit.** The post keeps its row, id, permalink, `published_at`
and place in the thread; its content becomes a notice saying it was removed and
why. The outgoing feed already carries that item at the same `<guid>`, so a peer
ingests it as an ordinary edit and overwrites in place.

**Federation needs no new code.** No endpoint, no cursor, no consumer, no ping
change. This is the whole point of the design.

Because feedsmith drops unknown elements, nothing new can be added to the wire
anyway — so the notice *is* the content, in a field every RSS reader already
renders. A peer that was not listening when the removal happened simply fetches
the item in its removed state and never sees the original. That is correct, not
a gap.

## Decisions

| # | Decision |
|---|---|
| D1 | A removal replaces content; it does not destroy the row. `terminallyDelete` stays, used **only** by account deletion |
| D2 | The `logical_deleted_local_v2` marker is still written, and is now the only way to distinguish a removed post from an ordinary one |
| D3 | Author removal **purges** `post_revisions`; moderator removal **retains** them as an admin-only record |
| D4 | Replying to a removed post is **refused** — today's refusal is an accident of the row being gone and must become explicit |
| D5 | A moderator picks from the nine existing `AuditCategory` values plus an optional note; an author gets fixed wording |
| D6 | **Account deletion is unchanged and stays destructive.** `posts.author_id` is a RESTRICT reference to `users(id)`; surviving rows would make `DELETE FROM users` fail |
| D7 | The journal effect is an **upsert**, not a remove — a remove frame would make peers and open SSE clients drop the item instead of showing the notice |

## Consequences to hold in view

- **"Deleted" no longer means the bytes are gone** for a moderator removal — the
  original sits in `post_revisions`. For an author it does, by D3.
- **Roughly eight code paths infer removal from a missing `posts` row.** Keeping
  the row flips all of them. Most flip the way we want; two do not (the
  reply-target gate, and the public history route) and are fixed explicitly.
- An account deletion propagates **nothing** — peers keep those copies, exactly
  as today. Only single-post removal federates.

## Rejected

**A separate `/deletions.json` endpoint plus a peer-side consumer** (revs 1–3,
built as tasks 6–9, reverted in `e149d1e`). It added a public surface, a cursor,
per-source state and a second source of truth, to transmit something the feed can
already say. It also rested on a requirement — gating the endpoint to approved
peers — that RSC cannot implement and never needed, since feeds are public and
peers pull anonymously.
