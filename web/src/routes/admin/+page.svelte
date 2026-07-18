<script lang="ts">
	import type { PageData, ActionData } from './$types'
	import ThemeToggle from '$lib/ThemeToggle.svelte'
	import { enhance } from '$app/forms'

	let { data, form }: { data: PageData; form: ActionData } = $props()
</script>

<svelte:head><title>Admin — Textcaster</title></svelte:head>

<div class="lens">
	<header class="masthead">
		<a href="/">Textcaster</a>
		<ThemeToggle />
	</header>

	<div>
		<h1>Admin</h1>
		<p class="subnav"><a href="/">back to timeline</a></p>
	</div>

	{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}

	<section>
		<h2>Remote feeds</h2>
		{#if data.feeds.length === 0}
			<p class="subnav">No remote feeds yet.</p>
		{:else}
			<ul class="following-list">
				{#each data.feeds as feed (feed.handle)}
					<li>
						<div class="feed-info">
							<strong>@{feed.handle}</strong>
							<span class="subnav feed-url">{feed.feedUrl ?? 'no feed url'}</span>
						</div>
						<form method="POST" action="?/remove" class="unfollow-form" use:enhance>
							<input type="hidden" name="handle" value={feed.handle} />
							<button aria-label="Remove @{feed.handle}">Remove</button>
						</form>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<details class="panel" open>
		<summary>Add remote feed</summary>
		<form method="POST" action="?/add" class="add-remote" use:enhance>
			<label class="visually-hidden" for="admin-add-handle">Handle</label>
			<input id="admin-add-handle" name="handle" placeholder="handle" required />
			<label class="visually-hidden" for="admin-add-display-name">Display name (optional)</label>
			<input id="admin-add-display-name" name="displayName" placeholder="display name (optional)" />
			<label class="visually-hidden" for="admin-add-feed-url">Feed URL</label>
			<input id="admin-add-feed-url" name="feedUrl" type="url" placeholder="https://their-site.com/feed.xml" required />
			<button>Add feed</button>
		</form>
	</details>
</div>

<style>
	/* Feed URLs can run long; the shared .following-list row has no wrap
	   handling since its usual content (a handle + kind badge) never needs
	   it — stack + wrap here rather than adding an admin-only case upstream. */
	.feed-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.feed-url {
		overflow-wrap: anywhere;
	}
</style>
