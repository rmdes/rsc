<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import type { LayoutData } from './$types';
	import ThemeToggle from '$lib/ThemeToggle.svelte'
	import ComposerDialog from '$lib/ComposerDialog.svelte'
	import { TABS } from '$lib/tabs'
	import { page } from '$app/state'

	let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<!-- Feed autodiscovery: a reader given ANY page of this site finds the
	     all-users firehose. Pages with a more specific feed (author lenses)
	     add their own link BEFORE this one via their own svelte:head. -->
	<link rel="alternate" type="application/rss+xml" title="All posts" href="/users/rss.xml" />
</svelte:head>

<div class="identity-bar">
	{#if !data.me}
		<div>Browsing as a guest — post or follow to get an identity. <a href="/login">Log in</a> · <a href="/register">Register</a></div>
	{:else if data.me.isAnonymous}
		<div>
			<a class="handle" href="/u/{data.me.user.handle}">@{data.me.user.handle}</a>
			<a class="identity-cta" href="/register">Register to keep this account</a>
			<a href="/settings">Settings</a>
		</div>
	{:else}
		<div>
			{data.me.user.displayName} <a class="handle" href="/u/{data.me.user.handle}">@{data.me.user.handle}</a>
			{#if data.me.emailVerified === false}
				<span>Verify your email — <a class="identity-cta" href="/login">email me a login link</a></span>
			{/if}
			<a href="/settings">Settings</a>
			<form method="POST" action="/login?/logout" class="logout-form"><button type="submit">Log out</button></form>
		</div>
	{/if}
</div>

<nav class="nav" aria-label="Main">
	<a class="nav-brand" href="/">RSC</a>
	{#each TABS as t (t)}
		<a href="/?tab={t}" aria-current={page.url.pathname === '/' && data.tab === t ? 'page' : undefined}>{t}</a>
	{/each}
	{#if page.url.pathname === '/'}
		<!-- Two targets, like the rivers/theme-toggle above: below 768px this
		     jumps into the mobile menu's own #compose group (native
		     details-auto-expand-on-anchor); at 768px+ it targets the desktop
		     tools rail's composer instead. Never both #compose at once — see
		     the CSS media queries gating each anchor's visibility. -->
		<a class="spacer btn new-post-mobile" href="#compose">New post</a>
		<a class="spacer btn new-post-desktop" href="#compose-desktop">New post</a>
	{/if}
	<ThemeToggle />

	<details class="nav-menu">
		<summary class="nav-menu-toggle">Menu</summary>

		<div class="nav-menu-panel">
			<div class="nav-menu-group nav-menu-rivers">
				<h6>Rivers</h6>
				{#each TABS as t (t)}
					<a href="/?tab={t}" aria-current={page.url.pathname === '/' && data.tab === t ? 'page' : undefined}>
						{t}<span class="n">{page.url.pathname === '/' && data.tab === t ? 'here' : ''}</span>
					</a>
				{/each}
			</div>

			{#if page.url.pathname === '/'}
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
			{/if}

			<div class="nav-menu-group">
				<h6>Signed in</h6>
				{#if data.me}
					<div class="nav-menu-identity">{data.me.user.displayName}</div>
					<div class="nav-menu-list">
						<a href="/u/{data.me.user.handle}">Your lens</a>
						<a href="/settings">Settings</a>
						{#if data.me.isAdmin}<a href="/admin">Admin</a>{/if}
						{#if !data.me.isAnonymous}<a class="destructive" href="/login?/logout">Log out</a>{/if}
					</div>
				{:else}
					<p class="auth-note"><a href="/login">Log in</a> · <a href="/register">Register</a></p>
				{/if}
			</div>

			<div class="nav-menu-group"><ThemeToggle variant="segmented" /></div>
		</div>
	</details>
</nav>

{@render children()}

<footer class="site-footer">
	<a href="/about">About</a>
	<a href="/users/rss.xml">Feed</a>
	<a href="https://github.com/rmdes/rsc">Source</a>
</footer>
