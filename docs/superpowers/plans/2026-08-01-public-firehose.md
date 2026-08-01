# Public Firehose (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `GET /api/v1/firehose/stream` — a public, anonymous SSE feed of
every new local post the instant it lands, matching the design in
`docs/superpowers/specs/2026-08-01-external-api-and-firehose-design.md`
("Public firehose" section). This is phase 1 of that spec's 4-phase
architecture; phases 2-4 (authed read/write/admin API) are separate plans,
not part of this one.

**Architecture:** Core gains one new route, `mountPublicFirehoseRoute`
(`core/src/api/logical-routes.ts`), reusing the same durable-journal SSE
transport `/stream` already rides (`LogicalStreamSource`, the bus's coalesced
sequence hint) — but with a hardcoded anonymous viewer (no session lookup at
all), frames filtered to `origin === 'local'` upserts only, content rendered
through the same safe-wire path `/users/rss.xml` already uses, and a per-IP
concurrent-connection cap. Web gets one new bespoke proxy file forwarding the
stream unchanged — no sanitizer transform needed there, since core already
emits wire-safe content (unlike the browser's `/stream` proxy, which renders
raw internal DTOs through the sanitizer itself).

**Tech Stack:** Hono (`hono/streaming`'s `streamSSE`), the existing
`LogicalStreamSource`/journal machinery, SvelteKit route handler (web proxy).
No new dependencies.

## Global Constraints

- No permission/key check on this route at all — it is genuinely public and
  anonymous (spec: "Public firehose" section, "Auth: none").
- Frames are filtered to `origin === 'local'` upserts only, matching
  `/users/rss.xml`'s existing scope (`core/src/api/logical-routes.ts:437`,
  `projectLocalActivity`).
- `enableSessionForAPIKeys` and any api-key machinery are **out of scope**
  for this plan entirely — this route needs none of it.
- Core stays internal; the route is reached only via the new web proxy,
  never a direct public Caddy entry.
- The web proxy for the firehose is a **plain pass-through** (headers +
  body), not a frame-transforming proxy like `/stream`'s — core already
  produces the final wire shape.

---

### Task 1: Core — `mountPublicFirehoseRoute` + safe content export + tests

**Files:**
- Modify: `core/src/domain/feed.ts` — export the existing `itemContentFields`
  (currently module-private) with no behavior change.
- Modify: `core/src/api/logical-routes.ts` — add `mountPublicFirehoseRoute`.
- Modify: `core/src/server.ts` — extract the inline `feeds` object to a local
  `const`, wire the new mount call.
- Test: `core/test/logical-firehose-sse.test.ts` (new).

**Interfaces:**
- Consumes: `LogicalStreamSource` (`source.start`/`source.batch`, exactly as
  `mountLogicalStreamRoute` already consumes it), `EventBus.onSequenceHint`,
  `FeedContext` (`{publicUrl, hubUrl, rssCloud}`), `logicalToFeedEntry(dto):
  TimelineEntry` and `itemContentFields(p: Post): {description: string, ...}`
  (both already in `core/src/domain/feed.ts`).
- Produces: `mountPublicFirehoseRoute(app: Hono, deps: PublicFirehoseDeps):
  void`, mounted at `GET /firehose/stream`. Later tasks (the web proxy) rely
  on this exact path and its SSE event shape: `event: upsert|remove|reset`,
  `data:` a JSON object with `model: 'firehose-v1'`.

- [ ] **Step 1: Export `itemContentFields`**

Read `core/src/domain/feed.ts` around line 109 to confirm current context,
then change:

```ts
function itemContentFields(p: Post) {
```

to:

```ts
export function itemContentFields(p: Post) {
```

No other change — same body, same behavior. This is the exact function
`renderRssFeed`/`renderFirehoseRss` already use to safely render a post's
content for external wire consumption (local posts: `renderLocalHtml`
through the sanitizer; remote posts: pass-through of already-sanitized
content) — the firehose reuses it instead of inventing a second content-safety
path.

