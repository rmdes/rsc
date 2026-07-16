# Textcaster Rich Content Rendering Implementation Plan (UI-6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Post bodies render rich (quotes, headings, code, lists, links, images) through one server-side sanitized path, and our feeds ship the Textcasting dual contract (`source:markdown` + rendered description).

**Architecture:** Migration 7 adds `posts.content_markdown` (incoming `source:markdown`, verbatim). Web renders via a single `renderPostHtml` (marked → sanitize-html) and enriches every entry with `contentHtml` at THREE server-side ingress points (page loads, thread.json proxy, SSE proxy — now a real frame parser). `{@html}` lives in exactly one new component (`PostBody.svelte`) used by all five render sites. Core renders + sanitizes its OWN local-compose HTML for feed descriptions (SEC-4); remote content re-emits untouched (pass-through).

**Tech Stack:** marked 18 (GFM), sanitize-html 2 (+ @types), both ALREADY INSTALLED in core and web (plan-time probes ran against them). TypeScript ESM, no build step in core.

**Spec:** `docs/superpowers/specs/2026-07-16-textcaster-rich-content-design.md` (rev 2 + sequencing fix, c91d725).

## Global Constraints

- **The sanitizer allowlist (both workspaces, identical):** tags `p br a em strong b i blockquote code pre ul ol li h1 h2 h3 h4 img`; `allowedAttributes: { a: ['href','rel'], img: ['src','loading'] }`; `allowedSchemes: ['http','https']`; `transformTags` forcing `rel="noreferrer"` on `a` and `loading="lazy"` on `img`. PROBED: transform-added attrs survive only because they are ALSO in allowedAttributes; `javascript:` hrefs and `data:` srcs are dropped; `<script>`/`<svg>`/`on*` never survive.
- **PROBED marked behavior:** `marked.parse(md)` is sync (string); GFM autolinks bare URLs; **raw HTML inside Markdown passes through** — the sanitizer AFTER marked is load-bearing, never skip it.
- **`{@html}` appears in exactly ONE component** (`PostBody.svelte`), fed only by server-produced `contentHtml`. Any other `{@html}` is a defect.
- **Three ingress points** (SEC-1): page `load`s, `/post/[id]/thread.json` proxy, `/stream` SSE proxy. All enrich server-side; the browser never sanitizes and never renders raw content (fallback = `plaintext()`).
- **Pass-through:** core never alters remote content; it sanitizes only HTML it GENERATES from local composes (SEC-4).
- **SSE replay contract:** the stream proxy must forward `id:` and `event:` lines byte-verbatim; unparseable frames forward untouched.
- **Migration array append-only** — this milestone appends the SEVENTH element (index 6).
- **No `git add -A`** (shared checkout). TDD; all four gates green at each task's end: `npm test -w core`, `npm run typecheck -w core`, `npm test -w web`, `npm run check -w web`.
- Commit after each task with trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## File structure

```
core/src/storage/sqlite.ts        # MODIFY: migration 7; backfillItemExtras (renamed, per-column COALESCE)
core/src/domain/repository.ts     # MODIFY: rename backfillSourceAttribution → backfillItemExtras (+ param)
core/src/domain/repository-contract.ts # MODIFY: per-column backfill pins
core/src/domain/types.ts          # MODIFY: Post.contentMarkdown?
core/src/domain/ingest.ts         # MODIFY: ParsedItem.contentMarkdown, toParsedItem, RSS mapper, ingestItems, trigger
core/src/domain/markdown.ts       # CREATE: renderLocalHtml (marked → sanitize-html, SEC-4)
core/src/domain/feed.ts           # MODIFY: dual-contract item mapping (RSS + comments + JSON Feed)
core/test/rich-content.test.ts    # CREATE: core-side tests
web/src/lib/server/render.ts      # CREATE: renderPostHtml + enrichEntries
web/src/lib/server/render.test.ts # CREATE: hostile fixtures + precedence matrix
web/src/lib/PostBody.svelte       # CREATE: the {@html} chokepoint
web/src/lib/types.ts              # MODIFY: contentMarkdown?, contentHtml?
web/src/routes/+page.server.ts, u/[handle]/+page.server.ts, u/[handle]/following/+page.server.ts, post/[id]/+page.server.ts # MODIFY: enrich
web/src/routes/post/[id]/thread.json/+server.ts # MODIFY: enrich (ingress 2)
web/src/routes/stream/+server.ts  # MODIFY: SSE frame parser (ingress 3)
web/src/routes/stream/server.test.ts # MODIFY: enrichment + verbatim-id tests
web/src/routes/+page.svelte, u/[handle]/+page.svelte, u/[handle]/following/+page.svelte, post/[id]/+page.svelte, web/src/lib/ReplyTree.svelte # MODIFY: use PostBody
web/src/app.css                   # MODIFY: rich body styles
docs/superpowers/documentation/RUNNING.md # MODIFY: markdown compose + dual-contract note
```

