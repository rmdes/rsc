<script lang="ts">
	import type { PageData, ActionData } from './$types'
	import ThemeToggle from '$lib/ThemeToggle.svelte'

	let { data, form }: { data: PageData; form: ActionData } = $props()
</script>

<svelte:head><title>Register — Textcaster</title></svelte:head>

<div class="lens">
	<header class="masthead">
		<a href="/">Textcaster</a>
		<ThemeToggle />
	</header>

	<h1>Register</h1>

	{#if form?.checkInbox}
		<p class="notice">Check your inbox — we sent a verification link to {form.email}.</p>
	{:else if !data.mailEnabled}
		<p class="notice">Email accounts are not available on this instance — post as a guest instead.</p>
	{:else}
		<p class="auth-note">Keeps your posts and follows under a permanent account — no more anonymous handle. Verify and sign in from this same browser to carry them over.</p>

		{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}

		<form method="POST" action="?/register" class="auth-form">
			<label class="visually-hidden" for="register-email">Email</label>
			<input id="register-email" name="email" type="email" placeholder="email" autocomplete="email" required />
			<label class="visually-hidden" for="register-password">Password</label>
			<input id="register-password" name="password" type="password" placeholder="password (min. 8 characters)" autocomplete="new-password" minlength="8" required />
			<button>Register</button>
		</form>

		<p class="auth-note">Already have an account? <a href="/login">Log in</a>.</p>
	{/if}
</div>
