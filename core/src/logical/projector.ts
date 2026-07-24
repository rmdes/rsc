import { createHash } from 'node:crypto'
import type { ReadTx } from './database.ts'
import type {
  EnclosureDto, LogicalItemDto, SelectedAuthor, TimelineLens, TimelineQuery,
  LogicalTimelineEnvelope, LogicalHistoryEnvelope, ProjectionViewer,
  PublicLocalAccount, PublicPublisher,
} from './types.ts'
import { snapshotJournalCursor } from './journal.ts'
import { encodeCursor } from '../domain/cursor.ts'

// Pure effective-selection and presentation-chain comparators (spec §3.2, §3.3,
// §3.6, §4.4). NO database access — reconciliation calls these to write hints and
// ordinary reads (Task 8) call the SAME functions to re-derive effective state, so
// stored selected-delivery/author/name fields are never authority (spec §3.1).

export type EvidenceLevel =
  | 'verified_origin'
  | 'bound_single_publisher'
  | 'aggregate_assertion'
  | 'source_scoped_fallback'

// Strongest first (rank 0). Vertical 3 PREPENDS the verified_origin rung at rank 0
// — an intentional in-place supersession of V2's exact three-level enum (spec §4.3).
// Because the comparator is strongest-first, the addition is PURELY ADDITIVE: no
// item without verified evidence changes selection. The others shift down one rank.
export const LEVEL_RANK: Record<EvidenceLevel, number> = {
  verified_origin: 0,
  bound_single_publisher: 1,
  aggregate_assertion: 2,
  source_scoped_fallback: 3,
}

// The complete durable first-arrival tuple (spec §2.2). Every first/latest rule
// uses all four components in order.
export interface FirstArrival {
  acquisitionCommittedAt: string
  runId: string
  wireOrdinal: number
  observationVersionId: string
}

export function compareFirstArrival(a: FirstArrival, b: FirstArrival): number {
  if (a.acquisitionCommittedAt !== b.acquisitionCommittedAt) return a.acquisitionCommittedAt < b.acquisitionCommittedAt ? -1 : 1
  if (a.runId !== b.runId) return a.runId < b.runId ? -1 : 1
  if (a.wireOrdinal !== b.wireOrdinal) return a.wireOrdinal - b.wireOrdinal
  if (a.observationVersionId !== b.observationVersionId) return a.observationVersionId < b.observationVersionId ? -1 : 1
  return 0
}

// The strongest evidence level that contains at least one eligible candidate.
function strongestEligibleLevel(levels: EvidenceLevel[]): EvidenceLevel | null {
  let best: EvidenceLevel | null = null
  for (const l of levels) if (best === null || LEVEL_RANK[l] < LEVEL_RANK[best]) best = l
  return best
}

// Public alias (spec §4.3, plan Appendix D): the strongest of a set of levels,
// null when empty — the four-level comparator, verified_origin first.
export function rankAttribution(levels: EvidenceLevel[]): EvidenceLevel | null {
  return strongestEligibleLevel(levels)
}

// ---- display-delivery selection (spec §3.2) ---------------------------------

export interface DeliveryCandidate {
  deliveryId: string
  level: EvidenceLevel
  eligible: boolean
  arrival: FirstArrival
}

export function selectDisplayDelivery(candidates: DeliveryCandidate[], current: string | null): string | null {
  const eligible = candidates.filter((c) => c.eligible)
  const level = strongestEligibleLevel(eligible.map((c) => c.level))
  if (level === null) return null
  const atLevel = eligible.filter((c) => c.level === level)
  if (current !== null && atLevel.some((c) => c.deliveryId === current)) return current
  return atLevel.reduce((a, b) => {
    const byArrival = compareFirstArrival(a.arrival, b.arrival)
    if (byArrival !== 0) return byArrival < 0 ? a : b
    return a.deliveryId <= b.deliveryId ? a : b // stable lexical delivery-id tie-break
  }).deliveryId
}

// ---- author selection is independent (spec §3.2) ----------------------------

export interface AuthorCandidate {
  claimId: string
  publisherId: string
  level: EvidenceLevel
  eligible: boolean
  arrival: FirstArrival
}

export function selectAuthor(candidates: AuthorCandidate[], current: string | null): { publisherId: string; level: EvidenceLevel; observationVersionId: string } | null {
  const eligible = candidates.filter((c) => c.eligible)
  const level = strongestEligibleLevel(eligible.map((c) => c.level))
  if (level === null) return null
  const atLevel = eligible.filter((c) => c.level === level)
  const retained = current !== null ? atLevel.find((c) => c.publisherId === current) : undefined
  const chosen = retained ?? atLevel.reduce((a, b) => {
    const byArrival = compareFirstArrival(a.arrival, b.arrival)
    if (byArrival !== 0) return byArrival < 0 ? a : b
    return a.claimId <= b.claimId ? a : b
  })
  return { publisherId: chosen.publisherId, level: chosen.level, observationVersionId: chosen.arrival.observationVersionId }
}

// ---- publisher-name normalization + selection (spec §3.6) -------------------

// Versioned: NFC; strip C0/C1 and explicit bidi override/isolation controls; trim
// and collapse Unicode whitespace; cap 200 code points; empty is invalid. Other
// format characters are retained (do not damage emoji). Web HTML-escapes the result.
const BIDI = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/gu
const C0C1 = /[\u0000-\u001F\u007F-\u009F]/gu
export function normalizePublisherName(raw: string | null): string | null {
  if (raw == null) return null
  let s = raw.normalize('NFC').replace(C0C1, '').replace(BIDI, '')
  s = s.replace(/\s+/gu, ' ').trim()
  if (s === '') return null
  const cp = [...s]
  return cp.length > 200 ? cp.slice(0, 200).join('') : s
}

