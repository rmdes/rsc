import type { MiddlewareHandler } from 'hono'

export function bearerAuth(token: string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header('authorization') ?? ''
    if (header !== `Bearer ${token}`) return c.json({ error: 'unauthorized' }, 401)
    await next()
  }
}
