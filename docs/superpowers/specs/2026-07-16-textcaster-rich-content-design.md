# Textcaster — rich content rendering design (UI-6)

Date: 2026-07-16 (rev 2 — folds in
`docs/superpowers/reviews/2026-07-16-rich-content-spec-review.md`:
SEC-1 third ingress, COR-1..4, SEC-4, transformTags gotcha)
Status: design approved (brainstorm); rev 2 pending review
Author: Ricardo (rmdes) with Claude Code
Basis: Textcasting contract (Markdown+HTML dual content;
source.scripting.com: a presenter that understands Markdown SHOULD prefer
`source:markdown` for display); rss.chat client worknotes 7/6–7/7/26
(blockquote/heading/code lessons). Probed: feedsmith parses AND emits
`sourceNs.markdown`.

## What this ships

Post bodies render rich — blockquotes, heading hierarchy, code, lists,
links, images — replacing plaintext-everything, with ONE server-side render
path and the Textcasting dual-content contract on our own feeds.

Decisions (brainstormed):

- **Sanitization is render-time, in web SSR.** Core stores and re-emits raw
  content (pass-through stays byte-faithful); the browser only ever
  receives sanitized HTML.
- **Full dual contract**: incoming `source:markdown` is the preferred
  display source; local composes are Markdown; our feeds emit
  `source:markdown` + rendered `<description>`.
- **New dependencies (user-approved; core scope widened at review)**:
  `marked` (core + web, same version; GFM so bare URLs autolink) and
  `sanitize-html` (web AND core — see SEC-4).
- **marked-in-core confirmed (review question)**: `<description>` must
  carry rendered HTML because pre-`source:markdown` readers — the entire
  legacy ecosystem plain-RSS federation exists for — render description
  only; Dave's docs define `source:markdown` as the SOURCE of the
  description, i.e. description is the rendered form.
- **SEC-4**: core sanitizes its OWN outbound rendered HTML — the same
  allowlist config, applied to `marked(content)` before it enters
  `<description>`/`content_html`. A member typing raw `<script>` in a
  compose must not ship in our feed. Raw remote content still re-emits
  untouched (pass-through applies to OTHERS' content, not to HTML we
  ourselves generate).
- **Images allowed** in post bodies (rss.chat posts carry them; the clamp
  bounds jank), http(s)-only + `loading="lazy"`.

## Data model — migration 7

```sql
ALTER TABLE posts ADD COLUMN content_markdown TEXT; -- source:markdown verbatim (remote); null otherwise
```

- Remote items: `ParsedItem` gains `contentMarkdown: string | null` from
  `item.sourceNs.markdown` (RSS path; other formats null). Stored verbatim.
  Backfill on re-poll: `backfillSourceAttribution` is renamed
  `backfillItemExtras` and gains the field. **Per-column no-flapping
  (COR-1)**: the UPDATE fills each column independently —
  `SET source_name = COALESCE(source_name, ?), source_feed_url =
  COALESCE(source_feed_url, ?), content_markdown =
  COALESCE(content_markdown, ?)` — never gated on a single column's
  nullness (a post attributed at migration 6 must still gain markdown at
  migration 7). Contract pin: exactly that scenario. **Trigger (COR-2)**:
  the ingest `else if` becomes
  `item.sourceName || item.sourceFeedUrl || item.contentMarkdown`.
- Local posts: `content` IS the Markdown source; `content_markdown` stays
  null (locals are implicitly Markdown by `source === 'local'`). Existing
  local dev posts are plain text — valid Markdown, renders equivalently.
- **Mechanical thread-through sites (COR-4), enumerated so none reads
  undefined**: `ParsedItem` field; `toParsedItem` param (RSS mapper passes
  `it.sourceNs?.markdown ?? null`; other formats default null); the
  `ingestItems` post literal; `Post` type (`contentMarkdown?: string |
  null`); `PostsTable` + `rowToPost` + `insertPost` values;
  `backfillItemExtras`; web `TimelineEntry` type. The timeline join and
  thread/comments queries pick it up via `selectAll('posts')`/`rowToPost`
  automatically.

## Display precedence (the whole rule)

Per post: `content_markdown` present → render as Markdown; else
`source === 'local'` → render `content` as Markdown; else render `content`
as HTML. Every path ends in the sanitizer.

## The one render path — `web/src/lib/server/render.ts`

```ts
renderPostHtml(post: { content: string; contentMarkdown?: string | null; source: 'local' | 'remote' }): string
```

- Markdown branches: `marked` with GFM (autolinks bare URLs); HTML branch:
  the content string as-is. BOTH then flow through `sanitize-html`.
- Allowlist: `p br a em strong b i blockquote code pre ul ol li h1 h2 h3 h4 img`.
  Attributes: `a[href]` and `img[src]` http(s)-only (scheme-checked by the
  sanitizer config), `rel="noreferrer"` forced on every `a`,
  `loading="lazy"` forced on every `img`; every other attribute stripped
  (no class, no style, no on*). Implementation gotcha (review-verified):
  attributes added via `transformTags` must ALSO appear in
  `allowedAttributes` or sanitize-html strips them back off — the unit
  tests pin `rel`/`loading` presence in the OUTPUT.
- Lives under `lib/server/` so SvelteKit build-fails any client import —
  the sanitizer never ships to (or runs in) the browser.

