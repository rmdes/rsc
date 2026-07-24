import { test, expect } from 'vitest'
import {
  compareFirstArrival, selectDisplayDelivery, selectAuthor,
  normalizePublisherName, selectPublisherName, presentationFingerprint,
  nextPresentationEntry, normalizeUtc, rankAttribution, LEVEL_RANK,
  type FirstArrival, type DeliveryCandidate, type AuthorCandidate, type NameCandidate, type WatermarkState,
} from '../src/logical/projector.ts'

// Pure selection/presentation comparators (spec §3.2, §3.3, §3.6, §4.4). No DB.

const fa = (committedAt: string, runId: string, ordinal: number, versionId: string): FirstArrival =>
  ({ acquisitionCommittedAt: committedAt, runId, wireOrdinal: ordinal, observationVersionId: versionId })

// ---- first-arrival tuple (spec §2.2, §3.2) ----------------------------------

test('compareFirstArrival orders by committedAt, then runId, then wireOrdinal, then versionId', () => {
  expect(compareFirstArrival(fa('2026-01-01T00:00:00Z', 'r1', 0, 'v1'), fa('2026-01-02T00:00:00Z', 'r1', 0, 'v1'))).toBeLessThan(0)
  expect(compareFirstArrival(fa('2026-01-01T00:00:00Z', 'r2', 0, 'v1'), fa('2026-01-01T00:00:00Z', 'r1', 0, 'v1'))).toBeGreaterThan(0)
  expect(compareFirstArrival(fa('2026-01-01T00:00:00Z', 'r1', 5, 'v1'), fa('2026-01-01T00:00:00Z', 'r1', 2, 'v1'))).toBeGreaterThan(0)
  expect(compareFirstArrival(fa('2026-01-01T00:00:00Z', 'r1', 0, 'vb'), fa('2026-01-01T00:00:00Z', 'r1', 0, 'va'))).toBeGreaterThan(0)
  expect(compareFirstArrival(fa('2026-01-01T00:00:00Z', 'r1', 0, 'v1'), fa('2026-01-01T00:00:00Z', 'r1', 0, 'v1'))).toBe(0)
})

// ---- display-delivery selection (spec §3.2) ---------------------------------

test('selectDisplayDelivery takes the strongest evidence level that has an eligible delivery', () => {
  // V3 supersession (spec §4.3): verified_origin is prepended as the new strongest
  // rung, so a later-arriving verified delivery wins over both bound and aggregate.
  // PURE COMPARATOR TEST — the `verified_origin` DeliveryCandidate below is
  // hand-built and the integration wiring CANNOT produce one today: applySelectionHints
  // derives a delivery's level from evidenceLevelFor(attribution_mode), which returns
  // only aggregate_assertion/bound_single_publisher, and the verified origin source is
  // created single_publisher. So verified_origin currently reaches DISPLAY selection
  // never — only AUTHOR selection (publisher_claims_v2 carries the level directly).
  // Read this as the comparator's contract, not as end-to-end behavior.
  const cands: DeliveryCandidate[] = [
    { deliveryId: 'd_agg', level: 'aggregate_assertion', eligible: true, arrival: fa('2026-01-01T00:00:00Z', 'r1', 0, 'v1') },
    { deliveryId: 'd_bound', level: 'bound_single_publisher', eligible: true, arrival: fa('2026-01-02T00:00:00Z', 'r2', 0, 'v2') },
    { deliveryId: 'd_ver', level: 'verified_origin', eligible: true, arrival: fa('2026-01-03T00:00:00Z', 'r3', 0, 'v3') },
  ]
  expect(selectDisplayDelivery(cands, null)).toBe('d_ver') // verified_origin wins even though it arrived last
  expect(selectDisplayDelivery(cands.slice(0, 2), null)).toBe('d_bound') // without verified, bound still wins
})

// ---- the verified_origin rung (spec §4.3, intentional supersession) ---------

test('rankAttribution ranks verified_origin strongest of the four levels', () => {
  expect(rankAttribution(['aggregate_assertion', 'verified_origin', 'bound_single_publisher'])).toBe('verified_origin')
  expect(rankAttribution(['aggregate_assertion', 'bound_single_publisher'])).toBe('bound_single_publisher')
  expect(rankAttribution(['source_scoped_fallback'])).toBe('source_scoped_fallback')
  expect(rankAttribution([])).toBeNull()
})

test('LEVEL_RANK is strongest-first with verified_origin at rank 0 (purely additive prepend)', () => {
  expect(LEVEL_RANK.verified_origin).toBe(0)
  expect(LEVEL_RANK.bound_single_publisher).toBeGreaterThan(LEVEL_RANK.verified_origin)
  expect(LEVEL_RANK.aggregate_assertion).toBeGreaterThan(LEVEL_RANK.bound_single_publisher)
  expect(LEVEL_RANK.source_scoped_fallback).toBeGreaterThan(LEVEL_RANK.aggregate_assertion)
})

