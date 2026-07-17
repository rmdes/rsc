<script lang="ts">
	import type { PageData, ActionData } from './$types'
	import ThemeToggle from '$lib/ThemeToggle.svelte'

	let { data, form }: { data: PageData; form: ActionData } = $props()
</script>

<svelte:head><title>Reset password — Textcaster</title></svelte:head>

<div class="lens">
	<header class="masthead">
		<a href="/">Textcaster</a>
		<ThemeToggle />
	</header>

	<h1>Reset password</h1>

	{#if !data.mailEnabled}
		<p class="notice">Email accounts are not available on this instance — post as a guest instead.</p>
	{:else if !data.token}
		<p class="error" role="alert">This reset link is missing its token — request a new one.</p>
		<p class="auth-note"><a href="/forgot">Request a reset link</a>.</p>
	{:else}
		{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}

		<form method="POST" action="?/reset" class="auth-form">
			<input type="hidden" name="token" value={data.token} />
			<label class="visually-hidden" for="reset-password">New password</label>
			<input id="reset-password" name="newPassword" type="password" placeholder="new password (min. 8 characters)" autocomplete="new-password" minlength="8" required />
			<button>Reset password</button>
		</form>
	{/if}
</div>
