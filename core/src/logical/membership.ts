import type Database from 'better-sqlite3'
import type { RemoteSourceV2Row } from '../storage/sqlite.ts'
import { encodeCursor, clampLimit, type Cursor } from '../domain/source-repository.ts'
type Db = InstanceType<typeof Database>

// ONE membership definition (spec rev 3 §Decided model), shared verbatim by
// the cascade, the mint rule, the admin member reads, and the heal.
// ponytail: http and https on one host do NOT group — split membership.
export function instancePrefix(canonicalUrl: string): string | null {
  try {
    const u = new URL(canonicalUrl)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return `${u.protocol}//${u.host}/`
  } catch { return null }
}

export function prefixUpperBound(prefix: string): string {
  return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
}

export interface ApprovedInstance { id: string; canonicalUrl: string; governance: string; createdAt: string }

export function approvedInstanceFor(raw: Db, memberUrl: string): ApprovedInstance | null {
  const prefix = instancePrefix(memberUrl)
  if (!prefix) return null
  const rows = raw.prepare(
    `SELECT s.id, s.canonical_url, s.governance, s.created_at FROM remote_sources_v2 s
     JOIN federation_relationships_v2 f ON f.source_id = s.id AND f.status = 'approved'
     WHERE s.canonical_url >= ? AND s.canonical_url < ?
     ORDER BY s.created_at ASC, s.id ASC`,
  ).all(prefix, prefixUpperBound(prefix)) as { id: string; canonical_url: string; governance: string; created_at: string }[]
  if (rows.length === 0) return null
  const pick = rows.find((r) => r.governance === 'blocked') ?? rows[0] // block is absolute
  return { id: pick.id, canonicalUrl: pick.canonical_url, governance: pick.governance, createdAt: pick.created_at }
}

// The distinct prefixes of every approved-federated instance — the ONE place
// the member prefix set is derived. Both consumers below build their own SQL
// around it (they mean different things by "member"), but neither re-derives
// the set: sqlite.ts's memberExclusionClause protects members from orphan
// reaping, store.ts's schedulability predicate decides which get polled.
//
// `activeOnly` is what separates them. Reaping asks "does an instance govern
// this row at all?", so a blocked or paused instance still counts — matching
// approvedInstanceFor above, which deliberately PREFERS a blocked instance.
// Scheduling asks "are we actively exchanging with it?", where blocked and
// paused must both stop traffic: an instance is one feed, its members are as
// many as it has authors, so continuing to poll them through a pause would
// hit the peer harder than not pausing at all.
export function approvedInstancePrefixes(raw: Db, opts: { activeOnly?: boolean } = {}): string[] {
  const rows = raw.prepare(
    `SELECT s.canonical_url FROM remote_sources_v2 s
     JOIN federation_relationships_v2 f ON f.source_id = s.id AND f.status = 'approved'
     ${opts.activeOnly ? `WHERE s.governance != 'blocked' AND s.operation = 'enabled'` : ''}`,
  ).all() as { canonical_url: string }[]
  const prefixes = new Set<string>()
  for (const r of rows) {
    const p = instancePrefix(r.canonical_url)
    if (p) prefixes.add(p)
  }
  return [...prefixes].sort()
}

// The shared range fragment (F7/PT7): both memberRows and memberRowsPage
// build their WHERE clause from this constant, and the EXPLAIN plan test
// asserts against it directly — a hand-retyped copy in the test could drift
// silently from the real query and still pass.
//
// 2026-07-28 F14 amendment (whole-branch review, core-side close): a row
// that is itself currently approved-federated governs itself — it is never
// treated as a member, even when another approved instance's prefix happens
// to cover it (establishFederation/transition('approve') can approve
// federation directly on an origin_verification-provenanced row). Mirrors
// the client predicate already in web's +page.server.ts isInstanceMember.
// The NOT EXISTS is correlated against the outer remote_sources_v2 row —
// no new bound parameter, so no call site's argument list changes.
export const MEMBER_RANGE_SQL = `canonical_url >= ? AND canonical_url < ? AND provenance = 'origin_verification' AND id != ?
  AND NOT EXISTS (SELECT 1 FROM federation_relationships_v2 f WHERE f.source_id = remote_sources_v2.id AND f.status = 'approved')`

