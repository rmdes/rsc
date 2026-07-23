import type { DatabaseContext, ReadTx } from './database.ts'
import type { LogicalReadTx, SourceModelV2Activation, LogicalItemDto } from './types.ts'
import type { User } from '../domain/types.ts'
import { getJournalMetadata } from './journal.ts'
import { createLocalPost, editLocalPost, deleteLocalPost, deleteLocalAccount } from './local.ts'

// Bounded transactional reads/writes over the logical-v2 schema (plan File map,
// VP6: the concrete factory is exported and TS infers its type — no LogicalStore
// interface). Task 2 realizes only the read seam's activation + journal-metadata
// reads; later tasks widen both the snapshot callback shape and the store's
// write methods (claimAcquisition, commitAcquisition, reconcileClaim, …).

// The subset of LogicalReadTx Task 2 implements. Later tasks broaden this Pick.
type ReadSeam = Pick<LogicalReadTx, 'getActivation' | 'getJournalMetadata'>

function makeReadTx(tx: ReadTx): ReadSeam {
  return {
    getActivation(): SourceModelV2Activation {
      const row = tx.prepare(
        `SELECT schema_version, state, last_activated_at, last_reconciled_at
         FROM logical_activation_v2 WHERE singleton = 1`,
      ).get() as { schema_version: 1; state: SourceModelV2Activation['state']; last_activated_at: string | null; last_reconciled_at: string | null }
      return {
        schemaVersion: row.schema_version,
        state: row.state,
        lastActivatedAt: row.last_activated_at,
        lastReconciledAt: row.last_reconciled_at,
      }
    },
    getJournalMetadata: () => getJournalMetadata(tx),
  }
}

// The local-mutation write seam (Task 3): each command runs inside ONE db.write()
// so local storage, logical metadata, and journal effects commit atomically (spec
// §2.6). service.ts routes v2-on local mutations here; later tasks widen the store
// with acquisition/reconciliation write methods.
export function createLogicalStore(db: DatabaseContext) {
  return {
    snapshot<T>(fn: (tx: ReadSeam) => T): T {
      return db.read((tx) => fn(makeReadTx(tx)))
    },
    createLocalPost(input: { author: User; content: string; replyToId: string | null; now: string }): LogicalItemDto {
      return db.write((tx) => createLocalPost({ tx, ...input }))
    },
    editLocalPost(input: { postId: string; authorId: string; content: string; now: string }): LogicalItemDto {
      return db.write((tx) => editLocalPost({ tx, ...input }))
    },
    deleteLocalPost(input: { postId: string; actorId: string; now: string }): void {
      db.write((tx) => deleteLocalPost({ tx, ...input }))
    },
    deleteLocalAccount(input: { accountId: string; actorId: string; now: string }): void {
      db.write((tx) => deleteLocalAccount({ tx, ...input }))
    },
  }
}

export type LogicalStore = ReturnType<typeof createLogicalStore>
