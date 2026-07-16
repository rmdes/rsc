import { generateOpml, parseOpml } from 'feedsmith'
import { feedUrls } from './feed.ts'
import { HandleTakenError } from './types.ts'
import type { User, NewRemoteUser } from './types.ts'

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

const MAX_OUTLINES = 1000 // H5: bound user creation per import
const MAX_HANDLE_ATTEMPTS = 50

interface Outline { text?: string; title?: string; xmlUrl?: string; outlines?: Outline[] }

// Import calls the service directly, which does NOT validate the URL scheme
// (that guard lives only in the POST /users route). Without this check a
// non-http(s) xmlUrl would create a permanent user the poller can never fetch
// (new URL() throws every cycle, forever) — P1.
function isHttpUrl(u: string): boolean {
  try {
    const p = new URL(u).protocol
    return p === 'http:' || p === 'https:'
  } catch {
    return false
  }
}

function flatten(outlines: Outline[] | undefined, out: Outline[]): void {
  for (const o of outlines ?? []) {
    if (typeof o.xmlUrl === 'string') out.push(o)
    if (o.outlines) flatten(o.outlines, out) // folders are structure, not feeds (H1)
  }
}

function slugBase(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 61) // 64 − room for "-50" (H3)
  return s || 'feed'
}

export interface ImportDeps {
  listRemoteUsers: () => Promise<User[]>
  getUserByHandle: (h: string) => Promise<User | undefined>
  addRemoteUser: (i: NewRemoteUser) => Promise<User>
  addFollow: (follower: User, target: User) => Promise<void>
  publicUrl: string | null
}

// Parse an "our own feed" URL → the local handle it points at, else null (H2: both minted URLs).
function localHandleForUrl(url: string, publicUrl: string | null): string | null {
  if (!publicUrl) return null
  const prefix = `${publicUrl}/users/`
  if (!url.startsWith(prefix)) return null
  const rest = url.slice(prefix.length) // "<handle>/feed.xml" | "<handle>/feed.json"
  const m = /^([^/]+)\/feed\.(xml|json)$/.exec(rest)
  return m ? m[1] : null
}

export async function importFollowingOpml(deps: ImportDeps, follower: User, body: string): Promise<{ followed: number; created: number; skipped: number }> {
  const parsed = parseOpml(body)
  const flat: Outline[] = []
  flatten(parsed.body?.outlines as Outline[] | undefined, flat)

  const byFeedUrl = new Map((await deps.listRemoteUsers()).map((u) => [u.feedUrl as string, u]))
  const seenUrls = new Set<string>()
  const assignedHandles = new Set<string>()
  const capped = flat.slice(0, MAX_OUTLINES)
  let followed = 0, created = 0, skipped = flat.length - capped.length // H5: over-cap outlines count as skipped

  for (const o of capped) {
    const xmlUrl = o.xmlUrl as string
    if (seenUrls.has(xmlUrl)) { skipped++; continue } // duplicate xmlUrl in file
    seenUrls.add(xmlUrl)
    if (!isHttpUrl(xmlUrl)) { skipped++; continue } // P1: non-http(s) → skip, never create
    try {
      // Case 1: a remote user already has this feedUrl.
      const existing = byFeedUrl.get(xmlUrl)
      if (existing) { await deps.addFollow(follower, existing); followed++; continue }
      // Case 2: one of our own minted local feed URLs (H2).
      const localHandle = localHandleForUrl(xmlUrl, deps.publicUrl)
      if (localHandle) {
        const localUser = await deps.getUserByHandle(localHandle)
        if (localUser && localUser.kind === 'local') { await deps.addFollow(follower, localUser); followed++; continue }
      }
      // Case 3: create a remote user, then follow.
      const displayName = (o.text ?? o.title ?? '').trim() || xmlUrl
      const base = slugBase(o.text ?? o.title ?? '')
      let handleUser: User | undefined
      for (let n = 1; n <= MAX_HANDLE_ATTEMPTS; n++) {
        const candidate = n === 1 ? base : `${base}-${n}`
        if (assignedHandles.has(candidate)) continue // same-slug collision within this file (H3)
        try {
          handleUser = await deps.addRemoteUser({ handle: candidate, displayName, feedUrl: xmlUrl })
          assignedHandles.add(candidate)
          break
        } catch (err) {
          if (err instanceof HandleTakenError) continue // collision in DB — try next suffix
          throw err // invalid feedUrl scheme etc. → outer catch skips
        }
      }
      if (!handleUser) { skipped++; continue } // exhausted attempts
      byFeedUrl.set(xmlUrl, handleUser)
      await deps.addFollow(follower, handleUser)
      created++; followed++
    } catch {
      skipped++ // create/follow errored (e.g. non-http(s) xmlUrl) — keep going
    }
  }
  return { followed, created, skipped }
}
