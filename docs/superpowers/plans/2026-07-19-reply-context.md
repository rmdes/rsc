# Reply-context from embedded h-cite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract an embedded h-cite's URL so object-form `in-reply-to` replies thread (a latent bug fix), and capture the parent's author + a snippet so an unresolved reply renders legible context instead of a bare link — as the replier's unverified claim.

**Architecture:** Consume-side only, h-feed path. A pure parse helper in `discovery.ts` turns the JF2 `in-reply-to` (string OR h-cite object, incl. the `{children:[]}` multi-cite wrapper and array `url`) into a thread ref + optional context; two nullable `posts` columns carry it; threading is unchanged; a serialization gate nulls the context once the parent resolves; four web surfaces render it as **plain text**.

**Tech Stack:** Hono/Node core (better-sqlite3 + Kysely, Node 22 native type-stripping — no build, no TS parameter properties, `.ts` import extensions), `@paulrobertlloyd/mf2tojf2` (already installed), SvelteKit web (Svelte 5 runes, plain scoped CSS `--color-*`), vitest.

**Spec:** `docs/superpowers/specs/2026-07-19-reply-context-design.md` (rev 2).

## Global Constraints

- **Plain-text render (security boundary, load-bearing):** `{author}` and `{snippet}` are rendered as **text nodes — NEVER `{@html}`**, never interpolated into any HTML string. They are untrusted, replier-supplied. `{@html}` stays in `PostBody.svelte` only.
- **The NEW render guard — quote it verbatim; do NOT copy the old `startsWith('http')`-only one:** render **context** when `!inReplyToPostId && replyContextAuthor`; else the **bare link** when `!inReplyToPostId && inReplyTo?.startsWith('http')`; else nothing.
- **Render shape:** author+snippet → `In reply to {author}: “{snippet}” ↗`; author only (snippet `null`) → `In reply to {author} ↗` (**no colon, no quotes — never render `“”`**); `↗` is a real `<a href={inReplyTo} rel="noreferrer">` only when a URL exists (no URL → text only).
- **Author rendered verbatim** — no fabricated `@` (h-feeds carry no such scheme).
- **All FOUR unresolved-reply surfaces, textually identical:** `web/src/routes/+page.svelte`, `web/src/routes/post/[id]/+page.svelte`, `web/src/routes/u/[handle]/+page.svelte`, `web/src/routes/u/[handle]/following/+page.svelte`.
- **`truncate` is code-point-safe** (`Array.from`, per `feed.ts:200`), **slice-before-trim** (bodies capped only by `MAX_FEED_BYTES` = 5 MB), cap **200 code points**, empty/whitespace → `null`.
- **Context reaches `toParsedItem` as ONE trailing options object**, not two positionals (adjacent same-typed params are a silent-swap hazard).
- **The context must be added at FOUR core sites or it silently no-ops:** `PostsTable` (`sqlite.ts:9`), `rowToPost` (`sqlite.ts:20-21`), `insertPost .values` (`sqlite.ts:181`), the `Post` object (`ingest.ts:158-165`).
- **Serialization trust gate:** null `replyContextAuthor`/`replyContextSnippet` whenever `inReplyToPostId` is set, once, server-side.
- **New replies only** — do NOT extend `backfillItemExtras`; pre-feature stored orphans stay orphaned (out of scope).
- **No new dependency, no fetch, no new Hono route.** Read the installed source before using any API.
- **UI task MUST invoke `ui-ux-pro-max:ui-ux-pro-max` first + follow `MASTER.md`**; consult `svelte-runes` + `sveltekit-data-flow`. No raw hex — every colour a `--color-*` token (`--color-secondary`). No Tailwind, no component libs.
- **Git — shared checkout:** stage explicit paths, **never `git add -A`**. Commit trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Known flaky:** a full `npm test -w core` may show one `ingest.test.ts > pollAll swallows an oversized feed` timeout — a load artifact, passes isolated; not a regression.

## File Structure

- **Modify `core/src/domain/discovery.ts`** — add + export `parseInReplyTo` and `truncate`; wire `discoverFeed`'s entry map to use them.
- **Modify `core/src/domain/ingest.ts`** — `ParsedItem` gains `replyContextAuthor`/`replyContextSnippet`; `toParsedItem` gains a trailing `reply?: { author, snippet }` options param; the `Post` object carries the two fields.
- **Modify `core/src/storage/sqlite.ts`** — migration (2 columns), `PostsTable`, `rowToPost`, `insertPost .values`.
- **Modify `core/src/api/app.ts`** — a `wireEntry` gate applied at the timeline map, the thread response, and the SSE emit.
- **Test `core/test/discovery.test.ts`** (create or extend), **`core/test/ingest.test.ts`** (extend), **`core/test/app.test.ts`** or nearest API test (extend) — verify against the existing test style; if a named file differs, match the real one.
- **Modify `web/src/lib/types.ts`** — `TimelineEntry` gains the two optional fields.
- **Modify `web/src/app.css`** — `.reply-context` class.
- **Modify the four `+page.svelte` surfaces** listed above — the render block, identical.
- **Test `web/src/routes/+page.svelte`'s render** via the existing web test style (extend the nearest render/component test).

