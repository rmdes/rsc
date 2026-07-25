import { test, expect } from 'vitest'
import { render } from 'svelte/server'
import FeedIcon from './FeedIcon.svelte'
import type { TimelineEntry } from './types'

const author = (over: Partial<TimelineEntry['author']> = {}): TimelineEntry['author'] => ({
	id: 'a',
	handle: 'alice',
	displayName: 'Alice',
	kind: 'local',
	...over
})

test('a local author links its proxied /u feed', () => {
	const { body } = render(FeedIcon, { props: { author: author() } })
	expect(body).toContain('href="/u/alice/feed.xml"')
})

test('a remote author with a canonical feed links that feed', () => {
	const { body } = render(FeedIcon, { props: { author: author({ kind: 'remote', feedUrl: 'https://ex.com/f.xml' }) } })
	expect(body).toContain('href="https://ex.com/f.xml"')
})

// D1: a non-navigable v2 remote publisher has no feed URL AND an empty handle —
// the old fallback emitted the dead link /u//feed.xml. It must render no feed link.
test('a handleless remote author (no feed URL) never emits a dead /u//feed.xml link', () => {
	const { body } = render(FeedIcon, { props: { author: author({ kind: 'remote', handle: '', feedUrl: null }) } })
	expect(body).not.toContain('/u//feed.xml')
})
