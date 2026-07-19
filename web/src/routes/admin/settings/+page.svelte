<script lang="ts">
	import { enhance } from '$app/forms'
	import type { PageData, ActionData } from './$types'

	let { data, form }: { data: PageData; form: ActionData } = $props()
</script>

<svelte:head><title>Admin · Settings — Textcaster</title></svelte:head>

<h2>Settings</h2>

{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}
{#if form?.saved}<p class="notice confirm" role="status">Saved.</p>{/if}

<form method="POST" action="?/save" use:enhance>
	<div class="field">
		<label for="max-subs">Max subscriptions per user</label>
		<input id="max-subs" name="maxSubsPerUser" type="number" min="0" required value={data.settings.maxSubsPerUser} />
		<p class="field-hint">Self-serve subscriptions (person + web feeds) each registered user may hold. Default 500.</p>
	</div>
	<button>Save</button>
</form>
