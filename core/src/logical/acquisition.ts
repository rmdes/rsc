import { randomUUID, createHash } from 'node:crypto'
import { parseFeed } from 'feedsmith'
import type { DatabaseContext, WriteTx, ReadTx } from './database.ts'
import { checkFetchHop } from '../domain/push-guard.ts'
import type { LookupFn } from '../domain/push-guard.ts'
import { parseFeedWithMeta, mergeDiscovery } from '../domain/ingest.ts'
import { discoverFeed } from '../domain/discovery.ts'
import { choosePushTarget } from '../domain/push-in.ts'
import { isTombstoned } from './tombstones.ts'
import type {
  AcquisitionReason, AcquisitionRun, ClaimAcquisitionResult, CommitAcquisitionInput,
  ConditionalValidators, RedirectObservation, AcquisitionFinding, AdminAcquisitionCounters,
  AdminFetchProjection, EnclosureDto, NewObservationVersion,
} from './types.ts'
import type { CommandEnvelope, RemoteSource } from '../domain/types.ts'

// Bounded network acquisition (spec §1.4-1.6, §2.1-2.2). Fetches a remote source
// under strict bounds, follows redirects under the §1.6 proof rules, parses
// candidates into observation versions, and commits runs/observations/jobs/
// aliases in the §1.4 two-transaction protocol. NEVER calls a push endpoint —
// a feed advertising WebSub/rssCloud records only the inert parse-time
// push_capability_json. Flag-off isolation is absolute (nothing runs unless the
// runtime, gated behind RSC_SOURCE_MODEL_V2, wires this in — Task 10).

// The versioned bounds profile (spec §1.5). Every constant is pinned and tested.
export const BOUNDS = {
  totalDeadlineMs: 10_000,
  maxRedirects: 5,
  maxBodyBytes: 5 * 1024 * 1024,
  maxCandidates: 1000,
  maxEnclosures: 32,
  maxOpStringCodePoints: 2048,
  maxOpStringBytes: 8192,
  maxItemEvidenceBytes: 1024 * 1024,
  maxRawEvidenceBytes: 4096,
  boundsProfileVersion: 'v1',
  fingerprintVersion: 1 as const,
} as const

const FEED_FETCH_HEADERS: Record<string, string> = {
  'user-agent': 'RSC/0.1 (+https://github.com/rmdes/rsc)',
  accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/json, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
}

// ---- string / evidence bounds (spec §1.5) -----------------------------------

const codePoints = (s: string): number => [...s].length
const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8')

// An operational identifier (delivery key) must fit BOTH the code-point and the
// UTF-8 byte bound; violating either skips the whole item (spec §1.5).
function opStringOk(s: string): boolean {
  return codePoints(s) <= BOUNDS.maxOpStringCodePoints && utf8Bytes(s) <= BOUNDS.maxOpStringBytes
}

// Digest-backed evidence (spec §1.5): an over-limit optional publisher/name claim
// becomes an inert digest instead of skipping the item. It can NEVER become an
// identifier/link/alias/convergence-key/ancestry-ref/publisher-anchor/label.
export interface DigestEvidence {
  kind: string; prefix: string; byteLength: number; codePointCount: number; sha256: string; truncated: true
}
export function digestEvidence(kind: string, value: string): DigestEvidence {
  const bytes = utf8Bytes(value)
  // Unicode-safe prefix: take whole code points up to a bounded budget.
  const prefix = [...value].slice(0, 64).join('')
  return { kind, prefix, byteLength: bytes, codePointCount: codePoints(value), sha256: createHash('sha256').update(value, 'utf8').digest('hex'), truncated: true }
}
// Bound a raw optional claim to 4,096 UTF-8 bytes, digesting past that (spec §1.5).
function boundRaw(kind: string, value: string | null): string | DigestEvidence | null {
  if (value == null) return null
  return utf8Bytes(value) > BOUNDS.maxRawEvidenceBytes ? digestEvidence(kind, value) : value
}

// ---- delivery identity (spec §2.2) ------------------------------------------

export type KeyKind = 'opaque' | 'permalink' | 'fallback'

// Normalize a permalink: http(s) only, lowercase scheme+host (URL does the host),
// strip the fragment. Path/query case is preserved (opaque to us).
function normalizePermalink(raw: string): string | null {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    u.hash = ''
    return u.toString()
  } catch {
    return null
  }
}

// Deterministic source-local fallback (spec §2.2): stable across polls of the
// same content, but a changed title/content/date yields a NEW identity.
function fallbackKey(title: string | null, content: string, rawDate: string): string {
  return 'fallback:' + createHash('sha256').update((title ?? '') + '\0' + content + '\0' + rawDate).digest('hex')
}

// ---- candidate parsing (spec §1.5, §2.2) ------------------------------------

export interface Candidate {
  wireOrdinal: number
  keyKind: KeyKind
  key: string
  fingerprint: string
  canonicalMaterial: Buffer
  rawEvidenceJson: string
  normalizedJson: string
  enclosures: EnclosureDto[]
}

export interface ParseResult {
  adapter: 'rss' | 'atom' | 'jsonfeed' | 'hfeed'
  candidates: Candidate[]
  findings: AcquisitionFinding[]
  candidateCount: number
  examined: number
  omitted: number
  itemsTruncated: boolean
}

