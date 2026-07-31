import { test, expect } from 'vitest'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createAcquisition, parseCandidates, healOrphanedRuns } from '../src/logical/acquisition.ts'
import type { LookupFn } from '../src/domain/push-guard.ts'
import type { CommandEnvelope } from '../src/domain/types.ts'

type Raw = InstanceType<typeof Database>
const NOW = '2026-07-23T00:00:00.000Z'
const LATER = '2026-07-23T01:00:00.000Z'

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

function ok(body: string): Response {
  return new Response(body, { status: 200 })
}
function fakeFetch(map: Record<string, () => Response | Promise<Response>>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const h = map[url]
    if (!h) throw new Error(`no route: ${url}`)
    return await h()
  }) as unknown as typeof fetch
}
const publicLookup: LookupFn = async () => [{ address: '93.184.216.34' }]

const RSS = (items: string): string => `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>${items}</channel></rss>`
const guidItem = (guid: string, permalink: boolean, body = 'd'): string =>
  `<item><guid isPermaLink="${permalink}">${guid}</guid><title>t</title><description>${body}</description></item>`
const linkOnly = (link: string, body = 'd'): string => `<item><link>${link}</link><title>t</title><description>${body}</description></item>`
const bare = (title: string, body: string): string => `<item><title>${title}</title><description>${body}</description></item>`

// ---- enclosure URL volatility must not churn the fingerprint ----------------
// Podcast feeds wrap audio in tracking redirectors (podtrac/byspotify/mgln.ai/…)
// whose URL rotates on the tracker's own cadence. The rotating URL must NOT count
// as a material change, or every poll spawns a phantom version + "edited" marker
// (the 2026-07-25 763k-row / 2.6 GB runaway; reproduced on rss.art19.com).
const encItem = (url: string): string =>
  `<item><guid isPermaLink="false">ep-1</guid><title>t</title><description>d</description><enclosure url="${url}" type="audio/mpeg" length="12345"/></item>`

test('a rotated enclosure tracking URL does not change the fingerprint', () => {
  const a = parseCandidates(RSS(encItem('https://pscrb.fm/rss/p/mgln.ai/e/441/traffic.megaphone.fm/EP.mp3')))
  const b = parseCandidates(RSS(encItem('https://pscrb.fm/rss/p/mgln.ai/e/999/traffic.megaphone.fm/EP.mp3')))
  // same episode, only the tracker prefix rotated → identical fingerprint, no phantom version
  expect(a.candidates[0].fingerprint).toBe(b.candidates[0].fingerprint)
})

test('a changed publish date alone does not change the fingerprint', () => {
  // Dateless h-feed entries get arrival time substituted into `published`
  // (ingest toIsoOrNow), which churned the fingerprint every poll (blog.om.co,
  // ratio 4+). Excluding it from the fingerprint fixes that; a real edit still
  // shows via `updated` and via a content change.
  const dated = (date: string): string => `<item><guid isPermaLink="false">ep-1</guid><title>t</title><description>d</description><pubDate>${date}</pubDate></item>`
  const a = parseCandidates(RSS(dated('Mon, 28 Jul 2026 10:00:00 GMT')))
  const b = parseCandidates(RSS(dated('Mon, 28 Jul 2026 11:00:00 GMT')))
  expect(a.candidates[0].fingerprint).toBe(b.candidates[0].fingerprint)
})

test('a genuinely different enclosure (size) still changes the fingerprint', () => {
  // guard: dropping the URL must not drop ALL enclosure signal — a real media
  // change (different byte length) is still a material change.
  const a = parseCandidates(RSS(encItem('https://x/EP.mp3').replace('length="12345"', 'length="12345"')))
  const b = parseCandidates(RSS(`<item><guid isPermaLink="false">ep-1</guid><title>t</title><description>d</description><enclosure url="https://x/EP.mp3" type="audio/mpeg" length="99999"/></item>`))
  expect(a.candidates[0].fingerprint).not.toBe(b.candidates[0].fingerprint)
})

// ---- delivery identity priority (spec §2.2) ---------------------------------

test('an opaque GUID is the exact delivery key and is never URL-normalized', () => {
  const parsed = parseCandidates(RSS(guidItem('urn:uuid:ABC-123', false)))
  expect(parsed.candidates[0].keyKind).toBe('opaque')
  expect(parsed.candidates[0].key).toBe('urn:uuid:ABC-123')
})

