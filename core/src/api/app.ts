import { Hono } from 'hono'
import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { bodyLimit } from 'hono/body-limit'
import { sessionAuth, registeredOnly, sessionOrToken, requireAdmin } from './auth.ts'
import type { UserDirectory } from './auth.ts'
import { parseCursor, formatCursor } from './cursor.ts'
import { DomainError, HandleTakenError } from '../domain/types.ts'
import { renderRssFeed, renderJsonFeed, renderCommentsFeed, injectSourceComments, renderFirehoseRss, injectSourceAccounts, emittedGuid } from '../domain/feed.ts'
import { buildFollowingOpml, importFollowingOpml } from '../domain/opml.ts'
import type { FeedContext } from '../domain/feed.ts'
import type { Service } from '../domain/service.ts'
import type { EventBus } from '../domain/bus.ts'
import type { Auth } from '../auth.ts'

function isValidFeedUrl(feedUrl: unknown): feedUrl is string {
  if (typeof feedUrl !== 'string') return false
  try {
    const protocol = new URL(feedUrl).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function isString(v: unknown, min: number, max: number): v is string {
  return typeof v === 'string' && v.length >= min && v.length <= max
}

async function readJsonBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    return await c.req.json()
  } catch {
    return null
  }
}

const REPLAY_CAP = 100

export interface PushApi {
  websub?: (form: Record<string, string>) => Promise<{ status: 202 | 400 | 404 | 429; error?: string }>
  rsscloud?: (form: Record<string, string>, requesterIp: string | null) => Promise<{ status: 202 | 400 | 404 | 429; error?: string }>
}

export interface PushInApi {
  websubVerify: (token: string, query: Record<string, string>) => Promise<{ status: number; body: string }>
  websubDeliver: (token: string, body: string, signature: string | null) => Promise<number>
  rsscloudChallenge?: (url: string, challenge: string) => Promise<{ status: number; body: string }>
  rsscloudPing?: (url: string) => Promise<number>
}

const MAX_FAT_PING_BYTES = 5 * 1024 * 1024
const MAX_FORM_BYTES = 64 * 1024
const rejectOversized = (c: Context) => c.text('payload too large', 413)

