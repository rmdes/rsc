import { mf2 } from 'microformats-parser'
import { mf2tojf2, type Jf2 } from '@paulrobertlloyd/mf2tojf2'
import { toParsedItem } from './ingest.ts'
import type { ParsedItem } from './ingest.ts'

export interface Discovered {
  feedUrl: string | null
  hentries: ParsedItem[]
}

const FEED_TYPES = new Set(['application/rss+xml', 'application/atom+xml', 'application/feed+json'])

// code-point-safe (plain .slice splits surrogate pairs); trim BEFORE cutting so
// whitespace never becomes a bare '…'; slice a bounded UTF-16 prefix before
// Array.from (bodies capped only by MAX_FEED_BYTES = 5 MB). Mirrors feed.ts:200.
export function truncate(s: string | null, n: number): string | null {
  const t = s?.trim()
  if (!t) return null
  const cp = Array.from(t.slice(0, n * 2 + 2))
  return cp.length > n ? cp.slice(0, n).join('').trimEnd() + '…' : t
}

export function parseInReplyTo(irt: unknown): {
  ref: string | null
  contextAuthor: string | null
  contextSnippet: string | null
} {
  let v = irt
  if (v && typeof v === 'object' && Array.isArray((v as { children?: unknown }).children)) {
    v = (v as { children: unknown[] }).children[0] // F1: multi-cite wrapper
  }
  const first = Array.isArray(v) ? v[0] : v
  if (typeof first === 'string') return { ref: first, contextAuthor: null, contextSnippet: null }
  if (first && typeof first === 'object') {
    const cite = first as { url?: unknown; author?: unknown; content?: unknown }
    const url = cite.url
    const ref = typeof url === 'string' ? url : Array.isArray(url) && typeof url[0] === 'string' ? url[0] : null // F2
    const author =
      cite.author && typeof cite.author === 'object' && typeof (cite.author as { name?: unknown }).name === 'string'
        ? (cite.author as { name: string }).name
        : typeof cite.author === 'string' ? cite.author : null
    if (!author) return { ref, contextAuthor: null, contextSnippet: null } // P4: no author → no renderable context
    const rawSnippet =
      cite.content && typeof cite.content === 'object' && typeof (cite.content as { text?: unknown }).text === 'string'
        ? (cite.content as { text: string }).text
        : typeof cite.content === 'string' ? cite.content
        : null
    return { ref, contextAuthor: author, contextSnippet: truncate(rawSnippet, 200) }
  }
  return { ref: null, contextAuthor: null, contextSnippet: null }
}

function jf2Content(e: Jf2): string {
  if (typeof e.content === 'string' && e.content) return e.content
  if (e.content && typeof e.content === 'object') {
    const c = e.content.text || e.content.html
    if (c) return c
  }
  return e.summary || e.name || ''
}

export function discoverFeed(html: string, pageUrl: string): Discovered {
  let parsed
  try {
    parsed = mf2(html, { baseUrl: pageUrl })
  } catch {
    return { feedUrl: null, hentries: [] }
  }

  // Autodiscovery: first alternate link whose type is a feed type (rel-urls is
  // populated in document order; hrefs are already absolute against baseUrl).
  let feedUrl: string | null = null
  for (const [url, info] of Object.entries(parsed['rel-urls'])) {
    if (info.rels.includes('alternate') && info.type && FEED_TYPES.has(info.type)) {
      feedUrl = url
      break
    }
  }

  // h-feed: convert to JF2 (which drops implied p-names — H1) and map entries.
  // A typed single entry is always itself, even when it carries children from nested
  // microformats (e.g. h-card). Everything else takes children.
  const jf2 = mf2tojf2(parsed)
  const entries: Jf2[] = jf2.type === 'entry' ? [jf2] : (jf2.children ?? [])
  const now = new Date().toISOString()
  const hentries = entries
    .filter((e) => e.type === 'entry')
    .map((e) => {
      const content = jf2Content(e)
      // mf2tojf2 already drops implied names; the !== content guard is belt-and-
      // suspenders so a name that duplicates the body never becomes a title.
      const title = e.name && e.name !== content ? e.name : null
      const rawDate = typeof e.published === 'string' ? e.published : ''
      const irt = e['in-reply-to']
      const { ref, contextAuthor, contextSnippet } = parseInReplyTo(irt)
      // `guid` stays `e.uid ?? e.url ?? fallbackGuid` (unchanged, v1-load-bearing);
      // the raw u-uid is surfaced ADDITIVELY for the v2 acquisition h-feed adapter.
      const uid = typeof e.uid === 'string' ? e.uid : null
      return { ...toParsedItem(e.uid ?? e.url, title, content, e.url ?? null, rawDate, now, ref, undefined, null, null, { author: contextAuthor, snippet: contextSnippet }), uid }
    })

  return { feedUrl, hentries }
}