---

### Task 1: Core — migration 7, contentMarkdown thread-through, backfillItemExtras

**Files:**
- Modify: `core/src/domain/types.ts`, `core/src/domain/repository.ts`, `core/src/storage/sqlite.ts`, `core/src/domain/ingest.ts`, `core/src/domain/repository-contract.ts`, `core/test/migrations.test.ts`
- Create: `core/test/rich-content.test.ts`

**Interfaces:**
- Produces: `Post.contentMarkdown?: string | null`; `ParsedItem.contentMarkdown: string | null`; `toParsedItem(..., source?, contentMarkdown: string | null = null)` (9th defaulted param); `Repository.backfillItemExtras(authorId, guid, sourceName, sourceFeedUrl, contentMarkdown)` (renamed from `backfillSourceAttribution` — update BOTH call/definition sites and the contract test name).
- Consumes: existing migration runner, `mkPost`.

- [ ] **Step 1: Failing tests** — create `core/test/rich-content.test.ts`:

```ts
import { test, expect } from 'vitest'
import { parseFeedWithMeta } from '../src/domain/ingest.ts'

test('source:markdown is captured verbatim into ParsedItem.contentMarkdown', async () => {
  const rss = `<?xml version="1.0"?><rss version="2.0" xmlns:source="http://source.scripting.com/"><channel><title>t</title>
