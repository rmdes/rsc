<script lang="ts">
	import type { PageData } from './$types'

	let { data }: { data: PageData } = $props()

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
	}
</script>

<svelte:head><title>Admin — Users — Textcaster</title></svelte:head>

<h2>Users</h2>

{#if data.users.length === 0}
	<p class="subnav">No users yet.</p>
{:else}
	<div class="table-scroll">
		<table>
			<caption class="visually-hidden">Registered local accounts and remote feeds on this instance</caption>
			<thead>
				<tr>
					<th scope="col">Handle</th>
					<th scope="col">Display name</th>
					<th scope="col">Kind</th>
					<th scope="col">Verified</th>
					<th scope="col">Joined</th>
					<th scope="col">Feed URL</th>
				</tr>
			</thead>
			<tbody>
				{#each data.users as u (u.handle)}
					<tr>
						<td>@{u.handle}</td>
						<td>{u.displayName}</td>
						<td><span class="badge-kind">{u.kind}</span></td>
						<td>{u.emailVerified === null ? '—' : u.emailVerified ? 'Yes' : 'No'}</td>
						<td>{formatDate(u.createdAt)}</td>
						<td class="feed-url">{u.feedUrl ?? '—'}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}

<style>
	/* Native horizontal scroll rather than a JS-driven card layout —
	   the table is narrow enough (6 columns) that this only kicks in
	   on small phones. */
	.table-scroll {
		overflow-x: auto;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		white-space: nowrap;
	}

	th,
	td {
		text-align: left;
		padding: var(--space-sm) var(--space-md);
		border-bottom: 1px solid var(--color-border);
	}

	th {
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-secondary);
	}

	.feed-url {
		overflow-wrap: anywhere;
		white-space: normal;
	}
</style>