**Enrichment at the THREE ingress points** — every route by which post
content reaches the browser, all server-side (SEC-1: the wedge's
`fetchThread` is the third; without it, wedge-revealed remote replies
would reach the `{@html}` component un-enriched — a plaintext degrade
today, a stored-XSS foot-gun for any future "fix"):

1. Page `load` functions (home, lenses, thread page): map each entry to
   include `contentHtml = renderPostHtml(entry)`.
2. The `/post/[id]/thread.json` proxy: parse core's JSON, enrich each
   thread entry, re-serialize (same shape as the loads — trivial).
3. The `/stream` SSE proxy — NOT a trivial transform (COR-3): the proxy is
   a pure body pipe today. It becomes a real SSE frame parser: buffer
   chunks, split frames on the blank-line delimiter, pass `id:` and
   `event:` lines through BYTE-VERBATIM (the Last-Event-ID replay contract
   rests on them), parse only `post` events' `data:` JSON, add
   `contentHtml`, re-serialize. A frame that fails to parse forwards
   untouched (fallback renders plaintext — never raw).

Wire type: `TimelineEntry` (web) gains `contentHtml?: string`. The
`{@html}` chokepoint gets a concrete home: a new `PostBody.svelte`
(the body `<p class="body">`-equivalent: `{@html}` + the clamp handler +
the plaintext fallback), and ALL FIVE render sites (home, two lenses,
thread page, ReplyTree) use it — `{@html}` appears in exactly one
component in the codebase, fed only by `render.ts` output. This also
retires the five duplicated body blocks (a first slice of the ledgered
post-card dedup). `plaintext()`/`Linkified` remain for excerpt contexts.

**Fallback**: entries missing `contentHtml` (shouldn't happen — all three
ingress points enrich) render via `plaintext()` as today, never raw.

## Feeds out (core) — the dual contract

Local posts, in `renderRssFeed`/`renderCommentsFeed` item mapping and the
JSON Feed equivalent:

- `<description>` = `marked(content)` (rendered HTML — readers that don't
  know `source:markdown` still see rich content).
- `<source:markdown>` = raw `content` (probed: feedsmith serializes
  `sourceNs.markdown`).
- JSON Feed: `content_html` = rendered, `content_text` = raw content
  (replacing today's text-only mapping for local posts).

Remote posts re-emit exactly as stored: `description` = `content`
untouched, plus `<source:markdown>` = `content_markdown` when present
(pass-through both fields). Core never alters OTHERS' content; it DOES
sanitize the HTML it generates itself from local composes (SEC-4) — the
distinction is authorship, not laziness.

Deps recap: core adds `marked` + `sanitize-html` (outbound-only);
web adds `marked` + `sanitize-html` (render path).

## Styling (web, tokens only — design pass refines)

Scoped inside `.post .body`, per rss.chat's 7/6–7/7 lessons:

- `blockquote`: thin left rule (`--color-border`), muted text
  (`--color-secondary`), body-size type — "someone else's words", not
  Bootstrap dress.
- `h1–h4`: real hierarchy scaled WITHIN the post body (post titles stay the
  page's h2/h3 — body headings must not outshout them).
- `code`/`pre`: small monospace stack, `--color-muted` background;
  `pre` scrolls horizontally rather than breaking layout.
- `img`: `max-width: 100%`, height auto.
- Click-to-expand clamp: unchanged — `max-height` works on rich HTML, and
  the link-click guard in `toggleClamp` already exempts anchors.

## Security invariants (tested, not asserted)

1. Allowlist-only sanitizer; `script`, `style`, `iframe`, `svg`, event
   handlers, `class`/`style` attributes never survive.
2. `href`/`src` http(s)-only — `javascript:`, `data:`, `vbscript:` dropped.
3. `{@html}` single chokepoint fed only by `render.ts`.
4. Hostile-fixture unit tests: `<script>`, `<img onerror>`,
   `javascript:` hrefs, `data:` srcs, nested/malformed markup, an SVG
   payload, and a Markdown document that EMBEDS raw HTML (marked passes
   raw HTML through — the sanitizer must catch it; this fixture is the
   load-bearing one).

## Testing

- `render.ts`: precedence matrix (markdown column / local / remote HTML) +
  the hostile fixtures above + autolink pin.
- Stream proxy: an upstream `post` event gains `contentHtml`; id/event
  fields byte-identical (replay untouched).
- Core: local markdown post → feed carries rendered `<description>` +
  verbatim `<source:markdown>`; JSON Feed carries `content_html` +
  `content_text`; remote posts re-emit untouched (pass-through pin);
  `content_markdown` ingest + backfill pins; migration 6→7 pin.
- Live: obscura SSR check on real rss.chat content (Dave's quote-heavy
  posts) — blockquote/heading/code elements present, script-free.

## Non-goals

Media enclosure UI, iframes/embeds (stripped), image uploads, syntax
highlighting, editing, sanitizer caching (render-per-request until it
measurably matters — `ponytail:` ceiling).

## Sequencing

1. Core: migration 7 + `contentMarkdown` ingest/backfill + dual-contract
   feed emission (with tests).
2. Web: `render.ts` + hostile fixtures; enrichment at the three ingress points;
   `{@html}` swap in the post-body component sites; styling.
3. Obscura verification on live data + RUNNING.md note.
