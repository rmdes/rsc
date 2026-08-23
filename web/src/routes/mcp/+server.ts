import { createMcpHandler } from '@modelcontextprotocol/server'
import { buildServer } from '@rsc/mcp/src/tools.ts'
import { base } from '$lib/server/session'
import type { RequestHandler } from './$types'

// Phase 2, Track A: the hosted transport. Sits beside mcp/src/stdio.ts against
// the same buildServer — the tool definitions are shared, only the way bytes
// move differs. Spec:
// docs/superpowers/specs/2026-08-22-rsc-mcp-hosted-transport-design.md
//
// Hosted inverts stdio's identity model: the server owns no credentials, the
// caller presents one, and the instance is fixed. That is a single-identity
// Config, which resolveIdentity already handles; `as` is vestigial here.

// RFC 7235: the auth scheme is case-insensitive. Exported for the test — this
// predicate is the whole perimeter, so it gets asserted directly.
export function bearer(request: Request): string | null {
	const raw = request.headers.get('authorization')
	if (!raw) return null
	const m = /^Bearer[ \t]+(\S+)$/i.exec(raw.trim())
	return m ? m[1] : null
}

// ONE module-level handler. The SDK builds a fresh McpServer per request from
// this factory, so the per-caller credential is read from ctx.requestInfo
// rather than captured here — nothing about the caller is module state.
//
// `base()` (CORE_API_URL) is core's origin, and Identity.url is now the full
// API base, so it is passed unprefixed: core mounts /me/timeline at root, and
// only web's proxy carries /api/v1. Looping back through the instance's public
// origin was rejected — a full DNS/TLS/reverse-proxy round trip, and
// rscFetch's `redirect: 'error'` makes any edge redirect fail every tool call.
const handler = createMcpHandler(
	(ctx) => {
		// Non-null on both counts: POST below rejects every tokenless request
		// before handler.fetch runs, and the SDK sets requestInfo on both the
		// modern and legacy legs (dist/index.mjs:1261 and :973).
		const key = bearer(ctx.requestInfo!)!
		return buildServer({ identities: new Map([['hosted', { url: base(), key }]]) })
	},
	// buildServer only registers tools, never a notifier, so subscriptions/listen
	// can never emit anything but keepalives on this route. Refusing it costs
	// nothing and closes an unauthenticated stream-pinning DoS: auth here is
	// syntactic only (a real key is validated later, by core, per tool call),
	// so any Bearer-shaped header could otherwise pin an SSE stream + 15s timer
	// against the same process serving the whole web UI, up to the process-wide
	// DEFAULT_MAX_SUBSCRIPTIONS cap. `0` survives the SDK's `?? DEFAULT_MAX_SUBSCRIPTIONS`
	// (dist/index.mjs:1220) and is refused before any stream/timer exists
	// (dist/mcp-DXXb3Vv3.mjs:225).
	{ maxSubscriptions: 0 }
)

export const POST: RequestHandler = ({ request }) => {
	// Auth is checked HERE, not inside the factory. A factory throw unwinds to
	// the SDK's own handle() catch and is answered 500 (dist/index.mjs:1339-1349,
	// via internalServerErrorResponse at :945) — so a missing key raised in the
	// factory would reach the caller as a server error instead of a 401. The
	// factory re-reads the same header once the route has admitted the request.
	if (!bearer(request)) return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer' } })
	return handler.fetch(request)
}

// No GET/DELETE export: SvelteKit answers 405, which is what the SDK answers
// for those 2025-era session operations anyway (dist/index.mjs:968). Exporting
// them would hand an unauthenticated GET a 401 and an authenticated one a 405 —
// a distinction that tells an anonymous prober whether a key is valid.
