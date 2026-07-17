import type { Hono } from 'hono'

// Runnable smoke check for the session-based user flow: anonymous sign-in,
// posting under that session, reading identity back via GET /me, and the one
// surviving legitimate use of the ops bearer token (seeding a remote user).
// Exercised in-process by core/test/smoke.test.ts; the same sequence is
// documented as a curl walkthrough in RUNNING.md for checking a live server.
export async function runSmoke(app: Hono, opsToken: string, origin: string): Promise<void> {
  const signIn = await app.request('/api/auth/sign-in/anonymous', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: '{}' })
  if (signIn.status !== 200) throw new Error(`anonymous sign-in failed: ${signIn.status}`)
  const cookie = (signIn.headers.get('set-cookie') ?? '').split(';')[0]
  if (!cookie) throw new Error('anonymous sign-in returned no session cookie')

  const post = await app.request('/posts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ content: 'smoke test post' }),
  })
  if (post.status !== 201) throw new Error(`POST /posts failed: ${post.status}`)

  const me = await app.request('/me', { headers: { cookie } })
  if (me.status !== 200) throw new Error(`GET /me failed: ${me.status}`)
  const meBody = (await me.json()) as { isAnonymous: boolean }
  if (meBody.isAnonymous !== true) throw new Error('expected an anonymous session')

  const seed = await app.request('/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${opsToken}` },
    body: JSON.stringify({ handle: 'smoke-remote', displayName: 'Smoke Remote', feedUrl: 'https://example.com/feed.xml' }),
  })
  if (seed.status !== 201) throw new Error(`POST /users (ops token seeding) failed: ${seed.status}`)
}
