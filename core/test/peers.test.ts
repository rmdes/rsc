import { test, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { createApp } from '../src/api/app.ts'
import { makeAuth } from './auth-helper.ts'

type Raw = InstanceType<typeof Database>

const T = '2026-07-01T00:00:00.000Z'

function insertSource(raw: Raw, id: string, canonicalUrl: string, governance: string): void {
  raw.prepare(
    `INSERT INTO remote_sources_v2
       (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, 'single_publisher', 'enabled', ?, 'user_subscription', NULL, 0, ?)`,
  ).run(id, canonicalUrl, governance, T)
}

function insertFederation(raw: Raw, sourceId: string, status: string): void {
  raw.prepare(
    `INSERT INTO federation_relationships_v2 (source_id, status, provenance_note, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)`,
  ).run(sourceId, status, T, T)
}

test('GET /peers (v2): only allowed sources with an approved federation relationship are returned', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const bus = createEventBus()
  const service = createService(repo, bus, null)
  const app = createApp({
    service, bus, token: 'secret', auth: makeAuth(repo), users: repo,
    sources: { service: createSourceService(repo, null), repo },
  })

  const approved = randomUUID()
  insertSource(raw, approved, 'https://rsschat.andysylvester.com/feed.xml', 'allowed')
  insertFederation(raw, approved, 'approved')

  const allowedNoFed = randomUUID()
  insertSource(raw, allowedNoFed, 'https://allowed-no-fed.example/feed.xml', 'allowed')

  const quarantined = randomUUID()
  insertSource(raw, quarantined, 'https://quarantined.example/feed.xml', 'quarantined')
  insertFederation(raw, quarantined, 'approved')

  const res = await app.request('/peers')
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.peers).toEqual([
    { handle: 'rsschat.andysylvester.com', displayName: 'rsschat.andysylvester.com', feedUrl: 'https://rsschat.andysylvester.com/feed.xml' },
  ])

  repo.close()
})
