import type { DatabaseContext, ReadTx } from './database.ts'
import type { LogicalReadTx, SourceModelV2Activation } from './types.ts'
import { getJournalMetadata } from './journal.ts'

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

export function createLogicalStore(db: DatabaseContext) {
  return {
    snapshot<T>(fn: (tx: ReadSeam) => T): T {
      return db.read((tx) => fn(makeReadTx(tx)))
    },
  }
}
