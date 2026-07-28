<script lang="ts">
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
