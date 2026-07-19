# Reply-context from embedded h-cite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract an embedded h-cite's URL so object-form `in-reply-to` replies thread (a latent bug fix), and capture the parent's author + a snippet so an unresolved reply renders legible context instead of a bare link — as the replier's unverified claim.

**Architecture:** Consume-side, h-feed path. A pure parse helper turns the JF2 `in-reply-to` (string OR h-cite object, incl. the `{children:[]}` multi-cite wrapper and array `url`) into a thread ref + optional context (author required); two nullable `posts` columns carry it; threading is unchanged; a generic gate helper nulls the context once the parent resolves, at three serialization sites; a small `ReplyContext.svelte` renders it as **plain text** on four surfaces.

**Tech Stack:** Hono/Node core (better-sqlite3 + Kysely, Node 22 native type-stripping — no build, no TS parameter properties, `.ts` import extensions), `@paulrobertlloyd/mf2tojf2` (installed), SvelteKit web (Svelte 5.56 runes, plain scoped CSS `--color-*`), vitest.

**Spec:** `docs/superpowers/specs/2026-07-19-reply-context-design.md` (rev 4).

## Global Constraints

- **Plain-text render (security boundary, load-bearing):** author/snippet are rendered as **text nodes — NEVER `{@html}`**, never interpolated into any HTML string. `{@html}` stays in `PostBody.svelte` only.
- **The render guard — quote it verbatim; do NOT copy the old `startsWith('http')`-only block:** show **context** when `!inReplyToPostId && replyContextAuthor`; else the **bare link** when `!inReplyToPostId && inReplyTo?.startsWith('http')`; else nothing.
- **Render shape** (in `ReplyContext.svelte`): author+snippet → `In reply to {author}: “{snippet}” ↗`; author only → `In reply to {author} ↗` (**no colon, no quotes — never render `“”`**); `↗` is a real `<a href rel="noreferrer">` only when a URL exists.
- **Context requires an author** — `parseInReplyTo` drops a snippet-with-no-author (unrenderable under the author-keyed guard). So `replyContextSnippet` is non-null only when `replyContextAuthor` is non-null.
- **Author rendered verbatim** — no fabricated `@`.
- **Render surfaces:** the **three timeline surfaces get a textually identical block** — `web/src/routes/+page.svelte`, `web/src/routes/u/[handle]/+page.svelte`, `web/src/routes/u/[handle]/following/+page.svelte`. **Post-detail (`post/[id]/+page.svelte`) has its OWN block** (a `{#if parent}/{:else if}` chain with a full-URL `.subnav` fallback) — see Task 4.
- **`truncate` is code-point-safe** (`Array.from`, per `feed.ts:200`), **trims BEFORE cutting** (empty/whitespace → `null`, never a bare `…`), slice a bounded prefix before `Array.from`, cap **200 code points**.
- **Context reaches `toParsedItem` as ONE trailing options object** (`{ author, snippet }`), not two positionals.
- **The context must be added at FOUR core sites or it silently no-ops:** `PostsTable` (`sqlite.ts:9`), `rowToPost` (`sqlite.ts:20-21`), `insertPost .values` (`sqlite.ts:181`), the `Post` object (`ingest.ts:158-165`).
- **Trust gate — a single generic helper `hideResolvedReplyContext` at THREE sites:** `joinedRowToEntry` (`sqlite.ts:34`), `emitNewPost` (`bus.ts`), and `GET /posts/:id/revisions` (`app.ts:127`). `POST /posts` + `PATCH /posts/:id` are safe by invariant (local posts never carry context) — one comment each, no gate.
- **Explicit VALUE imports for the helper** — `bus.ts` and `sqlite.ts` import `types.ts` via `import type` only; a runtime value folded into those lines type-checks clean then **erases under native type stripping** → runtime `TypeError`. Add a separate `import { hideResolvedReplyContext } from '…/types.ts'`.
- **New replies only** — do NOT extend `backfillItemExtras`; pre-feature stored orphans stay orphaned.
- **No new dependency, no fetch, no new Hono route.** Read the installed source before using an API.
- **UI/route skills:** Task 4 MUST invoke `ui-ux-pro-max:ui-ux-pro-max` + follow `MASTER.md` (`--color-secondary`, no raw hex) and consult `svelte-runes`/`sveltekit-data-flow`; Task 3 writes a route test → invoke the `hono` skill (CLAUDE.md). No Tailwind, no component libs, no new deps.
- **Git — shared checkout:** stage explicit paths, **never `git add -A`**. Trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Known flaky:** a full `npm test -w core` may show one `ingest.test.ts > pollAll swallows an oversized feed` timeout — a load artifact, passes isolated; not a regression.