- [ ] **Step 2: Write the failing core tests**

Read `core/test/logical-sse.test.ts` and `core/test/logical-moderation.test.ts`
first — this test file borrows their proven harness helpers (`setup()`-style
DB/store wiring from the first, `seedSource`/`acquire`/`drain`/
`remoteIdForSource` from the second) rather than reinventing them.

Create `core/test/logical-firehose-sse.test.ts`:

```ts
import { test, expect } from 'vitest'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { drainReconciliation } from '../src/logical/reconcile.ts'
import { createStreamSource, activateLogicalV2 } from '../src/logical/runtime.ts'
import { mountPublicFirehoseRoute } from '../src/api/logical-routes.ts'
import type { LookupFn } from '../src/domain/push-guard.ts'

type Raw = InstanceType<typeof Database>
const NOW = '2026-07-24T00:00:00.000Z'
const FEEDS = { publicUrl: 'https://rsc.test', hubUrl: null, rssCloud: false }

function seedSource(raw: Raw, id: string, url: string): void {
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, 'single_publisher', 'enabled', 'allowed', 'admin_federation', NULL, 0, ?)`,
  ).run(id, url, NOW)
}
const remoteIdForSource = (raw: Raw, sourceId: string): string =>
  (raw.prepare(`SELECT ik.logical_item_id AS id FROM logical_identity_keys_v2 ik JOIN deliveries_v2 d ON d.id = ik.key WHERE ik.kind = 'delivery' AND d.source_id = ?`).get(sourceId) as { id: string }).id
const ok = (body: string): Response => new Response(body, { status: 200 })
const RSS = (items: string): string => `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed T</title>${items}</channel></rss>`
const guidItem = (guid: string, body = 'd'): string => `<item><guid isPermaLink="false">${guid}</guid><title>t</title><description>${body}</description></item>`
async function acquireRemote(db: ReturnType<typeof createDatabaseContext>, sourceId: string, url: string, body: string): Promise<void> {
  const publicLookup: LookupFn = async () => [{ address: '93.184.216.34' }]
  const eng = createAcquisition({ db, fetchFn: (async () => ok(body)) as unknown as typeof fetch, lookupFn: publicLookup, now: () => NOW })
  await eng.acquireSource(sourceId, { kind: 'scheduled' }, undefined)
}

async function setup() {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as Raw
  const db = createDatabaseContext(raw)
  const store = createLogicalStore(db)
  const bus = createEventBus()
  const service = createService(repo, bus, null, store)
  activateLogicalV2(db, NOW)
  bus.onNewPost(() => { bus.emitSequenceHint(store.snapshot((tx) => tx.getJournalMetadata().highWaterSeq)) })
  const app = new Hono()
  mountPublicFirehoseRoute(app, { source: createStreamSource(db), bus, feeds: FEEDS, pollMs: 5, heartbeatMs: 30 })
  return { repo, raw, db, store, bus, service, app }
}
// A resumable cursor at the current high water — connecting with THIS (not a
// missing/absent one) keeps the stream open in the live poll loop instead of
// immediately resetting and closing, exactly like logical-sse.test.ts's own
// live-delivery tests (cursorNow there, same shape here).
const cursorNow = (store: Awaited<ReturnType<typeof setup>>['store']) => store.snapshot((tx) => tx.journalCursor())

interface Frame { event?: string; id?: string; data: Record<string, unknown> | null; comment: boolean }
async function readStream(res: Response, until: (frames: Frame[]) => boolean): Promise<Frame[]> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const frames: Frame[] = []
  for (let i = 0; i < 400 && !until(frames); i++) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value)
    let idx: number
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx); buf = buf.slice(idx + 2)
      const lines = raw.split('\n')
      const comment = raw.trimStart().startsWith(':')
      const dataLine = lines.find((l) => l.startsWith('data: '))
      frames.push({
        event: lines.find((l) => l.startsWith('event: '))?.slice(7),
        id: lines.find((l) => l.startsWith('id: '))?.slice(4),
        data: dataLine ? (JSON.parse(dataLine.slice(6)) as Record<string, unknown>) : null,
        comment,
      })
    }
  }
  await reader.cancel()
  return frames
}
const dataFrames = (frames: Frame[]) => frames.filter((f) => !f.comment && f.data)

