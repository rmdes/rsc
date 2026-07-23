import { test, expect, afterEach } from 'vitest'

// TEMPORARY fail-closed guard (Task 2). server.ts throws before it opens a
// listener when RSC_SOURCE_MODEL_V2 is on, because the logical-v2 runtime does
// not exist until Task 10. The guard sits in the server-composition layer only
// (NOT createApp) — so createApp({sources}) route tests are unaffected; those
// never import server.ts. We assert the throw fires during module evaluation,
// which proves it happens before `serve()` is ever reached.

const saved = { ...process.env }
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
  Object.assign(process.env, saved)
})

test('RSC_SOURCE_MODEL_V2=on fails closed before listening', async () => {
  Object.assign(process.env, {
    RSC_TOKEN: 'test-token',
    RSC_AUTH_SECRET: 'test-secret',
    RSC_DB: ':memory:',
    RSC_SOURCE_MODEL_V2: 'on',
  })
  await expect(import('../src/server.ts')).rejects.toThrow('logical-v2 runtime unavailable')
})
