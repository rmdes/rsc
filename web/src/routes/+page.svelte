<script lang="ts">
	import type { PageData, ActionData } from './$types'
	import type { TimelineEntry } from '$lib/types'
	import LiveTimeline from '$lib/LiveTimeline.svelte'
	import ThemeToggle from '$lib/ThemeToggle.svelte'
	import ComposerDialog from '$lib/ComposerDialog.svelte'
	import ReplyTree from '$lib/ReplyTree.svelte'
	import ReplyToggle from '$lib/ReplyToggle.svelte'
	import FeedIcon from '$lib/FeedIcon.svelte'
	import Avatar from '$lib/Avatar.svelte'
	import PostBody from '$lib/PostBody.svelte'
	import EditedMarker from '$lib/EditedMarker.svelte'
	import ReplyContext from '$lib/ReplyContext.svelte'
	import { applyRiverEvent } from '$lib/live'
	import { applyLiveEvent, type LiveEvent } from '$lib/logical-live'
	import { fetchThread } from '$lib/wedge'
	import { enhance } from '$app/forms'
	import { invalidateAll } from '$app/navigation'
	import { confirmSubmit } from '$lib/confirm'
	import { keepEvent, type Lens } from '$lib/lens'
	import { TABS } from '$lib/tabs'

	let { data, form }: { data: PageData; form: ActionData } = $props()

	let live = $state<TimelineEntry[]>([])
	let edited = $state<Record<string, TimelineEntry>>({})
	// v2 remove is durable; the set stays empty under v1, so `posts` is unchanged there.
	let removed = $state<Set<string>>(new Set())
	const pageIds = $derived(new Set(data.timeline.map((p) => p.id)))
	const posts = $derived([...live, ...data.timeline].filter((p) => !removed.has(p.id)).map((p) => edited[p.id] ?? p))

	// Public river is lensless; the stream is a firehose, so every other tab
	// filters incoming SSE events client-side (same pattern as author/thread pages).
	const lens = $derived.by((): Lens | null => {
		if (data.tab === 'local') return { kind: 'source', source: 'local' }
		if (data.tab === 'federated') return { kind: 'feedType', feedType: 'instance' }
		if (data.tab === 'personal') return { kind: 'followed', followIds: new Set(data.followIds ?? []) }
		return null
	})

	function onPost(entry: TimelineEntry) {
		const keep = !lens || keepEvent(entry, lens)
		const r = applyRiverEvent({ live, edited }, entry, { posts, pageIds, keep })
		live = r.live
		edited = r.edited
	}

	// The logical-v2 durable stream (spec §5.7). The proxy translates journal
	// frames into upsert/remove/reset events carrying render-shape data; the
	// reducer inserts at immutable order, excludes river replies, and applies the
	// idempotent replyCounts overlay. Reset discards event-derived state and
	// refetches SSR — which mints a fresh journalCursor, so the effect re-runs and
	// reconnects from the new snapshot. Reads of posts/pageIds/lens happen inside
	// the async handler, so they are NOT effect dependencies (no reconnect churn).
	// ponytail: no hidden-tab visibility gate here (one connection per river page);
	// add it back if many-hidden-tab connection starvation resurfaces under v2.
	$effect(() => {
		// Only with a valid snapshot cursor: a discarded (fail-closed) river yields
		// none, so the stream stays closed until a reload gets a valid envelope —
		// avoiding a reset↔refetch loop against a broken core.
		if (!data.sourceModelV2 || !data.isFirstPage || !data.journalCursor) return
		const es = new EventSource(`/stream?v2=1&last=${encodeURIComponent(data.journalCursor)}`)
		const onFrame = (kind: 'upsert' | 'remove') => (e: Event) => {
			const msg = e as MessageEvent
			try {
				const d = JSON.parse(msg.data)
				const ev: LiveEvent =
					kind === 'upsert'
						? { kind: 'upsert', entry: d as TimelineEntry, rootReplyCount: d.rootReplyCount, threadRootId: d.threadRootId }
						: { kind: 'remove', id: d.id as string, rootReplyCount: d.rootReplyCount, threadRootId: d.threadRootId }
				const keep = ev.kind === 'upsert' ? !lens || keepEvent(ev.entry, lens) : true
				const r = applyLiveEvent({ live, edited, removed }, ev, { posts, pageIds, keep })
				live = r.live
				edited = r.edited
				removed = r.removed
			} catch {
				// ignore a malformed frame; a genuine contract break arrives as `reset`
			}
		}
		es.addEventListener('upsert', onFrame('upsert'))
		es.addEventListener('remove', onFrame('remove'))
		es.addEventListener('reset', () => {
			es.close()
			live = []
			edited = {}
			removed = new Set()
			invalidateAll()
		})
		return () => es.close()
	})

	// Group Textcasting peers by instance host: "which Textcasting authors is this instance hosting..."
	const peerHosts = $derived.by(() => {
		const counts = new Map<string, number>()
		for (const p of data.peers ?? []) {
			const host = p.feedUrl ? URL.parse(p.feedUrl)?.host : null
			if (host) counts.set(host, (counts.get(host) ?? 0) + 1)
		}
		return [...counts.entries()].map(([host, feeds]) => ({ host, feeds }))
	})

	// Open threads: post id → its flat thread snapshot. Root-only rivers never
	// show a resolved reply as its own card, so there is nothing to hide — we
	// iterate `posts` directly. Threads are snapshot-only; reload repairs.
	let expanded = $state<Record<string, TimelineEntry[]>>({})
	let loading = $state<Record<string, boolean>>({})
	async function toggleReplies(id: string) {
		if (expanded[id]) {
			delete expanded[id]
			return
		}
		if (loading[id]) return
		loading[id] = true
		try {
			expanded[id] = await fetchThread(id)
		} catch {
			// Leave it closed; the href is still a live link to the conversation.
		} finally {
			delete loading[id]
		}
	}
