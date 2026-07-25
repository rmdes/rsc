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
  // v2 carries server-computed tab membership; v1 entries fall back to the field
  // the tab always keyed off, keeping the flag-off path byte-identical.
  if (lens.kind === 'feedType') return entry.classification?.federated ?? entry.author.feedType === lens.feedType
  return entry.classification?.personal ?? lens.followIds.has(entry.author.id)
}
