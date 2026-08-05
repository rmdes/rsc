<script lang="ts">
	import type { PageData, ActionData } from './$types'
	import { enhance } from '$app/forms'

	let { data, form }: { data: PageData; form: ActionData } = $props()

	// The hide/restore fail() branches echo { kind, commandId } as plain strings —
	// read them through one loose shape (the generated union across two actions does
	// not narrow cleanly across fail vs. success).
	type ModForm = { done?: string; kind?: string; commandId?: string; error?: string }
	const f = $derived(form as ModForm | null)

	// Command-id retention (design §11): a re-render after a failed submit reuses the
	// SUBMITTED id for THAT form, so a resubmit replays the original command.
	const hideCommandId = $derived(f?.kind === 'hide' && f.commandId ? f.commandId : data.hideCommandId)
	const restoreCommandId = $derived(f?.kind === 'restore' && f.commandId ? f.commandId : data.restoreCommandId)

	const d = $derived(data.detail)
	const STATE_LABEL: Record<string, string> = {
		ordinary: 'ordinary',
		hidden: 'hidden',
		unsupported: 'unsupported',
		structural_tombstone: 'structural tombstone',
		deleted_local: 'deleted (local)'
	}
</script>

<svelte:head><title>Admin — Item review — RSC</title></svelte:head>

<h2>Item review</h2>

