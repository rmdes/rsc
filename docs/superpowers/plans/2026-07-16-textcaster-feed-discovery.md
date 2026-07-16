# Textcaster Feed Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a followed URL returns HTML instead of a parseable feed, discover the feed — via `<link rel="alternate">` autodiscovery (persist the real feed URL) or microformats2 h-feed parsing (the page is the feed) — so IndieWeb sites and OPML-imported homepage URLs become followable.

**Architecture:** A poll-time fallback inside `ingestRemoteUser`. When the primary feed parse fails on HTML, a pure `discoverFeed(html, pageUrl)` (new `core/src/domain/discovery.ts`) parses the HTML once with `microformats-parser`, returning the first alternate feed link (from `rel-urls`) and any h-feed items (converted to JF2 via `@paulrobertlloyd/mf2tojf2`, then mapped to the existing `ParsedItem`). Autodiscovery fetches + persists the discovered feed; h-feed ingests the page's items directly. One hop, SSRF-guarded.

**Tech Stack:** TypeScript (ESM, Node ≥22.18, native type stripping — no build), Kysely + better-sqlite3, feedsmith, `microformats-parser`, `@paulrobertlloyd/mf2tojf2`, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-16-textcaster-feed-discovery-design.md` (rev 3, 259bc21)
**Review incorporated:** the spec's H1–H6 and R1/R2 are folded into the spec; this plan implements them.

## Global Constraints

- **TypeScript, ESM, Node ≥22.18; no build step.** Both new deps are ESM (`microformats-parser` → `dist/index.mjs`; `mf2tojf2` → `"type":"module"`). `microformats-parser` ships types; **`mf2tojf2` ships none** — Task 2 adds a minimal ambient `declare module` shim.
- **Storage-agnostic core:** domain/service/API depend only on the `Repository` interface; no SQL outside `storage/sqlite.ts`.
- **Probe-before-embedding (already done for this plan):** the embedded code below was written against the installed `microformats-parser@2.0.6` and `@paulrobertlloyd/mf2tojf2@3.0.0`, probed live: `mf2(html,{baseUrl})` returns `rel-urls: Record<url,{rels:string[]; type?:string}>` (type exposed, hrefs absolute) + `items`; `mf2tojf2(parsed)` returns `{type:'feed', children:[{type:'entry', name?, content:{html,text}, published, url, uid?}]}` for an h-feed and `{type:'entry',…}` for a bare h-entry, and **drops the implied `p-name`** (untitled notes have no `name`) — this is the H1 fix, no prefix heuristic needed.
- **Discovery is poll-time only** — never at OPML import (import stays fetch-free).
- **One hop:** discovery resolves at most one additional URL; never recurses.
- **SSRF:** the discovered URL passes `checkCallbackUrl` (from `push-guard.ts`) before any fetch; it also enforces http(s)-only. The discovered fetch **follows redirects** (feeds legitimately 301/302; residual accepted per spec §6).
- **No-logic-change refactors:** promoting `toParsedItem` to an export and extracting `fetchFeedBody` must not change behavior — the existing ingest tests stay green across those steps.
- **TDD:** failing test first. `npm test -w core` + `npm run typecheck -w core` green at each task's end.
- Commit after each task; end every commit message with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## File structure

```
core/package.json                    # MODIFY: + microformats-parser, @paulrobertlloyd/mf2tojf2
core/src/domain/repository.ts        # MODIFY: + updateFeedUrl
core/src/domain/repository-contract.ts # MODIFY: + updateFeedUrl pin
core/src/storage/sqlite.ts           # MODIFY: updateFeedUrl impl
core/src/domain/ingest.ts            # MODIFY: export toParsedItem; extract fetchFeedBody; wire discovery ladder
core/src/domain/mf2tojf2.d.ts        # CREATE: ambient types for the untyped dep
core/src/domain/discovery.ts         # CREATE: discoverFeed(html, pageUrl)
core/test/discovery.test.ts          # CREATE: discoverFeed unit tests
core/test/ingest-discovery.test.ts   # CREATE: ingestRemoteUser discovery integration + money test
docs/superpowers/documentation/RUNNING.md # MODIFY: discovery note
```

---

### Task 1: `updateFeedUrl` repository method

**Files:**
- Modify: `core/src/domain/repository.ts`, `core/src/storage/sqlite.ts`, `core/src/domain/repository-contract.ts`

**Interfaces:**
- Produces: `Repository.updateFeedUrl(userId: string, feedUrl: string): Promise<void>` — sets a user's `feed_url`; silent no-op for an unknown id.
- Consumes: nothing new.

- [ ] **Step 1: Add to the interface**

In `core/src/domain/repository.ts`, add after `createRemoteUser`:
```ts
  updateFeedUrl(userId: string, feedUrl: string): Promise<void>
