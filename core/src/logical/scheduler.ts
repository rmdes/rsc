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
  config: { pollSeconds: number }
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
// (push-in.ts:264), composed with the lastPollAt comparison instead of tick state.
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

  async function pollDue(nowStr: string): Promise<number> {
    const nowMs = Date.parse(nowStr)
    const intervalMs = config.pollSeconds * 1000
    let polled = 0
    // Serial: await each source before the next (no overlap, stable id order).
    for (const sourceId of store.listSchedulableSources()) {
      const health = store.getHealth(sourceId)
      const factor = deps.push?.hasActivePush(sourceId, nowStr) ? PUSH_POLL_FACTOR : 1
      if (health?.lastPollAt && nowMs - Date.parse(health.lastPollAt) < intervalMs * factor) continue // skip-if-recent
      if (acquisition.inFlight(sourceId)) continue // a run is already active for this source
      const run = await acquisition.acquireSource(sourceId, { kind: 'scheduled' })
      if (!('kind' in run)) {
        store.recordHealth({ sourceId, outcome: run.outcome, now: nowStr })
        polled++
        // After a successful acquisition commit, register from that run's claim.
        // A failed run committed no document, so it carries no fresh claim and an
        // older run's is inert (spec §1.1).
        if (SUCCESS_OUTCOMES.has(run.outcome) && deps.push) await deps.push.maybeRegister(sourceId, deps.push.latestClaim(sourceId))
      }
      // an 'unavailable' result (e.g. the source paused since listing) is skipped
      // Breathe HERE — between per-source acquisitions, never mid-transaction.
      // Each acquisition (its claim/commit/fail, the wrapped drainSync, recordHealth
      // and maybeRegister) is its own set of transactions and all have committed and
      // returned by this point, so the yield holds no SQLite lock. Yielding INSIDE an
      // open transaction would trade event-loop starvation for lock-holding, which is
      // strictly worse (it stalls every other writer, not just the loop). The
      // cheap skips above (skip-if-recent, in-flight) `continue` past this — they did
      // no blocking work, so there is nothing to interleave with.
      if (deps.breather) await deps.breather()
    }
    // v1's runPollCycle tail (push-in.ts:271-272) rebuilt over sources.
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
