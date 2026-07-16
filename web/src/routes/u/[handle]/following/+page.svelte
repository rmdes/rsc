<script lang="ts">
	import type { PageData, ActionData } from './$types'
	import type { TimelineEntry } from '$lib/types'
	import LiveTimeline from '$lib/LiveTimeline.svelte'
	import ThemeToggle from '$lib/ThemeToggle.svelte'
	import { keepEvent } from '$lib/lens'
	import { plaintext } from '$lib/plaintext'

	let { data, form }: { data: PageData; form: ActionData } = $props()
	const followSet = $derived(new Set(data.followIds))
	let live = $state<TimelineEntry[]>([])
	const posts = $derived([...live, ...data.timeline])

	function onPost(entry: TimelineEntry) {
		if (keepEvent(entry, { kind: 'followed', followIds: followSet }) && !posts.some((p) => p.id === entry.id)) live = [entry, ...live]
	}
</script>

{#if data.isFirstPage}
	<LiveTimeline {onPost} />
{/if}

<div class="lens">
	<header class="masthead">
		<a href="/">Textcaster</a>
		<ThemeToggle />
	</header>

	<div>
		<h1>@{data.handle} — following</h1>
		<p class="subnav"><a href="/u/{data.handle}">author lens</a> · <a href="/u/{data.handle}/following.opml">export OPML</a></p>
	</div>

	{#if data.coreDown}<p class="notice" role="alert">Core API unreachable — is the core server running?</p>{/if}
	{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}
	{#if form?.ok && form.result}
		<p class="import-result">Imported: {form.result.followed} followed, {form.result.created} created, {form.result.skipped} skipped.</p>
	{/if}

	<details class="panel" open>
		<summary>Follow someone</summary>
		<form method="POST" action="?/follow" class="follow-form">
			<input name="target" placeholder="handle to follow" required />
			<button>Follow</button>
		</form>
	</details>

	<details class="panel">
		<summary>Import OPML</summary>
		<form method="POST" action="?/import" enctype="multipart/form-data" class="import-form">
			<input type="file" name="opml" accept=".opml,.xml,text/xml" required />
			<button>Import OPML</button>
		</form>
	</details>

	<section>
		<h2>Following</h2>
		{#if data.following.length === 0}
			<p class="subnav">Not following anyone yet.</p>
		{:else}
			<ul class="following-list">
				{#each data.following as u (u.id)}
					<li>
						<span><a href="/u/{u.handle}">@{u.handle}</a> <span class="badge-kind">{u.kind}</span></span>
						<form method="POST" action="?/unfollow" class="unfollow-form">
							<input type="hidden" name="target" value={u.handle} />
							<button>Unfollow</button>
						</form>
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
						<a href="/u/{post.author.handle}">@{post.author.handle}</a>
					</div>
					{#if post.title}<h3 class="title">{post.title}</h3>{/if}
					<p>{plaintext(post.content)}</p>
					{#if post.url}<a href={post.url} rel="noreferrer">source</a>{/if}
				</li>
			{/each}
		</ul>

		{#if data.nextCursor}
			<a class="older" href="/u/{data.handle}/following?before={encodeURIComponent(data.nextCursor)}">Older posts</a>
		{/if}
	</section>
</div>
