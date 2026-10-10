import type Database from 'better-sqlite3'
import { randomUUID, createHash } from 'node:crypto'
import type { User, PushProtocol } from '../domain/types.ts'
import type { RemoteSource, SourceSubscription, SourceAuditEvent, Page, SourceSummary, SourceDetail, PushSummary, FederationStatus, OwnerSourceFollow, PublicLocalFollow, PublicSourceFollow, PublicFollowingEntry, OwnerFollowingView, CommandEnvelope, AttributionMode, AuditCategory, FederationRelationship, SourceTransitionResult, SourceSubscriptionState, SourceGovernance, SourceOperation } from '../domain/types.ts'
import type { SourceRepository, Cursor, SubscribeResult, ImportSourcesResult, UnsubscribeResult, EstablishFederationResult, SourceTransitionAction, SourceAxes, ReapCommandResult } from '../domain/source-repository.ts'
import { clampLimit, splitPage, checkCommand, storeCommand, reapSourceIfOrphaned, reapSource as reapSourceFn, SOURCE_TRANSITIONS, CATEGORY_OPTIONAL_ACTIONS } from '../domain/source-repository.ts'
import { appendJournal } from '../logical/journal.ts'
import { scheduleFanout } from '../logical/fanout.ts'
import { memberRows, memberRowsPage, memberCounts, approvedInstanceFor, approvedInstancePrefixes, prefixUpperBound } from '../logical/membership.ts'

// The SourceRepository half of the SQLite persistence layer: remote sources,
// federation, following and transitions. Split out of SqliteRepository
// (storage/sqlite.ts), which holds an instance as `sources` over the SAME
// connection. It touches only the raw better-sqlite3 handle, never Kysely.

// --- V2 logical journal integration (Task 9, spec §3.7) ----------------------
// These source-command methods run whenever the source-control plane is wired
// (server.ts builds `sources` unconditionally), so the journal effects below
// always fire in production. Governance/federation/
// attribution-mode changes advance the SOURCE's policy_generation AND append ONE
// ordinary in-generation reset — this is appendJournal, NOT reconstructJournal:
// the journal's own reset_generation gates SSE cursor validity and must not move
// for a per-source policy change. Active subscription create/remove and local
// follow append a Personal-membership reset WITHOUT advancing generation. Exactly
// ONE reset per command; NO source-wide item fan-out (reads recompute from current
// policy). V3 adds a durable fan-out (policy_fanout_v2) that converges the
// materialized hints: advancePolicyGeneration + scheduleFanout co-commit here so a
// fault before commit rolls the fan-out row back with the transition (spec §4.1).
// Replay/no-op/conflict append nothing.
function journalPolicyReset(raw: Database.Database, now: string): void {
  appendJournal(raw, { kind: 'reset', changeMask: 'barrier' }, now)
}
// Advances the source's policy generation and enqueues its fan-out row in the SAME
// transaction. Returns the new generation. Every generation-advancing transition
// MUST route through here so the fan-out row always tracks the current generation.
function advancePolicyGeneration(raw: Database.Database, sourceId: string, now: string): number {
  const r = raw.prepare(`UPDATE remote_sources_v2 SET policy_generation = policy_generation + 1 WHERE id = ? RETURNING policy_generation`).get(sourceId) as { policy_generation: number }
  scheduleFanout(raw, { sourceId, generation: r.policy_generation, now })
  return r.policy_generation
}

// The instance-governed-members cascade (spec 2026-07-25 rev 3): re-run the
// instance's ACTION through SOURCE_TRANSITIONS against each member's own axes
// (action, not value — value→cell has no legal unblock mapping). Members have
// no federation axis. Ordinary actions skip overridden members; block/unblock
// hit ALL (absolute both directions). Returns members MOVED.
function cascadeInstanceAction(raw: Database.Database, instance: { id: string; canonical_url: string }, action: SourceTransitionAction | 'establish', now: string): number {
  const effective = action === 'establish' || action === 'approve' ? 'allow' : action
  if (effective !== 'allow' && effective !== 'quarantine' && effective !== 'block' && effective !== 'unblock') return 0
  const absolute = effective === 'block' || effective === 'unblock'
  let moved = 0
  for (const m of memberRows(raw, instance)) {
    if (!absolute && m.overridden === 1) continue
    const patch = SOURCE_TRANSITIONS[effective]({ operation: m.operation as SourceOperation, governance: m.governance as SourceGovernance, federation: 'none' })
    if (!patch || patch.governance === undefined || patch.governance === m.governance) continue
    raw.prepare(`UPDATE remote_sources_v2 SET governance = ? WHERE id = ?`).run(patch.governance, m.id)
    if (patch.governance === 'allowed') {
      const row = raw.prepare(`SELECT * FROM remote_sources_v2 WHERE id = ?`).get(m.id) as RemoteSourceV2Row
      activatePendingSubscriptions(raw, row)
    }
    advancePolicyGeneration(raw, m.id, now) // members do NOT append their own reset
    moved++
  }
  return moved
}

// v2 source-control plane row shapes — read-only in this task. Rows carry the
// WIDER SQL CHECK vocabulary (rev 5, V4 §10 pin); mapping to the narrower V1
// DTO types below is deliberate, not a bug.
export interface RemoteSourceV2Row {
  id: string; canonical_url: string
  attribution_mode: 'single_publisher' | 'aggregate'
  operation: 'enabled' | 'paused'
  governance: 'allowed' | 'quarantined' | 'blocked'
  provenance: 'user_subscription' | 'opml' | 'admin_federation' | 'origin_verification' | 'migration'
  provenance_note: string | null
  admin_retained: 0 | 1
  overridden: 0 | 1
  created_at: string
}
interface SourceSubscriptionV2Row { id: string; owner_id: string; source_id: string; state: 'active' | 'pending' | 'pending_review'; created_at: string }
interface SourceAuditV2Row {
  id: string; source_id: string; command_id: string; actor_id: string | null
  actor_kind: 'administrator' | 'operator_token' | 'system'
  action: string
  category: 'spam' | 'abuse' | 'illegal_content' | 'compromised_source' | 'migration_review' | 'operator_policy' | 'false_positive' | 'remediated' | 'other' | null
  note: string | null; result_json: string; created_at: string
}

function rowToRemoteSourceV2(r: RemoteSourceV2Row): RemoteSource {
  return {
    id: r.id, canonicalUrl: r.canonical_url, attributionMode: r.attribution_mode,
    operation: r.operation, governance: r.governance, provenance: r.provenance,
    provenanceNote: r.provenance_note, adminRetained: r.admin_retained === 1, overridden: r.overridden === 0 ? false : true, createdAt: r.created_at,
  }
}