export interface NameCandidate {
  level: EvidenceLevel
  arrival: FirstArrival
  sourceId: string
  claimId: string
  name: string
}

export function selectPublisherName(candidates: NameCandidate[], currentSourceId: string | null): string | null {
  if (candidates.length === 0) return null
  // Pick the asserting SOURCE: retain the current source when it still supplies a
  // valid name at the strongest level; else order by level desc, first valid arrival
  // tuple asc, source id, claim id (spec §3.6).
  const level = strongestEligibleLevel(candidates.map((c) => c.level))
  if (level === null) return null
  const atLevel = candidates.filter((c) => c.level === level)
  const bySource = new Map<string, NameCandidate[]>()
  for (const c of atLevel) (bySource.get(c.sourceId) ?? bySource.set(c.sourceId, []).get(c.sourceId)!).push(c)
  let sourceId = currentSourceId !== null && bySource.has(currentSourceId) ? currentSourceId : null
  if (sourceId === null) {
    for (const [sid, cs] of bySource) {
      if (sourceId === null) { sourceId = sid; continue }
      const a = earliest(cs)
      const b = earliest(bySource.get(sourceId)!)
      const cmp = compareFirstArrival(a, b)
      if (cmp < 0 || (cmp === 0 && sid < sourceId)) sourceId = sid
    }
  }
  // Within the selected source, the latest valid full arrival tuple supplies the name.
  const within = bySource.get(sourceId!)!
  return within.reduce((a, b) => {
    const cmp = compareFirstArrival(a.arrival, b.arrival)
    if (cmp !== 0) return cmp > 0 ? a : b
    return a.claimId >= b.claimId ? a : b
  }).name
}

function earliest(cs: NameCandidate[]): FirstArrival {
  return cs.reduce((a, b) => (compareFirstArrival(a.arrival, b.arrival) <= 0 ? a : b)).arrival
}

// ---- presentation chain (spec §4.4) -----------------------------------------

export interface PresentationMaterial {
  title: string | null
  content: string | null
  contentMarkdown: string | null
  permalink: string | null
  sourceLink: string | null
  enclosures: EnclosureDto[]
  inReplyTo: string | null
}

// Canonical presentation fingerprint: ONLY ordinary rendering material. Excludes
// attribution, ancestry ids, publication/update claims, parser diagnostics, and
// acquisition metadata (spec §4.4).
export function presentationFingerprint(m: PresentationMaterial): string {
  const material = {
    title: m.title,
    content: m.content,
    contentMarkdown: m.contentMarkdown,
    permalink: m.permalink,
    sourceLink: m.sourceLink,
    inReplyTo: m.inReplyTo,
    enclosures: m.enclosures.map((e) => [e.url, e.mimeType, e.title, e.sizeBytes, e.durationSeconds]),
  }
  return createHash('sha256').update(JSON.stringify(material)).digest('hex')
}

export interface WatermarkState {
  sequence: number // the current top presentation sequence, -1 before any baseline
  explicitWatermark: string | null
  topFingerprint: string | null
}

export interface PresentationInput {
  materialFingerprint: string
  explicitUpdate: string | null // pre-validated: a normalized UTC instant <= arrival, else null
  arrivalAt: string
}

export type PresentationDecision = {
  entry?: { sequence: number; effectiveUpdatedAt: string | null; provenance: 'explicit' | 'arrival' | null }
  conflict?: 'rollback'
  watermark: string | null
}

// Decide the next presentation entry for one delivery's accepted chain (spec §4.4).
export function nextPresentationEntry(state: WatermarkState, input: PresentationInput): PresentationDecision {
  // baseline: sequence zero.
  if (state.sequence < 0) {
    if (input.explicitUpdate) {
      return { entry: { sequence: 0, effectiveUpdatedAt: input.explicitUpdate, provenance: 'explicit' }, watermark: input.explicitUpdate }
    }
    return { entry: { sequence: 0, effectiveUpdatedAt: null, provenance: null }, watermark: null }
  }
  // unchanged presentation material creates no entry or watermark change.
  if (input.materialFingerprint === state.topFingerprint) return { watermark: state.explicitWatermark }
  // changed material with a valid explicit ts strictly above the watermark: accept.
  if (input.explicitUpdate) {
    if (state.explicitWatermark === null || input.explicitUpdate > state.explicitWatermark) {
      return { entry: { sequence: state.sequence + 1, effectiveUpdatedAt: input.explicitUpdate, provenance: 'explicit' }, watermark: input.explicitUpdate }
    }
    // older-or-equal explicit ts is rollback evidence, not accepted.
    return { conflict: 'rollback', watermark: state.explicitWatermark }
  }
  // changed material with absent/malformed/future ts: accept at arrival, leaving the watermark.
  return { entry: { sequence: state.sequence + 1, effectiveUpdatedAt: input.arrivalAt, provenance: 'arrival' }, watermark: state.explicitWatermark }
}

// ---- shared UTC normalization (spec §3.3) -----------------------------------