<item><guid>g1</guid><description>&lt;p&gt;html&lt;/p&gt;</description><source:markdown>**md** with [link](https://x.ex)</source:markdown></item>
<item><guid>g2</guid><description>plain</description></item>
</channel></rss>`
  const { items } = await parseFeedWithMeta(rss)
  expect(items[0].contentMarkdown).toBe('**md** with [link](https://x.ex)')
  expect(items[1].contentMarkdown).toBeNull()
})
```

And append to `core/src/domain/repository-contract.ts` (replacing the existing `backfillSourceAttribution` test — rename + extend it):

```ts
    test('backfillItemExtras fills each column independently, only where null (COR-1)', async () => {
      const repo = await makeRepo()
      const a = await repo.createRemoteUser({ handle: 'agg', displayName: 'Agg', feedUrl: 'https://agg.ex/f' })
      await repo.insertPost(mkPost({ id: 'p1', authorId: a.id, guid: 'g1' }))
      // first pass: attribution only (the migration-6 world)
      await repo.backfillItemExtras(a.id, 'g1', 'Dave Winer', 'https://rss.chat/users/dave/rss.xml', null)
      // second pass: markdown arrives later (the migration-7 world) — must still fill
      await repo.backfillItemExtras(a.id, 'g1', 'Someone Else', 'https://other.ex/f', '**md**')
      const p = await repo.getPost('p1')
      expect(p?.sourceName).toBe('Dave Winer') // no flapping
      expect(p?.contentMarkdown).toBe('**md**') // filled despite source_name being set
      await repo.backfillItemExtras(a.id, 'nope', 'X', null, null) // unknown guid → no-op
    })
```

- [ ] **Step 2: Run — verify RED**

Run: `npm test -w core`
Expected: FAIL — `contentMarkdown` missing / `backfillItemExtras` not a function.

- [ ] **Step 3: Types + ParsedItem + toParsedItem + RSS mapper + ingest** — in `core/src/domain/types.ts` add to `Post` (after `sourceFeedUrl?`):
```ts
  contentMarkdown?: string | null // incoming source:markdown, verbatim (remote); null otherwise
```
In `core/src/domain/ingest.ts`:
```ts
export interface ParsedItem { guid: string; title: string | null; content: string; url: string | null; publishedAt: string; inReplyTo: string | null; sourceName: string | null; sourceFeedUrl: string | null; contentMarkdown: string | null }
```
`toParsedItem` gains a 9th defaulted param and returns it:
```ts
export function toParsedItem(guid: string | undefined, title: string | null, content: string, url: string | null, rawDate: string, now: string, inReplyTo: string | null = null, source?: { title?: string; url?: string }, contentMarkdown: string | null = null): ParsedItem {
```
…and in the returned object add `contentMarkdown,` (verbatim — no sanitization; it is the author's source).
RSS mapper (the last mapper in `parseFeedWithMeta`) passes it:
```ts
    toParsedItem(it.guid?.value, it.title ?? null, it.description ?? it.content?.encoded ?? '', it.link ?? null, it.pubDate ?? '', now, itemInReplyTo(it), it.source, it.sourceNs?.markdown ?? null))
```
(Other mappers keep the default null. If feedsmith's RSS item type lacks `sourceNs.markdown`, extend `itemInReplyTo`'s structural-parameter style: type the access as `(it as { sourceNs?: { markdown?: string } }).sourceNs?.markdown ?? null`.)
`ingestItems` post literal adds `contentMarkdown: item.contentMarkdown,` and the backfill trigger becomes:
```ts
    } else if (item.sourceName || item.sourceFeedUrl || item.contentMarkdown) {
      await repo.backfillItemExtras(user.id, item.guid, item.sourceName, item.sourceFeedUrl, item.contentMarkdown)
    }
```

- [ ] **Step 4: Repository + storage** — in `core/src/domain/repository.ts` replace the `backfillSourceAttribution` line:
```ts
  backfillItemExtras(authorId: string, guid: string, sourceName: string | null, sourceFeedUrl: string | null, contentMarkdown: string | null): Promise<void>
```
In `core/src/storage/sqlite.ts`: append migration 7 (seventh element, after the source-attribution entry):
```ts
  [
    // Incoming source:markdown, verbatim — the Textcasting preferred display source
    'ALTER TABLE posts ADD COLUMN content_markdown text',
  ],
```
Extend `PostsTable` with `content_markdown: string | null`, `rowToPost` with `contentMarkdown: r.content_markdown`, `insertPost` values with `content_markdown: p.contentMarkdown ?? null`. Replace `backfillSourceAttribution` with:
```ts
  async backfillItemExtras(authorId: string, guid: string, sourceName: string | null, sourceFeedUrl: string | null, contentMarkdown: string | null) {
    // Pre-existing rows never re-insert (dedup), so extras fill in place —
    // PER COLUMN (COR-1): a post attributed at migration 6 must still gain
    // markdown at migration 7. COALESCE keeps the first-seen value (no flapping).
    await this.db.updateTable('posts')
      .set((eb) => ({
        source_name: eb.fn.coalesce('source_name', eb.val(sourceName)),
        source_feed_url: eb.fn.coalesce('source_feed_url', eb.val(sourceFeedUrl)),
        content_markdown: eb.fn.coalesce('content_markdown', eb.val(contentMarkdown)),
      }))
      .where('author_id', '=', authorId)
      .where('guid', '=', guid)
      .execute()
  }
```
(If Kysely's `coalesce`/`val` typing fights the nullable strings, use `sql` template: `sql\`coalesce(source_name, ${sourceName})\`` — same semantics; keep all three columns per-column.)
Update `core/test/migrations.test.ts`: the three `toBe(6)` pins become `toBe(7)`.

- [ ] **Step 5: Run — verify GREEN + typecheck**

Run: `npm test -w core && npm run typecheck -w core`
Expected: PASS (the renamed contract test, both new tests, whole suite); typecheck exit 0. Grep check: `grep -rn backfillSourceAttribution core/` returns NOTHING (rename complete).

- [ ] **Step 6: Commit**

```bash
git add core/src/domain/types.ts core/src/domain/repository.ts core/src/storage/sqlite.ts core/src/domain/ingest.ts core/src/domain/repository-contract.ts core/test/migrations.test.ts core/test/rich-content.test.ts
git commit -m "$(printf 'core: migration 7 — content_markdown ingest + per-column backfillItemExtras\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 2: Core — dual-contract feed emission + outbound sanitization (SEC-4)

**Files:**
- Create: `core/src/domain/markdown.ts`
- Modify: `core/src/domain/feed.ts`, `core/package.json` (deps already installed — verify only)
- Modify: `core/test/rich-content.test.ts` (append)

**Interfaces:**
- Produces: `renderLocalHtml(markdown: string): string` (marked → sanitize-html, the Global-Constraints allowlist). Feed items: LOCAL posts emit `description`/`content_html` = `renderLocalHtml(content)` + `sourceNs.markdown` = raw `content` (+ JSON Feed `content_text` = raw content); REMOTE posts emit `description` = `content` untouched + `sourceNs.markdown` = `contentMarkdown` when present.
- Consumes: Task 1's `Post.contentMarkdown`.

- [ ] **Step 1: Failing tests** — append to `core/test/rich-content.test.ts`:

```ts
import { renderLocalHtml } from '../src/domain/markdown.ts'
import { renderRssFeed, renderJsonFeed } from '../src/domain/feed.ts'
import type { User, Post } from '../src/domain/types.ts'

const alice: User = { id: 'u1', kind: 'local', handle: 'alice', displayName: 'Alice', feedUrl: null, createdAt: '2026-01-01T00:00:00.000Z' }
const basePost: Post = { id: 'p1', authorId: 'u1', source: 'local', guid: 'g-1', title: null, content: '', url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' }
const ctx = { publicUrl: 'https://cast.example', hubUrl: null, rssCloud: false }

test('renderLocalHtml renders markdown and sanitizes raw HTML a member typed (SEC-4)', () => {
  const html = renderLocalHtml('**bold** then <script>alert(1)</script> and https://a.ex/1')
  expect(html).toContain('<strong>bold</strong>')
  expect(html).toContain('<a href="https://a.ex/1" rel="noreferrer">') // GFM autolink + forced rel
  expect(html).not.toContain('<script>')
})

test('RSS dual contract: local posts emit rendered description + raw source:markdown', () => {
  const xml = renderRssFeed(alice, [{ ...basePost, content: '**hello** world' }], ctx)
  expect(xml).toContain('<strong>hello</strong>')
  expect(xml).toContain('<source:markdown>**hello** world</source:markdown>')
})

test('RSS pass-through: remote posts re-emit content untouched + stored markdown verbatim', () => {
  const remote = { ...basePost, id: 'p2', guid: 'g-2', source: 'remote' as const, content: '<p>as-authored &amp; untouched</p>', contentMarkdown: '**their** source' }
  const xml = renderRssFeed(alice, [remote], ctx)
  expect(xml).toContain('as-authored') // content not re-rendered/sanitized
  expect(xml).toContain('<source:markdown>**their** source</source:markdown>')
})

test('JSON Feed: local posts carry content_html (rendered) + content_text (raw markdown)', () => {
  const json = JSON.parse(renderJsonFeed(alice, [{ ...basePost, content: '**hello**' }], ctx))
  expect(json.items[0].content_html).toContain('<strong>hello</strong>')
  expect(json.items[0].content_text).toBe('**hello**')
})
```

- [ ] **Step 2: Run — verify RED**

Run: `npm test -w core`
Expected: FAIL — cannot resolve `markdown.ts` / no source:markdown emitted.

- [ ] **Step 3: Implement `core/src/domain/markdown.ts`**:

```ts
import { marked } from 'marked'
import sanitizeHtml from 'sanitize-html'

// SEC-4: HTML we GENERATE from local composes never ships dirty — a member's
// raw <script> in markdown passes through marked (probed) and dies here.
// Remote content is never routed through this: pass-through applies to
// OTHERS' content, not to HTML we author ourselves.
const SANITIZE_CONFIG: sanitizeHtml.IOptions = {
  allowedTags: ['p', 'br', 'a', 'em', 'strong', 'b', 'i', 'blockquote', 'code', 'pre', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'img'],
  allowedAttributes: { a: ['href', 'rel'], img: ['src', 'loading'] },
  allowedSchemes: ['http', 'https'],
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noreferrer' }),
    img: sanitizeHtml.simpleTransform('img', { loading: 'lazy' }),
  },
}

export function renderLocalHtml(markdown: string): string {
  return sanitizeHtml(marked.parse(markdown, { async: false }) as string, SANITIZE_CONFIG)
}
```

- [ ] **Step 4: Feed emission** — in `core/src/domain/feed.ts`, import `renderLocalHtml`, then in BOTH `renderRssFeed`'s and `renderCommentsFeed`'s item mapping replace the `description`/`sourceNs` construction. The current mapping spreads `replyWireElements(p.inReplyTo)` which itself contains a `sourceNs` key — the markdown key must MERGE with it, not clobber it. Extract a helper used by both:

```ts
// Dual contract per item: local posts emit rendered HTML + their markdown
// source; remote posts re-emit as stored (pass-through), incl. any captured
// source:markdown. Merges with replyWireElements' sourceNs (inReplyTo).
function itemContentFields(p: Post) {
  const reply = p.inReplyTo ? replyWireElements(p.inReplyTo) : undefined
  const markdown = p.source === 'local' ? p.content : p.contentMarkdown ?? undefined
  const sourceNs = { ...(reply?.sourceNs ?? {}), ...(markdown ? { markdown } : {}) }
  return {
    description: p.source === 'local' ? renderLocalHtml(p.content) : p.content,
    ...(Object.keys(sourceNs).length ? { sourceNs } : {}),
    ...(reply?.thr ? { thr: reply.thr } : {}),
  }
}
```
and the item maps become (RSS shown; comments feed identical shape):
```ts
      items: posts.map((p) => ({
        ...(p.title !== null ? { title: p.title } : {}), // Textcasting: never synthesize a title
        guid: { value: p.guid, isPermaLink: false },
        ...(p.url !== null ? { link: p.url } : {}),
        pubDate: p.publishedAt,
        ...itemContentFields(p),
      })),
```
JSON Feed items (in `renderJsonFeed`) become:
```ts
      items: posts.map((p) => ({
        id: p.guid,
        ...(p.title !== null ? { title: p.title } : {}),
        ...(p.source === 'local'
          ? { content_html: renderLocalHtml(p.content), content_text: p.content }
          : { content_text: p.content }),
        ...(p.url !== null ? { url: p.url } : {}),
        date_published: p.publishedAt,
      })),
```

- [ ] **Step 5: Run — verify GREEN + typecheck + existing-suite sanity**

Run: `npm test -w core && npm run typecheck -w core`
Expected: PASS. NOTE: existing feed/federation tests assert plain-text descriptions for local posts (e.g. the threading money test's `'hello from A'` — `marked` wraps it in `<p>…</p>`). `toContain('hello from A')` style assertions still pass; if any asserts EXACT equality on a local description, update it to the rendered form and say so in the report.

- [ ] **Step 6: Commit**

```bash
git add core/src/domain/markdown.ts core/src/domain/feed.ts core/test/rich-content.test.ts
git commit -m "$(printf 'core: Textcasting dual contract — rendered descriptions + source:markdown, outbound sanitized\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 3: Web — render.ts, PostBody chokepoint, styles

**Files:**
- Create: `web/src/lib/server/render.ts`, `web/src/lib/server/render.test.ts`, `web/src/lib/PostBody.svelte`
- Modify: `web/src/lib/types.ts`, `web/src/app.css`, and the five render sites: `web/src/routes/+page.svelte`, `web/src/routes/u/[handle]/+page.svelte`, `web/src/routes/u/[handle]/following/+page.svelte`, `web/src/routes/post/[id]/+page.svelte`, `web/src/lib/ReplyTree.svelte`

**Interfaces:**
- Produces: `renderPostHtml(post: { content: string; contentMarkdown?: string | null; source: 'local' | 'remote' }): string`; `enrichEntries<T extends …>(entries: T[]): (T & { contentHtml: string })[]`; `PostBody.svelte` with prop `{ post: TimelineEntry }` — the ONLY `{@html}` in the codebase.
- Consumes: nothing from Tasks 1–2 (web is independent until Task 4 wires ingress).

- [ ] **Step 1: Failing tests** — create `web/src/lib/server/render.test.ts`:

```ts
import { test, expect } from 'vitest'
import { renderPostHtml } from './render'

const remote = (content: string, contentMarkdown: string | null = null) => ({ content, contentMarkdown, source: 'remote' as const })
const local = (content: string) => ({ content, contentMarkdown: null, source: 'local' as const })

test('precedence: contentMarkdown wins; local content is markdown; remote content is HTML', () => {
	expect(renderPostHtml(remote('<p>ignored</p>', '**md**'))).toContain('<strong>md</strong>')
	expect(renderPostHtml(local('**md**'))).toContain('<strong>md</strong>')
	expect(renderPostHtml(remote('<blockquote>quoted</blockquote>'))).toContain('<blockquote>quoted</blockquote>')
})

test('hostile fixtures never survive', () => {
	expect(renderPostHtml(remote('<script>alert(1)</script>ok'))).not.toContain('script')
	expect(renderPostHtml(remote('<img src="x" onerror="p()">'))).not.toContain('onerror')
	expect(renderPostHtml(remote('<a href="javascript:alert(1)">x</a>'))).not.toContain('javascript:')
	expect(renderPostHtml(remote('<img src="data:image/png;base64,xx">'))).not.toContain('data:')
	expect(renderPostHtml(remote('<svg onload="p()"></svg>'))).not.toContain('svg')
	// THE load-bearing one: markdown that embeds raw HTML — marked passes it through
	expect(renderPostHtml(remote('x', 'safe **md**\n\n<script>alert(1)</script>'))).not.toContain('script')
	expect(renderPostHtml(remote('<p class="x" style="y">attrs stripped</p>'))).not.toContain('class=')
})

test('transform-added attributes survive in the OUTPUT (allowedAttributes gotcha)', () => {
	const out = renderPostHtml(local('[x](https://a.ex) and ![i](https://a.ex/i.png)'))
	expect(out).toContain('rel="noreferrer"')
	expect(out).toContain('loading="lazy"')
})

test('GFM autolink on markdown paths', () => {
	expect(renderPostHtml(local('see https://a.ex/1'))).toContain('<a href="https://a.ex/1"')
})
```

- [ ] **Step 2: Run — verify RED**

Run: `npm test -w web`
Expected: FAIL — cannot resolve `./render`.

- [ ] **Step 3: Implement `web/src/lib/server/render.ts`** (under `lib/server/` — SvelteKit build-fails any client import, so the sanitizer never reaches the browser):

```ts
import { marked } from 'marked'
import sanitizeHtml from 'sanitize-html'

const SANITIZE_CONFIG: sanitizeHtml.IOptions = {
	allowedTags: ['p', 'br', 'a', 'em', 'strong', 'b', 'i', 'blockquote', 'code', 'pre', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'img'],
	allowedAttributes: { a: ['href', 'rel'], img: ['src', 'loading'] },
	allowedSchemes: ['http', 'https'],
	transformTags: {
		a: sanitizeHtml.simpleTransform('a', { rel: 'noreferrer' }),
		img: sanitizeHtml.simpleTransform('img', { loading: 'lazy' })
	}
}

// The one render path. Precedence: source:markdown → local-compose markdown →
// remote HTML. Every branch ends in the sanitizer — marked passes raw HTML
// through (probed), so sanitize-after-marked is load-bearing.
export function renderPostHtml(post: { content: string; contentMarkdown?: string | null; source: 'local' | 'remote' }): string {
	const md = post.contentMarkdown ?? (post.source === 'local' ? post.content : null)
	const html = md !== null ? (marked.parse(md, { async: false }) as string) : post.content
	return sanitizeHtml(html, SANITIZE_CONFIG)
}

export function enrichEntries<T extends { content: string; contentMarkdown?: string | null; source: 'local' | 'remote' }>(entries: T[]): (T & { contentHtml: string })[] {
	return entries.map((e) => ({ ...e, contentHtml: renderPostHtml(e) }))
}
```

- [ ] **Step 4: Wire types + PostBody** — in `web/src/lib/types.ts` add to `TimelineEntry`:
```ts
	contentMarkdown?: string | null
	contentHtml?: string
```
Create `web/src/lib/PostBody.svelte`:
```svelte
<script lang="ts">
	import type { TimelineEntry } from './types'
	import { plaintext } from './plaintext'
	import { toggleClamp } from './expand'

	// THE {@html} chokepoint — the only one in the codebase. contentHtml is
	// produced exclusively by lib/server/render.ts (sanitized server-side at
	// all three ingress points); anything without it falls back to plaintext,
	// never raw.
	let { post }: { post: TimelineEntry } = $props()
</script>

<!-- click-to-expand is a pointer convenience; keyboard/AT users reach the full text via the conversation link -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="body" onclick={toggleClamp}>
	{#if post.contentHtml}
		{@html post.contentHtml}
	{:else}
		<p>{plaintext(post.content)}</p>
	{/if}
</div>
```
In each of the FIVE render sites, replace the body block
```svelte
					<!-- click-to-expand is a pointer convenience; keyboard/AT users reach the full text via the conversation link -->
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
					<p class="body" onclick={toggleClamp}><Linkified text={plaintext(post.content)} /></p>
```
with `<PostBody {post} />` (thread page's plain `<p><Linkified …/></p>` and ReplyTree's variant with `reply` likewise: `<PostBody post={reply} />`). Remove the now-unused `Linkified`/`plaintext`/`toggleClamp` imports from those five files (PostBody owns them). `Linkified`/`linkify.ts` stay in the tree for excerpt contexts.

- [ ] **Step 5: Styles** — append to `web/src/app.css`:

```css

/* Rich post bodies (rss.chat 7/6-7/7 lessons: quotes read as quotes,
   headings have hierarchy, code reads as code). Scoped inside .body so
   page chrome is untouched. div.body replaces the old p.body — same clamp. */

.post .body {
	cursor: default;
}

.post .body blockquote {
	margin: var(--space-sm) 0;
	padding-left: var(--space-md);
	border-left: 2px solid var(--color-border);
	color: var(--color-secondary);
}

.post .body h1, .post .body h2, .post .body h3, .post .body h4 {
	margin: var(--space-sm) 0 var(--space-xs);
	line-height: 1.25;
}
.post .body h1 { font-size: 1.25rem; }
.post .body h2 { font-size: 1.125rem; }
.post .body h3 { font-size: 1rem; }
.post .body h4 { font-size: 0.9375rem; }

.post .body code {
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	font-size: 0.875em;
	background: var(--color-muted);
	padding: 0.0625rem 0.25rem;
	border-radius: 4px;
}

.post .body pre {
	background: var(--color-muted);
	padding: var(--space-sm);
	border-radius: 8px;
	overflow-x: auto;
}

.post .body pre code {
	background: none;
	padding: 0;
}

.post .body img {
	max-width: 100%;
	height: auto;
}

.post .body ul, .post .body ol {
	padding-left: var(--space-lg);
}
```
(The existing `.post .body { max-height: 14rem; overflow: hidden; }` clamp rule applies to the div unchanged — verify it selects by class, not `p.body`; if it says `p.body` anywhere, change to `.body`.)

- [ ] **Step 6: Run — verify GREEN**

Run: `npm test -w web && npm run check -w web`
Expected: PASS; 0 errors/0 warnings. Also: `grep -rn "{@html" web/src/ | wc -l` → exactly 1 (in PostBody.svelte).

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/server/render.ts web/src/lib/server/render.test.ts web/src/lib/PostBody.svelte web/src/lib/types.ts web/src/app.css web/src/routes/+page.svelte "web/src/routes/u/[handle]/+page.svelte" "web/src/routes/u/[handle]/following/+page.svelte" "web/src/routes/post/[id]/+page.svelte" web/src/lib/ReplyTree.svelte
git commit -m "$(printf 'web: one sanitized render path — PostBody {@html} chokepoint + rich body styles\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 4: Web — the three ingress points

**Files:**
- Modify: `web/src/routes/+page.server.ts`, `web/src/routes/u/[handle]/+page.server.ts`, `web/src/routes/u/[handle]/following/+page.server.ts`, `web/src/routes/post/[id]/+page.server.ts` (ingress 1)
- Modify: `web/src/routes/post/[id]/thread.json/+server.ts` (ingress 2 — SEC-1)
- Modify: `web/src/routes/stream/+server.ts`, `web/src/routes/stream/server.test.ts` (ingress 3 — COR-3)

**Interfaces:**
- Consumes: Task 3's `enrichEntries`/`renderPostHtml`.
- Produces: every `TimelineEntry` reaching the browser carries `contentHtml`.

- [ ] **Step 1: Ingress 1 — page loads.** In each `+page.server.ts`, import `enrichEntries` from `$lib/server/render` and wrap the fetched entries. Home (`web/src/routes/+page.server.ts`):
```ts
		const { timeline, nextCursor } = await getTimeline(fetch, { before })
		return { timeline: enrichEntries(timeline), nextCursor, isFirstPage }
```
Author lens and following lens: same one-line wrap of their `timeline`. Thread page (`post/[id]/+page.server.ts`):
```ts
		const thread = await getThread(fetch, params.id)
		return { postId: params.id, thread: enrichEntries(thread), rootId: thread[0]?.id ?? params.id }
```

- [ ] **Step 2: Ingress 2 — thread.json (SEC-1).** Replace the body-pipe in `web/src/routes/post/[id]/thread.json/+server.ts`:
```ts
import type { RequestHandler } from './$types'
import { env } from '$env/dynamic/private'
import { enrichEntries } from '$lib/server/render'

const base = () => env.CORE_API_URL ?? 'http://localhost:8787'

// SEC-1: this is the wedge's ingress — thread entries include remote
// (untrusted) content and MUST be enriched server-side like every other
// route to the browser.
export const GET: RequestHandler = async ({ params, fetch }) => {
	const upstream = await fetch(`${base()}/post/${encodeURIComponent(params.id)}/thread`)
	if (!upstream.ok) {
		return new Response(upstream.body, { status: upstream.status, headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' } })
	}
	const body = (await upstream.json()) as { thread: Parameters<typeof enrichEntries>[0] }
	return Response.json({ thread: enrichEntries(body.thread) })
}
```

- [ ] **Step 3: Failing SSE tests first.** Append to `web/src/routes/stream/server.test.ts`:
```ts
test('post events gain contentHtml; id and event lines are byte-verbatim (replay contract)', async () => {
	const frame = `event: post\nid: p-1\ndata: ${JSON.stringify({ id: 'p-1', content: '<script>x</script><p>hi</p>', source: 'remote', author: {} })}\n\n`
	const body = new ReadableStream({
		start(controller) {
			const b = new TextEncoder().encode(frame)
			// split mid-frame to prove chunk buffering works
			controller.enqueue(b.slice(0, 25))
			controller.enqueue(b.slice(25))
			controller.close()
		}
	})
	global.fetch = vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch
	const res = await GET({ request: new Request('http://x/stream') } as never)
	const text = await res.text()
	expect(text).toContain('event: post\n')
	expect(text).toContain('id: p-1\n')
	const data = JSON.parse(text.split('data: ')[1].split('\n')[0])
	expect(data.contentHtml).toContain('<p>hi</p>')
	expect(data.contentHtml).not.toContain('script')
})

test('an unparseable frame forwards untouched', async () => {
	const frame = 'event: post\nid: p-2\ndata: not-json\n\n'
	const body = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(frame))
			controller.close()
		}
	})
	global.fetch = vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch
	const res = await GET({ request: new Request('http://x/stream') } as never)
	expect(await res.text()).toContain('data: not-json\n')
})
```
Run: `npm test -w web` — Expected: FAIL (no enrichment happens).

- [ ] **Step 4: Ingress 3 — the SSE frame parser.** Replace the streaming return in `web/src/routes/stream/+server.ts` (keep the Last-Event-ID forwarding and error-status branch exactly as they are):
```ts
	// COR-3: a real SSE frame transformer, not a body pipe. Frames are
	// buffered across chunks and split on the blank-line delimiter; id: and
	// event: lines pass through BYTE-VERBATIM (the Last-Event-ID replay
	// contract rests on them); only post events' data: JSON is enriched.
	// Anything unparseable forwards untouched — the client falls back to
	// plaintext, never raw.
	const decoder = new TextDecoder()
	const encoder = new TextEncoder()
	let buffer = ''
	const enrichFrame = (frame: string): string => {
		if (!/^event: post$/m.test(frame)) return frame
		return frame
			.split('\n')
			.map((line) => {
				if (!line.startsWith('data: ')) return line
				try {
					const entry = JSON.parse(line.slice(6))
					return `data: ${JSON.stringify({ ...entry, contentHtml: renderPostHtml(entry) })}`
				} catch {
					return line
				}
			})
			.join('\n')
	}
	const transformed = upstream.body!.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				buffer += decoder.decode(chunk, { stream: true })
				const frames = buffer.split('\n\n')
				buffer = frames.pop() ?? ''
				for (const frame of frames) controller.enqueue(encoder.encode(enrichFrame(frame) + '\n\n'))
			},
			flush(controller) {
				if (buffer) controller.enqueue(encoder.encode(enrichFrame(buffer)))
			}
		})
	)
	return new Response(transformed, {
		status: upstream.status,
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache'
		}
	})
```
Add the import: `import { renderPostHtml } from '$lib/server/render'`.

- [ ] **Step 5: Run — all four gates**

Run: `npm test -w web && npm run check -w web && npm test -w core && npm run typecheck -w core`
Expected: all green (existing stream tests still pass — plain frames forward verbatim).

- [ ] **Step 6: Commit**

```bash
git add web/src/routes/+page.server.ts "web/src/routes/u/[handle]/+page.server.ts" "web/src/routes/u/[handle]/following/+page.server.ts" "web/src/routes/post/[id]/+page.server.ts" "web/src/routes/post/[id]/thread.json/+server.ts" web/src/routes/stream/+server.ts web/src/routes/stream/server.test.ts
git commit -m "$(printf 'web: contentHtml at all three ingress points — loads, thread.json, SSE frame parser\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 5: Live verification + RUNNING.md

**Files:**
- Modify: `docs/superpowers/documentation/RUNNING.md`

- [ ] **Step 1: Live obscura check** (dev servers must be running). Fetch `http://localhost:5173/` with obscura (`obscura fetch --allow-private-network --wait 6 --dump html http://localhost:5173/ | grep -c "<blockquote>\|<script"`) or the MCP equivalents, and verify: (a) rich elements present (Dave's quote-heavy rss.chat posts render `blockquote`/`a`/`strong` inside `.body`), (b) ZERO `<script>` inside any `.body`, (c) compose a local post containing `**bold** and <script>alert(1)</script>` via the UI form, confirm it renders bold with no script, and its feed (`curl http://localhost:8787/users/<handle>/feed.xml`) carries `<source:markdown>` raw + sanitized rendered description.

- [ ] **Step 2: RUNNING.md** — in the Feature notes section: local composes are Markdown (GFM; bare URLs autolink); feeds emit the Textcasting dual contract (`source:markdown` = your source, description = rendered HTML); incoming `source:markdown` is preferred for display; post bodies render a safe HTML subset (quotes, headings, code, lists, links, lazy images) — everything else is stripped at render time, feeds always carry the original.

- [ ] **Step 3: Whole-milestone gates**

Run: `npm test -w core && npm run typecheck -w core && npm test -w web && npm run check -w web`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/documentation/RUNNING.md
git commit -m "$(printf 'docs: markdown composes, dual-contract feeds, safe rich rendering\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

## Self-Review (done at plan-writing time)

- **Spec coverage:** migration 7 + verbatim capture + COR-1 per-column COALESCE + COR-2 trigger + COR-4 enumerated sites → Task 1; SEC-4 outbound sanitization + dual contract (RSS, comments feed via shared `itemContentFields`, JSON Feed) + pass-through pins → Task 2; render.ts + allowlist + transformTags gotcha pinned in output + hostile fixtures incl. the raw-HTML-in-Markdown load-bearing one + PostBody single `{@html}` (grep-checked) + styles per 7/6–7/7 lessons → Task 3; SEC-1 three ingress points, SSE parser with chunk-buffering + verbatim-id tests → Task 4; live verification + docs → Task 5. Non-goals absent (no iframes, no uploads, no highlighting, no sanitizer cache — `ponytail:` render-per-request). ✅
- **Placeholder scan:** every code step complete; the two typing escape-hatches (Kysely coalesce, feedsmith sourceNs.markdown item type) each state the concrete fallback code. ✅
- **Type consistency:** `contentMarkdown` naming identical across ParsedItem/Post/PostsTable(content_markdown)/TimelineEntry; `renderPostHtml`/`enrichEntries` signatures match between Task 3 definition and Task 4 usage; `backfillItemExtras(authorId, guid, sourceName, sourceFeedUrl, contentMarkdown)` identical in repository.ts, sqlite.ts, ingest trigger, and contract test. `itemContentFields` consumes `replyWireElements` (exists, exported, Task 4 of threading). ✅
- **Probe-accuracy:** marked 18.0.6 + sanitize-html installed in BOTH workspaces before writing; all embedded sanitizer/marked behavior probed this session (autolink, raw-HTML passthrough, hostile stripping, transformTags+allowedAttributes interplay).