export function createApp(deps: { service: Service; bus: EventBus; token: string; auth: Auth; users: UserDirectory; feeds?: FeedContext; pushApi?: PushApi; pushInApi?: PushInApi; mailEnabled?: boolean; adminEmails?: ReadonlySet<string> }): Hono {
  const { service, bus, token } = deps
  const feeds: FeedContext = deps.feeds ?? { publicUrl: null, hubUrl: null, rssCloud: false }
  const mailEnabled = deps.mailEnabled ?? true
  const adminEmails = deps.adminEmails ?? new Set<string>()
  const app = new Hono()

  app.onError((err, c) => {
    if (err instanceof DomainError) return c.json({ error: err.message }, 400)
    console.error(err)
    return c.json({ error: 'internal error' }, 500)
  })

  app.get('/health', (c) => c.json({ ok: true, mailEnabled }))

  // F-2: without a configured mailer, refuse the routes that would create an
  // unverifiable account (or send mail we cannot send) — up front, so no
  // limbo row is ever written. GET flows (verify/reset links) are unaffected.
  const MAIL_GATED = new Set(['/api/auth/sign-up/email', '/api/auth/sign-in/magic-link', '/api/auth/request-password-reset'])
  app.on('POST', [...MAIL_GATED], (c) => {
    if (mailEnabled) return deps.auth.handler(c.req.raw)
    return c.json({ error: 'email accounts are not available on this instance' }, 503)
  })

  app.on(['GET', 'POST'], '/api/auth/*', (c) => deps.auth.handler(c.req.raw))

  app.post('/users', sessionOrToken(token, deps.auth, deps.users), async (c) => {
    const body = await readJsonBody(c)
    if (!body) return c.json({ error: 'body invalid' }, 400)
    const { handle, displayName, feedUrl } = body
    if (!isString(handle, 1, 64)) return c.json({ error: 'handle invalid' }, 400)
    if (displayName !== undefined && !isString(displayName, 0, 200)) return c.json({ error: 'displayName invalid' }, 400)
    if (!isString(feedUrl, 1, 2048) || !isValidFeedUrl(feedUrl)) return c.json({ error: 'feedUrl invalid' }, 400)
    const effectiveDisplayName = typeof displayName === 'string' && displayName.trim() !== '' ? displayName : handle
    const user = await service.addRemoteUser({ handle, displayName: effectiveDisplayName, feedUrl })
    return c.json({ user }, 201)
  })

  app.post('/posts', sessionAuth(deps.auth, deps.users), async (c) => {
    const body = await readJsonBody(c)
    if (!body) return c.json({ error: 'body invalid' }, 400)
    const { content, inReplyTo } = body
    if (!isString(content, 1, 100000)) return c.json({ error: 'content invalid' }, 400)
    if (inReplyTo !== undefined && !isString(inReplyTo, 1, 64)) return c.json({ error: 'inReplyTo invalid' }, 400)
    let replyTarget
    if (typeof inReplyTo === 'string') {
      replyTarget = await service.getPost(inReplyTo)
      if (!replyTarget) return c.json({ error: 'unknown post' }, 404)
    }
    const me = c.get('coreUser')
    const post = await service.createLocalPostAs(me.handle, me.displayName, content, replyTarget)
    return c.json({ post }, 201)
  })

  async function resolveUser(handleRaw: string): Promise<import('../domain/types.ts').User | undefined> {
    return service.getUserByHandle(handleRaw.toLowerCase())
  }

  app.get('/me', sessionAuth(deps.auth, deps.users, adminEmails), (c) => c.json({ user: c.get('coreUser'), isAnonymous: c.get('sessionIsAnonymous'), isAdmin: c.get('isAdmin') }))

  app.get('/admin/status', sessionAuth(deps.auth, deps.users, adminEmails), requireAdmin(), (c) => c.json({ ok: true, adminEmails: [...adminEmails] }))

  app.patch('/me', sessionAuth(deps.auth, deps.users), async (c) => {
    const body = await readJsonBody(c)
    if (!body) return c.json({ error: 'body invalid' }, 400)
    const { handle, displayName } = body
    if (handle !== undefined && !isString(handle, 1, 64)) return c.json({ error: 'handle invalid' }, 400)
    if (displayName !== undefined && !isString(displayName, 1, 200)) return c.json({ error: 'displayName invalid' }, 400)
    if (handle === undefined && displayName === undefined) return c.json({ error: 'nothing to update' }, 400)
    try {
      const user = await service.updateUserProfile(c.get('coreUser').id, {
        ...(handle !== undefined ? { handle: handle.toLowerCase() } : {}),
        ...(displayName !== undefined ? { displayName } : {}),
      })
      return c.json({ user })
    } catch (err) {
      if (err instanceof HandleTakenError) return c.json({ error: 'handle already taken' }, 409)
      throw err
    }
  })

  app.post('/me/follows', sessionAuth(deps.auth, deps.users), async (c) => {
    const body = await readJsonBody(c)
    if (!body || !isString(body.handle, 1, 64)) return c.json({ error: 'handle invalid' }, 400)
    const target = await resolveUser(body.handle)
    if (!target) return c.json({ error: 'unknown user' }, 404)
    await service.addFollow(c.get('coreUser'), target)
    return c.json({ ok: true }, 200)
  })

  app.delete('/me/follows/:target', sessionAuth(deps.auth, deps.users), async (c) => {
    const target = await resolveUser(c.req.param('target') ?? '')
    if (!target) return c.json({ error: 'unknown user' }, 404)
    await service.removeFollow(c.get('coreUser').id, target.id)
    return c.json({ ok: true }, 200)
  })

  app.get('/users/:handle/follows', async (c) => {
    const user = await resolveUser(c.req.param('handle') ?? '')
    if (!user) return c.json({ error: 'unknown user' }, 404)
    return c.json({ following: await service.listFollowing(user.id) })
  })

  // Textcasting peers: remote feeds whose items have carried source:markdown —
  // the instances this one is verifiably interop-connected to. Public read.
  app.get('/peers', async (c) => {
    const peers = await service.listTextcastingPeers()
    return c.json({ peers: peers.map((u) => ({ handle: u.handle, displayName: u.displayName, feedUrl: u.feedUrl })) })
  })

  app.get('/post/:id/thread', async (c) => {
    const post = await service.getPost(c.req.param('id') ?? '')
    if (!post) return c.json({ error: 'unknown post' }, 404)
    const thread = await service.getThread(post.threadRootId ?? post.id)
    return c.json({ thread })
  })

  app.get('/post/:id/comments.xml', async (c) => {
    const post = await service.getPost(c.req.param('id') ?? '')
    if (!post) return c.json({ error: 'unknown post' }, 404)
    const replies = await service.listRepliesByPostId(post.id)
    const counts = await service.countRepliesByPostIds(replies.map((r) => r.id))
    let xml = renderCommentsFeed(post, replies, feeds)
    if (feeds.publicUrl) {
      const pub = feeds.publicUrl
      const host = new URL(pub).host
      // replies can be remote (a cross-instance reply resolving onto our local
      // post) — the injector must key on the same guid VALUE the XML emitted:
      // localGuid for local items, r.guid verbatim for remote (matches
      // renderCommentsFeed's per-item guid choice). The author name is still
      // legitimate to emit for a remote reply (whoever wrote it), just keyed
      // on its origin guid rather than a localGuid it never carries.
      xml = injectSourceAccounts(xml, replies.map((r) => ({ guid: emittedGuid(r), service: host, name: r.author.handle })))
      xml = injectSourceComments(xml, replies.filter((r) => (counts.get(r.id) ?? 0) > 0)
        .map((r) => ({ guid: emittedGuid(r), count: counts.get(r.id)!, feedUrl: `${pub}/post/${r.id}/comments.xml` })))
    }
    return c.body(xml, 200, { 'content-type': 'application/rss+xml; charset=utf-8' })
  })

  app.get('/users/:handle/following.opml', async (c) => {
    const user = await resolveUser(c.req.param('handle') ?? '')
    if (!user) return c.json({ error: 'unknown user' }, 404)
    const following = await service.listFollowing(user.id)
    const opml = buildFollowingOpml(user.displayName, following, feeds.publicUrl)
    return c.body(opml, 200, { 'content-type': 'text/xml; charset=utf-8' })
  })

  app.post('/me/follows/opml', sessionAuth(deps.auth, deps.users), registeredOnly(), bodyLimit({ maxSize: 1024 * 1024, onError: rejectOversized }), async (c) => {
    const follower = c.get('coreUser')
    const body = await c.req.text()
    const result = await importFollowingOpml(
      {
        listRemoteUsers: () => service.listRemoteUsers(),
        getUserByHandle: (h) => service.getUserByHandle(h),
        addRemoteUser: (i) => service.addRemoteUser(i),
        addFollow: (f, t) => service.addFollow(f, t),
        publicUrl: feeds.publicUrl,
      },
      follower,
      body,
    )
    return c.json(result, 200)
  })

  const FEED_LIMIT = 50

  async function resolveFeedUser(c: Context): Promise<{ user: import('../domain/types.ts').User } | Response> {
    const handle = (c.req.param('handle') ?? '').toLowerCase()
    const user = await service.getUserByHandle(handle)
    if (!user) return c.json({ error: 'unknown user' }, 404)
    if (user.kind === 'remote') {
      // Pass-through, not republishing. 302 (not 301): feedUrl is mutable.
      if (!user.feedUrl) return c.json({ error: 'unknown user' }, 404)
      return c.redirect(user.feedUrl, 302)
    }
    return { user }
  }

  // Static-before-param: Hono matches this ahead of /users/:handle/feed.xml
  // regardless of declaration order, but reading top-to-bottom should say so.
  app.get('/users/rss.xml', async (c) => {
    const entries = await service.getRecentLocalPosts(FEED_LIMIT)
    let xml = renderFirehoseRss(entries, feeds)
    if (feeds.publicUrl) {
      const pub = feeds.publicUrl
      const host = new URL(pub).host
      xml = injectSourceAccounts(xml, entries.map((p) => ({ guid: emittedGuid(p), service: host, name: p.author.handle })))
      const counts = await service.countRepliesByPostIds(entries.map((p) => p.id))
      xml = injectSourceComments(xml, entries.filter((p) => (counts.get(p.id) ?? 0) > 0)
        .map((p) => ({ guid: emittedGuid(p), count: counts.get(p.id)!, feedUrl: `${pub}/post/${p.id}/comments.xml` })))
    }
    return c.body(xml, 200, { 'content-type': 'application/rss+xml; charset=utf-8' })
  })

  app.get('/users/:handle/feed.xml', async (c) => {
    const r = await resolveFeedUser(c)
    if (r instanceof Response) return r
    const posts = await service.getPostsByAuthor(r.user.id, FEED_LIMIT)
    let xml = renderRssFeed(r.user, posts, feeds)
    if (feeds.publicUrl) {
      const pub = feeds.publicUrl
      const host = new URL(pub).host
      xml = injectSourceAccounts(xml, posts.map((p) => ({ guid: emittedGuid(p), service: host, name: r.user.handle })))
      const counts = await service.countRepliesByPostIds(posts.map((p) => p.id))
      xml = injectSourceComments(xml, posts.filter((p) => (counts.get(p.id) ?? 0) > 0)
        .map((p) => ({ guid: emittedGuid(p), count: counts.get(p.id)!, feedUrl: `${pub}/post/${p.id}/comments.xml` })))
    }
    return c.body(xml, 200, { 'content-type': 'application/rss+xml; charset=utf-8' })
  })

  app.get('/users/:handle/feed.json', async (c) => {
    const r = await resolveFeedUser(c)
    if (r instanceof Response) return r
    const posts = await service.getPostsByAuthor(r.user.id, FEED_LIMIT)
    return c.body(renderJsonFeed(r.user, posts, feeds), 200, { 'content-type': 'application/feed+json; charset=utf-8' })
  })

  app.post('/hub', bodyLimit({ maxSize: MAX_FORM_BYTES, onError: rejectOversized }), async (c) => {
    if (!deps.pushApi?.websub) return c.json({ error: 'not found' }, 404)
    const parsed = await c.req.parseBody()
    const form = Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'string')) as Record<string, string>
    const result = await deps.pushApi.websub(form)
    return c.json(result.error ? { error: result.error } : { ok: true }, result.status)
  })

  app.post('/rsscloud/pleaseNotify', bodyLimit({ maxSize: MAX_FORM_BYTES, onError: rejectOversized }), async (c) => {
    if (!deps.pushApi?.rsscloud) return c.json({ error: 'not found' }, 404)
    const parsed = await c.req.parseBody()
    const form = Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'string')) as Record<string, string>
    const requesterIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null
    const result = await deps.pushApi.rsscloud(form, requesterIp)
    return c.json(result.error ? { error: result.error } : { ok: true }, result.status)
  })

  app.get('/websub/callback/:token', async (c) => {
    if (!deps.pushInApi) return c.json({ error: 'not found' }, 404)
    const query: Record<string, string> = {}
    for (const [k, v] of Object.entries(c.req.query())) if (typeof v === 'string') query[k] = v
    const r = await deps.pushInApi.websubVerify(c.req.param('token') ?? '', query)
    return c.text(r.body, r.status as 200 | 404)
  })

  app.post('/websub/callback/:token', bodyLimit({ maxSize: MAX_FAT_PING_BYTES, onError: rejectOversized }), async (c) => {
    if (!deps.pushInApi) return c.json({ error: 'not found' }, 404)
    const body = await c.req.text()
    const status = await deps.pushInApi.websubDeliver(c.req.param('token') ?? '', body, c.req.header('x-hub-signature') ?? null)
    return c.json({ ok: status === 202 }, status as 202 | 404)
  })

  app.get('/rsscloud/notify', async (c) => {
    if (!deps.pushInApi?.rsscloudChallenge) return c.json({ error: 'not found' }, 404)
    const r = await deps.pushInApi.rsscloudChallenge(c.req.query('url') ?? '', c.req.query('challenge') ?? '')
    return c.text(r.body, r.status as 200 | 404)
  })

  app.post('/rsscloud/notify', bodyLimit({ maxSize: MAX_FORM_BYTES, onError: rejectOversized }), async (c) => {
    if (!deps.pushInApi?.rsscloudPing) return c.json({ error: 'not found' }, 404)
    const parsed = await c.req.parseBody()
    const url = typeof parsed.url === 'string' ? parsed.url : ''
    const status = await deps.pushInApi.rsscloudPing(url)
    return c.json({ ok: true }, status as 200)
  })

  app.get('/timeline', async (c) => {
    const beforeRaw = c.req.query('before')
    let before
    if (beforeRaw !== undefined) {
      const parsed = parseCursor(beforeRaw)
      if (!parsed) return c.json({ error: 'before invalid' }, 400)
      before = parsed
    }
    const limitRaw = c.req.query('limit')
    let limit = 100
    if (limitRaw !== undefined) {
      const n = Number(limitRaw)
      if (!Number.isInteger(n)) return c.json({ error: 'limit invalid' }, 400)
      limit = Math.min(Math.max(n, 1), 100)
    }
    const followedByRaw = c.req.query('followed_by')
    const authorRaw = c.req.query('author')
    if (followedByRaw !== undefined && authorRaw !== undefined) return c.json({ error: 'followed_by and author are mutually exclusive' }, 400)
    let filter: { followedBy?: string; authorId?: string } | undefined
    if (followedByRaw !== undefined) {
      const u = await resolveUser(followedByRaw)
      if (!u) return c.json({ error: 'unknown user' }, 404)
      filter = { followedBy: u.id }
    } else if (authorRaw !== undefined) {
      const u = await resolveUser(authorRaw)
      if (!u) return c.json({ error: 'unknown user' }, 404)
      filter = { authorId: u.id }
    }
    const entries = await service.getTimeline(limit, before, filter)
    // Wedge shading needs to know, per page, which posts have replies — one
    // grouped query on resolved ids (resolve-once: never re-matching refs).
    const counts = await service.countRepliesByPostIds(entries.map((e) => e.id))
    const timeline = entries.map((e) => ({ ...e, replyCount: counts.get(e.id) ?? 0 }))
    const last = timeline[timeline.length - 1]
    // Known accepted edge: an exactly-limit final page yields a non-null cursor
    // whose next page is empty.
    const nextCursor = timeline.length === limit && last ? formatCursor({ publishedAt: last.publishedAt, id: last.id }) : null
    return c.json({ timeline, nextCursor })
  })

  app.get('/timeline/stream', (c) =>
    streamSSE(c, async (stream) => {
      // Subscribe BEFORE replay (spec H2): a post landing between the replay
      // query and the subscription must not be lost. Double-delivery is fine —
      // clients dedup by id.
      const off = bus.onNewPost((entry) => { void stream.writeSSE({ event: 'post', id: entry.id, data: JSON.stringify(entry) }) })
      stream.onAbort(off)
      const lastEventId = c.req.header('Last-Event-ID')
      if (lastEventId) {
        try {
          const anchorPost = await service.getPost(lastEventId)
          if (anchorPost) {
            // Inclusive scan (spec R1): the anchor and its same-created_at batch
            // re-deliver in full; the cap count includes the anchor row.
            const missed = await service.getTimelineAfter(anchorPost.createdAt, REPLAY_CAP + 1)
            if (missed.length <= REPLAY_CAP) {
              for (const entry of missed) {
                await stream.writeSSE({ event: 'post', id: entry.id, data: JSON.stringify(entry) })
              }
            }
            // else: too stale for patch-up — skip replay entirely; SSR is the recovery path (spec H4).
          }
        } catch (err) {
          // Replay is best-effort: a failed catch-up must never block going live.
          console.error('SSE replay failed:', err instanceof Error ? err.message : err)
        }
      }
      while (!stream.aborted) { await stream.sleep(15000); await stream.writeSSE({ event: 'ping', data: '' }) }
    }),
  )

  return app
}
