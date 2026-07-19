<script lang="ts">
	import ThemeToggle from '$lib/ThemeToggle.svelte'
	import { page } from '$app/state'

	let { children }: { children: import('svelte').Snippet } = $props()

	const tabs = [
		{ href: '/admin', label: 'Overview' },
		{ href: '/admin/feeds', label: 'Feeds' },
		{ href: '/admin/users', label: 'Users' },
		{ href: '/admin/settings', label: 'Settings' }
	]
</script>

<div class="lens">
	<header class="masthead">
		<a href="/">Textcaster</a>
		<ThemeToggle />
	</header>

	<div>
		<h1>Admin</h1>
		<p class="subnav"><a href="/">back to timeline</a></p>
	</div>

	<nav class="admin-nav" aria-label="Admin sections">
		{#each tabs as tab (tab.href)}
			<a href={tab.href} aria-current={page.url.pathname === tab.href ? 'page' : undefined}>{tab.label}</a>
		{/each}
	</nav>

	{@render children()}
</div>

<style>
	.admin-nav {
		display: flex;
		gap: var(--space-md);
		border-bottom: 1px solid var(--color-border);
	}

	.admin-nav a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0 var(--space-xs);
		color: var(--color-secondary);
		font-weight: 600;
		text-decoration: none;
		border-bottom: 2px solid transparent;
	}

	.admin-nav a:hover {
		color: var(--color-foreground);
	}

	.admin-nav a:focus-visible {
		outline: none;
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-ring) 15%, transparent);
	}

	.admin-nav a[aria-current='page'] {
		color: var(--color-foreground);
		border-bottom-color: var(--color-accent);
	}
</style>
