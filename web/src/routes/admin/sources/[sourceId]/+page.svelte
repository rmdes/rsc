<script lang="ts">
	import type { PageData, ActionData } from './$types'
	import { enhance } from '$app/forms'
	import type { AdminRefreshResult, AdminRunProjection } from '$lib/logical-api'

	let { data, form }: { data: PageData; form: ActionData } = $props()

	// The refresh action returns one of three success shapes or a fail() — read them
	// through one loose shape (the generated ActionData union doesn't narrow cleanly
	// across fail vs. success). Every branch carries commandId so a retry replays.
	type RefreshForm = { commandId?: string; refused?: boolean; polling?: boolean; run?: AdminRefreshResult; error?: string }
	const f = $derived(form as RefreshForm | null)

	// Command-id retention (spec §6.2): a re-render after a still-processing (202),
	// refused, or errored submit reuses the SUBMITTED id, so a resubmit replays the
	// original run instead of minting a fresh command.
	const commandId = $derived(f?.commandId ?? data.refreshCommandId)

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
	}
</style>
