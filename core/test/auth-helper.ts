import type { Hono } from 'hono'
import { createAuth } from '../src/auth.ts'
import type { SqliteRepository } from '../src/storage/sqlite.ts'

export function makeAuth(repo: SqliteRepository) {
  return createAuth({ sqlite: repo.raw, users: repo, secret: 'test-secret', webOrigin: 'http://web.test', anonTtlDays: 7 })
}

// better-auth's rate limiter keys on client IP + path; in tests there's no
// real IP so it falls back to a single shared 127.0.0.1 bucket per path
// (10s/3 for sign-up|sign-in), which the whole suite's calls share across
// one test file. A distinct synthetic IP per call keeps unrelated tests'
// auth requests out of each other's bucket.
let ipCounter = 0
function uniqueIp(): string {
  ipCounter++
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`
}

export async function anonSession(app: Hono): Promise<string> {
  const res = await app.request('/api/auth/sign-in/anonymous', { method: 'POST', headers: { origin: 'http://web.test', 'x-forwarded-for': uniqueIp() } })
  if (res.status !== 200) throw new Error(`anon sign-in failed: ${res.status}`)
  const setCookie = res.headers.get('set-cookie') ?? ''
  return setCookie.split(';')[0] // "textcaster.session_token=..."
}

export async function registeredSession(app: Hono, email: string): Promise<string> {
  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://web.test', 'x-forwarded-for': uniqueIp() },
    body: JSON.stringify({ email, password: 'password123', name: email }),
  })
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status}`)
  const setCookie = res.headers.get('set-cookie') ?? ''
  return setCookie.split(';')[0]
}
