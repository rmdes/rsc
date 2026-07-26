import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { activateLogicalV2 } from '../src/logical/runtime.ts'
import { createLogicalStore } from '../src/logical/store.ts'

// Regression guard for V4 Task 11/13 (§H, retiring most of migration/convert.ts):
// runtime.ts's convertLegacy is NOT dead code — it runs unconditionally on the
// never_activated branch, which is the path a brand-new install's very first
// boot takes (zero legacy rows to convert, but the machinery still runs). This
// test must stay green through the migration-machinery retirement.
test('a brand-new database activates v2 on first boot and serves a post', async () => {
  const repo = await createSqliteRepository(':memory:')
  const db = createDatabaseContext(repo.raw)
  const now = new Date().toISOString()

  // Simulates server.ts's boot sequence for a fresh install: never_activated,
  // zero legacy rows, no manifest — activateLogicalV2 must run convertLegacy
  // (loadManifest/runPreflight/runConversion) trivially over zero rows, then
  // activate.
  activateLogicalV2(db, now)

  const activation = db.read((tx) =>
    tx.prepare(`SELECT state FROM logical_activation_v2 WHERE singleton = 1`).get()
  ) as { state: string }
  expect(activation.state).toBe('active')

  // A fresh instance must actually be able to create and read a post through
  // the v2 path immediately after activation — not just report `active`.
  // This is the same call service.ts's v2 branch makes (createLocalPostAs).
  const author = await repo.createLocalUser({ handle: 'first', displayName: 'First' })
  const store = createLogicalStore(db)
  const dto = store.createLocalPost({ author, content: 'hello, fresh install', replyToId: null, now })
  expect(dto.id).toBeTruthy()

  const stored = await repo.getPost(dto.id)
  expect(stored?.content).toBe('hello, fresh install')
})
