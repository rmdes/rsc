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
        port: u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80,
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
      })),
    },
    // lenient: type-level only — selects the DeepPartial<..., DateLike> overload so
    // ISO date *strings* type-check; generateRfc822Date accepts string|Date at
    // runtime regardless (probed), so this has no runtime effect.
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
