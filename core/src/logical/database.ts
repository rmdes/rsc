import type BetterSqlite3 from 'better-sqlite3'

// Vertical 1 and Vertical 2 share one SQLite transaction boundary. read()/write()
// are thin wrappers over the sqlite.ts house idiom
// (`raw.transaction(fn).deferred()` / `.immediate()`). A tx IS the raw
// connection — better-sqlite3 has no separate handle — so ReadTx/WriteTx are
// aliases of the database, exactly what the V1 ledger helpers
// (checkCommand/storeCommand/reapSourceIfOrphaned) already accept. A write()
// inside a write() is SAVEPOINT-safe natively; no nesting-rejection machinery
// (rev 4, VP2).
export type ReadTx = BetterSqlite3.Database
export type WriteTx = BetterSqlite3.Database

export interface DatabaseContext {
  raw: BetterSqlite3.Database
  read<T>(fn: (tx: ReadTx) => T): T
  write<T>(fn: (tx: WriteTx) => T): T
}

export function createDatabaseContext(raw: BetterSqlite3.Database): DatabaseContext {
  return {
    raw,
    read: (fn) => raw.transaction(() => fn(raw)).deferred(),
    write: (fn) => raw.transaction(() => fn(raw)).immediate(),
  }
}
