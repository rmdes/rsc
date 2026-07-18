import type { Hono } from 'hono'
import { createAuth } from '../src/auth.ts'
import type { SqliteRepository } from '../src/storage/sqlite.ts'
import type { Mailer } from '../src/mail.ts'

export function fakeMailer() {
  const sent: Array<{ to: string; subject: string; text: string }> = []
  return { sent, mailer: { send: async (to: string, subject: string, text: string) => void sent.push({ to, subject, text }) } }
}

export function makeAuth(repo: SqliteRepository, mailer: Mailer | null = fakeMailer().mailer) {
  return createAuth({ sqlite: repo.raw, users: repo, secret: 'test-secret', webOrigin: 'http://web.test', anonTtlDays: 7, mailer })
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
  return setCookie.split(';')[0] // "textcaster.session_token=..."
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
  // Get auth user ID and create a local user entry in textcaster's users table
  const authUser = repo.raw.prepare('SELECT id FROM user WHERE email = ?').get(email.toLowerCase()) as { id: string } | undefined
  if (authUser) {
    await repo.createLocalUser({ handle: email.split('@')[0], displayName: email, authUserId: authUser.id })
  }
  const setCookie = signIn.headers.get('set-cookie') ?? ''
  return setCookie.split(';')[0]
}
