import { serve } from '@hono/node-server'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { loadConfig } from './config.ts'
import { createSqliteRepository } from './storage/sqlite.ts'
import { createEventBus } from './domain/bus.ts'
import { createService } from './domain/service.ts'
import { createApp } from './api/app.ts'
import { mountLogicalStreamRoute, mountLogicalHandleRoute, mountPublicFirehoseRoute } from './api/logical-routes.ts'
import { createAuth } from './auth.ts'
import { createMailer } from './mail.ts'
import { hubLinkUrl } from './domain/feed.ts'
import { createPush, handleWebSubRequest, handleRssCloudRequest } from './domain/push.ts'
import { pushInEffective } from './logical/push.ts'
import { createSourcePlane } from './domain/source-service.ts'
import { createDatabaseContext } from './logical/database.ts'
import { createLogicalStore } from './logical/store.ts'
import { createAcquisition } from './logical/acquisition.ts'
import { createLogicalRuntime } from './logical/runtime.ts'
import { createShutdown } from './shutdown.ts'
import { sweepHousekeeping } from './housekeeping.ts'

const config = loadConfig()

if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true })

const repo = await createSqliteRepository(config.dbPath)
const bus = createEventBus()

// The runtime composition (spec §5.6/§7.1). Unconditional since the v1 retirement:
// build the logical store, acquisition engine, and the runtime — whose ONE
// pre-listen activation transaction runs (and completes) via `await runtime.ready`
// BEFORE this process serves any request; a failed activation rejects that promise
// and fails startup.
const db = createDatabaseContext(repo.raw)
const logicalStore = createLogicalStore(db)
const acquisition = createAcquisition({ db, getSetting: (key) => repo.getSetting(key) })
const runtime = createLogicalRuntime({
  db,
  store: logicalStore,
  acquisition,
  config,
  notify: (sequence) => bus.emitSequenceHint(sequence),
  getSetting: (key) => repo.getSetting(key),
})
await runtime.ready

const service = createService(repo, bus, config.publicUrl, logicalStore)
const mailer = createMailer(config.smtpUrl, config.mailFrom)
const auth = createAuth({ sqlite: repo.raw, users: repo, secret: config.authSecret, webOrigin: config.webOrigin, anonTtlDays: config.anonTtlDays, mailer, authOpenApi: config.authOpenApi, adminEmails: config.adminEmails })
const push = createPush({ repo, config })
if (config.pushIn && !config.publicUrl) console.log('push-in inactive: no public URL')
// The source-control plane, through the ONE composition helper — it takes the
// logical store (V3 Task 7) as a REQUIRED argument, so the tombstone guard cannot
// be silently dropped from subscribe/OPML/establishFederation again.
const sources = createSourcePlane(repo, config.publicUrl, logicalStore)
const feeds = { publicUrl: config.publicUrl, hubUrl: hubLinkUrl(config.websub, config.publicUrl), rssCloud: config.rssCloud }
const app = createApp({
  service,
  bus,
  token: config.token,
  adminEmails: config.adminEmails,
  auth,
  users: repo,
  mailEnabled: config.mailEnabled,
  feeds,
  websub: config.websub.mode,
  pushIn: config.pushIn,
  pollSeconds: config.pollSeconds,
  sources,
  logical: { store: logicalStore, acquisition: runtime.acquisition },
  pushApi:
    config.websub.mode === 'self' || config.rssCloud
      ? {
          ...(config.websub.mode === 'self' ? { websub: (form: Record<string, string>) => handleWebSubRequest({ repo, config }, form) } : {}),
          ...(config.rssCloud ? { rsscloud: (form: Record<string, string>, ip: string | null) => handleRssCloudRequest({ repo, config }, form, ip) } : {}),
        }
      : undefined,
  // The four public callback ROUTES (V4 §1.4, Caddyfile exposure unchanged) now
  // dispatch to the logical push lifecycle only.
  pushInApi: !pushInEffective(config)
    ? undefined
    : {
        websubVerify: (token: string, query: Record<string, string>) => runtime.push.websubVerify(token, query),
        websubDeliver: (token: string, body: string, signature: string | null) => runtime.push.websubDeliver(token, body, signature),
        rsscloudChallenge: (url: string, challenge: string) => runtime.push.rsscloudChallenge(url, challenge),
        rsscloudPing: (url: string) => runtime.push.rsscloudPing(url),
      },
})

// The durable v2 SSE transport (spec §5.3).
// The reserved-handle lookup web's /u/:handle asks before rendering (V4 §3.5).
mountLogicalHandleRoute(app, { raw: repo.raw })
mountLogicalStreamRoute(app, {
  source: runtime.streamSource,
  bus,
  resolveViewer: async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    const u = session ? await repo.getUserByAuthUserId(session.user.id) : null
    return { localAccountId: u ? u.id : null, activeSourceIds: [] }
  },
})
mountPublicFirehoseRoute(app, { source: runtime.streamSource, bus, feeds })
// Local mutations still emit an after-commit hint so the stream catches up before
// its heartbeat (spec §7.4); reads the coalesced high water once.
bus.onNewPost(() => { bus.emitSequenceHint(logicalStore.snapshot((tx) => tx.getJournalMetadata().highWaterSeq)) })

// A local post's after-commit notification drives outbound WebSub/rssCloud
// publishing. H4 seam: onLocalPost never rejects; void is safe here by contract.
bus.onNewPost((e) => { void push.onLocalPost(e) })
// Same H4 seam: a deletion pings the author's topic and the firehose so
// subscribed peers re-fetch sooner than their next scheduled poll.
bus.onPostDeleted((e) => { void push.onPostDeleted(e) })

let sweepTimer: NodeJS.Timeout
async function sweepLoop() {
  try {
    const { anonSwept, unverifiedSwept } = await sweepHousekeeping(repo, config, logicalStore)
    if (anonSwept > 0) console.log(`swept ${anonSwept} abandoned anonymous account(s)`)
    if (unverifiedSwept > 0) console.log(`swept ${unverifiedSwept} never-verified account(s)`)
  } catch (err) {
    console.error('housekeeping sweep failed:', err instanceof Error ? err.message : err)
  }
  sweepTimer = setTimeout(sweepLoop, 3600_000) // ponytail: fixed hourly cadence; config knob only if an operator ever asks
}
sweepTimer = setTimeout(sweepLoop, 3600_000)

const server = serve({ fetch: app.fetch, port: config.port })
console.log(`rsc core listening on :${config.port}`)

const handler = createShutdown({ server, repo, stopLoops: () => { clearTimeout(sweepTimer); void runtime.stop() } })
process.once('SIGTERM', () => handler('SIGTERM'))
process.once('SIGINT', () => handler('SIGINT'))
