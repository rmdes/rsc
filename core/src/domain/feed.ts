import { generateRssFeed, generateJsonFeed } from 'feedsmith'
import type { WebSubMode } from '../config.ts'
import type { Post, User, TimelineEntry } from './types.ts'
import { renderLocalHtml } from './markdown.ts'

export interface FeedContext {
  publicUrl: string | null
  hubUrl: string | null
  rssCloud: boolean
}

// The emitted identity of a LOCAL post. A post created under a public URL
// stored url = `${publicUrl}/post/${id}` (service.ts) — that stored url IS the
// permalink and becomes a bare <guid> (rss.chat's convention, which our ingest
// already honors, and which Dave's threadwalker string-compares). A post with
// no stored url keeps its UUID guid with isPermaLink="false" (a bare non-URL
// guid would be a lie, and that post emits no <link> either — consistent).
// PIN (feedsmith 2.9.6): the URL branch omits the isPermaLink key entirely —
// isPermaLink:true would serialize an attribute that breaks the walker.
export function localGuid(p: Post): { value: string; isPermaLink?: false } {
  return p.url !== null ? { value: p.url } : { value: p.guid, isPermaLink: false }
}

// The emitted <guid> VALUE for injector keying — the same string the render
// paths put in the <guid> element. Local posts use their permalink (localGuid);
// remote posts keep their origin guid. Use this at EVERY injector call site so
// the remote guard can't be forgotten when a new one is added.
export function emittedGuid(p: Post): string {
  return p.source === 'local' ? localGuid(p).value : p.guid
}

export function feedUrls(publicUrl: string, handle: string): { xml: string; json: string } {
  return { xml: `${publicUrl}/users/${handle}/feed.xml`, json: `${publicUrl}/users/${handle}/feed.json` }
}

export function firehoseUrl(publicUrl: string): string {
  return `${publicUrl}/users/rss.xml`
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

// Dual contract per item: local posts emit rendered HTML + their markdown
// source; remote posts re-emit as stored (pass-through), incl. any captured
// source:markdown. Merges with replyWireElements' sourceNs (inReplyTo).
function itemContentFields(p: Post) {
  const reply = p.inReplyTo ? replyWireElements(p.inReplyTo) : undefined
  const markdown = p.source === 'local' ? p.content : p.contentMarkdown ?? undefined
  const sourceNs = { ...(reply?.sourceNs ?? {}), ...(markdown ? { markdown } : {}) }
  return {
    description: p.source === 'local' ? renderLocalHtml(p.content) : p.content,
    ...(Object.keys(sourceNs).length ? { sourceNs } : {}),
    ...(reply?.thr ? { thr: reply.thr } : {}),
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
        guid: localGuid(p),
        ...(p.url !== null ? { link: p.url } : {}),
        pubDate: p.publishedAt,
        ...itemContentFields(p),
      })),
    },
    // lenient: type-level only — selects the DeepPartial<..., DateLike> overload so
    // ISO date *strings* type-check; generateRfc822Date accepts string|Date at
    // runtime regardless (probed), so this has no runtime effect.
    { lenient: true },
  )
}