test('with no opaque id the normalized permalink becomes the key', () => {
  const parsed = parseCandidates(RSS(linkOnly('https://Feed.Test/Post/1#frag')))
  expect(parsed.candidates[0].keyKind).toBe('permalink')
  // normalized: host lowercased, fragment stripped
  expect(parsed.candidates[0].key).toBe('https://feed.test/Post/1')
})

test('with neither id nor permalink a deterministic fallback key is synthesized', () => {
  const a = parseCandidates(RSS(bare('same', 'body')))
  const b = parseCandidates(RSS(bare('same', 'body')))
  expect(a.candidates[0].keyKind).toBe('fallback')
  expect(a.candidates[0].key).toBe(b.candidates[0].key) // deterministic across parses
  const c = parseCandidates(RSS(bare('same', 'DIFFERENT')))
  expect(c.candidates[0].key).not.toBe(a.candidates[0].key)
})

// ---- observation versions, deliveries, jobs (spec §2.1-2.2) -----------------

test('a first arrival writes a delivery, one observation version, and one observation job (column-named)', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  const eng = createAcquisition({ db, fetchFn: fakeFetch({ 'https://feed.test/f': () => ok(RSS(guidItem('g1', false))) }), lookupFn: publicLookup, now: () => NOW })
  await eng.acquireSource('s1', { kind: 'scheduled' }, undefined)

  expect(count(raw, 'deliveries_v2', 'WHERE source_id = ? AND key_kind = ? AND key = ?', 's1', 'opaque', 'g1')).toBe(1)
  expect(count(raw, 'observation_versions_v2')).toBe(1)
  const job = raw.prepare(`SELECT kind, status, attempts, run_id, observation_version_id FROM reconciliation_jobs_v2`).get() as { kind: string; status: string; attempts: number; run_id: string | null; observation_version_id: string | null }
  expect(job.kind).toBe('observation')
  expect(job.status).toBe('pending')
  expect(job.run_id).toBeTruthy()
  expect(job.observation_version_id).toBeTruthy()
})

test('the observation version records the complete durable first-arrival tuple', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  const eng = createAcquisition({ db, fetchFn: fakeFetch({ 'https://feed.test/f': () => ok(RSS(guidItem('g1', false) + guidItem('g2', false))) }), lookupFn: publicLookup, now: () => NOW })
  const run = await eng.acquireSource('s1', { kind: 'scheduled' }, undefined)
  if (!('runId' in run)) throw new Error('expected a run, got unavailable')
  const rows = raw.prepare(`SELECT arrival_at, run_id, wire_ordinal FROM observation_versions_v2 ORDER BY wire_ordinal`).all() as { arrival_at: string; run_id: string; wire_ordinal: number }[]
  expect(rows.map((r) => r.wire_ordinal)).toEqual([0, 1])
  expect(rows.every((r) => r.run_id === run.runId)).toBe(true)
  expect(rows.every((r) => r.arrival_at === NOW)).toBe(true)
})

test('a delivery retains at most 5 observation versions; older ones are evicted with their FK children', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  let body = ''
  const fetchFn = fakeFetch({ 'https://feed.test/f': () => ok(RSS(guidItem('g1', false, body))) })
  // 7 distinct bodies under one stable delivery key → 7 versions without a cap.
  // Belt-and-suspenders against a feed that churns a fingerprinted field every
  // poll (e.g. an arrival-substituted date); bounds storage AND jobs.
  for (let i = 0; i < 7; i++) {
    body = `body-${i}`
    const eng = createAcquisition({ db, fetchFn, lookupFn: publicLookup, now: () => `2026-07-23T00:0${i}:00.000Z` })
    await eng.acquireSource('s1', { kind: 'scheduled' }, undefined)
  }
  expect(count(raw, 'observation_versions_v2')).toBe(5)
  // jobs cascaded with the evicted versions — an uncascaded RESTRICT would have thrown
  expect(count(raw, 'reconciliation_jobs_v2')).toBe(5)
  const newest = raw.prepare(`SELECT canonical_material FROM observation_versions_v2 ORDER BY arrival_at DESC LIMIT 1`).get() as { canonical_material: Buffer }
  expect(Buffer.from(newest.canonical_material).toString()).toContain('body-6') // newest kept
})