interface RawItem {
  opaqueId: string | null
  link: string | null
  title: string | null
  content: string
  rawDate: string
  updatedAt: string | null
  inReplyTo: string | null
  sourceName: string | null
  // RSS core <source url>name</source> — the origin feed a firehose/aggregator
  // item claims (rss.chat). Only the RSS adapter carries it; others leave it
  // undefined. Its URL is what V3 origin-verification fetches (spec §7). The
  // legacy ingest path captures the same field (ingest.ts sourceFeedUrl).
  sourceFeedUrl?: string | null
  enclosures: EnclosureDto[]
  // Optional stable identity seed for the fallback delivery key. The feed adapters
  // leave it undefined (their rawDate is already the RAW value — empty when absent —
  // so the fallback key is stable across polls). The h-feed adapter sets it because
  // its rawDate is arrival-substituted by discoverFeed and would otherwise churn the
  // fallback key every poll (Task 4 re-review carry). See extractHfeed.
  identitySeed?: string
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

// h-feed adapter (spec §1.5): a non-feed HTML body that parses as an h-feed with
// ≥1 h-entry yields candidates in document order. Reuses ingest's discoverFeed
// (microformats-parser + mf2tojf2) rather than a second microformats path.
// Identity churn fix (Task 4 re-review carry, 2026-07-23): discoverFeed substitutes
// arrival time into `publishedAt` for a dateless entry, so using it in the fallback
// identity key churned to a NEW delivery every poll. `e.guid` is discoverFeed's
// raw-date-disciplined stable id (empty date for the dateless case, the real date
// otherwise), so it seeds a fallback key that is stable across polls exactly like a
// dateless RSS item. Presentation still falls back to arrival per §3.3.
function extractHfeed(html: string, pageUrl: string): RawItem[] {
  const { hentries } = discoverFeed(html, pageUrl)
  return hentries.map((e): RawItem => ({
    opaqueId: null,
    link: e.url,
    title: e.title,
    content: e.content,
    rawDate: e.publishedAt,
    updatedAt: e.updatedAt,
    inReplyTo: e.inReplyTo,
    sourceName: e.sourceName,
    enclosures: [],
    identitySeed: e.guid,
  }))
}

// Wire order per adapter: RSS/Atom document order, JSON Feed array order, h-feed
// document order (spec §1.5). feedsmith yields items in document/array order, so
// ordinals follow directly. When the body is not a feedsmith-recognized feed we
// fall back to h-feed (mirroring ingest.ts's feed-first, then-h-feed, then-"no
// feed found" order); a body that is neither rethrows so acquireSource can
// terminalize the run instead of crashing the caller.
function extractRawItems(doc: string, pageUrl: string): { adapter: ParseResult['adapter']; items: RawItem[] } {
  const clean = doc.charCodeAt(0) === 0xfeff ? doc.slice(1) : doc
  let parsed
  try {
    parsed = parseFeed(clean)
  } catch (err) {
    const items = extractHfeed(clean, pageUrl)
    if (items.length > 0) return { adapter: 'hfeed', items }
    throw err
  }
  if (parsed.format === 'json') {
    const items = (parsed.feed.items ?? []).map((it): RawItem => ({
      opaqueId: str(it.id),
      link: str(it.url),
      title: str(it.title),
      content: str(it.content_html) ?? str(it.content_text) ?? '',
      rawDate: str(it.date_published) ?? '',
      updatedAt: str(it.date_modified),
      inReplyTo: null,
      sourceName: str(parsed.feed.title),
      enclosures: (it.attachments ?? []).filter((a) => typeof a.url === 'string').slice(0, BOUNDS.maxEnclosures).map((a) => ({ url: a.url as string, mimeType: str(a.mime_type), title: str(a.title), sizeBytes: typeof a.size_in_bytes === 'number' ? a.size_in_bytes : null, durationSeconds: typeof a.duration_in_seconds === 'number' ? a.duration_in_seconds : null })),
    }))
    return { adapter: 'jsonfeed', items }
  }
  if (parsed.format === 'atom') {
    const items = (parsed.feed.entries ?? []).map((it): RawItem => {
      const alt = it.links?.find((l) => l.href && (!l.rel || l.rel === 'alternate'))?.href ?? null
      const encs = (it.links ?? []).filter((l) => l.rel === 'enclosure' && l.href).slice(0, BOUNDS.maxEnclosures)
      return {
        opaqueId: str(it.id),
        link: str(alt),
        title: str(it.title),
        content: str(it.content) ?? str(it.summary) ?? '',
        rawDate: str(it.published) ?? str(it.updated) ?? '',
        updatedAt: str(it.updated),
        inReplyTo: it.thr?.inReplyTos?.[0]?.ref ?? it.thr?.inReplyTos?.[0]?.href ?? null,
        sourceName: str(parsed.feed.title),
        enclosures: encs.map((l) => ({ url: l.href as string, mimeType: str(l.type ?? null), title: null, sizeBytes: typeof l.length === 'number' ? l.length : null, durationSeconds: null })),
      }
    })
    return { adapter: 'atom', items }
  }
  if (parsed.format === 'rdf') {
    // RDF/RSS-1.0 items: no guid/enclosure namespace — link + description + dc date.
    const items = (parsed.feed.items ?? []).map((it): RawItem => ({
      opaqueId: null,
      link: str(it.link),
      title: str(it.title),
      content: str(it.description) ?? '',
      rawDate: str(it.dc?.dates?.[0] ?? null) ?? '',
      updatedAt: null,
      inReplyTo: null,
      sourceName: str(parsed.feed.title),
      enclosures: [],
    }))
    return { adapter: 'rss', items }
  }
  // RSS (document order).
  const items = (parsed.feed.items ?? []).map((it): RawItem => ({
    opaqueId: str(it.guid?.value),
    link: str(it.link) ?? (it.guid?.value !== undefined && it.guid.isPermaLink !== false ? str(it.guid.value) : null),
    title: str(it.title),
    content: str(it.description) ?? str(it.content?.encoded) ?? '',
    rawDate: str(it.pubDate) ?? '',
    updatedAt: str(it.atom?.updated ?? null),
    inReplyTo: it.sourceNs?.inReplyTo?.value ?? it.thr?.inReplyTos?.[0]?.ref ?? null,
    sourceName: str(it.source?.title ?? null),
    sourceFeedUrl: str(it.source?.url ?? null),
    enclosures: (it.enclosures ?? []).filter((e) => typeof e.url === 'string').slice(0, BOUNDS.maxEnclosures).map((e) => ({ url: e.url as string, mimeType: str(e.type ?? null), title: null, sizeBytes: typeof e.length === 'number' ? e.length : null, durationSeconds: null })),
  }))
  return { adapter: 'rss', items }
}

// The canonical fingerprint v1 (spec §2.2): a deterministic serialization of the
// stable semantic fields, SHA-256'd. Distinct material ⇒ distinct version.
function canonicalMaterialFor(it: RawItem, keyKind: KeyKind, key: string): Buffer {
  const material = {
    v: BOUNDS.fingerprintVersion,
    keyKind, key,
    title: it.title,
    content: it.content,
    link: it.link,
    published: it.rawDate,
    updated: it.updatedAt,
    inReplyTo: it.inReplyTo,
    enclosures: it.enclosures.map((e) => [e.url, e.mimeType, e.sizeBytes, e.durationSeconds]),
  }
  return Buffer.from(JSON.stringify(material), 'utf8')
}

export function parseCandidates(doc: string, pageUrl = 'https://source.invalid/'): ParseResult {
  const { adapter, items } = extractRawItems(doc, pageUrl)
  const candidateCount = items.length
  const examined = Math.min(candidateCount, BOUNDS.maxCandidates)
  const omitted = candidateCount - examined
  const findings: AcquisitionFinding[] = []
  const candidates: Candidate[] = []

  // Ordinals are assigned BEFORE the cap; only ordinals 0..999 are examined, and a
  // structural skip inside that window does NOT open capacity for the omitted tail.
  for (let ordinal = 0; ordinal < examined; ordinal++) {
    const it = items[ordinal]
    // delivery key priority: exact opaque id → normalized permalink → fallback.
    let keyKind: KeyKind
    let key: string
    if (it.opaqueId) {
      keyKind = 'opaque'; key = it.opaqueId
    } else {
      const norm = it.link ? normalizePermalink(it.link) : null
      if (norm) { keyKind = 'permalink'; key = norm }
      else if (it.identitySeed != null) { keyKind = 'fallback'; key = 'fallback:' + createHash('sha256').update(it.identitySeed).digest('hex') }
      else { keyKind = 'fallback'; key = fallbackKey(it.title, it.content, it.rawDate) }
    }
    // structural: an oversized required operational identifier skips the whole item.
    if (!opStringOk(key)) {
      findings.push({ kind: 'operational_identifier_limit', evidenceJson: JSON.stringify({ wireOrdinal: ordinal, keyKind, byteLength: utf8Bytes(key), codePointCount: codePoints(key) }) })
      continue
    }
    const canonicalMaterial = canonicalMaterialFor(it, keyKind, key)
    // structural: item evidence over 1 MiB skips the whole item.
    if (canonicalMaterial.byteLength > BOUNDS.maxItemEvidenceBytes) {
      findings.push({ kind: 'item_evidence_limit', evidenceJson: JSON.stringify({ wireOrdinal: ordinal, byteLength: canonicalMaterial.byteLength }) })
      continue
    }
    const fingerprint = createHash('sha256').update(canonicalMaterial).digest('hex')
    // Optional over-limit publisher/name claims become inert digest evidence.
    const rawEvidence = { title: boundRaw('title', it.title), sourceName: boundRaw('sourceName', it.sourceName), link: it.link, published: it.rawDate, updated: it.updatedAt, enclosureCount: it.enclosures.length }
    // originFeedUrl (spec §7): the item's claimed origin feed (RSS <source url>),
    // http(s) only — reconcile schedules verification from it on aggregate claims.
    const originFeedUrl = it.sourceFeedUrl && /^https?:\/\//i.test(it.sourceFeedUrl) ? it.sourceFeedUrl : null
    const normalized = { keyKind, key, permalink: it.link ? normalizePermalink(it.link) : null, inReplyTo: it.inReplyTo, enclosures: it.enclosures, originFeedUrl }
    candidates.push({ wireOrdinal: ordinal, keyKind, key, fingerprint, canonicalMaterial, rawEvidenceJson: JSON.stringify(rawEvidence), normalizedJson: JSON.stringify(normalized), enclosures: it.enclosures })
  }
  return { adapter, candidates, findings, candidateCount, examined, omitted, itemsTruncated: omitted > 0 }
}

// ---- bounded fetch with SSRF-per-hop + redirect proof (spec §1.5-1.6) --------

export type FetchResult =
  | { kind: 'response'; res: Response; effectiveUrl: string; redirects: RedirectObservation[]; provenAliases: string[] }
  | { kind: 'not_modified'; effectiveUrl: string; redirects: RedirectObservation[] }
  | { kind: 'ownership_collision'; redirects: RedirectObservation[]; collidedUrl: string }
  | { kind: 'loop'; redirects: RedirectObservation[] }
  | { kind: 'failure'; category: NonNullable<AdminFetchProjection['failureCategory']>; diagnostic: string; redirects: RedirectObservation[] }

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308])