export function normalizeUtc(s: string | null): string | null {
  if (s == null || s === '') return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

// =============================================================================
// Read-time ordinary projection (spec §3.1-3.6, §4.3, §4.5) — Task 8
// =============================================================================
// The central projector. Every ordinary read, feed, history, and thread derives
// effective delivery/author/support/classification from the CURRENT snapshot
// (spec §3.1); the stored selected_delivery_id/selected_publisher_id are passed
// to the pure comparators only as `current` hints — a stale hint can never change
// the result. These functions take a ReadTx; the store's snapshot seam binds them.
//
// ponytail: the read-time candidate gathering mirrors reconcile.ts's
// applySelectionHints (which writes the same hints). The pure comparators are the
// shared authority; the two DB gatherings stay in lockstep (reconcile.ts is not a
// Task 8 staged path, so it cannot export the gathering without dragging it in).

function evidenceLevelFor(mode: string): EvidenceLevel {
  return mode === 'aggregate' ? 'aggregate_assertion' : 'bound_single_publisher'
}

// http(s) only, no credentials, no fragment (spec §3.4 URL bounds). Web escapes.
function safeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (u.username || u.password) return null
    u.hash = ''
    return u.toString()
  } catch { return null }
}

function hostnameOf(raw: string | null): string | null {
  const s = safeUrl(raw)
  if (!s) return null
  try { return new URL(s).hostname } catch { return null }
}

interface ItemRow {
  id: string; origin: 'local' | 'remote'; timeline_sort_at: string
  parent_state: LogicalItemDto['parentResolutionState']; parent_logical_item_id: string | null
  selected_delivery_id: string | null; selected_publisher_id: string | null
  hidden_at: string | null; structural_tombstone: number
}

// THE ONE item-level ordinary-visibility gate (spec §1.3). Hidden moderation
// (Task 2) and structural tombstones (Task 6 — inert until then, always 0) join
// here and NOWHERE else: every surface — river, single-item, thread, publisher,
// feeds, SSE — composes projectItem/projectTimeline, so a hidden/tombstoned item
// vanishes from all of them with no per-surface copy. The SQL fragment (on the
// `li` alias) gates the timeline WHERE before ORDER/LIMIT so a hidden row never
// shorts a page; the JS twin gates projectItem. They must stay in lockstep.
const ORDINARY_ITEM_VISIBLE_SQL = `li.hidden_at IS NULL AND li.structural_tombstone = 0`
function ordinaryItemVisible(row: { hidden_at: string | null; structural_tombstone: number }): boolean {
  return row.hidden_at == null && row.structural_tombstone === 0
}
const ITEM_COLUMNS = `id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, hidden_at, structural_tombstone`
interface PostRow {
  id: string; author_id: string; title: string | null; content: string; content_markdown: string | null
  url: string | null; published_at: string; edited_at: string | null
  in_reply_to: string | null; in_reply_to_post_id: string | null; thread_root_id: string | null
}

// The delivery's earliest ordinary-eligible version tuple (reconciled/conflicted
// jobs only). Mirrors reconcile.ts's earliestEligibleVersion but read-time (no
// in-flight version).
function earliestEligibleVersion(tx: ReadTx, deliveryId: string): FirstArrival | null {
  const rows = tx.prepare(
    `SELECT r.acquisition_committed_at AS committed_at, v.run_id, v.wire_ordinal, v.id AS vid, j.status
     FROM observation_versions_v2 v
     JOIN acquisition_runs_v2 r ON r.id = v.run_id
     JOIN reconciliation_jobs_v2 j ON j.observation_version_id = v.id AND j.kind = 'observation'
     WHERE v.delivery_id = ?`,
  ).all(deliveryId) as { committed_at: string; run_id: string; wire_ordinal: number; vid: string; status: string }[]
  const eligible = rows
    .filter((r) => r.status === 'reconciled' || r.status === 'conflicted')
    .map((r): FirstArrival => ({ acquisitionCommittedAt: r.committed_at, runId: r.run_id, wireOrdinal: r.wire_ordinal, observationVersionId: r.vid }))
  if (eligible.length === 0) return null
  return eligible.reduce((a, b) => (compareFirstArrival(a, b) <= 0 ? a : b))
}

interface EligibleDelivery { deliveryId: string; level: EvidenceLevel; arrival: FirstArrival; sourceId: string }

// Ordinary-eligible deliveries of a remote item: identity keys kind='delivery'
// whose source is currently allowed and has a reconciled/conflicted version.
function eligibleDeliveries(tx: ReadTx, itemId: string): EligibleDelivery[] {
  const keys = tx.prepare(`SELECT key FROM logical_identity_keys_v2 WHERE kind = 'delivery' AND logical_item_id = ?`).all(itemId) as { key: string }[]
  const out: EligibleDelivery[] = []
  for (const { key: deliveryId } of keys) {
    const meta = tx.prepare(`SELECT d.source_id, s.attribution_mode, s.governance FROM deliveries_v2 d JOIN remote_sources_v2 s ON s.id = d.source_id WHERE d.id = ?`).get(deliveryId) as { source_id: string; attribution_mode: string; governance: string } | undefined
    if (!meta || meta.governance !== 'allowed') continue
    const arrival = earliestEligibleVersion(tx, deliveryId)
    if (!arrival) continue
    out.push({ deliveryId, level: evidenceLevelFor(meta.attribution_mode), arrival, sourceId: meta.source_id })
  }
  return out
}

// The effective display delivery of a remote item, re-derived (never the raw hint).
function selectedDeliveryFor(tx: ReadTx, item: ItemRow): EligibleDelivery | null {
  const cands = eligibleDeliveries(tx, item.id)
  if (cands.length === 0) return null
  const chosen = selectDisplayDelivery(cands.map((d) => ({ deliveryId: d.deliveryId, level: d.level, eligible: true, arrival: d.arrival })), item.selected_delivery_id)
  return cands.find((d) => d.deliveryId === chosen) ?? null
}

