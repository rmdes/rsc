import { Hono } from 'hono'
import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { bodyLimit } from 'hono/body-limit'
import { sessionAuth, registeredOnly, requireAdmin, adminOrToken } from './auth.ts'
import type { UserDirectory } from './auth.ts'
import { mountLogicalRoutes, mountLogicalReadRoutes } from './logical-routes.ts'
import type { LogicalRouteDeps } from './logical-routes.ts'
import { parseCursor, formatCursor } from './cursor.ts'
import { DomainError, HandleTakenError } from '../domain/types.ts'
import { hideResolvedReplyContext } from '../domain/types.ts'
import type { TimelineFilter, TimelineEntry } from '../domain/types.ts'
import { renderRssFeed, renderJsonFeed, renderCommentsFeed, injectSourceComments, renderFirehoseRss, emittedGuid } from '../domain/feed.ts'
import { buildFollowingOpml, importFollowingOpml, localHandleForUrl } from '../domain/opml.ts'
import { checkCallbackUrl } from '../domain/push-guard.ts'
import { decodeCursor, SOURCE_TRANSITIONS, CATEGORY_OPTIONAL_ACTIONS } from '../domain/source-repository.ts'
import type { Cursor, SourceRepository, SourceTransitionAction } from '../domain/source-repository.ts'
import type { SourceService } from '../domain/source-service.ts'
import type { AttributionMode, AuditCategory, User } from '../domain/types.ts'
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

function isSubscriptionType(v: unknown): v is 'person' | 'webfeed' {
  return v === 'person' || v === 'webfeed'
}

async function readJsonBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    return await c.req.json()
  } catch {
    return null
  }
}

// --- v2 source-control plane validators (RSC_SOURCE_MODEL_V2) ---

function isAttributionMode(v: unknown): v is AttributionMode {
  return v === 'single_publisher' || v === 'aggregate'
}

// Mirrors AuditCategory in types.ts (V1's narrowed set — the SQL CHECK is
// deliberately wider). Typed as AuditCategory[] so removing a union member
// fails typecheck here too.
const AUDIT_CATEGORIES: ReadonlyArray<AuditCategory> = ['spam', 'abuse', 'illegal_content', 'compromised_source', 'operator_policy', 'other']

function isAuditCategory(v: unknown): v is AuditCategory {
  return typeof v === 'string' && (AUDIT_CATEGORIES as readonly string[]).includes(v)
}

// normalizeSourceUrl signals a malformed/credentialed/oversized URL by throwing
// (Task 3's contract, not a result kind) — every other error still bubbles to
// app.onError.
function isBadSourceUrl(err: unknown): boolean {
  return err instanceof Error && err.message === 'source URL invalid'
}

const DEFAULT_PAGE_LIMIT = 50

