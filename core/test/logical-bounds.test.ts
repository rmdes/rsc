import { test, expect } from 'vitest'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { BOUNDS, createAcquisition, parseCandidates } from '../src/logical/acquisition.ts'
import { MAX_FAT_PING_BYTES } from '../src/api/app.ts'
import type { LookupFn } from '../src/domain/push-guard.ts'

type Raw = InstanceType<typeof Database>
const NOW = '2026-07-23T00:00:00.000Z'

function count(raw: Raw, table: string, where = '', ...args: unknown[]): number {
  return (raw.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get(...args) as { n: number }).n
}

async function fresh() {
  const repo = await createSqliteRepository(':memory:')
  return { raw: repo.raw as Raw, db: createDatabaseContext(repo.raw) }
}

function seedSource(raw: Raw, id: string, url: string, opts: { operation?: string; governance?: string } = {}): void {
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, 'single_publisher', ?, ?, 'admin_federation', NULL, 0, ?)`,
  ).run(id, url, opts.operation ?? 'enabled', opts.governance ?? 'allowed', NOW)
}

// A body-only 200 response over a ReadableStream (so the streaming cap is exercised).
function ok(body: string | Buffer, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : new Uint8Array(body), { status: 200, headers })
}
function redirect(status: number, location: string): Response {
  return new Response(null, { status, headers: { location } })
}

// A map-driven fetch fake keyed by URL. Each entry is a function so tests can
// count calls / delay. redirect:'manual' means the engine drives hops itself.
function fakeFetch(map: Record<string, () => Response | Promise<Response>>, calls?: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls?.push(url)
    const handler = map[url]
    if (!handler) throw new Error(`no route: ${url}`)
    return await handler()
  }) as unknown as typeof fetch
}

const publicLookup: LookupFn = async () => [{ address: '93.184.216.34' }]

const RSS = (items: string, channelExtra = ''): string =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>${channelExtra}${items}</channel></rss>`
const rssItem = (guid: string, extra = ''): string =>
  `<item><guid isPermaLink="false">${guid}</guid><title>t</title><description>d</description>${extra}</item>`

// ---- versioned bounds profile (spec §1.5): every numeric bound is pinned ----

test('the bounds profile pins every §1.5 numeric constant', () => {
  expect(BOUNDS.totalDeadlineMs).toBe(10_000)
  expect(BOUNDS.maxRedirects).toBe(5)
  expect(BOUNDS.maxBodyBytes).toBe(5 * 1024 * 1024)
  expect(BOUNDS.maxCandidates).toBe(1000)
  expect(BOUNDS.maxEnclosures).toBe(32)
  expect(BOUNDS.maxOpStringCodePoints).toBe(2048)
  expect(BOUNDS.maxOpStringBytes).toBe(8192)
  expect(BOUNDS.maxItemEvidenceBytes).toBe(1024 * 1024)
})

// V4 Task 3 review pin: the fat-ping route (api/app.ts) bounds a pushed body
// at the HTTP layer, BEFORE it ever reaches this module's own maxBodyBytes
// enforcement for a fetched body. The two are defined in different modules
// (an import in either direction is awkward — see both constants' comments)
// so an unasserted coincidence would let a future change to one silently make
// the untrusted push path more permissive than the trusted poll path ever is.
test('the fat-ping route bound matches the fetched-body bound exactly', () => {
  expect(MAX_FAT_PING_BYTES).toBe(BOUNDS.maxBodyBytes)
})

// ---- the total deadline (spec §1.5: begins before DNS/SSRF) -----------------

test('the total deadline aborts a slow fetch and the run fails operationally as a timeout', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  const fetchFn = fakeFetch({ 'https://feed.test/f': () => new Promise<Response>(() => {}) }) // never resolves
  const eng = createAcquisition({ db, fetchFn, lookupFn: publicLookup, deadlineMs: 40, now: () => NOW })

  const run = await eng.acquireSource('s1', { kind: 'scheduled' }, undefined)
  expect(run).toMatchObject({ status: 'terminal', outcome: 'operational_failure' })
  const row = raw.prepare(`SELECT outcome, failure_category FROM acquisition_runs_v2 WHERE source_id = 's1'`).get() as { outcome: string; failure_category: string }
  expect(row.outcome).toBe('operational_failure')
  expect(row.failure_category).toBe('timeout')
})