```

- [ ] **Step 2: Failing contract test**

In `core/src/domain/repository-contract.ts`, add inside the contract block:
```ts
    test('updateFeedUrl changes a user feedUrl and no-ops on an unknown id', async () => {
      const repo = await makeRepo()
      const u = await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/page' })
      await repo.updateFeedUrl(u.id, 'https://ex.com/feed.xml')
      expect((await repo.getUser(u.id))?.feedUrl).toBe('https://ex.com/feed.xml')
      await repo.updateFeedUrl('no-such-id', 'https://ex.com/x') // no throw
    })
```

- [ ] **Step 3: Run — verify RED**

Run: `npm test -w core`
Expected: FAIL — `repo.updateFeedUrl is not a function`.

- [ ] **Step 4: Implement**

In `core/src/storage/sqlite.ts`, add to the `SqliteRepository` class (near `createRemoteUser`):
```ts
  async updateFeedUrl(userId: string, feedUrl: string) {
    await this.db.updateTable('users').set({ feed_url: feedUrl }).where('id', '=', userId).execute()
  }
```

- [ ] **Step 5: Run — verify GREEN + typecheck**

Run: `npm test -w core && npm run typecheck -w core`
Expected: PASS; typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(printf 'core: updateFeedUrl repository method (for discovery persistence)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 2: deps + `discoverFeed` module

**Files:**
- Modify: `core/package.json` (deps), `core/src/domain/ingest.ts` (export `toParsedItem`)
- Create: `core/src/domain/mf2tojf2.d.ts`, `core/src/domain/discovery.ts`, `core/test/discovery.test.ts`

**Interfaces:**
- Produces: `discoverFeed(html: string, pageUrl: string): { feedUrl: string | null; hentries: ParsedItem[] }` — pure, no I/O. `feedUrl` is the first alternate feed link; `hentries` are the page's h-feed items as `ParsedItem[]`.
- Consumes: `ParsedItem` + `toParsedItem` (exported here) from `ingest.ts`.

- [ ] **Step 1: Add the dependencies**

Run: `npm install -w core microformats-parser@^2.0.6 @paulrobertlloyd/mf2tojf2@^3.0.0`
(Confirm `core/package.json` gained both under `dependencies`.)

- [ ] **Step 2: Promote `toParsedItem` to an export (no logic change)**

In `core/src/domain/ingest.ts`, change the declaration:
```ts
function toParsedItem(guid: string | undefined, title: string | null, content: string, url: string | null, rawDate: string, now: string): ParsedItem {
```
to:
```ts
export function toParsedItem(guid: string | undefined, title: string | null, content: string, url: string | null, rawDate: string, now: string): ParsedItem {
```
(`ParsedItem` is already exported. Nothing else changes — run `npm test -w core` to confirm the existing suite stays green after this one-word edit.)

- [ ] **Step 3: Ambient types for the untyped dep**

Create `core/src/domain/mf2tojf2.d.ts` (mf2tojf2 ships no `.d.ts`; this declares only what `discoverFeed` consumes):
```ts
declare module '@paulrobertlloyd/mf2tojf2' {
  export interface Jf2 {
    type?: string // absent for the { children } shape (bare h-entries, no h-feed wrapper) — P1
    name?: string
    summary?: string
    content?: string | { html?: string; text?: string }
    published?: string
    url?: string
    uid?: string
    children?: Jf2[]
  }
  export function mf2tojf2(parsed: unknown): Jf2
}
```

- [ ] **Step 4: Failing unit tests**

Create `core/test/discovery.test.ts`:
```ts
import { test, expect } from 'vitest'
import { discoverFeed } from '../src/domain/discovery.ts'

test('autodiscovery: returns the first alternate feed link, absolute, excluding bare json', () => {
  const html = `<html><head>
    <link rel="alternate" type="application/json" href="/api.json">
    <link rel="alternate" type="application/rss+xml" href="/feed.xml">
    <link rel="alternate" type="application/atom+xml" href="https://other.example/atom">
  </head><body><p></p></body></html>`
  const { feedUrl } = discoverFeed(html, 'https://site.example/blog')
  expect(feedUrl).toBe('https://site.example/feed.xml') // relative resolved, json skipped, first feed-typed wins
})

test('autodiscovery: none present → null', () => {
  const { feedUrl, hentries } = discoverFeed('<html><head></head><body>plain</body></html>', 'https://site.example/')
  expect(feedUrl).toBeNull()
  expect(hentries).toEqual([])
})

test('h-feed: a titled article keeps its title; an untitled note has title null (implied-name dropped)', () => {
  const html = `<div class="h-feed">
    <article class="h-entry"><h1 class="p-name">Real Title</h1><div class="e-content">Article body.</div><time class="dt-published" datetime="2026-01-01T10:00:00Z"></time><a class="u-url" href="https://s.ex/a">l</a></article>
    <div class="h-entry"><p class="e-content">Just a note, no title.</p><time class="dt-published" datetime="2026-01-02T10:00:00Z"></time><a class="u-url" href="https://s.ex/n">l</a></div>
  </div>`
  const { hentries } = discoverFeed(html, 'https://s.ex/page')
  expect(hentries).toHaveLength(2)
  const article = hentries.find((h) => h.url === 'https://s.ex/a')!
  const note = hentries.find((h) => h.url === 'https://s.ex/n')!
  expect(article.title).toBe('Real Title')
  expect(article.content).toContain('Article body')
  expect(note.title).toBeNull()
  expect(note.content).toContain('Just a note')
  expect(note.guid).toBe('https://s.ex/n') // guid from u-url
})

test('h-feed: an undated note gets a deterministic guid across two parses (raw-date discipline)', () => {
  const html = `<div class="h-entry"><p class="e-content">dateless and linkless note</p></div>`
  const a = discoverFeed(html, 'https://s.ex/p').hentries[0]
  const b = discoverFeed(html, 'https://s.ex/p').hentries[0]
  expect(a.guid).toBe(b.guid) // fallbackGuid hashes raw fields, not "now"
})

test('h-feed: multiple bare h-entries with NO h-feed wrapper are all mapped (P1)', () => {
  // mf2tojf2 returns { children } with NO top-level `type` for this common
  // homepage shape; a type-first branch would drop every entry.
  const html = `<div class="h-entry"><p class="e-content">note one</p><a class="u-url" href="https://s.ex/1">l</a></div>
    <div class="h-entry"><p class="e-content">note two</p><a class="u-url" href="https://s.ex/2">l</a></div>`
  const { hentries } = discoverFeed(html, 'https://s.ex/')
  expect(hentries.map((h) => h.url).sort()).toEqual(['https://s.ex/1', 'https://s.ex/2'])
})

test('degenerate HTML (childless body) → nulls, never throws (spec §7)', () => {
  const { feedUrl, hentries } = discoverFeed('<html><head></head><body></body></html>', 'https://s.ex/')
  expect(feedUrl).toBeNull()
  expect(hentries).toEqual([])
})

test('a single h-entry carrying a nested microformat (e.g. h-card) is still mapped', () => {
  // mf2tojf2 attaches the nested (non-entry) mf as `children` on a typed entry;
  // the entry itself must not be dropped in favour of those children.
  const html = `<div class="h-entry"><p class="e-content">hi</p><a class="u-url" href="https://s.ex/1">l</a><div class="h-card">Nested card</div></div>`
  const { hentries } = discoverFeed(html, 'https://s.ex/')
  expect(hentries.map((h) => h.url)).toEqual(['https://s.ex/1'])
})
```

- [ ] **Step 5: Run — verify RED**

Run: `npm test -w core`
Expected: FAIL — cannot resolve `../src/domain/discovery.ts`.

- [ ] **Step 6: Implement `discoverFeed`**

Create `core/src/domain/discovery.ts`:
```ts
import { mf2 } from 'microformats-parser'
import { mf2tojf2, type Jf2 } from '@paulrobertlloyd/mf2tojf2'
import { toParsedItem } from './ingest.ts'
import type { ParsedItem } from './ingest.ts'

export interface Discovered {
  feedUrl: string | null
  hentries: ParsedItem[]
}

const FEED_TYPES = new Set(['application/rss+xml', 'application/atom+xml', 'application/feed+json'])

function jf2Content(e: Jf2): string {
  if (typeof e.content === 'string' && e.content) return e.content
  if (e.content && typeof e.content === 'object') {
    const c = e.content.text || e.content.html // `||`: a present-but-empty content object falls through
    if (c) return c
  }
  return e.summary || e.name || ''
}

export function discoverFeed(html: string, pageUrl: string): Discovered {
  let parsed
  try {
    parsed = mf2(html, { baseUrl: pageUrl })
  } catch {
    // microformats-parser throws on degenerate HTML (a childless <body>, some
    // challenge pages). Discovery must never throw — return nulls so the ladder
    // cleanly reports "no feed found" (spec §7 "Cloudflare-challenge → nulls").
    return { feedUrl: null, hentries: [] }
  }

  // Autodiscovery: first alternate link whose type is a feed type (rel-urls is
  // populated in document order; hrefs are already absolute against baseUrl).
  let feedUrl: string | null = null
  for (const [url, info] of Object.entries(parsed['rel-urls'])) {
    if (info.rels.includes('alternate') && info.type && FEED_TYPES.has(info.type)) {
      feedUrl = url
      break
    }
  }

  // h-feed: convert to JF2 (which drops implied p-names — H1) and map entries.
  // A single typed `entry` is ALWAYS itself (it may carry `children` from nested
  // microformats like an embedded h-card — those are NOT entries); everything
  // else (the `feed` wrapper, and the untyped `{ children }` shape from bare
  // h-entries with no wrapper — P1) takes its children. Probe-confirmed across
  // all four shapes.
  const jf2 = mf2tojf2(parsed)
  const entries: Jf2[] = jf2.type === 'entry' ? [jf2] : (jf2.children ?? [])
  const now = new Date().toISOString()
  const hentries = entries
    .filter((e) => e.type === 'entry')
    .map((e) => {
      const content = jf2Content(e)
      // mf2tojf2 already drops implied names; the !== content guard is belt-and-
      // suspenders so a name that duplicates the body never becomes a title.
      const title = e.name && e.name !== content ? e.name : null
      const rawDate = typeof e.published === 'string' ? e.published : ''
      return toParsedItem(e.uid ?? e.url, title, content, e.url ?? null, rawDate, now)
    })

  return { feedUrl, hentries }
}
```

- [ ] **Step 7: Run — verify GREEN + typecheck**

Run: `npm test -w core && npm run typecheck -w core`
Expected: PASS (4 discovery tests + existing); typecheck exit 0.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "$(printf 'core: discoverFeed — rel=alternate autodiscovery + JF2 h-feed mapping\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 3: wire discovery into `ingestRemoteUser`

**Files:**
- Modify: `core/src/domain/ingest.ts`
- Create: `core/test/ingest-discovery.test.ts`

**Interfaces:**
- Produces: `ingestRemoteUser`, on a primary parse failure with an HTML body, runs the discovery ladder — autodiscovery (SSRF-guard, one-hop fetch, collision-checked persist, ingest) then h-feed (ingest page items) — returning the same `{ inserted, discovery }` shape.
- Consumes: `discoverFeed` (Task 2), `checkCallbackUrl` (`push-guard.ts`), `updateFeedUrl` (Task 1), the extracted `fetchFeedBody`.

- [ ] **Step 1: Failing integration tests**

Create `core/test/ingest-discovery.test.ts`:
```ts
import { test, expect, vi } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { ingestRemoteUser } from '../src/domain/ingest.ts'

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title>
<item><title>Hello</title><link>https://s.ex/1</link><guid>https://s.ex/1</guid><description>Body</description></item></channel></rss>`

// A fetch stub that serves different bodies per URL and records the URLs seen.
function router(routes: Record<string, { body: string; type: string; status?: number }>) {
  const seen: string[] = []
  const fn = vi.fn(async (url: string | URL | Request) => {
    const u = String(url)
    seen.push(u)
    const r = routes[u]
    if (!r) return new Response('not found', { status: 404 })
    return new Response(r.body, { status: r.status ?? 200, headers: { 'content-type': r.type } })
  })
  return { fn: fn as unknown as typeof fetch, seen }
}

test('HTML page → autodiscover feed → ingest + persist the discovered feedUrl', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const user = await repo.createRemoteUser({ handle: 'blog', displayName: 'Blog', feedUrl: 'https://s.ex/page' })
  const html = `<html><head><link rel="alternate" type="application/rss+xml" href="https://s.ex/feed.xml"></head><body><p></p></body></html>`
  const { fn, seen } = router({
    'https://s.ex/page': { body: html, type: 'text/html' },
    'https://s.ex/feed.xml': { body: RSS, type: 'application/rss+xml' },
  })
  const { inserted } = await ingestRemoteUser(repo, bus, user, fn)
  expect(inserted).toBe(1)
  expect((await repo.getUser(user.id))?.feedUrl).toBe('https://s.ex/feed.xml') // persisted
  expect(seen).toEqual(['https://s.ex/page', 'https://s.ex/feed.xml']) // one hop
})

test('collision (R1): discovered feed already held by another user → rewrite skipped, items still ingest', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  await repo.createRemoteUser({ handle: 'direct', displayName: 'Direct', feedUrl: 'https://s.ex/feed.xml' }) // already holds it
  const pageUser = await repo.createRemoteUser({ handle: 'page', displayName: 'Page', feedUrl: 'https://s.ex/page' })
  const html = `<html><head><link rel="alternate" type="application/rss+xml" href="https://s.ex/feed.xml"></head><body><p></p></body></html>`
  const { fn } = router({
    'https://s.ex/page': { body: html, type: 'text/html' },
    'https://s.ex/feed.xml': { body: RSS, type: 'application/rss+xml' },
  })
  const { inserted } = await ingestRemoteUser(repo, bus, pageUser, fn)
  expect(inserted).toBe(1) // items still ingested under page-user
  expect((await repo.getUser(pageUser.id))?.feedUrl).toBe('https://s.ex/page') // NOT rewritten
})

