# Live Edits — Design

**Status:** design
**Date:** 2026-07-18
**Feature:** "Posts that stay current" — local post editing + edit propagation

## Context

Textcasting's own contract lists posts as **editable**
(`2026-07-15-textcaster-design.md:53`), yet today no post can be edited:

- **Local posts** are write-once. `createLocalPostAs` (`service.ts:38`) stores
  the author's raw text into `posts.content` (markdown; rendered to HTML on read
  through the `markdown.ts` / `render.ts` sanitize twin), `title` is always null,
  and there is no update path.
- **Remote posts** are frozen at first poll: a re-polled item whose `guid`
  already exists makes `insertPost` return `false`, and the only update branch
  (`backfillItemExtras`, `sqlite.ts:307`) `COALESCE`s attribution/url columns and
  **never touches `content`/`title`**.

Our headline interop partner rss.chat edits posts *in place* under a stable
guid; we silently pin every such post to its first-polled version.

This feature makes editing real, end to end: a local author edits their own
post, and the edit **stays current everywhere the post has travelled**.

## The shape: one primitive, two halves

Editing has a **produce** side and a **consume** side, served by one storage
primitive:

- **Produce** — `PATCH /posts/:id`: a local author rewrites their own post.
- **Consume** — the ingest edit-detector: instance B re-polls A's feed, sees the
  same guid with a changed body, and applies the edit locally. This is how a
  local edit on A propagates A→B→C.
- **Shared primitive** — `recordEdit`: snapshot the superseded version into
  `post_revisions`, overwrite `posts` with the new body, stamp `edited_at`, and
  emit the updated entry on the **existing `new-post` bus channel** (so the
  outbound WebSub/rssCloud push notifier fires — see Bus + SSE).

Because remote posts are re-emitted pass-through in our firehose, a changed body
already travels onward for free; the consume-side detector is what turns that
changed body back into a first-class edit (marker, history, further
propagation) at each hop.

## Decisions locked during brainstorming

1. **Trust + keep history.** Apply the source's/author's edit, but snapshot the
   superseded version into a `post_revisions` table. The "edited" state is
   auditable, not silent — the honest answer to the append-only trust boundary.
2. **Markdown-aware detection (consume side).** An incoming re-poll is an edit if
   `content` OR `title` OR `content_markdown` changed under the same guid.
   Accepted residual: a markdown reflow with byte-identical rendered HTML still
   flags "edited" with no visible change.
3. **Marker + full revision list.** A quiet "· edited ⟨time⟩" marker plus a
   `/post/:id/history` page listing every version. Inline diff highlighting is
   deferred within that page.
4. **Explicit wire signal.** Emit `<atom:updated>` on edited feed items so peers
   and generic readers get an explicit signal and a shared timestamp; on the
   consume side, **prefer the incoming `<atom:updated>`** as `edited_at` when
   present, so the whole federation agrees on one edit time.
5. **One combined spec** covering core + web.
6. **Edit rules: anytime, any local author, own posts only.** Editable iff
   `post.source === 'local'` AND `post.authorId === coreUser.id`. Registered and
   guest authors alike (a guest owns its own row); no time window.

## Design

### Data model

- **`posts.edited_at TEXT NULL`** — new nullable column (migration). Only ever set
  on an *applied* edit.
- **`post_revisions`** — new table:
  `(id TEXT PK, post_id TEXT NOT NULL REFERENCES posts(id), title TEXT, content TEXT NOT NULL, content_markdown TEXT, seen_at TEXT NOT NULL)`,
  indexed on `post_id`.
- **Snapshot-the-prior.** On each edit, INSERT the *currently-stored*
  `{title, content, content_markdown}` into `post_revisions` (with `seen_at` = the
  moment it is being superseded), then UPDATE `posts` to the new body and set
  `edited_at`. Consequences:
  - A never-edited post has **zero** revision rows.
  - The first edit captures the original.
  - Full history for a post = `[…revisions oldest→newest, current post]`.

### Produce side — `PATCH /posts/:id`

- Auth: `authed` (session). Body: `{ content }`, validated `isString(content, 1,
  100000)` — identical bounds to `POST /posts`.
- Resolve the post. `404 { error: 'unknown post' }` if missing.
- **Ownership + kind gate:** `403 { error: 'not editable' }` unless
  `post.source === 'local'` AND `post.authorId === coreUser.id`. (A remote post's
  `authorId` is a remote user row, never a session user, so the ownership check
  alone already blocks remote edits; asserting `source==='local'` makes the
  intent explicit and future-proof.)
