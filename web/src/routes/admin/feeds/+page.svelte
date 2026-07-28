<script lang="ts">
	import type { PageData, ActionData } from './$types'
	import { enhance } from '$app/forms'
	import { confirmSubmit } from '$lib/confirm'

	let { data, form }: { data: PageData; form: ActionData } = $props()

	// SvelteKit's generated ActionData is a union across all three actions on
	// this page; chaining `in` checks over it doesn't narrow cleanly once the
	// shapes differ this much. The `source`/`establish` fail() branches always
	// echo these fields as plain strings when present — read them through one
	// loose shape instead of fighting the union.
	// ponytail: `as`-cast past the generated union rather than fighting it with
	// per-branch narrowing. Ceiling: a 4th action with a same-named, differently
	// typed field could paper over a real mismatch here. Upgrade path: revisit
	// if this page's action count grows past three.
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

	// Shared by every row's Manage panel, ordinary or nested member (C1 fix):
	// a member row's `actions` is computed by the SAME toRow() as an ordinary
	// row, so the panel — and the forms it renders — are identical, not a
	// re-derivation.
	type Row = PageData['expandedMembers'][number]
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
					{@const expanded = data.expand === row.id}
					<li>
						<div class="feed-info">
							<strong class="feed-url">{row.url}</strong>
							<span>
								<span class="badge-kind">{row.governance}</span>
								<span class="badge-kind">{row.operation}</span>
								{#if row.federationStatus !== 'none'}<span class="badge-kind on">federation {row.federationStatus}</span>{/if}
								<span class="badge-kind">{row.attributionMode.replace('_', ' ')}</span>
								{#if row.overridden}<span class="badge-kind on">overridden</span>{/if}
							</span>
							<!-- A moderated member no longer tracks its instance's governance
							     (the overridden bit, Task 1); this hint marks WHERE a flatly-shown
							     row came from — verification, not subscribe/OPML/admin — a nested
							     member never reaches here at all (Task 6 exclusion). -->
							{#if row.viaVerification}<p class="subnav hint">via verification</p>{/if}
							<p class="subnav"><a href="/admin/sources/{encodeURIComponent(row.id)}">Details (run history, items, purge)</a></p>
						</div>
						{#if row.group === 'federation' && row.memberCounts}
							{@const qs = [expanded ? '' : `expand=${row.id}`, data.cursor ? `cursor=${encodeURIComponent(data.cursor)}` : ''].filter(Boolean).join('&')}
							<p class="subnav member-rollup">
								{row.memberCounts.members} member{row.memberCounts.members === 1 ? '' : 's'} ·
								{row.memberCounts.overridden} overridden ·
								{row.memberCounts.instanceGoverned} instance-governed
								{#if row.memberCounts.members > 0}
									<a href="/admin/feeds{qs ? `?${qs}` : ''}">{expanded ? 'Hide members' : 'Show members'}</a>
								{/if}
							</p>
							{#if expanded}
								<ul class="following-list source-list member-list">
									{#each data.expandedMembers as m (m.id)}
										<li>
											<div class="feed-info">
												<strong class="feed-url">{m.url}</strong>
												<span>
													<span class="badge-kind">{m.governance}</span>
													<span class="badge-kind">{m.operation}</span>
													{#if m.overridden}<span class="badge-kind on">overridden</span>{/if}
												</span>
												{#if m.viaVerification}<p class="subnav hint">via verification</p>{/if}
												<p class="subnav"><a href="/admin/sources/{encodeURIComponent(m.id)}">Details (run history, items, purge)</a></p>
											</div>
											{@render managePanel(m, 'm-')}
										</li>
									{/each}
								</ul>
							{/if}
						{/if}
						{@render managePanel(row)}
					</li>
				{/each}
			</ul>
		{/if}
	</section>
{/each}

<!-- C1 fix: the Manage panel is shared verbatim between an ordinary row and
     a nested member row — both carry the same `actions` shape from toRow(),
     so a member is moderated through the exact same forms, not a separate
     read-only view. `expand` is carried forward alongside `cursor` so acting
     on a member doesn't collapse its instance's expansion.
     N1 fix: a blocked member renders twice (flat + nested in expanded instance),
     so we add a scope discriminator to prevent duplicate DOM ids. -->
{#snippet managePanel(row: Row, scope = '')}
	{@const qs = [data.cursor ? `cursor=${encodeURIComponent(data.cursor)}` : '', data.expand ? `expand=${encodeURIComponent(data.expand)}` : ''].filter(Boolean).join('&')}
	<details class="panel">
		<summary aria-label="Manage {row.url}">Manage</summary>
		<div class="source-actions">
			{#each row.actions as a (a.action)}
				{@const consequence = CONSEQUENCE[a.action]}
				{@const retryCommandId = retryFail?.sourceId === row.id && retryFail?.action === a.action ? retryFail.commandId : undefined}
				<form
					method="POST"
					action="?/source{qs ? `&${qs}` : ''}"
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
						<label class="visually-hidden" for="mode-{scope}{row.id}">Attribution mode</label>
						<select id="mode-{scope}{row.id}" name="attributionMode">
							<option value="single_publisher">single publisher</option>
							<option value="aggregate">aggregate</option>
						</select>
					{/if}
					{#if a.action !== 'pause' && a.action !== 'resume'}
						<label class="visually-hidden" for="cat-{scope}{row.id}-{a.action}">Moderation category</label>
						<select id="cat-{scope}{row.id}-{a.action}" name="category" required>
							{#each CATEGORIES as c (c)}<option value={c}>{c.replace('_', ' ')}</option>{/each}
						</select>
					{/if}
					<label class="visually-hidden" for="note-{scope}{row.id}-{a.action}">Note (optional)</label>
					<input id="note-{scope}{row.id}-{a.action}" name="note" placeholder="note (optional)" />
					<button aria-label="{LABEL[a.action]} — {row.url}">{LABEL[a.action]}</button>
				</form>
			{/each}
		</div>
	</details>
{/snippet}

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

	/* The hint carries no new meaning of its own (it's a provenance footnote,
	   not a warning or a call to action) — same secondary/small treatment as
	   .consequence rather than a new color. */
	.hint {
		margin: 0;
		color: var(--color-secondary);
		font-size: 0.8125rem;
	}

	.member-rollup {
		margin: 0;
	}

	/* Nested members read as a sub-list of their instance: indented and
	   rail-marked with the existing border token, not a new component. */
	.member-list {
		margin: var(--space-sm) 0 0 var(--space-lg);
		border-left: 2px solid var(--color-border);
		padding-left: var(--space-sm);
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