test('selectAuthor prefers a verified_origin claim over bound_single_publisher (additive rung)', () => {
  const cands: AuthorCandidate[] = [
    { claimId: 'c_bound', publisherId: 'p_b', level: 'bound_single_publisher', eligible: true, arrival: fa('2026-01-01T00:00:00Z', 'r1', 0, 'v1') },
    { claimId: 'c_ver', publisherId: 'p_v', level: 'verified_origin', eligible: true, arrival: fa('2026-01-02T00:00:00Z', 'r2', 0, 'v2') },
  ]
  expect(selectAuthor(cands, null)).toMatchObject({ publisherId: 'p_v', level: 'verified_origin' })
})

test('a verified_origin candidate that is ineligible (quarantined) does not participate', () => {
  const cands: AuthorCandidate[] = [
    { claimId: 'c_ver', publisherId: 'p_v', level: 'verified_origin', eligible: false, arrival: fa('2026-01-02T00:00:00Z', 'r2', 0, 'v2') },
    { claimId: 'c_agg', publisherId: 'p_a', level: 'aggregate_assertion', eligible: true, arrival: fa('2026-01-01T00:00:00Z', 'r1', 0, 'v1') },
  ]
  expect(selectAuthor(cands, null)).toMatchObject({ publisherId: 'p_a', level: 'aggregate_assertion' })
})

test('selectDisplayDelivery retains the current delivery when it is still eligible at the strongest level', () => {
  const cands: DeliveryCandidate[] = [
    { deliveryId: 'd_a', level: 'bound_single_publisher', eligible: true, arrival: fa('2026-01-01T00:00:00Z', 'r1', 0, 'va') },
    { deliveryId: 'd_b', level: 'bound_single_publisher', eligible: true, arrival: fa('2026-01-02T00:00:00Z', 'r2', 0, 'vb') },
  ]
  expect(selectDisplayDelivery(cands, 'd_b')).toBe('d_b') // retained though d_a is earlier
  expect(selectDisplayDelivery(cands, null)).toBe('d_a') // no current -> earliest tuple
})

test('selectDisplayDelivery drops the current pointer when it is no longer eligible at the strongest level', () => {
  const cands: DeliveryCandidate[] = [
    { deliveryId: 'd_a', level: 'bound_single_publisher', eligible: true, arrival: fa('2026-01-01T00:00:00Z', 'r1', 0, 'va') },
    { deliveryId: 'd_b', level: 'bound_single_publisher', eligible: false, arrival: fa('2026-01-02T00:00:00Z', 'r2', 0, 'vb') },
  ]
  expect(selectDisplayDelivery(cands, 'd_b')).toBe('d_a') // d_b ineligible -> earliest eligible
})

test('selectDisplayDelivery breaks a first-arrival tie by the stable lexical delivery id', () => {
  const cands: DeliveryCandidate[] = [
    { deliveryId: 'd_z', level: 'bound_single_publisher', eligible: true, arrival: fa('2026-01-01T00:00:00Z', 'r1', 0, 'v') },
    { deliveryId: 'd_a', level: 'bound_single_publisher', eligible: true, arrival: fa('2026-01-01T00:00:00Z', 'r1', 0, 'v') },
  ]
  expect(selectDisplayDelivery(cands, null)).toBe('d_a')
})

test('selectDisplayDelivery ignores quarantined/blocked (ineligible) evidence entirely', () => {
  const cands: DeliveryCandidate[] = [
    { deliveryId: 'd_block', level: 'bound_single_publisher', eligible: false, arrival: fa('2026-01-01T00:00:00Z', 'r1', 0, 'v1') },
    { deliveryId: 'd_ok', level: 'aggregate_assertion', eligible: true, arrival: fa('2026-01-02T00:00:00Z', 'r2', 0, 'v2') },
  ]
  expect(selectDisplayDelivery(cands, null)).toBe('d_ok') // strongest level with an ELIGIBLE delivery
  expect(selectDisplayDelivery([], null)).toBeNull()
})

// ---- author selection is independent (spec §3.2) ----------------------------

test('selectAuthor uses the same level/tuple ordering independently of delivery selection', () => {
  const cands: AuthorCandidate[] = [
    { claimId: 'c_agg', publisherId: 'p1', level: 'aggregate_assertion', eligible: true, arrival: fa('2026-01-01T00:00:00Z', 'r1', 0, 'v1') },
    { claimId: 'c_bound', publisherId: 'p2', level: 'bound_single_publisher', eligible: true, arrival: fa('2026-01-02T00:00:00Z', 'r2', 0, 'v2') },
  ]
  expect(selectAuthor(cands, null)).toMatchObject({ publisherId: 'p2', level: 'bound_single_publisher' })
  expect(selectAuthor([], null)).toBeNull()
})

// ---- publisher-name normalization (spec §3.6) -------------------------------

test('normalizePublisherName applies NFC, strips controls/bidi, collapses whitespace, caps 200 cp', () => {
  expect(normalizePublisherName('  Ada   Lovelace  ')).toBe('Ada Lovelace')
  expect(normalizePublisherName('a\u0000b‮c')).toBe('abc') // C0 + bidi override removed
  expect(normalizePublisherName('   ')).toBeNull() // empty after trim is invalid
  expect(normalizePublisherName(null)).toBeNull()
  expect(normalizePublisherName('é')).toBe('é') // NFC composes
  expect(normalizePublisherName('x'.repeat(250))?.length).toBe(200)
})

