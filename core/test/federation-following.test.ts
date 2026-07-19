import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'
import { makeAuth, registeredSession } from './auth-helper.ts'

async function instance(publicUrl: string | null) {
  const repo = await createSqliteRepository(':memory:')
  const service = createService(repo, createEventBus())
  const app = createApp({ service, bus: createEventBus(), token: 'secret', auth: makeAuth(repo), users: repo, feeds: { publicUrl, hubUrl: null, rssCloud: false } })
  return { repo, service, app }
}

// OPML round-trip does a full export→import→re-follow cycle; slowest test in the
// suite. Passes in ~1.8s isolated but tips over vitest's 5s default under
// full-suite CPU contention — give it headroom rather than flake the whole run.
test('OPML round-trip: instance 1 export → instance 2 import recreates remote follows', { timeout: 15000 }, async () => {
  const one = await instance('https://one.example')
  const aliceCookie = await registeredSession(one.app, 'alice@test.example', one.repo)
  await one.app.request('/me', { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: aliceCookie }, body: JSON.stringify({ handle: 'alice', displayName: 'Alice' }) })
  await one.service.addRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
  await one.service.addRemoteUser({ handle: 'blog', displayName: 'Blog', feedUrl: 'https://ex.com/b.xml' })
  await one.app.request('/me/follows', { method: 'POST', headers: { 'content-type': 'application/json', cookie: aliceCookie }, body: JSON.stringify({ handle: 'news' }) })
  await one.app.request('/me/follows', { method: 'POST', headers: { 'content-type': 'application/json', cookie: aliceCookie }, body: JSON.stringify({ handle: 'blog' }) })

  const opml = await (await one.app.request('/users/alice/following.opml')).text()

  const two = await instance('https://two.example')
  const importerCookie = await registeredSession(two.app, 'importer@test.example', two.repo)
  await two.app.request('/me', { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: importerCookie }, body: JSON.stringify({ handle: 'importer', displayName: 'Importer' }) })
  const res = await two.app.request('/me/follows/opml', { method: 'POST', headers: { cookie: importerCookie }, body: opml })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ followed: 2, created: 2, skipped: 0 })

  const list = await (await two.app.request('/users/importer/follows')).json()
  expect(list.following.map((u: { feedUrl: string }) => u.feedUrl).sort()).toEqual(['https://ex.com/b.xml', 'https://ex.com/f.xml'])
})