---

### Task 1: Core parse — `parseInReplyTo` + `truncate`, wired into `discoverFeed`

**Files:**
- Modify: `core/src/domain/discovery.ts` (helpers + wire), `core/src/domain/ingest.ts` (`ParsedItem` + `toParsedItem`)
- Test: `core/test/discovery.test.ts` (create or extend)

**Interfaces:**
- Consumes: `mf2tojf2` JF2 shapes (string / h-cite object / `{children:[…]}` wrapper / array `url`); `toParsedItem`.
- Produces: `export function parseInReplyTo(irt: unknown): { ref: string | null; contextAuthor: string | null; contextSnippet: string | null }`; `ParsedItem.replyContextAuthor: string | null` + `.replyContextSnippet: string | null`; `toParsedItem(…, updatedAt = null, reply?: { author: string | null; snippet: string | null })`.

- [ ] **Step 1: Write the failing tests** — `core/test/discovery.test.ts`

Match the file's existing import/harness style (it exercises `discoverFeed(html, url)` and/or `parseInReplyTo` directly). Cover every real shape:

```ts
import { test, expect } from 'vitest'
import { parseInReplyTo } from '../src/domain/discovery.ts'

test('parseInReplyTo: string ref → ref, no context', () => {
  expect(parseInReplyTo('https://a/1')).toEqual({ ref: 'https://a/1', contextAuthor: null, contextSnippet: null })
})
test('parseInReplyTo: single h-cite → url ref + author + snippet', () => {
  const cite = { type: 'cite', url: 'https://a/1', author: { type: 'card', name: 'aaronpk' }, content: { html: '<p>hi</p>', text: 'hi there' } }
  expect(parseInReplyTo(cite)).toEqual({ ref: 'https://a/1', contextAuthor: 'aaronpk', contextSnippet: 'hi there' })
})
test('parseInReplyTo: multi-cite {children:[…]} → first cite (F1, not null)', () => {
  const irt = { children: [{ type: 'cite', url: 'https://a/1', author: { name: 'x' } }, { type: 'cite', url: 'https://a/2' }] }
  expect(parseInReplyTo(irt).ref).toBe('https://a/1')
})
test('parseInReplyTo: array url → url[0] (F2)', () => {
  expect(parseInReplyTo({ type: 'cite', url: ['https://a/1', 'https://a/2'] }).ref).toBe('https://a/1')
})
test('parseInReplyTo: plain-string author', () => {
  expect(parseInReplyTo({ type: 'cite', url: 'https://a/1', author: 'Aaron Parecki' }).contextAuthor).toBe('Aaron Parecki')
})
test('parseInReplyTo: no url → ref null, author kept, snippet null', () => {
  expect(parseInReplyTo({ type: 'cite', author: { name: 'x' } })).toEqual({ ref: null, contextAuthor: 'x', contextSnippet: null })
})
test('parseInReplyTo: html-only content → snippet null (author-only)', () => {
  expect(parseInReplyTo({ type: 'cite', url: 'https://a/1', author: { name: 'x' }, content: { html: '<p>hi</p>' } }).contextSnippet).toBeNull()
})
test('parseInReplyTo: non-cite object / undefined → all null', () => {
  expect(parseInReplyTo(undefined)).toEqual({ ref: null, contextAuthor: null, contextSnippet: null })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w core -- discovery`
Expected: FAIL — `parseInReplyTo is not a function` / import error.

- [ ] **Step 3: Implement the helpers** (`core/src/domain/discovery.ts`, near the top, exported)

