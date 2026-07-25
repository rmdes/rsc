<!-- D11: a neutral connective marker for an unavailable/tombstoned thread
     ancestor. NOT a card — no byline, avatar, PostBody, reply actions, or
     {@html} (the sole {@html} stays in PostBody). Low-emphasis, token-only
     (MASTER.md --color-secondary), SSR-rendered so no-JS readers see it. -->
<p class="thread-placeholder">Post unavailable</p>

<style>
	.thread-placeholder {
		margin: 0;
		font-size: 0.875rem;
		font-style: italic;
		color: var(--color-secondary);
	}
</style>
