<script lang="ts">
	import type { PageData, ActionData } from './$types'

	let { data, form }: { data: PageData; form: ActionData } = $props()
</script>

<svelte:head><title>Settings — RSC</title></svelte:head>

<div class="lens">
	<h1>Settings</h1>

	{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}

	<form method="POST" action="?/save" class="auth-form">
		<div class="field">
			<label for="settings-handle">Username</label>
			<input
				id="settings-handle"
				name="handle"
				placeholder="handle"
				value={data.me?.user.handle ?? ''}
				aria-describedby="settings-handle-hint"
			/>
			<p class="field-hint" id="settings-handle-hint">
				Your unique @name in timelines, links, and feeds. Lowercase; changing it updates your addresses.
			</p>
		</div>
		<div class="field">
			<label for="settings-display-name">Display name</label>
			<input
				id="settings-display-name"
				name="displayName"
				placeholder="display name"
				value={data.me?.user.displayName ?? ''}
				aria-describedby="settings-display-name-hint"
			/>
			<p class="field-hint" id="settings-display-name-hint">Shown next to your posts. Anything you like.</p>
		</div>
		<button>Save</button>
	</form>

	<!-- These were two `field-hint` paragraphs — the style that describes a form
	     input, tied to one via aria-describedby everywhere else on this page.
	     Standalone destinations wearing help-text weight read as fine print, so
	     API keys went unfound. Promoted to a labelled section under a 2px rule,
	     the same section convention MASTER.md uses elsewhere. -->
	<nav class="settings-more" aria-label="More settings">
		<h2 class="label">More</h2>
		<ul>
			<li>
				<a href="/settings/api-keys">API keys</a>
				<p class="field-hint">Programmatic access to your timeline and posts.</p>
			</li>
			<li>
				<a href="/accounts">Manage accounts on this browser</a>
				<p class="field-hint">Switch between accounts signed in here.</p>
			</li>
		</ul>
	</nav>
</div>

<style>
	.settings-more {
		margin-top: var(--space-xl);
		border-top: 2px solid var(--color-divider);
		padding-top: var(--space-md);
	}
	.settings-more h2 {
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
