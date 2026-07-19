# Reply-context from embedded h-cite — Design

**Status:** design
**Date:** 2026-07-19
**Idea:** `docs/superpowers/ideas.md` → "Reply-context that rides along" (Aaron-lens)
**Reviews folded:** ponytail (rev 1), parallel-session `docs/superpowers/reviews/2026-07-19-reply-context-spec-review.md` (rev 2)

## Context

When Textcaster ingests an h-feed (the microformats2 discovery path,
`core/src/domain/discovery.ts`), each entry's `in-reply-to` is read **only if it
is a bare URL string**. If it is an *object* — an embedded `h-cite`, the
IndieWeb reply-context carrying the parent post's author, name, and a content
snippet (which Aaron Parecki, among others, publishes on every reply) — it is
discarded to `null` at `discovery.ts:55`:

```ts
const irt = e['in-reply-to']
const inReplyTo = Array.isArray(irt) ? (typeof irt[0] === 'string' ? irt[0] : null) : typeof irt === 'string' ? irt : null
```

Two consequences: (1) a **latent threading bug** — the reply's parent URL is
right there inside the h-cite, but because it arrives object-form the reply
**orphans** (floats at the timeline root instead of threading); (2) the reply
context (author, snippet) that would let an unresolved reply render legible
context is thrown away.

`mf2tojf2` (already a dependency) flattens the property; the relevant real shapes
(verified in `flatten-items.js`) are:

- a **string** ref → passes through as a string;
- a **single h-cite** → the object itself:
  `{ type:"cite", url, name, author, content, published }`, where `url` may be a
  **string or an array of strings**, `author` is a **card object** (`{ type:"card",
  name, url, photo }`) **or a plain string**, and `content` is `{ html, text }`
  (but `text` is **omitted when the mf2 value is falsy** → html-only content
  carries no text snippet);
- **2+ h-cites** → a **wrapper** `{ children: [cite, cite] }` (an object, not an
  array).

Everything needed is in that object; no new dependency, no fetch.

## Goal

Extract the h-cite's URL so object-form replies **thread** like string-form ones
(the bug fix), and capture the parent's author + a snippet so an **unresolved**
reply renders legible context instead of a bare link — as the replier's
*unverified claim*, superseded once the real parent lands.

## Design

### 1. Parse — the fix + the capture (`core/src/domain/discovery.ts`)

Replace the inline string-only extraction with a small pure helper that handles
**every real `mf2tojf2` shape** and returns the thread ref + the optional context:

```ts
// returns { ref, contextAuthor, contextSnippet } — ref feeds threading, the
// other two are display-only context (both null for a plain string ref).
function parseInReplyTo(irt: unknown): {
  ref: string | null
  contextAuthor: string | null
  contextSnippet: string | null
} {
  // F1: 2+ values flatten to { children:[...] } — an object, not an array. Unwrap
  // to the first cite before anything else.
  let v = irt
  if (v && typeof v === 'object' && Array.isArray((v as { children?: unknown }).children)) {
    v = (v as { children: unknown[] }).children[0]
  }
  const first = Array.isArray(v) ? v[0] : v
  if (typeof first === 'string') return { ref: first, contextAuthor: null, contextSnippet: null }
  if (first && typeof first === 'object') {
    const cite = first as { url?: unknown; author?: unknown; content?: unknown }
    // F2: cite.url may be a string OR an array of strings (multiple u-url).
    const url = cite.url
    const ref = typeof url === 'string' ? url
      : Array.isArray(url) && typeof url[0] === 'string' ? url[0]
      : null
    // author is a card object (.name) or a plain string (text-only p-author).
    const author =
      cite.author && typeof cite.author === 'object' && typeof (cite.author as { name?: unknown }).name === 'string'
        ? (cite.author as { name: string }).name
        : typeof cite.author === 'string' ? cite.author : null
    // P4: context is author-keyed at render (§4). A snippet with no author is
    // unrenderable dead data — drop the whole context (keep the ref for threading).
    if (!author) return { ref, contextAuthor: null, contextSnippet: null }
    // content is { html, text } — but `text` is omitted for html-only content,
    // so that case yields no snippet → author-only line (§4), not “”.
    const rawSnippet =
      cite.content && typeof cite.content === 'object' && typeof (cite.content as { text?: unknown }).text === 'string'
        ? (cite.content as { text: string }).text
        : typeof cite.content === 'string' ? cite.content
        : null
    return { ref, contextAuthor: author, contextSnippet: truncate(rawSnippet, 200) }
  }
  return { ref: null, contextAuthor: null, contextSnippet: null }
}
```

