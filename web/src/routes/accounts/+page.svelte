<script lang="ts">
	import type { PageData } from './$types'
	let { data }: { data: PageData } = $props()
</script>

<svelte:head><title>Accounts — RSC</title></svelte:head>

<div class="lens">
	<h1>Accounts</h1>
	<p class="field-hint">Switch between accounts signed in on this browser.</p>

	<ul class="accounts">
		{#each data.accounts as account (account.id)}
			<li class:active={account.active}>
				<span class="account-email">{account.email}</span>
				{#if account.active}
					<span class="badge-kind on">current</span>
					<form method="POST" action="?/logoutOne"><button>Log out</button></form>
				{:else}
					<form method="POST" action="?/switch">
						<input type="hidden" name="id" value={account.id} />
						<button>Switch</button>
					</form>
				{/if}
			</li>
		{/each}
	</ul>

	<div class="account-actions">
		<a class="button" href="/login">Add account</a>
		<form method="POST" action="?/logoutAll"><button class="danger-link">Log out of all accounts</button></form>
	</div>

	<p class="field-hint">You can keep up to 3 accounts signed in on this browser.</p>
</div>

<style>
	/* Row-per-account, matching the house .following-list shape (surface card,
	   border, radius, space-sm/md padding) rather than a table — same reasoning
	   as /admin/users: this column is a fixed 42rem (.lens), too narrow for
	   columns to earn their keep. */
	.accounts {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
	}

	.accounts li {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-sm);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius);
		padding: var(--space-sm) var(--space-md);
	}

	/* Current-account marker: border + badge together (never color alone),
	   same pairing as .post.remote's left-border + kind badge. */
	.accounts li.active {
		border-left: 3px solid var(--color-accent);
	}

	.account-email {
		font-weight: 600;
		overflow-wrap: anywhere;
		margin-right: auto;
	}

	/* Compact row buttons (Switch / Log out), matching the density of
	   .follow-form/.unfollow-form's inline actions rather than full-size
	   page buttons. */
	.accounts button {
		padding: 6px 14px;
	}

	.account-actions {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-md);
	}

	/* P3: net-new here. Anchor styled as the accent CTA button (identical
	   visual to the bare <button> element skin in app.css) so "Add account"
	   reads as an action, not a text link, while staying a plain <a> (no-JS,
	   no form needed to get to /login). */
	.button {
		display: inline-block;
		background: var(--color-accent);
		color: var(--color-on-accent);
		padding: 10px 20px;
		border-radius: var(--radius);
		font-weight: 600;
		text-decoration: none;
		cursor: pointer;
		transition: opacity 200ms ease;
	}

	.button:hover {
		opacity: 0.9;
	}

</style>
