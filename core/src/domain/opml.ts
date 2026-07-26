import { generateOpml } from 'feedsmith'
import { feedUrls } from './feed.ts'
import type { User } from './types.ts'

export function buildFollowingOpml(displayName: string, following: User[], publicUrl: string | null): string {
  const outlines: Array<{ type: 'rss'; text: string; xmlUrl: string }> = []
  for (const u of following) {
    if (u.kind === 'remote' && u.feedUrl) {
      outlines.push({ type: 'rss', text: u.displayName, xmlUrl: u.feedUrl })
    } else if (u.kind === 'local' && publicUrl) {
      outlines.push({ type: 'rss', text: u.displayName, xmlUrl: feedUrls(publicUrl, u.handle).xml })
    }
    // local && !publicUrl → omitted (H4): a relative URL is junk to any aggregator.
  }
  const title = `${displayName} — following`
  // feedsmith's generateOpml throws "Invalid input OPML" on an empty outline
  // list, but a user who follows nobody has a valid (empty) subscription list.
  // Emit it directly so the export route never 500s; parseOpml round-trips it
  // back to zero outlines.
  if (outlines.length === 0) {
    return `<?xml version="1.0" encoding="utf-8"?>\n<opml version="2.0">\n  <head><title>${escapeXml(title)}</title></head>\n  <body></body>\n</opml>\n`
  }
  return generateOpml({ head: { title }, body: { outlines } })
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Parse an "our own feed" URL → the local handle it points at, else null (H2: both minted URLs).
export function localHandleForUrl(url: string, publicUrl: string | null): string | null {
  if (!publicUrl) return null
  const prefix = `${publicUrl}/users/`
  if (!url.startsWith(prefix)) return null
  const rest = url.slice(prefix.length) // "<handle>/feed.xml" | "<handle>/feed.json"
  const m = /^([^/]+)\/feed\.(xml|json)$/.exec(rest)
  return m ? m[1] : null
}