// ---- streaming 5 MiB decoded cap (enforced WHILE streaming, not after) ------

test('a body over 5 MiB is rejected without parsing and records bodyLimitExceeded', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  const oversized = Buffer.alloc(BOUNDS.maxBodyBytes + 1024, 0x61) // 5 MiB + 1 KiB of 'a'
  const fetchFn = fakeFetch({ 'https://feed.test/f': () => ok(oversized) })
  const eng = createAcquisition({ db, fetchFn, lookupFn: publicLookup, now: () => NOW })

  await eng.acquireSource('s1', { kind: 'scheduled' }, undefined)
  const row = raw.prepare(`SELECT counters_json, outcome FROM acquisition_runs_v2 WHERE source_id = 's1'`).get() as { counters_json: string; outcome: string }
  const counters = JSON.parse(row.counters_json)
  expect(counters.bodyLimitExceeded).toBe(true)
  expect(counters.candidates).toBe(0) // never parsed
  expect(count(raw, 'observation_versions_v2')).toBe(0)
})

test('the 5 MiB cap aborts mid-stream and never drains the whole body', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  let pulled = 0
  let cancelled = false
  const chunk = new Uint8Array(1024 * 1024) // 1 MiB per chunk
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= 100) { controller.close(); return } // ~100 MiB if fully drained
      pulled++
      controller.enqueue(chunk)
    },
    cancel() { cancelled = true },
  })
  const fetchFn = fakeFetch({ 'https://feed.test/f': () => new Response(stream, { status: 200 }) })
  const eng = createAcquisition({ db, fetchFn, lookupFn: publicLookup, now: () => NOW })

  await eng.acquireSource('s1', { kind: 'scheduled' }, undefined)
  const counters = JSON.parse((raw.prepare(`SELECT counters_json FROM acquisition_runs_v2 WHERE source_id = 's1'`).get() as { counters_json: string }).counters_json)
  expect(counters.bodyLimitExceeded).toBe(true)
  expect(cancelled).toBe(true) // the producer was cancelled — buffer-everything never cancels
  expect(pulled).toBeLessThan(100) // the stream was NOT fully consumed
  expect(pulled).toBeLessThanOrEqual(8) // aborted right after crossing 5 MiB, not ~100 MiB later
})

test('an oversized declared Content-Length is rejected immediately', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  // small actual body, but the declared length lies about being huge
  const fetchFn = fakeFetch({ 'https://feed.test/f': () => ok(RSS(rssItem('g1')), { 'content-length': String(BOUNDS.maxBodyBytes + 1) }) })
  const eng = createAcquisition({ db, fetchFn, lookupFn: publicLookup, now: () => NOW })

  await eng.acquireSource('s1', { kind: 'scheduled' }, undefined)
  const counters = JSON.parse((raw.prepare(`SELECT counters_json FROM acquisition_runs_v2 WHERE source_id = 's1'`).get() as { counters_json: string }).counters_json)
  expect(counters.bodyLimitExceeded).toBe(true)
  expect(count(raw, 'observation_versions_v2')).toBe(0)
})

// ---- redirects: at most five followed (spec §1.5) ---------------------------

test('at most five redirects are followed; a sixth is an operational failure', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's1', 'https://h.test/0')
  const map: Record<string, () => Response> = {}
  for (let i = 0; i < 7; i++) map[`https://h.test/${i}`] = () => redirect(302, `https://h.test/${i + 1}`)
  const eng = createAcquisition({ db, fetchFn: fakeFetch(map), lookupFn: publicLookup, now: () => NOW })

  const run = await eng.acquireSource('s1', { kind: 'scheduled' }, undefined)
  expect(run).toMatchObject({ outcome: 'operational_failure' })
})

// ---- SSRF at fetch time AND on every hop (V1 security handoff) ---------------

test('the initial URL is SSRF-checked at fetch time even though V1 never guarded it', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's1', 'https://internal.test/f') // an admin could have stored an RFC1918 target
  const privateLookup: LookupFn = async () => [{ address: '10.1.2.3' }]
  let fetched = false
  const fetchFn = fakeFetch({ 'https://internal.test/f': () => { fetched = true; return ok(RSS(rssItem('g1'))) } })
  const eng = createAcquisition({ db, fetchFn, lookupFn: privateLookup, now: () => NOW })

  const run = await eng.acquireSource('s1', { kind: 'scheduled' }, undefined)
  expect(fetched).toBe(false) // blocked before the socket opened
  expect(run).toMatchObject({ outcome: 'operational_failure' })
})

