# Reply-context from embedded h-cite — Design

**Status:** design
**Date:** 2026-07-19
**Idea:** `docs/superpowers/ideas.md` → "Reply-context that rides along" (Aaron-lens)

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
context (author, snippet) that would let an unresolved reply render "In reply to
@x: '…'" is thrown away.

`mf2tojf2` (already a dependency) flattens an h-cite in the `in-reply-to`
property to a JF2 object (`core/.../flatten-items.js`):

```js
{ type: "cite", url: "https://…", name: "Post title",
  author: { type: "card", name: "aaronpk", url: "https://aaronpk.com", photo: "…" },
  content: { html: "…", text: "…" }, published: "…" }
```

Everything needed is in that object; no new dependency, no fetch.

## Goal

Extract the h-cite's URL so object-form replies **thread** like string-form ones
(the bug fix), and capture the parent's author + a snippet so an **unresolved**
reply renders legible context instead of a bare link — as the replier's
*unverified claim*, superseded the instant the real parent lands.

## Design

### 1. Parse — the fix + the capture (`core/src/domain/discovery.ts`)

Replace the inline string-only extraction with a small pure helper that handles
both shapes and returns both the thread ref and the optional context:

```ts
// returns { ref, contextAuthor, contextSnippet } — ref feeds threading, the
// other two are display-only context (both null for a plain string ref).
function parseInReplyTo(irt: unknown): {
  ref: string | null
  contextAuthor: string | null
  contextSnippet: string | null
} {
  const first = Array.isArray(irt) ? irt[0] : irt
  if (typeof first === 'string') return { ref: first, contextAuthor: null, contextSnippet: null }
  if (first && typeof first === 'object') {
    const cite = first as { url?: unknown; name?: unknown; author?: unknown; content?: unknown }
    const ref = typeof cite.url === 'string' ? cite.url : null
    const author =
      cite.author && typeof cite.author === 'object' && typeof (cite.author as { name?: unknown }).name === 'string'
        ? (cite.author as { name: string }).name
        : typeof cite.author === 'string' ? cite.author : null
    const rawSnippet =
      cite.content && typeof cite.content === 'object' && typeof (cite.content as { text?: unknown }).text === 'string'
        ? (cite.content as { text: string }).text
        : typeof cite.content === 'string' ? cite.content
        : typeof cite.name === 'string' ? cite.name
        : null
    return { ref, contextAuthor: author, contextSnippet: truncate(rawSnippet, 200) }
  }
  return { ref: null, contextAuthor: null, contextSnippet: null }
}
```

- `truncate(s, n)`: trim, cut to `n` chars on a word boundary if possible, append
  `…` when cut; `null`-through. Small local helper (no dep).
- The three values ride on **`ParsedItem`** (new fields `replyContextAuthor`,
  `replyContextSnippet`) → **`toParsedItem`** (two new optional params, defaulting
  `null`, same as `contentMarkdown`) → the `Post` built in `ingest.ts`.
- **Author name is rendered verbatim** — whatever the source's `author.name` is
  (a handle like `aaronpk` or a display name like `Aaron Parecki`). We do **not**
  fabricate an `@` prefix (the UI adds framing, see §4).

### 2. Storage (`core/src/storage/sqlite.ts`)

Two new **nullable** columns on `posts`, mirroring the `source_name` pattern —
one migration appended to the migration list, plain columns (no FK, no index):

```sql
ALTER TABLE posts ADD COLUMN reply_context_author text
ALTER TABLE posts ADD COLUMN reply_context_snippet text
```

- Add to `PostsTable` (the Kysely interface) and map both in `rowToPost`
  (`sqlite.ts:21`) and in the `insertPost` `.values({…})` block, exactly as
  `source_name`/`content_markdown` are handled.
- **Approach note (chosen):** two typed nullable columns over a single
  `reply_context` JSON blob — matches the house pattern (no JSON columns exist),
  only two scalar fields, no parse step, queryable/serialisable as-is.

### 3. Threading — unchanged

`ingest.ts:157` already does `const target = item.inReplyTo ? await
repo.findPostByRef(item.inReplyTo) : undefined`. With `inReplyTo` now populated
from the h-cite URL, object-form replies resolve and late-adopt
(`adoptOrphans`) **exactly** like string-form ones. The two context columns are
pure display carry-along — **zero new threading logic**.

### 4. Render (web) — reuse the existing muted-metadata pattern

The unresolved-reply affordance already exists in two places:

- Timeline `web/src/routes/+page.svelte:127`:
  `{#if post.inReplyTo && !post.inReplyToPostId && post.inReplyTo.startsWith('http')}<a class="source" href={post.inReplyTo} rel="noreferrer">in reply to ↗</a>`
- Post-detail `web/src/routes/post/[id]/+page.svelte:83`: the `.subnav`
  "Replying to ↗ {url}" line.

Change: when the reply is **unresolved** (`!inReplyToPostId`) **and** context is
present, render the context in place of the bare URL. Shape (both surfaces):

```
In reply to {author}: “{snippet}” ↗
```

- `↗` is a real `<a href={inReplyTo} rel="noreferrer">` when a URL exists
  (tabbable, keyboard-reachable); when the h-cite carried **no** URL, drop the
  link and show just the text (a legible orphan — threading unchanged).
- **`{author}` and `{snippet}` are rendered as plain text nodes — NEVER through
  `{@html}`.** They are untrusted, replier-supplied strings; text-node rendering
  sidesteps the sanitizer entirely and keeps the single-`{@html}`-component
  invariant (`PostBody.svelte`) intact. This is the security boundary — do not
  interpolate them into any HTML string or `{@html}`.
