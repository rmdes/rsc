import type { TimelineEntry } from './types'

export type Lens =
  | { kind: 'author'; authorId: string }
  | { kind: 'followed'; followIds: Set<string> }
  | { kind: 'thread'; rootId: string }
  | { kind: 'source'; source: 'local' }
  | { kind: 'feedType'; feedType: 'instance' }

export function keepEvent(entry: TimelineEntry, lens: Lens): boolean {
  if (lens.kind === 'author') return entry.author.id === lens.authorId
  if (lens.kind === 'thread') return entry.id === lens.rootId || entry.threadRootId === lens.rootId
  if (lens.kind === 'source') return entry.source === lens.source
  if (lens.kind === 'feedType') return entry.author.feedType === lens.feedType
  return lens.followIds.has(entry.author.id)
}
