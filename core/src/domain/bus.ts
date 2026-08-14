import { EventEmitter } from 'node:events'
import type { TimelineEntry } from './types.ts'
import { hideResolvedReplyContext } from './types.ts'

export interface EventBus {
  emitNewPost(e: TimelineEntry): void
  onNewPost(fn: (e: TimelineEntry) => void): () => void
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
  // Deletion carries no TimelineEntry -- the post is gone and, for an account
  // deletion, so is the users row. The handle is captured BEFORE the delete so
  // push can resolve the per-author topic.
  emitPostDeleted(e: { handle: string }): void
  onPostDeleted(fn: (e: { handle: string }) => void): () => void
}

export function createEventBus(): EventBus {
  const emitter = new EventEmitter()
  emitter.setMaxListeners(0)
  return {
    emitNewPost(e) { emitter.emit('new-post', hideResolvedReplyContext(e)) },
    onNewPost(fn) {
      emitter.on('new-post', fn)
      return () => emitter.off('new-post', fn)
    },
    emitSequenceHint(sequence) { emitter.emit('seq-hint', sequence) },
    onSequenceHint(fn) {
      emitter.on('seq-hint', fn)
      return () => emitter.off('seq-hint', fn)
    },
    emitPostDeleted(e) { emitter.emit('post-deleted', e) },
    onPostDeleted(fn) {
      emitter.on('post-deleted', fn)
      return () => emitter.off('post-deleted', fn)
    },
  }
}
