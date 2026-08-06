import type { Hono, Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { EventBus } from '../../domain/bus.ts'
import type { LogicalStreamSource } from '../../logical/runtime.ts'
import type { ReadTx } from '../../logical/database.ts'
import type { ProjectionViewer, LogicalItemDto } from '../../logical/types.ts'
import type { FeedContext } from '../../domain/feed.ts'
import { logicalToFeedEntry, itemContentFields } from '../../domain/feed.ts'
import { MODEL, NEUTRAL_404 } from './shared.ts'

// =============================================================================
// v2 reserved-handle lookup (V4 spec §3.5) — Task 8
// =============================================================================
// Mounted by server.ts beside the stream route (both need composition pieces
// app.ts does not carry), unconditionally.
//
// Web asks this before rendering /u/:handle: a legacy remote handle converted
// from a single_publisher source is permanently reserved at conversion and
// redirects to its publisher page — an aggregate source's handle is never
// reserved, so /u/:handle just 404s for it as always. The reservation relation
// has NO foreign keys and outlives source removal and purge
// (schema.ts), so a hit here does NOT promise the publisher still exists —
// after a purge the redirect still fires and /p/:publisherId 404s through the
// ordinary not-found path (spec WP5). No post-purge branch exists, here or in web.
export function mountLogicalHandleRoute(app: Hono, deps: { raw: ReadTx }): void {
  app.get('/handles/:handle', (c) => {
    const handle = (c.req.param('handle') ?? '').toLowerCase()
    // ponytail: one indexed primary-key lookup — no snapshot needed for a single
    // statement, and the reservation is immutable once written.
    const row = deps.raw.prepare(`SELECT publisher_id FROM handle_reservations_v2 WHERE handle = ?`).get(handle) as { publisher_id: string } | undefined
    if (!row) return c.json(NEUTRAL_404, 404)
    return c.json({ model: MODEL, handle, reserved: true, publisherId: row.publisher_id })
  })
}

// =============================================================================
// v2 durable SSE transport (spec §5.3-5.5) — Task 10
// =============================================================================
// GET /stream. Mounted (by server.ts) only when the flag is on, on a v2-only path
// with no v1 collision. The journal — never the in-memory bus — is the event
// authority (spec §5.4): the bus supplies only coalesced wake-up sequence hints;
// every frame is projected from the durable journal under CURRENT policy.

export interface LogicalStreamDeps {
  source: LogicalStreamSource
  bus: EventBus
  resolveViewer: (c: Context) => Promise<ProjectionViewer>
  pollMs?: number
  heartbeatMs?: number
}

const RESET_DATA = JSON.stringify({ model: 'logical-v2', kind: 'reset' })
const STREAM_BATCH = 200

export function mountLogicalStreamRoute(app: Hono, deps: LogicalStreamDeps): void {
  const { source, bus, resolveViewer } = deps
  const pollMs = deps.pollMs ?? 1000
  const heartbeatMs = deps.heartbeatMs ?? 15000

  app.get('/stream', (c) =>
    streamSSE(c, async (stream) => {
      const viewer = await resolveViewer(c)

      // Register the wake-up listener BEFORE replay (spec §5.4): a live effect
      // landing during replay must not be lost. The hint is coalesced (highest
      // sequence wins) and is only a wake — the pump re-reads the durable journal.
      let hintHigh = 0
      const off = bus.onSequenceHint((s) => { hintHigh = Math.max(hintHigh, s) })
      stream.onAbort(off)

      // Core accepts the opaque cursor through the Last-Event-ID header (the
      // browser sets it on auto-reconnect and it takes precedence); the initial
      // `?last=` query seeds it. Missing/empty is invalid → reset (Core never
      // silently starts at current high water).
      const cursor = c.req.header('Last-Event-ID') ?? c.req.query('last') ?? null
      const start = source.start(cursor && cursor.length > 0 ? cursor : null)
      if (start.kind === 'reset') {
        await stream.writeSSE({ event: 'reset', data: RESET_DATA }) // synthesized: no invented id
        return // close
      }

      let after = start.afterSequence
      const generation = start.generation

      // Drain the journal from `after` under current policy. Returns true when a
      // reset (stored, generation change, or unsafe reconstruction) closed the run.
      const pump = async (): Promise<boolean> => {
        for (;;) {
          const b = source.batch({ afterSequence: after, generation, viewer, limit: STREAM_BATCH })
          for (const f of b.frames) {
            if (f.control === 'reset') {
              await stream.writeSSE({ event: 'reset', data: RESET_DATA, ...(f.id ? { id: f.id } : {}) })
              return true
            }
            await stream.writeSSE({ event: f.event.kind, id: f.id, data: JSON.stringify(f.event) })
          }
          if (b.done) return true
          if (b.lastSequence <= after) break // caught up
          after = b.lastSequence
        }
        return false
      }

      if (await pump()) return

      let lastHb = Date.now()
      while (!stream.aborted) {
        await stream.sleep(pollMs)
        if (stream.aborted) break
        const nowMs = Date.now()
        const heartbeatDue = nowMs - lastHb >= heartbeatMs
        // Heartbeats are SSE comments AND trigger DB catch-up (spec §5.4).
        if (heartbeatDue) { await stream.write(': hb\n\n'); lastHb = nowMs }
        // A coalesced sequence hint (highest wins) wakes the pump between beats;
        // the heartbeat is the safety catch-up (the bus is never authority — the
        // pump always re-reads the durable journal under current policy).
        if (heartbeatDue || hintHigh > after) {
          if (await pump()) return
        }
      }
    }),
  )
}

// =============================================================================
// Public firehose SSE (2026-08-01 design, phase 1) — GET /firehose/stream
// =============================================================================
// Public, anonymous, no key, no session lookup. Reuses the same
// durable-journal transport as /stream (source.start/source.batch, the bus's
// coalesced sequence hint) but hardcodes an anonymous viewer and reshapes
// every frame: only origin==='local' upserts are emitted, and content is
// rendered through the SAME safe-wire path /users/rss.xml already uses
// (itemContentFields) — never the raw internal DTO, which may carry
// unrendered markdown. A remove frame carries no origin info and is passed
// through unfiltered: a remove for an id whose upsert was filtered out is a
// harmless no-op for any consumer that never saw that id in the first place.

export interface PublicFirehoseDeps {
  source: LogicalStreamSource
  bus: EventBus
  feeds: FeedContext
  pollMs?: number
  heartbeatMs?: number
  maxConnectionsPerIp?: number
  maxConnectionsTotal?: number
  connectionRateWindowMs?: number
  maxConnectionsPerWindow?: number
  // Whether x-forwarded-for can be believed here (RSC_TRUST_CLIENT_IP, see
  // config.ts for the per-topology reasoning). Every per-IP limit below is
  // skipped when false — a limit keyed on forgeable input doesn't just fail
  // to stop an attacker, it hands them a way to evict a chosen victim.
  trustClientIp?: boolean
}

const FIREHOSE_ANON: ProjectionViewer = { localAccountId: null, activeSourceIds: [] }
const FIREHOSE_RESET = JSON.stringify({ model: 'firehose-v1', kind: 'reset' })
const FIREHOSE_BATCH = 200

function firehoseEntry(item: LogicalItemDto, feeds: FeedContext): Record<string, unknown> {
  const entry = logicalToFeedEntry(item)
  const { description, sourceNs } = itemContentFields(entry)
  const authorUrl = entry.author.kind === 'local' && feeds.publicUrl ? `${feeds.publicUrl}/u/${entry.author.handle}` : entry.author.feedUrl
  return {
    model: 'firehose-v1',
    kind: 'upsert',
    id: item.id,
    title: entry.title,
    content: description,
    // entry.contentMarkdown only ever holds a REMOTE peer's captured markdown;
    // a local post's markdown lives in content and only surfaces here via
    // itemContentFields' sourceNs.markdown (the same value /users/rss.xml emits
    // as source:markdown).
    contentMarkdown: sourceNs?.markdown ?? null,
    url: entry.url,
    publishedAt: entry.publishedAt,
    author: { displayName: entry.author.displayName, url: authorUrl },
    inReplyTo: entry.inReplyTo,
  }
}

// Exported (rather than inlined in the closure below) so it's directly
// unit-testable: deletes any window entry that has already expired. Without
// this, connectionAttempts (unlike ipCounts/totalConnections, which
// release() cleans up) has no eviction path at all — a window entry is only
// ever overwritten in place once expired, never deleted — so an IP seen
// exactly once would grow the map by one permanent entry forever. The map
// key is NOT client-spoofable in either live prod topology (both Caddy and
// the Cloudron nginx config route only /api/v1/firehose/stream to the web
// app, and web's proxy — web/src/routes/api/v1/firehose/stream/+server.ts —
// builds x-forwarded-for server-side from SvelteKit's getClientAddress(),
// discarding any client-supplied header), so this bounds a real but
// non-adversarial ceiling: distinct real client IPs seen within the last
// window, not an attacker-inflatable one. Throttled to run at most once per
// window (see lastSweep in the route closure below), not once per request —
// final-review Finding 2: an unthrottled per-request sweep turned an O(1)
// rejection into an O(n) scan on exactly the flood path this endpoint
// defends.
export function sweepExpiredConnectionAttempts(
  attempts: Map<string, { count: number; windowStart: number }>,
  now: number,
  windowMs: number,
): void {
  for (const [ip, entry] of attempts) {
    if (now - entry.windowStart >= windowMs) attempts.delete(ip)
  }
}

export function mountPublicFirehoseRoute(app: Hono, deps: PublicFirehoseDeps): void {
  const { source, bus, feeds } = deps
  const pollMs = deps.pollMs ?? 1000
  const heartbeatMs = deps.heartbeatMs ?? 15000
  const trustClientIp = deps.trustClientIp ?? false
  const maxPerIp = deps.maxConnectionsPerIp ?? 5
  // A per-IP cap alone bounds nothing: addresses are free, so N attackers get
  // N*5 streams. This endpoint is anonymous, so the GLOBAL ceiling is the one
  // that actually protects the process.
  const maxGlobal = deps.maxConnectionsTotal ?? 50
  // ponytail: single-process in-memory counters, reset on every deploy/restart.
  // Both live prod paths (compose.prod.yaml, Cloudron package) run one Node
  // process per instance today, so this is an accepted, named ceiling — would
  // need a shared store (e.g. Redis) if an instance ever ran multiple replicas
  // behind a load balancer.
  const ipCounts = new Map<string, number>()
  let totalConnections = 0

  // Separate from ipCounts/totalConnections above (which bound CONCURRENT
  // connections): those alone don't stop an attacker who opens and closes
  // connections rapidly, each one still triggering a full journal-replay
  // pump before releasing. This bounds connection ATTEMPTS per IP over a
  // fixed window. ponytail: same single-process in-memory counter
  // convention as the two above — same accepted ceiling, same reset-on-
  // restart tradeoff.
  const connectionWindowMs = deps.connectionRateWindowMs ?? 60_000
  const maxConnectionsPerWindow = deps.maxConnectionsPerWindow ?? 20
  const connectionAttempts = new Map<string, { count: number; windowStart: number }>()
  // Throttles sweepExpiredConnectionAttempts to at most once per window
  // instead of once per request (final-review Finding 2) — same eviction
  // guarantee (nothing outlives one window past its expiry), amortized cost.
  let lastSweep = 0

  // One awaited MACROTASK yield between pump batches. A cursor is unauthenticated
  // and `sequence = 0` is serveable against a journal that is never pruned, so any
  // anonymous caller can demand a full-history replay: without this the `for(;;)`
  // below drains 200-row batches of synchronous db.read + per-row projectItem
  // back-to-back and starves the event loop. `await writeSSE` does NOT help —
  // promise continuations resolve as microtasks, which never reach the check phase
  // where incoming HTTP callbacks are queued (the f612128 poll-tick lesson).
  const breathe = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

  app.get('/firehose/stream', (c) => {
    // `null` means "this deployment cannot supply a trustworthy address", not
    // "no address" — every per-IP branch below is then skipped entirely rather
    // than bucketing everyone under one placeholder key (which would turn each
    // per-IP cap into a global one and lock the whole instance out).
    const ip = trustClientIp ? (c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown') : null
    if (ip !== null) {
      const now = Date.now()
      if (now - lastSweep >= connectionWindowMs) {
        lastSweep = now
        sweepExpiredConnectionAttempts(connectionAttempts, now, connectionWindowMs)
      }
      const attempt = connectionAttempts.get(ip)
      if (attempt && now - attempt.windowStart < connectionWindowMs) {
        if (attempt.count >= maxConnectionsPerWindow) return c.json({ error: 'too many connection attempts, slow down' }, 429)
        attempt.count++
      } else {
        connectionAttempts.set(ip, { count: 1, windowStart: now })
      }
    }
    // Unforgeable by construction — it counts CONNECTIONS, not identities — so
    // it applies on every topology and is the only ceiling when ip is null.
    if (totalConnections >= maxGlobal) return c.json({ error: 'firehose at capacity' }, 429)
    if (ip !== null) {
      const current = ipCounts.get(ip) ?? 0
      if (current >= maxPerIp) return c.json({ error: 'too many connections from this address' }, 429)
      ipCounts.set(ip, current + 1)
    }
    totalConnections++
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      totalConnections--
      if (ip === null) return
      const n = (ipCounts.get(ip) ?? 1) - 1
      if (n <= 0) ipCounts.delete(ip)
      else ipCounts.set(ip, n)
    }

    return streamSSE(c, async (stream) => {
      stream.onAbort(release)
      try {
        let hintHigh = 0
        const off = bus.onSequenceHint((s) => { hintHigh = Math.max(hintHigh, s) })
        stream.onAbort(off)

        const cursor = c.req.header('Last-Event-ID') ?? c.req.query('last') ?? null
        let after: number
        let generation: number
        if (cursor && cursor.length > 0) {
          const start = source.start(cursor)
          if (start.kind === 'reset') {
            await stream.writeSSE({ event: 'reset', data: FIREHOSE_RESET })
            return
          }
          after = start.afterSequence
          generation = start.generation
        } else {
          // No cursor at all is the NORMAL case here (a fresh curl/EventSource
          // client has nothing to send yet) — unlike /stream, which always has an
          // SSR-derived cursor and treats "missing" as a real anomaly worth
          // resetting on, the firehose has no such guarantee. Start tailing from
          // now instead of reset-and-closing a client that never had a cursor to
          // send in the first place.
          const start = source.current()
          after = start.afterSequence
          generation = start.generation
        }

        const pump = async (): Promise<boolean> => {
          for (;;) {
            const b = source.batch({ afterSequence: after, generation, viewer: FIREHOSE_ANON, limit: FIREHOSE_BATCH })
            for (const f of b.frames) {
              if (f.control === 'reset') {
                await stream.writeSSE({ event: 'reset', data: FIREHOSE_RESET, ...(f.id ? { id: f.id } : {}) })
                return true
              }
              if (f.event.kind === 'upsert') {
                if (f.event.item.origin !== 'local') continue
                await stream.writeSSE({ event: 'upsert', id: f.id, data: JSON.stringify(firehoseEntry(f.event.item, feeds)) })
              } else if (f.event.kind === 'remove') {
                // No origin check here, unlike upserts above: a remove frame carries
                // no content/origin, only an opaque id, so passing it through
                // unfiltered is safe — a remove for an id whose upsert was filtered
                // out (a remote item) is a harmless no-op for any consumer that
                // never saw that id.
                await stream.writeSSE({ event: 'remove', id: f.id, data: JSON.stringify({ model: 'firehose-v1', kind: 'remove', id: f.event.logicalItemId }) })
              }
            }
            if (b.done) return true
            if (b.lastSequence <= after) break
            after = b.lastSequence
            await breathe() // let HTTP in between batches — see `breathe` above
          }
          return false
        }

        if (await pump()) return

        let lastHb = Date.now()
        while (!stream.aborted) {
          await stream.sleep(pollMs)
          if (stream.aborted) break
          const nowMs = Date.now()
          const heartbeatDue = nowMs - lastHb >= heartbeatMs
          if (heartbeatDue) { await stream.write(': hb\n\n'); lastHb = nowMs }
          if (heartbeatDue || hintHigh > after) {
            if (await pump()) return
          }
        }
      } finally {
        release()
      }
    })
  })
}