export function memberRows(raw: Db, instance: { id: string; canonical_url: string }): { id: string; governance: string; operation: string; overridden: 0 | 1 }[] {
  const prefix = instancePrefix(instance.canonical_url)
  if (!prefix) return []
  return raw.prepare(
    `SELECT id, governance, operation, overridden FROM remote_sources_v2 WHERE ${MEMBER_RANGE_SQL} ORDER BY canonical_url ASC`,
  ).all(prefix, prefixUpperBound(prefix), instance.id) as { id: string; governance: string; operation: string; overridden: 0 | 1 }[]
}

function isApprovedFederatedInstance(raw: Db, instanceId: string): boolean {
  return !!raw.prepare(`SELECT 1 FROM federation_relationships_v2 WHERE source_id = ? AND status = 'approved'`).get(instanceId)
}

// F2: admin reads of an id's members are gated on that id CURRENTLY holding
// an approved federation relationship — an arbitrary/non-instance/no-longer-
// federated id returns an empty page/counts, never a 404 (same posture as
// the sibling :id/subscriptions and :id/audit reads).
export function memberRowsPage(raw: Db, instance: { id: string; canonical_url: string }, cursor: Cursor | undefined, limit: number): { rows: RemoteSourceV2Row[]; nextCursor: string | null } {
  if (!isApprovedFederatedInstance(raw, instance.id)) return { rows: [], nextCursor: null }
  const prefix = instancePrefix(instance.canonical_url)
  if (!prefix) return { rows: [], nextCursor: null }
  const upper = prefixUpperBound(prefix)
  const lim = clampLimit(limit)
  const rows = (cursor
    ? raw.prepare(
        `SELECT * FROM remote_sources_v2 WHERE ${MEMBER_RANGE_SQL}
           AND ((created_at < ?) OR (created_at = ? AND id < ?))
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      ).all(prefix, upper, instance.id, cursor.createdAt, cursor.createdAt, cursor.id, lim + 1)
    : raw.prepare(
        `SELECT * FROM remote_sources_v2 WHERE ${MEMBER_RANGE_SQL} ORDER BY created_at DESC, id DESC LIMIT ?`,
      ).all(prefix, upper, instance.id, lim + 1)
  ) as RemoteSourceV2Row[]
  const page = rows.length > lim ? rows.slice(0, lim) : rows
  const nextCursor = rows.length > lim ? encodeCursor({ createdAt: page[lim - 1].created_at, id: page[lim - 1].id }) : null
  return { rows: page, nextCursor }
}

export function memberCounts(raw: Db, instance: { id: string; canonical_url: string }): { members: number; overridden: number } {
  if (!isApprovedFederatedInstance(raw, instance.id)) return { members: 0, overridden: 0 }
  const prefix = instancePrefix(instance.canonical_url)
  if (!prefix) return { members: 0, overridden: 0 }
  const row = raw.prepare(
    `SELECT COUNT(*) AS members, SUM(overridden) AS overridden FROM remote_sources_v2 WHERE ${MEMBER_RANGE_SQL}`,
  ).get(prefix, prefixUpperBound(prefix), instance.id) as { members: number; overridden: number | null }
  return { members: row.members, overridden: row.overridden ?? 0 }
}

// PT16/PT17/F5: the migration-19 one-time heal. Self-contained transaction —
// atomic even if the process dies mid-heal, unlike a heal left to run
// unwrapped after migrate()'s own per-migration transaction closes.
export function healMembers(raw: Db): void {
  raw.transaction(() => {
    raw.prepare(`UPDATE remote_sources_v2 SET overridden = 0 WHERE provenance = 'origin_verification'`).run()
    const instances = raw.prepare(
      `SELECT s.id, s.canonical_url, s.governance FROM remote_sources_v2 s
       JOIN federation_relationships_v2 f ON f.source_id = s.id AND f.status = 'approved'
       WHERE s.governance != 'blocked' ORDER BY s.created_at ASC, s.id ASC`,
    ).all() as { id: string; canonical_url: string; governance: string }[]
    const healed = new Set<string>()
    for (const inst of instances) {
      for (const m of memberRows(raw, { id: inst.id, canonical_url: inst.canonical_url })) {
        if (healed.has(m.id)) continue // deterministic: earliest instance wins
        healed.add(m.id)
        if (m.governance !== inst.governance) raw.prepare(`UPDATE remote_sources_v2 SET governance = ? WHERE id = ?`).run(inst.governance, m.id)
      }
    }
  })()
}
