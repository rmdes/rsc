<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import type { LayoutData } from './$types';
	import { tick } from 'svelte';
	import ComposerDialog from '$lib/ComposerDialog.svelte'
	import AccountMenu from '$lib/AccountMenu.svelte'
	import { TABS } from '$lib/tabs'
	import { page } from '$app/state'

	let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

	// This layout persists across SvelteKit's client-side navigation, so a
	// native <details>'s open/closed state otherwise survives a route change —
	// close it whenever the actual page changes (a river link was clicked).
	// Keyed on pathname+search, not the full href: opening the mobile composer
	// only changes the #compose hash on the SAME page and must not close this.
	let menuOpen = $state(false);
	const routeKey = $derived(page.url.pathname + page.url.search);
	$effect(() => {
		routeKey;
		menuOpen = false;
	});

	// The New Post link's href="#compose" is a no-JS fallback (the browser's
	// native fragment-reveal algorithm auto-expands an ancestor <details> —
	// but that's inconsistently supported and was the "sometimes it just
	// doesn't open" bug). With JS available, open the menu explicitly instead.
	async function openComposer(e: MouseEvent) {
		e.preventDefault();
		menuOpen = true;
		await tick();
		document.getElementById('compose')?.scrollIntoView({ block: 'start' });
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<!-- Feed autodiscovery: a reader given ANY page of this site finds the
	     all-users firehose. Pages with a more specific feed (author lenses)
	     add their own link BEFORE this one via their own svelte:head. -->
	<link rel="alternate" type="application/rss+xml" title="All posts" href="/users/rss.xml" />
</svelte:head>

<nav class="nav" aria-label="Main">
	<a class="nav-brand" href="/">RSC</a>
	<div class="nav-tabs">
		{#each TABS as t (t)}
			<a href="/?tab={t}" aria-current={page.url.pathname === '/' && data.tab === t ? 'page' : undefined}>{t}</a>
		{/each}
	</div>
	{#if page.url.pathname === '/'}
		<!-- Mobile-only shortcut: below 768px there's no persistently-visible
		     composer to jump to, so this opens the mobile menu's own #compose
		     group directly (see openComposer above). Hidden by CSS at 768px+,
		     where the .tools sidebar composer is already on-screen — see
		     .nav .new-post-mobile in app.css. -->
		<a class="spacer btn new-post-mobile" href="#compose" onclick={openComposer}>New post</a>
	{/if}
	<AccountMenu me={data.me} />

	{#if page.url.pathname === '/'}
		<details class="nav-menu" bind:open={menuOpen}>
			<summary class="nav-menu-toggle">Menu</summary>

			<div class="nav-menu-panel">
				<div class="nav-menu-group" id="compose">
					<h6>New post</h6>
					<ComposerDialog draftKey="compose" action="?tab={data.tab}&/compose" title="New post" submitLabel="Post" placeholder="what's happening?" />
				</div>
				<div class="nav-menu-group">
					<h6>Subscribe to a feed</h6>
					{#if data.me && !data.me.isAnonymous}
						<form method="POST" action="?tab={data.tab}&/subscribe" class="add-remote">
							<label class="visually-hidden" for="menu-sub-url">Feed URL</label>
							<input id="menu-sub-url" name="url" type="url" placeholder="https://their-site.com/feed.xml" required />
							<input type="hidden" name="commandId" value={data.subscribeCommandId} />
							<button>Subscribe</button>
						</form>
					{:else}
						<p class="auth-note">Register to add feeds.</p>
					{/if}
				</div>
			</div>
		</details>
	{/if}
</nav>

{@render children()}

<footer class="site-footer">
	<a href="/about">About</a>
	<a href="/users/rss.xml">Feed</a>
	<a href="https://github.com/rmdes/rsc">Source</a>
</footer>