</script>

<svelte:head><title>RSC</title></svelte:head>

<!-- V1 uses the legacy `event: post` firehose; V2 wires its own upsert/remove/
     reset stream in the effect above. Mount at most one. -->
{#if data.isFirstPage && !data.sourceModelV2}
	<LiveTimeline {onPost} />
{/if}

<div class="shell">
	<aside class="tools">
		<header class="masthead">
			<a href="/">RSC</a>
			<ThemeToggle />
		</header>

		<ComposerDialog
			draftKey="compose"
			action="?tab={data.tab}&/compose"
			title="New post"
			submitLabel="Post"
			placeholder="what's happening?"
		/>

		{#if data.me && !data.me.isAnonymous}
			<details class="panel">
				<summary>Subscribe to a feed</summary>
				<form method="POST" action="?tab={data.tab}&/subscribe" class="add-remote">
					<label class="visually-hidden" for="sub-url">Feed URL</label>
					<input id="sub-url" name="url" type="url" placeholder="https://their-site.com/feed.xml" required />
					{#if data.sourceModelV2}
						<!-- v2 derives the kind from the feed itself; the id makes a no-JS
						     resubmit replay the same command instead of subscribing twice. -->
						<input type="hidden" name="commandId" value={data.subscribeCommandId} />
					{:else}
						<label class="visually-hidden" for="sub-type">Subscription type</label>
						<select id="sub-type" name="type">
							<option value="webfeed" selected>a site or publication</option>
							<option value="person">an individual</option>
						</select>
					{/if}
					<button>Subscribe</button>
				</form>
			</details>
		{:else}
			<p class="auth-note">Register to add feeds.</p>
		{/if}
	</aside>

	<main>
		<h1 class="visually-hidden">Timeline</h1>

		<nav class="tabs" aria-label="Timeline">
			{#each TABS as t (t)}
				<a href="/?tab={t}" aria-current={data.tab === t ? 'page' : undefined}>{t}</a>
			{/each}
		</nav>

		{#if data.coreDown}
			<p class="notice" role="alert">Can't load this page right now — try again shortly.</p>
		{/if}

		{#if data.addedFeed}
			<p class="notice confirm" role="status">Now following <strong>@{data.addedFeed}</strong>.</p>
		{:else if data.subscribed === 'added'}
			<p class="notice confirm" role="status">Subscribed — new items will appear in this river.</p>
		{:else if data.subscribed === 'pending'}
			<!-- Core's own neutral wording. The page never infers why. -->
			<p class="notice" role="status">This source is awaiting review.</p>
		{/if}

		{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}

		{#if data.tab === 'personal' && posts.length === 0 && !data.coreDown}
			<p class="notice">Your personal river is empty — <a href="/u/{data.me?.user.handle}/following">follow people and feeds</a> to fill it.</p>
		{/if}

		<ul class="timeline">
			{#each posts as post (post.id)}
				<li class="post" class:remote={post.source === 'remote'}>
					<div class="byline">
						<Avatar author={post.author} sourceName={post.sourceName} />
						<strong>{post.sourceName ?? post.author.displayName}</strong>
						{#if post.publisherId}
							<!-- v2 remote publisher: /p, not /u (which stays local-account only) -->
							<a class="handle" id="by-{post.id}" href="/p/{encodeURIComponent(post.publisherId)}">{post.author.displayName}</a>
						{:else if post.author.handle}
							<a class="handle" id="by-{post.id}" href="/u/{post.author.handle}">@{post.author.handle}</a>
						{/if}
						<span class="kind">{post.source}</span>
						<a class="permalink" href="/post/{post.id}"><time datetime={post.publishedAt}>{post.publishedAt.slice(0, 10)}</time></a>
						<EditedMarker {post} />
						<FeedIcon author={post.author} sourceName={post.sourceName} sourceFeedUrl={post.sourceFeedUrl} />
					</div>
					{#if post.title}<h2 class="title">{post.title}</h2>{/if}
					<PostBody {post} />
					{#if post.replyCount}
						<ReplyToggle
							count={post.replyCount}
							href="/post/{post.id}"
							expanded={!!expanded[post.id]}
							busy={!!loading[post.id]}
							aria-describedby="by-{post.id}"
							onactivate={() => toggleReplies(post.id)}
						/>
					{/if}
					{#if !(post.replyCount || post.threadRootId || post.inReplyToPostId)}
						<a class="source" href="/post/{post.id}">Reply</a>
					{/if}
					{#if !post.inReplyToPostId && post.replyContextAuthor}
						<ReplyContext author={post.replyContextAuthor} snippet={post.replyContextSnippet} url={post.inReplyTo?.startsWith('http') ? post.inReplyTo : null} />
					{:else if post.inReplyTo && !post.inReplyToPostId && post.inReplyTo.startsWith('http')}
						<a class="source" href={post.inReplyTo} rel="noreferrer">in reply to ↗</a>
					{/if}
					{#if post.source === 'remote' && post.url}<a class="source" href={post.url} rel="noreferrer">{URL.parse(post.url)?.hostname ?? 'source'}</a>{/if}
					{#if post.source === 'local' && data.me?.user.id === post.author.id}
						<a class="edit" href="/post/{post.id}/edit">Edit</a>
					{/if}
					{#if data.me?.isAdmin && post.source === 'local'}
						<form method="POST" action="?tab={data.tab}&/deletePost" use:enhance={confirmSubmit('Remove this post? This can\'t be undone.')}>
							<input type="hidden" name="id" value={post.id} />
							<button class="danger-link" type="submit">Remove</button>
						</form>
					{/if}
					{#if expanded[post.id]}
						<ReplyTree thread={expanded[post.id]} parentId={post.id} />
					{/if}
				</li>
			{/each}
		</ul>

		{#if data.nextCursor}
			<a class="older" href="/?tab={data.tab}&before={encodeURIComponent(data.nextCursor)}">Older posts</a>
		{/if}
	</main>

	<aside class="meta">
		<details class="panel" open>
			<summary>About</summary>
			<p>
				RSC — Really Simple Conversations — is a feeds-native social timeline: people who post here
				and people who post on their own site are equal citizens. Everything travels as RSS — posts,
				replies, whole conversations — so following, threading, and federation work with nothing but
				open feeds.
			</p>
			<p>
				Inspired by Dave Winer's
				<a href="https://textcasting.org" rel="noreferrer">Textcasting</a> and
				<a href="https://github.com/scripting/rss.chat" rel="noreferrer">rss.chat</a>.
			</p>
			<p><a href="https://github.com/rmdes/rsc" rel="noreferrer">Source &amp; docs</a></p>
		</details>

		<details class="panel" open>
			<summary>Feed</summary>
			<p class="feed-widget">
				<a class="feed-badge" href="/users/rss.xml" target="_blank" rel="noreferrer" aria-label="All posts — RSS feed">
					<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
						<circle cx="2.5" cy="13.5" r="2" />
						<path d="M0 6.5v2.5a7 7 0 0 1 7 7h2.5A9.5 9.5 0 0 0 0 6.5z" />
						<path d="M0 1v2.5A12.5 12.5 0 0 1 12.5 16H15A15 15 0 0 0 0 1z" />
					</svg>
				</a>
				<a href="/users/rss.xml" target="_blank" rel="noreferrer">All posts · RSS</a>
			</p>
		</details>

		{#if peerHosts.length}
			<details class="panel" open>
				<summary>Connected instances</summary>
				<!-- Approved federation instances only (v2 governance plane) —
				     instances that thread and interop with us. -->
				<ul class="peer-list">
					{#each peerHosts as p (p.host)}
						<li>
							<a href="https://{p.host}/" rel="noreferrer">{p.host}</a>
							<span class="badge-kind">{p.feeds} {p.feeds === 1 ? 'feed' : 'feeds'}</span>
						</li>
					{/each}
				</ul>
			</details>
		{/if}
	</aside>
</div>

<style>
	/* Text-button destructive affordance, matching .edit/.source's inline
	   link weight — not a filled/outlined button (that's .danger on
	   /admin/users, a card list with more visual room). */
	.danger-link {
		font: inherit;
		font-size: 0.875rem;
		background: none;
		border: none;
		padding: 0;
		color: var(--color-destructive);
		cursor: pointer;
	}

	.danger-link:hover {
		text-decoration: underline;
	}

	/* Tab bar: .admin-nav pattern + focus ring. Fixed 44px row so live
	   prepends below never shift it (MASTER: jank-free prepends). */
	.tabs {
		display: flex;
		gap: var(--space-md);
		overflow-x: auto;
		border-bottom: 1px solid var(--color-border);
		margin-bottom: var(--space-md);
	}

	.tabs a {
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		min-height: 44px;
		padding: 0 var(--space-xs);
		color: var(--color-secondary);
		font-weight: 600;
		text-decoration: none;
		text-transform: capitalize;
		border-bottom: 2px solid transparent;
		transition:
			color 200ms,
			border-color 200ms;
	}

	.tabs a:hover {
		color: var(--color-foreground);
	}

	.tabs a:focus-visible {
		outline: none;
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-ring) 15%, transparent);
	}

	.tabs a[aria-current='page'] {
		color: var(--color-foreground);
		border-bottom-color: var(--color-accent);
	}
</style>
