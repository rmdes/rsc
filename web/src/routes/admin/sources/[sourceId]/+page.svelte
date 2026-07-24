<script lang="ts">
	import type { PageData, ActionData } from './$types'
	import { enhance } from '$app/forms'
	import { confirmSubmit } from '$lib/confirm'
	import type { AdminRefreshResult, AdminRunProjection } from '$lib/logical-api'

	let { data, form }: { data: PageData; form: ActionData } = $props()

	// The refresh + purge actions return one of several success shapes or a fail() —
	// read them through one loose shape (the generated ActionData union doesn't narrow
	// cleanly across fail vs. success). Every branch carries commandId so a retry
	// replays; `purge`/`purged` tag the purge branches so the right form is pinned.
	type SourceForm = { commandId?: string; refused?: boolean; polling?: boolean; run?: AdminRefreshResult; error?: string; purge?: boolean; purged?: boolean }
	const f = $derived(form as SourceForm | null)

	// Command-id retention (spec §6.2): a re-render after a still-processing (202),
	// refused, or errored submit reuses the SUBMITTED id, so a resubmit replays the
	// original run instead of minting a fresh command. The purge form pins its own id.
	const commandId = $derived((f?.purge || f?.purged) ? data.refreshCommandId : (f?.commandId ?? data.refreshCommandId))
	const purgeCommandId = $derived((f?.purge || f?.purged) && f.commandId ? f.commandId : data.purgeCommandId)

	const OUTCOME_LABEL: Record<string, string> = {
		pending: 'pending',
		not_modified: 'not modified',
		parsed: 'parsed',
		completed_truncated: 'completed (truncated)',
		redirect_conflict: 'redirect conflict',
		operational_failure: 'operational failure',
		cancelled: 'cancelled',
		superseded: 'superseded',
		policy_rejected: 'policy rejected'
	}

	// The panel shows only bounded counters — never raw evidence, deliveries, or
	// review links (Vertical 3 owns evidence review).
	const runOf = $derived((f?.run ?? data.latestRun) as AdminRunProjection | AdminRefreshResult | null)
</script>

<svelte:head><title>Admin — Source acquisition — RSC</title></svelte:head>

<h2>Source acquisition</h2>

<section>
	<div class="feed-info">
		<strong class="feed-url">{data.source.canonicalUrl}</strong>
		<span>
			<span class="badge-kind">{data.source.governance}</span>
			<span class="badge-kind">{data.source.operation}</span>
			<span class="badge-kind">{data.source.attributionMode.replace('_', ' ')}</span>
		</span>
	</div>
</section>

