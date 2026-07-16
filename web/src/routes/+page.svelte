<script lang="ts">
	import type { PageData, ActionData } from './$types'
	import type { TimelineEntry } from '$lib/types'
	import LiveTimeline from '$lib/LiveTimeline.svelte'
	import ThemeToggle from '$lib/ThemeToggle.svelte'
	import { plaintext } from '$lib/plaintext'

	let { data, form }: { data: PageData; form: ActionData } = $props()

	let live = $state<TimelineEntry[]>([])
	const posts = $derived([...live, ...data.timeline])

	function onPost(entry: TimelineEntry) {
		if (!posts.some((p) => p.id === entry.id)) live = [entry, ...live]
	}
</script>

{#if data.isFirstPage}
	<LiveTimeline {onPost} />
{/if}

<div class="shell">
	<aside class="tools">
		<header class="masthead">
			<a href="/">Textcaster</a>
			<ThemeToggle />
		</header>

		<details class="panel" open>
			<summary>New post</summary>
			<form method="POST" action="?/compose" class="composer">
				<input name="handle" placeholder="your handle" required />
				<input name="displayName" placeholder="display name (optional)" />
				<textarea name="content" placeholder="what's happening?" required></textarea>
				<button>Post</button>
			</form>
		</details>

		<details class="panel">
			<summary>Add remote user</summary>
			<form method="POST" action="?/addRemote" class="add-remote">
				<input name="handle" placeholder="remote handle" required />
				<input name="displayName" placeholder="display name (optional)" />
				<input name="feedUrl" type="url" placeholder="https://their-site.com/feed.xml" required />
				<button>Add remote user</button>
			</form>
		</details>
	</aside>

	<main>
		{#if data.coreDown}
			<p class="notice" role="alert">Core API unreachable — is the core server running?</p>
		{/if}

		{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}

		<ul class="timeline">
			{#each posts as post (post.id)}
				<li class="post" class:remote={post.source === 'remote'}>
					<div class="byline">
						<strong>{post.author.displayName}</strong>
						<a class="handle" href="/u/{post.author.handle}">@{post.author.handle}</a>
						<span class="kind">{post.source}</span>
						<time datetime={post.publishedAt}>{post.publishedAt.slice(0, 10)}</time>
					</div>
					{#if post.title}<h2 class="title">{post.title}</h2>{/if}
					<p>{plaintext(post.content)}</p>
					{#if post.url}<a href={post.url} rel="noreferrer">source</a>{/if}
				</li>
			{/each}
		</ul>

		{#if data.nextCursor}
			<a class="older" href="/?before={encodeURIComponent(data.nextCursor)}">Older posts</a>
		{/if}
	</main>

	<aside class="meta">
		<details class="panel" open>
			<summary>About</summary>
			<p>
				One timeline where people who post here and people who post on their own site are equal
				citizens. Local posts appear live; remote feeds are polled in.
			</p>
			<p><a href="https://textcasting.org" rel="noreferrer">Textcasting</a></p>
		</details>
	</aside>
</div>
