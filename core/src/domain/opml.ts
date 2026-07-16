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
  return generateOpml({ head: { title: `${displayName} — following` }, body: { outlines } })
}
