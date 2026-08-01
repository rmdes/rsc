import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { createApp } from '../src/api/app.ts'
import { makeAuth, anonSession, registeredSession } from './auth-helper.ts'

async function makeApp(adminEmails: string[] = ['boss@x.test']) {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  const service = createService(repo, bus, null, store)
  const app = createApp({
    service, bus, token: 'secret', auth: makeAuth(repo), users: repo,
    adminEmails: new Set(adminEmails), mailEnabled: true,
    feeds: { publicUrl: 'https://x.test', hubUrl: null, rssCloud: true },
    websub: 'self', pushIn: true,
    sources: { service: createSourceService(repo, null), repo },
    logical: { store, acquisition: createAcquisition({ db }) },
  })
  return { app, repo }
}

// TAB KEYS are the cross-workspace contract — hardcoded here on purpose.
const KEYS = ['local', 'federated', 'personal', 'public'] as const

test('GET /instance/config returns mailEnabled and null tab overrides by default', async () => {
  const { app } = await makeApp()
  const res = await app.request('/instance/config')
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.mailEnabled).toBe(true)
  for (const k of KEYS) {
    expect(body.tabs.labels[k]).toBeNull()
    expect(body.tabs.subtitles[k]).toBeNull()
  }
})

test('GET /instance/config echoes a stored override', async () => {
  const { app, repo } = await makeApp()
  await repo.setSetting('tab_label_personal', 'My feed')
  const res = await app.request('/instance/config')
  const body = await res.json()
  expect(body.tabs.labels.personal).toBe('My feed')
  expect(body.tabs.labels.local).toBeNull()
})

test('GET /health is a bare probe with no mailEnabled', async () => {
  const { app } = await makeApp()
  const res = await app.request('/health')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
})