## File Structure

- **Modify `core/src/domain/discovery.ts`** — export `parseInReplyTo` + `truncate`; wire `discoverFeed`.
- **Modify `core/src/domain/ingest.ts`** — `ParsedItem` + `toParsedItem` (trailing `reply` options); the `Post` object.
- **Modify `core/src/domain/types.ts`** — `Post` fields + the generic `hideResolvedReplyContext` helper.
- **Modify `core/src/storage/sqlite.ts`** — migration, `PostsTable`, `rowToPost`, `insertPost`, `joinedRowToEntry` (gate) + value import.
- **Modify `core/src/domain/bus.ts`** — `emitNewPost` (gate) + value import.
- **Modify `core/src/api/app.ts`** — `GET /posts/:id/revisions` (gate) + value import; comments on `POST`/`PATCH`.
- **Create `web/src/lib/ReplyContext.svelte`** — the plain-text context render.
- **Modify `web/vitest.config.ts`** — add `plugins: [svelte()]` (already-present devDep) so `.svelte` imports compile in tests.
- **Modify `web/src/lib/types.ts`** (`TimelineEntry`), **`web/src/app.css`** (`.reply-context`), the **four** surfaces.
- **Tests:** `core/test/discovery.test.ts` (create/extend), `core/test/ingest.test.ts` (extend), `core/test/api.test.ts` (extend — **not** `app.test.ts`), `web/src/lib/ReplyContext.test.ts` (create).

---

### Task 1: Core parse — `parseInReplyTo` + `truncate`, wired into `discoverFeed`

**Files:** Modify `core/src/domain/discovery.ts`, `core/src/domain/ingest.ts`. Test `core/test/discovery.test.ts`.

**Interfaces:**
- Produces: `export function parseInReplyTo(irt: unknown): { ref: string | null; contextAuthor: string | null; contextSnippet: string | null }`; `export function truncate(s: string | null, n: number): string | null`; `ParsedItem.replyContextAuthor/.replyContextSnippet: string | null`; `toParsedItem(…, updatedAt = null, reply?: { author: string | null; snippet: string | null })`.

