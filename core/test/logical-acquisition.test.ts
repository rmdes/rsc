import { test, expect } from 'vitest'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createAcquisition, parseCandidates, healOrphanedRuns } from '../src/logical/acquisition.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { drainReconciliation } from '../src/logical/reconcile.ts'
import { projectTimeline, projectItem } from '../src/logical/projector.ts'
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

// ---- one version per delivery (phase B): overwrite in place, never append ----

test('a delivery keeps exactly ONE observation version across repeated content changes — overwritten in place, same id, first arrival frozen', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  let body = 'body-0'
  const fetchFn = fakeFetch({ 'https://feed.test/f': () => ok(RSS(guidItem('g1', false, body))) })

  await createAcquisition({ db, fetchFn, lookupFn: publicLookup, now: () => NOW }).acquireSource('s1', { kind: 'scheduled' }, undefined)
  const first = raw.prepare(`SELECT id, arrival_at, run_id FROM observation_versions_v2`).get() as { id: string; arrival_at: string; run_id: string }

  // 6 more genuine content changes on the SAME delivery — no cap, no UNIQUE
  // throw, and never a second version row (spec C1).
  for (let i = 1; i <= 6; i++) {
    body = `body-${i}`
    const now = `2026-07-23T00:0${i}:00.000Z`
    await createAcquisition({ db, fetchFn, lookupFn: publicLookup, now: () => now }).acquireSource('s1', { kind: 'scheduled' }, undefined)
  }

  expect(count(raw, 'observation_versions_v2')).toBe(1)
  expect(count(raw, 'reconciliation_jobs_v2')).toBe(1) // reset in place, never inserted
  const row = raw.prepare(`SELECT id, arrival_at, run_id, canonical_material FROM observation_versions_v2`).get() as { id: string; arrival_at: string; run_id: string; canonical_material: Buffer }
  expect(row.id).toBe(first.id) // same row throughout — overwritten, not replaced
  expect(row.arrival_at).toBe(first.arrival_at) // I2: first-arrival stays frozen
  expect(row.run_id).toBe(first.run_id)
  expect(Buffer.from(row.canonical_material).toString()).toContain('body-6') // newest content wins
  const job = raw.prepare(`SELECT status FROM reconciliation_jobs_v2`).get() as { status: string }
  expect(job.status).toBe('pending') // re-pended so the drain reconciles the latest change
})