- **No-op:** if the new `content` equals the stored `content`, return `200` with
  the unchanged post — no phantom revision, no event.
- Otherwise `recordEdit(post, { content, editedAt: now })`: snapshot prior →
  update `content` + `edited_at=now` → `bus.emitNewPost({ ...updated, author })`
  (the existing channel, so push fires — see Bus + SSE). Local `content` *is*
  markdown and `title` stays null, so no title/markdown bookkeeping on this path.
- Response: `200 { post }` with the updated post. `edited_at` is the **real
  authored edit time**.

### Consume side — ingest edit-detection

The `insertPost(post) === false` branch in `ingestItems` (`ingest.ts:168`) must
become **unconditional**. Today it is guarded — `else if (item.sourceName ||
item.sourceFeedUrl || item.contentMarkdown || item.url)` — which would silently
skip edit-detection for a plain body edit on a feed carrying none of those. It
becomes `else { … }`, running on every dedup hit:

1. Load the stored `{ id, title, content, content_markdown }` for
   `(author_id, guid)` (new repo read, e.g. `getEditableByGuid(authorId, guid)`).
2. **Detect:** an edit iff
   `item.content !== stored.content` OR `item.title !== stored.title` OR
   `item.contentMarkdown !== stored.content_markdown`.
3. **If edit:** `recordEdit(storedId, { title, content, contentMarkdown,
   editedAt })` where `editedAt =` the incoming item's `<atom:updated>` if present
   and a valid date, else observed `now` (**prefer-incoming**). Then run the
   existing attribution `backfillItemExtras` COALESCE (source name / feed url /
   url), and `bus.emitNewPost({ ...updated, author: user })` (existing channel).
4. **Else (no body/title/markdown change):** `backfillItemExtras` exactly as
   today — attribution/url fill only.

`ponytail:` making the branch unconditional adds one `getEditableByGuid` SELECT
per already-seen item per poll (~50/feed/cycle). Fine at current scale; revisit
(e.g. hash-column short-circuit) only if a poll cycle's read volume ever bites.

**Prefer-incoming requires wiring the RSS parse branch**, not only Atom. The
edit-time source is a new **`updatedAt: string | null`** on `ParsedItem` /
`toParsedItem`. Textcaster emits RSS and rss.chat is RSS 2.0, so to make Decision
4 ("the federation agrees on one edit time") actually fire, the **RSS** branch of
`parseFeedWithMeta` (`ingest.ts:107`) must read feedsmith's item-level
`it.atom?.updated`; the Atom branch reads `it.updated`; JSON Feed reads
`date_modified`; RDF → `null`. If only the Atom branch were wired (as first
drafted), every real re-poll would carry `updatedAt = null` and fall back to
`now`, so instances would *not* agree — the decision would be silently defeated.
(Simpler alternative, if you'd accept per-instance observed times: drop
`updatedAt` entirely and always use `now`. This reverses Decision 4 — your call.)

`edited_at` is set **only on an observed change**. An item that is already edited
the first time we ever see it has no stored original to diff against, so it stays
`edited_at = null` until it changes again under our watch. Documented and
intentional.

### Bus + SSE — edits ride the existing `new-post` channel

Edits reuse the existing bus event rather than adding a second one. This is not
just simpler — it is what makes propagation *work*:

- **`recordEdit` emits the updated entry on the existing `new-post` channel**
  (`bus.emitNewPost`). No new bus event, no `'edited-post'` channel, no second
  `/timeline/stream` subscription.
- **Why reuse, not add (correctness, not taste):** `server.ts:54` wires
  `bus.onNewPost((e) => push.onLocalPost(e))` — the WebSub/rssCloud outbound
  notifier is subscribed to `new-post` **only**. `push.onLocalPost` is
  content-agnostic (it maps the entry to affected topic URLs and pings
  subscribers to *refetch*), so firing it on an edit is both correct and
  required: it is what pushes the edit out to peers. A separate edit channel
  would skip push entirely, and an edit would propagate only on the next
  full-poll tick — defeating the feature's headline claim.
- **`/timeline/stream`** (`app.ts:362`, frames are `event: 'post'`) keeps its
  wiring; the **web SSE handler becomes an idempotent upsert by post id**: the id
  is already in the DOM → swap the body + marker in place (an edit); the id is
  absent → prepend (a new post). One path serves both, and an edited entry
  carries `edited_at` so the marker renders. New-post prepend behaviour is
  unchanged (a genuinely new id is still absent → prepends).
