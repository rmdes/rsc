import type { TimelineEntry } from './types'

export type Lens =
  | { kind: 'author'; authorId: string }
  | { kind: 'followed'; followIds: Set<string> }

export function keepEvent(entry: TimelineEntry, lens: Lens): boolean {
  if (lens.kind === 'author') return entry.author.id === lens.authorId
  return lens.followIds.has(entry.author.id)
}
