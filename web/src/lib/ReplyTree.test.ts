import { test, expect } from 'vitest'
import { render } from 'svelte/server'
import ReplyTree from './ReplyTree.svelte'
import { logicalToEntry, type LogicalItemDto, type SelectedAuthor } from './logical-types.ts'

// A resolved reply whose author is <over> — logicalToEntry gives it
// inReplyToPostId='root', so ReplyTree(parentId='root') renders it as a child.
const replyBy = (author: SelectedAuthor) =>
	logicalToEntry({
		kind: 'logical_item',
		id: 'r1',
		origin: author.kind === 'local' ? 'local' : 'remote',
		parentResolutionState: 'resolved',
		parentLogicalItemId: 'root',
		threadRootId: 'root',
		selectedAuthor: author,
		title: null,
		content: '<p>a reply</p>',
		contentMarkdown: null,
		permalink: 'https://ex.com/r1',
		sourceLink: 'https://ex.com/r1',
		replyContext: null,
		enclosures: [],
		publishedAt: '2026-07-20T00:00:00.000Z',
		updatedAt: null,
		updatedAtProvenance: null,
		directReplyCount: 0,
		conversationReplyCount: 0,
		classification: { personal: false, federated: true }
	} as LogicalItemDto)

// Fix 2: the nested byline must use the SAME branch every other byline uses —
// /p/:id for a v2 remote publisher (handle is ''), not the broken /u/ link.
test('a v2 remote-publisher reply node renders a /p/:id byline, never /u/', () => {
	const reply = replyBy({ kind: 'remote_publisher', id: 'pub1', displayName: 'Pub One', canonicalFeedUrl: 'https://ex.com/f.xml', profileAvailable: true, attributionLevel: 'bound_single_publisher' })
	const { body } = render(ReplyTree, { props: { thread: [reply], parentId: 'root' } })
	expect(body).toContain('href="/p/pub1"')
	expect(body).not.toContain('href="/u/"') // the empty-handle 404 this fix removes
})

test('a local-account reply node still renders the /u/:handle byline', () => {
	const reply = replyBy({ kind: 'local', id: 'u1', handle: 'alice', displayName: 'Alice' })
	const { body } = render(ReplyTree, { props: { thread: [reply], parentId: 'root' } })
	expect(body).toContain('href="/u/alice"')
	expect(body).not.toContain('href="/p/')
})
