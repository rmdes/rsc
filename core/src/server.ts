import { serve } from '@hono/node-server'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { loadConfig } from './config.ts'
import { createSqliteRepository } from './storage/sqlite.ts'
import { createEventBus } from './domain/bus.ts'
import { createService } from './domain/service.ts'
import { createApp } from './api/app.ts'
import { mountLogicalStreamRoute } from './api/logical-routes.ts'
import { createAuth } from './auth.ts'
import { createMailer } from './mail.ts'
import { hubLinkUrl } from './domain/feed.ts'
import { createPush, handleWebSubRequest, handleRssCloudRequest } from './domain/push.ts'
import { createPushIn, runPollCycle, pushInEffective } from './domain/push-in.ts'
import { createShutdown } from './shutdown.ts'
import type { LogicalRuntime } from './logical/runtime.ts'
import type { LogicalStore } from './logical/store.ts'

const config = loadConfig()

if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true })

const repo = await createSqliteRepository(config.dbPath)
const bus = createEventBus()

// v2 runtime composition (spec §5.6/§7.1). REPLACES Task 2's fail-closed guard.
// When the flag is on, build the logical store, acquisition engine, and the
// runtime — whose ONE pre-listen activation transaction runs (and completes) via
// `await runtime.ready` BEFORE this process serves any request; a failed
// activation rejects that promise and fails startup (never serves v1). When off,
// a previously-active instance is marked reconciliation_required (a never-activated
// one is left byte-identically untouched). The v2 modules are imported dynamically
// here for locality, not isolation: domain/source-repository.ts already imports
// logical/tombstones.ts + logical/journal.ts statically, so the logical module
// graph is loaded either way. Those modules are side-effect-free and only ever
// called from a v2 code path, so flag-off behavior is unaffected.
let runtime: LogicalRuntime | null = null
let logicalStore: LogicalStore | undefined
// Fail-closed + v1/v2 worker isolation (spec §5.6/§7.4): enabled installs NEITHER
// legacy poll nor legacy inbound push; disabled runs today's legacy behavior.
let workers: { legacyPoll: boolean; legacyPushIn: boolean }
if (config.sourceModelV2) {
  const { createDatabaseContext } = await import('./logical/database.ts')
  const { createLogicalStore } = await import('./logical/store.ts')
  const { createAcquisition } = await import('./logical/acquisition.ts')
  const { createLogicalRuntime, compose } = await import('./logical/runtime.ts')
  const db = createDatabaseContext(repo.raw)
  logicalStore = createLogicalStore(db)
  const acquisition = createAcquisition({ db })
  runtime = createLogicalRuntime({
    db,
    store: logicalStore,
    acquisition,
    config,
    notify: (sequence) => bus.emitSequenceHint(sequence),
  })
  // The ONE pre-listen activation transaction completes BEFORE this process serves
  // any request; a failed activation rejects and fails startup (never serves v1).
  await runtime.ready
  workers = compose({ sourceModelV2: true, runtime })
} else {
  // spec §7.1: a disabled process marks reconciliation_required when v2 was
  // previously active — a no-op (and no write) on a never-activated instance, so
  // flag-off keeps its byte-identical legacy behavior. The inline SQL avoids
  // constructing the v2 runtime/store while off (the modules themselves are already
  // in the graph via domain/source-repository.ts, and are inert unless called).
  const act = repo.raw.prepare(`SELECT state FROM logical_activation_v2 WHERE singleton = 1`).get() as { state: string } | undefined
  if (act?.state === 'active') repo.raw.prepare(`UPDATE logical_activation_v2 SET state = 'reconciliation_required' WHERE singleton = 1`).run()
  workers = { legacyPoll: true, legacyPushIn: true }
}

const service = createService(repo, bus, config.publicUrl, logicalStore)
const mailer = createMailer(config.smtpUrl, config.mailFrom)
const auth = createAuth({ sqlite: repo.raw, users: repo, secret: config.authSecret, webOrigin: config.webOrigin, anonTtlDays: config.anonTtlDays, mailer, authOpenApi: config.authOpenApi })
const push = createPush({ repo, config })
const pushIn = createPushIn({ repo, config })
if (config.pushIn && !config.publicUrl) console.log('push-in inactive: no public URL')
// v2 source-control plane: built ONLY when RSC_SOURCE_MODEL_V2 is on, through the
// ONE composition helper — it takes the logical store (V3 Task 7) as a REQUIRED
// argument, so the tombstone guard cannot be silently dropped from subscribe/OPML/
// establishFederation again. `logicalStore` is undefined only when the flag is off,
// and this whole branch is skipped then.
const sources = config.sourceModelV2
  ? (await import('./domain/source-service.ts')).createSourcePlane(repo, config.publicUrl, logicalStore)
  : undefined
