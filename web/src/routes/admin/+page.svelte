<script lang="ts">
	import type { PageData } from './$types'

	let { data }: { data: PageData } = $props()
</script>

<svelte:head><title>Admin — RSC</title></svelte:head>

<h2>Overview</h2>

<dl class="stat-grid">
	<div class="stat-card">
		<dt>Registered users</dt>
		<dd>{data.overview.counts.registeredUsers}</dd>
	</div>
	<div class="stat-card">
		<dt>Guests</dt>
		<dd>{data.overview.counts.guests}</dd>
	</div>
	<div class="stat-card">
		<dt>Remote feeds</dt>
		<dd>{data.overview.counts.remoteFeeds}</dd>
	</div>
	<div class="stat-card">
		<dt>Posts</dt>
		<dd>{data.overview.counts.posts}</dd>
	</div>
</dl>

<section aria-labelledby="admin-federation-heading">
	<h3 id="admin-federation-heading">Federation</h3>
	<ul class="following-list">
		<li>
			<span class="status-label">WebSub</span>
			<span class="badge-kind">{data.overview.federation.websub}</span>
		</li>
		<li>
			<span class="status-label">rssCloud</span>
			<span class="badge-kind" class:on={data.overview.federation.rssCloud}>{data.overview.federation.rssCloud ? 'on' : 'off'}</span>
		</li>
		<li>
			<span class="status-label">Push-in</span>
			<span class="badge-kind" class:on={data.overview.federation.pushIn}>{data.overview.federation.pushIn ? 'on' : 'off'}</span>
		</li>
		<li>
			<span class="status-label">Public URL</span>
			<span class="subnav">{data.overview.federation.publicUrl ?? 'not set'}</span>
		</li>
		<li>
			<span class="status-label">Mail</span>
			<span class="badge-kind" class:on={data.overview.mailEnabled}>{data.overview.mailEnabled ? 'on' : 'off'}</span>
		</li>
	</ul>
</section>

{#if data.overview.adminEmails.length > 0}
	<section aria-labelledby="admin-emails-heading">
		<h3 id="admin-emails-heading">Admins</h3>
		<ul class="following-list">
			{#each data.overview.adminEmails as email (email)}
				<li>{email}</li>
			{/each}
		</ul>
	</section>
{/if}