test('an unchanged refetch creates no new version or job and only bumps seen metadata', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  const fetchFn = fakeFetch({ 'https://feed.test/f': () => ok(RSS(guidItem('g1', false))) })
  const eng1 = createAcquisition({ db, fetchFn, lookupFn: publicLookup, now: () => NOW })
  await eng1.acquireSource('s1', { kind: 'scheduled' }, undefined)
  const eng2 = createAcquisition({ db, fetchFn, lookupFn: publicLookup, now: () => LATER })
  await eng2.acquireSource('s1', { kind: 'scheduled' }, undefined)

  expect(count(raw, 'observation_versions_v2')).toBe(1) // no new version
  expect(count(raw, 'reconciliation_jobs_v2')).toBe(1) // no new job
  const d = raw.prepare(`SELECT seen_count, last_seen_at FROM deliveries_v2`).get() as { seen_count: number; last_seen_at: string }
  expect(d.seen_count).toBe(2)
  expect(d.last_seen_at).toBe(LATER)
  const v = raw.prepare(`SELECT seen_count, last_seen_at FROM observation_versions_v2`).get() as { seen_count: number; last_seen_at: string }
  expect(v.seen_count).toBe(2)
  expect(v.last_seen_at).toBe(LATER)
})

test('a fingerprint collision under the same key is skipped and records evidence, adding no version', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  // same opaque key, DIFFERENT canonical material — but we force a fingerprint clash
  // by seeding an observation version whose fingerprint equals the incoming one yet
  // whose material differs.
  await createAcquisition({ db, fetchFn: fakeFetch({ 'https://feed.test/f': () => ok(RSS(guidItem('g1', false, 'original'))) }), lookupFn: publicLookup, now: () => NOW }).acquireSource('s1', { kind: 'scheduled' }, undefined)
  // corrupt the stored material so a refetch of the SAME wire item mismatches its own fingerprint
  raw.prepare(`UPDATE observation_versions_v2 SET canonical_material = ?`).run(Buffer.from('tampered'))
  await createAcquisition({ db, fetchFn: fakeFetch({ 'https://feed.test/f': () => ok(RSS(guidItem('g1', false, 'original'))) }), lookupFn: publicLookup, now: () => LATER }).acquireSource('s1', { kind: 'scheduled' }, undefined)

  expect(count(raw, 'observation_versions_v2')).toBe(1) // no new version created
  expect(count(raw, 'acquisition_findings_v2', 'WHERE kind = ?', 'fingerprint_collision')).toBe(1)
  const counters = JSON.parse((raw.prepare(`SELECT counters_json FROM acquisition_runs_v2 ORDER BY started_at DESC LIMIT 1`).get() as { counters_json: string }).counters_json)
  expect(counters.skipped).toBe(1)
})

// ---- two-transaction protocol (spec §1.4) -----------------------------------

test('an administrator command associates a run in its own row that survives even a policy-rejected result', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  const command: CommandEnvelope = { actorScope: 'administrator', actorId: 'admin1', commandId: 'cmd-1', requestFingerprint: 'fp-1' }
  // pause the source AFTER the fetch begins to force the commit-time recheck to reject.
  const fetchFn = fakeFetch({ 'https://feed.test/f': () => { raw.prepare(`UPDATE remote_sources_v2 SET operation = 'paused' WHERE id = 's1'`).run(); return ok(RSS(guidItem('g1', false))) } })
  const eng = createAcquisition({ db, fetchFn, lookupFn: publicLookup, now: () => NOW })
  const run = await eng.acquireSource('s1', { kind: 'administrator', command }, undefined)
  if (!('runId' in run)) throw new Error('expected a run, got unavailable')

  // the command→run association committed BEFORE the (rejected) result
  const assoc = raw.prepare(`SELECT run_id FROM acquisition_commands_v2 WHERE actor_id = 'admin1' AND command_id = 'cmd-1'`).get() as { run_id: string } | undefined
  expect(assoc?.run_id).toBe(run.runId)
  // the result rechecked policy and rejected — nothing observed
  expect(run.outcome).toBe('policy_rejected')
  expect(count(raw, 'observation_versions_v2')).toBe(0)
  expect(count(raw, 'reconciliation_jobs_v2')).toBe(0)
})

