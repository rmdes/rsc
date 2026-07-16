import { randomUUID, createHash } from 'node:crypto'
import { parseFeed as parseFeedDocument } from 'feedsmith'
import type { Repository } from './repository.ts'
import type { EventBus } from './bus.ts'
import type { User, Post } from './types.ts'
import { discoverFeed } from './discovery.ts'
import { checkCallbackUrl } from './push-guard.ts'
import type { LookupFn } from './push-guard.ts'

export interface ParsedItem { guid: string; title: string | null; content: string; url: string | null; publishedAt: string }

export interface FeedDiscovery {
  hubs: string[]
  self: string | null
  cloud: { domain: string; port: number; path: string; protocol: string } | null
}

const NO_DISCOVERY: FeedDiscovery = { hubs: [], self: null, cloud: null }

// Hashes only fields that are stable across polls of the same feed item. The
// raw date string (as it appeared in the feed, or '' if absent) is used here —
// never the defaulted "now" — so an item with no date doesn't get a fresh
// guid, and thus re-insert as a new post, on every poll.
function fallbackGuid(title: string | null, content: string, rawDate: string): string {
  return createHash('sha256').update((title ?? '') + '\0' + content + '\0' + rawDate).digest('hex')
}

export const FETCH_TIMEOUT_MS = 10_000
const MAX_FEED_BYTES = 5 * 1024 * 1024

// Many feeds sit behind Cloudflare/WAFs that serve an HTML challenge to requests
// with no (or a bare `node`) User-Agent — which then fails parsing as "Unrecognized
// feed format". A descriptive UA + a feed Accept header gets the real feed back.
const FEED_FETCH_HEADERS = {
  'user-agent': 'Textcaster/0.1 (+https://github.com/rmdes/textcaster)',
  accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/json, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
}

// A garbage or unparseable raw date must not throw and kill the whole feed —
// it degrades to "now", same as a missing date. Callers still hash the raw
// string (not this return value) for the fallback guid, so determinism is unaffected.
function toIsoOrNow(raw: string, now: string): string {
  if (!raw) return now
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? now : d.toISOString()
}

export function toParsedItem(guid: string | undefined, title: string | null, content: string, url: string | null, rawDate: string, now: string): ParsedItem {
  return { guid: guid ?? url ?? fallbackGuid(title, content, rawDate), title, content, url, publishedAt: toIsoOrNow(rawDate, now) }
}

type ChannelLink = { href?: string; rel?: string }

function linksToDiscovery(links: ChannelLink[] | undefined): Pick<FeedDiscovery, 'hubs' | 'self'> {
  const hubs = (links ?? []).filter((l) => l.rel === 'hub' && l.href).map((l) => l.href as string)
  const self = (links ?? []).find((l) => l.rel === 'self' && l.href)?.href ?? null
  return { hubs, self }
}

export async function parseFeedWithMeta(body: string): Promise<{ items: ParsedItem[]; discovery: FeedDiscovery }> {
  // feedsmith's format detection chokes on a BOM, so strip it first.
  const cleanBody = body.charCodeAt(0) === 0xfeff ? body.slice(1) : body
  const now = new Date().toISOString()
  const parsed = parseFeedDocument(cleanBody)
  if (parsed.format === 'json') {
    const items = (parsed.feed.items ?? []).map((it) =>
      toParsedItem(it.id, it.title ?? null, it.content_text ?? it.content_html ?? '', it.url ?? null, it.date_published ?? '', now))
    const hubs = (parsed.feed.hubs ?? []).map((h) => h.url).filter((u): u is string => typeof u === 'string')
    return { items, discovery: { hubs, self: parsed.feed.feed_url ?? null, cloud: null } }
  }
  if (parsed.format === 'atom') {
    const items = (parsed.feed.entries ?? []).map((it) => {
      const url = it.links?.find((l) => l.href && (!l.rel || l.rel === 'alternate'))?.href ?? null
      return toParsedItem(it.id, it.title ?? null, it.content ?? it.summary ?? '', url, it.published ?? it.updated ?? '', now)
    })
    return { items, discovery: { ...linksToDiscovery(parsed.feed.links), cloud: null } }
  }
  if (parsed.format === 'rdf') {
    const items = (parsed.feed.items ?? []).map((it) =>
      toParsedItem(undefined, it.title ?? null, it.description ?? '', it.link ?? null, it.dc?.dates?.[0] ?? '', now))
    return { items, discovery: NO_DISCOVERY }
  }
  const items = (parsed.feed.items ?? []).map((it) =>
    toParsedItem(it.guid?.value, it.title ?? null, it.description ?? it.content?.encoded ?? '', it.link ?? null, it.pubDate ?? '', now))
  const c = parsed.feed.cloud
  const cloud = c && typeof c.domain === 'string' && typeof c.path === 'string' && c.protocol === 'http-post' && typeof c.port === 'number'
    ? { domain: c.domain, port: c.port, path: c.path, protocol: c.protocol }
    : null
  return { items, discovery: { ...linksToDiscovery(parsed.feed.atom?.links), cloud } }
}

