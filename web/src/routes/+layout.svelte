<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import type { LayoutData } from './$types';

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

{@render children()}
