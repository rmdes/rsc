import type { ReadTx } from './database.ts'

// The derived root of the chain ending at `id` (inclusive) — the topmost
// ancestor. Roots are derived, never stored authority (spec §4.1).
//
// Formerly three hand-duplicated copies (local.ts, runtime.ts, store.ts as
// adminDeriveRoot) — staged-path isolation during the v1/v2 verticals
// forbade a shared import; that reason ended with V4 Task 11. `ReadTx` and
// `WriteTx` are the same type alias (database.ts), so a `WriteTx` argument
// (local.ts's former call sites) is assignable where `ReadTx` is expected —
// one signature serves all three former callers.
//
// projector.ts's remoteThreadRoot is a DIFFERENT parent-chain walk,
// deliberately NOT folded in here: it stops at the first non-`resolved`
// parent_state, so it must NOT agree with this one.
export function deriveRoot(tx: ReadTx, id: string): string {
  const parentOf = tx.prepare(`SELECT parent_logical_item_id FROM logical_items_v2 WHERE id = ?`)
  let root = id
  let cur: string | null = id
  for (let i = 0; i < 1000 && cur; i++) {
    root = cur
    const row = parentOf.get(cur) as { parent_logical_item_id: string | null } | undefined
    cur = row ? row.parent_logical_item_id : null
  }
  return root
}

// Normalize a permalink: http(s) only, lowercase scheme+host (URL does the
// host), strip the fragment. Path/query case is preserved (opaque to us).
//
// Formerly two hand-duplicated copies (acquisition.ts, reconcile.ts) —
// reconcile's accepted `string | null`; acquisition's callers already guard
// on truthiness, so the wider signature is adopted as the one shared copy.
export function normalizePermalink(raw: string | null): string | null {
  if (!raw) return null
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    u.hash = ''
    return u.toString()
  } catch {
    return null
  }
}