// Review Critical: a cap-era (or otherwise not-yet-collapsed by Task 4)
// delivery can have MULTIPLE observation_versions_v2 sibling rows. Picking one
// via an unordered `WHERE delivery_id = ?` (SQLite's UNIQUE(delivery_id,
// fingerprint) auto-index order — effectively fingerprint-hash order, not
// display order) can silently overwrite the WRONG sibling: the edit is
// recorded, but not on the version readers actually see — a silent edit loss.
// The lookup must resolve the CURRENT-DISPLAY version the same way the reader
// does (projector.ts's projectRemote: the top-`sequence` presentation entry).
test('a content change on a delivery with a stale sibling version overwrites the CURRENT-DISPLAY version, never the sibling', async () => {
  const { raw, db } = await fresh()
  const store = createLogicalStore(db)
  seedSource(raw, 's1', 'https://feed.test/f')
  const fetchFn1 = fakeFetch({ 'https://feed.test/f': () => ok(RSS(guidItem('g1', false, 'v1'))) })
  await createAcquisition({ db, fetchFn: fetchFn1, lookupFn: publicLookup, now: () => NOW }).acquireSource('s1', { kind: 'scheduled' }, undefined)
  expect(drainReconciliation({ store, now: () => NOW })).toBe(1)

  const delivery = raw.prepare(`SELECT id FROM deliveries_v2`).get() as { id: string }
  const current = raw.prepare(`SELECT id FROM observation_versions_v2`).get() as { id: string }
  const run = raw.prepare(`SELECT id FROM acquisition_runs_v2`).get() as { id: string }

  // Hand-seed an OLDER sibling version — simulating a pre-existing multi-version
  // delivery (cap-era, or any not-yet-collapsed chain). It sits at presentation
  // sequence 0; the real current-display version (from above) is bumped to
  // sequence 1 — the higher sequence is what a reader sees.
  const sibling = parseCandidates(RSS(guidItem('g1', false, 'stale-sibling'))).candidates[0]
  raw.prepare(
    `INSERT INTO observation_versions_v2 (id, delivery_id, fingerprint_version, fingerprint, canonical_material, arrival_at, run_id, wire_ordinal, last_seen_at, last_seen_run_id, seen_count, raw_evidence_json, normalized_json)
     VALUES ('v-sibling', ?, 1, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?)`,
  ).run(delivery.id, sibling.fingerprint, Buffer.from(sibling.canonicalMaterial), NOW, run.id, NOW, run.id, sibling.rawEvidenceJson, sibling.normalizedJson)
  raw.prepare(`UPDATE presentation_entries_v2 SET sequence = 1 WHERE observation_version_id = ?`).run(current.id)
  raw.prepare(
    `INSERT INTO presentation_entries_v2 (delivery_id, sequence, observation_version_id, effective_updated_at, provenance, material_fingerprint) VALUES (?, 0, 'v-sibling', ?, 'arrival', ?)`,
  ).run(delivery.id, NOW, sibling.fingerprint)
  expect(count(raw, 'observation_versions_v2')).toBe(2) // the starting multi-version shape
  expect(count(raw, 'presentation_entries_v2')).toBe(2)

  // A real content-change poll on the SAME delivery.
  const fetchFn2 = fakeFetch({ 'https://feed.test/f': () => ok(RSS(guidItem('g1', false, 'v2-fresh'))) })
  await createAcquisition({ db, fetchFn: fetchFn2, lookupFn: publicLookup, now: () => LATER }).acquireSource('s1', { kind: 'scheduled' }, undefined)
  expect(drainReconciliation({ store, now: () => LATER })).toBe(1)

  expect(count(raw, 'observation_versions_v2')).toBe(2) // still 2 — overwritten in place, not appended
  const currentRow = raw.prepare(`SELECT canonical_material FROM observation_versions_v2 WHERE id = ?`).get(current.id) as { canonical_material: Buffer }
  expect(Buffer.from(currentRow.canonical_material).toString()).toContain('v2-fresh') // the edit landed HERE
  const siblingRow = raw.prepare(`SELECT canonical_material FROM observation_versions_v2 WHERE id = 'v-sibling'`).get() as { canonical_material: Buffer }
  expect(Buffer.from(siblingRow.canonical_material).toString()).toContain('stale-sibling') // untouched

  // The reader confirms the fresh content is actually what's visible — not
  // just that SOME version somewhere got edited.
  const item = raw.prepare(`SELECT id FROM logical_items_v2`).get() as { id: string }
  const dto = db.read((tx) => projectItem(tx, item.id, { localAccountId: null, activeSourceIds: [] }))
  expect(dto?.content).toBe('v2-fresh')
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

// ---- age ingest gate (Task 2: the retention loop-breaker) -------------------
// Retention deletes items the feed still serves, so without a gate the next
// poll re-ingests them as "new" — a delete<->re-ingest flood. commitAcquisition
// must refuse to create a delivery/version/job for an out-of-window item on a
// NEW delivery, using the identical content-date formula the retention trim
// (Task 1) uses so gate/trim/timeline never disagree about what "old" means.

const datedItem = (guid: string, pubDate: string, body = 'd'): string =>
  `<item><guid isPermaLink="false">${guid}</guid><title>t</title><description>${body}</description><pubDate>${pubDate}</pubDate></item>`

const OLD_DATE = 'Mon, 23 Jul 2024 00:00:00 GMT' // ~2 years before NOW
const TODAY_DATE = 'Thu, 23 Jul 2026 00:00:00 GMT' // == NOW

test('an item older than the live max-age cap is never ingested on a new delivery, and increments retentionFiltered; a same-poll fresh item still ingests', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  const body = RSS(datedItem('old1', OLD_DATE) + datedItem('new1', TODAY_DATE))
  const eng = createAcquisition({
    db, fetchFn: fakeFetch({ 'https://feed.test/f': () => ok(body) }), lookupFn: publicLookup, now: () => NOW,
    getSetting: async (k) => (k === 'max_remote_item_age_days' ? '120' : undefined),
  })
  await eng.acquireSource('s1', { kind: 'scheduled' }, undefined)

  expect(count(raw, 'deliveries_v2', 'WHERE key = ?', 'old1')).toBe(0)
  expect(count(raw, 'deliveries_v2', 'WHERE key = ?', 'new1')).toBe(1)
  expect(count(raw, 'observation_versions_v2')).toBe(1)
  expect(count(raw, 'reconciliation_jobs_v2')).toBe(1)
  const counters = JSON.parse((raw.prepare(`SELECT counters_json FROM acquisition_runs_v2 ORDER BY started_at DESC LIMIT 1`).get() as { counters_json: string }).counters_json)
  expect(counters.retentionFiltered).toBe(1)
})

test('loop-dead: polling the same old-dated feed twice under the cap creates zero new deliveries either time', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  const fetchFn = fakeFetch({ 'https://feed.test/f': () => ok(RSS(datedItem('old1', OLD_DATE))) })
  const getSetting = async (k: string) => (k === 'max_remote_item_age_days' ? '120' : undefined)

  await createAcquisition({ db, fetchFn, lookupFn: publicLookup, now: () => NOW, getSetting }).acquireSource('s1', { kind: 'scheduled' }, undefined)
  expect(count(raw, 'deliveries_v2')).toBe(0)

  await createAcquisition({ db, fetchFn, lookupFn: publicLookup, now: () => LATER, getSetting }).acquireSource('s1', { kind: 'scheduled' }, undefined)
  expect(count(raw, 'deliveries_v2')).toBe(0) // still never created — no delete<->re-ingest flood
})

