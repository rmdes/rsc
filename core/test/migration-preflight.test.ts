import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { loadManifest, runPreflight, type Manifest, type ManifestEntry } from '../src/migration/preflight.ts'

// V4 Task 4 — preflight is READ-ONLY by construction: it reads legacy `users`
// and `handle_reservations_v2` and returns findings. Every finding is an abort:
// the operator corrects the legacy rows and reruns (spec §2.1). loadManifest
// throws named diagnostics (it is the loader); runPreflight returns findings
// (it is the checker).

type Raw = InstanceType<typeof Database>
const NOW = '2026-07-24T00:00:00.000Z'

async function fresh(): Promise<Raw> {
  const repo = await createSqliteRepository(':memory:')
  return repo.raw as Raw
}

const USER_COLS = `id, kind, handle, display_name, feed_url, created_at, feed_type`
function seedRemote(raw: Raw, over: Record<string, string | null> = {}): void {
  const row = {
    id: 'u1', kind: 'remote', handle: 'alice', display_name: 'Alice',
    feed_url: 'https://a.test/feed.xml', created_at: NOW, feed_type: 'webfeed', ...over,
  }
  raw.prepare(
    `INSERT INTO users (${USER_COLS}) VALUES (@id, @kind, @handle, @display_name, @feed_url, @created_at, @feed_type)`,
  ).run(row)
}
function seedLocal(raw: Raw, id = 'l1', handle = 'local'): void {
  raw.prepare(
    `INSERT INTO users (${USER_COLS}) VALUES (?, 'local', ?, 'Local', NULL, ?, NULL)`,
  ).run(id, handle, NOW)
}
function seedReservation(raw: Raw, handle: string): void {
  raw.prepare(
    `INSERT INTO handle_reservations_v2 (handle, source_id, publisher_id, created_at) VALUES (?, 's-old', 'p-old', ?)`,
  ).run(handle, NOW)
}
function seedExistingSource(raw: Raw, canonicalUrl: string): void {
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES ('s-old', ?, 'single_publisher', 'enabled', 'allowed', 'migration', NULL, 0, ?)`,
  ).run(canonicalUrl, NOW)
}
const manifest = (entries: Partial<ManifestEntry>[]): Manifest => ({
  schemaVersion: 1,
  entries: entries.map((e) => ({ sourceId: 'u1', feedUrl: 'https://a.test/feed.xml', attributionMode: 'aggregate', note: 'approved by ops', ...e })),
})
function withTempFile<T>(name: string, body: string | null, fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'rsc-preflight-'))
  try {
    const path = join(dir, name)
    if (body !== null) writeFileSync(path, body)
    return fn(path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- clean sets -------------------------------------------------------------

test('a zero-row database is clean', async () => {
  expect(runPreflight(await fresh(), null)).toEqual([])
})

test('a clean legacy set — person, webfeed, instance and local rows — is clean with no manifest', async () => {
  const raw = await fresh()
  seedLocal(raw)
  seedRemote(raw, { id: 'u1', handle: 'alice', feed_url: 'https://a.test/feed.xml', feed_type: 'person' })
  seedRemote(raw, { id: 'u2', handle: 'bob', feed_url: 'http://b.test:8080/rss?x=1', feed_type: 'webfeed' })
  seedRemote(raw, { id: 'u3', handle: 'peer', feed_url: 'https://peer.test/feed/', feed_type: 'instance' })
  expect(runPreflight(raw, null)).toEqual([])
})

// --- URL abort classes ------------------------------------------------------

const BAD_URLS: { name: string; feed_url: string | null }[] = [
  { name: 'missing', feed_url: null },
  { name: 'malformed', feed_url: 'not a url' },
  { name: 'credential-bearing', feed_url: 'https://user:pw@a.test/feed.xml' },
  { name: 'oversized (>2048 chars)', feed_url: `https://a.test/${'x'.repeat(2100)}` },
  { name: 'non-HTTP(S)', feed_url: 'ftp://a.test/feed.xml' },
]

test.each(BAD_URLS)('a $name remote feed URL is an aborting invalid_url finding naming the legacy row', async ({ feed_url }) => {
  const raw = await fresh()
  seedRemote(raw, { id: 'u9', handle: 'broken', feed_url })
  const findings = runPreflight(raw, null)
  expect(findings.map((f) => f.kind)).toEqual(['invalid_url'])
  expect(findings[0]?.detail).toContain('u9')
  expect(findings[0]?.detail).toContain('broken')
})