function eligibleAuthorClaims(tx: ReadTx, itemId: string): AuthorCandidate[] {
  const rows = tx.prepare(
    `SELECT c.id AS claim_id, c.publisher_id, c.evidence_level,
            r.acquisition_committed_at AS committed_at, v.run_id, v.wire_ordinal, v.id AS vid, s.governance, j.status
     FROM publisher_claims_v2 c
     JOIN observation_versions_v2 v ON v.id = c.observation_version_id
     JOIN acquisition_runs_v2 r ON r.id = v.run_id
     JOIN reconciliation_jobs_v2 j ON j.observation_version_id = v.id AND j.kind = 'observation'
     JOIN remote_sources_v2 s ON s.id = c.source_id
     WHERE c.logical_item_id = ?`,
  ).all(itemId) as { claim_id: string; publisher_id: string; evidence_level: EvidenceLevel; committed_at: string; run_id: string; wire_ordinal: number; vid: string; governance: string; status: string }[]
  return rows
    .filter((a) => a.governance === 'allowed' && (a.status === 'reconciled' || a.status === 'conflicted'))
    .map((a) => ({ claimId: a.claim_id, publisherId: a.publisher_id, level: a.evidence_level, eligible: true, arrival: { acquisitionCommittedAt: a.committed_at, runId: a.run_id, wireOrdinal: a.wire_ordinal, observationVersionId: a.vid } }))
}

// The effective public name of a publisher (spec §3.6): reconciled names from
// currently-allowed sources only.
function publisherName(tx: ReadTx, publisherId: string): string | null {
  const rows = tx.prepare(
    `SELECT n.id AS claim_id, n.evidence_level, n.source_id, n.normalized_name,
            r.acquisition_committed_at AS committed_at, v.run_id, v.wire_ordinal, v.id AS vid, s.governance
     FROM publisher_names_v2 n
     JOIN observation_versions_v2 v ON v.id = n.observation_version_id
     JOIN acquisition_runs_v2 r ON r.id = v.run_id
     JOIN remote_sources_v2 s ON s.id = n.source_id
     WHERE n.publisher_id = ?`,
  ).all(publisherId) as { claim_id: string; evidence_level: EvidenceLevel; source_id: string; normalized_name: string | null; committed_at: string; run_id: string; wire_ordinal: number; vid: string; governance: string }[]
  const cands: NameCandidate[] = rows
    .filter((r) => r.governance === 'allowed' && r.normalized_name != null && r.normalized_name !== '')
    .map((r) => ({ level: r.evidence_level, arrival: { acquisitionCommittedAt: r.committed_at, runId: r.run_id, wireOrdinal: r.wire_ordinal, observationVersionId: r.vid }, sourceId: r.source_id, claimId: r.claim_id, name: r.normalized_name as string }))
  return selectPublisherName(cands, null)
}

function remoteVisible(tx: ReadTx, itemId: string): boolean {
  return eligibleDeliveries(tx, itemId).length > 0
}

// Whether a direct/descendant node counts as ordinary-visible (spec §3.4: retained
// unavailable evidence and placeholders never count).
// Exported as the reply-target gate: a LOCAL reply may target exactly what
// ordinary reads can show — a local post or an ordinary-visible remote item.
export function itemOrdinaryVisible(tx: ReadTx, id: string): boolean {
  return nodeVisible(tx, id)
}
function nodeVisible(tx: ReadTx, id: string): boolean {
  const post = tx.prepare(`SELECT 1 FROM posts WHERE id = ? AND source = 'local'`).get(id)
  if (post) return true
  const li = tx.prepare(`SELECT origin FROM logical_items_v2 WHERE id = ?`).get(id) as { origin: string } | undefined
  if (!li || li.origin !== 'remote') return false
  return remoteVisible(tx, id)
}

// Direct resolved children of a logical item (local via posts.in_reply_to_post_id,
// remote via logical_items_v2.parent_logical_item_id).
function childIds(tx: ReadTx, id: string): string[] {
  const local = (tx.prepare(`SELECT id FROM posts WHERE source = 'local' AND in_reply_to_post_id = ?`).all(id) as { id: string }[]).map((r) => r.id)
  const remote = (tx.prepare(`SELECT id FROM logical_items_v2 WHERE origin = 'remote' AND parent_state = 'resolved' AND parent_logical_item_id = ?`).all(id) as { id: string }[]).map((r) => r.id)
  return [...local, ...remote]
}

const COUNT_NODE_BOUND = 5000
// ponytail: per-item O(subtree) BFS for reply counts — bounded at 5000 nodes. A
// materialized denormalized count is the upgrade path if a hot conversation slows.
function replyCounts(tx: ReadTx, id: string): { direct: number; conversation: number } {
  let direct = 0
  let conversation = 0
  const seen = new Set<string>([id])
  let level = childIds(tx, id)
  let depth = 0
  while (level.length && seen.size < COUNT_NODE_BOUND) {
    const next: string[] = []
    for (const cid of level) {
      if (seen.has(cid)) continue
      seen.add(cid)
      if (!nodeVisible(tx, cid)) continue
      if (depth === 0) direct++
      conversation++
      for (const gc of childIds(tx, cid)) next.push(gc)
    }
    level = next
    depth++
  }
  return { direct, conversation }
}

function remoteThreadRoot(tx: ReadTx, parentId: string): string {
  const q = tx.prepare(`SELECT parent_state, parent_logical_item_id FROM logical_items_v2 WHERE id = ?`)
  let root = parentId
  let cur: string | null = parentId
  for (let i = 0; i < 1000 && cur; i++) {
    const row = q.get(cur) as { parent_state: string; parent_logical_item_id: string | null } | undefined
    root = cur
    if (!row || row.parent_state !== 'resolved' || !row.parent_logical_item_id) break
    cur = row.parent_logical_item_id
  }
  return root
}

