<script lang="ts">
	import type { PageData, ActionData } from './$types'
	import { enhance } from '$app/forms'

	let { data, form }: { data: PageData; form: ActionData } = $props()

	// ActionData is a union across deleteUser (error/deleted) and bulkDelete
	// (bulkDeleteResults) — same loose-read reasoning as feeds/+page.svelte's
	// RetryFail, one field doesn't collide with the other action's shape.
	type BulkForm = { bulkDeleteResults?: { handle: string; ok: boolean; error?: string }[] }
	const bulkForm = $derived(form as BulkForm | null)

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
	}

	function verified(v: boolean | null): string {
		return v === null ? '—' : v ? 'Yes' : 'No'
	}

	// COSMETIC ONLY: drives the live "N selected" count and the blurb↔toolbar
	// swap class. What a bulk submit actually carries comes from the checked
	// boxes themselves (each one's own `value` is the handle) — the confirm-gate
	// and its button below are never gated on this Set's size, only on whether
	// any local user exists at all, so they stay reachable with JS off.
	let selected: Set<string> = $state(new Set())
	function toggleSelected(handle: string) {
		const next = new Set(selected)
		if (next.has(handle)) next.delete(handle)
		else next.add(handle)
		selected = next
	}
</script>

<svelte:head><title>Admin — Users — RSC</title></svelte:head>

<h2>Users</h2>

{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}

{#if data.users.length === 0}
	<p class="subnav">No users yet.</p>
{:else}
	<table class="table table-records">
		<thead>
			<!-- The checkbox column's header is a real, in-flow cell with only its
			     LABEL hidden: .visually-hidden is `position: absolute`, so putting
			     it on the <th> itself drops that cell out of flow and misaligns
			     every column against the body rows. Same shape feeds/+page.svelte
			     uses for its own row-select labels. -->
			<tr><th><span class="visually-hidden">Select</span></th><th>Handle</th><th>Kind</th><th>Name</th><th>Verified</th><th>Joined</th><th>Feed</th><th>Action</th></tr>
		</thead>
		<tbody>
			{#each data.users as u (u.handle)}
				<tr>
					<td data-label="Select">
						{#if u.kind === 'local'}
							<input type="checkbox" form="bulk-delete-users" name="handle" value={u.handle} checked={selected.has(u.handle)} onchange={() => toggleSelected(u.handle)} />
						{/if}
					</td>
					<td data-label="Handle">@{u.handle}</td>
					<td data-label="Kind">{u.kind}</td>
					<td data-label="Name">{u.displayName}</td>
					<td data-label="Verified">{verified(u.emailVerified)}</td>
					<td data-label="Joined">{formatDate(u.createdAt)}</td>
					<td data-label="Feed">{u.feedUrl ?? '—'}</td>
					<td data-label="Action">
						{#if u.kind === 'local'}
							<!-- Carries the current page's cursor forward, same convention as
							     admin/feeds' mutating forms — otherwise deleting a user on
							     page 2 would bounce the reload back to page 1. -->
							<form
								method="POST"
								action="?/deleteUser{data.cursor ? `&cursor=${encodeURIComponent(data.cursor)}` : ''}"
								class="unfollow-form"
								use:enhance
							>
								<input type="hidden" name="handle" value={u.handle} />
								<details class="confirm-gate">
									<summary><span class="action-name">Delete account</span></summary>
									<p class="consequence">Delete @{u.handle} and all their posts? This can't be undone.</p>
									<button type="submit" aria-label="Confirm delete — @{u.handle}">Confirm delete</button>
								</details>
							</form>
						{:else}
							—
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
	<!-- Same always-visible posture as feeds/+page.svelte's orphan/tombstone
	     bulk bars (Task 7, corrected): the confirm-gate/button ship in server
	     output whenever there's at least one local user to act on — never
	     gated on `selected.size`, which would make the submit path
	     unreachable with JS off. "N selected" is the only JS-cosmetic bit. -->
	<form
		id="bulk-delete-users"
		method="POST"
		action="?/bulkDelete{data.cursor ? `&cursor=${encodeURIComponent(data.cursor)}` : ''}"
		class="bulk-bar"
		use:enhance={() => {
			// invalidateAll() re-runs load() without remounting, so a stale
			// selection would keep handles of now-deleted users otherwise.
			selected = new Set()
		}}
	>
		{#if data.users.some((u) => u.kind === 'local')}
			<p class="subnav bulk-blurb" class:has-selection={selected.size > 0}>
				<span class="bulk-tools">
					{#if selected.size > 0}<span>{selected.size} selected ·</span>{/if}
				</span>
			</p>
			<details class="confirm-gate">
				<summary><span class="action-name">Delete selected</span></summary>
				<p class="consequence">Delete the selected accounts and all their posts? This can't be undone.</p>
				<button>Confirm delete selected</button>
			</details>
		{/if}
	</form>
	{#if bulkForm?.bulkDeleteResults?.length}
		<ul class="bulk-outcomes">
			{#each bulkForm.bulkDeleteResults as r (r.handle)}<li class:error={!r.ok}>@{r.handle}: {r.ok ? 'deleted' : r.error}</li>{/each}
		</ul>
	{/if}
{/if}

{#if data.nextCursor}
	<a class="older" href="/admin/users?cursor={encodeURIComponent(data.nextCursor)}">More users</a>
{/if}

<style>
	.bulk-bar {
		margin: 0 0 var(--space-sm);
	}

	.bulk-blurb {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-sm);
	}

	.bulk-blurb.has-selection {
		border-bottom: 2px solid var(--color-border);
		padding-bottom: var(--space-sm);
	}

	.bulk-tools {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-sm);
	}

	.bulk-outcomes {
		list-style: none;
		margin: 0 0 var(--space-md);
		padding: 0;
		font-size: 0.8125rem;
	}

	.bulk-outcomes .error {
		color: var(--color-destructive);
	}

	.action-name {
		font-weight: 600;
	}
	.consequence {
		margin: 0;
		color: var(--color-secondary);
		font-size: 0.8125rem;
	}
	.confirm-gate summary {
		cursor: pointer;
		list-style: none;
	}
	.confirm-gate summary::-webkit-details-marker {
		display: none;
	}

	/* The native marker is removed just above, so the summary needs an
	   affordance of its own — without one every destructive action in /admin
	   reads as static bold text with no hint that it expands. A CSS-only glyph
	   that turns when open; no icon font, no asset. Duplicated verbatim in the
	   three admin pages that own .confirm-gate, same as .consequence /
	   .action-name already are. */
	.confirm-gate summary::before {
		content: '▸';
		display: inline-block;
		margin-right: var(--space-xs);
		color: var(--color-secondary);
		transition: transform 0.15s ease;
	}

	.confirm-gate[open] summary::before {
		transform: rotate(90deg);
	}
	.confirm-gate[open] summary .action-name {
		color: var(--color-secondary);
	}
	.confirm-gate .consequence {
		margin: var(--space-sm) 0;
	}
</style>