test('a local post appears as an upsert with safe rendered content, RSC firehose model tag', async () => {
  const { app, service, store } = await setup()
  // Connect first (caught up at high water, stays open in the poll loop),
  // THEN create — proving live delivery, not just replay.
  const res = await app.request('/firehose/stream', { headers: { 'Last-Event-ID': cursorNow(store) } })
  const post = await service.createLocalPostAs('alice', 'Alice', '**hi** there')
  const frames = await readStream(res, (f) => dataFrames(f).some((x) => x.data!.id === post.id))
  const upsert = dataFrames(frames).find((f) => f.data!.id === post.id)!
  expect(upsert.event).toBe('upsert')
  expect(upsert.data!.model).toBe('firehose-v1')
  expect(upsert.data!.content).toContain('<strong>hi</strong>')
  expect(upsert.data!.author).toMatchObject({ displayName: 'Alice', url: 'https://rsc.test/u/alice' })
})

test('a remote item is never emitted as an upsert — filtered by origin', async () => {
  const { app, raw, db, store, service } = await setup()
  const res = await app.request('/firehose/stream', { headers: { 'Last-Event-ID': cursorNow(store) } })
  seedSource(raw, 's1', 'https://feed.test/f')
  await acquireRemote(db, 's1', 'https://feed.test/f', RSS(guidItem('g1')))
  drainReconciliation({ store, now: () => NOW })
  const remoteId = remoteIdForSource(raw, 's1')
  // A local post AFTER the remote item proves the stream is alive and past
  // the remote item's position, not merely still waiting to catch up.
  const marker = await service.createLocalPostAs('alice', 'Alice', 'marker')
  const frames = await readStream(res, (f) => dataFrames(f).some((x) => x.data!.id === marker.id))
  expect(dataFrames(frames).some((f) => f.data!.id === remoteId)).toBe(false)
})

test('a missing cursor is a reset, exactly like /stream', async () => {
  const { app } = await setup()
  const res = await app.request('/firehose/stream')
  const frames = await readStream(res, (f) => f.some((x) => x.event === 'reset'))
  expect(frames.some((f) => f.event === 'reset' && f.data!.model === 'firehose-v1')).toBe(true)
})

