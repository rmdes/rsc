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

<svelte:head><title>Admin — Users — RSC</title></svelte:head>

<h2>Users</h2>

{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}

{#if data.users.length === 0}
	<p class="subnav">No users yet.</p>
{:else}
	<table class="table table-records">
		<thead>
			<tr><th>Handle</th><th>Kind</th><th>Name</th><th>Verified</th><th>Joined</th><th>Feed</th><th>Action</th></tr>
		</thead>
		<tbody>
			{#each data.users as u (u.handle)}
				<tr>
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
								use:enhance={confirmSubmit(`Delete @${u.handle} and all their posts? This can't be undone.`)}
							>
								<input type="hidden" name="handle" value={u.handle} />
								<button type="submit">Delete account</button>
							</form>
						{:else}
							—
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
{/if}

{#if data.nextCursor}
	<a class="older" href="/admin/users?cursor={encodeURIComponent(data.nextCursor)}">More users</a>
{/if}