test('a redirect hop resolving to a private address is blocked mid-chain', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's1', 'https://public.test/f')
  const lookupFn: LookupFn = async (h) => (h === 'public.test' ? [{ address: '93.184.216.34' }] : [{ address: '169.254.169.254' }])
  let hitInternal = false
  const fetchFn = fakeFetch({
    'https://public.test/f': () => redirect(301, 'https://metadata.test/latest'),
    'https://metadata.test/latest': () => { hitInternal = true; return ok('x') },
  })
  const eng = createAcquisition({ db, fetchFn, lookupFn, now: () => NOW })

  await eng.acquireSource('s1', { kind: 'scheduled' }, undefined)
  expect(hitInternal).toBe(false)
})

test('a hop rejected mid-chain still retains its redirect evidence (spec §1.6)', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's1', 'https://public.test/f')
  const lookupFn: LookupFn = async (h) => (h === 'public.test' ? [{ address: '93.184.216.34' }] : [{ address: '169.254.169.254' }])
  const fetchFn = fakeFetch({
    'https://public.test/f': () => redirect(301, 'https://metadata.test/latest'),
    'https://metadata.test/latest': () => ok('x'),
  })
  const eng = createAcquisition({ db, fetchFn, lookupFn, now: () => NOW })
  const run = await eng.acquireSource('s1', { kind: 'scheduled' }, undefined)
  expect(run).toMatchObject({ outcome: 'operational_failure' })
  // the rejected hop's from/to/ordinal/status is persisted even though the fetch failed
  const hop = raw.prepare(`SELECT ordinal, status, from_evidence, to_evidence FROM redirect_observations_v2`).get() as { ordinal: number; status: number; from_evidence: string; to_evidence: string } | undefined
  expect(hop).toEqual({ ordinal: 0, status: 301, from_evidence: 'https://public.test/f', to_evidence: 'https://metadata.test/latest' })
  expect(count(raw, 'source_aliases_v2')).toBe(0) // still no alias on a rejected chain
})

test('a URL carrying credentials is rejected before the fetch', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's1', 'https://user:pass@feed.test/f')
  let fetched = false
  const fetchFn = fakeFetch({ 'https://user:pass@feed.test/f': () => { fetched = true; return ok('x') } })
  const eng = createAcquisition({ db, fetchFn, lookupFn: publicLookup, now: () => NOW })
  const run = await eng.acquireSource('s1', { kind: 'scheduled' }, undefined)
  expect(fetched).toBe(false)
  expect(run).toMatchObject({ outcome: 'operational_failure' })
})

test('a normalized redirect loop stops immediately and records redirect_loop', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's1', 'https://loop.test/a')
  const fetchFn = fakeFetch({
    'https://loop.test/a': () => redirect(302, 'https://loop.test/b'),
    'https://loop.test/b': () => redirect(302, 'https://loop.test/a'),
  })
  const eng = createAcquisition({ db, fetchFn, lookupFn: publicLookup, now: () => NOW })
  await eng.acquireSource('s1', { kind: 'scheduled' }, undefined)
  const finding = raw.prepare(`SELECT kind FROM acquisition_findings_v2 WHERE kind = 'redirect_loop'`).get()
  expect(finding).toBeTruthy()
})

// ---- redirect-alias proof (spec §1.6) ---------------------------------------

test('an uninterrupted 301 chain from the canonical URL proves the target as a source alias', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's1', 'https://old.test/f')
  const fetchFn = fakeFetch({
    'https://old.test/f': () => redirect(301, 'https://new.test/f'),
    'https://new.test/f': () => ok(RSS(rssItem('g1'))),
  })
  const eng = createAcquisition({ db, fetchFn, lookupFn: publicLookup, now: () => NOW })
  await eng.acquireSource('s1', { kind: 'scheduled' }, undefined)
  const alias = raw.prepare(`SELECT url, source_id FROM source_aliases_v2 WHERE url = 'https://new.test/f'`).get() as { url: string; source_id: string } | undefined
  expect(alias).toEqual({ url: 'https://new.test/f', source_id: 's1' })
})