export interface FetchCtx {
  fetchFn: typeof fetch
  lookupFn?: LookupFn
  signal: AbortSignal
  sourceId: string
  ownedAliases: Set<string>
  validators: ConditionalValidators | null
  aliasOwner: (url: string) => string | null
  // V3 Task 7 (spec §5.1): a redirect hop landing on a tombstoned URL is rejected
  // exactly like an SSRF-blocked hop — indistinguishable network failure, no fetch.
  isTombstoned?: (url: string) => boolean
}

export async function fetchBounded(startUrl: string, ctx: FetchCtx): Promise<FetchResult> {
  const redirects: RedirectObservation[] = []
  const provenAliases: string[] = []
  const seen = new Set<string>()
  let current = startUrl
  // The permanent-proof chain begins at the canonical URL (or an already-owned
  // alias). A 302/303/307 breaks it for all LATER hops; landing on an owned alias
  // restarts a fresh permanent chain (spec §1.6).
  let chainPermanent = true

  for (let hop = 0; ; hop++) {
    // SSRF + credential guard at fetch time AND on every hop (V1 security handoff):
    // never assume a stored row's URL was guarded at creation.
    const guard = await checkFetchHop(current, ctx.lookupFn)
    if (!guard.ok) return { kind: 'failure', category: 'network', diagnostic: `blocked ${guard.reason}`, redirects }
    // A tombstoned hop is never fetched and returns the same generic network
    // failure an SSRF-blocked hop does (spec §5.1: no oracle).
    if (ctx.isTombstoned?.(current)) return { kind: 'failure', category: 'network', diagnostic: 'blocked tombstoned', redirects }
    // alias-ownership: a hop landing on a URL owned by a DIFFERENT source is an
    // ownership collision (a domain outcome, not a scheduler failure — spec §1.6).
    const owner = ctx.aliasOwner(current)
    if (owner && owner !== ctx.sourceId) return { kind: 'ownership_collision', redirects, collidedUrl: current }

    const normalized = normalizePermalink(current) ?? current
    if (seen.has(normalized)) return { kind: 'loop', redirects }
    seen.add(normalized)

    const headers: Record<string, string> = { ...FEED_FETCH_HEADERS }
    if (ctx.validators && ctx.validators.effectiveUrl === current) {
      if (ctx.validators.etag) headers['if-none-match'] = ctx.validators.etag
      if (ctx.validators.lastModified) headers['if-modified-since'] = ctx.validators.lastModified
    }

    let res: Response
    try {
      res = await ctx.fetchFn(current, { signal: ctx.signal, headers, redirect: 'manual' })
    } catch (err) {
      return { kind: 'failure', category: 'network', diagnostic: err instanceof Error ? err.message : 'fetch failed', redirects }
    }

    if (res.status === 304) return { kind: 'not_modified', effectiveUrl: current, redirects }

    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
    if (location && REDIRECT_CODES.has(res.status)) {
      if (hop >= BOUNDS.maxRedirects) return { kind: 'failure', category: 'network', diagnostic: 'too many redirects', redirects }
      const target = new URL(location, current).toString()
      const permanent = res.status === 301 || res.status === 308
      const proven = permanent && chainPermanent
      redirects.push({ ordinal: hop, status: res.status, fromEvidence: current, toEvidence: target, permanentProof: proven })
      if (proven && !ctx.ownedAliases.has(target)) provenAliases.push(target)
      if (!permanent) chainPermanent = false
      if (ctx.ownedAliases.has(target)) chainPermanent = true // an owned alias starts a fresh chain
      current = target
      continue
    }
    return { kind: 'response', res, effectiveUrl: current, redirects, provenAliases }
  }
}

