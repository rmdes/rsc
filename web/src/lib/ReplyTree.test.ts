import { test, expect } from 'vitest'
import { render } from 'svelte/server'
import ReplyTree from './ReplyTree.svelte'
import { logicalToEntry, placeholderToEntry, type LogicalItemDto, type SelectedAuthor } from './logical-types.ts'

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

// D1: a non-navigable remote publisher has no /p page (profileAvailable=false ⇒
// publisherId undefined) AND an empty handle — the old /u/{handle} fallback made
// a dead <a href="/u/">@</a>. The byline must name it in plain text instead.
test('a non-navigable remote reply node names its author in plain text, never a dead /u/ link or bare @', () => {
	const reply = replyBy({ kind: 'remote_publisher', id: 'p2', displayName: 'Fallback Pub', canonicalFeedUrl: null, profileAvailable: false, attributionLevel: 'source_scoped_fallback' })
	const { body } = render(ReplyTree, { props: { thread: [reply], parentId: 'root' } })
	expect(body).toContain('Fallback Pub') // the display name still shows
	expect(body).not.toContain('href="/u/"') // no dead empty-handle link
	expect(body).not.toContain('href="/p/') // no /p link (it would 404)
	expect(body).not.toMatch(/>@</) // no bare @
})

test('a local-account reply node still renders the /u/:handle byline', () => {
	const reply = replyBy({ kind: 'local', id: 'u1', handle: 'alice', displayName: 'Alice' })
	const { body } = render(ReplyTree, { props: { thread: [reply], parentId: 'root' } })
	expect(body).toContain('href="/u/alice"')
	expect(body).not.toContain('href="/p/')
})

// D11: an unavailable ancestor mid-thread must render as a neutral connective
// marker with its reply subtree nested underneath it — not be dropped, which
// would make the whole subtree unreachable.
test('a placeholder mid-thread renders a neutral marker and its reply subtree still renders', () => {
	const gap = placeholderToEntry({ kind: 'placeholder', logicalItemId: 'gap', parentLogicalItemId: 'root', timelineSortAt: '2026-07-19T00:00:00.000Z', placeholderKind: 'unavailable' })
	// the reply hangs off the placeholder, not off root
	const reply = { ...replyBy({ kind: 'local', id: 'u1', handle: 'alice', displayName: 'Alice' }), inReplyToPostId: 'gap' }
	const { body } = render(ReplyTree, { props: { thread: [gap, reply], parentId: 'root', openAll: true } })
	expect(body).toContain('Post unavailable') // the marker
	expect(body).toContain('a reply') // the subtree under the placeholder renders
	expect(body).toContain('href="/u/alice"') // the descendant reply is a full card
})

// The marker is a neutral node, NOT a card: no byline/avatar/PostBody/reply-action
// and no {@html} chokepoint of its own.
test('a placeholder node is a neutral marker, not a card', () => {
	const gap = placeholderToEntry({ kind: 'placeholder', logicalItemId: 'gap', parentLogicalItemId: 'root', timelineSortAt: '2026-07-19T00:00:00.000Z', placeholderKind: 'unavailable' })
	const { body } = render(ReplyTree, { props: { thread: [gap], parentId: 'root', openAll: true } })
	expect(body).toContain('Post unavailable')
	expect(body).not.toContain('class="byline"') // no byline
	expect(body).not.toContain('href="/u/') // no author handle link
	expect(body).not.toContain('>Reply<') // no reply action
})