{#if f?.error}<p class="error" role="alert">{f.error}</p>{/if}
{#if f?.refused}
	<!-- Neutral refusal (spec §6.2): a paused/blocked/unknown source refuses without
	     leaking which state caused it. No evidence, no run. -->
	<p class="notice" role="status">This source can’t be refreshed right now.</p>
{/if}
{#if f?.run && !f.polling}
	<p class="notice confirm" role="status">Refresh {f.run.disposition} — the run reached terminal status.</p>
{/if}
{#if f?.run && f.polling}
	<!-- 202: still processing. The poll affordance is a resubmit of the SAME command
	     (replays, returning the run's current status) plus a link to full history. -->
	<p class="notice" role="status">Still processing — check again in a moment.</p>
{/if}
{#if f?.purged}
	<p class="notice confirm" role="status">Evidence purged — permanently deleted. The URL stays blocked by its tombstone.</p>
{/if}

<section class="panel-block">
	<h3>Refresh</h3>
	<form method="POST" action="?/refresh" class="refresh-form" use:enhance>
		<input type="hidden" name="sourceId" value={data.sourceId} />
		<input type="hidden" name="commandId" value={commandId} />
		<button aria-label="Refresh acquisition for {data.source.canonicalUrl}">
			{f?.polling ? 'Check status' : 'Refresh now'}
		</button>
	</form>
</section>

<section class="panel-block">
	<h3>Status</h3>
	{#if runOf}
		<dl class="status">
			<div><dt>Latest run</dt><dd class="mono">{runOf.runId}</dd></div>
			<div><dt>Run status</dt><dd><span class="badge-kind" class:on={runOf.status === 'processing'}>{runOf.status}</span></dd></div>
			<div><dt>Fetch outcome</dt><dd>{OUTCOME_LABEL[runOf.fetch.outcome] ?? runOf.fetch.outcome}</dd></div>
			{#if runOf.fetch.diagnostic}<div><dt>Diagnostic</dt><dd>{runOf.fetch.diagnostic}</dd></div>{/if}
			<div><dt>Nonterminal runs</dt><dd>{data.nonterminalCount}</dd></div>
			<div>
				<dt>Acquisition</dt>
				<dd>{runOf.acquisition.observed} observed · {runOf.acquisition.unchanged} unchanged · {runOf.acquisition.skipped} skipped{runOf.acquisition.itemsTruncated ? ' · truncated' : ''}</dd>
			</div>
			<div>
				<dt>Reconciliation</dt>
				<dd>{runOf.reconciliation.reconciled} reconciled · {runOf.reconciliation.conflicted} conflicted · {runOf.reconciliation.pending + runOf.reconciliation.processing + runOf.reconciliation.retrying} open · {runOf.reconciliation.failed} failed</dd>
			</div>
		</dl>
	{:else}
		<p class="subnav">No acquisition runs yet.</p>
	{/if}
	<a class="older" href="/admin/sources/{encodeURIComponent(data.sourceId)}/runs">Run history</a>
</section>

<section class="panel-block">
	<h3>Items <span class="subnav">{data.conflictCount} conflict(s) across this source</span></h3>
	{#if data.items.length === 0}
		<p class="subnav">No items acquired from this source yet.</p>
	{:else}
		<ul class="item-list">
			{#each data.items as item (item.logicalItemId)}
				<li>
					<a class="mono" href="/admin/items/{encodeURIComponent(item.logicalItemId)}">{item.logicalItemId}</a>
					<span class="badge-kind" class:on={item.state === 'hidden'}>{item.state.replace(/_/g, ' ')}</span>
					<span class="subnav">{item.timelineSortAt}</span>
				</li>
			{/each}
		</ul>
		{#if data.itemsNextCursor}
			<a class="older" href="/admin/sources/{encodeURIComponent(data.sourceId)}?before={encodeURIComponent(data.itemsNextCursor)}">Older items</a>
		{/if}
	{/if}
</section>

{#if data.purgeEligible}
	<!-- Purge appears for a BLOCKED source ALONE. Its consequence is DISTINCT from
	     unblock: evidence is permanently deleted, but the URL STAYS blocked. -->
	<section class="panel-block">
		<h3>Purge evidence</h3>
		<form method="POST" action="?/purge" class="source-action destructive" use:enhance={confirmSubmit(`${data.purgeConsequence} Continue?`)}>
			<input type="hidden" name="sourceId" value={data.sourceId} />
			<input type="hidden" name="commandId" value={purgeCommandId} />
			<p class="consequence">{data.purgeConsequence}</p>
			<label class="visually-hidden" for="purge-cat">Moderation category</label>
			<select id="purge-cat" name="category" required>
				{#each data.categories as c (c)}<option value={c}>{c.replace(/_/g, ' ')}</option>{/each}
			</select>
			<label class="visually-hidden" for="purge-note">Note (optional)</label>
			<input id="purge-note" name="note" placeholder="note (optional)" />
			<button aria-label="Purge evidence for {data.source.canonicalUrl}">Purge evidence</button>
		</form>
	</section>
{/if}

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
	.refresh-form button {
		background: transparent;
		color: var(--color-foreground);
		border: 1px solid var(--color-border);
	}
	.status {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		margin: 0 0 var(--space-md);
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
	.mono {
		font-family: var(--font-mono, monospace);
		font-size: 0.8125rem;
		overflow-wrap: anywhere;
	}
	.item-list {
		list-style: none;
		padding: 0;
		margin: 0 0 var(--space-sm);
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
	}
	.item-list li {
		display: flex;
		gap: var(--space-sm);
		flex-wrap: wrap;
		align-items: baseline;
	}
	/* Outline, not the accent fill — matches the moderation forms elsewhere; purge
	   reads destructive on top of that. */
	.source-action {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-sm);
	}
	.source-action button {
		background: transparent;
		color: var(--color-foreground);
		border: 1px solid var(--color-border);
	}
	.source-action.destructive button {
		color: var(--color-destructive);
	}
	.consequence {
		margin: 0;
		color: var(--color-secondary);
		font-size: 0.8125rem;
	}
</style>
