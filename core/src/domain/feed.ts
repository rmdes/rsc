import { generateRssFeed, generateJsonFeed } from 'feedsmith'
import type { WebSubMode } from '../config.ts'
import type { Post, User } from './types.ts'

export interface FeedContext {
  publicUrl: string | null
  hubUrl: string | null
  rssCloud: boolean
}

export function feedUrls(publicUrl: string, handle: string): { xml: string; json: string } {
  return { xml: `${publicUrl}/users/${handle}/feed.xml`, json: `${publicUrl}/users/${handle}/feed.json` }
}

export function urlPort(u: URL): number {
  return u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80
}

export function hubLinkUrl(websub: WebSubMode, publicUrl: string | null): string | null {
  if (websub.mode === 'external') return websub.hubUrl
  if (websub.mode === 'self' && publicUrl) return `${publicUrl}/hub`
  return null
}

// Channel link is required by RSS 2.0; without a configured public URL there
// is no honest absolute URL, so use an explicitly-invalid placeholder host.
function channelLink(ctx: FeedContext, handle: string): string {
  return ctx.publicUrl ? `${ctx.publicUrl}/users/${handle}` : `https://textcaster.invalid/users/${handle}`
}

// Dual-emit reply metadata: source:inReplyTo (Textcasting; isPermaLink=false for
// non-permalink refs, per source-namespace docs) + thr:in-reply-to (RFC 4685).
export function replyWireElements(ref: string) {
  const isUrl = ref.startsWith('http://') || ref.startsWith('https://')
  return {
    sourceNs: { inReplyTo: { value: ref, ...(isUrl ? {} : { isPermaLink: false }) } },
    thr: { inReplyTos: [{ ref, ...(isUrl ? { href: ref } : {}) }] },
  }
}

export function renderRssFeed(user: User, posts: Post[], ctx: FeedContext): string {
  const atomLinks: Array<{ href: string; rel: string; type?: string }> = []
  let cloud
  if (ctx.publicUrl) {
    atomLinks.push({ href: feedUrls(ctx.publicUrl, user.handle).xml, rel: 'self', type: 'application/rss+xml' })
    if (ctx.hubUrl) atomLinks.push({ href: ctx.hubUrl, rel: 'hub' })
    if (ctx.rssCloud) {
      const u = new URL(ctx.publicUrl)
      cloud = {
        domain: u.hostname,
        port: urlPort(u),
        path: '/rsscloud/pleaseNotify',
        registerProcedure: '', // feedsmith omits the empty attribute — expected output
        protocol: 'http-post',
      }
    }
  }
  return generateRssFeed(
    {
      title: user.displayName,
      link: channelLink(ctx, user.handle),
      description: `Posts by ${user.displayName}`,
      ...(atomLinks.length ? { atom: { links: atomLinks } } : {}),
      ...(cloud ? { cloud } : {}),
      items: posts.map((p) => ({
        ...(p.title !== null ? { title: p.title } : {}), // Textcasting: never synthesize a title
        description: p.content,
        guid: { value: p.guid, isPermaLink: false },
        ...(p.url !== null ? { link: p.url } : {}),
        pubDate: p.publishedAt,
        ...(p.inReplyTo ? replyWireElements(p.inReplyTo) : {}),
      })),
    },
    // lenient: type-level only — selects the DeepPartial<..., DateLike> overload so
    // ISO date *strings* type-check; generateRfc822Date accepts string|Date at
    // runtime regardless (probed), so this has no runtime effect.
    { lenient: true },
  )
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const xmlAttrEscape = (s: string) => xmlEscape(s).replace(/"/g, '&quot;')

// feedsmith 2.9.6 cannot serialize <source:comments count feedUrl/> (probed —
// silently dropped), so it is injected into XML WE generated: feedsmith's item
// output is deterministic, and guids are matched as the <guid> ELEMENT value.
// ponytail: delete this the day feedsmith's sourceNs types grow `comments`.
export function injectSourceComments(xml: string, ads: Array<{ guid: string; count: number; feedUrl: string }>): string {
  let out = xml
  let injected = false
  for (const ad of ads) {
    // feedsmith CDATA-wraps guid values containing & < > and entity-escapes "
    // in plain text (probed) — match both serializations or the ad is skipped.
    const markers = [`<![CDATA[${ad.guid}]]>`, `>${xmlAttrEscape(ad.guid)}</guid>`]
    let at = -1
    for (const m of markers) { at = out.indexOf(m); if (at !== -1) break }
    if (at === -1) continue
    const close = out.indexOf('</item>', at)
    if (close === -1) continue
    out = out.slice(0, close) + `<source:comments count="${ad.count}" feedUrl="${xmlAttrEscape(ad.feedUrl)}"/>` + out.slice(close)
    injected = true
  }
  if (injected && !out.includes('xmlns:source=')) {
    out = out.replace('<rss ', '<rss xmlns:source="http://source.scripting.com/" ')
  }
  return out
}

export function renderCommentsFeed(post: Post, replies: Post[], ctx: FeedContext): string {
  const label = post.title ?? (post.content.length > 60 ? `${post.content.slice(0, 60)}…` : post.content)
  return generateRssFeed(
    {
      title: `Comments on "${label}"`,
      link: post.url ?? ctx.publicUrl ?? '',
      description: `Replies to "${label}"`,
      items: replies.map((p) => ({
        ...(p.title !== null ? { title: p.title } : {}),
        description: p.content,
        guid: { value: p.guid, isPermaLink: false },
        ...(p.url !== null ? { link: p.url } : {}),
        pubDate: p.publishedAt,
        ...(p.inReplyTo ? replyWireElements(p.inReplyTo) : {}),
      })),
    },
    { lenient: true },
  )
}

export function renderJsonFeed(user: User, posts: Post[], ctx: FeedContext): string {
  const feed = generateJsonFeed(
    {
      title: user.displayName,
      description: `Posts by ${user.displayName}`,
      ...(ctx.publicUrl ? { feed_url: feedUrls(ctx.publicUrl, user.handle).json } : {}),
      ...(ctx.hubUrl ? { hubs: [{ type: 'WebSub', url: ctx.hubUrl }] } : {}),
      items: posts.map((p) => ({
        id: p.guid,
        ...(p.title !== null ? { title: p.title } : {}),
        content_text: p.content,
        ...(p.url !== null ? { url: p.url } : {}),
        date_published: p.publishedAt,
      })),
    },
    // lenient: type-level only — see renderRssFeed; generateJsonFeed's JS impl
    // ignores options entirely, so this has no runtime effect either.
    { lenient: true },
  )
  return JSON.stringify(feed, null, 1) // generateJsonFeed returns an OBJECT (probed)
}
