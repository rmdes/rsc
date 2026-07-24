import { readFileSync } from 'node:fs'
import type BetterSqlite3 from 'better-sqlite3'
import { normalizeSourceUrl } from '../domain/source-url.ts'
import type { AttributionMode } from '../domain/types.ts'

// V4 §2 — the read-only preflight and its versioned manifest. Two entry points,
// one module: the operator CLI (preflight-cli.ts) and the in-process check run
// immediately before conversion (Task 8). Every finding is an abort; the
// operator corrects the legacy rows and reruns (foundation §12 procedure).
//
// READ-ONLY BY CONSTRUCTION: runPreflight only ever prepares SELECTs. The CLI
// opens the database with {readonly:true}; the in-process caller hands over the
// live handle, so a stray write here would land inside the activation
// transaction that must commit nothing on abort.
//
// The split: loadManifest THROWS named diagnostics (it is the loader, and it
// owns every file/shape diagnostic — config validates presence only);
// runPreflight RETURNS findings (it is the checker, and it owns every check
// that needs the legacy rows).

export interface ManifestEntry { sourceId: string; feedUrl: string; attributionMode: AttributionMode; note: string }
export interface Manifest { schemaVersion: 1; entries: ManifestEntry[] }

const ATTRIBUTION_MODES: AttributionMode[] = ['single_publisher', 'aggregate']
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0

export function loadManifest(path: string | null): Manifest | null {
  if (!path) return null
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`migration manifest not readable at ${path}`)
  }
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    throw new Error(`migration manifest at ${path} is not valid JSON`)
  }
  if (!isRecord(doc)) throw new Error(`migration manifest at ${path} must be a JSON object`)
  if (doc.schemaVersion !== 1) throw new Error(`migration manifest at ${path} has unsupported schemaVersion ${JSON.stringify(doc.schemaVersion)} (expected 1)`)
  if (!Array.isArray(doc.entries)) throw new Error(`migration manifest at ${path} must have an entries array`)
  const entries = doc.entries.map((raw, i) => {
    if (!isRecord(raw)) throw new Error(`migration manifest entry ${i} must be an object`)
    if (!str(raw.sourceId)) throw new Error(`migration manifest entry ${i} needs a non-empty sourceId`)
    if (!str(raw.feedUrl)) throw new Error(`migration manifest entry ${i} (${raw.sourceId}) needs a non-empty feedUrl`)
    if (typeof raw.note !== 'string') throw new Error(`migration manifest entry ${i} (${raw.sourceId}) needs a note`)
    if (!ATTRIBUTION_MODES.includes(raw.attributionMode as AttributionMode)) {
      throw new Error(`migration manifest entry ${i} (${raw.sourceId}) has invalid attributionMode ${JSON.stringify(raw.attributionMode)}`)
    }
    return { sourceId: raw.sourceId, feedUrl: raw.feedUrl, attributionMode: raw.attributionMode as AttributionMode, note: raw.note }
  })
  return { schemaVersion: 1, entries }
}

export interface PreflightFinding {
  kind: 'invalid_url' | 'url_collision' | 'manifest_invalid' | 'manifest_unknown_entry'
    | 'manifest_mismatch' | 'manifest_duplicate' | 'handle_reservation_collision'
  detail: string
}

interface LegacyRow { id: string; handle: string; feed_url: string | null; feed_type: string | null }

export function runPreflight(raw: BetterSqlite3.Database, manifest: Manifest | null): PreflightFinding[] {
  const findings: PreflightFinding[] = []
  const rows = raw.prepare(
    `SELECT id, handle, feed_url, feed_type FROM users WHERE kind = 'remote' ORDER BY id`,
  ).all() as LegacyRow[]

  // Every remote feed URL must normalize under V1's narrow canonicalization
  // (missing/malformed/credential-bearing/oversized/non-HTTP(S) all throw
  // there), and no two rows may normalize alike — a collision makes the
  // converted canonical URL ambiguous.
  const byNormalized = new Map<string, LegacyRow>()
  for (const row of rows) {
    const name = `${row.id} (@${row.handle})`
    if (!row.feed_url) {
      findings.push({ kind: 'invalid_url', detail: `legacy remote user ${name} has no feed_url` })
      continue
    }
    let normalized: string
    try {
      normalized = normalizeSourceUrl(row.feed_url)
    } catch {
      findings.push({ kind: 'invalid_url', detail: `legacy remote user ${name} has an unusable feed_url ${JSON.stringify(row.feed_url)}` })
      continue
    }
    const clash = byNormalized.get(normalized)
    if (clash) findings.push({ kind: 'url_collision', detail: `legacy remote users ${clash.id} (@${clash.handle}) and ${name} both normalize to ${normalized}` })
    else byNormalized.set(normalized, row)
  }

  // Manifest entries are keyed by exact legacy source ID AND exact legacy feed
  // URL, and only legacy instance rows may be confirmed (spec §2.2).
  if (manifest) {
    const byId = new Map(rows.map((r) => [r.id, r]))
    const seen = new Set<string>()
    for (const entry of manifest.entries) {
      if (seen.has(entry.sourceId)) {
        findings.push({ kind: 'manifest_duplicate', detail: `manifest has more than one entry for ${entry.sourceId}` })
        continue
      }
      seen.add(entry.sourceId)
      const row = byId.get(entry.sourceId)
      if (!row) {
        findings.push({ kind: 'manifest_unknown_entry', detail: `manifest entry ${entry.sourceId} matches no legacy remote user` })
        continue
      }
      if (row.feed_url !== entry.feedUrl) {
        findings.push({ kind: 'manifest_mismatch', detail: `manifest entry ${entry.sourceId} feedUrl ${JSON.stringify(entry.feedUrl)} does not match the legacy feed_url ${JSON.stringify(row.feed_url)}` })
        continue
      }
      if (row.feed_type !== 'instance') {
        findings.push({ kind: 'manifest_invalid', detail: `manifest entry ${entry.sourceId} targets a ${JSON.stringify(row.feed_type)} row; only instance rows can be confirmed` })
      }
    }
  }

  // Every legacy remote handle must still be reservable: a leftover reservation
  // (partial restore, rerun) would otherwise plan a double reservation.
  const reserved = new Set(
    (raw.prepare(`SELECT handle FROM handle_reservations_v2`).all() as { handle: string }[]).map((r) => r.handle),
  )
  for (const row of rows) {
    if (reserved.has(row.handle)) {
      findings.push({ kind: 'handle_reservation_collision', detail: `legacy remote handle @${row.handle} (${row.id}) is already reserved in handle_reservations_v2` })
    }
  }

  return findings
}
