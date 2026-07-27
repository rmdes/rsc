import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { createApp } from '../src/api/app.ts'
import { runSmoke } from '../src/smoke.ts'
import { makeAuth } from './auth-helper.ts'

test('smoke: anonymous sign-in, post, /me, and ops-token federation seeding all work end to end', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  const service = createService(repo, bus, null, store)
  const app = createApp({
    service, bus, token: 'secret', auth: makeAuth(repo), users: repo,
    sources: { service: createSourceService(repo, null), repo },
    logical: { store, acquisition: createAcquisition({ db }) },
  })

  await runSmoke(app, 'secret', 'http://web.test')

  // establishFederation inserts federation_relationships_v2 with status
  // 'approved' directly, so the new source is immediately visible here — the
  // same method GET /peers' v2 arm uses (app.ts).
  const approved = await repo.listApprovedFederationSources()
  expect(approved.some((s) => s.canonicalUrl === 'https://203.0.113.199/feed.xml')).toBe(true)
})
