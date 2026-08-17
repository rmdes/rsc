import { test, expect } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { drainReconciliation } from '../src/logical/reconcile.ts'
import { createService } from '../src/domain/service.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { createApp } from '../src/api/app.ts'
import { makeAuth, registeredSession } from './auth-helper.ts'
import type { LookupFn } from '../src/domain/push-guard.ts'

type Raw = InstanceType<typeof Database>
const NOW = '2026-07-25T00:00:00.000Z'
const publicLookup: LookupFn = async () => [{ address: '93.184.216.34' }]
const ok = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'application/rss+xml' } })

// A reply to a post that exists ONLY as a v2 logical item (any RSS feed under
// the flag) must be accepted: the v1 posts-table lookup alone rejected every
// such reply with 404 "unknown post" (found dogfooding 2026-07-25).
test('POST /posts accepts a reply whose target is a v2 logical item, and the reply threads onto it', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as Raw
  const db = createDatabaseContext(raw)
  const store = createLogicalStore(db)
  const bus = createEventBus()
  const service = createService(repo, bus, null, store)
  const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title><item><guid isPermaLink="true">https://blog.test/p1</guid><title>t</title><description>hello</description></item></channel></rss>`
  const eng = createAcquisition({
    db,
    fetchFn: (async () => ok(feed)) as unknown as typeof fetch,
    lookupFn: publicLookup,
    now: () => NOW,
  })
  const app = createApp({
    service, bus, token: 't0k3n', auth: makeAuth(repo), users: repo, adminEmails: new Set(),
    sources: { service: createSourceService(repo, null), repo },
    logical: { store, acquisition: eng, now: () => NOW },
  })

  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, 'https://blog.test/feed', 'single_publisher', 'enabled', 'allowed', 'user_subscription', NULL, 0, ?)`,
  ).run('s1', NOW)
  await eng.acquireSource('s1', { kind: 'scheduled' }, undefined)
  drainReconciliation({ store, now: () => NOW })
  const target = raw.prepare(`SELECT logical_item_id id FROM logical_identity_keys_v2 WHERE kind = 'permalink' AND key = 'https://blog.test/p1'`).get() as { id: string }

  const cookie = await registeredSession(app, 'replier@x.test', repo)
  const res = await app.request('/posts', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'good point', inReplyTo: target.id }),
  })
  expect(res.status).toBe(201)
  const { post } = (await res.json()) as { post: { id: string } }
  const reply = raw.prepare(`SELECT parent_state s, parent_logical_item_id p FROM logical_items_v2 WHERE id = ?`).get(post.id) as { s: string; p: string | null }
  expect(reply.s).toBe('resolved')
  expect(reply.p).toBe(target.id)

  // garbage ids still 404 — the check is relaxed only onto visible logical items
  const bad = await app.request('/posts', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'x', inReplyTo: randomUUID() }),
  })
  expect(bad.status).toBe(404)
  repo.close()
})

// removeLocalPost (Task 11) keeps the posts row and overwrites its content with
// a removal notice, so repo.getPost still finds it — a removed post must not
// become repliable again just because the row survives. Existing replies to it
// are untouched (spec: removal is an edit, not a destruction).
test('a removed post is no longer a valid reply target, even though its row survives as a notice', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as Raw
  const db = createDatabaseContext(raw)
  const store = createLogicalStore(db)
  const bus = createEventBus()
  const service = createService(repo, bus, null, store)
  const app = createApp({
    service, bus, token: 't0k3n', auth: makeAuth(repo), users: repo, adminEmails: new Set(),
    sources: { service: createSourceService(repo, null), repo },
    logical: { store, acquisition: createAcquisition({ db, lookupFn: publicLookup, now: () => NOW }) },
  })

  const cookie = await registeredSession(app, 'author@x.test', repo)
  const created = await (await app.request('/posts', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'original' }),
  })).json() as { post: { id: string } }
  const postId = created.post.id

  expect(await service.deletePost(postId, { kind: 'author' })).toEqual({ ok: true })
  // the row is still there — the point of the regression
  expect(await repo.getPost(postId)).toBeDefined()

  const reply = await app.request('/posts', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'too late', inReplyTo: postId }),
  })
  expect(reply.status).toBe(404)
  repo.close()
})
