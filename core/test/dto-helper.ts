import type { LogicalItemDto, SelectedAuthor } from '../src/logical/types.ts'

// LogicalItemDto fixtures for the feed renderers' unit tests. dto() is a
// top-level LOCAL item by alice with no permalink; override field by field.
export const localAuthor = (handle = 'alice', displayName = 'Alice', id = 'u1'): SelectedAuthor =>
  ({ kind: 'local', id, handle, displayName })

export const remoteAuthor = (displayName = 'Bob', canonicalFeedUrl: string | null = 'https://bob.example/rss.xml', id = 'pub1'): SelectedAuthor =>
  ({ kind: 'remote_publisher', id, displayName, canonicalFeedUrl, profileAvailable: true, attributionLevel: 'bound_single_publisher' })

export function dto(over: Partial<LogicalItemDto> = {}): LogicalItemDto {
  return {
    kind: 'logical_item', id: 'p1', origin: 'local', parentResolutionState: 'none',
    parentLogicalItemId: null, threadRootId: null, selectedAuthor: localAuthor(),
    title: null, content: 'c', contentMarkdown: null, permalink: null, originGuid: null,
    inReplyToRef: null, sourceLink: null, replyContext: null, enclosures: [],
    publishedAt: '2026-01-01T00:00:00.000Z', updatedAt: null, updatedAtProvenance: null,
    directReplyCount: 0, conversationReplyCount: 0,
    classification: { personal: false, federated: false }, removed: false,
    ...over,
  }
}
