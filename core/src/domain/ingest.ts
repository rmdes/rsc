import { createHash } from 'node:crypto'
import { parseFeed as parseFeedDocument } from 'feedsmith'

// `uid` is ADDITIVE and read by NOTHING in v1 ingest — `guid` (the folded
// `uid ?? url ?? fallbackGuid`) is unchanged, so the flag-off path and the
// existing `posts` rows are byte-identical. Only discoverFeed sets it (the raw
// h-feed u-uid) and only the v2 acquisition h-feed adapter reads it, to key an
// edited uid-bearing entry as opaque:<uid> instead of forking on a url change.
export interface ParsedItem { guid: string; title: string | null; content: string; url: string | null; publishedAt: string; inReplyTo: string | null; sourceName: string | null; sourceFeedUrl: string | null; contentMarkdown: string | null; updatedAt: string | null; replyContextAuthor: string | null; replyContextSnippet: string | null; uid?: string | null }

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

// Shared with logical/push.ts, which is now its only consumer.
export const FETCH_TIMEOUT_MS = 10_000

// A garbage or unparseable raw date must not throw and kill the whole feed —
// it degrades to "now", same as a missing date. Callers still hash the raw
// string (not this return value) for the fallback guid, so determinism is unaffected.
function toIsoOrNow(raw: string, now: string): string {
  if (!raw) return now
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? now : d.toISOString()
}

// source:inReplyTo (Textcasting) preferred, thr:in-reply-to (RFC 4685) fallback.
// Shapes probed against feedsmith 2.9.6; Atom exposes thr only (no sourceNs).
function itemInReplyTo(it: { sourceNs?: { inReplyTo?: { value?: string } }; thr?: { inReplyTos?: Array<{ ref?: string; href?: string }> } }): string | null {
  return it.sourceNs?.inReplyTo?.value ?? it.thr?.inReplyTos?.[0]?.ref ?? it.thr?.inReplyTos?.[0]?.href ?? null
}

