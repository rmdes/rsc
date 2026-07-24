import type { AcquisitionEngine } from './acquisition.ts'
import type { LogicalStore } from './store.ts'

// Single-lane serial poll loop (spec §1.3-1.4). One global loop in the single
// Core process polls one source at a time, in stable sourceId order, skipping any
// source whose durable last_poll_at is more recent than RSC_POLL_SECONDS. The
// per-source in-flight boolean lives in the acquisition engine; a second
// acquisition is refused while one is active. Health is durable and updated after
// every completed poll (manual refresh updates the same health through the route).
// Startup runs the same loop with no separate overdue catch-up burst.
// ponytail: single-lane poll + skip-if-recent; add backoff/slots only when a real
// feed misbehaves or the feed count grows (the consecutive-failure counter is
// already durable, so backoff needs no schema change).

export interface SchedulerDeps {
  store: LogicalStore
  acquisition: AcquisitionEngine
  config: { pollSeconds: number }
  now?: () => string
  // Background work that does NETWORK I/O (origin verification, spec §7.1). It
  // rides THIS loop — there is no second timer — which is what keeps it off the
  // pre-listen startup path and off every request path. Its I/O therefore delays
  // the next poll; that is the accepted trade for one loop.
  // REQUIRED, never optional: an optional one can be forgotten at the runtime call
  // site and verification then silently never runs with a fully green suite. A
  // caller that genuinely has none passes an explicit `undefined` — the same
  // deliberate posture as createSourcePlane's required logicalStore. Do not
  // "clean up" the `| undefined` back into a `?`.
  drainVerification: (() => Promise<void>) | undefined
}

export interface LogicalScheduler {
  start(): void
  stop(): void
  wake(): void
  // One deterministic serial pass over the due sources; returns the count polled.
  // The loop and tests share it. Exposed so tests need no wall-clock timers.
  pollDue(now: string): Promise<number>
}

export function createScheduler(deps: SchedulerDeps): LogicalScheduler {
  const { store, acquisition, config } = deps
  const now = deps.now ?? (() => new Date().toISOString())
  let timer: ReturnType<typeof setTimeout> | null = null
  let busy = false
  let stopped = true

  async function pollDue(nowStr: string): Promise<number> {
    const nowMs = Date.parse(nowStr)
    const intervalMs = config.pollSeconds * 1000
    let polled = 0
    // Serial: await each source before the next (no overlap, stable id order).
    for (const sourceId of store.listSchedulableSources()) {
      const health = store.getHealth(sourceId)
      if (health?.lastPollAt && nowMs - Date.parse(health.lastPollAt) < intervalMs) continue // skip-if-recent
      if (acquisition.inFlight(sourceId)) continue // a run is already active for this source
      const run = await acquisition.acquireSource(sourceId, { kind: 'scheduled' })
      if (!('kind' in run)) {
        store.recordHealth({ sourceId, outcome: run.outcome, now: nowStr })
        polled++
      }
      // an 'unavailable' result (e.g. the source paused since listing) is skipped
    }
    return polled
  }

  async function tick(): Promise<void> {
    if (busy || stopped) return
    busy = true
    try {
      await pollDue(now())
      // …then the background drain, in the same serial turn. `stopped` is re-checked
      // because stop() may have landed while the poll pass was in flight, and a
      // throw from either is caught here — neither may take the process down.
      if (!stopped) await deps.drainVerification?.()
    } catch (err) {
      console.error('poll loop failed:', err instanceof Error ? err.message : err)
    } finally {
      busy = false
    }
    if (!stopped) timer = setTimeout(() => { void tick() }, config.pollSeconds * 1000)
  }

  return {
    start() {
      if (!stopped) return
      stopped = false
      void tick() // startup runs the same loop; no separate overdue burst
    },
    stop() {
      stopped = true
      if (timer) { clearTimeout(timer); timer = null }
    },
    wake() {
      if (!stopped && !busy) void tick()
    },
    pollDue,
  }
}
