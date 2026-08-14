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

<!-- reset:false — default enhance resets the form on success, which blanks the
     uncontrolled inputs; Svelte then only re-populates fields whose value changed,
     leaving unedited fields empty (and a re-save would submit them as 0). -->
<form method="POST" action="?/save" use:enhance={() => async ({ update }) => update({ reset: false })}>
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
	<div class="field">
		<label for="feed-item-limit">Items per feed</label>
		<input id="feed-item-limit" name="feedItemLimit" type="number" min="1" required value={data.settings.feedItemLimit} />
		<p class="field-hint">How many items each RSS/JSON feed renders. Default 50.</p>
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

<!-- Same "labelled section under a 2px rule" convention settings/+page.svelte
     uses for its own "More" section (API keys, manage accounts) — /admin/
     api-keys has no natural row context to link from (unlike admin/sources
     or admin/items, which hang off admin/feeds' row expansion), so it gets
     the same standalone-destination treatment here. -->
<nav class="settings-more" aria-label="More admin settings">
	<h3 class="label">More</h3>
	<ul>
		<li>
			<a href="/admin/api-keys">API keys</a>
			<p class="field-hint">Mint admin-tier keys for scripts managing this instance via <code>/admin-api/*</code>.</p>
		</li>
	</ul>
</nav>

<style>
	form {
		max-width: 24rem;
	}

	.settings-more {
		margin-top: var(--space-xl);
		border-top: 2px solid var(--color-divider);
		padding-top: var(--space-md);
	}
	.settings-more h3 {
		margin: 0 0 var(--space-3);
	}
	.settings-more ul {
		margin: 0;
		padding: 0;
		list-style: none;
		display: grid;
		gap: var(--space-md);
	}
	.settings-more li > a {
		display: inline-block;
		padding: var(--space-xs) 0;
	}
</style>