```ts
// code-point-safe (plain .slice splits surrogate pairs); slice a bounded UTF-16
// prefix BEFORE Array.from (bodies capped only by MAX_FEED_BYTES = 5 MB). Mirrors
// feed.ts:200's idiom.
function truncate(s: string | null, n: number): string | null {
  if (!s) return null
  const cp = Array.from(s.slice(0, n * 2 + 2))
  const cut = cp.length > n ? cp.slice(0, n).join('') + '…' : cp.join('')
  const t = cut.trim()
  return t || null
}

export function parseInReplyTo(irt: unknown): {
  ref: string | null
  contextAuthor: string | null
  contextSnippet: string | null
} {
  // F1: 2+ values flatten to { children:[…] } — an object, not an array.
  let v = irt
  if (v && typeof v === 'object' && Array.isArray((v as { children?: unknown }).children)) {
    v = (v as { children: unknown[] }).children[0]
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

Add the two fields to the `ParsedItem` interface (line 10, after `updatedAt`):

```ts
replyContextAuthor: string | null; replyContextSnippet: string | null
```

Add a trailing options param to `toParsedItem` (do NOT add two positionals — F10) and set the fields in the returned object:

```ts
// signature: append after `updatedAt: string | null = null`
reply: { author: string | null; snippet: string | null } = { author: null, snippet: null }
// in the returned ParsedItem object literal, after `updatedAt`:
replyContextAuthor: reply.author,
replyContextSnippet: reply.snippet,
```

- [ ] **Step 5: Wire `discoverFeed`** (`core/src/domain/discovery.ts:54-56`) — replace the inline extraction:

```ts
      const irt = e['in-reply-to']
      const { ref, contextAuthor, contextSnippet } = parseInReplyTo(irt)
      return toParsedItem(e.uid ?? e.url, title, content, e.url ?? null, rawDate, now, ref, undefined, null, null, { author: contextAuthor, snippet: contextSnippet })
```

(The RSS caller of `toParsedItem` in `ingest.ts` passes no `reply` arg — it defaults. Grep every `toParsedItem(` call site and confirm only this h-feed one passes context.)

- [ ] **Step 6: Run tests + typecheck**

Run: `npm test -w core -- discovery` → PASS. `npm run typecheck -w core` → clean.

- [ ] **Step 7: Commit**

```bash
git add core/src/domain/discovery.ts core/src/domain/ingest.ts core/test/discovery.test.ts
git commit -m "core: parse embedded h-cite in-reply-to (thread ref + reply context)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Core persistence — two columns + carry the context to the DB

**Files:**
- Modify: `core/src/storage/sqlite.ts` (migration, `PostsTable`, `rowToPost`, `insertPost`), `core/src/domain/ingest.ts` (the `Post` object)
- Test: `core/test/ingest.test.ts` (extend)

**Interfaces:**
- Consumes: `ParsedItem.replyContextAuthor`/`.replyContextSnippet` (Task 1); `insertPost`, `getPost`, `findPostByRef`.
- Produces: `Post.replyContextAuthor?: string | null` + `.replyContextSnippet?: string | null` persisted + round-tripped; object-form h-cite replies thread.

- [ ] **Step 1: Write the failing test** (`core/test/ingest.test.ts`, match the file's existing ingest harness — it builds a repo + calls `ingestItems`/`discoverFeed`)

```ts
test('h-cite reply persists context and threads onto an existing parent', async () => {
  // (adapt to the file's real repo/user setup helpers)
  const parent = await repo.insertPost(/* a remote post with url 'https://a/1', id 'P' */)
  const items = discoverFeed(
    `<div class="h-entry"><a class="u-in-reply-to h-cite" href="https://a/1">
       <span class="p-author h-card"><span class="p-name">aaronpk</span></span>
       <span class="p-content">nice one</span></a>
     <div class="e-content">my reply</div><a class="u-url" href="https://a/2">x</a></div>`,
    'https://feed/x'
  ).hentries
  await ingestItems(repo, bus, user, items)
  const stored = await repo.getPost(/* the reply's id, resolved via getPostByGuid or list */)
  expect(stored?.replyContextAuthor).toBe('aaronpk')
  expect(stored?.replyContextSnippet).toContain('nice one')
  expect(stored?.inReplyToPostId).toBe('P') // threaded, not orphaned — the bug fix
})
```

*(If the exact mf2 fixture is awkward, drive `ingestItems` with a hand-built `ParsedItem[]` carrying `replyContextAuthor`/`replyContextSnippet` + `inReplyTo: 'https://a/1'` — the persistence + threading is what this task proves; Task 1 already proved the parse.)*

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w core -- ingest`
Expected: FAIL — `stored.replyContextAuthor` is `undefined` (columns/plumbing absent).

- [ ] **Step 3: Add the migration** (`core/src/storage/sqlite.ts`) — append a NEW element as the last entry of the `MIGRATIONS: string[][]` array (after the `edited_at`/`post_revisions` migration's `]`, before `MIGRATIONS`'s closing `]`):

```ts
  [
    'ALTER TABLE posts ADD COLUMN reply_context_author text',
    'ALTER TABLE posts ADD COLUMN reply_context_snippet text',
  ],
