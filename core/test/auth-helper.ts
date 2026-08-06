import type { Hono } from 'hono'
import { createAuth } from '../src/auth.ts'
import type { SqliteRepository } from '../src/storage/sqlite.ts'
import type { Mailer } from '../src/mail.ts'

export function fakeMailer() {
  const sent: Array<{ to: string; subject: string; text: string }> = []
  return { sent, mailer: { send: async (to: string, subject: string, text: string) => void sent.push({ to, subject, text }) } }
}

export function makeAuth(
  repo: SqliteRepository,
  mailer: Mailer | null = fakeMailer().mailer,
  authOpenApi = false,
  adminEmails: ReadonlySet<string> = new Set(),
) {
  return createAuth({ sqlite: repo.raw, users: repo, secret: 'test-secret', webOrigin: 'http://web.test', anonTtlDays: 7, mailer, authOpenApi, adminEmails, trustClientIp: true })
}

// better-auth's rate limiter keys on client IP + path; in tests there's no
// real IP so it falls back to a single shared 127.0.0.1 bucket per path
// (10s/3 for sign-up|sign-in), which the whole suite's calls share across
// one test file. A distinct synthetic IP per call keeps unrelated tests'
// auth requests out of each other's bucket.
let ipCounter = 0
export function uniqueIp(): string {
  ipCounter++
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`
}

export async function anonSession(app: Hono): Promise<string> {
  const res = await app.request('/api/auth/sign-in/anonymous', { method: 'POST', headers: { origin: 'http://web.test', 'x-forwarded-for': uniqueIp() } })
  if (res.status !== 200) throw new Error(`anon sign-in failed: ${res.status}`)
  const setCookie = res.headers.get('set-cookie') ?? ''
  return setCookie.split(';')[0] // "rsc.session_token=..."
}

// Accumulates every Set-Cookie across requests — multiSession mints several
// cookies (one per held session); the single-cookie helpers above only keep
// the last one.
export function cookieJar() {
  const jar = new Map<string, string>()
  return {
    absorb(res: Response) {
      for (const sc of res.headers.getSetCookie()) {
        const pair = sc.split(';')[0]
        const eq = pair.indexOf('=')
        if (eq < 1) continue
        const name = pair.slice(0, eq).trim()
        const value = pair.slice(eq + 1).trim()
        if (value === '') jar.delete(name)
        else jar.set(name, value)
      }
    },
    header() {
      return [...jar.entries()].map(([n, v]) => `${n}=${v}`).join('; ')
    },
  }
}

export async function registeredSession(app: Hono, email: string, repo: SqliteRepository): Promise<string> {
  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://web.test', 'x-forwarded-for': uniqueIp() },
    body: JSON.stringify({ email, password: 'password123', name: email }),
  })
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status}`)
  // Hard verification (Step 1) skips auto sign-in on sign-up (probed:
  // shouldSkipAutoSignIn when requireEmailVerification is on) — this helper
  // has no mailer to intercept the verify link, so flip the column directly
  // rather than round-tripping through email.
  repo.raw.prepare('UPDATE user SET emailVerified = 1 WHERE email = ?').run(email.toLowerCase())
  const signIn = await app.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://web.test', 'x-forwarded-for': uniqueIp() },
    body: JSON.stringify({ email, password: 'password123' }),
  })
  if (signIn.status !== 200) throw new Error(`sign-in after verify failed: ${signIn.status}`)
  const setCookie = signIn.headers.get('set-cookie') ?? ''
  return setCookie.split(';')[0]
}