export function parseLinkHeader(header: string | null): { hubs: string[]; self: string | null } {
  if (!header) return { hubs: [], self: null }
  const hubs: string[] = []
  let self: string | null = null
  for (const part of header.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="?([^";]+)"?/.exec(part.trim())
    if (!m) continue
    const rels = m[2].split(/\s+/)
    if (rels.includes('hub')) hubs.push(m[1])
    if (rels.includes('self') && !self) self = m[1]
  }
  return { hubs, self }
}

export async function ingestItems(repo: Repository, bus: EventBus, user: User, items: ParsedItem[]): Promise<number> {
  const backfill = !(await repo.hasPostsByAuthor(user.id))
  let inserted = 0
  for (const item of items) {
    const now = new Date()
    const publishedAt = new Date(item.publishedAt).getTime() > now.getTime() ? now.toISOString() : item.publishedAt
    const post: Post = { id: randomUUID(), authorId: user.id, source: 'remote', guid: item.guid, title: item.title, content: item.content, url: item.url, publishedAt, createdAt: now.toISOString() }
    if (await repo.insertPost(post)) {
      if (!backfill) bus.emitNewPost({ ...post, author: user })
      inserted++
    }
  }
  return inserted
}

async function fetchFeedBody(url: string, fetchFn: typeof fetch): Promise<{ body: string; res: Response }> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: FEED_FETCH_HEADERS })
  const contentLength = Number(res.headers.get('content-length') ?? '0')
  if (contentLength > MAX_FEED_BYTES) throw new Error(`feed exceeds size cap: ${contentLength} bytes`)
  // ponytail: cap rejects oversized bodies but only after buffering them; stream + abort past the cap if memory ever matters
  const body = await res.text()
  if (Buffer.byteLength(body) > MAX_FEED_BYTES) throw new Error(`feed exceeds size cap: ${Buffer.byteLength(body)} bytes`)
  return { body, res }
}

function looksLikeHtml(body: string): boolean {
  return body.trimStart().startsWith('<')
}

// lookupFn is DI-only (mirrors push-in.ts's PushInDeps.lookupFn): omitted, checkCallbackUrl
// falls back to real DNS — unchanged behavior for every existing production caller.
export async function ingestRemoteUser(repo: Repository, bus: EventBus, user: User, fetchFn: typeof fetch = fetch, lookupFn?: LookupFn): Promise<{ inserted: number; discovery: FeedDiscovery }> {
  if (!user.feedUrl) return { inserted: 0, discovery: NO_DISCOVERY }
  const { body, res } = await fetchFeedBody(user.feedUrl, fetchFn)

  let parsed
  try {
    parsed = await parseFeedWithMeta(body)
  } catch (err) {
    // Primary parse failed. If the body is HTML, try discovery; else re-throw.
    if (!looksLikeHtml(body)) throw err
    return await ingestViaDiscovery(repo, bus, user, user.feedUrl, body, fetchFn, lookupFn)
  }

  const inserted = await ingestItems(repo, bus, user, parsed.items)
  return { inserted, discovery: mergeDiscovery(res, parsed.discovery) }
}

function mergeDiscovery(res: Response, discovery: FeedDiscovery): FeedDiscovery {
  const header = parseLinkHeader(res.headers.get('link'))
  return {
    hubs: [...new Set([...header.hubs, ...discovery.hubs])],
    self: header.self ?? discovery.self,
    cloud: discovery.cloud,
  }
}

async function ingestViaDiscovery(repo: Repository, bus: EventBus, user: User, pageUrl: string, html: string, fetchFn: typeof fetch, lookupFn?: LookupFn): Promise<{ inserted: number; discovery: FeedDiscovery }> {
  const { feedUrl, hentries } = discoverFeed(html, pageUrl)

  // 1. Autodiscovery: a real feed link, one hop.
  if (feedUrl && feedUrl !== pageUrl) {
    const guard = await checkCallbackUrl(feedUrl, lookupFn)
    if (guard.ok) {
      const { body, res } = await fetchFeedBody(feedUrl, fetchFn) // follows redirects (feeds 301/302)
      const parsed = await parseFeedWithMeta(body) // may throw → bounded by pollAll's per-user catch
      const inserted = await ingestItems(repo, bus, user, parsed.items)
      // R1: persist only if no OTHER user already holds this feedUrl.
      const taken = (await repo.listRemoteUsers()).some((u) => u.id !== user.id && u.feedUrl === feedUrl)
      if (!taken) await repo.updateFeedUrl(user.id, feedUrl)
      return { inserted, discovery: mergeDiscovery(res, parsed.discovery) }
    }
    // guard rejected → fall through to h-feed
  }

  // 2. h-feed: the page is the feed; ingest its items, leave feedUrl unchanged.
  if (hentries.length > 0) {
    const inserted = await ingestItems(repo, bus, user, hentries)
    return { inserted, discovery: NO_DISCOVERY }
  }

  // 3. Neither.
  throw new Error('no feed found (no alternate link, no h-feed)')
}

export async function pollAll(repo: Repository, bus: EventBus, fetchFn: typeof fetch = fetch): Promise<void> {
  for (const user of await repo.listRemoteUsers()) {
    try { await ingestRemoteUser(repo, bus, user, fetchFn) }
    catch (err) { console.error(`ingest failed for ${user.handle}:`, err instanceof Error ? err.message : err) }
  }
}