- `{snippet}` is wrapped in typographic quotes (`“…”`); the stored value is
  already truncated (§1), so the visible text is the stored text. Add
  `title={snippet}` so the untruncated-enough value is available on hover.
- When context is **absent** (a string-form reply, or an h-cite with neither
  author nor snippet), fall back to today's bare "in reply to ↗" link — no
  regression.

**UI integration constraints** (per `ui-ux-pro-max:ui-ux-pro-max` +
`design-system/textcaster/MASTER.md` — the repo-canonical UI source; the
`ui-styling` sub-skill is shadcn/Tailwind-scoped and does not apply to our
plain-CSS SvelteKit):

- Style matches the existing inline-metadata: `color: var(--color-secondary);
  font-size: 0.875rem` — identical to `.subnav`/`.source`. **No raw hex; every
  colour a `--color-*` token.** `--color-secondary` is contrast-verified 4.5:1+
  in both themes (MASTER.md palette).
- No new CLS: the line occupies the same slot the bare link uses today.
- Accessibility: real semantic `<a>` for the `↗`, focus ring intact, the `↗`
  glyph plus `rel="noreferrer"` signals an external destination (matches the
  existing `.source` links).
- A small scoped class (e.g. `.reply-context`) or reuse of `.subnav`/`.source`;
  minimal new CSS. Built consulting `svelte-runes` + `sveltekit-data-flow`
  (the fields arrive via the existing page `data`; no new load, no new state).

### 5. Serialization (Hono) — no route change

The timeline route spreads the whole entry —
`timeline = entries.map((e) => ({ ...e, replyCount }))` then
`c.json({ timeline, nextCursor })` (`app.ts:395,400`). The thread route
(`getThread` → `c.json`) and the SSE `post` event
(`app.ts:408`, `JSON.stringify(entry)`) do the same. So the two new `Post`
fields **serialize automatically** once `rowToPost` maps them — **no new Hono
route, no field whitelist to edit.** The only web-type change is adding
`replyContextAuthor?`/`replyContextSnippet?` to `TimelineEntry`
(`web/src/lib/types.ts`) so the client can read them (and to any `api.ts`
mapping if one enumerates fields; if it spreads, nothing to change — verify
against the real code, don't assume).

## Trust posture

The context is the replier's **unverified claim** about the parent. Two
safeguards, no heavy disclaimer (chosen default; flag at spec review if you want
an explicit "as quoted" marker):

1. **Shown only while unresolved.** The moment the real parent is ingested and
   `adoptOrphans`/`findPostByRef` sets `inReplyToPostId`, the normal in-thread
   rendering takes over and the claimed context is not shown — the real post
   always wins.
2. **Plain-text render** (§4) — a hostile snippet cannot inject markup.

The phrasing "In reply to {author}: '…'" is naturally attributive (it is what
*this reply* says it answers), so no separate disclaimer is added.

## Scope boundaries (YAGNI)

- **h-feed/microformats path only.** The RSS/Atom ingest path already handles
  reply refs as strings via `source:inReplyTo` (Textcasting) / `thr:in-reply-to`
  (RFC 4685); it is untouched.
- **Not federated onward.** Textcaster's own feeds do **not** re-emit the
  captured context. The reply's URL ref already federates via existing
  mechanisms; the captured author/snippet is local display enrichment of
  unverified data and stays consume-side.
- **No avatar / photo.** Author-name + snippet only (the chosen richness). The
  h-cite's `author.photo` is not stored — avoids serving a remote image URL and
  a card component.
- **No new dependency, no fetch** — everything is in the already-parsed JF2.

## Error handling

- A malformed / partial h-cite (missing `url`, missing `author`, missing
  `content`) degrades field-by-field to `null` via the helper's typeof guards —
  never throws. Missing `url` → no thread ref (unchanged orphan) but context may
  still render; missing author *and* snippet → falls back to today's bare link.
- `truncate` is `null`-safe. Empty strings normalize to `null` (treated as
  absent) so an empty snippet never renders `“”`.

## Testing

**Core — `discovery.ts` (unit, the regression that proves the bug fixed):**
- An entry whose `in-reply-to` is an **h-cite object** → `inReplyTo` = the
  cite's `url` **and** `replyContextAuthor`/`replyContextSnippet` populated (this
  is the orphan-bug regression: before the fix the ref is `null`).
- A **string** `in-reply-to` → `inReplyTo` = the string, context both `null`
  (no regression to the existing path).
- An h-cite with **no `url`** (author/name only) → ref `null`, context populated.
- `truncate` cuts a long snippet with `…` and passes short/empty/`null` through.

**Core — `ingest.ts` (threading):**
- An h-cite reply whose parent already exists **threads** onto it
  (`inReplyToPostId` set via `findPostByRef`).
- An h-cite reply arriving **before** its parent orphans, then **adopts** when
  the parent lands (`adoptOrphans`) — same as string-form.

**Web:**
- An unresolved reply **with** context renders `author` + `snippet` as **text**
  (assert no `{@html}`; assert the `↗` is an `<a href>`), muted-metadata styled.
- An unresolved reply **without** context falls back to the bare "in reply to ↗"
  link (no regression).
- A **resolved** reply shows the thread, not the context.

## Out of scope

- Federating / re-emitting the captured context in Textcaster's own feeds.
- Author avatars / photos, or a full quoted-parent card.
- Verifying the claimed context against the parent's real feed (that is the
  separate "Verified bylines" idea — a different trust posture).
- The RSS/Atom reply path (already string-based, unaffected).
