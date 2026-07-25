<script lang="ts">
	import type { PageData, ActionData } from './$types'
	import type { TimelineEntry } from '$lib/types'
	import LiveTimeline from '$lib/LiveTimeline.svelte'
	import ThemeToggle from '$lib/ThemeToggle.svelte'
	import { keepEvent } from '$lib/lens'
	import ReplyTree from '$lib/ReplyTree.svelte'
	import ReplyToggle from '$lib/ReplyToggle.svelte'
	import FeedIcon from '$lib/FeedIcon.svelte'
	import Avatar from '$lib/Avatar.svelte'
	import PostBody from '$lib/PostBody.svelte'
	import ReplyContext from '$lib/ReplyContext.svelte'
	import { applyRiverEvent } from '$lib/live'
	import { fetchThread } from '$lib/wedge'

	let { data, form }: { data: PageData; form: ActionData } = $props()
	const followSet = $derived(new Set(data.followIds))
	const emptyNote = $derived(data.isOwner ? "You're not following anything yet — subscribe above." : `@${data.handle} isn't following anything yet.`)
	let live = $state<TimelineEntry[]>([])
	let edited = $state<Record<string, TimelineEntry>>({})
	const pageIds = $derived(new Set(data.timeline.map((p) => p.id)))
	const posts = $derived([...live, ...data.timeline].map((p) => edited[p.id] ?? p))

	function onPost(entry: TimelineEntry) {
		const keep = keepEvent(entry, { kind: 'followed', followIds: followSet }) || entry.author.handle === data.handle
		const r = applyRiverEvent({ live, edited }, entry, { posts, pageIds, keep })
		live = r.live
		edited = r.edited
	}

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

<svelte:head><title>@{data.handle} following — RSC</title></svelte:head>

