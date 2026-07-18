import { test, expect, vi } from 'vitest'
import { createShutdown, type ShutdownDeps } from '../src/shutdown.ts'

function fakeServer(captureCb: { cb?: () => void }) {
  return {
    close: vi.fn((cb?: () => void) => { captureCb.cb = cb }),
    closeIdleConnections: vi.fn(),
    closeAllConnections: vi.fn(),
  }
}

test('teardown: stops loops, sheds idlers, drains, then closes db + exit(0)', () => {
  const cap: { cb?: () => void } = {}
  const server = fakeServer(cap)
  const repo = { close: vi.fn() }
  const stopLoops = vi.fn()
  const exit = vi.fn()
  const handler = createShutdown({ server, repo, stopLoops, exit } as unknown as ShutdownDeps)

  handler('SIGTERM')
  expect(stopLoops).toHaveBeenCalledTimes(1)
  expect(server.closeIdleConnections).toHaveBeenCalledTimes(1)
  expect(server.close).toHaveBeenCalledTimes(1)
  expect(repo.close).not.toHaveBeenCalled() // not until the drain callback fires
  expect(exit).not.toHaveBeenCalled()

  cap.cb!() // simulate all connections drained
  expect(repo.close).toHaveBeenCalledTimes(1)
  expect(exit).toHaveBeenCalledWith(0)
})

test('force-closes connections at DRAIN_MS; backstops exit(1) if close never completes', () => {
  vi.useFakeTimers()
  const cap: { cb?: () => void } = {}
  const server = fakeServer(cap) // close() never invokes its callback
  const exit = vi.fn()
  const handler = createShutdown({ server, repo: { close: vi.fn() }, stopLoops: vi.fn(), exit } as unknown as ShutdownDeps)

  handler('SIGTERM')
  vi.advanceTimersByTime(5000)
  expect(server.closeAllConnections).toHaveBeenCalledTimes(1)
  expect(exit).not.toHaveBeenCalled()
  vi.advanceTimersByTime(2000)
  expect(exit).toHaveBeenCalledWith(1)
  vi.useRealTimers()
})

test('a clean exit(0) makes the backstop a no-op (exit called once)', () => {
  vi.useFakeTimers()
  const cap: { cb?: () => void } = {}
  const server = fakeServer(cap)
  const exit = vi.fn()
  const handler = createShutdown({ server, repo: { close: vi.fn() }, stopLoops: vi.fn(), exit } as unknown as ShutdownDeps)

  handler('SIGTERM')
  cap.cb!() // clean exit(0)
  vi.advanceTimersByTime(7000) // past the backstop
  expect(exit).toHaveBeenCalledTimes(1)
  expect(exit).toHaveBeenCalledWith(0)
  vi.useRealTimers()
})

test('a second signal is a no-op (teardown runs once)', () => {
  const cap: { cb?: () => void } = {}
  const server = fakeServer(cap)
  const handler = createShutdown({ server, repo: { close: vi.fn() }, stopLoops: vi.fn(), exit: vi.fn() } as unknown as ShutdownDeps)
  handler('SIGTERM')
  handler('SIGINT')
  expect(server.close).toHaveBeenCalledTimes(1)
})