function personalLocal(tx: ReadTx, authorId: string, account: string | null): boolean {
  if (!account) return false
  if (authorId === account) return true
  return tx.prepare(`SELECT 1 FROM follows WHERE follower_id = ? AND followed_id = ?`).get(account, authorId) !== undefined
}

function personalRemote(tx: ReadTx, itemId: string, account: string | null): boolean {
  if (!account) return false
  return tx.prepare(
    `SELECT 1 FROM logical_identity_keys_v2 ik
       JOIN deliveries_v2 d ON d.id = ik.key
       JOIN remote_sources_v2 s ON s.id = d.source_id
       JOIN source_subscriptions_v2 sub ON sub.source_id = s.id
     WHERE ik.kind = 'delivery' AND ik.logical_item_id = ? AND s.governance = 'allowed'
       AND sub.owner_id = ? AND sub.state = 'active' LIMIT 1`,
  ).get(itemId, account) !== undefined
}

function federatedRemote(tx: ReadTx, itemId: string): boolean {
  return tx.prepare(
    `SELECT 1 FROM logical_identity_keys_v2 ik
       JOIN deliveries_v2 d ON d.id = ik.key
       JOIN remote_sources_v2 s ON s.id = d.source_id
       JOIN federation_relationships_v2 f ON f.source_id = s.id
     WHERE ik.kind = 'delivery' AND ik.logical_item_id = ? AND s.governance = 'allowed'
       AND f.status = 'approved' LIMIT 1`,
  ).get(itemId) !== undefined
}

interface RemoteMaterial {
  title: string | null; content: string | null; link: string | null; inReplyTo: string | null
}
function materialOf(tx: ReadTx, versionId: string): { material: RemoteMaterial; normalized: { permalink: string | null; enclosures: EnclosureDto[]; inReplyTo: string | null } } | null {
  const v = tx.prepare(`SELECT canonical_material, normalized_json FROM observation_versions_v2 WHERE id = ?`).get(versionId) as { canonical_material: Buffer; normalized_json: string } | undefined
  if (!v) return null
  const material = JSON.parse(v.canonical_material.toString('utf8')) as RemoteMaterial
  const normalized = JSON.parse(v.normalized_json) as { permalink: string | null; enclosures: EnclosureDto[]; inReplyTo: string | null }
  return { material, normalized }
}

function projectEnclosures(encs: EnclosureDto[] | undefined): EnclosureDto[] {
  return (encs ?? [])
    .filter((e) => safeUrl(e.url) != null)
    .slice(0, 32)
    .map((e) => ({ url: safeUrl(e.url) as string, mimeType: e.mimeType ?? null, title: e.title ?? null, sizeBytes: e.sizeBytes ?? null, durationSeconds: e.durationSeconds ?? null }))
}

// Build the selectedAuthor DTO for a remote item's chosen publisher (or a
// source-scoped fallback when no eligible author claim supports it).
function remoteAuthor(tx: ReadTx, item: ItemRow, display: EligibleDelivery): SelectedAuthor {
  const claim = selectAuthor(eligibleAuthorClaims(tx, item.id), item.selected_publisher_id)
  if (!claim) {
    const src = tx.prepare(`SELECT canonical_url FROM remote_sources_v2 WHERE id = ?`).get(display.sourceId) as { canonical_url: string } | undefined
    return { kind: 'remote_publisher', id: display.sourceId, displayName: hostnameOf(src?.canonical_url ?? null) ?? 'Remote publisher', canonicalFeedUrl: null, profileAvailable: false, attributionLevel: 'source_scoped_fallback' }
  }
  const pub = tx.prepare(`SELECT canonical_feed_url, identity_level FROM remote_publishers_v2 WHERE id = ?`).get(claim.publisherId) as { canonical_feed_url: string | null; identity_level: string } | undefined
  const url = safeUrl(pub?.canonical_feed_url ?? null)
  const navigable = pub?.identity_level === 'feed_anchored' && url != null
  return {
    kind: 'remote_publisher',
    id: claim.publisherId,
    // The byline is the ITEM'S OWN assertion first (v1's <source> byline rule):
    // on an aggregate every item claims the same shared publisher, so the
    // publisher-level name is some OTHER item's author (or nothing). Only when
    // this item's claims assert no name does the publisher-level name — and
    // then the hostname — speak for it.
    displayName: itemAssertedName(tx, item.id, claim.observationVersionId) ?? publisherName(tx, claim.publisherId) ?? hostnameOf(pub?.canonical_feed_url ?? null) ?? 'Remote publisher',
    canonicalFeedUrl: navigable ? url : null,
    profileAvailable: navigable,
    attributionLevel: claim.level,
  }
}

// The name evidence written by THIS item's claims: the selected claim's own
// observation first, then the strongest-level assertion among the item's other
// eligible claims (covers a nameless just-minted verified publisher whose item
// still carries the aggregate's <source> assertion).
function itemAssertedName(tx: ReadTx, itemId: string, selectedVersionId: string): string | null {
  const rows = tx.prepare(
    `SELECT n.normalized_name, n.evidence_level, c.observation_version_id FROM publisher_names_v2 n
     JOIN publisher_claims_v2 c ON c.observation_version_id = n.observation_version_id AND c.publisher_id = n.publisher_id
     JOIN remote_sources_v2 s ON s.id = n.source_id
     WHERE c.logical_item_id = ? AND n.normalized_name IS NOT NULL AND s.governance = 'allowed'`,
  ).all(itemId) as { normalized_name: string; evidence_level: EvidenceLevel; observation_version_id: string }[]
  if (rows.length === 0) return null
  const own = rows.find((r) => r.observation_version_id === selectedVersionId)
  if (own) return own.normalized_name
  return rows.reduce((a, b) => (LEVEL_RANK[a.evidence_level] <= LEVEL_RANK[b.evidence_level] ? a : b)).normalized_name
}

