import { test, expect } from 'vitest'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { normalizePermalink as acquisitionNormalizePermalink } from '../src/logical/acquisition.ts'
import { normalizePermalink as reconcileNormalizePermalink } from '../src/logical/reconcile.ts'
import { deriveRoot as localDeriveRoot } from '../src/logical/local.ts'
import { deriveRoot as runtimeDeriveRoot } from '../src/logical/runtime.ts'
import { adminDeriveRoot } from '../src/logical/store.ts'

type Raw = InstanceType<typeof Database>

// ── lockstep drift canary ────────────────────────────────────────────────
// Two helpers are hand-duplicated across the logical layer:
//   normalizePermalink — acquisition.ts + reconcile.ts        (2 copies)
//   deriveRoot         — local.ts + runtime.ts + store.ts     (3 copies,
//                        the store one named adminDeriveRoot)
// The copies are NOT char-identical (differing signatures, param names, a
// null guard) so a textual canary would be noise. What the system actually
// depends on is BEHAVIOURAL equivalence: a verified delivery is presented
// through the same shared path as an acquisition-written one, so their
// presentation fingerprints must match — which silently requires both
// normalizePermalink copies to agree on every input. Likewise a thread root
// must read the same whether derived by the local write path, the runtime
// projection overlay, or the admin store. A rule added to one copy and not
// the others makes unchanged material read as changed.
// This test asserts the copies agree with each other over one shared corpus.
// Do NOT consolidate the copies here; do keep them in lockstep.

// acquisition's copy takes `raw: string`, reconcile's takes `raw: string | null`
// and short-circuits null. Benign: every acquisition call site guards with
// `it.link ? …`, so it is never reached with null. The corpus therefore feeds
// null only to the copy whose signature accepts it, and asserts the guard's
// answer (null) matches what the shared path treats a missing link as.
const PERMALINK_CORPUS = [
  'https://example.com/a#frag',
  'https://example.com/a#',
  'https://example.com/a?#',
  'https://example.com/a?b=1#frag',
  'HTTPS://EXAMPLE.COM/Path',
  'HtTp://Example.COM/',
  'https://example.com:443/a',
  'http://example.com:80/a',
  'https://example.com:8443/a',
  'https://example.com/%7euser',
  'https://example.com/%7Euser',
  'https://example.com/caf%C3%A9',
  'https://example.com/café',
  '  https://example.com/a  ',
  'https://example.com/a b',
  'https://exämple.com/ünïcode',
  'https://example.com/a/./b/../c',
  'https://example.com/../a',
  'https://user:pw@example.com/a',
  'https://example.com',
  'https://example.com/',
  'mailto:someone@example.com',
  'tag:example.com,2026:1',
  'urn:uuid:00000000-0000-0000-0000-000000000000',
  'ftp://example.com/a',
  'javascript:alert(1)',
  'not a url',
  '',
  '/relative/path',
  '//protocol-relative/path',
]

test('normalizePermalink copies agree (acquisition.ts vs reconcile.ts — lockstep canary)', () => {
  for (const raw of PERMALINK_CORPUS) {
    expect(reconcileNormalizePermalink(raw), `input: ${JSON.stringify(raw)}`)
      .toBe(acquisitionNormalizePermalink(raw))
  }
  // The one signature difference, asserted rather than papered over.
  expect(reconcileNormalizePermalink(null)).toBe(null)
})

// Chain fixture, one seeded tree shared by all three deriveRoot copies:
//   root                      — no parent
//   one → root                — one deep
//   d1 → d2 → d3 → deepRoot   — multi deep
//   cycA ↔ cycB               — a cycle (every copy bounds its walk at 1000)
// A dangling parent id is NOT seeded: parent_logical_item_id is FK RESTRICT,
// so it cannot exist. The missing-row branch of the walk is exercised instead
// by deriving from an id that was never seeded ('missing' in the id list).
function seedChain(raw: Raw): void {
  const ins = raw.prepare(
    `INSERT INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, created_at)
     VALUES (?, 'local', '2026-07-24T00:00:00.000Z', ?, ?, NULL, NULL, '2026-07-24T00:00:00.000Z')`,
  )
  const node = (id: string, parent: string | null): void => { ins.run(id, parent ? 'resolved' : 'none', parent) }
  node('root', null)
  node('one', 'root')
  node('deepRoot', null)
  node('d3', 'deepRoot')
  node('d2', 'd3')
  node('d1', 'd2')
  node('cycA', null)
  node('cycB', 'cycA')
  // Close the cycle after both rows exist — the FK permits it, so the walk bound is real.
  raw.prepare(`UPDATE logical_items_v2 SET parent_logical_item_id = 'cycB' WHERE id = 'cycA'`).run()
}

test('deriveRoot copies agree (local.ts vs runtime.ts vs store.ts — lockstep canary)', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  seedChain(raw)

  for (const id of ['root', 'one', 'deepRoot', 'd3', 'd2', 'd1', 'cycA', 'cycB', 'missing']) {
    const local = localDeriveRoot(raw, id)
    expect(runtimeDeriveRoot(raw, id), `input: ${id}`).toBe(local)
    expect(adminDeriveRoot(raw, id), `input: ${id}`).toBe(local)
  }

  // Non-vacuity: the corpus must actually exercise a walk, not just identity.
  expect(localDeriveRoot(raw, 'd1')).toBe('deepRoot')
  expect(localDeriveRoot(raw, 'one')).toBe('root')
})
