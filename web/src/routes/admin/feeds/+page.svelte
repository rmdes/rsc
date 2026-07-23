<script lang="ts">
	import type { PageData, ActionData } from './$types'
	import { enhance } from '$app/forms'
	import { confirmSubmit } from '$lib/confirm'

	let { data, form }: { data: PageData; form: ActionData } = $props()

	const LABEL: Record<string, string> = {
		pause: 'Pause acquisition',
		resume: 'Resume acquisition',
		quarantine: 'Quarantine',
		allow: 'Allow',
		approve: 'Approve federation',
		reject: 'Reject federation',
		revoke: 'Revoke federation',
		block: 'Block',
		unblock: 'Unblock',
		'attribution-mode': 'Change attribution mode'
	}

	// Design §10: block and unblock confirmations state their DISTINCT
	// consequences. The same sentence is rendered in the form (no-JS never sees
	// a confirm dialog) and used as the confirm() text when JS is on.
	const CONSEQUENCE: Record<string, string> = {
		block:
			'Blocking stops all acquisition from this source — no polling, no push — and makes every delivery from it ineligible, so its items leave ordinary timelines. Items, subscriptions, federation provenance and audit history stay inspectable. Only an explicit unblock reverses it.',
		unblock:
			'Unblocking returns this source to quarantine, never straight to visibility: acquisition resumes, but its deliveries stay out of ordinary timelines until you allow it in a separate step.'
	}

	// core's V1 AuditCategory enum. core is the gate (it 400s an invalid one);
	// this select is the enum at the UI.
	const CATEGORIES = ['spam', 'abuse', 'illegal_content', 'compromised_source', 'operator_policy', 'other']
</script>

<svelte:head><title>Admin — {data.mode === 'v2' ? 'Sources' : 'Feeds'} — RSC</title></svelte:head>

<h2>{data.mode === 'v2' ? 'Sources' : 'Feeds'}</h2>