<!-- v1 firehose only; under v2 this river is snapshot (reload to refresh). -->
{#if data.isFirstPage && !data.sourceModelV2}
	<LiveTimeline {onPost} />
{/if}

<div class="lens">
	<header class="masthead">
		<a href="/">RSC</a>
		<ThemeToggle />
	</header>

	<div>
		<h1>@{data.handle} — following</h1>
		<p class="subnav"><a href="/u/{data.handle}">author lens</a> · <a href="/u/{data.handle}/following.opml">export OPML</a></p>
	</div>

	{#if data.coreDown}<p class="notice" role="alert">Can't load this page right now — try again shortly.</p>{/if}
	{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}
	{#if form?.ok && form.result}
		{#if 'followed' in form.result}
			<p class="notice confirm" role="status">Imported: {form.result.followed} followed, {form.result.created} created, {form.result.skipped} skipped (unfetchable, duplicate, or over your subscription cap).</p>
		{:else}
			{@const r = form.result}
			<!-- unavailable and not-subscribable are one indistinguishable outcome. -->
			<p class="notice confirm" role="status">Imported: {r.localFollowed} followed, {r.active} subscribed, {r.pending} awaiting review, {r.unavailable + r.notSubscribable} unavailable, {r.capSkipped} over your subscription cap.</p>
		{/if}
	{/if}

	{#if !data.isOwner}
		<p class="auth-note">Follow buttons here act as you, not as @{data.handle}.</p>
	{/if}

	{#if data.isOwner}
		<details class="panel">
			<summary>Subscribe to a feed</summary>
			<form method="POST" action="/?/subscribe" class="add-remote">
				<label class="visually-hidden" for="sub-url">Feed URL</label>
				<input id="sub-url" name="url" type="url" placeholder="https://their-site.com/feed.xml" required />
				{#if data.sourceModelV2}
					<input type="hidden" name="commandId" value={data.commandIds?.subscribe} />
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
		<details class="panel" open>
			<summary>Follow someone</summary>
			<form method="POST" action="?/follow" class="follow-form">
				<label class="visually-hidden" for="follow-target">Handle to follow</label>
				<input id="follow-target" name="target" placeholder="handle to follow" required />
				<button>Follow</button>
			</form>
		</details>

		{#if data.me && !data.me.isAnonymous}
			<details class="panel">
				<summary>Import OPML</summary>
				<form method="POST" action="?/import" enctype="multipart/form-data" class="import-form">
					<label class="visually-hidden" for="import-opml">OPML file to import</label>
					<input id="import-opml" type="file" name="opml" accept=".opml,.xml,text/xml" required />
					{#if data.sourceModelV2}
						<input type="hidden" name="commandId" value={data.commandIds?.import} />
					{/if}
					<button>Import OPML</button>
				</form>
			</details>
		{:else}
			<p class="auth-note">Register to add feeds.</p>
		{/if}
	{/if}

	<section>
		<h2>{data.isOwner ? 'Your subscriptions' : `@${data.handle} follows`}</h2>
		{#if data.sourceModelV2}
			{#if (data.rows ?? []).length === 0}
				<p class="timeline-empty">{emptyNote}</p>
			{:else}
				<ul class="following-list">
					{#each data.rows ?? [] as row (row.kind === 'local' ? row.handle : row.sourceId)}
						<li>
							{#if row.kind === 'local'}
								<span><a href="/u/{row.handle}">@{row.handle}</a> <span class="badge-kind">local</span></span>
								<form method="POST" action={data.isOwner ? '?/unfollow' : '?/follow'} class="unfollow-form" class:follow-row={!data.isOwner}>
									<input type="hidden" name="target" value={row.handle} />
									<button>{data.isOwner ? 'Unfollow' : 'Follow'}</button>
								</form>
							{:else}
								<!-- Only the owner's own projection can carry pending, and it
								     says nothing about why — no governance state reaches here. -->
								<span><a href={row.url} rel="noreferrer">{row.label}</a>{#if row.pending}<span class="badge-kind">awaiting review</span>{/if}</span>
								{#if data.isOwner}
									<form method="POST" action="?/unsubscribe" class="unfollow-form">
										<input type="hidden" name="sourceId" value={row.sourceId} />
										<input type="hidden" name="commandId" value={row.commandId} />
										<button>Unsubscribe</button>
									</form>
								{/if}
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		{:else if data.following.length === 0}
			<p class="timeline-empty">{emptyNote}</p>
		{:else}
			<ul class="following-list">
				{#each data.following as u (u.id)}
					<li>
						<span><a href="/u/{u.handle}">@{u.handle}</a> <span class="badge-kind">{u.kind}</span>{#if u.feedType === 'instance'}<span class="badge-kind on">instance</span>{/if}</span>
						{#if data.isOwner}
							<form method="POST" action="?/unfollow" class="unfollow-form">
								<input type="hidden" name="target" value={u.handle} />
								<button>Unfollow</button>
							</form>
						{:else}
							<form method="POST" action="?/follow" class="unfollow-form follow-row">
								<input type="hidden" name="target" value={u.handle} />
								<button>Follow</button>
							</form>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section>
		<h2>Timeline</h2>
		<ul class="timeline">
			{#each posts as post (post.id)}
				<li class="post" class:remote={post.source === 'remote'}>
					<div class="byline">
						<Avatar author={post.author} sourceName={post.sourceName} />
						<strong>{post.sourceName ?? post.author.displayName}</strong>
						{#if post.publisherId}
							<a class="handle" id="by-{post.id}" href="/p/{encodeURIComponent(post.publisherId)}">{post.author.displayName}</a>
						{:else if post.author.handle}
							<a class="handle" id="by-{post.id}" href="/u/{post.author.handle}">@{post.author.handle}</a>
						{/if}
						<span class="kind">{post.source}</span>
						<a class="permalink" href="/post/{post.id}"><time datetime={post.publishedAt}>{post.publishedAt.slice(0, 10)}</time></a>
						<FeedIcon author={post.author} sourceName={post.sourceName} sourceFeedUrl={post.sourceFeedUrl} />
					</div>
					{#if post.title}<h3 class="title">{post.title}</h3>{/if}
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
					{#if post.source === 'remote' && post.url}<a href={post.url} rel="noreferrer">source</a>{/if}
					{#if expanded[post.id]}
						<ReplyTree thread={expanded[post.id]} parentId={post.id} />
					{/if}
				</li>
			{:else}
				<li class="timeline-empty">Nothing to show — posts from the people you follow will appear as they arrive, or the timeline couldn't load.</li>
			{/each}
		</ul>

		{#if data.nextCursor}
			<a class="older" href="/u/{data.handle}/following?before={encodeURIComponent(data.nextCursor)}">Older posts</a>
		{/if}
	</section>
</div>
