<script lang="ts">
	import type { PageData, ActionData } from './$types'
	import ThemeToggle from '$lib/ThemeToggle.svelte'

	let { data, form }: { data: PageData; form: ActionData } = $props()
</script>

<svelte:head><title>Forgot password — Textcaster</title></svelte:head>

<div class="lens">
	<header class="masthead">
		<a href="/">Textcaster</a>
		<ThemeToggle />
	</header>

	<h1>Forgot password</h1>

	{#if form?.sent}
		<p class="notice">If that email exists, we sent a reset link.</p>
	{:else if !data.mailEnabled}
		<p class="notice">Email accounts are not available on this instance — post as a guest instead.</p>
	{:else}
		<p class="auth-note">Enter your email and we'll send a link to reset your password.</p>

		<form method="POST" action="?/forgot" class="auth-form">
			<label class="visually-hidden" for="forgot-email">Email</label>
			<input id="forgot-email" name="email" type="email" placeholder="email" autocomplete="email" required />
			<button>Send reset link</button>
		</form>
	{/if}

	<p class="auth-note"><a href="/login">Back to log in</a>.</p>
</div>
