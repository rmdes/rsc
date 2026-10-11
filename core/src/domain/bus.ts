import { EventEmitter } from 'node:events'

// A committed local post, edit or removal, as its listeners need it: whose feed
// changed. Carries no content — push and the stream re-read under current policy.
export interface LocalPostEvent { authorId: string; handle: string }

export interface EventBus {
  emitNewPost(e: LocalPostEvent): void
  onNewPost(fn: (e: LocalPostEvent) => void): () => void
  // Logical-v2 journal wake-up hints (spec §5.1/§5.4). A committed journal effect
  // publishes its (coalesced) high-water sequence here so an open SSE /stream
  // catches up sooner than its heartbeat. The bus is NEVER event-content
  // authority — the hint carries only a sequence NUMBER; the stream re-reads the
  // durable journal under current policy. Additive: onNewPost/emitNewPost stay
  // the live outbound hook regardless — server.ts wires them to both this
  // sequence-hint wake-up AND push.onLocalPost's outbound WebSub/rssCloud
  // notification, independently of each other.
  emitSequenceHint(sequence: number): void
  onSequenceHint(fn: (sequence: number) => void): () => void
}

export function createEventBus(): EventBus {
  const emitter = new EventEmitter()
  emitter.setMaxListeners(0)
  return {
    emitNewPost(e) { emitter.emit('new-post', e) },
    onNewPost(fn) {
      emitter.on('new-post', fn)
      return () => emitter.off('new-post', fn)
    },
    emitSequenceHint(sequence) { emitter.emit('seq-hint', sequence) },
    onSequenceHint(fn) {
      emitter.on('seq-hint', fn)
      return () => emitter.off('seq-hint', fn)
    },
  }
}
