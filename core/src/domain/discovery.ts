import { mf2 } from 'microformats-parser'
import { mf2tojf2, type Jf2 } from '@paulrobertlloyd/mf2tojf2'
import { toParsedItem } from './ingest.ts'
import type { ParsedItem } from './ingest.ts'

export interface Discovered {
  feedUrl: string | null
  hentries: ParsedItem[]
}

const FEED_TYPES = new Set(['application/rss+xml', 'application/atom+xml', 'application/feed+json'])

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
  const jf2 = mf2tojf2(parsed)
  const entries: Jf2[] = jf2.children ?? (jf2.type === 'entry' ? [jf2] : [])
  const now = new Date().toISOString()
  const hentries = entries
    .filter((e) => e.type === 'entry')
    .map((e) => {
      const content = jf2Content(e)
      // mf2tojf2 already drops implied names; the !== content guard is belt-and-
      // suspenders so a name that duplicates the body never becomes a title.
      const title = e.name && e.name !== content ? e.name : null
      const rawDate = typeof e.published === 'string' ? e.published : ''
      return toParsedItem(e.uid ?? e.url, title, content, e.url ?? null, rawDate, now)
    })

  return { feedUrl, hentries }
}