test('a 302 anywhere in the chain breaks the alias proof for later permanent hops', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's1', 'https://a.test/f')
  const fetchFn = fakeFetch({
    'https://a.test/f': () => redirect(302, 'https://b.test/f'),
    'https://b.test/f': () => redirect(301, 'https://c.test/f'),
    'https://c.test/f': () => ok(RSS(rssItem('g1'))),
  })
  const eng = createAcquisition({ db, fetchFn, lookupFn: publicLookup, now: () => NOW })
  await eng.acquireSource('s1', { kind: 'scheduled' }, undefined)
  // neither B nor C may become an alias (302 first breaks the proof)
  expect(count(raw, 'source_aliases_v2')).toBe(0)
  // but every hop is still retained as redirect evidence
  expect(count(raw, 'redirect_observations_v2')).toBe(2)
})

test('an ownership collision commits run outcome + redirect evidence + conflict but no aliases/observations/jobs', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's1', 'https://a.test/f')
  seedSource(raw, 's2', 'https://owned.test/f') // a DIFFERENT source already owns the target
  const fetchFn = fakeFetch({
    'https://a.test/f': () => redirect(301, 'https://owned.test/f'),
    'https://owned.test/f': () => ok(RSS(rssItem('g1'))),
  })
  const eng = createAcquisition({ db, fetchFn, lookupFn: publicLookup, now: () => NOW })
  const run = await eng.acquireSource('s1', { kind: 'scheduled' }, undefined)
  expect(run).toMatchObject({ outcome: 'redirect_conflict' })
  expect(count(raw, 'source_aliases_v2')).toBe(0)
  expect(count(raw, 'observation_versions_v2')).toBe(0)
  expect(count(raw, 'reconciliation_jobs_v2')).toBe(0)
  expect(count(raw, 'source_validators_v2')).toBe(0)
  const conflict = raw.prepare(`SELECT kind FROM acquisition_findings_v2 WHERE kind = 'redirect_ownership_conflict'`).get()
  expect(conflict).toBeTruthy()
  expect(count(raw, 'redirect_observations_v2')).toBe(1)
})

test('redirecting to the same source existing alias writes nothing new', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's1', 'https://a.test/f')
  raw.prepare(`INSERT INTO source_aliases_v2 (url, source_id, created_at) VALUES ('https://b.test/f', 's1', ?)`).run(NOW)
  const fetchFn = fakeFetch({
    'https://a.test/f': () => redirect(301, 'https://b.test/f'),
    'https://b.test/f': () => ok(RSS(rssItem('g1'))),
  })
  const eng = createAcquisition({ db, fetchFn, lookupFn: publicLookup, now: () => NOW })
  await eng.acquireSource('s1', { kind: 'scheduled' }, undefined)
  expect(count(raw, 'source_aliases_v2')).toBe(1) // unchanged
})

// ---- conditional validators indexed by effective URL (spec §1.6) ------------

test('validators are persisted against the final effective URL', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's1', 'https://old.test/f')
  const fetchFn = fakeFetch({
    'https://old.test/f': () => redirect(301, 'https://new.test/f'),
    'https://new.test/f': () => ok(RSS(rssItem('g1')), { etag: 'W/"abc"', 'last-modified': 'Wed, 21 Oct 2026 07:28:00 GMT' }),
  })
  const eng = createAcquisition({ db, fetchFn, lookupFn: publicLookup, now: () => NOW })
  await eng.acquireSource('s1', { kind: 'scheduled' }, undefined)
  const v = raw.prepare(`SELECT effective_url, etag, last_modified FROM source_validators_v2 WHERE source_id = 's1'`).get() as { effective_url: string; etag: string; last_modified: string }
  expect(v.effective_url).toBe('https://new.test/f')
  expect(v.etag).toBe('W/"abc"')
})

