<script lang="ts">
	import type { Component } from 'svelte'
	import { PREVIEW_SANITIZE_OPTS } from './preview-sanitize'

	let {
		name = 'content',
		placeholder = '',
		required = true
	}: { name?: string; placeholder?: string; required?: boolean } = $props()

	// One value binds BOTH branches: whatever was typed pre-enhancement seeds
	// the editor; Carta's own textarea then carries the form semantics.
	let value = $state('')

	// Post-mount flag (H4): never gate on `browser` — SSR and the first client
	// render must both show the plain textarea or hydration mismatches. The
	// swap happens only after carta-md's dynamic import resolves; on import
	// failure the flag never flips and the plain textarea IS the composer.
	let editor = $state<{ MarkdownEditor: Component; carta: unknown } | null>(null)

	$effect(() => {
		let cancelled = false
		Promise.all([import('carta-md'), import('dompurify'), import('carta-md/default.css')])
			.then(([cartaMod, dompurifyMod]) => {
				if (cancelled) return
				const carta = new cartaMod.Carta({
					// Preview runs client-side on pasteable input — paste-based
					// self-XSS is real. Display sanitization stays server-side.
					sanitizer: (html: string) => dompurifyMod.default.sanitize(html, PREVIEW_SANITIZE_OPTS)
				})
				editor = { MarkdownEditor: cartaMod.MarkdownEditor as unknown as Component, carta }
			})
			.catch(() => {})
		return () => {
			cancelled = true
		}
	})
</script>

{#if editor}
	{@const MarkdownEditor = editor.MarkdownEditor}
	<MarkdownEditor carta={editor.carta} mode="tabs" {placeholder} textarea={{ name, required }} bind:value />
{:else}
	<textarea {name} {placeholder} {required} bind:value></textarea>
{/if}