- **No edit replay.** `Last-Event-ID` replay is unchanged. A client that
  reconnects or reloads gets the current body + `edited_at` from the normal
  server render, so a missed live frame costs nothing.

### Wire / feed rendering

- `renderRssFeed` + `renderFirehoseRss` (`feed.ts`): when a post has `edited_at`,
  emit `<atom:updated>{edited_at}</atom:updated>` per item (feedsmith emits
  item-level `item.atom.updated` natively). RSS 2.0 core has no "updated";
  `atom:updated` is the standard cross-format carrier.
  **Namespace caveat:** `xmlns:atom` is currently declared on the root only when
  the channel carries atom links, which needs `ctx.publicUrl`. With no
  `publicUrl` (some dev/test paths) an edited item could emit `<atom:updated>`
  with the namespace undeclared → malformed XML. The plan must declare the atom
  namespace whenever any item emits `atom:updated` (or guard the emit), with a
  fixture covering the no-`publicUrl` case.
- `renderJsonFeed`: set JSON Feed's native `date_modified` when `edited_at` is
  set (feedsmith generates `date_modified`).
- Never-edited posts omit both — no behavioural change to existing output.

### Web UI

Invokes `ui-ux-pro-max:ui-ux-pro-max` and the relevant `svelte-skills`
(`sveltekit-data-flow` for the form action, `svelte-runes` for the SSE swap
state) at build; follows `design-system/textcaster/MASTER.md`; every colour a
`--color-*` token, no raw hex.