test('a 304 not-modified records notModified with zero candidates and zero jobs', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  raw.prepare(`INSERT INTO source_validators_v2 (source_id, effective_url, etag, last_modified) VALUES ('s1', 'https://feed.test/f', 'W/"tag"', NULL)`).run()
  let seenHeaders: Headers | undefined
  const fetchFn = (async (_i: unknown, init: RequestInit) => { seenHeaders = new Headers(init.headers); return new Response(null, { status: 304 }) }) as unknown as typeof fetch
  const eng = createAcquisition({ db, fetchFn, lookupFn: publicLookup, now: () => NOW })
  await eng.acquireSource('s1', { kind: 'scheduled' }, undefined)
  expect(seenHeaders?.get('if-none-match')).toBe('W/"tag"') // conditional GET issued
  const counters = JSON.parse((raw.prepare(`SELECT counters_json FROM acquisition_runs_v2 WHERE source_id = 's1'`).get() as { counters_json: string }).counters_json)
  expect(counters.notModified).toBe(true)
  expect(counters.candidates).toBe(0)
  expect(count(raw, 'reconciliation_jobs_v2')).toBe(0)
})

// ---- 1,000 candidate cap + ordinals assigned before the cap (spec §1.5) -----

test('candidates carry a zero-based wire ordinal in RSS document order', () => {
  const doc = RSS(Array.from({ length: 5 }, (_, i) => rssItem(`g${i}`)).join(''))
  const parsed = parseCandidates(doc)
  expect(parsed.adapter).toBe('rss')
  expect(parsed.candidates.map((c) => c.wireOrdinal)).toEqual([0, 1, 2, 3, 4])
  expect(parsed.candidates.map((c) => c.key)).toEqual(['g0', 'g1', 'g2', 'g3', 'g4'])
})

test('h-feed candidates use document order with zero-based ordinals (spec §1.5)', () => {
  const entry = (n: number): string =>
    `<article class="h-entry"><a class="u-url" href="https://blog.test/${n}">l</a><h1 class="p-name">Title ${n}</h1><div class="e-content">body ${n}</div><time class="dt-published">2026-01-0${n}</time></article>`
  const html = `<html><body><div class="h-feed">${entry(1)}${entry(2)}${entry(3)}</div></body></html>`
  const parsed = parseCandidates(html, 'https://blog.test/')
  expect(parsed.adapter).toBe('hfeed')
  expect(parsed.candidates.map((c) => c.wireOrdinal)).toEqual([0, 1, 2])
  expect(parsed.candidates.map((c) => c.key)).toEqual(['https://blog.test/1', 'https://blog.test/2', 'https://blog.test/3'])
  expect(parsed.candidates.map((c) => c.keyKind)).toEqual(['permalink', 'permalink', 'permalink'])
})

test('JSON Feed candidates use array order', () => {
  const items = Array.from({ length: 3 }, (_, i) => `{"id":"j${i}","content_text":"c"}`).join(',')
  const doc = `{"version":"https://jsonfeed.org/version/1.1","title":"T","items":[${items}]}`
  const parsed = parseCandidates(doc)
  expect(parsed.adapter).toBe('jsonfeed')
  expect(parsed.candidates.map((c) => c.key)).toEqual(['j0', 'j1', 'j2'])
})

test('only the first 1,000 candidates are examined; the 1001st is omitted even if earlier ones were skipped', () => {
  const items = Array.from({ length: 1001 }, (_, i) => rssItem(`g${i}`)).join('')
  const parsed = parseCandidates(RSS(items))
  expect(parsed.candidateCount).toBe(1001)
  expect(parsed.examined).toBe(1000)
  expect(parsed.omitted).toBe(1)
  expect(parsed.itemsTruncated).toBe(true)
  expect(parsed.candidates.at(-1)?.wireOrdinal).toBe(999) // ordinal 1000 never appears
})

// ---- per-item structural bounds (spec §1.5) ---------------------------------

test('at most 32 enclosures are kept per item', () => {
  const encs = Array.from({ length: 40 }, (_, i) => `<enclosure url="https://e.test/${i}.mp3" length="1" type="audio/mpeg"/>`).join('')
  const parsed = parseCandidates(RSS(rssItem('g1', encs)))
  expect(parsed.candidates[0].enclosures).toHaveLength(BOUNDS.maxEnclosures)
})

