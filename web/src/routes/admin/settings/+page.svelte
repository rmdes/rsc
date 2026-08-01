<script lang="ts">
	import { enhance } from '$app/forms'
	import { TABS, TAB_LABELS, TAB_SUBTITLES } from '$lib/tabs'
	import type { PageData, ActionData } from './$types'

	let { data, form }: { data: PageData; form: ActionData } = $props()
</script>

<svelte:head><title>Admin · Settings — RSC</title></svelte:head>

<h2>Settings</h2>

{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}
{#if form?.saved}<p class="notice confirm" role="status">Saved.</p>{/if}

<form method="POST" action="?/save" use:enhance>
	<div class="field">
		<label for="max-subs">Max subscriptions per user</label>
		<input id="max-subs" name="maxSubsPerUser" type="number" min="0" required value={data.settings.maxSubsPerUser} />
		<p class="field-hint">Self-serve subscriptions (person + web feeds) each registered user may hold. Default 500. 0 disables subscribing entirely.</p>
	</div>
	<div class="field">
		<label for="max-remote-items">Max remote items per source</label>
		<input id="max-remote-items" name="maxRemoteItemsPerSource" type="number" min="0" required value={data.settings.maxRemoteItemsPerSource} />
		<p class="field-hint">Keeps only the N most recent items from each remote source, trimming older ones after each poll. 0 means unlimited (default) — local posts are never affected.</p>
	</div>
	<div class="field">
		<label for="max-remote-age">Max remote item age (days)</label>
		<input id="max-remote-age" name="maxRemoteItemAgeDays" type="number" min="0" required value={data.settings.maxRemoteItemAgeDays} />
		<p class="field-hint">Trims remote items older than this many days after each poll. 0 means unlimited (default) — local posts are never affected.</p>
	</div>
	<h3>Timeline tabs</h3>
	<p class="field-hint">Override the label and subtitle shown on each home-timeline tab. Leave a field blank to use the default (shown as placeholder).</p>
	{#each TABS as key (key)}
		<div class="field">
			<label for="tab-label-{key}">{key} tab — label</label>
			<input
				id="tab-label-{key}"
				name="tab_label_{key}"
				maxlength="24"
				value={data.settings.tabLabels[key] ?? ''}
				placeholder={TAB_LABELS[key]}
			/>
		</div>
		<div class="field">
			<label for="tab-subtitle-{key}">{key} tab — subtitle</label>
			<input
				id="tab-subtitle-{key}"
				name="tab_subtitle_{key}"
				maxlength="120"
				value={data.settings.tabSubtitles[key] ?? ''}
				placeholder={TAB_SUBTITLES[key]}
			/>
		</div>
	{/each}
	<button>Save</button>
</form>

<style>
	form {
		max-width: 24rem;
	}
</style>
