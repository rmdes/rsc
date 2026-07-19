<script lang="ts">
	import type { PageData, ActionData } from './$types'
	import ThemeToggle from '$lib/ThemeToggle.svelte'

	let { data, form }: { data: PageData; form: ActionData } = $props()
</script>

<svelte:head><title>Settings — Textcaster</title></svelte:head>

<div class="lens">
	<header class="masthead">
		<a href="/">Textcaster</a>
		<ThemeToggle />
	</header>

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

	<p class="field-hint"><a href="/accounts">Manage accounts on this browser →</a></p>
</div>