test('a per-IP connection cap rejects the (N+1)th concurrent connection with 429', async () => {
  const { app, store } = await setup()
  // A VALID resume cursor (not a missing one) keeps each connection open in
  // the live poll loop instead of resetting-and-closing immediately — without
  // this, streams would release their cap slot before all 6 requests finish
  // opening, making the 429 assertion below racy/flaky.
  const opts = { headers: { 'x-forwarded-for': '203.0.113.9', 'Last-Event-ID': cursorNow(store) } }
  const responses = await Promise.all(Array.from({ length: 6 }, () => app.request('/firehose/stream', opts)))
  const statuses = responses.map((r) => r.status).sort()
  expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0)
  expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(5)
  for (const r of responses) await r.body?.cancel()
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `docker compose exec -T core npm test -w core -- logical-firehose-sse`
Expected: FAIL — `mountPublicFirehoseRoute` doesn't exist yet.

- [ ] **Step 4: Implement `mountPublicFirehoseRoute`**

In `core/src/api/logical-routes.ts`, near `mountLogicalStreamRoute` (reuses
its exact pump/heartbeat shape), add:

```ts
// =============================================================================
// Public firehose SSE (2026-08-01 design, phase 1) — GET /firehose/stream
// =============================================================================
// Public, anonymous, no key, no session lookup. Reuses the same
// durable-journal transport as /stream (source.start/source.batch, the bus's
// coalesced sequence hint) but hardcodes an anonymous viewer and reshapes
// every frame: only origin==='local' upserts are emitted, and content is
// rendered through the SAME safe-wire path /users/rss.xml already uses
// (itemContentFields) — never the raw internal DTO, which may carry
// unrendered markdown. A remove frame carries no origin info and is passed
// through unfiltered: a remove for an id whose upsert was filtered out is a
// harmless no-op for any consumer that never saw that id in the first place.

export interface PublicFirehoseDeps {
  source: LogicalStreamSource
  bus: EventBus
  feeds: FeedContext
  pollMs?: number
  heartbeatMs?: number
  maxConnectionsPerIp?: number
}

const FIREHOSE_ANON: ProjectionViewer = { localAccountId: null, activeSourceIds: [] }
const FIREHOSE_RESET = JSON.stringify({ model: 'firehose-v1', kind: 'reset' })
const FIREHOSE_BATCH = 200

function firehoseEntry(item: LogicalItemDto, feeds: FeedContext): Record<string, unknown> {
  const entry = logicalToFeedEntry(item)
  const { description } = itemContentFields(entry)
  const authorUrl = entry.author.kind === 'local' && feeds.publicUrl ? `${feeds.publicUrl}/u/${entry.author.handle}` : entry.author.feedUrl
  return {
    model: 'firehose-v1',
    kind: 'upsert',
    id: item.id,
    title: entry.title,
    content: description,
    contentMarkdown: entry.contentMarkdown,
    url: entry.url,
    publishedAt: entry.publishedAt,
    author: { displayName: entry.author.displayName, url: authorUrl },
    inReplyTo: entry.inReplyTo,
  }
}

export function mountPublicFirehoseRoute(app: Hono, deps: PublicFirehoseDeps): void {
  const { source, bus, feeds } = deps
  const pollMs = deps.pollMs ?? 1000
  const heartbeatMs = deps.heartbeatMs ?? 15000
  const maxPerIp = deps.maxConnectionsPerIp ?? 5
  const ipCounts = new Map<string, number>()

  app.get('/firehose/stream', (c) => {
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
    const current = ipCounts.get(ip) ?? 0
    if (current >= maxPerIp) return c.json({ error: 'too many connections from this address' }, 429)
    ipCounts.set(ip, current + 1)
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      const n = (ipCounts.get(ip) ?? 1) - 1
      if (n <= 0) ipCounts.delete(ip)
      else ipCounts.set(ip, n)
    }

    return streamSSE(c, async (stream) => {
      stream.onAbort(release)
      try {
        let hintHigh = 0
        const off = bus.onSequenceHint((s) => { hintHigh = Math.max(hintHigh, s) })
        stream.onAbort(off)

        const cursor = c.req.header('Last-Event-ID') ?? c.req.query('last') ?? null
        const start = source.start(cursor && cursor.length > 0 ? cursor : null)
        if (start.kind === 'reset') {
          await stream.writeSSE({ event: 'reset', data: FIREHOSE_RESET })
          return
        }

        let after = start.afterSequence
        const generation = start.generation

        const pump = async (): Promise<boolean> => {
          for (;;) {
            const b = source.batch({ afterSequence: after, generation, viewer: FIREHOSE_ANON, limit: FIREHOSE_BATCH })
            for (const f of b.frames) {
              if (f.control === 'reset') {
                await stream.writeSSE({ event: 'reset', data: FIREHOSE_RESET, ...(f.id ? { id: f.id } : {}) })
                return true
              }
              if (f.event.kind === 'upsert') {
                if (f.event.item.origin !== 'local') continue
                await stream.writeSSE({ event: 'upsert', id: f.id, data: JSON.stringify(firehoseEntry(f.event.item, feeds)) })
              } else if (f.event.kind === 'remove') {
                await stream.writeSSE({ event: 'remove', id: f.id, data: JSON.stringify({ model: 'firehose-v1', kind: 'remove', id: f.event.logicalItemId }) })
              }
            }
            if (b.done) return true
            if (b.lastSequence <= after) break
            after = b.lastSequence
          }
          return false
        }

        if (await pump()) return

        let lastHb = Date.now()
        while (!stream.aborted) {
          await stream.sleep(pollMs)
          if (stream.aborted) break
          const nowMs = Date.now()
          const heartbeatDue = nowMs - lastHb >= heartbeatMs
          if (heartbeatDue) { await stream.write(': hb\n\n'); lastHb = nowMs }
          if (heartbeatDue || hintHigh > after) {
            if (await pump()) return
          }
        }
      } finally {
        release()
      }
    })
  })
}
```

Add `itemContentFields` to the existing `from '../domain/feed.ts'` import at
the top of `logical-routes.ts` (it already imports `logicalToFeedEntry` from
there).

- [ ] **Step 5: Wire it in `server.ts`**

Read `core/src/server.ts` around the existing `createApp({...})` call
(currently has `feeds: { publicUrl: config.publicUrl, hubUrl:
hubLinkUrl(config.websub, config.publicUrl), rssCloud: config.rssCloud }`
inlined) and the `mountLogicalStreamRoute(app, {...})` call just below it.
Extract the feeds object to a local `const` so both `createApp` and the new
mount share it — no behavior change, pure DRY:

```ts
const feeds = { publicUrl: config.publicUrl, hubUrl: hubLinkUrl(config.websub, config.publicUrl), rssCloud: config.rssCloud }
const app = createApp({
  service,
  bus,
  token: config.token,
  adminEmails: config.adminEmails,
  auth,
  users: repo,
  mailEnabled: config.mailEnabled,
  feeds,
  websub: config.websub.mode,
  // ...rest unchanged
```

Then, beside the existing `mountLogicalStreamRoute(app, {...})` call, add:

```ts
mountPublicFirehoseRoute(app, { source: runtime.streamSource, bus, feeds })
```

Add `mountPublicFirehoseRoute` to the existing
`import { mountLogicalStreamRoute, mountLogicalHandleRoute } from
'./api/logical-routes.ts'` line.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `docker compose exec -T core npm test -w core -- logical-firehose-sse`
Expected: all 4 tests pass.

- [ ] **Step 7: Full core suite + typecheck**

Run: `docker compose exec -T core npm test -w core` and `docker compose exec -T core npm run typecheck -w core`
Expected: all passing, 0 type errors (native type-stripping means vitest
alone won't catch type errors — always run tsc too, per this repo's testing
gotchas).

- [ ] **Step 8: Commit**

```bash
git add core/src/domain/feed.ts core/src/api/logical-routes.ts core/src/server.ts core/test/logical-firehose-sse.test.ts
git commit -m "$(cat <<'EOF'
feat(core): public anonymous firehose SSE at GET /firehose/stream

Phase 1 of the 2026-08-01 external-API design: a public, no-auth SSE
feed of new local posts, reusing the durable-journal /stream transport
with a hardcoded anonymous viewer, origin==='local' filtering, and
content rendered through the same safe-wire path /users/rss.xml
already uses (itemContentFields, now exported). A per-IP concurrent-
connection cap (in-memory, no new storage) bounds the newly-public
surface.

developed with the help of AI tools
EOF
)"
```

---

### Task 2: Web — bespoke pass-through proxy + tests

**Files:**
- Create: `web/src/routes/api/v1/firehose/stream/+server.ts`
- Test: `web/src/routes/api/v1/firehose/stream/server.test.ts`

**Interfaces:**
- Consumes: core's `GET /firehose/stream` (Task 1) — same `Last-Event-ID`/
  `?last=` cursor contract as `/stream`.
- Produces: `GET /api/v1/firehose/stream` on web, a plain pass-through (no
  frame transform) — later phases' `/api/v1/*` catch-all proxy (spec rev 2)
  is a *separate* file for the JSON REST routes; this file stays bespoke,
  matching why `web/src/routes/stream/+server.ts` is bespoke (SSE framing).

- [ ] **Step 1: Write the failing tests**

Read `web/src/routes/stream/+server.ts` and `web/src/routes/stream/
server.test.ts` first — this proxy is a *simpler* variant of that one (no
frame translation), so several tests below are close copies with the target
path/host changed; keep the parts that don't apply (there is no `?v2=1`
tolerance concern here, and no sanitizer-transform tests, since this file
does no transform at all).

