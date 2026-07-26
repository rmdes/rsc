<script lang="ts">
	import type { PageData, ActionData } from './$types'
	import { enhance } from '$app/forms'
	import { confirmSubmit } from '$lib/confirm'

	let { data, form }: { data: PageData; form: ActionData } = $props()

	// SvelteKit's generated ActionData is a union across all four actions on
	// this page; chaining `in` checks over it doesn't narrow cleanly once the
	// shapes differ this much. The `source`/`establish` fail() branches always
	// echo these fields as plain strings when present — read them through one
	// loose shape instead of fighting the union.
	// ponytail: `as`-cast past the generated union rather than fighting it with
	// per-branch narrowing. Ceiling: a 5th action with a same-named, differently
	// typed field could paper over a real mismatch here. Upgrade path: revisit
	// if this page's action count grows past four.
	type RetryFail = { sourceId?: string; action?: string; commandId?: string; tombstoneId?: string }
	const retryFail = $derived(form as RetryFail | null)
	// Retry id for the establish form specifically (no sourceId/tombstoneId of its
	// own): was a template {@const}, which requires an enclosing block — hoisted
	// here once the page's only {#if} (the dead v1 arm) was deleted.
	const establishRetryCommandId = $derived(retryFail?.commandId && !retryFail.sourceId ? retryFail.commandId : undefined)

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

<svelte:head><title>Admin — Sources — RSC</title></svelte:head>

<h2>Sources</h2>

{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}
{#if form && 'done' in form && form.done}<p class="notice confirm" role="status">{LABEL[form.done] ?? form.done} applied.</p>{/if}
{#if form && 'established' in form && form.established}<p class="notice confirm" role="status">Federation established — the source is now approved.</p>{/if}
{#if form && 'unblocked' in form && form.unblocked}<p class="notice confirm" role="status">Tombstone unblocked — the URL can be created again. Nothing was restored.</p>{/if}

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
							<summary aria-label="Manage {row.url}">Manage</summary>
							<div class="source-actions">
								{#each row.actions as a (a.action)}
									{@const consequence = CONSEQUENCE[a.action]}
									{@const retryCommandId = retryFail?.sourceId === row.id && retryFail?.action === a.action ? retryFail.commandId : undefined}
									<form
										method="POST"
										action="?/source{data.cursor ? `&cursor=${encodeURIComponent(data.cursor)}` : ''}"
										class="source-action"
										class:destructive={a.action === 'block'}
										use:enhance={consequence ? confirmSubmit(`${consequence} Continue?`) : undefined}
									>
										<input type="hidden" name="sourceId" value={row.id} />
										<input type="hidden" name="action" value={a.action} />
										<input type="hidden" name="commandId" value={retryCommandId ?? a.commandId} />
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
	<form method="POST" action="?/establish{data.cursor ? `&cursor=${encodeURIComponent(data.cursor)}` : ''}" class="add-remote" use:enhance>
		<label class="visually-hidden" for="fed-url">Source URL</label>
		<input id="fed-url" name="url" type="url" placeholder="https://their-instance.example/feed.xml" required />
		<label class="visually-hidden" for="fed-note">Note (optional)</label>
		<input id="fed-note" name="note" placeholder="note (optional)" />
		<input type="hidden" name="commandId" value={establishRetryCommandId ?? data.establishCommandId} />
		<button>Establish federation</button>
	</form>
</details>

<section>
	<h3>Blocked and tombstoned URLs</h3>
	<p class="subnav">
		Reserved URLs: a block or purge leaves a tombstone so the URL can't be re-created. Unblocking a tombstone lifts the reservation so the
		URL becomes creatable again — it restores nothing.
	</p>
	{#if data.tombstones.length === 0}
		<p class="subnav">None.</p>
	{:else}
		<ul class="following-list source-list">
			{#each data.tombstones as t (t.id)}
				{@const retryCommandId = retryFail?.tombstoneId === t.id ? retryFail.commandId : undefined}
				<li>
					<div class="feed-info">
						<strong class="feed-url">{t.canonicalUrl}</strong>
						<span>
							<span class="badge-kind">{t.action}</span>
							<span class="badge-kind">{t.category.replace(/_/g, ' ')}</span>
							<span class="subnav">{t.createdAt}</span>
						</span>
						{#if t.aliases.length}<span class="subnav feed-url">aliases: {t.aliases.join(', ')}</span>{/if}
						{#if t.note}<span class="subnav">{t.note}</span>{/if}
					</div>
					<form method="POST" action="?/tombstone{data.cursor ? `&cursor=${encodeURIComponent(data.cursor)}` : ''}" class="source-action" use:enhance={confirmSubmit(`${data.tombstoneConsequence} Continue?`)}>
						<input type="hidden" name="tombstoneId" value={t.id} />
						<input type="hidden" name="commandId" value={retryCommandId ?? t.commandId} />
						<p class="consequence">{data.tombstoneConsequence}</p>
						<label class="visually-hidden" for="tomb-cat-{t.id}">Moderation category</label>
						<select id="tomb-cat-{t.id}" name="category" required>
							{#each data.categories as c (c)}<option value={c}>{c.replace(/_/g, ' ')}</option>{/each}
						</select>
						<label class="visually-hidden" for="tomb-note-{t.id}">Note (optional)</label>
						<input id="tomb-note-{t.id}" name="note" placeholder="note (optional)" />
						<button aria-label="Unblock {t.canonicalUrl}">Unblock URL</button>
					</form>
				</li>
			{/each}
		</ul>
	{/if}
</section>

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