{#if f?.error}<p class="error" role="alert">{f.error}</p>{/if}
{#if f?.done}<p class="notice confirm" role="status">{f.done === 'hide' ? 'Item hidden.' : 'Item restored.'}</p>{/if}

<section>
	<div class="feed-info">
		<strong class="feed-url mono">{d.logicalItemId}</strong>
		<span>
			<span class="badge-kind" class:on={d.state === 'hidden'}>{STATE_LABEL[d.state] ?? d.state}</span>
			<span class="badge-kind">{d.origin}</span>
			{#if d.hiddenAt}<span class="badge-kind">hidden {d.hiddenAt}</span>{/if}
		</span>
	</div>
	<dl class="status">
		<div><dt>Selected delivery</dt><dd class="mono">{d.selected.deliveryId ?? '—'}</dd></div>
		<div><dt>Selected publisher</dt><dd class="mono">{d.selected.publisherId ?? '—'}</dd></div>
		<div><dt>Attribution</dt><dd>{d.selected.attributionLevel ?? '—'}</dd></div>
		{#if d.parentLogicalItemId}<div><dt>Parent</dt><dd class="mono">{d.parentLogicalItemId}</dd></div>{/if}
	</dl>
</section>

<!-- Bounded sections: each shows its inline cap alongside the TRUE total from
     counts (core's count, never the capped array length). -->
<section class="panel-block">
	<h3>Deliveries <span class="subnav">showing {d.deliveries.length} of {d.counts.deliveries}</span></h3>
	{#if d.deliveries.length === 0}
		<p class="subnav">None.</p>
	{:else}
		<ul class="plain">
			{#each d.deliveries as delivery (delivery.deliveryId)}
				<li>
					<div class="row-head">
						<span class="mono">{delivery.sourceId}</span>
						<span class="badge-kind" class:on={delivery.eligible}>{delivery.eligible ? 'eligible' : 'ineligible'}</span>
						<span class="subnav">{delivery.keyKind}:{delivery.key}</span>
						<span class="subnav">{delivery.firstSeenAt}</span>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<section class="panel-block">
	<h3>Claims <span class="subnav">showing {d.claims.length} of {d.counts.claims}</span></h3>
	{#if d.claims.length === 0}
		<p class="subnav">None.</p>
	{:else}
		<ul class="plain">
			{#each d.claims as claim (claim.claimId)}
				<li class="row-head">
					<span class="mono">{claim.publisherId}</span>
					<span class="badge-kind">{claim.evidenceLevel}</span>
					<span class="subnav">{claim.firstSeenAt}</span>
					{#if claim.conflictIds.length}<span class="subnav">{claim.conflictIds.length} conflict(s)</span>{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>

<section class="panel-block">
	<h3>Conflicts <span class="subnav">showing {d.conflicts.length} of {d.counts.conflicts}</span></h3>
	{#if d.conflicts.length === 0}
		<p class="subnav">None.</p>
	{:else}
		<ul class="plain">
			{#each d.conflicts as conflict (conflict.conflictId)}
				<li class="version">
					<span class="subnav">{conflict.kind} · {conflict.createdAt}</span>
					<pre class="evidence">{conflict.disputed}</pre>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<!-- One row per verification check; NOTHING renders for an item never scheduled. -->
{#if d.verification.length > 0}
	<section class="panel-block">
		<h3>Origin verification</h3>
		<ul class="plain">
			{#each d.verification as check (check.publisherFeedUrl)}
				<li class="row-head">
					<span class="feed-url">{check.publisherFeedUrl}</span>
					<span class="badge-kind" class:on={check.state === 'verified'}>{check.state}</span>
					<span class="subnav">{check.attempts} attempt(s)</span>
					<span class="subnav">{check.lastCheckedAt ?? 'not yet checked'}</span>
				</li>
			{/each}
		</ul>
	</section>
{/if}

<section class="panel-block">
	<h3>Moderation</h3>
	<div class="source-actions">
		<form method="POST" action="?/hide" class="source-action" use:enhance>
			<input type="hidden" name="itemId" value={d.logicalItemId} />
			<input type="hidden" name="commandId" value={hideCommandId} />
			<span class="action-name">Hide</span>
			<p class="consequence">Hiding keeps every delivery and its evidence inspectable but drops this item from ordinary timelines.</p>
			<label class="visually-hidden" for="hide-cat">Moderation category</label>
			<select id="hide-cat" name="category" required>
				{#each data.categories as c (c)}<option value={c}>{c.replace(/_/g, ' ')}</option>{/each}
			</select>
			<label class="visually-hidden" for="hide-note">Note (optional)</label>
			<input id="hide-note" name="note" placeholder="note (optional)" />
			<button aria-label="Hide item {d.logicalItemId}">Hide</button>
		</form>
		<form method="POST" action="?/restore" class="source-action" use:enhance>
			<input type="hidden" name="itemId" value={d.logicalItemId} />
			<input type="hidden" name="commandId" value={restoreCommandId} />
			<span class="action-name">Restore</span>
			<p class="consequence">Restoring returns a previously hidden item to ordinary timelines; it changes nothing about its deliveries or evidence.</p>
			<label class="visually-hidden" for="restore-cat">Moderation category</label>
			<select id="restore-cat" name="category" required>
				{#each data.categories as c (c)}<option value={c}>{c.replace(/_/g, ' ')}</option>{/each}
			</select>
			<label class="visually-hidden" for="restore-note">Note (optional)</label>
			<input id="restore-note" name="note" placeholder="note (optional)" />
			<button aria-label="Restore item {d.logicalItemId}">Restore</button>
		</form>
	</div>
</section>

<section class="panel-block">
	<h3>Audit <span class="subnav">showing {data.audit.length} of {d.counts.audit}</span></h3>
	{#if data.audit.length === 0}
		<p class="subnav">No audit events.</p>
	{:else}
		<ul class="plain">
			{#each data.audit as event (event.id)}
				<li class="row-head">
					<span class="action-name">{event.action}</span>
					{#if event.category}<span class="badge-kind">{event.category.replace(/_/g, ' ')}</span>{/if}
					<span class="subnav">{event.createdAt}</span>
					{#if event.note}<span class="subnav">{event.note}</span>{/if}
				</li>
			{/each}
		</ul>
	{/if}
	{#if data.auditNextCursor}
		<a class="older" href="/admin/items/{encodeURIComponent(data.id)}?before={encodeURIComponent(data.auditNextCursor)}">Older audit</a>
	{/if}
</section>

<style>
	.feed-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.feed-url {
		overflow-wrap: anywhere;
	}
	.panel-block {
		padding-top: var(--space-md);
		margin-top: var(--space-md);
		border-top: 1px solid var(--color-border);
	}
	.panel-block h3 {
		display: flex;
		align-items: baseline;
		gap: var(--space-sm);
		flex-wrap: wrap;
	}
	.status {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
		margin: var(--space-sm) 0 0;
	}
	.status div {
		display: flex;
		gap: var(--space-sm);
		flex-wrap: wrap;
	}
	.status dt {
		flex: 0 0 9rem;
		color: var(--color-secondary);
		font-weight: 600;
	}
	.status dd {
		margin: 0;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.plain {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
	}
	.row-head {
		display: flex;
		gap: var(--space-sm);
		flex-wrap: wrap;
		align-items: baseline;
	}
	.version {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
		margin-top: var(--space-xs);
	}
	.evidence {
		margin: 0;
		padding: var(--space-sm);
		background: var(--color-muted);
		border: 1px solid var(--color-border);
		border-radius: var(--radius);
		font-family: var(--font-mono, monospace);
		font-size: 0.8125rem;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		max-height: 16rem;
		overflow-y: auto;
	}
	.mono {
		font-family: var(--font-mono, monospace);
		font-size: 0.8125rem;
		overflow-wrap: anywhere;
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
	.source-action button {
		background: transparent;
		color: var(--color-foreground);
		border: 1px solid var(--color-border);
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