const app = createApp({
  service,
  bus,
  token: config.token,
  adminEmails: config.adminEmails,
  auth,
  users: repo,
  mailEnabled: config.mailEnabled,
  feeds: { publicUrl: config.publicUrl, hubUrl: hubLinkUrl(config.websub, config.publicUrl), rssCloud: config.rssCloud },
  websub: config.websub.mode,
  pushIn: config.pushIn,
  sources,
  logical: runtime && logicalStore ? { store: logicalStore, acquisition: runtime.acquisition } : undefined,
  pushApi:
    config.websub.mode === 'self' || config.rssCloud
      ? {
          ...(config.websub.mode === 'self' ? { websub: (form: Record<string, string>) => handleWebSubRequest({ repo, config }, form) } : {}),
          ...(config.rssCloud ? { rsscloud: (form: Record<string, string>, ip: string | null) => handleRssCloudRequest({ repo, config }, form, ip) } : {}),
        }
      : undefined,
  // The four public callback ROUTES are the same paths in both models (V4 §1.4,
  // Caddyfile exposure unchanged); only what they dispatch to changes. Under v2 the
  // composition supplies the logical push lifecycle and the v1 handlers are NOT
  // routed (spec §7.4); with the flag off this is byte-identically today's wiring.
  pushInApi: !pushInEffective(config)
    ? undefined
    : runtime
      ? {
          websubVerify: (token: string, query: Record<string, string>) => runtime.push.websubVerify(token, query),
          websubDeliver: (token: string, body: string, signature: string | null) => runtime.push.websubDeliver(token, body, signature),
          rsscloudChallenge: (url: string, challenge: string) => runtime.push.rsscloudChallenge(url, challenge),
          rsscloudPing: (url: string) => runtime.push.rsscloudPing(url),
        }
      : workers.legacyPushIn
        ? {
            websubVerify: (token: string, query: Record<string, string>) => pushIn.handleWebSubVerification(token, query),
            websubDeliver: (token: string, body: string, signature: string | null) => pushIn.handleFatPing(token, body, signature, { bus }),
            rsscloudChallenge: (url: string, challenge: string) => pushIn.handleRssCloudChallenge(url, challenge),
            rsscloudPing: (url: string) => pushIn.handleThinPing(url, { bus }),
          }
        : undefined,
})

// The durable v2 SSE transport (spec §5.3). Mounted only when the runtime is live;
// a v2-only path, so it never collides with the v1 /timeline/stream.
if (runtime && logicalStore) {
  const store = logicalStore
  mountLogicalStreamRoute(app, {
    source: runtime.streamSource,
    bus,
    resolveViewer: async (c) => {
      const session = await auth.api.getSession({ headers: c.req.raw.headers })
      const u = session ? await repo.getUserByAuthUserId(session.user.id) : null
      return { localAccountId: u ? u.id : null, activeSourceIds: [] }
    },
  })
  // v2 local mutations still emit an after-commit hint so the stream catches up
  // before its heartbeat (spec §7.4); reads the coalesced high water once.
  bus.onNewPost(() => { bus.emitSequenceHint(store.snapshot((tx) => tx.getJournalMetadata().highWaterSeq)) })
}

// Outbound push for local feeds is retained in BOTH modes (spec §7.4): a local
// post's after-commit notification still drives WebSub/rssCloud publishing.
// H4 seam: onLocalPost never rejects; void is safe here by contract.
bus.onNewPost((e) => { void push.onLocalPost(e) })

let tick = 0
let pollTimer: NodeJS.Timeout | undefined
async function loop() {
  tick++
  try {
    await runPollCycle({ repo, bus, config, pushIn }, tick)
  } catch (err) {
    console.error('poll cycle failed:', err instanceof Error ? err.message : err)
  }
  pollTimer = setTimeout(loop, config.pollSeconds * 1000)
}
// Legacy polling is not started when v2 is on (spec §7.4); the v2 scheduler
// (started by runtime.ready) owns acquisition instead.
if (workers.legacyPoll) pollTimer = setTimeout(loop, config.pollSeconds * 1000)

let sweepTimer: NodeJS.Timeout
async function sweepLoop() {
  try {
    const { swept } = repo.sweepAnonymousUsers(config.anonTtlDays)
    if (swept > 0) console.log(`swept ${swept} abandoned anonymous account(s)`)
  } catch (err) {
    console.error('anon sweep failed:', err instanceof Error ? err.message : err)
  }
  sweepTimer = setTimeout(sweepLoop, 3600_000) // ponytail: fixed hourly cadence; config knob only if an operator ever asks
}
sweepTimer = setTimeout(sweepLoop, 3600_000)

const server = serve({ fetch: app.fetch, port: config.port })
console.log(`rsc core listening on :${config.port}`)

const handler = createShutdown({ server, repo, stopLoops: () => { if (pollTimer) clearTimeout(pollTimer); clearTimeout(sweepTimer); void runtime?.stop() } })
process.once('SIGTERM', () => handler('SIGTERM'))
process.once('SIGINT', () => handler('SIGINT'))
