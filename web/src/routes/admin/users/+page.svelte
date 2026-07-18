<script lang="ts">
	import type { PageData, ActionData } from './$types'
	import { enhance } from '$app/forms'
	import { confirmSubmit } from '$lib/confirm'

	let { data, form }: { data: PageData; form: ActionData } = $props()

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
	}

	function verified(v: boolean | null): string {
		return v === null ? '—' : v ? 'Yes' : 'No'
	}
</script>

<svelte:head><title>Admin — Users — Textcaster</title></svelte:head>

<h2>Users</h2>

{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}

{#if data.users.length === 0}
	<p class="subnav">No users yet.</p>
{:else}
	<ul class="user-list">
		{#each data.users as u (u.handle)}
			<li>
				<div class="user-head">
					<span class="user-handle">@{u.handle}</span>
					<span class="badge-kind">{u.kind}</span>
				</div>
				<dl class="user-meta">
					<div><dt>Name</dt> <dd>{u.displayName}</dd></div>
					<div><dt>Verified</dt> <dd>{verified(u.emailVerified)}</dd></div>
					<div><dt>Joined</dt> <dd>{formatDate(u.createdAt)}</dd></div>
					{#if u.feedUrl}
						<div class="user-feed"><dt>Feed</dt> <dd>{u.feedUrl}</dd></div>
					{/if}
				</dl>
				{#if u.kind === 'local'}
					<form
						method="POST"
						action="?/deleteUser"
						class="delete-form"
						use:enhance={confirmSubmit(`Delete @${u.handle} and all their posts? This can't be undone.`)}
					>
						<input type="hidden" name="handle" value={u.handle} />
						<button class="danger" type="submit">Delete account</button>
					</form>
				{/if}
			</li>
		{/each}
	</ul>
{/if}

<style>
	/* Card-per-user, not a table: the admin column is a fixed 42rem (`.lens`),
	   too narrow for 6 columns — cards reflow instead of forcing a scrollbar. */
	.user-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
	}

	.user-list li {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		padding: var(--space-md);
	}

	.user-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-sm);
		margin-bottom: var(--space-sm);
	}

	.user-handle {
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	/* Label/value pairs that flow inline and wrap; the feed URL takes its own row. */
	.user-meta {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs) var(--space-lg);
		margin: 0;
		font-size: 0.8125rem;
	}

	.user-meta > div {
		display: flex;
		gap: var(--space-xs);
		min-width: 0;
	}

	.user-meta dt {
		color: var(--color-secondary);
	}

	.user-meta dd {
		margin: 0;
	}

	.user-feed {
		flex-basis: 100%;
	}

	.user-feed dd {
		overflow-wrap: anywhere;
	}

	.delete-form {
		margin-top: var(--space-sm);
	}

	/* Outline destructive, matching .unfollow-form's button on /admin/feeds. */
	.danger {
		background: transparent;
		color: var(--color-destructive);
		border: 1px solid var(--color-border);
		padding: 6px 14px;
	}
</style>
