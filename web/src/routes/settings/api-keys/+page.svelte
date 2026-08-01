<script lang="ts">
	import type { PageData, ActionData } from './$types'
	import { enhance } from '$app/forms'
	import { PERMISSION_OPTIONS } from './permissions.ts'

	let { data, form }: { data: PageData; form: ActionData } = $props()

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
	}

	function permissionText(permissions: Record<string, string[]> | null): string {
		if (!permissions) return '—'
		const parts = Object.entries(permissions).flatMap(([resource, actions]) => actions.map((a) => `${resource}:${a}`))
		return parts.length ? parts.join(', ') : '—'
	}
</script>

<svelte:head><title>API keys — Settings — RSC</title></svelte:head>

<div class="lens">
	<h1>API keys</h1>
	<p class="field-hint">
		Personal keys for scripts and tools to read your own timeline and posts. Each key is shown in full exactly once, right
		after you create it.
	</p>

	{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}

	{#if form?.createdKey}
		<p class="notice confirm" role="status">
			<strong>{form.createdName ?? 'New key'}</strong> created. Copy it now — it won't be shown again:
			<br />
			<code class="key-value">{form.createdKey}</code>
		</p>
	{/if}

	{#if data.keys.length === 0}
		<p class="subnav">No API keys yet.</p>
	{:else}
		<ul class="following-list">
			{#each data.keys as key (key.id)}
				<li>
					<div class="key-row">
						<span class="key-name">{key.name ?? '(unnamed)'}</span>
						<span class="field-hint">{key.start ?? 'rsc_'}… · created {formatDate(key.createdAt)} · {permissionText(key.permissions)}</span>
					</div>
					<form method="POST" action="?/revoke" class="unfollow-form" use:enhance>
						<input type="hidden" name="id" value={key.id} />
						<details class="confirm-gate">
							<summary><span class="action-name">Revoke</span></summary>
							<p class="consequence">Revoke "{key.name ?? '(unnamed)'}"? Anything using it will stop working immediately.</p>
							<button type="submit" aria-label="Confirm revoke — {key.name ?? '(unnamed)'}">Confirm revoke</button>
						</details>
					</form>
				</li>
			{/each}
		</ul>
	{/if}

	<h2>Create a new key</h2>
	<form method="POST" action="?/create" class="auth-form" use:enhance>
		<div class="field">
			<label for="api-key-name">Name</label>
			<input id="api-key-name" name="name" placeholder="e.g. my reading script" maxlength="32" required />
			<p class="field-hint" id="api-key-name-hint">Helps you tell keys apart later — not shown to anyone else.</p>
		</div>
		<fieldset class="permissions-field">
			<legend>Permissions</legend>
			{#each PERMISSION_OPTIONS as opt (opt.formKey)}
				<label class="permission-option">
					<input type="checkbox" name={opt.formKey} />
					{opt.label}
				</label>
			{/each}
		</fieldset>
		<button>Create key</button>
	</form>

	<p class="field-hint"><a href="/settings">Back to Settings</a></p>
</div>

<style>
	/* One monospace, muted-background token for the one-time plaintext key
	   display — mirrors .post .body code's inline-code treatment (app.css),
	   which is scoped to markdown rendering and unusable here as-is. */
	.key-value {
		display: inline-block;
		margin-top: var(--space-xs);
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.9em;
		background: var(--color-muted);
		padding: 2px 6px;
		border-radius: var(--radius);
		overflow-wrap: anywhere;
	}

	/* A key row is name + metadata stacked above its own revoke form — same
	   "card is a column, not a two-column row" shape as admin/feeds' source
	   rows, needed here because .following-list li is otherwise a flex row
	   with no room for a form beneath the label. */
	.following-list li {
		flex-direction: column;
		align-items: stretch;
		gap: var(--space-xs);
	}

	.key-row {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.key-name {
		font-weight: 600;
	}

	fieldset.permissions-field {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
		border: 1px solid var(--color-divider);
		border-radius: var(--radius);
		padding: var(--space-sm) var(--space-md);
		margin: 0;
	}

	fieldset.permissions-field legend {
		font-size: 0.75rem;
		color: var(--color-secondary);
		padding: 0 var(--space-xs);
	}

	.permission-option {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		font-size: 0.875rem;
	}

	/* Duplicated verbatim in every page that owns .confirm-gate (see
	   admin/feeds/+page.svelte's comment on the same rule) — .action-name /
	   .consequence / the disclosure glyph are house primitives, not a
	   shared stylesheet import. */
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