```

- [ ] **Step 4: Thread the four literal sites**

`PostsTable` interface (`sqlite.ts:9`, append fields):
```ts
reply_context_author: string | null; reply_context_snippet: string | null
```
`rowToPost` (`sqlite.ts:20-21`, append to the returned object):
```ts
replyContextAuthor: r.reply_context_author, replyContextSnippet: r.reply_context_snippet
```
`insertPost .values({…})` (`sqlite.ts:181`, append):
```ts
reply_context_author: p.replyContextAuthor ?? null, reply_context_snippet: p.replyContextSnippet ?? null
```
The `Post` object in `ingest.ts:158-165` (append, mirroring `contentMarkdown`):
```ts
replyContextAuthor: item.replyContextAuthor, replyContextSnippet: item.replyContextSnippet,
```
Add `replyContextAuthor?: string | null` + `replyContextSnippet?: string | null` to the `Post` interface in `core/src/domain/types.ts` (after `contentMarkdown`).

- [ ] **Step 5: Run tests + typecheck**

Run: `npm test -w core -- ingest` → PASS. `npm run typecheck -w core` → clean. `npm test -w core` once (apply the flaky note) → all pass.

- [ ] **Step 6: Commit**

```bash
git add core/src/storage/sqlite.ts core/src/domain/ingest.ts core/src/domain/types.ts core/test/ingest.test.ts
git commit -m "core: persist reply-context columns (migration + Post plumbing)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Core serialization — the trust gate (F8)

**Files:**
- Modify: `core/src/api/app.ts`
- Test: `core/test/app.test.ts` (or the nearest existing API/timeline test — match it)

**Interfaces:**
- Consumes: the serialized entry shape (`Post` + `author`), `inReplyToPostId`.
- Produces: entries leaving core have `replyContextAuthor`/`replyContextSnippet` nulled when `inReplyToPostId` is set.

- [ ] **Step 1: Write the failing test** — a resolved reply must ship no context

```ts
test('GET /timeline nulls reply-context on a resolved reply, keeps it on an orphan', async () => {
  // ingest a parent 'https://a/1' + a reply that resolves onto it (inReplyToPostId set),
  // and an orphan reply to 'https://a/unknown' carrying context.
  const res = await app.request('/timeline')
  const { timeline } = await res.json()
  const resolved = timeline.find((e: any) => e.inReplyToPostId)
  const orphan = timeline.find((e: any) => !e.inReplyToPostId && e.replyContextAuthor)
  expect(resolved.replyContextAuthor).toBeNull()
  expect(resolved.replyContextSnippet).toBeNull()
  expect(orphan.replyContextAuthor).not.toBeNull() // unresolved keeps its claim
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w core -- app` (or the matched file)
Expected: FAIL — `resolved.replyContextAuthor` is non-null (no gate yet).

- [ ] **Step 3: Add the gate helper + apply at all three serialization points** (`core/src/api/app.ts`)

```ts
// The reply-context is the replier's unverified claim; once the real parent is
// known it must not leave core. Enforce once, here.
const wireEntry = <T extends { inReplyToPostId?: string | null; replyContextAuthor?: string | null; replyContextSnippet?: string | null }>(e: T): T =>
  e.inReplyToPostId ? { ...e, replyContextAuthor: null, replyContextSnippet: null } : e
```

Apply it:
- Timeline map (`app.ts:395`): `const timeline = entries.map((e) => ({ ...wireEntry(e), replyCount: counts.get(e.id) ?? 0 }))`
- The thread route's `c.json` entries (`getThread` result) — map each through `wireEntry`.
- The SSE `post` emit (`app.ts:408`): `stream.writeSSE({ event: 'post', id: entry.id, data: JSON.stringify(wireEntry(entry)) })`.

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test -w core -- app` (matched file) → PASS. `npm run typecheck -w core` → clean.

- [ ] **Step 5: Commit**

```bash
git add core/src/api/app.ts core/test/app.test.ts
git commit -m "core: serialization gate — drop reply-context once the reply resolves

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Web — render reply-context on all four surfaces

**Files:**
- Modify: `web/src/lib/types.ts` (`TimelineEntry`), `web/src/app.css` (`.reply-context`), and the four surfaces: `web/src/routes/+page.svelte`, `web/src/routes/post/[id]/+page.svelte`, `web/src/routes/u/[handle]/+page.svelte`, `web/src/routes/u/[handle]/following/+page.svelte`
- Test: the nearest existing web render test (extend; match the harness)

