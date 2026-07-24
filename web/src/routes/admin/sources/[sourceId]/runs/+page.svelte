<script lang="ts">
	import type { PageData } from './$types'

	let { data }: { data: PageData } = $props()

	const sid = $derived(encodeURIComponent(data.sourceId))

	// A run row links to itself with ?run=<id> to open its job summaries below.
	const runHref = (runId: string) => `/admin/sources/${sid}/runs?run=${encodeURIComponent(runId)}`
</script>

<svelte:head><title>Admin — Run history — RSC</title></svelte:head>

<h2>Run history</h2>
<p class="subnav"><a href="/admin/sources/{sid}">← Source acquisition</a></p>

<section>
	{#if data.runs.length === 0}
		<p class="subnav">No acquisition runs yet.</p>
	{:else}
		<ul class="following-list run-list">
			{#each data.runs as run (run.runId)}
				<li>
					<div class="feed-info">
						<a class="mono" href={runHref(run.runId)}>{run.runId}</a>
						<span>
							<span class="badge-kind" class:on={run.status === 'processing'}>{run.status}</span>
							<span class="badge-kind">{run.fetch.outcome.replace(/_/g, ' ')}</span>
							<span class="subnav">{run.reconciliation.reconciled} reconciled · {run.reconciliation.conflicted} conflicted · {run.reconciliation.failed} failed</span>
						</span>
					</div>
				</li>
			{/each}
		</ul>
	{/if}

	{#if data.nextCursor}
		<a class="older" href="/admin/sources/{sid}/runs?before={encodeURIComponent(data.nextCursor)}">Older runs</a>
	{/if}
</section>

{#if data.selectedRun && data.jobs}
	<section class="panel-block">
		<h3>Jobs — <span class="mono">{data.selectedRun}</span></h3>
		{#if data.jobs.length === 0}
			<p class="subnav">No reconciliation jobs for this run.</p>
		{:else}
			<ul class="following-list job-list">
				{#each data.jobs as job (job.jobId)}
					<li>
						<div class="feed-info">
							<span class="mono">{job.jobId}</span>
							<span>
								<span class="badge-kind" class:on={job.status === 'processing' || job.status === 'retrying'}>{job.status}</span>
								<span class="subnav">attempt {job.attempts}{job.nextAttemptAt ? ` · next ${job.nextAttemptAt}` : ''}{job.failureCategory ? ` · ${job.failureCategory.replace(/_/g, ' ')}` : ''}</span>
							</span>
							{#if job.diagnostic}<span class="subnav diag">{job.diagnostic}</span>{/if}
						</div>
					</li>
				{/each}
			</ul>
		{/if}

		{#if data.jobsNextCursor}
			<a class="older" href="/admin/sources/{sid}/runs?run={encodeURIComponent(data.selectedRun)}&jobsBefore={encodeURIComponent(data.jobsNextCursor)}">Older jobs</a>
		{/if}
	</section>
{/if}

<style>
	.feed-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.run-list li,
	.job-list li {
		flex-direction: column;
		align-items: stretch;
	}
	.panel-block {
		padding-top: var(--space-md);
		margin-top: var(--space-md);
		border-top: 1px solid var(--color-border);
	}
	.mono {
		font-family: var(--font-mono, monospace);
		font-size: 0.8125rem;
		overflow-wrap: anywhere;
	}
	.diag {
		overflow-wrap: anywhere;
	}
</style>
