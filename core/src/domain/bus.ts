import { EventEmitter } from 'node:events'
import type { TimelineEntry } from './types.ts'
import { hideResolvedReplyContext } from './types.ts'

export interface EventBus {
  emitNewPost(e: TimelineEntry): void
  onNewPost(fn: (e: TimelineEntry) => void): () => void
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
  }
}