Create `web/src/routes/api/v1/firehose/stream/server.test.ts`:

```ts
import { test, expect, vi, afterEach } from 'vitest'
import { GET } from './+server.ts'

const originalFetch = global.fetch

afterEach(() => {
	global.fetch = originalFetch
})

test('GET proxies core\'s public firehose stream unchanged, with SSE headers', async () => {
	const body = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('event: reset\ndata: {"model":"firehose-v1","kind":"reset"}\n\n'))
			controller.close()
		}
	})
	const fetchMock = vi.fn(async () => new Response(body, { status: 200 }))
	global.fetch = fetchMock as unknown as typeof fetch

	const request = new Request('http://x/api/v1/firehose/stream')
	const res = await GET({ request } as never)

	expect(fetchMock).toHaveBeenCalledWith('http://localhost:8787/firehose/stream', expect.objectContaining({ signal: request.signal }))
	expect(res.headers.get('content-type')).toBe('text/event-stream')
	expect(res.headers.get('cache-control')).toBe('no-cache')
	const text = await res.text()
	expect(text).toBe('event: reset\ndata: {"model":"firehose-v1","kind":"reset"}\n\n') // byte-verbatim, no transform
})

test('GET forwards upstream error status', async () => {
	const body = new ReadableStream({ start(controller) { controller.close() } })
	const fetchMock = vi.fn(async () => new Response(body, { status: 429 }))
	global.fetch = fetchMock as unknown as typeof fetch

	const request = new Request('http://x/api/v1/firehose/stream')
	const res = await GET({ request } as never)
	expect(res.status).toBe(429)
})

test('GET returns a retryable 503 when core is unreachable', async () => {
	global.fetch = vi.fn(async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
	const request = new Request('http://x/api/v1/firehose/stream')
	const res = await GET({ request } as never)
	expect(res.status).toBe(503)
})

test('GET forwards the Last-Event-ID header upstream', async () => {
	const body = new ReadableStream({ start(controller) { controller.close() } })
	const fetchMock = vi.fn(async () => new Response(body, { status: 200 }))
	global.fetch = fetchMock as unknown as typeof fetch

	const request = new Request('http://x/api/v1/firehose/stream', { headers: { 'Last-Event-ID': 'fh-9' } })
	await GET({ request } as never)
	const init = (fetchMock as any).mock.calls[0][1] as RequestInit
	expect(new Headers(init.headers).get('Last-Event-ID')).toBe('fh-9')
})

test('GET forwards ?last= as Last-Event-ID when no header is present', async () => {
	const body = new ReadableStream({ start(controller) { controller.close() } })
	const fetchMock = vi.fn(async () => new Response(body, { status: 200 }))
	global.fetch = fetchMock as unknown as typeof fetch

	const request = new Request('http://x/api/v1/firehose/stream?last=fh-9')
	await GET({ request } as never)
	const init = (fetchMock as any).mock.calls[0][1] as RequestInit
	expect(new Headers(init.headers).get('Last-Event-ID')).toBe('fh-9')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run api/v1/firehose`
