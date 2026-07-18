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
  const token = env.TEXTCASTER_TOKEN
  if (!token) throw new Error('TEXTCASTER_TOKEN is required')

  const rawPublic = env.TEXTCASTER_PUBLIC_URL
  const publicUrl = rawPublic ? httpUrl('TEXTCASTER_PUBLIC_URL', rawPublic).replace(/\/+$/, '') : null

  const rawWebsub = env.TEXTCASTER_WEBSUB ?? 'off'
  let websub: WebSubMode
  if (rawWebsub === 'off') websub = { mode: 'off' }
  else if (rawWebsub === 'self') websub = { mode: 'self' }
  else websub = { mode: 'external', hubUrl: httpUrl('TEXTCASTER_WEBSUB', rawWebsub) }

  const rawRssCloud = env.TEXTCASTER_RSSCLOUD ?? 'off'
  if (rawRssCloud !== 'on' && rawRssCloud !== 'off') throw new Error(`TEXTCASTER_RSSCLOUD must be "on" or "off", got "${rawRssCloud}"`)
  const rssCloud = rawRssCloud === 'on'

  const rawPushIn = env.TEXTCASTER_PUSH_IN ?? 'on'
  if (rawPushIn !== 'on' && rawPushIn !== 'off') throw new Error(`TEXTCASTER_PUSH_IN must be "on" or "off", got "${rawPushIn}"`)
  const pushIn = rawPushIn === 'on'

  // Fail-fast ONLY for explicitly enabled push (spec H1): defaults stay bootable.
  if ((websub.mode !== 'off' || rssCloud) && !publicUrl) {
    throw new Error('TEXTCASTER_PUBLIC_URL is required when TEXTCASTER_WEBSUB or TEXTCASTER_RSSCLOUD is enabled')
  }

  const authSecret = env.TEXTCASTER_AUTH_SECRET
  if (!authSecret) throw new Error('TEXTCASTER_AUTH_SECRET is required')
  const webOrigin = httpUrl('TEXTCASTER_WEB_ORIGIN', env.TEXTCASTER_WEB_ORIGIN ?? 'http://localhost:5173').replace(/\/+$/, '')
  const anonTtlDays = positiveInt('TEXTCASTER_ANON_TTL_DAYS', env.TEXTCASTER_ANON_TTL_DAYS ?? '7')

  const smtpUrl = env.TEXTCASTER_SMTP_URL ?? null
  // From-address default derives from the public origin's host, else webOrigin's.
  const mailHost = new URL(publicUrl ?? webOrigin).host
  const mailFrom = env.TEXTCASTER_MAIL_FROM ?? `textcaster@${mailHost}`

  const adminEmails = parseAdminEmails(env.TEXTCASTER_ADMIN_EMAIL)

  return {
    dbPath: env.TEXTCASTER_DB ?? './data/textcaster.db',
    token,
    port: positiveInt('TEXTCASTER_PORT', env.TEXTCASTER_PORT ?? '8787'),
    pollSeconds: positiveInt('TEXTCASTER_POLL_SECONDS', env.TEXTCASTER_POLL_SECONDS ?? '60'),
    publicUrl,
    websub,
    rssCloud,
    pushIn,
    authSecret,
    webOrigin,
    anonTtlDays,
    smtpUrl,
    mailFrom,
    mailEnabled: smtpUrl !== null,
    adminEmails,
  }
}
