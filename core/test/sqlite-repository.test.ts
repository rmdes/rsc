import { test, expect } from 'vitest'
import { runRepositoryContract } from '../src/domain/repository-contract.ts'
import { createSqliteRepository } from '../src/storage/sqlite.ts'

runRepositoryContract(() => createSqliteRepository(':memory:'))

test('auth link surface: getUserByAuthUserId / setAuthUserId', async () => {
  const repo = await createSqliteRepository(':memory:')
  const u = await repo.createLocalUser({ handle: 'guest-abc12', displayName: 'guest-abc12', authUserId: 'anon-1' })
  expect((await repo.getUserByAuthUserId('anon-1'))?.id).toBe(u.id)
  expect(await repo.getUserByAuthUserId('nope')).toBeUndefined()

  await repo.setAuthUserId(u.id, 'perm-1')
  expect((await repo.getUserByAuthUserId('perm-1'))?.id).toBe(u.id)
  expect(await repo.getUserByAuthUserId('anon-1')).toBeUndefined()
})
