import type { AcquisitionEngine } from './acquisition.ts'
import type { LogicalStore } from './store.ts'
import type { PushLifecycle } from './push.ts'

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

// An event-loop "breather": one awaited macrotask yield, inserted BETWEEN
// per-source acquisitions so pending HTTP callbacks interleave with a poll burst.
export type Breather = () => Promise<void>

export interface SchedulerDeps {
  store: LogicalStore
  acquisition: AcquisitionEngine
  config: { pollSeconds: number; ingestCycleMinutes: number; ingestConcurrency: number; ingestMaxPerHost: number }
  now?: () => string
  // The poll-tick breather (perf fix): every ~10th tick polls 100+ sources
  // back-to-back, and each source's synchronous parse+commit+drainSync slice
  // starves the event loop, so SSR / and real clients time out for the whole
  // burst. A real breather awaits a macrotask yield between per-source
  // acquisitions and lets those HTTP callbacks run. REQUIRED and never optional,
  // for drainVerification's reason (below): an optional `?` could be silently
  // dropped at a call site and the interleave would never happen with a fully
  // green suite. A caller with nothing to interleave — the pre-listen path, a
  // sync-harness test — passes an explicit `undefined`, and the pass then runs
  // exactly as today (byte-identical, no extra yield). Do not "clean up" the
  // `| undefined` into a `?`.
  breather: Breather | undefined
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
  // The v2 inbound push lifecycle (V4 §1.3). It rides THIS pass too — registration
  // after each successful acquisition commit, then one renewal sweep and the
  // expired-row purge at pass end — because V4 adds no third loop. REQUIRED and
  // never optional, for drainVerification's reason: an optional one can be
  // forgotten at the runtime call site and the whole push subsystem then silently
  // never runs with a fully green suite. A caller that genuinely has none passes an
  // explicit `undefined`. The BEHAVIOURAL guard is
  // test/logical-push-callbacks.test.ts's composition test, which drives a real
  // runtime through a poll pass and asserts a lease row is written — the type alone
  // cannot stop `push: undefined` from being passed here.
  push: PushLifecycle | undefined
}

// A source with a live push lease polls at a reduced cadence: the durable
// equivalent of v1's in-memory `tick % 10 !== 0 && hasActivePush` skip
// (v1's deleted push-in.ts), composed with the lastPollAt comparison instead of tick state.
const PUSH_POLL_FACTOR = 10

// "Successful acquisition commit" — the same outcomes recordHealth counts as a
// success (store.ts recordHealth): the run reached the source and committed.
const SUCCESS_OUTCOMES = new Set(['parsed', 'completed_truncated', 'not_modified', 'redirect_conflict'])

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

  function hostOf(canonicalUrl: string): string {
    try { return new URL(canonicalUrl).host } catch { return canonicalUrl }
  }

  async function pollDue(nowStr: string): Promise<number> {
    const catalogSize = store.countSchedulableSources()
    if (catalogSize === 0) {
      await deps.push?.renewDue()
      deps.push?.purgeExpired(nowStr)
      return 0
    }
    const ticksPerCycle = Math.max(1, Math.ceil((config.ingestCycleMinutes * 60) / config.pollSeconds))
    const batchSize = Math.max(1, Math.ceil(catalogSize / ticksPerCycle))

    const due = store.listDueSources({ now: nowStr, pollSeconds: config.pollSeconds, pushPollFactor: PUSH_POLL_FACTOR, limit: batchSize })
      .filter((s) => !acquisition.inFlight(s.id))
    // ponytail: a lane that finds nothing startable (every remaining item is
    // host-capped) exits without waiting for a host slot to free — the
    // overflow is still the most-overdue set and is first in line again next
    // tick, rather than this tick blocking to squeeze it in.
    const queue = due.map((s) => ({ id: s.id, host: hostOf(s.canonicalUrl) }))
    const hostCounts = new Map<string, number>()
    let polled = 0

    async function lane(): Promise<void> {
      for (;;) {
        const idx = queue.findIndex((item) => (hostCounts.get(item.host) ?? 0) < config.ingestMaxPerHost)
        if (idx === -1) return
        const [item] = queue.splice(idx, 1)
        hostCounts.set(item.host, (hostCounts.get(item.host) ?? 0) + 1)
        try {
          const run = await acquisition.acquireSource(item.id, { kind: 'scheduled' })
          if (!('kind' in run)) {
            store.recordHealth({ sourceId: item.id, outcome: run.outcome, now: nowStr })
            polled++
            if (SUCCESS_OUTCOMES.has(run.outcome) && deps.push) await deps.push.maybeRegister(item.id, deps.push.latestClaim(item.id))
          }
        } finally {
          hostCounts.set(item.host, (hostCounts.get(item.host) ?? 1) - 1)
        }
        // Breathe HERE — between per-source acquisitions, never mid-transaction
        // (each acquisition's claim/commit/fail, recordHealth and maybeRegister
        // have all committed and returned by this point).
        if (deps.breather) await deps.breather()
      }
    }

    await Promise.all(Array.from({ length: Math.min(config.ingestConcurrency, queue.length) }, () => lane()))

    await deps.push?.renewDue()
    deps.push?.purgeExpired(nowStr)
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
