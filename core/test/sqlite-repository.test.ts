import { test, expect } from 'vitest'
import { runRepositoryContract } from '../src/domain/repository-contract.ts'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { HandleTakenError } from '../src/domain/types.ts'

runRepositoryContract(() => createSqliteRepository(':memory:'))

test('auth link surface: getUserByAuthUserId / setAuthUserId / updateUserProfile', async () => {
  const repo = await createSqliteRepository(':memory:')
  const u = await repo.createLocalUser({ handle: 'guest-abc12', displayName: 'guest-abc12', authUserId: 'anon-1' })
  expect((await repo.getUserByAuthUserId('anon-1'))?.id).toBe(u.id)
  expect(await repo.getUserByAuthUserId('nope')).toBeUndefined()

  await repo.setAuthUserId(u.id, 'perm-1')
  expect((await repo.getUserByAuthUserId('perm-1'))?.id).toBe(u.id)
  expect(await repo.getUserByAuthUserId('anon-1')).toBeUndefined()

  const renamed = await repo.updateUserProfile(u.id, { handle: 'ricardo', displayName: 'Ricardo' })
  expect(renamed.handle).toBe('ricardo')
  expect(renamed.displayName).toBe('Ricardo')
  expect(renamed.authUserId).toBe('perm-1')

  await repo.createLocalUser({ handle: 'taken', displayName: 'taken' })
  await expect(repo.updateUserProfile(u.id, { handle: 'taken' })).rejects.toThrow(HandleTakenError)
})
