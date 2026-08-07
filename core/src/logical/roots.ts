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

// The parent's on-the-wire reply reference (v1 parity, service.ts): the string the
// outbound feed emits as <source:inReplyTo>, which a peer instance string-matches to
// the parent's own <guid>. It MUST equal what the parent's feed advertises as its
// guid: a LOCAL parent's guid is its absolute permalink (`url`) or, url-less, its own
// id (logicalToFeedEntry emits guid = dto.id === post.id in the null-url fallback —
// NOT the opaque posts.guid column); a REMOTE parent (logical-only, not in `posts`)
// advertises its canonical permalink identity key.
export function parentReplyRef(tx: ReadTx, parentId: string): string | null {
  const local = tx.prepare(`SELECT url FROM posts WHERE id = ? AND source = 'local'`).get(parentId) as { url: string | null } | undefined
  if (local) return local.url ?? parentId
  // Precedence mirrors v1's `replyTo.url ?? replyTo.guid`: permalink first, then
  // the opaque guid. reconcile stores the opaque key with a publisher-scoped kind
  // but its `key` column IS the bare wire guid (reconcile.ts:322 claims key=v.key),
  // so a peer string-matches it against the parent's own <guid> exactly as under v1.
  const k = tx.prepare(`SELECT key FROM logical_identity_keys_v2 WHERE kind = 'permalink' AND logical_item_id = ? LIMIT 1`).get(parentId) as { key: string } | undefined
  if (k) return k.key
  const o = tx.prepare(`SELECT key FROM logical_identity_keys_v2 WHERE kind LIKE 'opaque:%' AND logical_item_id = ? LIMIT 1`).get(parentId) as { key: string } | undefined
  return o ? o.key : null
}