{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}
{#if form && 'done' in form && form.done}<p class="notice confirm" role="status">{LABEL[form.done] ?? form.done} applied.</p>{/if}
{#if form && 'established' in form && form.established}<p class="notice confirm" role="status">Federation established — the source is now approved.</p>{/if}

{#if data.mode === 'v2'}
	{#each data.groups as group (group.key)}
		<section>
			<h3>{group.title}</h3>
			<p class="subnav">{group.blurb}</p>
			{#if group.rows.length === 0}
				<p class="subnav">None.</p>
			{:else}
				<ul class="following-list source-list">
					{#each group.rows as row (row.id)}
						<li>
							<div class="feed-info">
								<strong class="feed-url">{row.url}</strong>
								<span>
									<span class="badge-kind">{row.governance}</span>
									<span class="badge-kind">{row.operation}</span>
									{#if row.federationStatus !== 'none'}<span class="badge-kind on">federation {row.federationStatus}</span>{/if}
									<span class="badge-kind">{row.attributionMode.replace('_', ' ')}</span>
								</span>
							</div>
							<details class="panel">
								<summary>Manage</summary>
								<div class="source-actions">
									{#each row.actions as a (a.action)}
										{@const consequence = CONSEQUENCE[a.action]}
										<form
											method="POST"
											action="?/source"
											class="source-action"
											class:destructive={a.action === 'block'}
											use:enhance={consequence ? confirmSubmit(`${consequence} Continue?`) : undefined}
										>
											<input type="hidden" name="sourceId" value={row.id} />
											<input type="hidden" name="action" value={a.action} />
											<input type="hidden" name="commandId" value={a.commandId} />
											<span class="action-name">{LABEL[a.action]}</span>
											{#if consequence}<p class="consequence">{consequence}</p>{/if}
											{#if a.action === 'attribution-mode'}
												<label class="visually-hidden" for="mode-{row.id}">Attribution mode</label>
												<select id="mode-{row.id}" name="attributionMode">
													<option value="single_publisher">single publisher</option>
													<option value="aggregate">aggregate</option>
												</select>
											{/if}
											{#if a.action !== 'pause' && a.action !== 'resume'}
												<label class="visually-hidden" for="cat-{row.id}-{a.action}">Moderation category</label>
												<select id="cat-{row.id}-{a.action}" name="category" required>
													{#each CATEGORIES as c (c)}<option value={c}>{c.replace('_', ' ')}</option>{/each}
												</select>
											{/if}
											<label class="visually-hidden" for="note-{row.id}-{a.action}">Note (optional)</label>
											<input id="note-{row.id}-{a.action}" name="note" placeholder="note (optional)" />
											<button aria-label="{LABEL[a.action]} — {row.url}">{LABEL[a.action]}</button>
										</form>
									{/each}
								</div>
							</details>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/each}

	{#if data.nextCursor}
		<a class="older" href="/admin/feeds?cursor={encodeURIComponent(data.nextCursor)}">More sources</a>
	{/if}

	<details class="panel">
		<summary>Establish federation with a source</summary>
		<form method="POST" action="?/establish" class="add-remote" use:enhance>
			<label class="visually-hidden" for="fed-url">Source URL</label>
			<input id="fed-url" name="url" type="url" placeholder="https://their-site.com/feed.xml" required />
			<label class="visually-hidden" for="fed-mode">Attribution mode</label>
			<select id="fed-mode" name="attributionMode">
				<option value="single_publisher">single publisher</option>
				<option value="aggregate">aggregate</option>
			</select>
			<label class="visually-hidden" for="fed-category">Category</label>
			<select id="fed-category" name="category" required>
				{#each CATEGORIES as c (c)}<option value={c}>{c.replace('_', ' ')}</option>{/each}
			</select>
			<label class="visually-hidden" for="fed-note">Note (optional)</label>
			<input id="fed-note" name="note" placeholder="note (optional)" />
			<input type="hidden" name="commandId" value={data.establishCommandId} />
			<button>Establish federation</button>
		</form>
	</details>
{:else}
	<section>
		<h3>Remote feeds</h3>
		{#if data.feeds.length === 0}
			<p class="subnav">No remote feeds yet.</p>
		{:else}
			<ul class="following-list">
				{#each data.feeds as feed (feed.handle)}
					<li>
						<div class="feed-info">
							<strong>@{feed.handle}</strong>
							<span class="subnav feed-url">{feed.feedUrl ?? 'no feed url'}</span>
						</div>
						<form method="POST" action="?/remove" class="unfollow-form" use:enhance>
							<input type="hidden" name="handle" value={feed.handle} />
							<button aria-label="Remove @{feed.handle}">Remove</button>
						</form>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<details class="panel" open>
		<summary>Add remote feed</summary>
		<form method="POST" action="?/add" class="add-remote" use:enhance>
			<label class="visually-hidden" for="admin-add-handle">Handle</label>
			<input id="admin-add-handle" name="handle" placeholder="handle" required />
			<label class="visually-hidden" for="admin-add-display-name">Display name (optional)</label>
			<input id="admin-add-display-name" name="displayName" placeholder="display name (optional)" />
			<label class="visually-hidden" for="admin-add-feed-url">Feed URL</label>
			<input id="admin-add-feed-url" name="feedUrl" type="url" placeholder="https://their-site.com/feed.xml" required />
			<button>Add feed</button>
		</form>
	</details>
{/if}

<style>
	/* Feed URLs can run long; the shared .following-list row has no wrap
	   handling since its usual content (a handle + kind badge) never needs
	   it — stack + wrap here rather than adding an admin-only case upstream. */
	.feed-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.feed-url {
		overflow-wrap: anywhere;
	}

	/* A source row is a card, not a two-column row: its manage panel is a
	   stack of moderation forms, so the shared .following-list li (flex row,
	   space-between) is turned upright here only. */
	.source-list li {
		flex-direction: column;
		align-items: stretch;
	}

	.source-actions {
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
	}

	.source-action {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-sm);
		padding-top: var(--space-sm);
		border-top: 1px solid var(--color-border);
	}

	.source-action:first-child {
		border-top: none;
	}

	/* Outline, not the accent fill: half a dozen moderation verbs stacked in
	   one panel are all equally weighted, none of them a page CTA. Block reads
	   destructive on top of that, matching .unfollow-form / .danger elsewhere. */
	.source-action button {
		background: transparent;
		color: var(--color-foreground);
		border: 1px solid var(--color-border);
	}

	.source-action.destructive button {
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
</style>