- [ ] **Step 1: Write the failing tests** — `core/test/discovery.test.ts` (match the file's import style)

```ts
import { test, expect } from 'vitest'
import { parseInReplyTo, truncate } from '../src/domain/discovery.ts'

test('parseInReplyTo: string ref → ref, no context', () => {
  expect(parseInReplyTo('https://a/1')).toEqual({ ref: 'https://a/1', contextAuthor: null, contextSnippet: null })
})
test('parseInReplyTo: single h-cite → url ref + author + snippet', () => {
  const cite = { type: 'cite', url: 'https://a/1', author: { type: 'card', name: 'aaronpk' }, content: { html: '<p>hi</p>', text: 'hi there' } }
  expect(parseInReplyTo(cite)).toEqual({ ref: 'https://a/1', contextAuthor: 'aaronpk', contextSnippet: 'hi there' })
})
test('parseInReplyTo: multi-cite {children:[…]} → first cite ref (F1)', () => {
  const irt = { children: [{ type: 'cite', url: 'https://a/1', author: { name: 'x' } }, { type: 'cite', url: 'https://a/2' }] }
  expect(parseInReplyTo(irt).ref).toBe('https://a/1')
})
test('parseInReplyTo: array url → url[0] (F2)', () => {
  expect(parseInReplyTo({ type: 'cite', url: ['https://a/1', 'https://a/2'], author: { name: 'x' } }).ref).toBe('https://a/1')
})
test('parseInReplyTo: plain-string author', () => {
  expect(parseInReplyTo({ type: 'cite', url: 'https://a/1', author: 'Aaron Parecki' }).contextAuthor).toBe('Aaron Parecki')
})
test('parseInReplyTo: no url → ref null, author kept', () => {
  expect(parseInReplyTo({ type: 'cite', author: { name: 'x' } })).toEqual({ ref: null, contextAuthor: 'x', contextSnippet: null })
})
test('parseInReplyTo: html-only content → snippet null (author-only)', () => {
  expect(parseInReplyTo({ type: 'cite', url: 'https://a/1', author: { name: 'x' }, content: { html: '<p>hi</p>' } }).contextSnippet).toBeNull()
})
test('parseInReplyTo: snippet but NO author → whole context dropped (P4)', () => {
  expect(parseInReplyTo({ type: 'cite', url: 'https://a/1', content: { text: 'hi' } }))
    .toEqual({ ref: 'https://a/1', contextAuthor: null, contextSnippet: null })
})
test('parseInReplyTo: non-cite / undefined → all null', () => {
  expect(parseInReplyTo(undefined)).toEqual({ ref: null, contextAuthor: null, contextSnippet: null })
})

test('truncate: null / empty / all-whitespace → null (never a bare …)', () => {
  expect(truncate(null, 200)).toBeNull()
  expect(truncate('   ', 200)).toBeNull()
})
test('truncate: short string returned as-is (trimmed)', () => {
  expect(truncate('  hi  ', 200)).toBe('hi')
})
test('truncate: >n code points → n + …, code-point-safe at an astral boundary', () => {
  const out = truncate('😀'.repeat(250), 200)!
  expect(Array.from(out)).toHaveLength(201) // 200 code points + the …
  expect(out.endsWith('…')).toBe(true)
  expect(out).not.toContain('�') // no split surrogate
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w core -- discovery`
Expected: FAIL — `parseInReplyTo`/`truncate` not exported / not a function.

- [ ] **Step 3: Implement the helpers** (`core/src/domain/discovery.ts`, exported, near the top)

```ts
// code-point-safe (plain .slice splits surrogate pairs); trim BEFORE cutting so
// whitespace never becomes a bare '…'; slice a bounded UTF-16 prefix before
// Array.from (bodies capped only by MAX_FEED_BYTES = 5 MB). Mirrors feed.ts:200.
export function truncate(s: string | null, n: number): string | null {
  const t = s?.trim()
  if (!t) return null
  const cp = Array.from(t.slice(0, n * 2 + 2))
  return cp.length > n ? cp.slice(0, n).join('').trimEnd() + '…' : t
}

export function parseInReplyTo(irt: unknown): {
  ref: string | null
  contextAuthor: string | null
  contextSnippet: string | null
} {
  let v = irt
  if (v && typeof v === 'object' && Array.isArray((v as { children?: unknown }).children)) {
    v = (v as { children: unknown[] }).children[0] // F1: multi-cite wrapper
  }
  const first = Array.isArray(v) ? v[0] : v
  if (typeof first === 'string') return { ref: first, contextAuthor: null, contextSnippet: null }
  if (first && typeof first === 'object') {
    const cite = first as { url?: unknown; author?: unknown; content?: unknown }
    const url = cite.url
    const ref = typeof url === 'string' ? url : Array.isArray(url) && typeof url[0] === 'string' ? url[0] : null // F2
    const author =
      cite.author && typeof cite.author === 'object' && typeof (cite.author as { name?: unknown }).name === 'string'
        ? (cite.author as { name: string }).name
        : typeof cite.author === 'string' ? cite.author : null
    if (!author) return { ref, contextAuthor: null, contextSnippet: null } // P4: no author → no renderable context
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

- [ ] **Step 4: Extend `ParsedItem` + `toParsedItem`** (`core/src/domain/ingest.ts`)

Add to the `ParsedItem` interface (after `updatedAt`): `replyContextAuthor: string | null; replyContextSnippet: string | null`.
Append a trailing options param to `toParsedItem` (after `updatedAt: string | null = null`): `reply: { author: string | null; snippet: string | null } = { author: null, snippet: null }`; and in the returned object literal (after `updatedAt`): `replyContextAuthor: reply.author, replyContextSnippet: reply.snippet`.

- [ ] **Step 5: Wire `discoverFeed`** (`core/src/domain/discovery.ts:54-56`) — replace the inline extraction (import `parseInReplyTo` is local to the file):

```ts
      const irt = e['in-reply-to']
      const { ref, contextAuthor, contextSnippet } = parseInReplyTo(irt)
      return toParsedItem(e.uid ?? e.url, title, content, e.url ?? null, rawDate, now, ref, undefined, null, null, { author: contextAuthor, snippet: contextSnippet })
```

(Grep every `toParsedItem(` call site: only this h-feed one passes `reply`; the RSS caller omits it → defaults.)

- [ ] **Step 6: Run tests + typecheck** — `npm test -w core -- discovery` → PASS; `npm run typecheck -w core` → clean.

- [ ] **Step 7: Commit**

```bash
git add core/src/domain/discovery.ts core/src/domain/ingest.ts core/test/discovery.test.ts
git commit -m "core: parse embedded h-cite in-reply-to (thread ref + author-gated context)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Core persistence — two columns + carry the context to the DB

**Files:** Modify `core/src/storage/sqlite.ts`, `core/src/domain/ingest.ts`, `core/src/domain/types.ts`. Test `core/test/ingest.test.ts`.

**Interfaces:**
- Consumes: `ParsedItem.replyContext*` (Task 1); `createRemoteUser`, `insertPost` (returns `boolean`), `getPostsByAuthor`, `getPost`, `findPostByRef`.
- Produces: `Post.replyContextAuthor?/.replyContextSnippet?: string | null` persisted; object-form h-cite replies thread.

- [ ] **Step 1: Write the failing test** (`core/test/ingest.test.ts` — use the file's real repo/bus setup; drive `ingestItems` with a hand-built `ParsedItem` to keep the mf2 fixture out of it)

```ts
test('h-cite reply persists context and threads onto an existing parent', async () => {
  const feed = await repo.createRemoteUser({ handle: 'aaron', displayName: 'Aaron', feedUrl: 'https://e/f.xml' })
  await repo.insertPost({ id: 'P', authorId: feed.id, source: 'remote', guid: 'pg', title: null, content: 'parent', url: 'https://a/1', publishedAt: '2026-07-19T00:00:00Z', createdAt: '2026-07-19T00:00:00Z', inReplyTo: null, inReplyToPostId: null, threadRootId: null })
  const items = [toParsedItem('rg', null, 'my reply', 'https://a/2', '2026-07-19T00:01:00Z', new Date().toISOString(), 'https://a/1', undefined, null, null, { author: 'aaronpk', snippet: 'nice one' })]
  await ingestItems(repo, bus, feed, items)
  const reply = (await repo.getPostsByAuthor(feed.id, 50)).find((p) => p.guid === 'rg')!
  const stored = await repo.getPost(reply.id) // getPost is NOT gated → raw context readable
  expect(stored?.replyContextAuthor).toBe('aaronpk')
  expect(stored?.replyContextSnippet).toBe('nice one')
  expect(stored?.inReplyToPostId).toBe('P') // threaded, not orphaned — the bug fix
})
```

*(`posts.author_id` is an enforced FK — the `createRemoteUser` first is mandatory. `insertPost` returns a boolean; ignore it here. Match the file's existing repo/bus construction.)*

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w core -- ingest`
Expected: FAIL — `stored.replyContextAuthor` is `undefined` (columns/plumbing absent).

- [ ] **Step 3: Add the migration** (`core/src/storage/sqlite.ts`) — append a NEW element as the last entry of the `MIGRATIONS: string[][]` array (after the `edited_at`/`post_revisions` migration's `]`):

```ts
  [
    'ALTER TABLE posts ADD COLUMN reply_context_author text',
    'ALTER TABLE posts ADD COLUMN reply_context_snippet text',
  ],
```

- [ ] **Step 4: Thread the four literal sites + the `Post` type**

`PostsTable` (`sqlite.ts:9`, append): `reply_context_author: string | null; reply_context_snippet: string | null`.
`rowToPost` (`sqlite.ts:20-21`, append to the returned object): `replyContextAuthor: r.reply_context_author, replyContextSnippet: r.reply_context_snippet`.
`insertPost .values({…})` (`sqlite.ts:181`, append): `reply_context_author: p.replyContextAuthor ?? null, reply_context_snippet: p.replyContextSnippet ?? null`.
`Post` object in `ingest.ts:158-165` (append, mirroring `contentMarkdown`): `replyContextAuthor: item.replyContextAuthor, replyContextSnippet: item.replyContextSnippet,`.
`Post` interface in `core/src/domain/types.ts` (after `contentMarkdown`): `replyContextAuthor?: string | null; replyContextSnippet?: string | null`.

- [ ] **Step 5: Run tests + typecheck** — `npm test -w core -- ingest` → PASS; `npm run typecheck -w core` → clean; `npm test -w core` once (flaky note) → all pass.

- [ ] **Step 6: Commit**

```bash
git add core/src/storage/sqlite.ts core/src/domain/ingest.ts core/src/domain/types.ts core/test/ingest.test.ts
git commit -m "core: persist reply-context columns (migration + Post plumbing)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Core serialization — the trust gate at three sites

**Files:** Modify `core/src/domain/types.ts` (helper), `core/src/storage/sqlite.ts` (`joinedRowToEntry`), `core/src/domain/bus.ts` (`emitNewPost`), `core/src/api/app.ts` (revisions route + POST/PATCH comments). Test `core/test/api.test.ts`.

- [ ] **Step 1: Invoke the `hono` skill** (CLAUDE.md — this task writes/extends a route test). Read the installed Hono if any request/response detail is uncertain; add no route.

- [ ] **Step 2: Write the failing tests** (`core/test/api.test.ts` — the real file; supports `app.request('/timeline')` unauthenticated)

```ts
test('reply-context is nulled on a resolved reply, kept on an orphan (timeline + revisions)', async () => {
  // ingest a parent 'https://a/1' + a reply that resolves onto it (context stored),
  // and an orphan reply to 'https://a/unknown' carrying context. (Match the file's ingest setup.)
  const { timeline } = await (await app.request('/timeline')).json()
  const resolved = timeline.find((e: any) => e.inReplyToPostId)
  const orphan = timeline.find((e: any) => !e.inReplyToPostId && e.replyContextAuthor)
  expect(resolved.replyContextAuthor).toBeNull()
  expect(orphan.replyContextAuthor).not.toBeNull()
  // P2: the revisions route serializes getPost — also gated
  const rev = await (await app.request(`/posts/${resolved.id}/revisions`)).json()
  expect(rev.post.replyContextAuthor).toBeNull()
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm test -w core -- api`
Expected: FAIL — `resolved.replyContextAuthor` non-null (no gate yet).

- [ ] **Step 4: Add the generic helper** (`core/src/domain/types.ts`, near `Post`/`TimelineEntry`)

```ts
// A resolved reply's reply-context is the replier's unverified claim about a
// parent we now have for real — it must never leave core. Generic so it wraps
// both a TimelineEntry (joinedRowToEntry, emitNewPost) and a bare Post (the
// revisions route). Applied at every client-facing serialization site.
export function hideResolvedReplyContext<T extends { inReplyToPostId?: string | null; replyContextAuthor?: string | null; replyContextSnippet?: string | null }>(e: T): T {
  return e.inReplyToPostId ? { ...e, replyContextAuthor: null, replyContextSnippet: null } : e
}
```

- [ ] **Step 5: Apply at the three sites — with EXPLICIT VALUE IMPORTS (P6)**

`core/src/storage/sqlite.ts` — add a value import (its `types.ts` import is `import type` only): `import { hideResolvedReplyContext } from '../domain/types.ts'`. Wrap `joinedRowToEntry`'s return:
```ts
function joinedRowToEntry(r: JoinedRow): TimelineEntry {
  return hideResolvedReplyContext({
    ...rowToPost(r),
    author: { id: r.u_id, kind: r.u_kind, handle: r.u_handle, displayName: r.u_display_name, feedUrl: r.u_feed_url, createdAt: r.u_created_at, authUserId: r.u_auth_user_id },
  })
}
```
`core/src/domain/bus.ts` — add `import { hideResolvedReplyContext } from './types.ts'` (its `TimelineEntry` import is `import type`). Gate the emit: `emitNewPost(e) { emitter.emit('new-post', hideResolvedReplyContext(e)) },`.
`core/src/api/app.ts` — add `import { hideResolvedReplyContext } from '../domain/types.ts'`. Gate the revisions route (`app.ts:127-130`): `return c.json({ post: hideResolvedReplyContext(post), revisions: await service.getRevisions(post.id) })`. Add a one-line comment at the `POST /posts` and `PATCH /posts/:id` returns: `// local post — never carries reply-context (h-feed ingest only); no gate needed`.

- [ ] **Step 6: Run tests + typecheck** — `npm test -w core -- api` → PASS; `npm run typecheck -w core` → clean; `npm test -w core` once (flaky note) → all pass (confirms Task 2's `getPost` persistence test still green — `getPost` itself is not gated).

- [ ] **Step 7: Commit**

```bash
git add core/src/domain/types.ts core/src/storage/sqlite.ts core/src/domain/bus.ts core/src/api/app.ts core/test/api.test.ts
git commit -m "core: trust gate — drop reply-context at the three serialization sites once resolved

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Web — `ReplyContext.svelte` + render on four surfaces

**Files:** Create `web/src/lib/ReplyContext.svelte`; modify `web/src/lib/types.ts`, `web/src/app.css`, and the four surfaces. Test `web/src/lib/ReplyContext.test.ts`.

**Interfaces:** Consumes `entry.replyContextAuthor/.replyContextSnippet/.inReplyTo/.inReplyToPostId` (serialized by Tasks 2–3). Produces `ReplyContext.svelte` with props `{ author: string; snippet?: string | null; url?: string | null }`.

- [ ] **Step 1: Invoke the UI skill first** — `ui-ux-pro-max:ui-ux-pro-max` + `MASTER.md` (`--color-secondary`, no raw hex); consult `svelte-runes` + `sveltekit-data-flow`. No Tailwind, no new deps.

- [ ] **Step 2: Add the fields to `TimelineEntry`** (`web/src/lib/types.ts`, after `inReplyToPostId`): `replyContextAuthor?: string | null; replyContextSnippet?: string | null`.

- [ ] **Step 3: Add the CSS** (`web/src/app.css`) — `.reply-context` also styles the inner `<a>`, overriding the global accent-anchor rule (its specificity wins):

```css
.reply-context {
	color: var(--color-secondary);
	font-size: 0.875rem;
}
```

- [ ] **Step 4: Create `web/src/lib/ReplyContext.svelte`** (plain text — no `{@html}`; author required, snippet/url optional)

```svelte
<script lang="ts">
	let { author, snippet = null, url = null }: { author: string; snippet?: string | null; url?: string | null } = $props()
</script>
<span class="reply-context">In reply to {author}{#if snippet}: “{snippet}”{/if}{#if url} <a class="reply-context" href={url} rel="noreferrer">↗</a>{/if}</span>
```

- [ ] **Step 5: Enable Svelte-component compilation in the test config** — `web/vitest.config.ts` currently has **no svelte plugin**, so an `import … from './ReplyContext.svelte'` won't compile at all. Add the plugin (already a devDependency `@sveltejs/vite-plugin-svelte` — no new dep):

```ts
import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
	plugins: [svelte()],
	test: { include: ['src/**/*.test.ts'] },
	resolve: {
		alias: {
			'$env/dynamic/private': new URL('./test/env-stub.ts', import.meta.url).pathname,
			$lib: new URL('./src/lib', import.meta.url).pathname
		}
	}
})
```

vitest's node environment runs the SSR transform, so `svelte/server`'s `render()` works with no DOM env.

- [ ] **Step 6: Write the failing component test** (`web/src/lib/ReplyContext.test.ts`) — SSR via `svelte/server` (runs in the node harness, DOM-free)

```ts
import { test, expect } from 'vitest'
import { render } from 'svelte/server'
import ReplyContext from './ReplyContext.svelte'

test('author + snippet + url → text with an <a>, quoted snippet', () => {
  const { body } = render(ReplyContext, { props: { author: 'aaronpk', snippet: 'hi', url: 'https://a/1' } })
  expect(body).toContain('In reply to aaronpk')
  expect(body).toContain('“hi”')
  expect(body).toContain('href="https://a/1"')
})
test('author only → no colon, no quotes (F5/P9 — never “”)', () => {
  const { body } = render(ReplyContext, { props: { author: 'aaronpk' } })
  expect(body).toContain('In reply to aaronpk')
  expect(body).not.toContain('“')
})
test('author/snippet are escaped text, not HTML (security boundary)', () => {
  const { body } = render(ReplyContext, { props: { author: '<b>x</b>', snippet: '<i>y</i>' } })
  expect(body).not.toContain('<b>')
  expect(body).toContain('&lt;b&gt;')
})
```

Run: `npm test -w web -- ReplyContext` → FAIL (component absent).

- [ ] **Step 7: Place the block on the four surfaces**

**Three timeline surfaces — identical** (`web/src/routes/+page.svelte`, `web/src/routes/u/[handle]/+page.svelte`, `web/src/routes/u/[handle]/following/+page.svelte`): add `import ReplyContext from '$lib/ReplyContext.svelte'` and replace each existing bare-link block (the `{#if post.inReplyTo && !post.inReplyToPostId && post.inReplyTo.startsWith('http')}<a class="source">in reply to ↗</a>{/if}`) with:

```svelte
{#if !post.inReplyToPostId && post.replyContextAuthor}
	<ReplyContext author={post.replyContextAuthor} snippet={post.replyContextSnippet} url={post.inReplyTo?.startsWith('http') ? post.inReplyTo : null} />
{:else if post.inReplyTo && !post.inReplyToPostId && post.inReplyTo.startsWith('http')}
	<a class="source" href={post.inReplyTo} rel="noreferrer">in reply to ↗</a>
{/if}
```

**Post-detail (`web/src/routes/post/[id]/+page.svelte`, its OWN block, P5)** — insert the context branch into the existing `{#if parent}/{:else if}` chain (`:81-85`), keeping the full-URL `.subnav` fallback; add the import:

```svelte
{#if parent}
	<p class="subnav">Replying to <a href="/post/{parent.id}">@{parent.author.handle}</a></p>
{:else if viewed && !viewed.inReplyToPostId && viewed.replyContextAuthor}
	<p class="subnav"><ReplyContext author={viewed.replyContextAuthor} snippet={viewed.replyContextSnippet} url={viewed.inReplyTo?.startsWith('http') ? viewed.inReplyTo : null} /></p>
{:else if viewed?.inReplyTo && !viewed.inReplyToPostId && viewed.inReplyTo.startsWith('http')}
	<p class="subnav">Replying to <a href={viewed.inReplyTo} rel="noreferrer">↗ {viewed.inReplyTo}</a></p>
{/if}
```

- [ ] **Step 8: Verify** — `npm test -w web -- ReplyContext` → PASS; `npm run check -w web` (0 errors), `npm run build -w web`, `npm test -w web`. If a `.vite-temp` EACCES blocks host svelte-check, clear it: `sudo rm -rf web/node_modules/.vite-temp` (do NOT route tests through the container — `CORE_API_URL` breaks URL-asserting tests).

- [ ] **Step 9: Commit**

```bash
git add web/vitest.config.ts web/src/lib/ReplyContext.svelte web/src/lib/ReplyContext.test.ts web/src/lib/types.ts web/src/app.css web/src/routes/+page.svelte "web/src/routes/post/[id]/+page.svelte" "web/src/routes/u/[handle]/+page.svelte" "web/src/routes/u/[handle]/following/+page.svelte"
git commit -m "web: render embedded reply-context (ReplyContext.svelte) on the four unresolved-reply surfaces

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Notes

- **Order:** 1 (parse) → 2 (persist) → 3 (gate) → 4 (web). 2 depends on 1's `ParsedItem` fields; 3 depends on 2's `Post`/`rowToPost`; 4 depends on 2–3's serialized fields.
- **Reviews folded:** the spec is rev 4 (ponytail rev 1 + parallel-session spec review rev 2 + plan ponytail rev 3 + plan parallel-session review rev 4). This plan incorporates the plan review's P1–P10: component-based render tested via `svelte/server` (P1, no new dep); three gate sites incl. `/posts/:id/revisions` (P2); `truncate` trims-before-cut (P3) + exported + tested (P8); author-required context (P4); post-detail's own block (P5); explicit value imports (P6); `api.test.ts` not `app.test.ts` (P7); author-only render test (P9); real Task-2 helpers (P10); `hono`-skill step on Task 3 (minor).
- **Verify test-file names against the real tree** before writing; match each file's existing harness. `u/[handle]`'s inner `others` stacked-conversation loop intentionally renders no context block (those are resolved + gated) — leave it.
- **Rev 5 (plan re-review):** Task 4 Step 5 adds `plugins: [svelte()]` to `web/vitest.config.ts` — it had no svelte plugin, so a `.svelte` import wouldn't compile in tests. `@sveltejs/vite-plugin-svelte` is already a devDependency (no new dep); the config file is staged in Task 4's commit.
- **Shared checkout:** confirm `npm test -w core` is green on HEAD before starting.