- **Edit affordance** on **your own** local posts → an edit form (a `<textarea>`
  prefilled with the post's markdown = its stored `content`). Submits via a
  **SvelteKit form action** (`PATCH` through the core proxy) so it works with **no
  JS**; on success the page re-renders the updated body.
- **Edited marker:** a quiet "· edited ⟨relative time⟩" (absolute in `title=`),
  **server-rendered from `edited_at`**, wherever posts render — home timeline,
  `u/[handle]`, `post/[id]`, and `ReplyTree`.
- **`/post/:id/history`:** a server `load` returns the current post + its
  revisions oldest→newest; the page lists each version with its `seen_at`, each
  body rendered through the **same sanitize twin**. Inline diff highlighting is
  deferred (the version list carries the audit value).
- **SSE `edited`:** locate the post node by id, replace its body through the same
  server-side render/sanitize path used for new posts (the `PostBody` `{@html}`
  chokepoint — **no new `{@html}` site**), and update/insert the marker,
  jank-free. If the post is not currently in the DOM, ignore the frame.

## Invariants held (do not break)

- **The sanitizer is the one XSS gate.** `PATCH /posts/:id` stores raw markdown
  exactly as `POST /posts` does; display HTML is produced only at render time by
  the `markdown.ts` / `render.ts` twin. The history page and the SSE swap both
  reuse that path. **No second `{@html}` is introduced.** The drift-canary tests
  are unaffected (no sanitizer-config change).
- **guid / permalink stability.** An edit changes `content`/`edited_at` only;
  `guid`, `url`, and the permalink are untouched, so every existing reply stays
  threaded.
- **Timeline order is stable.** `published_at` is not changed by an edit, so an
  edited post keeps its position — a quiet correction, not a bump to the top.

## API changes

| Method | Route | Auth | Change |
|---|---|---|---|
| PATCH | `/posts/:id` | `authed` | **new** — edit own local post; `200 { post }` / `403 not editable` / `404 unknown post` |
| GET | `/post/:id` feeds | — | items with `edited_at` gain `<atom:updated>` (RSS/firehose) and `date_modified` (JSON) |
| GET | `/timeline/stream` | — | unchanged wiring; edits ride existing `event: 'post'` frames (client upserts by id) |
| GET | `/posts/:id/revisions` | — (public) | **new** — `{ current, revisions: [{title,content,seen_at}, …] }` for the history page. Public, mirroring the public post page/feeds: a public post's edit trail is public. |
| — | bus | — | edits reuse the existing `new-post` channel (no new event) — so the outbound push notifier fires |

## Out of scope / deferred residuals

- **Delete** — a separate concern (moderation / a later milestone).
- **Inline diff highlighting** on the history page — deferred; the version list
  ships first.
- **SSE edit-replay** on reconnect — unnecessary; a reload is already current.
- **Already-edited-on-first-sight** — `edited_at` is set only on an observed
  change; an item first seen in an edited state stays `null` until it changes
  again. Documented, not fixed.
- **Revision retention cap** — unbounded for now. A flapping/looping source
  (A→B→A) records a revision per flip. `ponytail:` add a keep-last-N (or
  drop-if-equal-to-immediately-prior-revision) cap only if this ever bites.
- **Local post titles** — local posts remain untitled (`title: null`); editing
  changes only the body.

## Testing

**Core — unit + in-process integration (existing style):**
- `PATCH /posts/:id`: owner edits own local post → body updated, one revision
  (the original), `edited_at` set, `edited` event emitted; a second edit → a
  second revision. Same content → `200`, no revision, no event. Non-owner → 403.
  Remote post → 403. Missing → 404. Anonymous session editing its **own** post →
  allowed; editing another's → 403.
- Ingest detection: re-ingest same guid, changed body → revision + `edited_at` +
  entry emitted on `new-post`; unchanged → none; attribution-only change →
  `backfillItemExtras`, not an edit; `edited_at` prefers a valid incoming
  `<atom:updated>` and falls back to `now` when absent/invalid.
- Unconditional branch: a **plain body edit on a feed with no
  attribution/markdown/permalink-url** is still detected (guards the
  `ingest.ts:168` regression).
- Propagation: an edit (local PATCH *and* consume-side) fires `push.onLocalPost`
  (the entry rides `new-post`), so subscribers are pinged — not deferred to the
  next full-poll tick.
- Feed output: an edited post emits `<atom:updated>` (RSS + firehose) and JSON
  `date_modified`; a never-edited post omits both.
- `getRevisions`/`getEditableByGuid` return the expected shapes and ordering.

**Web:**
- `api.test.ts`: an `editPost` client (mirroring `createPost`).
- Edit form action updates the post; `/post/:id/history` `load` returns
  current + revisions.
- Drift-canary suites unchanged.

## Open details resolved in the plan

1. Exact name/signature of the repo reads/writes: `recordEdit`,
   `getEditableByGuid`, `getRevisions`, and how `recordEdit` is made atomic
   (snapshot + update in one transaction).
2. The web proxy route for `PATCH /posts/:id` (mirrors the existing
   auth/stream proxies) and the form-action wiring.
3. Marker component placement across the four render sites and its MASTER.md
   token/spacing treatment.
4. `RUNNING.md` note for the new endpoints and the `post_revisions` table.

## Revision history

- **Rev 1 (2026-07-18) — clean-context review fold.** A ponytail/soundness review
  in an isolated context found three real issues, folded here (none reverse a
  brainstorming decision):
  1. **Edits ride the existing `new-post` bus channel**, not a new
     `emitEditedPost`/`edited-post` channel. `server.ts:54` subscribes the
     outbound push notifier to `new-post` only, so a separate channel would have
     silently skipped WebSub/rssCloud push — edits would not have propagated
     until the next full poll. Riding `new-post` fixes propagation *and* drops the
     second event, second stream subscription, and `event: edited` frame; the web
     SSE handler upserts by id (swap if present, prepend if not).
  2. **The `ingest.ts:168` else-branch becomes unconditional** — it was guarded
     by `if (item.sourceName || … || item.url)`, which would skip edit-detection
     for a plain body edit. `ponytail:` note added for the added per-item SELECT.
  3. **Prefer-incoming needs the RSS parse branch wired** to read item-level
     `it.atom?.updated` (feedsmith parses it); wiring only the Atom branch would
     make every real re-poll fall back to `now` and silently defeat Decision 4.
  Also: stream line ref corrected to `app.ts:362`; `xmlns:atom` namespace caveat
  documented for the no-`publicUrl` case.
  **Not folded — maintainer reviewed and held both decisions (2026-07-18):** the
  reviewer argued to *defer the whole revision/history half* (table, migration,
  `/post/:id/history`, public revisions endpoint) and to *drop the `updatedAt`
  plumbing* for a per-instance `now`. Presented with the explicit cost, the
  maintainer **kept full history** (Decisions 1 + 3 — auditability, matching the
  project's transparency posture) and **kept the wire/prefer-incoming plumbing**
  (Decision 4 — one federation-agreed edit time). Both cuts declined deliberately,
  not overlooked.