// Shared query parsing for every v2 admin listing; the repository clamps the
// limit to 1..100 itself, so this only has to reject junk.
function pageArgs(c: Context): { cursor: Cursor | undefined; limit: number } | Response {
  let cursor: Cursor | undefined
  const cursorRaw = c.req.query('cursor')
  if (cursorRaw !== undefined) {
    try {
      cursor = decodeCursor(cursorRaw)
    } catch {
      return c.json({ error: 'cursor invalid' }, 400)
    }
    if (typeof cursor?.createdAt !== 'string' || typeof cursor.id !== 'string') return c.json({ error: 'cursor invalid' }, 400)
  }
  const limitRaw = c.req.query('limit')
  if (limitRaw !== undefined && !Number.isInteger(Number(limitRaw))) return c.json({ error: 'limit invalid' }, 400)
  return { cursor, limit: limitRaw === undefined ? DEFAULT_PAGE_LIMIT : Number(limitRaw) }
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

// EXPORTED (V4 Task 3 review pin): a pushed document must never be accepted at
// a larger size than a polled one ever could be — an untrusted push body
// bounded more loosely than `logical/acquisition.ts`'s BOUNDS.maxBodyBytes
// would let unauthenticated-until-HMAC-verified input outrun the trusted fetch
// path. Not derived by import (this route also serves the flag-off v1 push-in
// path, which never loads the V2-only logical/acquisition module); instead
// `logical-bounds.test.ts` asserts the two constants stay equal.
export const MAX_FAT_PING_BYTES = 5 * 1024 * 1024
const MAX_FORM_BYTES = 64 * 1024
// Authed JSON writes: cap the body before it is buffered. 512 KB clears the
// largest valid payload (100 000-char content is ≤ ~300 KB of UTF-8) with room
// to spare; every other write route carries only small fields.
const MAX_JSON_BYTES = 512 * 1024
const rejectOversized = (c: Context) => c.text('payload too large', 413)
// EXPORTED (rev 5 pin): logical-routes.ts (and V3+) composes the SAME authed-JSON
// body guard by import instead of redefining it.
export const jsonWrite = bodyLimit({ maxSize: MAX_JSON_BYTES, onError: rejectOversized })

// Frozen cross-vertical capability constants (spec §5.6). The journal cursor
// version is 1 (Task 2's journal.ts encodes version 1); the stream protocol
// version is 1 (Task 10 owns the SSE transport that consumes it). Exported so
// Task 10/11 reuse these exact values rather than magic numbers.
export const JOURNAL_CURSOR_VERSION = 1
export const STREAM_PROTOCOL_VERSION = 1

export function createApp(deps: { service: Service; bus: EventBus; token: string; auth: Auth; users: UserDirectory; feeds?: FeedContext; pushApi?: PushApi; pushInApi?: PushInApi; mailEnabled?: boolean; adminEmails?: ReadonlySet<string>; websub?: string; pushIn?: boolean; sources?: { service: SourceService; repo: SourceRepository }; logical?: LogicalRouteDeps }): Hono {
  const { service, bus, token, sources } = deps
  const feeds: FeedContext = deps.feeds ?? { publicUrl: null, hubUrl: null, rssCloud: false }
  const mailEnabled = deps.mailEnabled ?? true
  const adminEmails = deps.adminEmails ?? new Set<string>()
  const websubMode = deps.websub ?? 'off'
  const pushInEnabled = deps.pushIn ?? false
  const app = new Hono()
  const authed = sessionAuth(deps.auth, deps.users, adminEmails)

  app.onError((err, c) => {
    if (err instanceof DomainError) return c.json({ error: err.message }, 400)
    console.error(err)
    return c.json({ error: 'internal error' }, 500)
  })

  app.get('/health', (c) => c.json({ ok: true, mailEnabled }))

  // The ONE v2 route served in both states: web discovers which source model
  // this instance runs before it picks an API path, so it must answer while the
  // flag is off too. V2 supersession (spec §5.6): when v2 is configured on this
  // emits the discriminated enabled shape; off keeps exactly {sourceModelV2:false}.
  app.get('/capabilities', (c) => c.json(
    sources !== undefined
      ? { sourceModelV2: true, model: 'logical-v2', journalCursorVersion: JOURNAL_CURSOR_VERSION, streamProtocolVersion: STREAM_PROTOCOL_VERSION }
      : { sourceModelV2: false },
  ))

  // --- v2 ordinary read + feed surface (RSC_SOURCE_MODEL_V2) ---
  // Registered HERE — before every v1 content route — so the v2 branch wins on
  // the shared read/feed paths (Hono runs the first-registered matching handler).
  // Present only when the flag is on (deps.logical is built behind the flag), so
  // while off not one of these registers and every v1 route keeps today's behavior.
  if (deps.logical) mountLogicalReadRoutes(app, { store: deps.logical.store, auth: deps.auth, users: deps.users, service, feeds })

  // F-2: without a configured mailer, refuse the routes that would create an
  // unverifiable account (or send mail we cannot send) — up front, so no
  // limbo row is ever written. GET flows (verify/reset links) are unaffected.
  const MAIL_GATED = new Set(['/api/auth/sign-up/email', '/api/auth/sign-in/magic-link', '/api/auth/request-password-reset'])
  app.on('POST', [...MAIL_GATED], (c) => {
    if (mailEnabled) return deps.auth.handler(c.req.raw)
    return c.json({ error: 'email accounts are not available on this instance' }, 503)
  })

  app.on(['GET', 'POST'], '/api/auth/*', (c) => deps.auth.handler(c.req.raw))

  app.post('/users', adminOrToken(token, deps.auth, deps.users, adminEmails), jsonWrite, async (c) => {
    const body = await readJsonBody(c)
    if (!body) return c.json({ error: 'body invalid' }, 400)
    const { handle, displayName, feedUrl } = body
    if (!isString(handle, 1, 64)) return c.json({ error: 'handle invalid' }, 400)
    if (displayName !== undefined && !isString(displayName, 0, 200)) return c.json({ error: 'displayName invalid' }, 400)
    if (!isString(feedUrl, 1, 2048) || !isValidFeedUrl(feedUrl)) return c.json({ error: 'feedUrl invalid' }, 400)
    const effectiveDisplayName = typeof displayName === 'string' && displayName.trim() !== '' ? displayName : handle
    try {
      const user = await service.addRemoteUser({ handle, displayName: effectiveDisplayName, feedUrl, feedType: 'instance' })
      return c.json({ user }, 201)
    } catch (err) {
      // UNIQUE(handle) or UNIQUE(feed_url) both surface as HandleTakenError.
      // 409 to match PATCH /me; anything else bubbles to app.onError.
      if (err instanceof HandleTakenError) return c.json({ error: 'handle or feed already exists' }, 409)
      throw err
    }
  })

  app.post('/posts', authed, jsonWrite, async (c) => {
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
    // local post — never carries reply-context (h-feed ingest only); no gate needed
    return c.json({ post }, 201)
  })

  app.patch('/posts/:id', authed, jsonWrite, async (c) => {
    const me = c.get('coreUser')
    const post = await service.getPost(c.req.param('id'))
    if (!post) return c.json({ error: 'unknown post' }, 404)
    if (post.source !== 'local' || post.authorId !== me.id) return c.json({ error: 'not editable' }, 403)
    const body = await readJsonBody(c)
    if (!body) return c.json({ error: 'body invalid' }, 400)
    const { content } = body
    if (!isString(content, 1, 100000)) return c.json({ error: 'content invalid' }, 400)
    if (content === post.content) return c.json({ post }, 200) // no-op: no phantom revision
    const entry = await service.editLocalPost(post, content, me)
    // local post — never carries reply-context (h-feed ingest only); no gate needed
    return c.json({ post: entry }, 200)
  })

  app.get('/posts/:id/revisions', async (c) => {
    const post = await service.getPost(c.req.param('id'))
    if (!post) return c.json({ error: 'unknown post' }, 404)
    return c.json({ post: hideResolvedReplyContext(post), revisions: await service.getRevisions(post.id) })
  })

  async function resolveUser(handleRaw: string): Promise<import('../domain/types.ts').User | undefined> {
    return service.getUserByHandle(handleRaw.toLowerCase())
  }

  app.get('/me', authed, (c) => c.json({ user: c.get('coreUser'), isAnonymous: c.get('sessionIsAnonymous'), isAdmin: c.get('isAdmin') }))

  // One gate for the whole admin surface — every /admin/* route is admin-only by
  // construction, so a new one can't ship ungated by forgetting the guard. Must
  // precede the /admin/* handlers to run before them. NOTE: the token-or-admin
  // routes (POST /users, DELETE /users/:handle) live under /users, not /admin,
  // and keep their own adminOrToken gate — this prefix does not touch them.
  app.use('/admin/*', authed, requireAdmin())

  // --- v2 logical acquisition admin routes (RSC_SOURCE_MODEL_V2) ---
  // Registered here — after the /admin/* gate (so they inherit authed +
  // requireAdmin) and BEFORE the /admin/sources/:id/:action transition handler
  // below, so `/admin/sources/:id/refresh` matches the refresh route, not the
  // transition matrix. Present only when the flag is on (server.ts builds the
  // logical bundle behind the flag), so while off not one of these registers.
  if (deps.logical) mountLogicalRoutes(app, deps.logical)

  // --- v2 source-control plane routes (RSC_SOURCE_MODEL_V2) ---
  // `deps.sources` exists ONLY when the flag is on (server.ts builds it behind
  // the flag, importing the domain module dynamically), so while off not one
  // route below is registered and every legacy route keeps today's behavior.
  // Registered HERE — after the /admin/* gate, so the admin routes inherit it,
  // and BEFORE the legacy /me/subscriptions, /me/follows/opml,
  // /users/:handle/follows and /users/:handle/following.opml handlers, so that
  // on those four shared paths the v2 handler answers first (Hono runs matched
  // handlers in registration order and stops at the first response).
  if (sources) {
    const v2 = sources.service
    const v2repo = sources.repo
    // Blocked, not-subscribable and never-existed are ONE answer: a caller must
    // not be able to tell them apart (design §4).
    const NEUTRAL_UNAVAILABLE = { error: 'source unavailable' }
    const IDEMPOTENCY_CONFLICT = { error: 'idempotency conflict' }

    app.post('/me/subscriptions', authed, registeredOnly(), jsonWrite, async (c) => {
      const body = await readJsonBody(c)
      if (!body) return c.json({ error: 'body invalid' }, 400)
      const { url, commandId } = body
      if (!isString(url, 1, 2048)) return c.json({ error: 'url invalid' }, 400)
      if (!isString(commandId, 1, 200)) return c.json({ error: 'commandId invalid' }, 400)
      let result
      try {
        result = await v2.subscribeByUrl(c.get('coreUser'), url, commandId)
      } catch (err) {
        if (isBadSourceUrl(err)) return c.json({ error: 'url invalid' }, 400)
        throw err
      }
      switch (result.kind) {
        case 'source': {
          const subscription = result.subscription
          // Pending answers the neutral payload ONLY — never the owner
          // projection, which would leak that the source is under review.
          if (subscription.subscriptionState !== 'active') {
            return c.json({ subscription: 'pending', message: 'This source is awaiting review.' }, result.created ? 202 : 200)
          }
          return c.json({ subscription }, result.created ? 201 : 200)
        }
        case 'local':
          return c.json({ follow: result.follow }, result.created ? 201 : 200)
        case 'cap':
          return c.json({ error: 'subscription limit reached' }, 429)
        case 'conflict':
          return c.json(IDEMPOTENCY_CONFLICT, 409)
        default:
          return c.json(NEUTRAL_UNAVAILABLE, 409)
      }
    })

    app.delete('/me/subscriptions/:sourceId', authed, jsonWrite, async (c) => {
      const body = await readJsonBody(c)
      if (!body || !isString(body.commandId, 1, 200)) return c.json({ error: 'commandId invalid' }, 400)
      const result = await v2.unsubscribe(c.get('coreUser').id, c.req.param('sourceId') ?? '', body.commandId)
      if (result.kind === 'unknown') return c.json({ error: 'unknown subscription' }, 404)
      if (result.kind === 'conflict') return c.json(IDEMPOTENCY_CONFLICT, 409)
      // sourceRemoved is deliberately NOT surfaced: whether the source row
      // survived is a function of governance/federation/retention, which an
      // ordinary DTO never reveals.
      return c.json({ ok: true }, 200)
    })

    // Same 1 MB bound as the legacy OPML route below; the command id travels as
    // a header because the body is XML, not JSON.
    app.post('/me/follows/opml', authed, registeredOnly(), bodyLimit({ maxSize: 1024 * 1024, onError: rejectOversized }), async (c) => {
      const commandId = c.req.header('x-rsc-command-id')
      if (!isString(commandId, 1, 200)) return c.json({ error: 'commandId invalid' }, 400)
      const result = await v2.importOpml(c.get('coreUser'), await c.req.text(), commandId)
      if ('kind' in result) return c.json(IDEMPOTENCY_CONFLICT, 409)
      return c.json(result, 200)
    })

    app.get('/me/following', authed, async (c) => c.json(await v2.ownerFollowing(c.get('coreUser').id)))

    app.get('/users/:handle/follows', async (c) => {
      const user = await resolveUser(c.req.param('handle') ?? '')
      if (!user) return c.json({ error: 'unknown user' }, 404)
      return c.json({ following: await v2.publicFollowing(user.id) })
    })

    app.get('/users/:handle/following.opml', async (c) => {
      const user = await resolveUser(c.req.param('handle') ?? '')
      if (!user) return c.json({ error: 'unknown user' }, 404)
      // publicFollowing filters to active subscriptions on allowed sources in
      // SQL, so nothing else can reach the export.
      const entries = await v2.publicFollowing(user.id)
      // buildFollowingOpml reads only kind/displayName/handle/feedUrl; the v2
      // projection carries no other User field, hence the cast.
      const following = entries.map((e) =>
        e.kind === 'local'
          ? { kind: 'local', handle: e.handle, displayName: e.displayName }
          : { kind: 'remote', displayName: e.displayName, feedUrl: e.url },
      ) as unknown as User[]
      return c.body(buildFollowingOpml(user.displayName, following, feeds.publicUrl), 200, { 'content-type': 'text/xml; charset=utf-8' })
    })

    app.get('/admin/sources', async (c) => {
      const args = pageArgs(c)
      if (args instanceof Response) return args
      return c.json(await v2repo.listSourceSummaries(args.cursor, args.limit))
    })

    app.get('/admin/sources/:id', async (c) => {
      const detail = await v2repo.getSourceDetail(c.req.param('id') ?? '')
      if (!detail) return c.json({ error: 'unknown source' }, 404)
      return c.json(detail)
    })

    app.get('/admin/sources/:id/subscriptions', async (c) => {
      const args = pageArgs(c)
      if (args instanceof Response) return args
      return c.json(await v2repo.listSourceSubscriptions(c.req.param('id') ?? '', args.cursor, args.limit))
    })

    app.get('/admin/sources/:id/audit', async (c) => {
      const args = pageArgs(c)
      if (args instanceof Response) return args
      return c.json(await v2repo.listSourceAudit(c.req.param('id') ?? '', args.cursor, args.limit))
    })

    app.post('/admin/sources', jsonWrite, async (c) => {
      const body = await readJsonBody(c)
      if (!body) return c.json({ error: 'body invalid' }, 400)
      const { url, attributionMode, category, note, commandId } = body
      if (!isString(url, 1, 2048)) return c.json({ error: 'url invalid' }, 400)
      if (!isAttributionMode(attributionMode)) return c.json({ error: 'attributionMode invalid' }, 400)
      if (!isAuditCategory(category)) return c.json({ error: 'category invalid' }, 400)
      if (note !== undefined && note !== null && !isString(note, 0, 2000)) return c.json({ error: 'note invalid' }, 400)
      if (!isString(commandId, 1, 200)) return c.json({ error: 'commandId invalid' }, 400)
      let result
      try {
        result = await v2.establishFederation({
          url, attributionMode, category, note: typeof note === 'string' ? note : null,
          commandId, actorId: c.get('coreUser').id, actorKind: 'administrator',
        })
      } catch (err) {
        if (isBadSourceUrl(err)) return c.json({ error: 'url invalid' }, 400)
        throw err
      }
      if (result.kind === 'established') return c.json({ source: result.source, federation: result.federation }, 201)
      if (result.kind === 'exists') return c.json({ error: 'federation already exists' }, 409)
      if (result.kind === 'conflict') return c.json(IDEMPOTENCY_CONFLICT, 409)
      return c.json(NEUTRAL_UNAVAILABLE, 409)
    })

    app.post('/admin/sources/:id/:action', jsonWrite, async (c) => {
      // Route segments are hyphenated; only this one differs from its domain
      // action, every other segment is its action verbatim.
      const segment = c.req.param('action') ?? ''
      const action = (segment === 'attribution-mode' ? 'set_attribution_mode' : segment) as SourceTransitionAction
      // hasOwn, not `in`: `constructor`/`__proto__` are inherited keys.
      if (!Object.hasOwn(SOURCE_TRANSITIONS, action)) return c.json({ error: 'action invalid' }, 400)
      const body = await readJsonBody(c)
      if (!body) return c.json({ error: 'body invalid' }, 400)
      const { category, note, commandId, attributionMode } = body
      if (!isString(commandId, 1, 200)) return c.json({ error: 'commandId invalid' }, 400)
      if (category === undefined || category === null) {
        if (!CATEGORY_OPTIONAL_ACTIONS.has(action)) return c.json({ error: 'category invalid' }, 400)
      } else if (!isAuditCategory(category)) return c.json({ error: 'category invalid' }, 400)
      if (note !== undefined && note !== null && !isString(note, 0, 2000)) return c.json({ error: 'note invalid' }, 400)
      // Required for set_attribution_mode, optional-but-valid everywhere else.
      if ((attributionMode !== undefined || action === 'set_attribution_mode') && !isAttributionMode(attributionMode)) return c.json({ error: 'attributionMode invalid' }, 400)

      // The command runs FIRST, so the ledger answers before anything else: a
      // replayed command id returns its stored result (spec §11) instead of
      // being re-judged against state its own first run already changed.
      const id = c.req.param('id') ?? ''
      const result = await v2.transition({
        sourceId: id, action, category: isAuditCategory(category) ? category : null,
        note: typeof note === 'string' ? note : null,
        ...(isAttributionMode(attributionMode) ? { attributionMode } : {}),
        commandId, actorId: c.get('coreUser').id, actorKind: 'administrator',
      })
      if (result.kind === 'applied') return c.json({ source: result.source, audit: result.audit }, 200)
      // An unknown source is ledgered like any other outcome, so this 404 consumes
      // the commandId: reusing it against a VALID source then conflicts. The admin
      // UI pins one commandId per (source, action), so only direct API callers can
      // hit that; the alternative — pre-checking existence outside the command —
      // is what caused replays of a SUCCESSFUL transition to 409.
      if (result.kind === 'unknown') return c.json({ error: 'unknown source' }, 404)
      // The repository collapses an illegal transition and an idempotency
      // conflict into one {kind:'conflict'}; the exported matrix is what tells
      // them apart, so ask it here — only now that a replay is ruled out. A
      // concurrent transition between the command and this read still lands as
      // 'idempotency conflict' — a mislabel in a race, never a wrong write (the
      // conflict already wrote nothing).
      const detail = await v2repo.getSourceDetail(id)
      if (!detail) return c.json({ error: 'unknown source' }, 404)
      const axes = { operation: detail.source.operation, governance: detail.source.governance, federation: detail.federationStatus }
      if (SOURCE_TRANSITIONS[action](axes) === null) return c.json({ error: 'invalid transition' }, 409)
      return c.json(IDEMPOTENCY_CONFLICT, 409)
    })
  }

  app.get('/admin/overview', (c) => c.json({
    counts: service.instanceStats(),
    federation: { websub: websubMode, rssCloud: feeds.rssCloud, pushIn: pushInEnabled, publicUrl: feeds.publicUrl },
    mailEnabled,
    adminEmails: [...adminEmails],
  }))

  app.get('/admin/users', (c) => c.json({ users: service.listUsers() }))

  app.get('/admin/settings', async (c) =>
    c.json({ maxSubsPerUser: Number(await service.getSetting('max_subs_per_user') ?? '500') }))

  app.patch('/admin/settings', jsonWrite, async (c) => {
    const body = await readJsonBody(c)
    if (!body) return c.json({ error: 'body invalid' }, 400)
    const { maxSubsPerUser } = body
    if (!(typeof maxSubsPerUser === 'number' && Number.isInteger(maxSubsPerUser) && maxSubsPerUser >= 0)) {
      return c.json({ error: 'maxSubsPerUser invalid' }, 400)
    }
    await service.setSetting('max_subs_per_user', String(maxSubsPerUser))
    return c.json({ maxSubsPerUser }, 200)
  })

  app.get('/admin/feeds', async (c) => {
    const feeds = await service.listRemoteUsers()
    return c.json({ feeds: feeds.map((u) => ({ handle: u.handle, displayName: u.displayName, feedUrl: u.feedUrl })) })
  })

  app.delete('/users/:handle', adminOrToken(token, deps.auth, deps.users, adminEmails), async (c) => {
    const result = await service.removeRemoteFeed(c.req.param('handle') ?? '')
    if ('error' in result) return c.json({ error: result.error === 'unknown' ? 'unknown feed' : 'not a remote feed' }, result.error === 'unknown' ? 404 : 409)
    return c.json({ ok: true }, 200)
  })

  app.delete('/admin/users/:handle', async (c) => {
    const result = await service.deleteLocalAccount(c.req.param('handle') ?? '')
    if ('error' in result) return c.json({ error: result.error === 'unknown' ? 'unknown user' : 'not a local account' }, result.error === 'unknown' ? 404 : 409)
    return c.json({ ok: true }, 200)
  })

  app.delete('/admin/posts/:id', async (c) => {
    const result = await service.deletePost(c.req.param('id') ?? '')
    if ('error' in result) return c.json({ error: result.error === 'unknown' ? 'unknown post' : 'not a local post' }, result.error === 'unknown' ? 404 : 409)
    return c.json({ ok: true }, 200)
  })

  app.patch('/me', authed, jsonWrite, async (c) => {
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

  app.post('/me/follows', authed, jsonWrite, async (c) => {
    const body = await readJsonBody(c)
    if (!body || !isString(body.handle, 1, 64)) return c.json({ error: 'handle invalid' }, 400)
    const target = await resolveUser(body.handle)
    if (!target) return c.json({ error: 'unknown user' }, 404)
    await service.addFollow(c.get('coreUser'), target)
    return c.json({ ok: true }, 200)
  })

  app.delete('/me/follows/:target', authed, async (c) => {
    const target = await resolveUser(c.req.param('target') ?? '')
    if (!target) return c.json({ error: 'unknown user' }, 404)
    await service.removeFollow(c.get('coreUser').id, target)
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
      // per-reply attribution is the core <source> element renderCommentsFeed emits
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

  app.post('/me/follows/opml', authed, registeredOnly(), bodyLimit({ maxSize: 1024 * 1024, onError: rejectOversized }), async (c) => {
    const follower = c.get('coreUser')
    const body = await c.req.text()
    const result = await importFollowingOpml(
      {
        listRemoteUsers: () => service.listRemoteUsers(),
        getUserByHandle: (h) => service.getUserByHandle(h),
        addRemoteUser: (i) => service.addRemoteUser(i),
        addFollow: (f, t) => service.addFollow(f, t),
        getSetting: (k) => service.getSetting(k),
        countRemoteSubscriptions: (uid) => service.countRemoteSubscriptions(uid),
        getRemoteUserByFeedUrl: (u) => service.getRemoteUserByFeedUrl(u),
        publicUrl: feeds.publicUrl,
      },
      follower,
      body,
    )
    return c.json(result, 200)
  })

  // Self-serve subscribe by URL (SP1 per-user feeds): registeredOnly (guests
  // can't grow the remote-user table) + SSRF-checked (checkCallbackUrl —
  // same gate as push callbacks, no lookupFn DI needed: a literal loopback
  // IP is rejected without a DNS round-trip).
  app.post('/me/subscriptions', authed, registeredOnly(), jsonWrite, async (c) => {
    const body = await readJsonBody(c)
    if (!body) return c.json({ error: 'body invalid' }, 400)
    const { url, type } = body
    if (!isString(url, 1, 2000)) return c.json({ error: 'url invalid' }, 400)
    if (!isSubscriptionType(type)) return c.json({ error: 'type invalid' }, 400)
    if (!isValidFeedUrl(url)) return c.json({ error: 'url invalid' }, 400)
    if (!(await checkCallbackUrl(url)).ok) return c.json({ error: 'url invalid' }, 400)
    // Own-instance feed URL → follow the local user; never mint a remote shadow (SP3 F1).
    // Requires publicUrl; without it (dev) the resolve never matches — accepted, spec S4.
    // Note: this sits AFTER the SSRF gate, so a publicUrl host that resolves
    // privately from core's vantage (split-horizon DNS) 400s before reaching here.
    const localHandle = localHandleForUrl(url, feeds.publicUrl)
    if (localHandle) {
      const local = await resolveUser(localHandle)
      if (local && local.kind === 'local') {
        const minted = await service.addFollow(c.get('coreUser'), local)
        return c.json({ user: local, followed: minted }, 200)
      }
    }
    const result = await service.subscribeByUrl(c.get('coreUser'), url, type)
    if ('error' in result) return c.json({ error: 'subscription limit reached' }, 429)
    return c.json({ user: result.user, followed: result.followed }, result.created ? 201 : 200)
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
      // attribution is the per-item core <source> renderFirehoseRss emits
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
      // personal feed is single-author: the channel names the author (walker default)
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
    const sourceRaw = c.req.query('source')
    if (sourceRaw !== undefined && sourceRaw !== 'local') return c.json({ error: 'source invalid' }, 400)
    const feedTypeRaw = c.req.query('feed_type')
    if (feedTypeRaw !== undefined && feedTypeRaw !== 'instance') return c.json({ error: 'feed_type invalid' }, 400)
    const topLevelRaw = c.req.query('top_level')
    if (topLevelRaw !== undefined && topLevelRaw !== '1') return c.json({ error: 'top_level invalid' }, 400)
    let filter: TimelineFilter | undefined
    if (followedByRaw !== undefined) {
      const u = await resolveUser(followedByRaw)
      if (!u) return c.json({ error: 'unknown user' }, 404)
      filter = { followedBy: u.id }
    } else if (authorRaw !== undefined) {
      const u = await resolveUser(authorRaw)
      if (!u) return c.json({ error: 'unknown user' }, 404)
      filter = { authorId: u.id }
    }
    if (sourceRaw === 'local' || feedTypeRaw === 'instance') {
      filter = { ...filter, ...(sourceRaw === 'local' ? { source: 'local' as const } : {}), ...(feedTypeRaw === 'instance' ? { feedType: 'instance' as const } : {}) }
    }
    // Include topLevel only when explicitly requested.
    filter = { ...filter, ...(topLevelRaw === '1' ? { topLevel: true as const } : {}) }
    const entries = await service.getTimeline(limit, before, filter)
    // Wedge shading needs to know, per page, which posts have replies. Root-only
    // mode reports the whole conversation subtree (countThreadRepliesByRootIds);
    // the default mode keeps direct-child counts (countRepliesByPostIds) — one
    // grouped query either way (resolve-once: never re-matching refs).
    const counts = topLevelRaw === '1'
      ? await service.countThreadRepliesByRootIds(entries.map((e) => e.id))
      : await service.countRepliesByPostIds(entries.map((e) => e.id))
    const timeline = entries.map((e) => ({ ...e, replyCount: counts.get(e.id) ?? 0 }))
    const last = timeline[timeline.length - 1]
    // Known accepted edge: an exactly-limit final page yields a non-null cursor
    // whose next page is empty.
    const nextCursor = timeline.length === limit && last ? formatCursor({ publishedAt: last.publishedAt, id: last.id }) : null
    return c.json({ timeline, nextCursor })
  })

  // Adds the authoritative whole-conversation reply total to every resolved,
  // non-edit reply in the batch, in one grouped query (no N+1 — live batches
  // are one entry, replay batches are the distinct root ids of the page).
  // Roots, unresolved replies, and edits pass through untouched. A count
  // query failure degrades to the un-enriched frames instead of dropping the
  // batch or killing the stream (spec: "must not kill the stream").
  async function withRootReplyCounts(entries: TimelineEntry[]): Promise<TimelineEntry[]> {
    const roots = [...new Set(entries
      .filter((e) => e.inReplyToPostId && e.threadRootId && !e.editedAt)
      .map((e) => e.threadRootId as string))]
    if (roots.length === 0) return entries
    try {
      const counts = await service.countThreadRepliesByRootIds(roots)
      return entries.map((e) =>
        e.inReplyToPostId && e.threadRootId && !e.editedAt
          ? { ...e, rootReplyCount: counts.get(e.threadRootId) ?? 0 }
          : e)
    } catch (err) {
      console.error('reply count enrichment failed:', err instanceof Error ? err.message : err)
      return entries
    }
  }

  app.get('/timeline/stream', (c) =>
    streamSSE(c, async (stream) => {
      // Subscribe BEFORE replay (spec H2): a post landing between the replay
      // query and the subscription must not be lost. Double-delivery is fine —
      // clients dedup by id.
      const off = bus.onNewPost((entry) => {
        void (async () => {
          const [enriched] = await withRootReplyCounts([entry])
          await stream.writeSSE({ event: 'post', id: enriched.id, data: JSON.stringify(enriched) })
        })()
      })
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
              const enrichedMissed = await withRootReplyCounts(missed)
              for (const entry of enrichedMissed) {
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