const httpOnly = (u: string | null | undefined) => (u && /^https?:\/\//i.test(u) ? u : null)

export function toParsedItem(guid: string | undefined, title: string | null, content: string, url: string | null, rawDate: string, now: string, inReplyTo: string | null = null, source?: { title?: string; url?: string }, contentMarkdown: string | null = null, updatedAt: string | null = null, reply: { author: string | null; snippet: string | null } = { author: null, snippet: null }): ParsedItem {
  // Item links come from remote feed content and end up as <a href> in the web
  // client — only http(s) survives (a javascript: link would be click-to-XSS).
  // The guid fallback chain keeps the RAW value: it's an opaque dedup id, and
  // changing its derivation would re-ingest every existing item under a new id.
  return {
    guid: guid ?? url ?? fallbackGuid(title, content, rawDate),
    title,
    content,
    url: httpOnly(url),
    publishedAt: toIsoOrNow(rawDate, now),
    inReplyTo,
    // RSS core <source url>name</source> — per-item attribution in aggregate
    // feeds (rss.chat's firehose). The url renders as an href: http(s) only.
    sourceName: source?.title ?? null,
    sourceFeedUrl: httpOnly(source?.url),
    contentMarkdown,
    updatedAt,
    replyContextAuthor: reply.author,
    replyContextSnippet: reply.snippet,
  }
}

type ChannelLink = { href?: string; rel?: string }

function linksToDiscovery(links: ChannelLink[] | undefined): Pick<FeedDiscovery, 'hubs' | 'self'> {
  const hubs = (links ?? []).filter((l) => l.rel === 'hub' && l.href).map((l) => l.href as string)
  const self = (links ?? []).find((l) => l.rel === 'self' && l.href)?.href ?? null
  return { hubs, self }
}

export async function parseFeedWithMeta(body: string): Promise<{ items: ParsedItem[]; discovery: FeedDiscovery; title: string | null }> {
  // feedsmith's format detection chokes on a BOM, so strip it first.
  const cleanBody = body.charCodeAt(0) === 0xfeff ? body.slice(1) : body
  const now = new Date().toISOString()
  const parsed = parseFeedDocument(cleanBody)
  if (parsed.format === 'json') {
    const items = (parsed.feed.items ?? []).map((it) =>
      toParsedItem(it.id, it.title ?? null, it.content_html ?? it.content_text ?? '', it.url ?? null, it.date_published ?? '', now, null, undefined, null, it.date_modified ?? null))
    const hubs = (parsed.feed.hubs ?? []).map((h) => h.url).filter((u): u is string => typeof u === 'string')
    return { items, discovery: { hubs, self: parsed.feed.feed_url ?? null, cloud: null }, title: parsed.feed.title ?? null }
  }
  if (parsed.format === 'atom') {
    const items = (parsed.feed.entries ?? []).map((it) => {
      const url = it.links?.find((l) => l.href && (!l.rel || l.rel === 'alternate'))?.href ?? null
      return toParsedItem(it.id, it.title ?? null, it.content ?? it.summary ?? '', url, it.published ?? it.updated ?? '', now, itemInReplyTo(it), undefined, null, it.updated ?? null)
    })
    return { items, discovery: { ...linksToDiscovery(parsed.feed.links), cloud: null }, title: parsed.feed.title ?? null }
  }
  if (parsed.format === 'rdf') {
    const items = (parsed.feed.items ?? []).map((it) =>
      toParsedItem(undefined, it.title ?? null, it.description ?? '', it.link ?? null, it.dc?.dates?.[0] ?? '', now))
    return { items, discovery: NO_DISCOVERY, title: parsed.feed.title ?? null }
  }
  const items = (parsed.feed.items ?? []).map((it) =>
    toParsedItem(
      it.guid?.value,
      it.title ?? null,
      it.description ?? it.content?.encoded ?? '',
      // RSS 2.0: a guid without isPermaLink="false" IS the item's permalink.
      // rss.chat items carry no <link> at all — the guid is the only URL.
      // toParsedItem's httpOnly() still gates the scheme downstream.
      it.link ?? (it.guid?.value !== undefined && it.guid.isPermaLink !== false ? it.guid.value : null),
      it.pubDate ?? '',
      now,
      itemInReplyTo(it),
      it.source,
      it.sourceNs?.markdown ?? null,
      it.atom?.updated ?? null,
    ))
  const c = parsed.feed.cloud
  const cloud = c && typeof c.domain === 'string' && typeof c.path === 'string' && c.protocol === 'http-post' && typeof c.port === 'number'
    ? { domain: c.domain, port: c.port, path: c.path, protocol: c.protocol }
    : null
  return { items, discovery: { ...linksToDiscovery(parsed.feed.atom?.links), cloud }, title: parsed.feed.title ?? null }
}

export function parseLinkHeader(header: string | null): { hubs: string[]; self: string | null } {
  if (!header) return { hubs: [], self: null }
  const hubs: string[] = []
  let self: string | null = null
  // Split on commas outside quotes (a quoted param may contain one), then find
  // rel= anywhere among the params — not just first — scanning only past the
  // <url> so a rel= inside the URL's query string can't match.
  for (const part of header.match(/(?:[^,"]|"[^"]*")+/g) ?? []) {
    const urlM = /<([^>]+)>/.exec(part)
    if (!urlM) continue
    const relM = /(?:^|;)\s*rel\s*=\s*"?([^";]+)"?/.exec(part.slice(urlM.index + urlM[0].length))
    if (!relM) continue
    const rels = relM[1].split(/\s+/)
    if (rels.includes('hub')) hubs.push(urlM[1])
    if (rels.includes('self') && !self) self = urlM[1]
  }
  return { hubs, self }
}

// Exported for the logical-v2 acquisition engine's inert push-capability
// discovery (spec §1.2): it merges the response Link header with in-body hub/
// self/cloud advertisements, then hands the result to choosePushTarget. Reused
// rather than reimplemented so the Link-header + in-body merge stays one path.
export function mergeDiscovery(res: Response, discovery: FeedDiscovery): FeedDiscovery {
  const header = parseLinkHeader(res.headers.get('link'))
  return {
    hubs: [...new Set([...header.hubs, ...discovery.hubs])],
    self: header.self ?? discovery.self,
    cloud: discovery.cloud,
  }
}