// The all-users firehose (rss.chat's /users/rss.xml convention): every LOCAL
// post, with RSS core <source> naming the item's author and linking their
// personal feed — the same element our ingest attributes rss.chat items by.
export function renderFirehoseRss(entries: TimelineEntry[], ctx: FeedContext): string {
  const host = ctx.publicUrl ? new URL(ctx.publicUrl).host : 'textcaster.invalid'
  const atomLinks: Array<{ rel: string; href: string; type?: string }> = []
  let cloud
  if (ctx.publicUrl) {
    atomLinks.push({ rel: 'self', href: firehoseUrl(ctx.publicUrl), type: 'application/rss+xml' })
    if (ctx.hubUrl) atomLinks.push({ rel: 'hub', href: ctx.hubUrl })
    if (ctx.rssCloud) {
      const u = new URL(ctx.publicUrl)
      cloud = { domain: u.hostname, port: urlPort(u), path: '/rsscloud/pleaseNotify', registerProcedure: '', protocol: 'http-post' }
    }
  }
  return generateRssFeed(
    {
      title: `${host}: all posts`,
      link: ctx.publicUrl ?? 'https://textcaster.invalid',
      description: `Posts from all users on ${host}`,
      ...(atomLinks.length ? { atom: { links: atomLinks } } : {}),
      ...(cloud ? { cloud } : {}),
      ...(ctx.publicUrl ? { sourceNs: { self: firehoseUrl(ctx.publicUrl) } } : {}),
      items: entries.map((p) => ({
        ...(p.title !== null ? { title: p.title } : {}),
        guid: localGuid(p),
        ...(p.url !== null ? { link: p.url } : {}),
        pubDate: p.publishedAt,
        // RSS core <source>: the item's author and their personal feed.
        ...(ctx.publicUrl ? { source: { title: p.author.displayName, url: feedUrls(ctx.publicUrl, p.author.handle).xml } } : {}),
        ...itemContentFields(p),
      })),
    },
    { lenient: true },
  )
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const xmlAttrEscape = (s: string) => xmlEscape(s).replace(/"/g, '&quot;')

// Shared injector core: feedsmith cannot serialize these sourceNs elements
// (probed: comments AND account are silently dropped), so they are injected
// into XML WE generated, keyed by the <guid> element value.
// ponytail: delete all of this the day feedsmith serializes them.
function injectItemElements(xml: string, ads: Array<{ guid: string; fragment: string }>): string {
  let out = xml
  let injected = false
  for (const ad of ads) {
    const markers = [`<![CDATA[${ad.guid}]]>`, `>${xmlAttrEscape(ad.guid)}</guid>`]
    let at = -1
    for (const m of markers) { at = out.indexOf(m); if (at !== -1) break }
    if (at === -1) continue
    const close = out.indexOf('</item>', at)
    if (close === -1) continue
    out = out.slice(0, close) + ad.fragment + out.slice(close)
    injected = true
  }
  if (injected && !out.slice(out.indexOf('<rss'), out.indexOf('>', out.indexOf('<rss')) + 1).includes('xmlns:source=')) {
    out = out.replace('<rss ', '<rss xmlns:source="http://source.scripting.com/" ')
  }
  return out
}

export function injectSourceComments(xml: string, ads: Array<{ guid: string; count: number; feedUrl: string }>): string {
  return injectItemElements(xml, ads.map((ad) => ({ guid: ad.guid, fragment: `<source:comments count="${ad.count}" feedUrl="${xmlAttrEscape(ad.feedUrl)}"/>` })))
}
// source:account was injected per-item so Dave's old threadwalker could read the
// author. As of rss.chat issue #14 the walker reads the RSS core <source> element
// instead, and item-level source:account is a spec violation (it's channel-level).
// Every feed now carries core <source> for attribution (firehose + comments) or a
// single-author channel (personal feed), so the injector is gone.

// The author's canonical feed URL for a core <source> element: a remote author's
// own origin feed; a local author's feed on this instance (needs publicUrl).
function authorSourceUrl(author: User, ctx: FeedContext): string | null {
  return author.feedUrl ?? (ctx.publicUrl ? feedUrls(ctx.publicUrl, author.handle).xml : null)
}

export function renderCommentsFeed(post: Post, replies: TimelineEntry[], ctx: FeedContext): string {
  const chars = Array.from(post.content) // code-point safe: .length/.slice on a string split surrogate pairs
  const label = post.title ?? (chars.length > 60 ? `${chars.slice(0, 60).join('')}…` : post.content)
  return generateRssFeed(
    {
      title: `Comments on "${label}"`,
      link: post.url ?? ctx.publicUrl ?? 'https://textcaster.invalid',
      description: `Replies to "${label}"`,
      items: replies.map((p) => {
        const srcUrl = authorSourceUrl(p.author, ctx)
        return {
          ...(p.title !== null ? { title: p.title } : {}),
          // Unlike the other two RSS paths, replies here can be remote (a
          // cross-instance reply resolves onto our local post) — only local
          // items get the permalink-guid treatment; a remote item's guid VALUE
          // must stay p.guid verbatim, never swapped to p.url.
          guid: p.source === 'local' ? localGuid(p) : { value: p.guid, isPermaLink: false },
          ...(p.url !== null ? { link: p.url } : {}),
          pubDate: p.publishedAt,
          // RSS core <source>: the reply's author + their feed. Dave's fixed
          // threadwalker (issue #14) reads the author from here, and a comments
          // feed has no single-author channel to fall back to — so a reply
          // without it walks as "?". Mirrors renderFirehoseRss.
          ...(srcUrl ? { source: { title: p.author.displayName, url: srcUrl } } : {}),
          ...itemContentFields(p),
        }
      }),
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
        id: localGuid(p).value,
        ...(p.title !== null ? { title: p.title } : {}),
        ...(p.source === 'local'
          ? { content_html: renderLocalHtml(p.content), content_text: p.content }
          : { content_text: p.content }),
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