Expected: FAIL — `./+server.ts` doesn't exist.

- [ ] **Step 3: Implement the proxy**

Read `web/src/routes/stream/+server.ts` in full first — this reuses its
`base()` import and Last-Event-ID/`?last=` precedence logic verbatim, but
drops the frame-transform `TransformStream` entirely (core already emits the
final wire shape) and points at `/firehose/stream` instead of `/stream`.

Create `web/src/routes/api/v1/firehose/stream/+server.ts`:

```ts
import type { RequestHandler } from './$types'
import { base } from '$lib/server/session'

// Public, anonymous — no cookie/session handling, unlike every other proxy
// in this app. A plain pass-through: core's /firehose/stream already emits
// the final wire-safe JSON shape (reusing the same content-rendering path
// /users/rss.xml uses), so unlike web/src/routes/stream/+server.ts (which
// renders raw internal DTOs through the sanitizer for the browser), this
// proxy does no frame transformation at all.
export const GET: RequestHandler = async ({ request }) => {
	const url = new URL(request.url)
	const lastEventId = request.headers.get('last-event-id') ?? url.searchParams.get('last')
	const upstreamUrl = `${base()}/firehose/stream`
	let upstream: Response
	try {
		upstream = await fetch(upstreamUrl, {
			signal: request.signal,
			headers: lastEventId ? { 'Last-Event-ID': lastEventId } : {}
		})
	} catch {
		return new Response('core unavailable', { status: 503 })
	}
	if (!upstream.ok) {
		return new Response(upstream.body, {
			status: upstream.status,
			headers: { 'content-type': upstream.headers.get('content-type') ?? 'text/plain' }
		})
	}
	return new Response(upstream.body, {
		status: upstream.status,
		headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }
	})
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run api/v1/firehose`
Expected: all 5 tests pass.