**Interfaces:**
- Consumes: `entry.replyContextAuthor`/`.replyContextSnippet` (serialized by Tasks 2–3), `entry.inReplyTo`, `entry.inReplyToPostId`.

- [ ] **Step 1: Invoke the UI skill first** — `ui-ux-pro-max:ui-ux-pro-max` + `MASTER.md` (`--color-secondary`, no raw hex); consult `svelte-runes` + `sveltekit-data-flow`. No Tailwind, no new deps.

- [ ] **Step 2: Add the fields to `TimelineEntry`** (`web/src/lib/types.ts`, after `inReplyToPostId`)

```ts
	replyContextAuthor?: string | null
	replyContextSnippet?: string | null
```

- [ ] **Step 3: Add the CSS** (`web/src/app.css`)

```css
.reply-context {
	color: var(--color-secondary);
	font-size: 0.875rem;
}
```

- [ ] **Step 4: Write the failing render test** (extend the nearest web render/component test)

Assert, for one surface: an unresolved reply with `replyContextAuthor='aaronpk'` + `replyContextSnippet='hi'` renders the text `In reply to aaronpk: “hi” ↗`, the `↗` is an `<a href>`, and the author/snippet appear as **text** (not raw HTML — assert an author value like `<b>x</b>` renders escaped, proving no `{@html}`). Run it: expect FAIL.

- [ ] **Step 5: Implement the render block on ALL FOUR surfaces — identical** (per the Global Constraints guard + shape)

Replace the existing bare-link block on each surface. **Use that surface's own loop/scope variable** — `post` on the timeline and the two `u/[handle]` surfaces (confirm the each-loop variable name in each file), `viewed` on post-detail (`post/[id]/+page.svelte:83` gates on `viewed`). Post-detail keeps its enclosing `.subnav` wrapper; the other three use `.reply-context`. "Textually identical" means the **guard + render shape are identical** — only the variable binding and the outer wrapper class differ. Representative block (timeline, variable `post`):

```svelte
{#if !post.inReplyToPostId && post.replyContextAuthor}
	<span class="reply-context">In reply to {post.replyContextAuthor}{#if post.replyContextSnippet}: “{post.replyContextSnippet}”{/if}
		{#if post.inReplyTo?.startsWith('http')}<a class="reply-context" href={post.inReplyTo} rel="noreferrer">↗</a>{/if}
	</span>
{:else if !post.inReplyToPostId && post.inReplyTo?.startsWith('http')}
	<a class="source" href={post.inReplyTo} rel="noreferrer">in reply to ↗</a>
{/if}
```

Keep the four copies **textually identical** (only the variable name / wrapper differs where noted). Author verbatim, no `@`. `{author}`/`{snippet}` are text nodes — never `{@html}`.

- [ ] **Step 6: Verify** — `npm run check -w web` (0 errors), `npm run build -w web`, `npm test -w web`. If the dev stack is running and a `.vite-temp` EACCES blocks host svelte-check, clear it: `sudo rm -rf web/node_modules/.vite-temp` (root-owned leftover) — do NOT route tests through the container (`CORE_API_URL` breaks URL-asserting tests).

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/types.ts web/src/app.css web/src/routes/+page.svelte "web/src/routes/post/[id]/+page.svelte" "web/src/routes/u/[handle]/+page.svelte" "web/src/routes/u/[handle]/following/+page.svelte"
git commit -m "web: render embedded reply-context on the four unresolved-reply surfaces

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Notes

- **Order:** 1 (parse) → 2 (persist) → 3 (gate) → 4 (web render). Each is independently testable; 2 depends on 1's `ParsedItem` fields, 4 depends on 2–3's serialized fields.
- **Plan-level carry-overs from the spec review (not spec text):** F9 (`truncate` code-point-safe + slice-before-trim — implemented in Task 1 Step 3); F10 (context via one trailing options object — Task 1 Step 4); the guard-quoting trap (Task 4 uses the NEW guard verbatim; do not copy the old `startsWith('http')`-only block). Minor: the two ingest threading tests collapse to one integration smoke (Task 2) since `ingestItems` sees a plain string ref either way — the discovery-level assertions (Task 1) are the new logic.
- **Verify test-file names against the real tree** before writing (`core/test/*.test.ts`, the web render test harness) — match the existing style; if a named file doesn't exist, use the nearest equivalent and note it in the report.
- **Shared checkout:** confirm `npm test -w core` is green on HEAD before starting (a pre-existing red other than the known ingest flaky is not this work's).