- **`truncate(s, n)`** — `null`-safe and **code-point-safe** (F9): reuse the
  `feed.ts:200` idiom (`Array.from`; a plain `.slice(0,n)`/`.length` splits
  surrogate pairs / emoji at the boundary). **Bound the work first** — a hostile
  body is capped only by `MAX_FEED_BYTES` (5 MB, `ingest.ts:29`), so slice a
  UTF-16 prefix (`s.slice(0, n*2 + 2)`, safe since a code point is ≤2 units)
  **before** `Array.from`, then take `n` code points + `…`. Empty/whitespace →
  `null`. The plan pins the exact expression against `feed.ts:200`.
- The three values ride on **`ParsedItem`** (new fields `replyContextAuthor`,
  `replyContextSnippet`) → **`toParsedItem`** → the `Post` built in `ingest.ts`.
  **F10 — swap hazard:** `toParsedItem` already ends with 10 positional params
  (`… source?, contentMarkdown = null, updatedAt = null`); two more adjacent
  `string | null` positionals are silently swappable at the call site. Pass the
  two context values as **one trailing options object** (`{ author, snippet }`),
  not two positionals — the plan pins the exact signature and the single h-feed
  call site (`discovery.ts:56`).
- **Author name is rendered verbatim** — the source's `author.name` may be a
  handle (`aaronpk`), a display name (`Aaron Parecki`), or a plain string; we do
  **not** fabricate an `@` prefix (h-feeds carry no such identity scheme). The UI
  adds framing (§4).

### 2. Storage (`core/src/storage/sqlite.ts`)

Two new **nullable** columns on `posts`, mirroring the `source_name` pattern —
one migration appended to the list, plain columns (no FK, no index):

```sql
ALTER TABLE posts ADD COLUMN reply_context_author text
ALTER TABLE posts ADD COLUMN reply_context_snippet text
```

**Approach note (chosen):** two typed nullable columns over a single
`reply_context` JSON blob — matches the house pattern (no JSON columns exist),
only two scalar fields, no parse step.

### 3. Threading — unchanged logic; NEW replies only (F3)

`ingest.ts:157` already does `const target = item.inReplyTo ? await
repo.findPostByRef(item.inReplyTo) : undefined`. With `inReplyTo` now populated
from the h-cite URL, object-form replies resolve and late-adopt
(`adoptOrphans`) **exactly** like string-form ones. The context columns are pure
display carry-along — **zero new threading logic**.

**Scope boundary (F3) — new items only.** Replies already stored with
`in_reply_to = null` (their object-form ref discarded pre-feature) take the
already-seen else-branch on re-poll, and `backfillItemExtras` (`sqlite.ts:317`)
COALESCEs only `source_name`/`source_feed_url`/`content_markdown`/`url` — never
the thread ref or context columns. Healing that finite pre-feature orphan backlog
(extend `backfillItemExtras` + re-run adoption when a ref appears) is a separate,
larger change and is **out of scope**: everything ingested after ship threads
correctly; the pre-feature backlog stays orphaned.

**Implementer checklist — the "rides along" is FOUR hand edits; miss one and the
feature silently no-ops:** add the new fields at (1) `PostsTable` (`sqlite.ts:9`),
(2) `rowToPost` (`sqlite.ts:20-21`), (3) `insertPost .values` (`sqlite.ts:181`),
(4) the `Post` object built in `ingest.ts:158-165`. (Fresh DBs replay all
migrations — the migration list is not a fifth site.)

### 4. Render (web) — the unresolved-reply line, on all FOUR surfaces (F6)

The unresolved-reply affordance (today: `!inReplyToPostId &&
inReplyTo.startsWith('http')` → a bare "in reply to ↗" link) exists,
**hand-copied on four timeline surfaces**. All four must get the enrichment and
stay **textually identical** (a security-sensitive render):

