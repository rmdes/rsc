import type { Hono, Context } from 'hono'
import { injectSourceComments, emittedGuid, logicalToFeedEntry, renderFirehoseRss, renderRssFeed, renderJsonFeed, renderCommentsFeed, commentsFeedUrl } from '../../domain/feed.ts'
import type { LogicalStore } from '../../logical/store.ts'
import type { Auth } from '../../auth.ts'
import type { UserDirectory } from '../auth.ts'
import type { Service } from '../../domain/service.ts'
import type { FeedContext } from '../../domain/feed.ts'
import type { TimelineLens, ProjectionViewer, LogicalItemDto } from '../../logical/types.ts'
import { FEED_LIMIT, clampLimit, decodeBeforeCursor } from './shared.ts'

// =============================================================================
// v2 ordinary read + feed surface (spec §3.4-3.6, §4.3, §4.5, §4.6) — Task 8
// =============================================================================
// Mounted (by app.ts) unconditionally, on every content path (/timeline,
// /post/:id/thread, /posts/:id/revisions, /users/rss.xml, /users/:handle/feed.*,
// /post/:id/comments.xml) plus GET /post/:id (the v2-only single-item route).

export interface LogicalReadDeps {
  store: LogicalStore
  auth: Auth
  users: UserDirectory
  service: Service
  feeds: FeedContext
}

const XML = { 'content-type': 'application/rss+xml; charset=utf-8' }

// The six lens selectors (spec §3.5), parsed strictly from the query BEFORE any DB
// work. Personal/local_author/publisher carry a raw key resolved inside the read
// snapshot. Anything malformed collapses to the single 'invalid' answer.
type LensSpec =
  | { kind: 'public' } | { kind: 'local' } | { kind: 'federated' }
  | { kind: 'personal'; handle: string } | { kind: 'local_author'; handle: string }
  | { kind: 'publisher'; publisherId: string }

const LENS_KEYS = ['origin', 'followed_by', 'author', 'publisher', 'federated'] as const
// v1/legacy selectors that are invalid in v2 (spec §3.5): source, feed_type,
// top_level, and federated=false all return the same 'invalid lens'.
const FORBIDDEN_KEYS = ['source', 'feed_type', 'top_level'] as const

function parseLensSpec(c: Context): LensSpec | 'invalid' {
  for (const k of FORBIDDEN_KEYS) if (c.req.query(k) !== undefined) return 'invalid'
  const present: string[] = []
  for (const k of LENS_KEYS) {
    const vals = c.req.queries(k)
    if (vals === undefined || vals.length === 0) continue
    if (vals.length > 1) return 'invalid' // duplicate selector
    present.push(k)
  }
  if (present.length > 1) return 'invalid' // combined selectors
  if (present.length === 0) return { kind: 'public' }
  const key = present[0]
  const v = c.req.query(key) ?? ''
  if (v === '') return 'invalid' // empty selector
  if (key === 'origin') return v === 'local' ? { kind: 'local' } : 'invalid'
  if (key === 'federated') return v === 'true' ? { kind: 'federated' } : 'invalid'
  if (key === 'followed_by') return { kind: 'personal', handle: v }
  if (key === 'author') return { kind: 'local_author', handle: v }
  return { kind: 'publisher', publisherId: v }
}