test('h-feed page (no feed link) → ingest h-entries, feedUrl unchanged', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const user = await repo.createRemoteUser({ handle: 'indie', displayName: 'Indie', feedUrl: 'https://s.ex/home' })
  const html = `<html><body><div class="h-feed"><div class="h-entry"><p class="e-content">a note</p><a class="u-url" href="https://s.ex/n">l</a></div></div></body></html>`
  const { fn, seen } = router({ 'https://s.ex/home': { body: html, type: 'text/html' } })
  const { inserted } = await ingestRemoteUser(repo, bus, user, fn)
  expect(inserted).toBe(1)
  expect((await repo.getUser(user.id))?.feedUrl).toBe('https://s.ex/home') // unchanged
  expect(seen).toEqual(['https://s.ex/home']) // no second fetch
})

test('neither feed link nor h-entries → still fails (throws), bounded by pollAll', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const user = await repo.createRemoteUser({ handle: 'x', displayName: 'X', feedUrl: 'https://s.ex/blank' })
  const { fn } = router({ 'https://s.ex/blank': { body: '<html><body><p>nothing</p></body></html>', type: 'text/html' } })
  await expect(ingestRemoteUser(repo, bus, user, fn)).rejects.toThrow()
})

test('SSRF-rejected discovered URL → no second fetch, ladder falls through (P2, spec §7)', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const user = await repo.createRemoteUser({ handle: 's', displayName: 'S', feedUrl: 'https://s.ex/page' })
  // The discovered link points at a loopback IP literal — checkCallbackUrl rejects
  // it synchronously (no DNS), so the feed is never fetched and the ladder falls
  // through to h-feed (none here) → throw. `seen` proves no second fetch happened.
  const html = `<html><head><link rel="alternate" type="application/rss+xml" href="http://127.0.0.1/feed"></head><body><p>x</p></body></html>`
  const { fn, seen } = router({ 'https://s.ex/page': { body: html, type: 'text/html' } })
  await expect(ingestRemoteUser(repo, bus, user, fn)).rejects.toThrow()
  expect(seen).toEqual(['https://s.ex/page']) // the 127.0.0.1 feed was never fetched
})
```

- [ ] **Step 2: Run — verify RED**

Run: `npm test -w core`
Expected: FAIL — discovery not wired; the HTML body throws "Unrecognized feed format" and nothing is discovered/persisted.

- [ ] **Step 3: Extract `fetchFeedBody` (no logic change), then wire the ladder**

In `core/src/domain/ingest.ts`, add imports at the top:
```ts
import { discoverFeed } from './discovery.ts'
import { checkCallbackUrl } from './push-guard.ts'
```

Extract the fetch+cap into a helper (identical logic to the current inline fetch — the existing tests must stay green):
```ts
async function fetchFeedBody(url: string, fetchFn: typeof fetch): Promise<{ body: string; res: Response }> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: FEED_FETCH_HEADERS })
  const contentLength = Number(res.headers.get('content-length') ?? '0')
  if (contentLength > MAX_FEED_BYTES) throw new Error(`feed exceeds size cap: ${contentLength} bytes`)
  // ponytail: cap rejects oversized bodies but only after buffering them; stream + abort past the cap if memory ever matters
  const body = await res.text()
  if (Buffer.byteLength(body) > MAX_FEED_BYTES) throw new Error(`feed exceeds size cap: ${Buffer.byteLength(body)} bytes`)
  return { body, res }
}

