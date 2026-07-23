import { createHash } from 'node:crypto'
import type { EnclosureDto } from './types.ts'

// Pure effective-selection and presentation-chain comparators (spec §3.2, §3.3,
// §3.6, §4.4). NO database access — reconciliation calls these to write hints and
// ordinary reads (Task 8) call the SAME functions to re-derive effective state, so
// stored selected-delivery/author/name fields are never authority (spec §3.1).

export type EvidenceLevel =
  | 'bound_single_publisher'
  | 'aggregate_assertion'
  | 'source_scoped_fallback'

// Strongest first (rank 0). Vertical 3 prepends a verified-origin rung; because the
// comparator is strongest-first, that is purely additive (spec §3.2, review rev 1 P2).
export const LEVEL_RANK: Record<EvidenceLevel, number> = {
  bound_single_publisher: 0,
  aggregate_assertion: 1,
  source_scoped_fallback: 2,
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

export function selectAuthor(candidates: AuthorCandidate[], current: string | null): { publisherId: string; level: EvidenceLevel } | null {
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
  return { publisherId: chosen.publisherId, level: chosen.level }
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
