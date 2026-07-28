import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { sessionAuth, registeredOnly, requireAdmin, bearerAuth } from './auth.ts'
import type { UserDirectory } from './auth.ts'
import { mountLogicalRoutes, mountLogicalReadRoutes } from './logical-routes.ts'
import type { LogicalRouteDeps } from './logical-routes.ts'
import { DomainError, HandleTakenError } from '../domain/types.ts'
import { buildFollowingOpml } from '../domain/opml.ts'
import { decodeCursor, fingerprintRequest, SOURCE_TRANSITIONS, CATEGORY_OPTIONAL_ACTIONS } from '../domain/source-repository.ts'
import type { Cursor, SourceRepository, SourceTransitionAction } from '../domain/source-repository.ts'
import type { SourceService } from '../domain/source-service.ts'
import type { AttributionMode, AuditCategory, CommandEnvelope, User } from '../domain/types.ts'
import type { FeedContext } from '../domain/feed.ts'
import type { Service } from '../domain/service.ts'
import type { EventBus } from '../domain/bus.ts'
import type { Auth } from '../auth.ts'

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

// --- source-control plane validators ---

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

// EXPORTED (V4 Task 3 review pin): this must stay EQUAL to
// `logical/acquisition.ts`'s BOUNDS.maxBodyBytes — a pushed document is accepted
// at exactly the size a polled one is, so unauthenticated-until-HMAC-verified
// input can never outrun the trusted fetch path. Not derived by import (the two
// bounds live in different layers — the HTTP layer here bounds a pushed body
// before it ever reaches the fetch module's own enforcement, and an import in
// either direction is awkward); instead `logical-bounds.test.ts` asserts the
// equality directly.
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

