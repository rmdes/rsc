<script lang="ts">
	import type { Component } from 'svelte'
	import { PREVIEW_SANITIZE_OPTS } from './preview-sanitize'

	let {
		name = 'content',
		placeholder = '',
		required = true,
		// Bindable so parents can seed from / persist to a draft store.
		// One value binds BOTH branches: whatever was typed pre-enhancement seeds
		// the editor; Carta's own textarea then carries the form semantics.
		value = $bindable('')
	}: { name?: string; placeholder?: string; required?: boolean; value?: string } = $props()

	// Post-mount flag (H4): never gate on `browser` — SSR and the first client
	// render must both show the plain textarea or hydration mismatches. The
	// swap happens only after carta-md's dynamic import resolves; on import
	// failure the flag never flips and the plain textarea IS the composer.
	let editor = $state<{ MarkdownEditor: Component; carta: unknown } | null>(null)

	$effect(() => {
		let cancelled = false
		Promise.all([
			import('carta-md'),
			import('dompurify'),
			import('remark-breaks'),
			import('rehype-highlight'),
			import('@cartamd/plugin-slash'),
			import('@cartamd/plugin-emoji'),
			import('carta-md/default.css'),
			import('@cartamd/plugin-slash/default.css'),
			import('@cartamd/plugin-emoji/default.css')
		])
			.then(([cartaMod, dompurifyMod, breaksMod, highlightMod, slashMod, emojiMod]) => {
				if (cancelled) return
				const carta = new cartaMod.Carta({
					// Preview runs client-side on pasteable input — paste-based
					// self-XSS is real. Display sanitization stays server-side.
					sanitizer: (html: string) => dompurifyMod.default.sanitize(html, PREVIEW_SANITIZE_OPTS),
					extensions: [
						slashMod.slash(),
						emojiMod.emoji(), // brings remark-emoji itself — same map as the server
						{
							// Preview parity with the server twins: same remark-breaks,
							// same rehype-highlight (NOT shiki/plugin-code — the server
							// is sync highlight.js, and Task 3's token CSS colors both).
							transformers: [
								{ execution: 'sync', type: 'remark', transform: ({ processor }) => void processor.use(breaksMod.default) },
								{ execution: 'sync', type: 'rehype', transform: ({ processor }) => void processor.use(highlightMod.default) }
							]
						}
					]
				})
				// Carta portals caret-bound popups (slash menu, emoji autocomplete)
				// to <body> by default — but body children can NEVER paint above a
				// top-layer modal <dialog>. Portal into the enclosing dialog instead
				// (popups position:fixed in viewport coords, so the math is
				// unchanged); outside a dialog (inline reply) body stays the portal.
				const bindToCaret = carta.bindToCaret.bind(carta)
				carta.bindToCaret = (element: HTMLElement) =>
					bindToCaret(element, element.closest('dialog') ?? document.body)
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