test('an unparseable body terminalizes the run instead of leaving it processing', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  // an HTML error page: not a feedsmith feed and not an h-feed (no h-entry)
  const html = '<!doctype html><html><body><h1>Just an error page</h1></body></html>'
  const eng = createAcquisition({ db, fetchFn: fakeFetch({ 'https://feed.test/f': () => ok(html) }), lookupFn: publicLookup, now: () => NOW })
  const run = await eng.acquireSource('s1', { kind: 'scheduled' }, undefined)
  expect(run).toMatchObject({ status: 'terminal', outcome: 'operational_failure' })
  const row = raw.prepare(`SELECT status, outcome, failure_category FROM acquisition_runs_v2 WHERE source_id = 's1'`).get() as { status: string; outcome: string; failure_category: string }
  expect(row.status).toBe('terminal') // NOT stuck in 'processing'
  expect(row.failure_category).toBe('feed_parse')
  expect(count(raw, 'acquisition_findings_v2', 'WHERE kind = ?', 'parser_item_error')).toBe(1)
  expect(count(raw, 'observation_versions_v2')).toBe(0)
})

test('claiming a blocked source is unavailable and never fetches', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f', { governance: 'blocked' })
  let fetched = false
  const eng = createAcquisition({ db, fetchFn: fakeFetch({ 'https://feed.test/f': () => { fetched = true; return ok(RSS(guidItem('g1', false))) } }), lookupFn: publicLookup, now: () => NOW })
  const run = await eng.acquireSource('s1', { kind: 'scheduled' }, undefined)
  expect(fetched).toBe(false)
  expect(run).toMatchObject({ kind: 'unavailable', reason: 'blocked' })
  expect(count(raw, 'acquisition_runs_v2')).toBe(0)
})

test('a second acquisition for the same source is refused while one is in flight', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const fetchFn = fakeFetch({ 'https://feed.test/f': async () => { await gate; return ok(RSS(guidItem('g1', false))) } })
  const eng = createAcquisition({ db, fetchFn, lookupFn: publicLookup, now: () => NOW })

  const first = eng.acquireSource('s1', { kind: 'scheduled' }, undefined)
  await Promise.resolve() // let the first claim + fetch start
  expect(eng.inFlight('s1')).toBe(true)
  const second = await eng.acquireSource('s1', { kind: 'scheduled' }, undefined)
  expect(second).toMatchObject({ kind: 'unavailable', reason: 'unscheduled' })
  release()
  await first
  expect(eng.inFlight('s1')).toBe(false) // flag clears after the result transaction
  expect(count(raw, 'acquisition_runs_v2')).toBe(1) // only one fetch happened
})

test('healOrphanedRuns terminalizes every processing row unconditionally', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/s1')
  raw.prepare(
    `INSERT INTO acquisition_runs_v2 (id, source_id, reason, status, started_at, acquisition_committed_at, completed_at, outcome, counters_json, failure_category, diagnostic, push_capability_json)
     VALUES ('r1', 's1', 'scheduled', 'processing', ?, NULL, NULL, 'pending', '{}', NULL, NULL, NULL)`,
  ).run(NOW)

  const healed = healOrphanedRuns(db, LATER)
  expect(healed).toBe(1)
  const row = raw.prepare(`SELECT status, outcome, failure_category, diagnostic, completed_at FROM acquisition_runs_v2 WHERE id = 'r1'`).get()
  expect(row).toEqual({ status: 'terminal', outcome: 'operational_failure', failure_category: 'interrupted', diagnostic: 'orphaned by process restart', completed_at: LATER })
})

test('healOrphanedRuns is a no-op when nothing is processing', async () => {
  const { db } = await fresh()
  expect(healOrphanedRuns(db, NOW)).toBe(0)
})

test('healOrphanedRuns never touches an already-terminal run', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/s1')
  raw.prepare(
    `INSERT INTO acquisition_runs_v2 (id, source_id, reason, status, started_at, acquisition_committed_at, completed_at, outcome, counters_json, failure_category, diagnostic, push_capability_json)
     VALUES ('r1', 's1', 'scheduled', 'terminal', ?, ?, ?, 'parsed', '{}', NULL, NULL, NULL)`,
  ).run(NOW, NOW, NOW)
  expect(healOrphanedRuns(db, LATER)).toBe(0)
  const row = raw.prepare(`SELECT status, outcome FROM acquisition_runs_v2 WHERE id = 'r1'`).get()
  expect(row).toEqual({ status: 'terminal', outcome: 'parsed' })
})