// Read the streamed body under the 5 MiB decoded cap (spec §1.5). The cap is
// enforced WHILE streaming — chunks are counted and the stream is cancelled the
// moment the total crosses the cap, so an oversized body is never fully buffered.
export async function readCappedBody(res: Response): Promise<{ body: string | null; exceeded: boolean }> {
  const declared = Number(res.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > BOUNDS.maxBodyBytes) return { body: null, exceeded: true }
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer())
    return buf.byteLength > BOUNDS.maxBodyBytes ? { body: null, exceeded: true } : { body: buf.toString('utf8'), exceeded: false }
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.byteLength
      if (total > BOUNDS.maxBodyBytes) { await reader.cancel().catch(() => {}); return { body: null, exceeded: true } }
      chunks.push(value)
    }
  }
  return { body: Buffer.concat(chunks).toString('utf8'), exceeded: false }
}

export function raceDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DeadlineError()), ms) })
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer)) as Promise<T>
}
export class DeadlineError extends Error { constructor() { super('acquisition deadline exceeded') } }

// ---- store-side transaction functions (spec §1.4, §2.1) ---------------------
// Pure WriteTx functions; store.ts wraps each in db.write(). The engine drives
// TX1 (claim) then TX2 (commit/fail) as separate transactions.

interface SourcePolicy { id: string; canonicalUrl: string; governance: string; operation: string }

function readSourcePolicy(tx: ReadTx, sourceId: string): SourcePolicy | undefined {
  const r = tx.prepare(`SELECT id, canonical_url, governance, operation FROM remote_sources_v2 WHERE id = ?`).get(sourceId) as { id: string; canonical_url: string; governance: string; operation: string } | undefined
  return r ? { id: r.id, canonicalUrl: r.canonical_url, governance: r.governance, operation: r.operation } : undefined
}

const ZERO_COUNTERS: AdminAcquisitionCounters = { candidates: 0, seen: 0, observed: 0, unchanged: 0, skipped: 0, omitted: 0, itemsTruncated: false, bodyLimitExceeded: false, notModified: false }

function loadRemoteSource(tx: ReadTx, sourceId: string): RemoteSource | undefined {
  const r = tx.prepare(`SELECT * FROM remote_sources_v2 WHERE id = ?`).get(sourceId) as Record<string, unknown> | undefined
  if (!r) return undefined
  return { id: r.id as string, canonicalUrl: r.canonical_url as string, attributionMode: r.attribution_mode as RemoteSource['attributionMode'], operation: r.operation as RemoteSource['operation'], governance: r.governance as RemoteSource['governance'], provenance: r.provenance as RemoteSource['provenance'], provenanceNote: (r.provenance_note as string | null) ?? null, adminRetained: r.admin_retained === 1, createdAt: r.created_at as string }
}

