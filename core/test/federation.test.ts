import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'
import { ingestRemoteUser } from '../src/domain/ingest.ts'
import { makeAuth } from './auth-helper.ts'

// The primary feedUrl fetch is now SSRF-guarded (checkCallbackUrl); default real
// DNS won't resolve the fake a.example host used across this bridge, so inject
// a fake public-IP lookup (mirrors push-in.test.ts / push.test.ts).
const publicLookup = async () => [{ address: '93.184.216.34' }]

test('the loop closes: instance B ingests instance A user as a remote over plain RSS', async () => {
  // Instance A: emits alice's feed
  const repoA = await createSqliteRepository(':memory:')
  const busA = createEventBus()
  // Instance A's local posts mint their permalink guid (service.ts: url =
  // `${publicUrl}/post/${id}` when createService gets a publicUrl) — matching
  // A's own feed context below, so this test exercises the milestone's actual
  // cross-instance permalink-guid loop, not the legacy url-less shape.
  const serviceA = createService(repoA, busA, 'http://a.example')
  const appA = createApp({ service: serviceA, bus: busA, token: 'a', auth: makeAuth(repoA), users: repoA, feeds: { publicUrl: 'http://a.example', hubUrl: null, rssCloud: false } })
  await serviceA.createLocalPostAs('alice', 'Alice', 'hello from instance A — ünïcode ✓')
  await serviceA.createLocalPostAs('alice', 'Alice', 'second transmission')

  // Instance B: ingests A's feed URL through the normal remote-user path
  const repoB = await createSqliteRepository(':memory:')
  const busB = createEventBus()
  const serviceB = createService(repoB, busB)
  const aliceAtB = await serviceB.addRemoteUser({ handle: 'alice-a', displayName: 'Alice (A)', feedUrl: 'http://a.example/users/alice/feed.xml' })

  const bridge = (async (url: string | URL | Request) => appA.request(String(url).replace('http://a.example', ''))) as unknown as typeof fetch
  const r = await ingestRemoteUser(repoB, busB, aliceAtB, bridge, publicLookup)
  expect(r.inserted).toBe(2)

  const timeline = await repoB.getTimeline(10)
  const contents = timeline.map((e) => e.content)
  expect(contents).toContain('<p>hello from instance A — ünïcode ✓</p>') // local post → rendered HTML on the wire (dual contract)
  expect(timeline.every((e) => e.source === 'remote')).toBe(true)
  expect(timeline[0].author.handle).toBe('alice-a')

  // permalinks survive the wire: A's posts are url-bearing, so the EMITTED
  // guid (the permalink, not A's internal opaque UUID) becomes B's stored
  // guid — this is the walkable-feeds cross-instance loop under permalink guids.
  const aUrls = (await repoA.getTimeline(10)).map((e) => e.url).sort()
  const bGuids = timeline.map((e) => e.guid).sort()
  expect(bGuids).toEqual(aUrls)
  expect(bGuids.every((g) => g?.startsWith('http://a.example/post/'))).toBe(true)

  // idempotent re-ingest — the poller can hit A forever without duplicating
  expect((await ingestRemoteUser(repoB, busB, aliceAtB, bridge, publicLookup)).inserted).toBe(0)
})
