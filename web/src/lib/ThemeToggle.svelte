<script lang="ts">
	import { browser } from '$app/environment';

	let { variant = 'icon' }: { variant?: 'icon' | 'segmented' } = $props();

	type Mode = 'system' | 'light' | 'dark'
	const current = (): Mode => {
		const t = browser ? localStorage.theme : undefined
		return t === 'dark' || t === 'light' ? t : 'system'
	}
	let mode = $state<Mode>(browser ? current() : 'system')

	function apply(next: Mode) {
		mode = next
		if (next === 'system') {
			delete localStorage.theme
			delete document.documentElement.dataset.theme
		} else {
			localStorage.theme = next
			document.documentElement.dataset.theme = next
		}
	}

	// Icon-variant toggle: binary, same behavior as before (never touches "system").
	function toggle() {
		const root = document.documentElement;
		const dark = root.dataset.theme
			? root.dataset.theme === 'dark'
			: matchMedia('(prefers-color-scheme: dark)').matches;
		apply(dark ? 'light' : 'dark');
	}
</script>

{#if browser}
	{#if variant === 'segmented'}
		<div class="theme-segmented" role="group" aria-label="Theme">
			{#each (['system', 'light', 'dark'] as const) as m (m)}
				<button type="button" class:active={mode === m} onclick={() => apply(m)}>{m}</button>
			{/each}
		</div>
	{:else}
		<button type="button" class="theme-toggle" onclick={toggle} aria-label="Toggle light/dark theme">
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
				<circle cx="12" cy="12" r="9" />
				<path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
			</svg>
		</button>
	{/if}
{/if}