export function claimAcquisition(tx: WriteTx, input: { sourceId: string; reason: AcquisitionReason; now: string }): ClaimAcquisitionResult {
  const { sourceId, reason, now } = input
  const policy = readSourcePolicy(tx, sourceId)
  if (!policy) return { kind: 'unavailable', reason: 'unknown' }
  if (policy.governance === 'blocked') return { kind: 'unavailable', reason: 'blocked' }
  if (policy.operation === 'paused') return { kind: 'unavailable', reason: 'paused' }

  const source = loadRemoteSource(tx, sourceId)!

  // Administrator command idempotency (V1 ledger contract): a replayed command
  // returns its original run without a second fetch.
  if (reason.kind === 'administrator') {
    const prior = tx.prepare(`SELECT run_id FROM acquisition_commands_v2 WHERE actor_id = ? AND command_id = ?`).get(reason.command.actorId, reason.command.commandId) as { run_id: string | null } | undefined
    if (prior?.run_id) return { kind: 'claimed', runId: prior.run_id, source, disposition: 'replayed' }
  }

  const runId = randomUUID()
  const runReason = reason.kind === 'administrator' ? 'administrator_refresh' : 'scheduled'
  tx.prepare(
    `INSERT INTO acquisition_runs_v2 (id, source_id, reason, status, started_at, acquisition_committed_at, completed_at, outcome, counters_json, failure_category, diagnostic, push_capability_json)
     VALUES (?, ?, ?, 'processing', ?, NULL, NULL, 'pending', ?, NULL, NULL, NULL)`,
  ).run(runId, sourceId, runReason, now, JSON.stringify(ZERO_COUNTERS))
  if (reason.kind === 'administrator') {
    tx.prepare(
      `INSERT INTO acquisition_commands_v2 (actor_id, command_id, request_fingerprint, run_id, refusal_json, created_at)
       VALUES (?, ?, ?, ?, NULL, ?)`,
    ).run(reason.command.actorId, reason.command.commandId, reason.command.requestFingerprint, runId, now)
  }
  return { kind: 'claimed', runId, source, disposition: 'created' }
}

