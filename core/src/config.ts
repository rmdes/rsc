export type WebSubMode = { mode: 'off' } | { mode: 'self' } | { mode: 'external'; hubUrl: string }

export interface Config {
  dbPath: string
  token: string
  port: number
  pollSeconds: number
  publicUrl: string | null
  websub: WebSubMode
  rssCloud: boolean
  pushIn: boolean
  authOpenApi: boolean
  sourceModelV2: boolean
  authSecret: string
  webOrigin: string
  anonTtlDays: number
  smtpUrl: string | null
  mailFrom: string
  mailEnabled: boolean
  adminEmails: Set<string>
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

  const rawSourceModelV2 = env.RSC_SOURCE_MODEL_V2 ?? 'off'
  if (rawSourceModelV2 !== 'on' && rawSourceModelV2 !== 'off') throw new Error(`RSC_SOURCE_MODEL_V2 must be "on" or "off", got "${rawSourceModelV2}"`)
  const sourceModelV2 = rawSourceModelV2 === 'on'

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
    publicUrl,
    websub,
    rssCloud,
    pushIn,
    authOpenApi,
    sourceModelV2,
    authSecret,
    webOrigin,
    anonTtlDays,
    smtpUrl,
    mailFrom,
    mailEnabled: smtpUrl !== null,
    adminEmails,
  }
}