- Timeline `web/src/routes/+page.svelte:127`
- Post-detail `web/src/routes/post/[id]/+page.svelte:83` (inside `.subnav`)
- Profile `web/src/routes/u/[handle]/+page.svelte:124`
- Following `web/src/routes/u/[handle]/following/+page.svelte:126`

(`ReplyTree.svelte` shows only **resolved** replies — correctly out of scope.)

**The new guard (plan must quote it verbatim so nobody copy-pastes the old
`startsWith('http')`-only one):** render **context** when `!inReplyToPostId &&
replyContextAuthor`; else the **bare link** when `!inReplyToPostId &&
inReplyTo?.startsWith('http')`; else nothing.

**Render shape:**
- **author + snippet:** `In reply to {author}: “{snippet}” ↗`
- **author only** (snippet `null` — a routine state: h-cite with author but no
  text `content`, incl. html-only content per §1): `In reply to {author} ↗` —
  **no colon, no quotes** (never render `“”`).
- `↗` is a real `<a href={inReplyTo} rel="noreferrer">` when a URL exists
  (tabbable); **no URL → drop the link, text only** (a legible orphan).

**Security boundary (unchanged, load-bearing):** `{author}` and `{snippet}` are
rendered as **plain text nodes — NEVER `{@html}`**. They are untrusted,
replier-supplied strings; text-node rendering sidesteps the sanitizer entirely
and keeps the single-`{@html}`-component invariant (`PostBody.svelte`) intact. Do
not interpolate them into any HTML string. Author is rendered verbatim (§1).

**UI integration** (per `ui-ux-pro-max:ui-ux-pro-max` + `MASTER.md` — the
repo-canonical source; the `ui-styling` sub-skill is shadcn/Tailwind-scoped and
does not apply to our plain-CSS SvelteKit):

- **One small wrapping class** — `.reply-context { color: var(--color-secondary);
  font-size: 0.875rem }` (F4). Rev-1's "reuse `.source`, no new CSS" was **wrong**:
  `.source` (`app.css:404`) is **font-size only**, its colour comes from the
  global `a { color: var(--color-accent) }` (`app.css:62`), and it sits **on the
  `<a>`** — so plain-text author/snippet nodes outside the anchor would render at
  default body size/colour. `.subnav` (`app.css:463`) genuinely carries
  `--color-secondary`/0.875rem and wraps text, so **post-detail reuses `.subnav`**;
  the timeline/profile/following use the new `.reply-context` wrapper. **No raw
  hex** — `--color-secondary` is contrast-verified 4.5:1+ in both themes.
