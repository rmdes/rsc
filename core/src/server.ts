import { serve } from '@hono/node-server'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { loadConfig } from './config.ts'
import { createSqliteRepository } from './storage/sqlite.ts'
import { createEventBus } from './domain/bus.ts'
import { createService } from './domain/service.ts'
import { createApp } from './api/app.ts'
import { createAuth } from './auth.ts'
import { createMailer } from './mail.ts'
import { hubLinkUrl } from './domain/feed.ts'
import { createPush, handleWebSubRequest, handleRssCloudRequest } from './domain/push.ts'
import { createPushIn, runPollCycle, pushInEffective } from './domain/push-in.ts'

const config = loadConfig()
if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true })

const repo = await createSqliteRepository(config.dbPath)
const bus = createEventBus()
const service = createService(repo, bus, config.publicUrl)
const mailer = createMailer(config.smtpUrl, config.mailFrom)
const auth = createAuth({ sqlite: repo.raw, users: repo, secret: config.authSecret, webOrigin: config.webOrigin, anonTtlDays: config.anonTtlDays, mailer })
const push = createPush({ repo, config })
const pushIn = createPushIn({ repo, config })
if (config.pushIn && !config.publicUrl) console.log('push-in inactive: no public URL')
const app = createApp({
  service,
  bus,
  token: config.token,
  adminEmails: config.adminEmails,
  auth,
  users: repo,
  mailEnabled: config.mailEnabled,
  feeds: { publicUrl: config.publicUrl, hubUrl: hubLinkUrl(config.websub, config.publicUrl), rssCloud: config.rssCloud },
  pushApi:
    config.websub.mode === 'self' || config.rssCloud
      ? {
          ...(config.websub.mode === 'self' ? { websub: (form: Record<string, string>) => handleWebSubRequest({ repo, config }, form) } : {}),
          ...(config.rssCloud ? { rsscloud: (form: Record<string, string>, ip: string | null) => handleRssCloudRequest({ repo, config }, form, ip) } : {}),
        }
      : undefined,
  pushInApi: pushInEffective(config)
    ? {
        websubVerify: (token: string, query: Record<string, string>) => pushIn.handleWebSubVerification(token, query),
        websubDeliver: (token: string, body: string, signature: string | null) => pushIn.handleFatPing(token, body, signature, { bus }),
        rsscloudChallenge: (url: string, challenge: string) => pushIn.handleRssCloudChallenge(url, challenge),
        rsscloudPing: (url: string) => pushIn.handleThinPing(url, { bus }),
      }
    : undefined,
})

// H4 seam: onLocalPost never rejects; void is safe here by contract.
bus.onNewPost((e) => { void push.onLocalPost(e) })

let tick = 0
async function loop() {
  tick++
  try {
    await runPollCycle({ repo, bus, config, pushIn }, tick)
  } catch (err) {
    console.error('poll cycle failed:', err instanceof Error ? err.message : err)
  }
  setTimeout(loop, config.pollSeconds * 1000)
}
setTimeout(loop, config.pollSeconds * 1000)

async function sweepLoop() {
  try {
    const { swept } = repo.sweepAnonymousUsers(config.anonTtlDays)
    if (swept > 0) console.log(`swept ${swept} abandoned anonymous account(s)`)
  } catch (err) {
    console.error('anon sweep failed:', err instanceof Error ? err.message : err)
  }
  setTimeout(sweepLoop, 3600_000) // ponytail: fixed hourly cadence; config knob only if an operator ever asks
}
setTimeout(sweepLoop, 3600_000)

serve({ fetch: app.fetch, port: config.port })
console.log(`textcaster core listening on :${config.port}`)
