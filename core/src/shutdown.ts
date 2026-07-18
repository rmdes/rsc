const DRAIN_MS = 5000

export interface ShutdownDeps {
  server: { close(cb?: () => void): unknown; closeIdleConnections?(): void; closeAllConnections?(): void }
  repo: { close(): void }
  stopLoops: () => void
  exit?: (code: number) => void
}

// Returns the signal handler. server.ts wires it to SIGTERM/SIGINT. Returning the
// handler (rather than registering signals in here) is what makes the teardown
// unit-testable — call the handler directly, no real signals, no process.exit.
export function createShutdown(deps: ShutdownDeps): (signal: string) => void {
  const exit = deps.exit ?? ((code: number) => process.exit(code))
  let started = false
  let done = false
  const doExit = (code: number) => {
    if (done) return
    done = true
    exit(code)
  }
  return (signal: string) => {
    if (started) return
    started = true
    console.log(`${signal} received; shutting down`)
    deps.stopLoops()
    deps.server.closeIdleConnections?.()
    deps.server.close(() => {
      deps.repo.close()
      doExit(0)
    })
    // SSE streams never end on their own; force them closed after the drain
    // window so server.close's callback can fire.
    setTimeout(() => deps.server.closeAllConnections?.(), DRAIN_MS)
    // Backstop: exit even if the close callback never fires. unref so it never
    // itself keeps the process alive.
    setTimeout(() => doExit(1), DRAIN_MS + 2000).unref()
  }
}