function projectLocal(tx: ReadTx, post: PostRow, viewer: ProjectionViewer): LogicalItemDto {
  const author = tx.prepare(`SELECT id, handle, display_name FROM users WHERE id = ?`).get(post.author_id) as { id: string; handle: string; display_name: string } | undefined
  const state: LogicalItemDto['parentResolutionState'] = post.in_reply_to_post_id ? 'resolved' : 'none'
  const counts = replyCounts(tx, post.id)
  return {
    kind: 'logical_item',
    id: post.id,
    origin: 'local',
    parentResolutionState: state,
    parentLogicalItemId: post.in_reply_to_post_id,
    threadRootId: post.in_reply_to_post_id ? post.thread_root_id : null,
    selectedAuthor: { kind: 'local', id: post.author_id, handle: author?.handle ?? '', displayName: author?.display_name ?? '' },
    title: post.title,
    content: post.content,
    contentMarkdown: post.content_markdown,
    permalink: safeUrl(post.url),
    inReplyToRef: post.in_reply_to, // the stored absolute wire ref, re-emitted as <source:inReplyTo>
    sourceLink: null,
    replyContext: null,
    enclosures: [],
    publishedAt: post.published_at,
    updatedAt: post.edited_at,
    updatedAtProvenance: post.edited_at ? 'explicit' : null,
    directReplyCount: counts.direct,
    conversationReplyCount: counts.conversation,
    classification: { personal: personalLocal(tx, post.author_id, viewer.localAccountId), federated: false },
  }
}

function projectRemote(tx: ReadTx, item: ItemRow, viewer: ProjectionViewer): LogicalItemDto | undefined {
  const display = selectedDeliveryFor(tx, item)
  if (!display) return undefined // no ordinary-eligible delivery ⇒ unavailable
  const pres = tx.prepare(`SELECT observation_version_id, effective_updated_at, provenance FROM presentation_entries_v2 WHERE delivery_id = ? ORDER BY sequence DESC LIMIT 1`).get(display.deliveryId) as { observation_version_id: string; effective_updated_at: string | null; provenance: 'explicit' | 'arrival' | null } | undefined
  if (!pres) return undefined
  const mat = materialOf(tx, pres.observation_version_id)
  if (!mat) return undefined
  const counts = replyCounts(tx, item.id)
  const state = item.parent_state
  let replyContext: LogicalItemDto['replyContext'] = null
  if (state === 'missing' || state === 'ambiguous') {
    const url = safeUrl(mat.material.inReplyTo)
    if (url) replyContext = { kind: 'asserted_external', authorLabel: null, snippet: null, url }
  }
  return {
    kind: 'logical_item',
    id: item.id,
    origin: 'remote',
    parentResolutionState: state,
    parentLogicalItemId: state === 'resolved' ? item.parent_logical_item_id : null,
    threadRootId: state === 'resolved' && item.parent_logical_item_id ? remoteThreadRoot(tx, item.parent_logical_item_id) : null,
    selectedAuthor: remoteAuthor(tx, item, display),
    title: mat.material.title,
    content: mat.material.content,
    contentMarkdown: null,
    permalink: safeUrl(mat.normalized.permalink ?? mat.material.link),
    inReplyToRef: null, // remote items keep the current firehose/comments behavior (no source:inReplyTo re-emit)
    sourceLink: safeUrl(mat.material.link),
    replyContext,
    enclosures: projectEnclosures(mat.normalized.enclosures),
    publishedAt: item.timeline_sort_at,
    updatedAt: pres.effective_updated_at,
    updatedAtProvenance: pres.provenance,
    directReplyCount: counts.direct,
    conversationReplyCount: counts.conversation,
    classification: { personal: personalRemote(tx, item.id, viewer.localAccountId), federated: federatedRemote(tx, item.id) },
  }
}

// A structural tombstone (spec §5.3): the terminal remote state retaining only
// logical ID, parent/root edges, and the immutable sort key. Shared read used by
// the reconciliation arrival guard and threading's adoption/parent guards so an
// arriving delivery or reply never resurrects or adopts one.
export function isStructuralTombstone(tx: ReadTx, id: string): boolean {
  const r = tx.prepare(`SELECT structural_tombstone FROM logical_items_v2 WHERE id = ?`).get(id) as { structural_tombstone: number } | undefined
  return r?.structural_tombstone === 1
}

// Project one logical item to its ordinary DTO, or undefined when it is not
// currently ordinary-visible (spec §3.4). Local id === post.id; a live local post
// projects directly (no logical row needed); a deleted/absent local post ⇒ undefined.
export function projectItem(tx: ReadTx, id: string, viewer: ProjectionViewer): LogicalItemDto | undefined {
  const post = tx.prepare(
    `SELECT id, author_id, title, content, content_markdown, url, published_at, edited_at, in_reply_to, in_reply_to_post_id, thread_root_id
     FROM posts WHERE id = ? AND source = 'local'`,
  ).get(id) as PostRow | undefined
  if (post) return projectLocal(tx, post, viewer)
  const li = tx.prepare(`SELECT ${ITEM_COLUMNS} FROM logical_items_v2 WHERE id = ?`).get(id) as ItemRow | undefined
  if (!li || li.origin !== 'remote') return undefined
  if (!ordinaryItemVisible(li)) return undefined // hidden/tombstoned ⇒ not ordinary-visible (spec §1.3)
  return projectRemote(tx, li, viewer)
}

// --- lens resolution (spec §3.5-3.6) ----------------------------------------