function looksLikeHtml(body: string): boolean {
  return body.trimStart().startsWith('<')
}
```

Replace the body of `ingestRemoteUser` (from the fetch through the return) with the ladder. The new `ingestRemoteUser`:
```ts
export async function ingestRemoteUser(repo: Repository, bus: EventBus, user: User, fetchFn: typeof fetch = fetch): Promise<{ inserted: number; discovery: FeedDiscovery }> {
  if (!user.feedUrl) return { inserted: 0, discovery: NO_DISCOVERY }
  const { body, res } = await fetchFeedBody(user.feedUrl, fetchFn)

  let parsed
  try {
    parsed = await parseFeedWithMeta(body)
  } catch (err) {
    // Primary parse failed. If the body is HTML, try discovery; else re-throw.
    if (!looksLikeHtml(body)) throw err
    return await ingestViaDiscovery(repo, bus, user, user.feedUrl, body, fetchFn)
  }

  const inserted = await ingestItems(repo, bus, user, parsed.items)
  return { inserted, discovery: mergeDiscovery(res, parsed.discovery) }
}

function mergeDiscovery(res: Response, discovery: FeedDiscovery): FeedDiscovery {
  const header = parseLinkHeader(res.headers.get('link'))
  return {
    hubs: [...new Set([...header.hubs, ...discovery.hubs])],
    self: header.self ?? discovery.self,
    cloud: discovery.cloud,
  }
}