test('two legacy rows normalizing to the same URL are an aborting url_collision naming both', async () => {
  const raw = await fresh()
  seedRemote(raw, { id: 'u1', handle: 'alice', feed_url: 'https://A.test/feed.xml#top' })
  seedRemote(raw, { id: 'u2', handle: 'bob', feed_url: 'https://a.test:443/feed.xml' })
  const findings = runPreflight(raw, null)
  expect(findings.map((f) => f.kind)).toEqual(['url_collision'])
  expect(findings[0]?.detail).toContain('u1')
  expect(findings[0]?.detail).toContain('u2')
  expect(findings[0]?.detail).toContain('https://a.test/feed.xml')
})

// --- loadManifest: named diagnostics ----------------------------------------

test('no manifest path configured loads null — every instance row takes the unconfirmed default (asserted at conversion)', async () => {
  expect(loadManifest(null)).toBeNull()
  const raw = await fresh()
  seedRemote(raw, { feed_type: 'instance' })
  expect(runPreflight(raw, null)).toEqual([])
})

test('a missing file at a configured path throws a named diagnostic', () => {
  // Pinned to the exact wording loadManifest emits — not just /manifest/i,
  // which the raw Node ENOENT message would also match (it embeds the path,
  // and the path contains "manifest.json"). This must fail if the try/catch
  // at preflight.ts:31-35 is removed and the raw ENOENT propagates instead.
  withTempFile('manifest.json', null, (path) => {
    expect(() => loadManifest(path)).toThrow(`migration manifest not readable at ${path}`)
  })
})

test('a manifest that is not valid JSON throws a named diagnostic', () => {
  withTempFile('manifest.json', '{ nope', (path) => {
    expect(() => loadManifest(path)).toThrow(/manifest/i)
  })
})

test('a wrong schemaVersion throws a named diagnostic', () => {
  withTempFile('manifest.json', JSON.stringify({ schemaVersion: 2, entries: [] }), (path) => {
    expect(() => loadManifest(path)).toThrow(/schemaVersion/)
  })
})

test('an invalid attributionMode throws a named diagnostic', () => {
  const body = JSON.stringify({ schemaVersion: 1, entries: [{ sourceId: 'u1', feedUrl: 'https://a.test/feed.xml', attributionMode: 'whatever', note: 'n' }] })
  withTempFile('manifest.json', body, (path) => {
    expect(() => loadManifest(path)).toThrow(/attributionMode/)
  })
})

test('a well-formed manifest loads verbatim', () => {
  const doc = manifest([{}])
  withTempFile('manifest.json', JSON.stringify(doc), (path) => {
    expect(loadManifest(path)).toEqual(doc)
  })
})

// --- manifest abort classes (checked against the legacy rows) ---------------

test('a manifest entry matching an instance row by exact ID and exact legacy URL is clean', async () => {
  const raw = await fresh()
  seedRemote(raw, { id: 'u1', feed_url: 'https://peer.test/feed/', feed_type: 'instance' })
  expect(runPreflight(raw, manifest([{ sourceId: 'u1', feedUrl: 'https://peer.test/feed/' }]))).toEqual([])
})

test('an entry keyed by an unknown sourceId is an aborting manifest_unknown_entry', async () => {
  const raw = await fresh()
  seedRemote(raw, { id: 'u1', feed_type: 'instance' })
  const findings = runPreflight(raw, manifest([{ sourceId: 'ghost' }]))
  expect(findings.map((f) => f.kind)).toEqual(['manifest_unknown_entry'])
  expect(findings[0]?.detail).toContain('ghost')
})

test('an entry whose feedUrl differs from the row exact legacy URL is an aborting manifest_mismatch, even when both normalize alike', async () => {
  const raw = await fresh()
  seedRemote(raw, { id: 'u1', feed_url: 'https://peer.test/feed/', feed_type: 'instance' })
  const findings = runPreflight(raw, manifest([{ sourceId: 'u1', feedUrl: 'https://PEER.test/feed/' }]))
  expect(findings.map((f) => f.kind)).toEqual(['manifest_mismatch'])
  expect(findings[0]?.detail).toContain('u1')
})

test('an entry for a non-instance row is an aborting manifest_invalid', async () => {
  const raw = await fresh()
  seedRemote(raw, { id: 'u1', feed_url: 'https://a.test/feed.xml', feed_type: 'webfeed' })
  const findings = runPreflight(raw, manifest([{ sourceId: 'u1' }]))
  expect(findings.map((f) => f.kind)).toEqual(['manifest_invalid'])
  expect(findings[0]?.detail).toContain('u1')
})