export function mountLogicalReadRoutes(app: Hono, deps: LogicalReadDeps): void {
  const { store, auth, users, service, feeds } = deps
  const ANON: ProjectionViewer = { localAccountId: null, activeSourceIds: [] }
  const NOT_FOUND = { error: 'not found' }

  // Optional viewer: the authenticated account when a session is present, else
  // anonymous. A read NEVER mints a guest (no ensureCoreUser) and NEVER writes.
  async function viewerAccount(c: Context): Promise<string | null> {
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (!session) return null
    const u = await users.getUserByAuthUserId(session.user.id)
    return u ? u.id : null
  }

  // --- GET /timeline (spec §3.5) ------------------------------------------
  app.get('/timeline', async (c) => {
    const spec = parseLensSpec(c)
    if (spec === 'invalid') return c.json({ error: 'invalid lens' }, 400)
    const before = decodeBeforeCursor(c)
    if (before === 'invalid') return c.json({ error: 'invalid cursor' }, 400)
    const limit = clampLimit(c.req.query('limit'))
    const viewer: ProjectionViewer = { localAccountId: await viewerAccount(c), activeSourceIds: [] }
    const result = store.snapshot((tx) => {
      let lens: TimelineLens
      if (spec.kind === 'personal' || spec.kind === 'local_author') {
        const acc = tx.resolveLocalAccount(spec.handle)
        if (!acc) return 'notfound' as const
        lens = spec.kind === 'personal' ? { kind: 'personal', account: acc } : { kind: 'local_author', account: acc }
      } else if (spec.kind === 'publisher') {
        const pub = tx.resolvePublisher(spec.publisherId)
        if (!pub) return 'notfound' as const
        lens = { kind: 'publisher', publisher: pub }
      } else {
        lens = { kind: spec.kind }
      }
      return tx.projectTimeline({ lens, before, limit, viewer })
    })
    if (result === 'notfound') return c.json(NOT_FOUND, 404)
    return c.json(result)
  })

  // --- GET /post/:id — deliberate v2-only single-item route (spec §3.4) ----
  app.get('/post/:id', async (c) => {
    const viewer: ProjectionViewer = { localAccountId: await viewerAccount(c), activeSourceIds: [] }
    const env = store.snapshot((tx) => {
      const item = tx.projectItem(c.req.param('id') ?? '', viewer)
      return item ? { model: 'logical-v2' as const, item, journalCursor: tx.journalCursor() } : null
    })
    if (!env) return c.json(NOT_FOUND, 404)
    return c.json(env)
  })

  // --- GET /post/:id/thread (spec §4.3) ------------------------------------
  app.get('/post/:id/thread', async (c) => {
    const viewer: ProjectionViewer = { localAccountId: await viewerAccount(c), activeSourceIds: [] }
    const env = store.snapshot((tx) => tx.projectThread(c.req.param('id') ?? '', viewer))
    if (!env) return c.json(NOT_FOUND, 404)
    return c.json(env)
  })

  // --- GET /posts/:id/revisions — history (spec §4.5) ----------------------
  app.get('/posts/:id/revisions', async (c) => {
    const viewer: ProjectionViewer = { localAccountId: await viewerAccount(c), activeSourceIds: [] }
    const env = store.snapshot((tx) => tx.projectHistory(c.req.param('id') ?? '', viewer))
    if (!env) return c.json(NOT_FOUND, 404)
    return c.json(env)
  })

  // --- feeds (spec §4.6): central projector, no placeholders ---------------

  function injectComments(xml: string, items: LogicalItemDto[]): string {
    if (!feeds.publicUrl) return xml
    const pub = feeds.publicUrl
    return injectSourceComments(xml, items.filter((d) => d.directReplyCount > 0)
      .map((d) => ({ guid: emittedGuid(logicalToFeedEntry(d)), count: d.directReplyCount, feedUrl: commentsFeedUrl(pub, d.id) })))
  }

  // The all-users firehose: origin=local WITHOUT the river predicate (transports
  // local replies). Static route — wins over /users/:handle/feed.xml.
  app.get('/users/rss.xml', (c) => {
    const items = store.snapshot((tx) => tx.projectLocalActivity({ authorId: null, limit: FEED_LIMIT }))
    const xml = injectComments(renderFirehoseRss(items.map(logicalToFeedEntry), feeds), items)
    return c.body(xml, 200, XML)
  })

  // Local-account feeds use the local_author (activity) lens. A remote handle
  // redirects to its origin feed exactly like v1 (existing URLs stay stable).
  async function feedAccount(c: Context): Promise<{ id: string } | Response> {
    const handle = (c.req.param('handle') ?? '').toLowerCase()
    const user = await service.getUserByHandle(handle)
    if (!user) return c.json({ error: 'unknown user' }, 404)
    if (user.kind === 'remote') {
      if (!user.feedUrl) return c.json({ error: 'unknown user' }, 404)
      return c.redirect(user.feedUrl, 302)
    }
    return { id: user.id }
  }

  app.get('/users/:handle/feed.xml', async (c) => {
    const r = await feedAccount(c)
    if (r instanceof Response) return r
    const items = store.snapshot((tx) => tx.projectLocalActivity({ authorId: r.id, limit: FEED_LIMIT }))
    const author = items[0]?.selectedAuthor
    const user = { id: r.id, kind: 'local' as const, handle: (c.req.param('handle') ?? '').toLowerCase(), displayName: author && author.kind === 'local' ? author.displayName : (c.req.param('handle') ?? ''), feedUrl: null, createdAt: '', authUserId: null }
    const xml = injectComments(renderRssFeed(user, items.map(logicalToFeedEntry), feeds), items)
    return c.body(xml, 200, XML)
  })

  app.get('/users/:handle/feed.json', async (c) => {
    const r = await feedAccount(c)
    if (r instanceof Response) return r
    const items = store.snapshot((tx) => tx.projectLocalActivity({ authorId: r.id, limit: FEED_LIMIT }))
    const author = items[0]?.selectedAuthor
    const user = { id: r.id, kind: 'local' as const, handle: (c.req.param('handle') ?? '').toLowerCase(), displayName: author && author.kind === 'local' ? author.displayName : (c.req.param('handle') ?? ''), feedUrl: null, createdAt: '', authUserId: null }
    return c.body(renderJsonFeed(user, items.map(logicalToFeedEntry), feeds), 200, { 'content-type': 'application/feed+json; charset=utf-8' })
  })

  // Comments feed: bounded thread projector for policy/safety, but serializes
  // ordinary-visible DIRECT replies only (spec §4.6). Never serializes placeholders.
  app.get('/post/:id/comments.xml', (c) => {
    const id = c.req.param('id') ?? ''
    const data = store.snapshot((tx) => {
      const item = tx.projectItem(id, ANON)
      if (!item) return null
      const thread = tx.projectThread(id, ANON)
      const replies = (thread?.nodes ?? [])
        .filter((n): n is { kind: 'item'; item: LogicalItemDto } => n.kind === 'item' && n.item.parentLogicalItemId === id)
        .map((n) => n.item)
        // RSS convention is newest-first; projectThread returns depth-then-time ASC.
        // Feed bytes only — the web UI reads /post/:id/thread, not comments.xml, so
        // the chronological conversation order users see is unaffected. injectComments
        // keys by guid, so resorting here cannot mis-target an injection.
        .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : a.id < b.id ? 1 : -1))
      return { item, replies }
    })
    if (!data) return c.json({ error: 'unknown post' }, 404)
    let xml = renderCommentsFeed(logicalToFeedEntry(data.item), data.replies.map(logicalToFeedEntry), feeds)
    xml = injectComments(xml, data.replies)
    return c.body(xml, 200, XML)
  })
}
