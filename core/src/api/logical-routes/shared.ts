import type { Context } from 'hono'
import { decodeCursor } from '../../domain/cursor.ts'
import type { TimelineCursorV2 } from '../../logical/types.ts'

// Cross-group helpers/constants shared by two or more of the
// logical-routes/{write,read,personal,admin,public} route groups. Seeded by
// the logical-routes.ts split (Task 1); later tasks may promote more symbols
// here as the `tsc` gate demands.

export const MODEL = 'logical-v2'
export const NEUTRAL_404 = { model: MODEL, error: 'source unavailable' }

export function isString(v: unknown, min: number, max: number): v is string {
  return typeof v === 'string' && v.length >= min && v.length <= max
}
export async function readJsonBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    return await c.req.json()
  } catch {
    return null
  }
}

export const FEED_LIMIT = 50

export function clampLimit(raw: string | undefined): number {
  if (raw === undefined) return FEED_LIMIT
  const n = Number(raw)
  return Number.isInteger(n) ? Math.max(1, Math.min(100, n)) : FEED_LIMIT
}

// Shared ?before= decode for every TimelineCursorV2-paginated read (GET
// /timeline and the two GET /me/* routes below): the tuple codec's raw
// [timelineSortAt, logicalItemId] pair mapped onto the cursor shape, or the
// single 'invalid' answer on any malformed input.
export function decodeBeforeCursor(c: Context): TimelineCursorV2 | null | 'invalid' {
  const beforeRaw = c.req.query('before')
  if (beforeRaw === undefined) return null
  const dec = decodeCursor(beforeRaw)
  if (!dec || dec.tuple.length !== 2) return 'invalid'
  return { version: 1, timelineSortAt: dec.tuple[0], logicalItemId: dec.tuple[1] }
}

// Same auth.api erasure this file already works around for apiKeyAuth's
// verifyApiKey cast (api/auth.ts) — createApiKey needs its own narrow slice.
// REAL FINDING (found by hitting the live REST endpoint, not from any plan):
// better-auth's real create-api-key handler
// (node_modules/@better-auth/api-key/dist/index.mjs) throws
// SERVER_ONLY_PROPERTY whenever `permissions` is set AND `ctx.request ||
// ctx.headers` is truthy — true for EVERY call that reaches the plugin's own
// /api-key/create REST endpoint, including a same-origin server-to-server
// fetch from the web app. permissions can only be set through this
// in-process auth.api.createApiKey call (no headers/request on the input),
// matching the shape Task 1's own smoke test already used. This is why key
// creation needs its own core route instead of the web layer calling
// /api/auth/api-key/create directly like list/delete do.
export interface ApiKeyCreation {
  createApiKey(input: {
    body: { configId?: string; userId?: string; name?: string; permissions?: Record<string, string[]> }
  }): Promise<{ id: string; key: string; name: string | null; prefix: string | null }>
}