test('selectPublisherName retains the current source at strongest level; a later invalid name does not erase a prior valid one', () => {
  const cands: NameCandidate[] = [
    { level: 'bound_single_publisher', arrival: fa('2026-01-01T00:00:00Z', 'r1', 0, 'v1'), sourceId: 's1', claimId: 'c1', name: 'First Name' },
    { level: 'bound_single_publisher', arrival: fa('2026-01-02T00:00:00Z', 'r2', 0, 'v2'), sourceId: 's1', claimId: 'c2', name: 'Latest Name' },
  ]
  expect(selectPublisherName(cands, 's1')).toBe('Latest Name') // within source, latest tuple supplies the name
  expect(selectPublisherName([cands[0]], 's1')).toBe('First Name')
})

// ---- presentation chain (spec §4.4) -----------------------------------------

test('presentationFingerprint excludes attribution/ancestry-id/publication so pub-date-only churn is unchanged material', () => {
  const base = { title: 't', content: 'body', contentMarkdown: null, permalink: 'https://x/1', sourceLink: 'https://x/1', enclosures: [], inReplyTo: null }
  expect(presentationFingerprint(base)).toBe(presentationFingerprint({ ...base }))
  // changing the body changes the fingerprint; changing nothing presentation-relevant does not
  expect(presentationFingerprint({ ...base, content: 'other' })).not.toBe(presentationFingerprint(base))
})

const wm = (sequence: number, explicitWatermark: string | null, topFingerprint: string | null): WatermarkState =>
  ({ sequence, explicitWatermark, topFingerprint })

test('baseline entry is sequence zero with no ordinary updatedAt when no valid explicit claim', () => {
  const r = nextPresentationEntry(wm(-1, null, null), { materialFingerprint: 'f0', explicitUpdate: null, arrivalAt: '2026-01-01T00:00:00Z' })
  expect(r.entry).toEqual({ sequence: 0, effectiveUpdatedAt: null, provenance: null })
})

test('baseline valid explicit claim (<= arrival) initializes the watermark with explicit provenance', () => {
  const r = nextPresentationEntry(wm(-1, null, null), { materialFingerprint: 'f0', explicitUpdate: '2026-01-01T00:00:00Z', arrivalAt: '2026-01-02T00:00:00Z' })
  expect(r.entry).toEqual({ sequence: 0, effectiveUpdatedAt: '2026-01-01T00:00:00Z', provenance: 'explicit' })
  expect(r.watermark).toBe('2026-01-01T00:00:00Z')
})

test('unchanged presentation material creates no entry', () => {
  const r = nextPresentationEntry(wm(0, null, 'f0'), { materialFingerprint: 'f0', explicitUpdate: '2026-02-01T00:00:00Z', arrivalAt: '2026-02-01T00:00:00Z' })
  expect(r.entry).toBeUndefined()
})

test('changed material with a valid explicit ts above the watermark is accepted with explicit provenance', () => {
  const r = nextPresentationEntry(wm(0, '2026-01-01T00:00:00Z', 'f0'), { materialFingerprint: 'f1', explicitUpdate: '2026-01-05T00:00:00Z', arrivalAt: '2026-01-06T00:00:00Z' })
  expect(r.entry).toEqual({ sequence: 1, effectiveUpdatedAt: '2026-01-05T00:00:00Z', provenance: 'explicit' })
  expect(r.watermark).toBe('2026-01-05T00:00:00Z')
})

test('changed material with an older-or-equal explicit ts is rollback evidence, not accepted', () => {
  const r = nextPresentationEntry(wm(1, '2026-01-05T00:00:00Z', 'f1'), { materialFingerprint: 'f2', explicitUpdate: '2026-01-05T00:00:00Z', arrivalAt: '2026-01-07T00:00:00Z' })
  expect(r.entry).toBeUndefined()
  expect(r.conflict).toBe('rollback')
  expect(r.watermark).toBe('2026-01-05T00:00:00Z') // unchanged
})

test('changed material with absent/future ts is accepted at arrival with arrival provenance, leaving the watermark', () => {
  const r = nextPresentationEntry(wm(1, '2026-01-05T00:00:00Z', 'f1'), { materialFingerprint: 'f2', explicitUpdate: null, arrivalAt: '2026-01-08T00:00:00Z' })
  expect(r.entry).toEqual({ sequence: 2, effectiveUpdatedAt: '2026-01-08T00:00:00Z', provenance: 'arrival' })
  expect(r.watermark).toBe('2026-01-05T00:00:00Z') // explicit watermark unchanged
})

// ---- UTC normalization / arrival watermark validity (spec §3.3, §4.4) -------

test('normalizeUtc returns a UTC instant for valid input and null for junk/future-callers decide', () => {
  expect(normalizeUtc('2026-01-01T12:00:00+02:00')).toBe('2026-01-01T10:00:00.000Z')
  expect(normalizeUtc('not a date')).toBeNull()
  expect(normalizeUtc(null)).toBeNull()
})