function rowToSourceSubscriptionV2(r: SourceSubscriptionV2Row): SourceSubscription {
  return { id: r.id, ownerId: r.owner_id, sourceId: r.source_id, state: r.state, createdAt: r.created_at }
}

// PublicSourceFollow.displayName is deterministic presentation data, not
// stored identity (Task 5 brief / design §4): the hostname of the canonical
// URL, falling back to the complete URL if it doesn't parse.
function sourceDisplayName(canonicalUrl: string): string {
  try {
    return new URL(canonicalUrl).hostname
  } catch {
    return canonicalUrl
  }
}

// The all-null projection for a source with no lease. The field is always present
// — an absent lease is nulls, never a missing key.
const NO_PUSH: PushSummary = { mode: null, state: null, endpointFingerprint: null }

interface PushRowV2Read { mode: PushProtocol; state: 'pending' | 'active'; endpoint: string; expires_at: string }

// actor_kind/category are cast to the TS unions the row is known to carry.
// Both are now the full SQL vocabulary (V4 re-added 'operator_token' and
// 'migration_review'), so the cast is a pure row-typing no-op.
function rowToSourceAuditV2(r: SourceAuditV2Row): SourceAuditEvent {
  return {
    id: r.id, sourceId: r.source_id, commandId: r.command_id, actorId: r.actor_id,
    actorKind: r.actor_kind as SourceAuditEvent['actorKind'],
    action: r.action, category: r.category as SourceAuditEvent['category'],
    note: r.note, resultJson: r.result_json, createdAt: r.created_at,
  }
}

type Db = InstanceType<typeof Database>

