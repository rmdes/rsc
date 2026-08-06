export type WebSubMode = { mode: 'off' } | { mode: 'self' } | { mode: 'external'; hubUrl: string }

export interface Config {
  dbPath: string
  token: string
  port: number
  pollSeconds: number
  ingestCycleMinutes: number
  ingestConcurrency: number
  ingestMaxPerHost: number
  publicUrl: string | null
  websub: WebSubMode
  rssCloud: boolean
  pushIn: boolean
  authOpenApi: boolean
  trustClientIp: boolean
  authSecret: string
  webOrigin: string
  anonTtlDays: number
  smtpUrl: string | null
  mailFrom: string
  mailEnabled: boolean
  adminEmails: Set<string>
  // Optional legacy-conversion manifest path. Presence only — the file is read
  // and validated by preflight (V4 Task 4), never here.
  migrationManifestPath: string | null
}

function positiveInt(name: string, raw: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`)
  return n
}

function httpUrl(name: string, raw: string): string {
  try {
    const protocol = new URL(raw).protocol
    if (protocol === 'http:' || protocol === 'https:') return raw
  } catch {
    // fall through to the throw below
  }
  throw new Error(`${name} must be an http(s) URL, got "${raw}"`)
}

function parseAdminEmails(raw: string | undefined): Set<string> {
  if (!raw) return new Set()
  return new Set(raw.split(',').map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0))
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env.RSC_TOKEN
  if (!token) throw new Error('RSC_TOKEN is required')

  const rawPublic = env.RSC_PUBLIC_URL
  const publicUrl = rawPublic ? httpUrl('RSC_PUBLIC_URL', rawPublic).replace(/\/+$/, '') : null

  const rawWebsub = env.RSC_WEBSUB ?? 'off'
  let websub: WebSubMode
  if (rawWebsub === 'off') websub = { mode: 'off' }
  else if (rawWebsub === 'self') websub = { mode: 'self' }
  else websub = { mode: 'external', hubUrl: httpUrl('RSC_WEBSUB', rawWebsub) }

  const rawRssCloud = env.RSC_RSSCLOUD ?? 'off'
  if (rawRssCloud !== 'on' && rawRssCloud !== 'off') throw new Error(`RSC_RSSCLOUD must be "on" or "off", got "${rawRssCloud}"`)
  const rssCloud = rawRssCloud === 'on'

  const rawPushIn = env.RSC_PUSH_IN ?? 'on'
  if (rawPushIn !== 'on' && rawPushIn !== 'off') throw new Error(`RSC_PUSH_IN must be "on" or "off", got "${rawPushIn}"`)
  const pushIn = rawPushIn === 'on'

  const rawAuthOpenApi = env.RSC_AUTH_OPENAPI ?? 'off'
  if (rawAuthOpenApi !== 'on' && rawAuthOpenApi !== 'off') throw new Error(`RSC_AUTH_OPENAPI must be "on" or "off", got "${rawAuthOpenApi}"`)
  const authOpenApi = rawAuthOpenApi === 'on'

  // Does this deployment's edge proxy supply a client address the client
  // cannot forge? Only the operator knows, so it is declared, not guessed —
  // and it defaults OFF, because a per-IP limit fed forgeable input is worse
  // than no limit at all (anyone can spend a few requests to lock out a
  // CHOSEN victim, turning the control into the attack).
  //   on  — compose.prod.yaml: Caddy APPENDS the real address to
  //         X-Forwarded-For and XFF_DEPTH=1 reads the RIGHTMOST entry, so a
  //         client-prepended value can never shift the result.
  //   off — the Cloudron package DEFAULT, pending a server-side fix. Cloudron
  //         has a documented "Trusted IPs" control (Network → Trusted IPs):
  //         a proxy listed there has its X-Forwarded-For trusted as the client
  //         address. On a correctly-configured install that list is empty (or
  //         only the real fronting proxy) and apps get a trustworthy IP — this
  //         is a per-server setting, NOT a Cloudron limitation, which is why
  //         other Cloudron apps need no such flag. On rmdes' fleet the list was
  //         measured too broad on 2026-08-06 (a spoofed header from an ordinary
  //         client came through untouched, with no proxy in front), so the
  //         address is the caller's claim until that is corrected; see
  //         cloudron/start.sh for the re-enable order.
  const rawTrustClientIp = env.RSC_TRUST_CLIENT_IP ?? 'off'
  if (rawTrustClientIp !== 'on' && rawTrustClientIp !== 'off') throw new Error(`RSC_TRUST_CLIENT_IP must be "on" or "off", got "${rawTrustClientIp}"`)
  const trustClientIp = rawTrustClientIp === 'on'

  // Fail-fast ONLY for explicitly enabled push (spec H1): defaults stay bootable.
  if ((websub.mode !== 'off' || rssCloud) && !publicUrl) {
    throw new Error('RSC_PUBLIC_URL is required when RSC_WEBSUB or RSC_RSSCLOUD is enabled')
  }

  const authSecret = env.RSC_AUTH_SECRET
  if (!authSecret) throw new Error('RSC_AUTH_SECRET is required')
  const webOrigin = httpUrl('RSC_WEB_ORIGIN', env.RSC_WEB_ORIGIN ?? 'http://localhost:5173').replace(/\/+$/, '')
  const anonTtlDays = positiveInt('RSC_ANON_TTL_DAYS', env.RSC_ANON_TTL_DAYS ?? '7')

  const smtpUrl = env.RSC_SMTP_URL ?? null
  // From-address default derives from the public origin's host, else webOrigin's.
  const mailHost = new URL(publicUrl ?? webOrigin).host
  const mailFrom = env.RSC_MAIL_FROM ?? `rsc@${mailHost}`

  const adminEmails = parseAdminEmails(env.RSC_ADMIN_EMAIL)

  return {
    dbPath: env.RSC_DB ?? './data/rsc.db',
    token,
    port: positiveInt('RSC_PORT', env.RSC_PORT ?? '8787'),
    pollSeconds: positiveInt('RSC_POLL_SECONDS', env.RSC_POLL_SECONDS ?? '60'),
    ingestCycleMinutes: positiveInt('RSC_INGEST_CYCLE_MINUTES', env.RSC_INGEST_CYCLE_MINUTES ?? '30'),
    ingestConcurrency: positiveInt('RSC_INGEST_CONCURRENCY', env.RSC_INGEST_CONCURRENCY ?? '8'),
    ingestMaxPerHost: positiveInt('RSC_INGEST_MAX_PER_HOST', env.RSC_INGEST_MAX_PER_HOST ?? '2'),
    publicUrl,
    websub,
    rssCloud,
    pushIn,
    authOpenApi,
    trustClientIp,
    authSecret,
    webOrigin,
    anonTtlDays,
    smtpUrl,
    mailFrom,
    mailEnabled: smtpUrl !== null,
    adminEmails,
    migrationManifestPath: env.RSC_MIGRATION_MANIFEST || null,
  }
}
