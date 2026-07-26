import { test, expect } from 'vitest'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import type { Repository } from '../src/domain/repository.ts'
import type { User } from '../src/domain/types.ts'

// v1 subscribeByUrl and its five tests were deleted with the v1 path (V4 Task
// 11); SourceService.subscribeByUrl is covered by source-subscribe.test.ts.
// What survives here is service.addFollow's exclusion guard.

test('addFollow refuses self-follow and instance targets, minting nothing', async () => {
  const follows: Array<[string, string]> = []
  const repo = { addFollow: async (a: string, b: string) => { follows.push([a, b]) } } as unknown as Repository
  const svc = createService(repo, createEventBus())
  const alice: User = { id: 'alice-id', kind: 'local', handle: 'alice', displayName: 'Alice', feedUrl: null, createdAt: '2026-01-01T00:00:00.000Z', authUserId: null }
  const peer: User = { id: 'inst-id', kind: 'remote', handle: 'peer', displayName: 'Peer', feedUrl: 'https://p.example/f.xml', createdAt: '2026-01-01T00:00:00.000Z', authUserId: null, feedType: 'instance' }
  expect(await svc.addFollow(alice, alice)).toBe(false)
  expect(await svc.addFollow(alice, peer)).toBe(false)
  expect(follows).toEqual([])
  const person: User = { ...peer, id: 'p2', handle: 'p2', feedType: 'person' }
  expect(await svc.addFollow(alice, person)).toBe(true)
  expect(follows).toEqual([['alice-id', 'p2']])
})