// A command arriving while the source is in flight JOINS the active run (spec
// §1.4). The association commits in its own transaction before the result.
export function associateCommand(tx: WriteTx, input: { command: CommandEnvelope; runId: string; now: string }): void {
  tx.prepare(
    `INSERT OR IGNORE INTO acquisition_commands_v2 (actor_id, command_id, request_fingerprint, run_id, refusal_json, created_at)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  ).run(input.command.actorId, input.command.commandId, input.command.requestFingerprint, input.runId, input.now)
}

function markTerminal(tx: WriteTx, input: { runId: string; now: string; outcome: AdminFetchProjection['outcome']; counters: AdminAcquisitionCounters; failureCategory: AdminFetchProjection['failureCategory']; diagnostic: string | null; committedAt: string | null; pushCapabilityJson: string | null }): void {
  tx.prepare(
    `UPDATE acquisition_runs_v2 SET status = 'terminal', outcome = ?, counters_json = ?, failure_category = ?, diagnostic = ?, acquisition_committed_at = ?, completed_at = ?, push_capability_json = ? WHERE id = ?`,
  ).run(input.outcome, JSON.stringify(input.counters), input.failureCategory, input.diagnostic, input.committedAt, input.now, input.pushCapabilityJson, input.runId)
}

export function failAcquisition(tx: WriteTx, input: { runId: string; sourceId: string; now: string; outcome: 'operational_failure' | 'cancelled' | 'superseded' | 'policy_rejected'; category: AdminFetchProjection['failureCategory']; diagnostic: string | null; redirects?: RedirectObservation[]; findings?: AcquisitionFinding[] }): AcquisitionRun {
  // A mid-chain rejected hop still retains its redirect evidence (spec §1.6); a
  // parse failure still records its finding — while committing NO aliases,
  // observations, jobs, or validators.
  if (input.redirects?.length) insertRedirects(tx, input.runId, input.redirects)
  if (input.findings?.length) insertFindings(tx, input.runId, input.findings, input.now)
  markTerminal(tx, { runId: input.runId, now: input.now, outcome: input.outcome, counters: ZERO_COUNTERS, failureCategory: input.category, diagnostic: input.diagnostic, committedAt: null, pushCapabilityJson: null })
  return { runId: input.runId, sourceId: input.sourceId, status: 'terminal', outcome: input.outcome }
}

function insertRedirects(tx: WriteTx, runId: string, redirects: RedirectObservation[]): void {
  const stmt = tx.prepare(`INSERT INTO redirect_observations_v2 (id, run_id, ordinal, status, from_evidence, to_evidence, permanent_proof) VALUES (?, ?, ?, ?, ?, ?, ?)`)
  for (const r of redirects) stmt.run(randomUUID(), runId, r.ordinal, r.status, r.fromEvidence, r.toEvidence, r.permanentProof ? 1 : 0)
}

function insertFindings(tx: WriteTx, runId: string, findings: AcquisitionFinding[], now: string): void {
  const stmt = tx.prepare(`INSERT INTO acquisition_findings_v2 (id, run_id, kind, evidence_json, created_at) VALUES (?, ?, ?, ?, ?)`)
  for (const f of findings) stmt.run(randomUUID(), runId, f.kind, f.evidenceJson, now)
}

// The acquisition-result transaction (spec §1.4, §2.1). Rechecks CURRENT source
// policy; pause/block/tombstone commits NOTHING but the terminal run. Otherwise
// atomically persists redirects, findings, delivery sightings, new observation
// versions, one observation job per new version, validators, and proven aliases.
export function commitAcquisition(tx: WriteTx, input: CommitAcquisitionInput): AcquisitionRun {
  const { runId, sourceId, committedAt } = input

  // Commit-time policy recheck (spec §1.4): a stale result on a now-paused/blocked
  // source commits nothing but the rejected terminal run.
  const policy = readSourcePolicy(tx, sourceId)
  if (!policy || policy.governance === 'blocked' || policy.operation === 'paused') {
    markTerminal(tx, { runId, now: committedAt, outcome: 'policy_rejected', counters: ZERO_COUNTERS, failureCategory: 'policy', diagnostic: 'source policy changed during acquisition', committedAt, pushCapabilityJson: null })
    return { runId, sourceId, status: 'terminal', outcome: 'policy_rejected' }
  }

  insertRedirects(tx, runId, input.redirects)

  // Ownership collision (spec §1.6): run outcome + redirect evidence + conflict,
  // but NO aliases, observations, jobs, validators, or conditional-fetch changes.
  if (input.outcome === 'redirect_conflict') {
    insertFindings(tx, runId, input.findings, committedAt)
    markTerminal(tx, { runId, now: committedAt, outcome: 'redirect_conflict', counters: input.counters, failureCategory: null, diagnostic: null, committedAt, pushCapabilityJson: input.pushCapabilityJson })
    return { runId, sourceId, status: 'terminal', outcome: 'redirect_conflict' }
  }

  const counters: AdminAcquisitionCounters = { ...input.counters }

  // Body-limit / not-modified / loop terminals carry no observations.
  const parseFindings = [...input.findings]

  // Classify each candidate observation against current delivery/version state,
  // INSIDE this guarded transaction so unchanged seen-bumps are policy-guarded too.
  const findDelivery = tx.prepare(`SELECT id FROM deliveries_v2 WHERE source_id = ? AND key_kind = ? AND key = ?`)
  const bumpDelivery = tx.prepare(`UPDATE deliveries_v2 SET last_seen_at = ?, last_seen_run_id = ?, seen_count = seen_count + 1 WHERE id = ?`)
  const insertDelivery = tx.prepare(`INSERT INTO deliveries_v2 (id, source_id, key_kind, key, first_seen_at, last_seen_at, last_seen_run_id, seen_count) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`)
  const findVersion = tx.prepare(`SELECT id, canonical_material FROM observation_versions_v2 WHERE delivery_id = ? AND fingerprint_version = ? AND fingerprint = ?`)
  const bumpVersion = tx.prepare(`UPDATE observation_versions_v2 SET last_seen_at = ?, last_seen_run_id = ?, seen_count = seen_count + 1 WHERE id = ?`)
  const insertVersion = tx.prepare(`INSERT INTO observation_versions_v2 (id, delivery_id, fingerprint_version, fingerprint, canonical_material, arrival_at, run_id, wire_ordinal, last_seen_at, last_seen_run_id, seen_count, raw_evidence_json, normalized_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
  const insertJob = tx.prepare(`INSERT INTO reconciliation_jobs_v2 (id, kind, run_id, observation_version_id, verification_batch_key, status, attempts, next_attempt_at, failure_category, diagnostic, created_at) VALUES (?, 'observation', ?, ?, NULL, 'pending', 0, ?, NULL, NULL, ?)`)

  for (const obs of input.observations) {
    const norm = JSON.parse(obs.normalizedJson) as { keyKind: KeyKind; key: string }
    counters.candidates++
    counters.seen++
    // resolve-or-create the delivery (spec §2.2 identity update rides here).
    const existing = findDelivery.get(sourceId, norm.keyKind, norm.key) as { id: string } | undefined
    const deliveryId = existing?.id ?? obs.deliveryId
    if (existing) bumpDelivery.run(committedAt, runId, deliveryId)
    else insertDelivery.run(deliveryId, sourceId, norm.keyKind, norm.key, committedAt, committedAt, runId)

    const priorVersion = findVersion.get(deliveryId, BOUNDS.fingerprintVersion, obs.fingerprint) as { id: string; canonical_material: Buffer } | undefined
    if (priorVersion) {
      // fingerprint match: compare canonical material (spec §2.2).
      if (Buffer.compare(Buffer.from(priorVersion.canonical_material), Buffer.from(obs.canonicalMaterial)) === 0) {
        bumpVersion.run(committedAt, runId, priorVersion.id) // unchanged
        counters.unchanged++
      } else {
        // fingerprint collision: bounded evidence, skipped, no new version/job.
        parseFindings.push({ kind: 'fingerprint_collision', evidenceJson: JSON.stringify({ deliveryId, wireOrdinal: obs.wireOrdinal, fingerprint: obs.fingerprint }) })
        counters.skipped++
      }
      continue
    }
    // new observation version + one observation job.
    insertVersion.run(obs.id, deliveryId, BOUNDS.fingerprintVersion, obs.fingerprint, Buffer.from(obs.canonicalMaterial), committedAt, runId, obs.wireOrdinal, committedAt, runId, obs.rawEvidenceJson, obs.normalizedJson)
    insertJob.run(randomUUID(), runId, obs.id, committedAt, committedAt)
    counters.observed++
  }

  insertFindings(tx, runId, parseFindings, committedAt)

  // Validators: source acquisition state indexed by the final effective URL.
  if (input.validators) {
    tx.prepare(
      `INSERT INTO source_validators_v2 (source_id, effective_url, etag, last_modified) VALUES (?, ?, ?, ?)
       ON CONFLICT(source_id, effective_url) DO UPDATE SET etag = excluded.etag, last_modified = excluded.last_modified`,
    ).run(sourceId, input.validators.effectiveUrl, input.validators.etag, input.validators.lastModified)
  }

  // Proven permanent-chain targets become source aliases (spec §1.6); redirecting
  // to an already-owned alias is a no-op via INSERT OR IGNORE.
  const aliasStmt = tx.prepare(`INSERT OR IGNORE INTO source_aliases_v2 (url, source_id, created_at) VALUES (?, ?, ?)`)
  for (const url of input.aliases) aliasStmt.run(url, sourceId, committedAt)

  const failureCategory = counters.bodyLimitExceeded ? 'body_limit' : input.outcome === 'operational_failure' ? 'network' : null
  markTerminal(tx, { runId, now: committedAt, outcome: input.outcome, counters, failureCategory, diagnostic: null, committedAt, pushCapabilityJson: input.pushCapabilityJson })
  return { runId, sourceId, status: 'terminal', outcome: input.outcome }
}

// ---- the acquisition engine (spec §1.4) -------------------------------------

export interface AcquisitionDeps {
  db: DatabaseContext
  fetchFn?: typeof fetch
  lookupFn?: LookupFn
  deadlineMs?: number
  now?: () => string
}

export interface AcquisitionEngine {
  acquireSource(sourceId: string, reason: AcquisitionReason, signal?: AbortSignal): Promise<AcquisitionRun | { kind: 'unavailable'; reason: string }>
  inFlight(sourceId: string): boolean
}

// Read the per-source acquisition context the engine needs before fetching:
// conditional validators, the source's own aliases, and a URL→owner resolver.
function readContext(tx: ReadTx, sourceId: string, canonicalUrl: string): { validators: ConditionalValidators | null; ownedAliases: Set<string>; aliasOwner: (url: string) => string | null; isTombstoned: (url: string) => boolean } {
  const vRows = tx.prepare(`SELECT effective_url, etag, last_modified FROM source_validators_v2 WHERE source_id = ?`).all(sourceId) as { effective_url: string; etag: string | null; last_modified: string | null }[]
  // Prefer the canonical URL's validators; else the most recent effective URL's.
  const pick = vRows.find((v) => v.effective_url === canonicalUrl) ?? vRows[0]
  const validators = pick ? { effectiveUrl: pick.effective_url, etag: pick.etag, lastModified: pick.last_modified } : null
  const aRows = tx.prepare(`SELECT url FROM source_aliases_v2 WHERE source_id = ?`).all(sourceId) as { url: string }[]
  const ownedAliases = new Set(aRows.map((a) => a.url))
  const aliasOwner = (url: string): string | null => {
    const c = tx.prepare(`SELECT id FROM remote_sources_v2 WHERE canonical_url = ?`).get(url) as { id: string } | undefined
    if (c) return c.id
    const a = tx.prepare(`SELECT source_id FROM source_aliases_v2 WHERE url = ?`).get(url) as { source_id: string } | undefined
    return a ? a.source_id : null
  }
  return { validators, ownedAliases, aliasOwner, isTombstoned: (url) => isTombstoned(tx, url) }
}

export function createAcquisition(deps: AcquisitionDeps): AcquisitionEngine {
  const { db } = deps
  const fetchFn = deps.fetchFn ?? fetch
  const now = deps.now ?? (() => new Date().toISOString())
  const deadlineMs = deps.deadlineMs ?? BOUNDS.totalDeadlineMs
  // Per-source in-process in-flight flag (spec §1.4): covers fetch+parse+result
  // transaction, not later reconciliation. A crash clears it with the process
  // (the Map is process memory); startup begins with none active.
  // ponytail: in-process Map; distributed claims only if core ever multi-process.
  const inFlightMap = new Map<string, string>()

  async function acquireSource(sourceId: string, reason: AcquisitionReason, signal?: AbortSignal): Promise<AcquisitionRun | { kind: 'unavailable'; reason: string }> {
    // Join an active run instead of a second fetch (spec §1.4).
    const active = inFlightMap.get(sourceId)
    if (active) {
      if (reason.kind === 'administrator') {
        const command = reason.command
        db.write((tx) => associateCommand(tx, { command, runId: active, now: now() }))
        return { runId: active, sourceId, status: 'processing', outcome: 'pending' }
      }
      return { kind: 'unavailable', reason: 'unscheduled' }
    }

    // TX1: command-to-run association (and run creation) commits BEFORE the result.
    const claim = db.write((tx) => claimAcquisition(tx, { sourceId, reason, now: now() }))
    if (claim.kind === 'unavailable') return claim
    if (claim.disposition === 'replayed') {
      const row = db.read((tx) => tx.prepare(`SELECT status, outcome FROM acquisition_runs_v2 WHERE id = ?`).get(claim.runId)) as { status: 'processing' | 'terminal'; outcome: AdminFetchProjection['outcome'] } | undefined
      return { runId: claim.runId, sourceId, status: row?.status ?? 'terminal', outcome: row?.outcome ?? 'pending' }
    }

    const runId = claim.runId
    inFlightMap.set(sourceId, runId)
    try {
      const ctxData = db.read((tx) => readContext(tx, sourceId, claim.source.canonicalUrl))
      const fetchSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(deadlineMs)]) : AbortSignal.timeout(deadlineMs)
      const ctx: FetchCtx = { fetchFn, lookupFn: deps.lookupFn, signal: fetchSignal, sourceId, ownedAliases: ctxData.ownedAliases, validators: ctxData.validators, aliasOwner: ctxData.aliasOwner, isTombstoned: ctxData.isTombstoned }

      let result: FetchResult
      try {
        result = await raceDeadline(fetchBounded(claim.source.canonicalUrl, ctx), deadlineMs)
      } catch (err) {
        const timeout = err instanceof DeadlineError || (err instanceof Error && err.name === 'TimeoutError')
        return db.write((tx) => failAcquisition(tx, { runId, sourceId, now: now(), outcome: 'operational_failure', category: timeout ? 'timeout' : 'network', diagnostic: err instanceof Error ? err.message : 'fetch failed' }))
      }

      const committedAt = now()

      if (result.kind === 'failure') {
        return db.write((tx) => failAcquisition(tx, { runId, sourceId, now: committedAt, outcome: 'operational_failure', category: result.category, diagnostic: result.diagnostic, redirects: result.redirects }))
      }
      if (result.kind === 'loop') {
        return db.write((tx) => commitAcquisition(tx, { runId, sourceId, committedAt, effectiveUrl: null, validators: null, redirects: result.redirects, aliases: [], observations: [], findings: [{ kind: 'redirect_loop', evidenceJson: JSON.stringify({ hops: result.redirects.length }) }], counters: { ...ZERO_COUNTERS }, outcome: 'operational_failure', pushCapabilityJson: null }))
      }
      if (result.kind === 'ownership_collision') {
        return db.write((tx) => commitAcquisition(tx, { runId, sourceId, committedAt, effectiveUrl: null, validators: null, redirects: result.redirects, aliases: [], observations: [], findings: [{ kind: 'redirect_ownership_conflict', evidenceJson: JSON.stringify({ collidedUrl: result.collidedUrl }) }], counters: { ...ZERO_COUNTERS }, outcome: 'redirect_conflict', pushCapabilityJson: null }))
      }
      if (result.kind === 'not_modified') {
        // A 304 keeps its validators (spec §1.6) and records notModified.
        return db.write((tx) => commitAcquisition(tx, { runId, sourceId, committedAt, effectiveUrl: result.effectiveUrl, validators: ctxData.validators, redirects: result.redirects, aliases: [], observations: [], findings: [], counters: { ...ZERO_COUNTERS, notModified: true }, outcome: 'not_modified', pushCapabilityJson: null }))
      }

      // A parsed response: read the body under the streaming cap.
      const { body, exceeded } = await readCappedBody(result.res)
      if (exceeded || body == null) {
        return db.write((tx) => commitAcquisition(tx, { runId, sourceId, committedAt, effectiveUrl: result.effectiveUrl, validators: null, redirects: result.redirects, aliases: [], observations: [], findings: [], counters: { ...ZERO_COUNTERS, bodyLimitExceeded: true }, outcome: 'operational_failure', pushCapabilityJson: null }))
      }

      // An unparseable body (not a feed, not an h-feed) must terminalize the run —
      // never reject and leave it stuck in 'processing'. Redirect evidence is
      // retained; nothing else is committed.
      let parsed: ParseResult
      try {
        parsed = parseCandidates(body, result.effectiveUrl)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unparseable body'
        return db.write((tx) => failAcquisition(tx, { runId, sourceId, now: committedAt, outcome: 'operational_failure', category: 'feed_parse', diagnostic: message, redirects: result.redirects, findings: [{ kind: 'parser_item_error', evidenceJson: JSON.stringify({ message }) }] }))
      }
      const observations: NewObservationVersion[] = parsed.candidates.map((c) => ({ id: randomUUID(), deliveryId: randomUUID(), wireOrdinal: c.wireOrdinal, arrivalAt: committedAt, fingerprintVersion: BOUNDS.fingerprintVersion, fingerprint: c.fingerprint, canonicalMaterial: c.canonicalMaterial, rawEvidenceJson: c.rawEvidenceJson, normalizedJson: c.normalizedJson }))

      // Inert push-capability evidence (spec §1.2): parse-time discovery only —
      // NEVER contact the hub/cloud. Reuses ingest's discovery + push-in's target.
      const pushCapabilityJson = await pushCapabilityFrom(body, result.res, result.effectiveUrl)

      const etag = result.res.headers.get('etag')
      const lastModified = result.res.headers.get('last-modified')
      const validators: ConditionalValidators | null = etag || lastModified ? { effectiveUrl: result.effectiveUrl, etag, lastModified } : null

      const counters: AdminAcquisitionCounters = { ...ZERO_COUNTERS, candidates: parsed.candidateCount, omitted: parsed.omitted, itemsTruncated: parsed.itemsTruncated }
      const outcome: AdminFetchProjection['outcome'] = parsed.itemsTruncated ? 'completed_truncated' : 'parsed'

      return db.write((tx) => commitAcquisition(tx, { runId, sourceId, committedAt, effectiveUrl: result.effectiveUrl, validators, redirects: result.redirects, aliases: result.provenAliases, observations, findings: parsed.findings, counters, outcome, pushCapabilityJson }))
    } finally {
      inFlightMap.delete(sourceId)
    }
  }

  return { acquireSource, inFlight: (sourceId) => inFlightMap.has(sourceId) }
}

// Parse-time push-capability discovery, folded to the inert {mode,endpoint,topic}
// evidence shape (spec §1.2). Best-effort: a parse failure yields no evidence and
// never fails the run. NO push endpoint is ever contacted — this only records
// what the feed advertises. Reuses ingest's discovery merge + push-in's target
// chooser rather than reimplementing the WebSub/rssCloud advertisement parsing.
// ponytail: a second (discovery-only) parse of the already-fetched body; fine at
// ≤5 MiB once per poll — collapse into one parse if poll read-volume ever bites.
async function pushCapabilityFrom(body: string, res: Response, effectiveUrl: string): Promise<string | null> {
  try {
    const { discovery } = await parseFeedWithMeta(body)
    const merged = mergeDiscovery(res, discovery)
    const target = choosePushTarget(merged, effectiveUrl)
    return target ? JSON.stringify(target) : null
  } catch {
    return null
  }
}