// Every audited mutation (Task 6) writes exactly one of these, inside the same
// transaction as its effect. result_json is the outcome of THIS command, never
// the envelope that carries the audit event itself.
// `command` is structurally the two fields actually read, not the full
// CommandEnvelope: the V4 legacy conversion (migration/convert.ts) audits under
// a synthetic command id with NO actor — every existing CommandEnvelope caller
// still satisfies this shape unchanged.
export function insertAudit(tx: Db, a: {
  sourceId: string; command: { commandId: string; actorId: string | null }; actorKind: SourceAuditEvent['actorKind']
  action: string; category: AuditCategory | null; note: string | null; result: unknown; now: string
}): SourceAuditEvent {
  const row: SourceAuditV2Row = {
    id: randomUUID(), source_id: a.sourceId, command_id: a.command.commandId, actor_id: a.command.actorId,
    actor_kind: a.actorKind, action: a.action, category: a.category, note: a.note,
    result_json: JSON.stringify(a.result), created_at: a.now,
  }
  tx.prepare(
    `INSERT INTO source_audit_v2 (id, source_id, command_id, actor_id, actor_kind, action, category, note, result_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.source_id, row.command_id, row.actor_id, row.actor_kind, row.action, row.category, row.note, row.result_json, row.created_at)
  return rowToSourceAuditV2(row)
}

// Ordinary pending subscriptions become active only once the source is BOTH
// allowed and single_publisher. pending_review never activates automatically
// under any transition, and already-active subscriptions are left alone.
function activatePendingSubscriptions(tx: Db, source: RemoteSourceV2Row): void {
  if (source.governance !== 'allowed' || source.attribution_mode !== 'single_publisher') return
  tx.prepare(`UPDATE source_subscriptions_v2 SET state = 'active' WHERE source_id = ? AND state = 'pending'`).run(source.id)
}

export class SqliteSourceRepository implements SourceRepository {
  private raw: Database.Database

  // Plain assignment instead of a parameter property: Node's native type
  // stripping can't erase parameter properties.
  constructor(raw: Database.Database) {
    this.raw = raw
  }

  // --- v2 source-control plane administrative reads (served by the
  // /admin/sources routes) — nothing here touches legacy tables; these methods
  // only ever read the five v2 tables.

  private federationStatusFor(sourceId: string): 'none' | FederationStatus {
    const row = this.raw.prepare(`SELECT status FROM federation_relationships_v2 WHERE source_id = ?`).get(sourceId) as { status: FederationStatus } | undefined
    return row ? row.status : 'none'
  }

  private subscriptionCountsFor(sourceId: string): { active: number; pending: number; pendingReview: number } {
    const rows = this.raw.prepare(
      `SELECT state, COUNT(*) AS n FROM source_subscriptions_v2 WHERE source_id = ? GROUP BY state`,
    ).all(sourceId) as { state: 'active' | 'pending' | 'pending_review'; n: number }[]
    const counts = { active: 0, pending: 0, pendingReview: 0 }
    for (const r of rows) {
      if (r.state === 'active') counts.active = r.n
      else if (r.state === 'pending') counts.pending = r.n
      else counts.pendingReview = r.n
    }
    return counts
  }

  async getSource(id: string): Promise<RemoteSource | undefined> {
    const row = this.raw.prepare(`SELECT * FROM remote_sources_v2 WHERE id = ?`).get(id) as RemoteSourceV2Row | undefined
    return row ? rowToRemoteSourceV2(row) : undefined
  }

  async listSourceSummaries(cursor: Cursor | undefined, limit: number, filter?: 'governance' | 'orphan', q?: string): Promise<Page<SourceSummary>> {
    const lim = clampLimit(limit)
    // 'governance' narrows to the administratively load-bearing rows — any
    // federation relationship (approved OR pending) or a quarantined source —
    // so the admin page's federation/review sections can be built independent
    // of where bulk subscriptions push them in the created_at pagination.
    // 'orphan' mirrors reapSourceIfOrphaned's own predicate verbatim: allowed,
    // no federation relationship, zero subscriptions of any state (including
    // pending_review — a source under review is never an orphan).
    const where = filter === 'governance'
      ? `(EXISTS(SELECT 1 FROM federation_relationships_v2 f WHERE f.source_id = remote_sources_v2.id) OR governance = 'quarantined')`
      : filter === 'orphan'
        ? `(governance = 'allowed'
            AND NOT EXISTS(SELECT 1 FROM federation_relationships_v2 f WHERE f.source_id = remote_sources_v2.id)
            AND NOT EXISTS(SELECT 1 FROM source_subscriptions_v2 s WHERE s.source_id = remote_sources_v2.id))`
        : '1=1'
    // Instance-governed members match the orphan predicate BY DEFINITION — a
    // member has no subscribers and no federation row of its own, because its
    // items arrive through the aggregate. Labelling them 'instance_member' (the
    // 2026-08-06 reap fix) stopped them being deleted but left this list
    // describing itself falsely: on rsc.rmdes.be every one of its 60 rows was a
    // member, so the section's own promise — "kept only by whatever's still
    // retaining them" — was untrue for 100% of it, and a real orphan would be
    // buried across pages of members. Members already have their own home
    // (per-aggregate counts + "Show members", with the same per-row actions),
    // so exclude them here rather than relabel: the other retained reasons
    // (admin_retained/audit_history/verified_origin) are rare individual
    // exceptions, while membership is systematic and arrives in dozens.
    const memberEx = filter === 'orphan' ? this.memberExclusionClause() : { sql: '', params: [] as string[] }
    // Escape LIKE's own wildcards in the user's literal search text — otherwise
    // a search for e.g. '%' or '_' matches far more than the substring typed.
    const qEscaped = q?.replace(/[\\%_]/g, (m) => `\\${m}`)
    const qClause = q ? ` AND canonical_url LIKE '%'||?||'%' ESCAPE '\\'` : ''
    const qParams = q ? [qEscaped] : []
    const rows = (cursor
      ? this.raw.prepare(
          `SELECT * FROM remote_sources_v2 WHERE ${where}${memberEx.sql}${qClause} AND ((created_at < ?) OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC LIMIT ?`,
        ).all(...memberEx.params, ...qParams, cursor.createdAt, cursor.createdAt, cursor.id, lim + 1)
      : this.raw.prepare(`SELECT * FROM remote_sources_v2 WHERE ${where}${memberEx.sql}${qClause} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...memberEx.params, ...qParams, lim + 1)
    ) as RemoteSourceV2Row[]
    const { page, nextCursor } = splitPage(rows, lim)
    const items: SourceSummary[] = page.map((r) => {
      const source = rowToRemoteSourceV2(r)
      const isOrphan = filter === 'orphan'
      return {
        source,
        federationStatus: this.federationStatusFor(source.id),
        subscriptionCounts: this.subscriptionCountsFor(source.id),
        push: this.pushFor(source.id).push,
        retention: isOrphan ? this.retentionFor(source.id) : null,
        addedBy: this.addedByFor(source.id),
      }
    })
    return { items, nextCursor }
  }

  // The v2 "Connected instances" read: approved federation instances only —
  // legacy markdown-webfeed authorship (the retired listTextcastingPeers)
  // neither includes nor excludes correctly post-cutover. See app.ts's /peers.
  async listApprovedFederationSources(): Promise<{ canonicalUrl: string }[]> {
    const rows = this.raw.prepare(
      `SELECT canonical_url FROM remote_sources_v2 s
       WHERE s.governance = 'allowed'
         AND EXISTS (SELECT 1 FROM federation_relationships_v2 f
                     WHERE f.source_id = s.id AND f.status = 'approved')
       ORDER BY canonical_url`,
    ).all() as { canonical_url: string }[]
    return rows.map((r) => ({ canonicalUrl: r.canonical_url }))
  }

  async getSourceDetail(id: string): Promise<SourceDetail | undefined> {
    const row = this.raw.prepare(`SELECT * FROM remote_sources_v2 WHERE id = ?`).get(id) as RemoteSourceV2Row | undefined
    if (!row) return undefined
    // m2 (whole-branch review): a cascading transition can insert TWO audit
    // rows for the same source_id with the SAME created_at (the direct
    // action's own audit, plus its instance_cascade summary) — id DESC broke
    // that tie on a random UUID, so which one "latestAudit" picked varied
    // unpredictably run to run. rowid reflects real insertion order, so the
    // most-recently-inserted row deterministically wins. Single LIMIT-1 read,
    // no cursor involved — unlike listSourceAudit below, changing this
    // tie-break doesn't touch any keyset-pagination invariant.
    const auditRow = this.raw.prepare(
      `SELECT * FROM source_audit_v2 WHERE source_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(id) as SourceAuditV2Row | undefined
    return {
      source: rowToRemoteSourceV2(row),
      federationStatus: this.federationStatusFor(id),
      subscriptionCounts: this.subscriptionCountsFor(id),
      latestAudit: auditRow ? rowToSourceAuditV2(auditRow) : null,
      retention: this.retentionFor(id),
      addedBy: this.addedByFor(id),
      ...this.pushFor(id),
    }
  }

  // The administrative push projection (V4 spec §1.5). A source holds at most one
  // row per mode, so the ONE lease the admin sees is chosen deterministically: a
  // live lease over a pending one, then websub over its rsscloud fallback. The
  // endpoint is NEVER shipped — only a stable non-secret digest of it — and the
  // callback token and secret are not read at all, so they cannot reach any body.
  // ponytail: one small indexed lookup per listed source (the page is clamped to
  // ≤100, via clampLimit); fold into the list query only if a page read ever shows up in a profile.
  private pushFor(sourceId: string): { push: PushSummary; pushExpiresAt: string | null } {
    const row = this.raw.prepare(
      `SELECT mode, state, endpoint, expires_at FROM push_subscriptions_v2 WHERE source_id = ?
       ORDER BY CASE state WHEN 'active' THEN 0 ELSE 1 END, CASE mode WHEN 'websub' THEN 0 ELSE 1 END LIMIT 1`,
    ).get(sourceId) as PushRowV2Read | undefined
    if (!row) return { push: NO_PUSH, pushExpiresAt: null }
    return {
      push: { mode: row.mode, state: row.state, endpointFingerprint: createHash('sha256').update(row.endpoint).digest('hex').slice(0, 16) },
      pushExpiresAt: row.expires_at,
    }
  }

  // A display-only retention-reason label for ANY source (getSourceDetail and
  // listSourceMembers call this unconditionally, not just for orphans) — first
  // match wins, in priority order: instance_member > verified_origin >
  // admin_retained > audit_history > reapable. instance_member (an
  // origin_verification-provenance member covered by an approved instance)
  // is checked first, ahead of its own verified_origin claim, since that
  // claim churns far more often than the membership itself. This checks only
  // those 4 signals, NOT the full reapSourceIfOrphaned guard chain (which
  // also checks subscribers/governance/federation first). Trap: 'reapable'
  // means "nothing here is retaining it," NOT "safe to reap" — a source with
  // active subscriptions still shows 'reapable' when rendered via
  // getSourceDetail/listSourceMembers, since neither pre-filters to orphans
  // the way listSourceSummaries's orphan filter does.
  private retentionFor(sourceId: string): 'instance_member' | 'verified_origin' | 'audit_history' | 'admin_retained' | 'reapable' {
    const s = this.raw.prepare(`SELECT canonical_url, provenance FROM remote_sources_v2 WHERE id = ?`).get(sourceId) as { canonical_url: string; provenance: string } | undefined
    if (s?.provenance === 'origin_verification' && approvedInstanceFor(this.raw, s.canonical_url) !== null) return 'instance_member'
    if (this.raw.prepare(`SELECT 1 FROM publisher_claims_v2 WHERE source_id = ? AND evidence_level = 'verified_origin' LIMIT 1`).get(sourceId)) return 'verified_origin'
    const source = this.raw.prepare(`SELECT admin_retained FROM remote_sources_v2 WHERE id = ?`).get(sourceId) as { admin_retained: 0 | 1 } | undefined
    if (source?.admin_retained === 1) return 'admin_retained'
    if (this.raw.prepare(`SELECT 1 FROM source_audit_v2 WHERE source_id = ? LIMIT 1`).get(sourceId)) return 'audit_history'
    return 'reapable'
  }

  // Set-based twin of the per-source membership test used by reapSource's guard
  // and retentionFor: a row is a member when it is origin_verification-
  // provenanced, is not itself approved-federated (the F14 self-governing
  // exclusion, mirrored from MEMBER_RANGE_SQL), and falls inside some approved
  // instance's prefix range. Built from instancePrefix/prefixUpperBound rather
  // than SQL string surgery on the URL, so all three encodings of "member"
  // share one definition. Approved instances are few (single digits), so the
  // OR-list is small and every bound is a parameter, never interpolated.
  private memberExclusionClause(): { sql: string; params: string[] } {
    // No activeOnly: a blocked or paused instance still governs its members,
    // so they stay protected from orphan reaping. See approvedInstancePrefixes.
    const prefixes = approvedInstancePrefixes(this.raw)
    const ranges = prefixes.map(() => '(canonical_url >= ? AND canonical_url < ?)')
    const params = prefixes.flatMap((p) => [p, prefixUpperBound(p)])
    // No approved instances ⇒ nothing can be a member ⇒ no exclusion at all
    // (an empty OR-list would be a syntax error, not a no-op).
    if (ranges.length === 0) return { sql: '', params: [] }
    return {
      sql: ` AND NOT (provenance = 'origin_verification'
        AND NOT EXISTS (SELECT 1 FROM federation_relationships_v2 f WHERE f.source_id = remote_sources_v2.id AND f.status = 'approved')
        AND (${ranges.join(' OR ')}))`,
      params,
    }
  }

  // ponytail: one small indexed lookup per listed source (the page is clamped
  // to ≤100, matching pushFor's own accepted shape); fold into the list query
  // only if a page read ever shows up in a profile.
  private addedByFor(sourceId: string): { handle: string; displayName: string }[] {
    const rows = this.raw.prepare(
      `SELECT u.handle AS handle, u.display_name AS displayName
       FROM source_subscriptions_v2 s JOIN users u ON u.id = s.owner_id
       WHERE s.source_id = ? ORDER BY s.created_at ASC LIMIT 3`,
    ).all(sourceId) as { handle: string; displayName: string }[]
    return rows
  }

  async listSourceSubscriptions(sourceId: string, cursor: Cursor | undefined, limit: number): Promise<Page<SourceSubscription>> {
    const lim = clampLimit(limit)
    const rows = (cursor
      ? this.raw.prepare(
          `SELECT * FROM source_subscriptions_v2 WHERE source_id = ? AND ((created_at < ?) OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC LIMIT ?`,
        ).all(sourceId, cursor.createdAt, cursor.createdAt, cursor.id, lim + 1)
      : this.raw.prepare(
          `SELECT * FROM source_subscriptions_v2 WHERE source_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
        ).all(sourceId, lim + 1)
    ) as SourceSubscriptionV2Row[]
    const { page, nextCursor } = splitPage(rows, lim)
    return { items: page.map(rowToSourceSubscriptionV2), nextCursor }
  }

  // m2 (whole-branch review): this listing's ORDER BY tie-break stays `id`,
  // NOT `rowid` like getSourceDetail's single-row read above — its keyset
  // pagination WHERE-seeks on `id` (cursor.id), so the ORDER BY and the seek
  // predicate must use the same column or a same-created_at row can be
  // skipped or repeated across a page boundary. A full listing showing two
  // equal-timestamp rows in either relative order loses no data (unlike
  // picking a single "latest"), so id's arbitrary-but-stable tie-break is
  // left alone here. ponytail: fold rowid into the cursor if this listing
  // ever needs a "most recent wins" reading too.
  async listSourceAudit(sourceId: string, cursor: Cursor | undefined, limit: number): Promise<Page<SourceAuditEvent>> {
    const lim = clampLimit(limit)
    const rows = (cursor
      ? this.raw.prepare(
          `SELECT * FROM source_audit_v2 WHERE source_id = ? AND ((created_at < ?) OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC LIMIT ?`,
        ).all(sourceId, cursor.createdAt, cursor.createdAt, cursor.id, lim + 1)
      : this.raw.prepare(
          `SELECT * FROM source_audit_v2 WHERE source_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
        ).all(sourceId, lim + 1)
    ) as SourceAuditV2Row[]
    const { page, nextCursor } = splitPage(rows, lim)
    return { items: page.map(rowToSourceAuditV2), nextCursor }
  }

  // Task 5 (instance-governed-members): the admin member list/count reads —
  // delegates the F2 approved-federation gate and the range query wholly to
  // membership.ts, then reuses this class's own per-row summary projection
  // (same shape listSourceSummaries/getSourceDetail already build).
  async listSourceMembers(sourceId: string, cursor: Cursor | undefined, limit: number): Promise<Page<SourceSummary>> {
    const instRow = this.raw.prepare(`SELECT id, canonical_url FROM remote_sources_v2 WHERE id = ?`).get(sourceId) as { id: string; canonical_url: string } | undefined
    if (!instRow) return { items: [], nextCursor: null }
    const { rows, nextCursor } = memberRowsPage(this.raw, instRow, cursor, limit)
    const items: SourceSummary[] = rows.map((r) => {
      const source = rowToRemoteSourceV2(r)
      return {
        source,
        federationStatus: this.federationStatusFor(source.id),
        subscriptionCounts: this.subscriptionCountsFor(source.id),
        push: this.pushFor(source.id).push,
        retention: this.retentionFor(source.id),
        addedBy: this.addedByFor(source.id),
      }
    })
    return { items, nextCursor }
  }

  async sourceMemberCounts(sourceId: string): Promise<{ members: number; overridden: number }> {
    const instRow = this.raw.prepare(`SELECT id, canonical_url FROM remote_sources_v2 WHERE id = ?`).get(sourceId) as { id: string; canonical_url: string } | undefined
    if (!instRow) return { members: 0, overridden: 0 }
    return memberCounts(this.raw, instRow)
  }

  // --- v2 source-control plane mutations (Task 3). Each method is a single
  // ledger-backed BEGIN IMMEDIATE
  // transaction: checkCommand, resolve, cap-check where applicable, write,
  // storeCommand, commit. No await inside the transaction() callback —
  // better-sqlite3's transactions are synchronous only (Task 2 report).
  // Every INSERT uses an explicit column list (frozen cross-vertical contract).

  async followLocalAccount(input: { command: CommandEnvelope; ownerId: string; targetId: string; now: string }): Promise<SubscribeResult> {
    const raw = this.raw
    return raw.transaction(() => {
      const check = checkCommand<SubscribeResult>(raw, input.command)
      if (check.kind === 'replay') return check.result
      if (check.kind === 'conflict') return { kind: 'conflict' } as SubscribeResult

      const existing = raw.prepare(`SELECT 1 FROM follows WHERE follower_id = ? AND followed_id = ?`).get(input.ownerId, input.targetId)
      const created = !existing
      if (created) {
        raw.prepare(`INSERT INTO follows (follower_id, followed_id, created_at) VALUES (?, ?, ?)`).run(input.ownerId, input.targetId, input.now)
      }
      const target = raw.prepare(`SELECT id, handle, display_name FROM users WHERE id = ?`).get(input.targetId) as { id: string; handle: string; display_name: string }
      const result: SubscribeResult = { kind: 'local', created, follow: { kind: 'local', id: target.id, handle: target.handle, displayName: target.display_name } }
      if (created) journalPolicyReset(raw, input.now) // new Personal-membership edge
      storeCommand(raw, input.command, result, input.now)
      return result
    }).immediate()
  }

  async resolveAndSubscribeSource(input: { command: CommandEnvelope; ownerId: string; canonicalUrl: string; cap: number; now: string }): Promise<SubscribeResult> {
    const raw = this.raw
    return raw.transaction(() => {
      const check = checkCommand<SubscribeResult>(raw, input.command)
      if (check.kind === 'replay') return check.result
      if (check.kind === 'conflict') return { kind: 'conflict' } as SubscribeResult

      let source = raw.prepare(`SELECT * FROM remote_sources_v2 WHERE canonical_url = ?`).get(input.canonicalUrl) as RemoteSourceV2Row | undefined

      // Blocked (and, once tombstones land, tombstoned) sources return the
      // same generic result as a URL that never existed — design §4.
      if (source && source.governance === 'blocked') {
        const result: SubscribeResult = { kind: 'unavailable' }
        storeCommand(raw, input.command, result, input.now)
        return result
      }

      // Only a single_publisher source with no federation relationship
      // accepts a new user subscription — design §4 "User subscription boundary".
      if (source) {
        const federated = raw.prepare(`SELECT 1 FROM federation_relationships_v2 WHERE source_id = ?`).get(source.id)
        if (source.attribution_mode === 'aggregate' || federated) {
          const result: SubscribeResult = { kind: 'not_subscribable' }
          storeCommand(raw, input.command, result, input.now)
          return result
        }
      }

      const existingSub = source
        ? (raw.prepare(`SELECT * FROM source_subscriptions_v2 WHERE owner_id = ? AND source_id = ?`).get(input.ownerId, source.id) as SourceSubscriptionV2Row | undefined)
        : undefined

      let state: SourceSubscriptionState
      let created: boolean
      if (existingSub) {
        // Report the state that is STORED — re-subscribing writes nothing, so
        // claiming 'active' over a pending_review row would contradict
        // ownerFollowing. pending_review is terminal in V1; V2 owns its exit.
        state = existingSub.state
        created = false
      } else {
        // Cap gates every NEW subscription (and the source it may create) —
        // one check, inside this transaction, serializes concurrent final-slot
        // subscribers to exactly one success (design §4).
        const { n } = raw.prepare(`SELECT COUNT(*) AS n FROM source_subscriptions_v2 WHERE owner_id = ?`).get(input.ownerId) as { n: number }
        if (n >= input.cap) {
          const result: SubscribeResult = { kind: 'cap' }
          storeCommand(raw, input.command, result, input.now)
          return result
        }
        if (!source) {
          const id = randomUUID()
          raw.prepare(
            `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
             VALUES (?, ?, 'single_publisher', 'enabled', 'allowed', 'user_subscription', NULL, 0, ?)`,
          ).run(id, input.canonicalUrl, input.now)
          source = { id, canonical_url: input.canonicalUrl, attribution_mode: 'single_publisher', operation: 'enabled', governance: 'allowed', provenance: 'user_subscription', provenance_note: null, admin_retained: 0, overridden: 1, created_at: input.now }
        }
        state = source.governance === 'quarantined' ? 'pending' : 'active'
        raw.prepare(
          `INSERT INTO source_subscriptions_v2 (id, owner_id, source_id, state, created_at) VALUES (?, ?, ?, ?, ?)`,
        ).run(randomUUID(), input.ownerId, source.id, state, input.now)
        created = true
      }
      // Invariant: reachable only with a resolved source (existingSub implies
      // it via the ternary above; the !source branch above always sets one).
      if (!source) throw new Error('source resolution invariant violated')

      const subscription: OwnerSourceFollow = {
        sourceId: source.id,
        url: source.canonical_url,
        attributionMode: source.attribution_mode,
        subscriptionState: state,
        // Same rule as ownerFollowing: only 'active' is available; pending and
        // pending_review are awaiting_review regardless of governance (rev 5).
        availability: state === 'active' ? 'available' : 'awaiting_review',
      }
      const result: SubscribeResult = { kind: 'source', created, subscription }
      // A newly created ACTIVE subscription changes Personal membership; a new
      // pending one is inactive-to-inactive and a re-subscribe writes nothing.
      if (created && state === 'active') journalPolicyReset(raw, input.now)
      storeCommand(raw, input.command, result, input.now)
      return result
    }).immediate()
  }

  // Task 4: the mixed local/remote OPML import command. One transaction —
  // ledger check, insert local follows, resolve/create sources, enforce the
  // cap, store, commit — as explicit sequential substeps. All partitioning
  // (parsing, local-feed resolution, normalization, SSRF checks) already
  // happened in source-service.ts; this method never awaits or touches the
  // network.
  async importSourceSubscriptions(input: {
    command: CommandEnvelope
    ownerId: string
    localTargetIds: string[]
    canonicalUrls: string[]
    unavailableCount: number
    cap: number
    now: string
  }): Promise<ImportSourcesResult | { kind: 'conflict' }> {
    const raw = this.raw
    return raw.transaction(() => {
      const check = checkCommand<ImportSourcesResult>(raw, input.command)
      if (check.kind === 'replay') return check.result
      if (check.kind === 'conflict') return { kind: 'conflict' } as ImportSourcesResult | { kind: 'conflict' }

      // Substep: insert local follows (unlimited, mirrors legacy Case 2 — no cap applies).
      let localFollowed = 0
      for (const targetId of input.localTargetIds) {
        const existing = raw.prepare(`SELECT 1 FROM follows WHERE follower_id = ? AND followed_id = ?`).get(input.ownerId, targetId)
        if (!existing) {
          raw.prepare(`INSERT INTO follows (follower_id, followed_id, created_at) VALUES (?, ?, ?)`).run(input.ownerId, targetId, input.now)
          localFollowed++
        }
      }

      // Substep: resolve/create sources, enforce the cap. active+pending+
      // pending_review all count toward it (same query as resolveAndSubscribeSource).
      let active = 0, pending = 0, notSubscribable = 0, capSkipped = 0
      let unavailable = input.unavailableCount
      let subCount = (raw.prepare(`SELECT COUNT(*) AS n FROM source_subscriptions_v2 WHERE owner_id = ?`).get(input.ownerId) as { n: number }).n

      for (const canonicalUrl of input.canonicalUrls) {
        let source = raw.prepare(`SELECT * FROM remote_sources_v2 WHERE canonical_url = ?`).get(canonicalUrl) as RemoteSourceV2Row | undefined

        // Blocked reveals nothing beyond generic unavailable (design §4) —
        // same bucket the pre-write SSRF/invalid-URL rejects landed in.
        if (source && source.governance === 'blocked') { unavailable++; continue }

        if (source) {
          const federated = raw.prepare(`SELECT 1 FROM federation_relationships_v2 WHERE source_id = ?`).get(source.id)
          if (source.attribution_mode === 'aggregate' || federated) { notSubscribable++; continue }
        }

        const existingSub = source
          ? (raw.prepare(`SELECT * FROM source_subscriptions_v2 WHERE owner_id = ? AND source_id = ?`).get(input.ownerId, source.id) as SourceSubscriptionV2Row | undefined)
          : undefined

        if (existingSub) {
          if (existingSub.state === 'active') active++
          else pending++ // pending and pending_review are both pending-ish (matches resolveAndSubscribeSource)
          continue
        }

        if (subCount >= input.cap) { capSkipped++; continue }

        if (!source) {
          const id = randomUUID()
          raw.prepare(
            `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
             VALUES (?, ?, 'single_publisher', 'enabled', 'allowed', 'opml', NULL, 0, ?)`,
          ).run(id, canonicalUrl, input.now)
          source = { id, canonical_url: canonicalUrl, attribution_mode: 'single_publisher', operation: 'enabled', governance: 'allowed', provenance: 'opml', provenance_note: null, admin_retained: 0, overridden: 1, created_at: input.now }
        }
        const state: 'active' | 'pending' = source.governance === 'quarantined' ? 'pending' : 'active'
        raw.prepare(
          `INSERT INTO source_subscriptions_v2 (id, owner_id, source_id, state, created_at) VALUES (?, ?, ?, ?, ?)`,
        ).run(randomUUID(), input.ownerId, source.id, state, input.now)
        subCount++
        if (state === 'pending') pending++
        else active++
      }

      const result: ImportSourcesResult = { localFollowed, active, pending, unavailable, notSubscribable, capSkipped }
      storeCommand(raw, input.command, result, input.now)
      return result
    }).immediate()
  }

  // Shared by ownerFollowing and publicFollowing: local-account follows are
  // never governance-gated, so both projections show the identical set.
  private localFollowsFor(ownerId: string): PublicLocalFollow[] {
    const rows = this.raw.prepare(
      `SELECT u.id AS id, u.handle AS handle, u.display_name AS display_name
       FROM follows f JOIN users u ON u.id = f.followed_id
       WHERE f.follower_id = ? AND u.kind = 'local'
       ORDER BY f.created_at ASC, u.handle ASC`,
    ).all(ownerId) as { id: string; handle: string; display_name: string }[]
    return rows.map((r) => ({ kind: 'local', id: r.id, handle: r.handle, displayName: r.display_name }))
  }

  // Task 5: ordinary projections — plain queries, not commands. Every SELECT
  // lists its columns explicitly; never spread a row, since that is how
  // administrative fields (governance/operation/provenance/adminRetained/
  // audit/counts) would leak into an ordinary response (frozen contract).
  async ownerFollowing(ownerId: string): Promise<OwnerFollowingView> {
    const localFollows = this.localFollowsFor(ownerId)

    const subRows = this.raw.prepare(
      `SELECT s.source_id AS source_id, s.state AS state, r.canonical_url AS canonical_url, r.attribution_mode AS attribution_mode
       FROM source_subscriptions_v2 s JOIN remote_sources_v2 r ON r.id = s.source_id
       WHERE s.owner_id = ?
       ORDER BY s.created_at ASC`,
    ).all(ownerId) as { source_id: string; state: 'active' | 'pending' | 'pending_review'; canonical_url: string; attribution_mode: 'single_publisher' | 'aggregate' }[]
    // active -> available; pending/pending_review -> awaiting_review, no matter
    // the source's governance (pending only ever arises on a quarantined source
    // today, and pending_review is pinned to awaiting_review regardless — rev 5).
    const sourceSubscriptions: OwnerSourceFollow[] = subRows.map((r) => ({
      sourceId: r.source_id,
      url: r.canonical_url,
      attributionMode: r.attribution_mode,
      subscriptionState: r.state,
      availability: r.state === 'active' ? 'available' : 'awaiting_review',
    }))
    return { localFollows, sourceSubscriptions }
  }

  async publicFollowing(ownerId: string): Promise<PublicFollowingEntry[]> {
    const localFollows: PublicFollowingEntry[] = this.localFollowsFor(ownerId)

    // Public exposes active subscriptions on allowed sources ONLY (design §4) —
    // pending/pending_review and any non-allowed governance are excluded here,
    // not filtered later, so a quarantined/blocked source's id never reaches JSON.
    const sourceRows = this.raw.prepare(
      `SELECT s.source_id AS source_id, r.canonical_url AS canonical_url
       FROM source_subscriptions_v2 s JOIN remote_sources_v2 r ON r.id = s.source_id
       WHERE s.owner_id = ? AND s.state = 'active' AND r.governance = 'allowed'
       ORDER BY s.created_at ASC`,
    ).all(ownerId) as { source_id: string; canonical_url: string }[]
    const sourceEntries: PublicFollowingEntry[] = sourceRows.map((r): PublicSourceFollow => ({
      kind: 'source', sourceId: r.source_id, url: r.canonical_url, displayName: sourceDisplayName(r.canonical_url),
    }))
    return [...localFollows, ...sourceEntries]
  }

  // One ledger-backed BEGIN IMMEDIATE transaction (Task 5): ledger check,
  // delete the subscription, evaluate last-subscription retention
  // (reapSourceIfOrphaned — shared with deleteUserCascade), store, commit.
  async unsubscribe(input: { command: CommandEnvelope; ownerId: string; sourceId: string; now: string }): Promise<UnsubscribeResult> {
    const raw = this.raw
    return raw.transaction(() => {
      const check = checkCommand<UnsubscribeResult>(raw, input.command)
      if (check.kind === 'replay') return check.result
      if (check.kind === 'conflict') return { kind: 'conflict' } as UnsubscribeResult

      const sub = raw.prepare(`SELECT id, state FROM source_subscriptions_v2 WHERE owner_id = ? AND source_id = ?`).get(input.ownerId, input.sourceId) as { id: string; state: SourceSubscriptionState } | undefined
      if (!sub) {
        const result: UnsubscribeResult = { kind: 'unknown' }
        storeCommand(raw, input.command, result, input.now)
        return result
      }
      raw.prepare(`DELETE FROM source_subscriptions_v2 WHERE id = ?`).run(sub.id)

      const result: UnsubscribeResult = { kind: 'removed', sourceRemoved: reapSourceIfOrphaned(raw, input.sourceId) }
      if (sub.state === 'active') journalPolicyReset(raw, input.now) // active removal changes Personal membership
      storeCommand(raw, input.command, result, input.now)
      return result
    }).immediate()
  }

  // Task 2 (admin-governance-visibility): the operator override of
  // reapSourceIfOrphaned. Same ledger-backed BEGIN IMMEDIATE shape as every
  // other command here; the guard chain itself lives in reapSource (shared
  // domain function) — this method only wraps it with the command ledger and
  // the unknown-source 404 case.
  async reapSource(input: { command: CommandEnvelope; sourceId: string; force: boolean; now: string }): Promise<ReapCommandResult> {
    const raw = this.raw
    return raw.transaction(() => {
      const check = checkCommand<ReapCommandResult>(raw, input.command)
      if (check.kind === 'replay') return check.result
      if (check.kind === 'conflict') return { kind: 'conflict' as const }
      if (!raw.prepare(`SELECT 1 FROM remote_sources_v2 WHERE id = ?`).get(input.sourceId)) {
        const result = { kind: 'unknown' as const }
        storeCommand(raw, input.command, result, input.now)
        return result
      }
      const outcome = reapSourceFn(raw, input.sourceId, { force: input.force }, input.now)
      // Only a 'reaped' outcome is ledgered — like every sibling admin command,
      // a refusal writes nothing so a retry with the same commandId
      // re-evaluates against live state instead of replaying a stale refusal.
      if (outcome.kind === 'reaped') storeCommand(raw, input.command, outcome, input.now)
      return outcome
    }).immediate()
  }

  // Task 6, audited administrator commands. Both follow the same shape as every
  // mutation above — one BEGIN IMMEDIATE transaction: ledger check, resolve,
  // apply, write the audit row, store the result, commit — with one addition:
  // a conflict NEVER writes, not even a ledger row, so a corrected retry is
  // re-evaluated against live state instead of replaying a stale refusal.

  // actorKind widens with the audit vocabulary: the ops-token federation route
  // (V4 Task 9) establishes as 'operator_token'. The SourceRepository /
  // SourceService declarations widen with their own tasks.
  async establishFederation(input: {
    command: CommandEnvelope; canonicalUrl: string; attributionMode: AttributionMode
    category: AuditCategory; note: string | null; actorKind: 'administrator' | 'operator_token'; now: string
  }): Promise<EstablishFederationResult> {
    if (!input.category) return { kind: 'conflict' } // every establishment is audited under a category
    const raw = this.raw
    return raw.transaction(() => {
      const check = checkCommand<EstablishFederationResult>(raw, input.command)
      if (check.kind === 'replay') return check.result
      if (check.kind === 'conflict') return { kind: 'conflict' } as EstablishFederationResult

      let row = raw.prepare(`SELECT * FROM remote_sources_v2 WHERE canonical_url = ?`).get(input.canonicalUrl) as RemoteSourceV2Row | undefined

      // Blocked: unblock or purge first (design §5). Reveals nothing further.
      if (row && row.governance === 'blocked') {
        const result: EstablishFederationResult = { kind: 'unavailable' }
        storeCommand(raw, input.command, result, input.now)
        return result
      }
      // The relationship's PK is source_id, so concurrent different commands
      // converge on the one row: the loser reports it already exists.
      if (row && raw.prepare(`SELECT 1 FROM federation_relationships_v2 WHERE source_id = ?`).get(row.id)) {
        const result: EstablishFederationResult = { kind: 'exists' }
        storeCommand(raw, input.command, result, input.now)
        return result
      }

      if (!row) {
        // New URL: the administrator picks the mode; a federated source starts
        // enabled and allowed.
        const id = randomUUID()
        raw.prepare(
          `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
           VALUES (?, ?, ?, 'enabled', 'allowed', 'admin_federation', NULL, 0, ?)`,
        ).run(id, input.canonicalUrl, input.attributionMode, input.now)
        row = { id, canonical_url: input.canonicalUrl, attribution_mode: input.attributionMode, operation: 'enabled', governance: 'allowed', provenance: 'admin_federation', provenance_note: null, admin_retained: 0, overridden: 1, created_at: input.now }
      } else if (row.governance === 'quarantined') {
        // A retained source keeps its own mode and operation; approval only
        // lifts a quarantined candidate to allowed (design §5).
        raw.prepare(`UPDATE remote_sources_v2 SET governance = 'allowed' WHERE id = ?`).run(row.id)
        row = { ...row, governance: 'allowed' }
      }

      raw.prepare(
        `INSERT INTO federation_relationships_v2 (source_id, status, provenance_note, created_at, updated_at) VALUES (?, 'approved', ?, ?, ?)`,
      ).run(row.id, input.note, input.now, input.now)
      activatePendingSubscriptions(raw, row)

      const source = rowToRemoteSourceV2(row)
      const federation: FederationRelationship = { sourceId: row.id, status: 'approved', provenanceNote: input.note, createdAt: input.now, updatedAt: input.now }
      const result: EstablishFederationResult = { kind: 'established', source, federation }
      advancePolicyGeneration(raw, row.id, input.now) // federation is a source-policy change
      journalPolicyReset(raw, input.now)
      const moved = cascadeInstanceAction(raw, { id: row.id, canonical_url: row.canonical_url }, 'establish', input.now)
      if (moved > 0) insertAudit(raw, { sourceId: row.id, command: input.command, actorKind: 'system', action: 'instance_cascade', category: input.category, note: null, result: { moved }, now: input.now })
      insertAudit(raw, { sourceId: row.id, command: input.command, actorKind: input.actorKind, action: 'establish_federation', category: input.category, note: input.note, result, now: input.now })
      storeCommand(raw, input.command, result, input.now)
      return result
    }).immediate()
  }

  async transition(input: {
    command: CommandEnvelope; sourceId: string; action: SourceTransitionAction
    category: AuditCategory | null; note: string | null; attributionMode?: AttributionMode
    actorKind: 'administrator' | 'system'; now: string
  }): Promise<SourceTransitionResult> {
    // Malformed requests are refused before the ledger is touched.
    if (!input.category && !CATEGORY_OPTIONAL_ACTIONS.has(input.action)) return { kind: 'conflict' }
    if (input.action === 'set_attribution_mode' && !input.attributionMode) return { kind: 'conflict' }
    const raw = this.raw
    return raw.transaction(() => {
      const check = checkCommand<SourceTransitionResult>(raw, input.command)
      if (check.kind === 'replay') return check.result
      if (check.kind === 'conflict') return { kind: 'conflict' } as SourceTransitionResult

      const row = raw.prepare(`SELECT * FROM remote_sources_v2 WHERE id = ?`).get(input.sourceId) as RemoteSourceV2Row | undefined
      if (!row) {
        const result: SourceTransitionResult = { kind: 'unknown' }
        storeCommand(raw, input.command, result, input.now)
        return result
      }
      const fed = raw.prepare(`SELECT status FROM federation_relationships_v2 WHERE source_id = ?`).get(row.id) as { status: FederationStatus } | undefined
      const axes: SourceAxes = { operation: row.operation, governance: row.governance, federation: fed ? fed.status : 'none' }

      const patch = SOURCE_TRANSITIONS[input.action](axes)
      if (!patch) return { kind: 'conflict' } as SourceTransitionResult // invalid cell: refused, writes nothing

      const operation = patch.operation ?? row.operation
      const governance = patch.governance ?? row.governance
      const attributionMode = input.action === 'set_attribution_mode' && input.attributionMode ? input.attributionMode : row.attribution_mode
      if (operation !== row.operation || governance !== row.governance || attributionMode !== row.attribution_mode) {
        raw.prepare(`UPDATE remote_sources_v2 SET operation = ?, governance = ?, attribution_mode = ? WHERE id = ?`).run(operation, governance, attributionMode, row.id)
      }
      // A direct administrator GOVERNANCE change on a member is a sticky
      // override; pause/resume/set_attribution_mode are not judgments.
      const overriddenFlip = input.actorKind === 'administrator' && governance !== row.governance && row.provenance === 'origin_verification'
      if (overriddenFlip) {
        raw.prepare(`UPDATE remote_sources_v2 SET overridden = 1 WHERE id = ?`).run(row.id)
      }
      if (patch.federation === 'none') raw.prepare(`DELETE FROM federation_relationships_v2 WHERE source_id = ?`).run(row.id)
      else if (patch.federation) raw.prepare(`UPDATE federation_relationships_v2 SET status = ?, updated_at = ? WHERE source_id = ?`).run(patch.federation, input.now, row.id)

      // m1 (whole-branch review): `updated` is spread from the PRE-flip row —
      // when overriddenFlip just fired, the DB row is already 1 but `row` still
      // says 0. Reflect the flip in the same response, not just the database.
      const updated: RemoteSourceV2Row = { ...row, operation, governance, attribution_mode: attributionMode, overridden: overriddenFlip ? 1 : row.overridden }
      if (input.action === 'allow' || input.action === 'approve') activatePendingSubscriptions(raw, updated)
      // Converting to aggregate withdraws every ordinary subscription for review
      // — active and pending alike — in the same transaction as the mode change.
      if (attributionMode === 'aggregate' && row.attribution_mode !== 'aggregate') {
        raw.prepare(`UPDATE source_subscriptions_v2 SET state = 'pending_review' WHERE source_id = ? AND state IN ('active', 'pending')`).run(row.id)
      }

      // Governance, federation, or attribution-mode changes advance this source's
      // policy generation and append ONE reset (even when several subscriptions
      // change with it — no fan-out). pause/resume touch only the operation axis:
      // no reset, generation retained (spec §3.7). patch.federation is set only by
      // approve/reject/revoke, the genuine federation transitions.
      if (governance !== row.governance || patch.federation !== undefined || attributionMode !== row.attribution_mode) {
        advancePolicyGeneration(raw, row.id, input.now)
        journalPolicyReset(raw, input.now)
      }

      // The instance-governed-members cascade (spec 2026-07-25 rev 3): an
      // instance's governance transition, or its federation being newly
      // approved, re-runs the same action against every member underneath it.
      if (governance !== row.governance || input.action === 'approve') {
        const fedNow = patch.federation === 'approved' || (fed?.status === 'approved' && patch.federation === undefined)
        if (fedNow) {
          const moved = cascadeInstanceAction(raw, { id: row.id, canonical_url: row.canonical_url }, input.action, input.now)
          if (moved > 0) insertAudit(raw, { sourceId: row.id, command: input.command, actorKind: 'system', action: 'instance_cascade', category: input.category, note: null, result: { moved }, now: input.now })
        }
      }

      const source = rowToRemoteSourceV2(updated)
      const audit = insertAudit(raw, { sourceId: row.id, command: input.command, actorKind: input.actorKind, action: input.action, category: input.category, note: input.note, result: { kind: 'applied', source }, now: input.now })
      const result: SourceTransitionResult = { kind: 'applied', source, audit }
      storeCommand(raw, input.command, result, input.now)
      return result
    }).immediate()
  }
}