test('duplicate entries for one sourceId are an aborting manifest_duplicate', async () => {
  const raw = await fresh()
  seedRemote(raw, { id: 'u1', feed_url: 'https://peer.test/feed/', feed_type: 'instance' })
  const entry = { sourceId: 'u1', feedUrl: 'https://peer.test/feed/' }
  const findings = runPreflight(raw, manifest([entry, entry]))
  expect(findings.map((f) => f.kind)).toEqual(['manifest_duplicate'])
  expect(findings[0]?.detail).toContain('u1')
})

// --- reservation abort class -----------------------------------------------

test('a legacy remote handle equal to an existing reservation is an aborting handle_reservation_collision', async () => {
  const raw = await fresh()
  seedRemote(raw, { id: 'u1', handle: 'alice' })
  seedReservation(raw, 'alice')
  const findings = runPreflight(raw, null)
  expect(findings.map((f) => f.kind)).toEqual(['handle_reservation_collision'])
  expect(findings[0]?.detail).toContain('alice')
})

test('reservations for other handles, and local handles, do not collide', async () => {
  const raw = await fresh()
  seedLocal(raw, 'l1', 'carol')
  seedRemote(raw, { id: 'u1', handle: 'alice' })
  seedReservation(raw, 'carol')
  seedReservation(raw, 'dave')
  expect(runPreflight(raw, null)).toEqual([])
})

// --- existing-source abort class --------------------------------------------
// A stale remote_sources_v2 row left by a hand-repaired or partially-restored
// database (spec §4.1 step 2) — the source-side analogue of the reservation
// check above (handle_reservations_v2 is written by conversion in the same
// transaction as remote_sources_v2, so under the ordinary flip flow the two
// are never inconsistent; both checks guard the same anomaly class).

test('a legacy remote feed URL that normalizes to an existing remote_sources_v2.canonical_url is an aborting existing_source_collision', async () => {
  const raw = await fresh()
  seedRemote(raw, { id: 'u1', handle: 'alice', feed_url: 'https://A.test/feed.xml#top' })
  seedExistingSource(raw, 'https://a.test/feed.xml')
  const findings = runPreflight(raw, null)
  expect(findings.map((f) => f.kind)).toEqual(['existing_source_collision'])
  expect(findings[0]?.detail).toContain('u1')
  expect(findings[0]?.detail).toContain('https://a.test/feed.xml')
})

test('an existing remote_sources_v2 row at an unrelated canonical URL does not collide', async () => {
  const raw = await fresh()
  seedRemote(raw, { id: 'u1', handle: 'alice', feed_url: 'https://a.test/feed.xml' })
  seedExistingSource(raw, 'https://other.test/feed.xml')
  expect(runPreflight(raw, null)).toEqual([])
})

// --- READ-ONLY --------------------------------------------------------------

test('runPreflight issues SELECTs only — no exec, no non-SELECT statement (write counter)', async () => {
  const raw = await fresh()
  seedRemote(raw, { id: 'u1', handle: 'alice' })
  seedRemote(raw, { id: 'u2', handle: 'bob', feed_url: 'bogus' })
  seedReservation(raw, 'alice')
  const statements: string[] = []
  let writes = 0
  const counting = new Proxy(raw, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => {
          statements.push(sql)
          if (!/^\s*SELECT\b/i.test(sql)) writes += 1
          return target.prepare(sql)
        }
      }
      if (prop === 'exec' || prop === 'transaction' || prop === 'pragma') {
        return () => { writes += 1; throw new Error(`preflight must not call ${String(prop)}`) }
      }
      return Reflect.get(target, prop, receiver)
    },
  })
  // A non-null manifest so the write-counter also covers the `if (manifest)`
  // branch (preflight.ts:97-119) — a write added inside it must trip this
  // proof too, not just the URL/reservation checks below it.
  const findings = runPreflight(counting, manifest([{}]))
  expect(findings.some((f) => f.kind.startsWith('manifest_'))).toBe(true) // the manifest branch really ran
  expect(findings.length).toBeGreaterThan(0) // the checks really ran
  expect(statements.length).toBeGreaterThan(0)
  expect(writes).toBe(0)
})

test('runPreflight runs against a readonly connection — SQLite itself refuses any write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rsc-preflight-ro-'))
  try {
    const file = join(dir, 'test.db')
    const repo = await createSqliteRepository(file)
    seedRemote(repo.raw as Raw, { id: 'u1', handle: 'alice', feed_url: 'bogus' })
    const readonly = new Database(file, { readonly: true })
    const findings = runPreflight(readonly, null)
    readonly.close()
    expect(findings.map((f) => f.kind)).toEqual(['invalid_url'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