async function ingestViaDiscovery(repo: Repository, bus: EventBus, user: User, pageUrl: string, html: string, fetchFn: typeof fetch): Promise<{ inserted: number; discovery: FeedDiscovery }> {
  const { feedUrl, hentries } = discoverFeed(html, pageUrl)

  // 1. Autodiscovery: a real feed link, one hop.
  if (feedUrl && feedUrl !== pageUrl) {
    const guard = await checkCallbackUrl(feedUrl)
    if (guard.ok) {
      const { body, res } = await fetchFeedBody(feedUrl, fetchFn) // follows redirects (feeds 301/302)
      const parsed = await parseFeedWithMeta(body) // may throw → bounded by pollAll's per-user catch
      const inserted = await ingestItems(repo, bus, user, parsed.items)
      // R1: persist only if no OTHER user already holds this feedUrl.
      const taken = (await repo.listRemoteUsers()).some((u) => u.id !== user.id && u.feedUrl === feedUrl)
      if (!taken) await repo.updateFeedUrl(user.id, feedUrl)
      return { inserted, discovery: mergeDiscovery(res, parsed.discovery) }
    }
    // guard rejected → fall through to h-feed
  }

  // 2. h-feed: the page is the feed; ingest its items, leave feedUrl unchanged.
  if (hentries.length > 0) {
    const inserted = await ingestItems(repo, bus, user, hentries)
    return { inserted, discovery: NO_DISCOVERY }
  }

  // 3. Neither.
  throw new Error('no feed found (no alternate link, no h-feed)')
}
```

- [ ] **Step 4: Run — verify GREEN + typecheck**

Run: `npm test -w core && npm run typecheck -w core`
Expected: PASS (4 new integration tests + the existing ingest suite unchanged); typecheck exit 0. The existing `ingestRemoteUser` tests still pass because the happy path (successful parse) is behaviorally identical — the refactor only adds the catch branch.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(printf 'core: wire discovery into ingest — autodiscover+persist, h-feed, one hop, SSRF-guarded\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 4: money test, redirect test, docs, whole-milestone gates

**Files:**
- Modify: `core/test/ingest-discovery.test.ts` (append), `docs/superpowers/documentation/RUNNING.md`

**Interfaces:**
- Consumes everything above. The money test is the milestone's definition of done; no new production code (fix wiring in Task 3 if it exposes a bug).

- [ ] **Step 1: Append the money test**

NOTE: the earlier planned "R2: does NOT set redirect:'manual'" test is OBSOLETE — the security hardening in Task 3 deliberately sets `redirect:'manual'` and re-validates each hop, and legitimate multi-hop redirect following is already covered by that task's `legit multi-hop redirect → ingests` test. Do NOT add a redirect test here.

The primary `feedUrl` fetch is now SSRF-guarded, so every `ingestRemoteUser` call needs the `publicLookup` 5th arg (already defined at the top of `ingest-discovery.test.ts` from the Task 3 hardening: `const publicLookup: LookupFn = async () => [{ address: '93.184.216.34' }]`). Append to `core/test/ingest-discovery.test.ts`:
```ts
test('MONEY TEST: OPML-style HTML-page user becomes followable end to end', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  // Simulates an OPML import that stored an HTML page URL as the feedUrl.
  const user = await repo.createRemoteUser({ handle: 'indieweb', displayName: 'IndieWeb', feedUrl: 'https://blog.ex/' })
  const html = `<html><head><link rel="alternate" type="application/atom+xml" href="https://blog.ex/atom.xml"></head><body><p></p></body></html>`
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title>
    <entry><title>First</title><id>urn:1</id><link href="https://blog.ex/1"/><content>Hi</content><updated>2026-01-01T00:00:00Z</updated></entry></feed>`
  const calls: string[] = []
  const fn = vi.fn(async (url: string | URL | Request) => {
    const u = String(url); calls.push(u)
    if (u === 'https://blog.ex/') return new Response(html, { headers: { 'content-type': 'text/html' } })
    if (u === 'https://blog.ex/atom.xml') return new Response(atom, { headers: { 'content-type': 'application/atom+xml' } })
    return new Response('x', { status: 404 })
  }) as unknown as typeof fetch

  // First poll: discovers + persists + ingests. publicLookup so blog.ex passes the guard.
  const first = await ingestRemoteUser(repo, bus, user, fn, publicLookup)
  expect(first.inserted).toBe(1)
  expect((await repo.getUser(user.id))?.feedUrl).toBe('https://blog.ex/atom.xml')
  const tl = await repo.getTimeline(10)
  expect(tl.find((e) => e.content.includes('First'))).toBeTruthy()

  // Second poll: hits the persisted feed directly (no page fetch, no re-discovery).
  calls.length = 0
  const refreshed = (await repo.getUser(user.id))!
  await ingestRemoteUser(repo, bus, refreshed, fn, publicLookup)
  expect(calls).toEqual(['https://blog.ex/atom.xml']) // page URL never fetched again
})
```

- [ ] **Step 2: Run — verify GREEN (or fix Task 3 wiring)**

Run: `npm test -w core && npm run typecheck -w core`
Expected: PASS. If the money test fails, the bug is in Task 3's ladder — fix there, do not weaken the test.

- [ ] **Step 3: RUNNING.md note**

Add a short "Feed discovery" subsection under the feeds section of `docs/superpowers/documentation/RUNNING.md`: a followed URL that returns an HTML page is auto-resolved to its `<link rel="alternate">` feed (and the stored URL is rewritten to it), and IndieWeb pages with `h-entry` microformats but no feed are ingested directly (the page is re-parsed each poll). Note discovery runs at poll time, is one-hop, and private-address links are rejected.

- [ ] **Step 4: Whole-milestone gates**

Run:
```bash
npm test -w core && npm run typecheck -w core
```
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(printf 'core: feed-discovery money test + redirect test; docs: discovery note\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

## Self-Review (done at plan-writing time)

- **Spec coverage:** `updateFeedUrl` + contract pin → Task 1; deps + `discoverFeed` (autodiscovery rel-urls, JF2 h-feed mapping, H1 implied-name via mf2tojf2, feed-type set excluding bare json, raw-date guid via `toParsedItem`) → Task 2; the ladder in `ingestRemoteUser` (`<`-sniff gate, `fetchFeedBody` extraction H3, loop guard, SSRF `checkCallbackUrl`, one-hop fetch, R1 collision-checked persist, h-feed branch, H4 discovery from the feed response) → Task 3; money test + R2 redirect + h-feed + docs → Task 3/4. Non-goals (OPML-time discovery, recursion, WebSub-from-HTML, user merge) appear nowhere. ✅
- **Probe-accurate:** all embedded code was written against the installed `microformats-parser@2.0.6` / `mf2tojf2@3.0.0`, probed live (rel-urls `type` exposed; mf2tojf2 drops implied names; JF2 `{type,name?,content:{html,text},published,url,uid?,children?}`; bare h-entry → top-level `{type:'entry'}`). The one residual probe risk — mf2tojf2's exact field names on unusual inputs — is covered by Task 2's unit tests failing loudly if wrong.
- **No-logic-change steps isolated:** `toParsedItem` export (Task 2 Step 2) and `fetchFeedBody` extraction (Task 3 Step 3) each keep the existing ingest suite green — called out so a reviewer can confirm the refactor is behavior-preserving.
- **Minimal surface:** only `toParsedItem` is promoted to an export (not the spec's fuller list — `NO_DISCOVERY`/`MAX_FEED_BYTES`/`FETCH_TIMEOUT_MS`/`FEED_FETCH_HEADERS` are used only within `ingest.ts`, where `fetchFeedBody` lives, so they stay private). No new repo method beyond `updateFeedUrl`; the R1 collision check reuses `listRemoteUsers()`.
- **Type consistency:** `Discovered`/`ParsedItem` identical across discovery.ts and its tests; `toParsedItem(guid, title, content, url, rawDate, now)` signature matches ingest.ts; the `Jf2` ambient type matches the fields `discoverFeed` reads.