export function resolveLocalAccount(tx: ReadTx, handle: string): PublicLocalAccount | undefined {
  const u = tx.prepare(`SELECT id, handle, display_name FROM users WHERE handle = ? AND kind = 'local'`).get(handle.toLowerCase()) as { id: string; handle: string; display_name: string } | undefined
  return u ? { id: u.id, handle: u.handle, displayName: u.display_name } : undefined
}

// A publisher page exists only for a feed-anchored, ordinary-safe, evidence-backed
// publisher (spec §3.6). Everything else is the neutral ordinary 404.
export function resolvePublisher(tx: ReadTx, publisherId: string): PublicPublisher | undefined {
  const p = tx.prepare(`SELECT id, canonical_feed_url, identity_level FROM remote_publishers_v2 WHERE id = ?`).get(publisherId) as { id: string; canonical_feed_url: string | null; identity_level: string } | undefined
  if (!p || p.identity_level !== 'feed_anchored') return undefined
  const url = safeUrl(p.canonical_feed_url)
  if (!url) return undefined
  const supported = tx.prepare(`SELECT 1 FROM publisher_claims_v2 pc JOIN remote_sources_v2 s ON s.id = pc.source_id WHERE pc.publisher_id = ? AND s.governance = 'allowed' LIMIT 1`).get(publisherId)
  if (!supported) return undefined
  return { id: p.id, displayName: publisherName(tx, publisherId) ?? hostnameOf(url) ?? 'Remote publisher', canonicalFeedUrl: url, identityLevel: 'feed_anchored' }
}

// --- timeline (spec §3.3, §3.5) ---------------------------------------------

// A delivery must be BOTH ordinary-eligible (governance allowed, some version's
// job reconciled/conflicted — same criterion as eligibleDeliveries/
// earliestEligibleVersion) AND have a presentation entry: gating on entry
// existence alone (governance-blind to job status) can admit a delivery whose
// job later regressed while its entry lingers, over-counting a row LIMIT
// cannot then render (projectRemote drops it), shorting the page.
const REMOTE_VISIBLE = `EXISTS (SELECT 1 FROM logical_identity_keys_v2 ik JOIN deliveries_v2 d ON d.id = ik.key JOIN remote_sources_v2 s ON s.id = d.source_id WHERE ik.kind = 'delivery' AND ik.logical_item_id = li.id AND s.governance = 'allowed' AND EXISTS (SELECT 1 FROM presentation_entries_v2 pe WHERE pe.delivery_id = d.id) AND EXISTS (SELECT 1 FROM observation_versions_v2 v JOIN reconciliation_jobs_v2 j ON j.observation_version_id = v.id AND j.kind = 'observation' WHERE v.delivery_id = d.id AND j.status IN ('reconciled', 'conflicted')))`
const REMOTE_SUBSCRIBED = `EXISTS (SELECT 1 FROM logical_identity_keys_v2 ik JOIN deliveries_v2 d ON d.id = ik.key JOIN remote_sources_v2 s ON s.id = d.source_id JOIN source_subscriptions_v2 sub ON sub.source_id = s.id WHERE ik.kind = 'delivery' AND ik.logical_item_id = li.id AND s.governance = 'allowed' AND sub.owner_id = ? AND sub.state = 'active')`
const REMOTE_FEDERATED = `EXISTS (SELECT 1 FROM logical_identity_keys_v2 ik JOIN deliveries_v2 d ON d.id = ik.key JOIN remote_sources_v2 s ON s.id = d.source_id JOIN federation_relationships_v2 f ON f.source_id = s.id WHERE ik.kind = 'delivery' AND ik.logical_item_id = li.id AND s.governance = 'allowed' AND f.status = 'approved')`

// Conversation-entry (river) lenses include roots + unresolved replies and EXCLUDE
// resolved replies; activity lenses (local_author, publisher) include resolved
// replies (spec §3.5). The predicate is applied in SQL WITH visibility and lens
// membership BEFORE ordering, cursor, and LIMIT — never post-page.
function isRiverLens(kind: TimelineLens['kind']): boolean {
  return kind === 'public' || kind === 'local' || kind === 'personal' || kind === 'federated'
}