// ponytail: deps.bus kept dead in the type to avoid touching every createApp
// call site; remove when a call site changes anyway.
export function createApp(deps: { service: Service; bus: EventBus; token: string; auth: Auth; users: UserDirectory; feeds?: FeedContext; pushApi?: PushApi; pushInApi?: PushInApi; mailEnabled?: boolean; adminEmails?: ReadonlySet<string>; websub?: string; pushIn?: boolean; sources: { service: SourceService; repo: SourceRepository }; logical: LogicalRouteDeps }): Hono {
  const { service, token, sources } = deps
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

  // Web discovers the source model before it picks an API path. V1 is retired,
  // so the answer is constant — but `sourceModelV2` stays in the payload: it is
  // a wire contract web still reads.
  app.get('/capabilities', (c) => c.json(
    { sourceModelV2: true, model: 'logical-v2', journalCursorVersion: JOURNAL_CURSOR_VERSION, streamProtocolVersion: STREAM_PROTOCOL_VERSION },
  ))

  // --- ordinary read + feed surface ---
  mountLogicalReadRoutes(app, { store: deps.logical.store, auth: deps.auth, users: deps.users, service, feeds })

  // F-2: without a configured mailer, refuse the routes that would create an
  // unverifiable account (or send mail we cannot send) — up front, so no
  // limbo row is ever written. GET flows (verify/reset links) are unaffected.
  const MAIL_GATED = new Set(['/api/auth/sign-up/email', '/api/auth/sign-in/magic-link', '/api/auth/request-password-reset'])
  app.on('POST', [...MAIL_GATED], (c) => {
    if (mailEnabled) return deps.auth.handler(c.req.raw)
    return c.json({ error: 'email accounts are not available on this instance' }, 503)
  })

  app.on(['GET', 'POST'], '/api/auth/*', (c) => deps.auth.handler(c.req.raw))

  app.post('/posts', authed, jsonWrite, async (c) => {
    const body = await readJsonBody(c)
    if (!body) return c.json({ error: 'body invalid' }, 400)
    const { content, inReplyTo } = body
    if (!isString(content, 1, 100000)) return c.json({ error: 'content invalid' }, 400)
    if (inReplyTo !== undefined && !isString(inReplyTo, 1, 64)) return c.json({ error: 'inReplyTo invalid' }, 400)
    let replyTarget
    if (typeof inReplyTo === 'string') {
      // Under v2 the target may be a remote logical item with no posts row —
      // resolveReplyTarget accepts exactly what ordinary reads can show.
      replyTarget = await service.resolveReplyTarget(inReplyTo)
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

  async function resolveUser(handleRaw: string): Promise<import('../domain/types.ts').User | undefined> {
    return service.getUserByHandle(handleRaw.toLowerCase())
  }

  app.get('/me', authed, (c) => c.json({ user: c.get('coreUser'), isAnonymous: c.get('sessionIsAnonymous'), isAdmin: c.get('isAdmin') }))

  // One gate for the whole admin surface — every /admin/* route is admin-only by
  // construction, so a new one can't ship ungated by forgetting the guard. Must
  // precede the /admin/* handlers to run before them.
  app.use('/admin/*', authed, requireAdmin())

  // --- logical acquisition admin routes ---
  // Registered here — after the /admin/* gate (so they inherit authed +
  // requireAdmin) and BEFORE the /admin/sources/:id/:action transition handler
  // below, so `/admin/sources/:id/refresh` matches the refresh route, not the
  // transition matrix.
  mountLogicalRoutes(app, deps.logical)

  // --- source-control plane routes ---
  // Registered after the /admin/* gate, so the admin routes inherit it.
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

  // 1 MB bound for an OPML import; the command id travels as a header because
  // the body is XML, not JSON.
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
    const filter = c.req.query('filter')
    if (filter !== undefined && filter !== 'governance' && filter !== 'orphan') return c.json({ error: 'filter invalid' }, 400)
    const q = c.req.query('q')
    if (q !== undefined && q.length > 256) return c.json({ error: 'q invalid' }, 400)
    return c.json(await v2repo.listSourceSummaries(args.cursor, args.limit, filter as 'governance' | 'orphan' | undefined, q))
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

  // Task 2 (admin-governance-visibility): the operator override of
  // reapSourceIfOrphaned's guard chain. Registered here, BEFORE the
  // /admin/sources/:id/:action catch-all below, mirroring the existing
  // mountLogicalRoutes /refresh and /purge precedent — otherwise :action='reap'
  // would be swallowed as an invalid transition.
  app.post('/admin/sources/:id/reap', jsonWrite, async (c) => {
    const id = c.req.param('id') ?? ''
    const body = await readJsonBody(c)
    if (!body) return c.json({ error: 'body invalid' }, 400)
    const { commandId, force } = body
    if (!isString(commandId, 1, 200)) return c.json({ error: 'commandId invalid' }, 400)
    if (force !== undefined && typeof force !== 'boolean') return c.json({ error: 'force invalid' }, 400)
    const actorId = c.get('coreUser').id
    const command: CommandEnvelope = { actorScope: 'administrator', actorId, commandId, requestFingerprint: fingerprintRequest(['reap', id]) }
    const result = await v2repo.reapSource({ command, sourceId: id, force: force === true, now: new Date().toISOString() })
    if (result.kind === 'reaped') return c.json(result, 200)
    if (result.kind === 'unknown') return c.json({ error: 'unknown source' }, 404)
    if (result.kind === 'conflict') return c.json(IDEMPOTENCY_CONFLICT, 409)
    return c.json({ error: result.reason }, 409)
  })

  // Task 5 (instance-governed-members): same empty-not-404 posture as the two
  // siblings above — a non-instance id (no approved federation relationship)
  // is Task 2's F2 gate, applied inside listSourceMembers/sourceMemberCounts.
  app.get('/admin/sources/:id/members', async (c) => {
    const args = pageArgs(c)
    if (args instanceof Response) return args
    return c.json(await v2repo.listSourceMembers(c.req.param('id') ?? '', args.cursor, args.limit))
  })

  app.get('/admin/sources/:id/members/counts', async (c) => {
    return c.json(await v2repo.sourceMemberCounts(c.req.param('id') ?? ''))
  })

  // ONE federation handler for both callers (V4 §6: "no second code path") —
  // same validator, same establishFederation call, same dispositions. Only the
  // actor differs, so the ops route cannot drift from the admin route.
  async function establishFederation(c: Context, actorId: string, actorKind: 'administrator' | 'operator_token'): Promise<Response> {
    const body = await readJsonBody(c)
    if (!body) return c.json({ error: 'body invalid' }, 400)
    const { url, attributionMode, category, note, commandId } = body
    if (!isString(url, 1, 2048)) return c.json({ error: 'url invalid' }, 400)
    if (!isAttributionMode(attributionMode)) return c.json({ error: 'attributionMode invalid' }, 400)
    if (!isAuditCategory(category)) return c.json({ error: 'category invalid' }, 400)
    if (note !== undefined && note !== null && !isString(note, 0, 2000)) return c.json({ error: 'note invalid' }, 400)
    // The command id travels in the JSON body ONLY — never a header.
    if (!isString(commandId, 1, 200)) return c.json({ error: 'commandId invalid' }, 400)
    let result
    try {
      result = await v2.establishFederation({
        url, attributionMode, category, note: typeof note === 'string' ? note : null,
        commandId, actorId, actorKind,
      })
    } catch (err) {
      if (isBadSourceUrl(err)) return c.json({ error: 'url invalid' }, 400)
      throw err
    }
    if (result.kind === 'established') return c.json({ source: result.source, federation: result.federation }, 201)
    if (result.kind === 'exists') return c.json({ error: 'federation already exists' }, 409)
    if (result.kind === 'conflict') return c.json(IDEMPOTENCY_CONFLICT, 409)
    return c.json(NEUTRAL_UNAVAILABLE, 409)
  }

  app.post('/admin/sources', jsonWrite, (c) => establishFederation(c, c.get('coreUser').id, 'administrator'))

  // The ops-token compatibility route (V4 spec §6). Bearer-only: an admin
  // session carries no bearer header and gets 401 here, and on every
  // /admin/* route a bearer-only request has no better-auth session, so
  // sessionAuth answers 401 before requireAdmin's 403 is reachable (V1
  // review Finding 3). Since the v1 retirement deleted POST /users and
  // DELETE /users/:handle, this is now the operator token's ONLY reach into
  // the API — see RUNNING.md's RSC_TOKEN row. NOT part of the public Caddy
  // exposure set: operators call core internally. The actor id is a stable
  // NON-SECRET fingerprint of the token; the raw token is never stored or
  // returned.
  const opsActorId = `ops:${createHash('sha256').update(token).digest('hex').slice(0, 16)}`
  app.post('/ops/sources/federation', bearerAuth(token), jsonWrite, (c) => establishFederation(c, opsActorId, 'operator_token'))

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

  app.get('/admin/overview', (c) => c.json({
    counts: service.instanceStats(true),
    federation: { websub: websubMode, rssCloud: feeds.rssCloud, pushIn: pushInEnabled, publicUrl: feeds.publicUrl },
    mailEnabled,
    adminEmails: [...adminEmails],
  }))

  app.get('/admin/users', (c) => {
    const args = pageArgs(c)
    if (args instanceof Response) return args
    return c.json(service.listUsers(args.cursor, args.limit))
  })

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

  // Connected instances: approved federation instances from the governance
  // plane. Public read.
  app.get('/peers', async (c) => {
    const feds = await sources.repo.listApprovedFederationSources()
    const peers: { handle: string; displayName: string; feedUrl: string }[] = []
    for (const f of feds) {
      let host: string
      try {
        host = new URL(f.canonicalUrl).host
      } catch {
        continue
      }
      peers.push({ handle: host, displayName: host, feedUrl: f.canonicalUrl })
    }
    return c.json({ peers })
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

  return app
}
