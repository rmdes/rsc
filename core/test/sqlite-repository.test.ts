import { runRepositoryContract } from '../src/domain/repository-contract.ts'
import { createSqliteRepository } from '../src/storage/sqlite.ts'

runRepositoryContract(() => createSqliteRepository(':memory:'))