- [ ] **Step 5: Full web suite + typecheck**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run` and `docker compose exec -T web npm run -w web check`
Expected: all passing, 0 errors/warnings.

- [ ] **Step 6: Commit**

```bash
git add web/src/routes/api/v1/firehose/stream/+server.ts web/src/routes/api/v1/firehose/stream/server.test.ts
git commit -m "$(cat <<'EOF'
feat(web): proxy the public firehose SSE stream to core

Plain pass-through, no frame transform — core's /firehose/stream
already emits the final wire-safe shape. Public route, no auth
handling at all, unlike every other proxy in this app.

developed with the help of AI tools
EOF
)"
```

---

## Self-Review

**Spec coverage:** The spec's "Public firehose" section is fully covered:
route+path (`/api/v1/firehose/stream`), journal reuse, hardcoded anonymous
viewer, `origin === 'local'` filtering, Last-Event-ID replay (inherited from
the shared transport, no special-casing needed), and the per-IP guardrail —
all in Task 1. The spec's namespace section's firehose-specific note ("keeps
its own bespoke proxy file... SSE framing genuinely differs") is Task 2.
Everything else in the spec (read/write/admin API, key management) is
explicitly out of scope for this plan — separate plans, per the spec's
stated phasing.

**Placeholder scan:** No TBD/TODO; every step has complete, grounded code
read against the actual current files (`mountLogicalStreamRoute`'s exact
pump/heartbeat shape, `itemContentFields`'s exact reuse, `Post`/
`TimelineEntry`'s confirmed structural compatibility, `feeds` context's exact
shape from `server.ts`).

**Type consistency:** `PublicFirehoseDeps`/`mountPublicFirehoseRoute` (Task
1) is the only new exported interface; Task 2 doesn't reference it (the web
proxy talks HTTP, not TypeScript types, to core) — no cross-task type-name
drift risk.

**A design correction made during planning, not left implicit:** the spec's
brainstorm-time description implied passing the raw internal journal event
through to the public firehose. Grounding against the actual code
(`LogicalItemDto.content` requires `renderLocalHtml`/the sanitizer to become
safe HTML for local posts — confirmed by `web/src/routes/stream/
+server.ts`'s own separate render step) surfaced that raw pass-through would
be unsafe. This plan instead reuses `itemContentFields`, the exact function
`/users/rss.xml` already uses for the same problem — no new sanitization
code, and it's why Task 2's web proxy can be a dumb pass-through instead of
needing its own transform.