test('maxAgeDays=0 leaves the gate inert: the old item ingests normally', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  const eng = createAcquisition({ db, fetchFn: fakeFetch({ 'https://feed.test/f': () => ok(RSS(datedItem('old1', OLD_DATE))) }), lookupFn: publicLookup, now: () => NOW })
  await eng.acquireSource('s1', { kind: 'scheduled' }, undefined)

  expect(count(raw, 'deliveries_v2', 'WHERE key = ?', 'old1')).toBe(1)
  expect(count(raw, 'observation_versions_v2')).toBe(1)
})

test('an existing delivery is never gated: a genuine edit to an already-ingested old item is still recorded (overwritten in place)', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  // first poll: no cap active — the old item ingests and creates the delivery.
  await createAcquisition({ db, fetchFn: fakeFetch({ 'https://feed.test/f': () => ok(RSS(datedItem('old1', OLD_DATE, 'v1'))) }), lookupFn: publicLookup, now: () => NOW }).acquireSource('s1', { kind: 'scheduled' }, undefined)
  expect(count(raw, 'deliveries_v2')).toBe(1)
  expect(count(raw, 'observation_versions_v2')).toBe(1)
  const first = raw.prepare(`SELECT id FROM observation_versions_v2`).get() as { id: string }

  // second poll: cap now active, same old date, but the content changed — the
  // delivery already exists, so the age gate must not apply to it.
  const getSetting = async (k: string) => (k === 'max_remote_item_age_days' ? '120' : undefined)
  await createAcquisition({ db, fetchFn: fakeFetch({ 'https://feed.test/f': () => ok(RSS(datedItem('old1', OLD_DATE, 'v2'))) }), lookupFn: publicLookup, now: () => LATER, getSetting }).acquireSource('s1', { kind: 'scheduled' }, undefined)

  expect(count(raw, 'deliveries_v2')).toBe(1) // same delivery, not re-created
  expect(count(raw, 'observation_versions_v2')).toBe(1) // the edit overwrites the same row, not a new one
  const row = raw.prepare(`SELECT id, canonical_material FROM observation_versions_v2`).get() as { id: string; canonical_material: Buffer }
  expect(row.id).toBe(first.id)
  expect(Buffer.from(row.canonical_material).toString()).toContain('v2')
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

// One version + one presentation entry per delivery (phase B). A real content
// change re-pends the SAME observation job every poll, so reconcileClaim runs
// repeatedly over the SAME observation_version_id — the exact shape that grew
// the July 2026 observation-version runaway (763k rows). This is the CRITICAL
// review guard (C-B): re-reconciling an overwritten-in-place version must be
// idempotent for publisher_claims_v2/publisher_names_v2 too, or the runaway
// simply reappears on these two tables once the version cap is gone.
test('polling a changing item repeatedly keeps ONE observation version, ONE presentation entry, and ONE publisher claim/name — no churn runaway', async () => {
  const { raw, db } = await fresh()
  const store = createLogicalStore(db)
  seedSource(raw, 's1', 'https://feed.test/f')
  let body = ''
  const fetchFn = fakeFetch({ 'https://feed.test/f': () => ok(RSS(guidItem('g1', false, body))) })

  for (let i = 0; i < 5; i++) {
    body = `body-${i}`
    const now = `2026-07-23T00:0${i}:00.000Z`
    const eng = createAcquisition({ db, fetchFn, lookupFn: publicLookup, now: () => now })
    await eng.acquireSource('s1', { kind: 'scheduled' }, undefined)
    drainReconciliation({ store, now: () => now })
  }

  expect(count(raw, 'observation_versions_v2')).toBe(1)
  expect(count(raw, 'presentation_entries_v2')).toBe(1)
  // CRITICAL (review C-B): must stay 1 each across all 5 change-polls.
  expect(count(raw, 'publisher_claims_v2')).toBe(1)
  expect(count(raw, 'publisher_names_v2')).toBe(1)

  // The presentation entry's display time tracks the LATEST change, not the
  // frozen first-arrival instant (I2: arrival_at/run_id stay frozen, but the
  // display time lives in effective_updated_at).
  const pe = raw.prepare(`SELECT effective_updated_at FROM presentation_entries_v2`).get() as { effective_updated_at: string | null }
  expect(pe.effective_updated_at).toBe('2026-07-23T00:04:00.000Z')

  const env = db.read((tx) => projectTimeline(tx, { lens: { kind: 'public' }, before: null, limit: 10, viewer: { localAccountId: null, activeSourceIds: [] } }))
  expect(env.timeline).toHaveLength(1) // one logical item throughout — no duplicate/fork
  expect(env.timeline[0].selectedAuthor.displayName).toBe('T')
})

test('source:markdown never enters the fingerprint', () => {
  const item = `<item><guid>https://x.example/1</guid><link>https://x.example/1</link><description>body</description>`
  const without = parseCandidates(RSS(item + `</item>`))
  const with_ = parseCandidates(RSS(item + `<source:markdown>**body**</source:markdown></item>`))
  // The 2026-07-25 runaway (763k observation_versions, 2.6GB) was volatile fields
  // in the fingerprint. Markdown rides normalized_json and must never change it.
  expect(with_.candidates[0].fingerprint).toBe(without.candidates[0].fingerprint)
  expect(JSON.parse(with_.candidates[0].normalizedJson).contentMarkdown).toBe('**body**')
  expect(JSON.parse(without.candidates[0].normalizedJson).contentMarkdown ?? null).toBe(null)
})

test('an oversized source:markdown is dropped, not stored whole', () => {
  const item = `<item><guid>https://x.example/2</guid><link>https://x.example/2</link><description>d</description>`
  const oversized = 'x'.repeat(1024 * 1024 + 1) // over BOUNDS.maxItemEvidenceBytes (1 MiB)
  const huge = parseCandidates(RSS(item + `<source:markdown>${oversized}</source:markdown></item>`))
  expect(JSON.parse(huge.candidates[0].normalizedJson).contentMarkdown).toBe(null)
  // A normal-sized value is unaffected by the same code path.
  const normal = parseCandidates(RSS(item + `<source:markdown>**body**</source:markdown></item>`))
  expect(JSON.parse(normal.candidates[0].normalizedJson).contentMarkdown).toBe('**body**')
})