export function projectTimeline(tx: ReadTx, query: TimelineQuery): LogicalTimelineEnvelope {
  const { lens, before, limit, viewer } = query
  const river = isRiverLens(lens.kind)
  const parts: string[] = []
  const params: unknown[] = []

  const wantsLocal = lens.kind === 'public' || lens.kind === 'local' || lens.kind === 'personal' || lens.kind === 'local_author'
  const wantsRemote = lens.kind === 'public' || lens.kind === 'personal' || lens.kind === 'federated' || lens.kind === 'publisher'

  if (wantsLocal) {
    let w = `p.source = 'local'`
    if (river) w += ` AND p.in_reply_to_post_id IS NULL`
    if (lens.kind === 'personal') { w += ` AND (p.author_id = ? OR p.author_id IN (SELECT followed_id FROM follows WHERE follower_id = ?))`; params.push(lens.account.id, lens.account.id) }
    if (lens.kind === 'local_author') { w += ` AND p.author_id = ?`; params.push(lens.account.id) }
    parts.push(`SELECT p.id AS id, p.published_at AS sort_at FROM posts p WHERE ${w}`)
  }
  if (wantsRemote) {
    let w = `li.origin = 'remote' AND ${ORDINARY_ITEM_VISIBLE_SQL} AND ${REMOTE_VISIBLE}`
    if (river) w += ` AND li.parent_state IN ('none','missing','ambiguous')`
    if (lens.kind === 'personal') { w += ` AND ${REMOTE_SUBSCRIBED}`; params.push(lens.account.id) }
    if (lens.kind === 'federated') { w += ` AND ${REMOTE_FEDERATED}` }
    if (lens.kind === 'publisher') { w += ` AND EXISTS (SELECT 1 FROM publisher_claims_v2 pc JOIN remote_sources_v2 s2 ON s2.id = pc.source_id WHERE pc.logical_item_id = li.id AND pc.publisher_id = ? AND s2.governance = 'allowed')`; params.push(lens.publisher.id) }
    parts.push(`SELECT li.id AS id, li.timeline_sort_at AS sort_at FROM logical_items_v2 li WHERE ${w}`)
  }

  let sql = `SELECT id, sort_at FROM (${parts.join(' UNION ALL ')}) u`
  if (before) { sql += ` WHERE (sort_at < ? OR (sort_at = ? AND id < ?))`; params.push(before.timelineSortAt, before.timelineSortAt, before.logicalItemId) }
  sql += ` ORDER BY sort_at DESC, id DESC LIMIT ?`
  params.push(limit + 1)

  const rows = tx.prepare(sql).all(...params) as { id: string; sort_at: string }[]
  const page = rows.slice(0, limit)
  const timeline: LogicalItemDto[] = []
  for (const r of page) {
    const dto = projectItem(tx, r.id, viewer)
    if (dto) timeline.push(dto) // aligned with the SQL visibility predicate; defensive
  }
  const last = page[page.length - 1]
  const nextCursor = rows.length > limit && last ? encodeCursor(1, [last.sort_at, last.id]) : null
  return { model: 'logical-v2', lens, timeline, nextCursor, journalCursor: snapshotJournalCursor(tx) }
}

// Local activity population for the central-projector feeds (spec §4.6): the
// firehose (`origin=local` WITHOUT the river predicate) and local-account feeds
// (local_author activity). Both transport local replies, so no river filter here.
export function projectLocalActivity(tx: ReadTx, opts: { authorId: string | null; limit: number }): LogicalItemDto[] {
  const rows = (opts.authorId
    ? tx.prepare(`SELECT id FROM posts WHERE source = 'local' AND author_id = ? ORDER BY published_at DESC, id DESC LIMIT ?`).all(opts.authorId, opts.limit)
    : tx.prepare(`SELECT id FROM posts WHERE source = 'local' ORDER BY published_at DESC, id DESC LIMIT ?`).all(opts.limit)) as { id: string }[]
  const anon: ProjectionViewer = { localAccountId: null, activeSourceIds: [] }
  const out: LogicalItemDto[] = []
  for (const r of rows) { const d = projectItem(tx, r.id, anon); if (d) out.push(d) }
  return out
}

// --- history (spec §4.5) -----------------------------------------------------

export function projectHistory(tx: ReadTx, id: string, viewer: ProjectionViewer): LogicalHistoryEnvelope | undefined {
  if (!projectItem(tx, id, viewer)) return undefined
  const post = tx.prepare(
    `SELECT id, author_id, title, content, content_markdown, url, published_at, edited_at, in_reply_to, in_reply_to_post_id, thread_root_id FROM posts WHERE id = ? AND source = 'local'`,
  ).get(id) as PostRow | undefined
  if (post) {
    const revs = tx.prepare(`SELECT title, content, content_markdown FROM post_revisions WHERE post_id = ? ORDER BY seen_at ASC`).all(id) as { title: string | null; content: string; content_markdown: string | null }[]
    const chain = [
      ...revs.map((r) => ({ title: r.title, content: r.content, markdown: r.content_markdown, updatedAt: null as string | null, provenance: null as 'explicit' | 'arrival' | null })),
      { title: post.title, content: post.content, markdown: post.content_markdown, updatedAt: post.edited_at, provenance: (post.edited_at ? 'explicit' : null) as 'explicit' | 'arrival' | null },
    ]
    return {
      model: 'logical-v2', logicalItemId: id, origin: 'local',
      entries: chain.map((e, i) => ({ sequence: i, title: e.title, content: e.content, markdown: e.markdown, permalink: safeUrl(post.url), enclosures: [], updatedAt: e.updatedAt, updatedAtProvenance: e.provenance, current: i === chain.length - 1 })),
      currentSequence: chain.length - 1,
      journalCursor: snapshotJournalCursor(tx),
    }
  }
  const li = tx.prepare(`SELECT ${ITEM_COLUMNS} FROM logical_items_v2 WHERE id = ?`).get(id) as ItemRow | undefined
  if (!li) return undefined
  const display = selectedDeliveryFor(tx, li)
  if (!display) return undefined
  const pres = tx.prepare(`SELECT sequence, observation_version_id, effective_updated_at, provenance FROM presentation_entries_v2 WHERE delivery_id = ? ORDER BY sequence ASC`).all(display.deliveryId) as { sequence: number; observation_version_id: string; effective_updated_at: string | null; provenance: 'explicit' | 'arrival' | null }[]
  const top = pres.length ? pres[pres.length - 1].sequence : 0
  return {
    model: 'logical-v2', logicalItemId: id, origin: 'remote',
    entries: pres.map((p) => {
      const mat = materialOf(tx, p.observation_version_id)
      return { sequence: p.sequence, title: mat?.material.title ?? null, content: mat?.material.content ?? null, markdown: null, permalink: safeUrl(mat?.normalized.permalink ?? mat?.material.link ?? null), enclosures: projectEnclosures(mat?.normalized.enclosures), updatedAt: p.effective_updated_at, updatedAtProvenance: p.provenance, current: p.sequence === top }
    }),
    currentSequence: top,
    journalCursor: snapshotJournalCursor(tx),
  }
}
