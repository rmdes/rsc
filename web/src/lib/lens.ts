import type { TimelineEntry } from './types'

export type Lens =
  | { kind: 'author'; authorId: string }
  | { kind: 'followed'; followIds: Set<string> }
  | { kind: 'thread'; rootId: string }

export function keepEvent(entry: TimelineEntry, lens: Lens): boolean {
  if (lens.kind === 'author') return entry.author.id === lens.authorId
  if (lens.kind === 'thread') return entry.id === lens.rootId || entry.threadRootId === lens.rootId
  return lens.followIds.has(entry.author.id)
}