test('an item whose operational identifier exceeds the code-point limit is skipped whole', () => {
  const hugeGuid = 'x'.repeat(BOUNDS.maxOpStringCodePoints + 1)
  const parsed = parseCandidates(RSS(rssItem(hugeGuid) + rssItem('ok')))
  expect(parsed.candidates.map((c) => c.key)).toEqual(['ok']) // the oversized-id item dropped
  expect(parsed.findings.some((f) => f.kind === 'invalid_identifier' || f.kind === 'operational_identifier_limit')).toBe(true)
})

test('item evidence over 1 MiB skips the whole item with an item_evidence_limit finding', () => {
  const huge = 'z'.repeat(BOUNDS.maxItemEvidenceBytes + 10)
  // the huge string IS the item's single description (its canonical content).
  const bigItem = `<item><guid isPermaLink="false">big</guid><title>t</title><description>${huge}</description></item>`
  const parsed = parseCandidates(RSS(bigItem + rssItem('small')))
  expect(parsed.candidates.map((c) => c.key)).toEqual(['small'])
  expect(parsed.findings.some((f) => f.kind === 'item_evidence_limit')).toBe(true)
})

test('an oversized optional name claim becomes inert digest-backed evidence and the item is kept', () => {
  // 'あ' is 3 UTF-8 bytes; 3000 of them = 9000 bytes > the 4,096-byte raw bound.
  const bigTitle = 'あ'.repeat(3000)
  const item = `<item><guid isPermaLink="false">ok</guid><title>${bigTitle}</title><description>d</description></item>`
  const parsed = parseCandidates(RSS(item))
  expect(parsed.candidates.map((c) => c.key)).toEqual(['ok']) // valid content still kept
  const evidence = JSON.parse(parsed.candidates[0].rawEvidenceJson)
  expect(evidence.title).toMatchObject({ kind: 'title', truncated: true, byteLength: Buffer.byteLength(bigTitle, 'utf8') })
  expect(evidence.title.prefix.length).toBeLessThanOrEqual(64) // bounded Unicode-safe prefix
  expect(evidence.title.sha256).toMatch(/^[0-9a-f]{64}$/) // SHA-256 digest
})

test('a multi-byte operational identifier over the 8,192 UTF-8 byte bound is skipped', () => {
  // 4-byte emoji: 2,100 code points = 8,400 UTF-8 bytes. maxOpStringBytes (8,192)
  // = 4 x maxOpStringCodePoints (2,048), so in UTF-8 a byte-bound violation always
  // co-trips the code-point bound (true isolation is impossible); this asserts the
  // byte measurement is UTF-8 bytes, not JS string length.
  const emojiGuid = '🎉'.repeat(2100)
  const parsed = parseCandidates(RSS(rssItem(emojiGuid) + rssItem('ok')))
  expect(parsed.candidates.map((c) => c.key)).toEqual(['ok'])
  const finding = parsed.findings.find((f) => f.kind === 'operational_identifier_limit')
  expect(finding).toBeTruthy()
  const ev = JSON.parse(finding!.evidenceJson)
  expect(ev.byteLength).toBe(Buffer.byteLength(emojiGuid, 'utf8')) // measured in UTF-8 bytes
  expect(ev.byteLength).toBeGreaterThan(BOUNDS.maxOpStringBytes)
})

// ---- inert push discovery (spec §1.2, step 1b) ------------------------------

test('a feed advertising WebSub records only inert push-capability evidence and calls no push endpoint', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  const calls: string[] = []
  const withHub = RSS(rssItem('g1'), `<atom:link xmlns:atom="http://www.w3.org/2005/Atom" rel="hub" href="https://hub.test/sub"/><atom:link xmlns:atom="http://www.w3.org/2005/Atom" rel="self" href="https://feed.test/f"/>`)
  const fetchFn = fakeFetch({ 'https://feed.test/f': () => ok(withHub) }, calls)
  const eng = createAcquisition({ db, fetchFn, lookupFn: publicLookup, now: () => NOW })
  await eng.acquireSource('s1', { kind: 'scheduled' }, undefined)

  const pc = (raw.prepare(`SELECT push_capability_json FROM acquisition_runs_v2 WHERE source_id = 's1'`).get() as { push_capability_json: string | null }).push_capability_json
  expect(pc).toBeTruthy()
  expect(JSON.parse(pc as string)).toMatchObject({ mode: 'websub', endpoint: 'https://hub.test/sub' })
  expect(calls).toEqual(['https://feed.test/f']) // the hub was never contacted
})
