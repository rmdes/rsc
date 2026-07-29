<script lang="ts">
	import ThemeToggle from '$lib/ThemeToggle.svelte'

	type Me = {
		user: { displayName: string; handle: string }
		isAnonymous: boolean
		emailVerified?: boolean
		isAdmin?: boolean
	} | null

	let { me }: { me: Me } = $props()
	const needsAttention = $derived(me != null && (me.isAnonymous || me.emailVerified === false))
</script>

{#if !me}
	<div class="account-menu account-menu-guest">
		<a href="/login">Log in</a> · <a href="/register">Register</a>
	</div>
{:else}
	<details class="account-menu">
		<summary class="account-menu-toggle">
			{#if needsAttention}<span class="account-menu-dot" aria-hidden="true"></span><span class="visually-hidden">Needs attention</span>{/if}
			<span class="account-menu-handle">@{me.user.handle}</span>
		</summary>
		<div class="account-menu-panel">
			<div class="nav-menu-group">
				<div class="nav-menu-identity">{me.user.displayName}</div>
			</div>
			<div class="nav-menu-group">
				<div class="nav-menu-list">
					{#if me.isAnonymous}
						<a class="accent" href="/register">Register to keep this account</a>
					{:else if me.emailVerified === false}
						<a class="accent" href="/login">Verify your email — email me a login link</a>
					{/if}
					<a href="/u/{me.user.handle}">Your lens</a>
					<a href="/settings">Settings</a>
					{#if me.isAdmin}<a href="/admin">Admin</a>{/if}
					{#if !me.isAnonymous}
						<form method="POST" action="/login?/logout">
							<button class="destructive" type="submit">Log out</button>
						</form>
					{/if}
				</div>
			</div>
			<div class="nav-menu-group">
				<ThemeToggle variant="segmented" />
			</div>
		</div>
	</details>
{/if}