- No new CLS (same slot as today's bare link). Real semantic `<a>` for `↗`, focus
  ring intact, `rel="noreferrer"` signals external. Built consulting
  `svelte-runes` + `sveltekit-data-flow` (fields arrive via existing page `data`;
  no new load, no new state).

### 5. Serialization (Hono) — no route change; one trust gate (F8)

The timeline route spreads the whole entry — `entries.map((e) => ({ ...e,
replyCount }))` then `c.json({ timeline, nextCursor })`
(`core/src/api/app.ts:395,400`); the thread route (`getThread` → `c.json`) and
the SSE `post` event (`core/src/api/app.ts:408`, `JSON.stringify(entry)`) do the
same. So the two new `Post` fields **serialize automatically** once `rowToPost`
maps them — **no new Hono route, no field whitelist.** (Read the installed Hono
if any route/serialization detail is uncertain; do not add a route.)

**Trust gate at the serialization choke points (F8) — enforce "the real post
always wins":** a resolved reply must never ship its unverified claim. A helper
`hideResolvedReplyContext<T extends { inReplyToPostId?: string | null;
replyContextAuthor?: string | null; replyContextSnippet?: string | null }>(e: T):
T` (generic — it wraps both `TimelineEntry` and bare `Post`) nulls the two fields
when `inReplyToPostId` is set, applied at the **three** places a reply's context
can reach the client:
- **`joinedRowToEntry`** (`sqlite.ts:34`) — the single `TimelineEntry` mapper
  (`{ ...rowToPost(r), author }`) behind `getTimeline`, `getThread`, **and
  `getTimelineAfter` (the SSE reconnect-replay path)** and the firehose;
- **`emitNewPost`** (`core/src/domain/bus.ts`) — the live SSE emit, whose
  in-memory literals bypass the DB mapper; and
- **`GET /posts/:id/revisions`** (`core/src/api/app.ts:127-130`) — returns a bare
  `getPost` `Post` to the web history page (P2: `getPost` is **not** internal-only).

`getPost`'s other client-facing callers are safe by invariant, not by the gate:
`POST /posts` and `PATCH /posts/:id` serialize only **local** posts, which never
carry reply-context (it is captured on the h-feed ingest path only) — worth one
code comment where each returns. The render guard still checks `!inReplyToPostId`
as defense-in-depth.

Web-type change: add `replyContextAuthor?`/`replyContextSnippet?` to
`TimelineEntry` (`web/src/lib/types.ts`); check whether `web/src/lib/api.ts`
enumerates or spreads fields (verify against real code, don't assume).

## Trust posture

The context is the replier's **unverified claim** about the parent. Two
safeguards, no explicit disclaimer (chosen; the attributive phrasing + plain-text
render carry it):

1. **Shown only while unresolved — superseded on next load (F7).** Once the parent
   is ingested and `inReplyToPostId` is set (via `findPostByRef` or
   `adoptOrphans`), the reply serializes **without** context (§5 gate) and renders
   in-thread. **Honest caveat:** `adoptOrphans` does **not** re-emit adopted rows
   over SSE (`emitNewPost` fires only for the inserted parent, `ingest.ts:167`),
   so a **live** timeline keeps showing the claim until the next page load; a
   fresh fetch is always correct. (Re-emitting adopted rows would make it
   live-instant — deferred; the `mergeIncoming`-by-id swap already exists,
   `live.ts:12`, if we choose to.)
2. **Plain-text render** (§4) — a hostile snippet cannot inject markup.

## Scope boundaries (YAGNI)

- **h-feed/microformats path only.** The RSS/Atom ingest path already handles
  reply refs as strings via `source:inReplyTo` / `thr:in-reply-to`; untouched.
- **New replies only** (F3) — pre-feature stored orphans are not healed.
- **Not federated onward.** Our feeds do not re-emit the captured context; the
  URL ref already federates. Consume-side display enrichment only.
- **No avatar / photo** — author-name + snippet only; `author.photo` not stored.
- **No new dependency, no fetch** — everything is in the already-parsed JF2.

## Error handling

- A malformed / partial h-cite degrades field-by-field to `null` via the helper's
  typeof guards — never throws. No `url` → no thread ref (unchanged orphan),
  context may still render; no author *and* no snippet → today's bare link.
- `truncate` is `null`-safe; empty/whitespace → `null`, so an empty snippet never
  renders `“”` (and the author-only variant, §4, is the specified state when
  snippet is `null` but author is present).

## Testing

**Core — `discovery.ts` (unit — the new logic + the library-shape regressions):**
- h-cite **object** → `inReplyTo` = cite `url` + context populated (the orphan-bug
  regression: pre-fix the ref is `null`).
- **multi-cite** `{ children: [cite, cite] }` → ref from the first cite, **not
  `null`** (F1).
- cite with **array `url`** (`[a, b]`) → ref = `url[0]` (F2).
- **string** ref → ref = string, context `null` (no regression).
- h-cite **no `url`** → ref `null`, author captured, snippet `null`.
- **html-only content** (`content.html`, no `text`) → snippet `null` (author-only).
- `truncate` — code-point-safe cut with `…`; short / empty / `null` /
  emoji-at-the-boundary (no broken half-codepoint).

**Core — threading (one integration smoke):** an h-feed reply whose parent exists
threads onto it end-to-end (discovery → ingest → `findPostByRef`). *(Dropped the
before/after `adoptOrphans` pair — `ingestItems` sees a plain string ref either
way, so they exercise no new code; the discovery assertions above are the new
logic.)*

**Core — serialization gate (F8):** a **resolved** reply (`inReplyToPostId` set)
serializes with `replyContext*` = `null`; an unresolved one keeps them.

**Web (any one of the four surfaces; assert the four copies are identical):**
- unresolved + author + snippet → text `In reply to {author}: “{snippet}” ↗`
  (assert **no `{@html}`**; `↗` is an `<a href>`), `.reply-context`/`.subnav` styled.
- unresolved + author only → `In reply to {author} ↗` (no colon, no `“”`).
- unresolved + no context → bare "in reply to ↗" link (no regression).
- resolved → in-thread, no context.

## Out of scope

- Healing pre-feature stored orphans (F3); federating/re-emitting the context.
- Author avatars / photos, or a full quoted-parent card.
- Verifying the claim against the parent's real feed (the separate "Verified
  bylines" idea — a different trust posture).
- The RSS/Atom reply path (already string-based, unaffected).

## Revisions

**Rev 4 (2026-07-19)** — folded a parallel-session review of the *plan*
(`docs/superpowers/reviews/2026-07-19-reply-context-plan-review.md`), two items of
which touch this spec: **P2** — the gate covers **three** sites, not two: the
reviewer falsified "getPost is internal / covers every path" by finding
`GET /posts/:id/revisions` ships a raw `getPost` `Post` to the web history page,
so `hideResolvedReplyContext` is **generic** again (Post + TimelineEntry),
reversing rev-3's "no generic" (rev-3's path analysis was incomplete). **P4** —
`parseInReplyTo` now **requires an author** for any context (a snippet with no
author is unrenderable under §4's author-keyed guard — dead data). The other
eight findings are plan-only (test harness, code-sketch bugs, implementer traps).

**Rev 3 (2026-07-19)** — folded a ponytail review of the *plan* that traced the
real serialization paths: the §5 gate moves from an app-route-level shaping step
(which would have **missed the SSE reconnect-replay path**, `getTimelineAfter` →
`joinedRowToEntry`, leaking a resolved reply's context on reconnect) to the two
`TimelineEntry` **choke points** `joinedRowToEntry` + `emitNewPost`. This also
drops the generic on the helper (both sites are `TimelineEntry`) and leaves
`getPost` raw. Everything else in the plan was confirmed at/below its constraints'
minimum.

**Rev 2 (2026-07-19)** — folded the parallel-session spec review
(`docs/superpowers/reviews/2026-07-19-reply-context-spec-review.md`; both product
calls endorsed):
- **F1** — unwrap `{ children:[...] }` (multi-cite) before the cite branch, else
  the ref is `null` and the reply still orphans.
- **F2** — `cite.url` may be an array; take `url[0]`, else the fix no-ops.
- **F3** — stated the **new-items-only** boundary (pre-feature orphans aren't
  healed; `backfillItemExtras` touches neither ref nor context) + the FOUR
  edit-site checklist.
- **F4** — reverted rev-1's "no new CSS" for the timeline: `.source` is
  font-size-only + accent-coloured on the `<a>`, so a small `.reply-context`
  wrapper is needed (post-detail still reuses `.subnav`).
- **F5** — specified the **author-only** render variant (`In reply to {author} ↗`,
  no colon/quotes) so it never renders the forbidden `“”`.
- **F6** — the unresolved-reply line lives on **four** surfaces (added
  `u/[handle]` + `u/[handle]/following`); keep the copies identical.
- **F7** — softened trust-safeguard 1 to "superseded on next load" (adopted
  orphans aren't re-emitted over SSE).
- **F8** — null the context fields at serialization when `inReplyToPostId` is set,
  enforcing the trust gate once server-side.

Carried as **plan-level notes** (not spec text): F9 (code-point-safe `truncate`
per `feed.ts:200`, slice-before-trim — folded into §1's `truncate` bullet), F10
(pass context as one trailing options object, not two positionals — folded into
§1), and the guard-quoting trap (§4 mandates quoting the NEW guard verbatim).

**Rev 1 (2026-07-19)** — folded a ponytail review (4 cuts, ~−12 lines): dropped a
redundant `title` hover; dropped the `cite.name`→snippet fallback (title ≠
snippet); made `truncate` a hard cut (superseded by F9 rev-2); attempted to reuse
`.source`/`.subnav` with no new CSS (**partially reverted by F4**).
