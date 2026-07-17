<script lang="ts">
	import { enhance } from '$app/forms'
	import type { SubmitFunction } from '@sveltejs/kit'
	import MarkdownComposer from './MarkdownComposer.svelte'
	import { loadDraft, saveDraft } from './draft'

	let {
		draftKey,
		action,
		title,
		submitLabel,
		placeholder = '',
		showDisplayName = false
	}: {
		draftKey: string
		action: string
		title: string
		submitLabel: string
		placeholder?: string
		showDisplayName?: boolean
	} = $props()

	let handle = $state('')
	let displayName = $state('')
	let content = $state('')
	let error = $state('')
	let dialog = $state<HTMLDialogElement>()
	// Carta measures its textarea with requestAnimationFrame at mount; inside a
	// CLOSED dialog (display:none) that measures 0 and the inline height sticks
	// at 0px — a dead, unclickable editor until the first keystroke. So the
	// composer only mounts while the dialog is open.
	let isOpen = $state(false)

	// Post-mount flag (H4 rule): SSR and first client render both show the
	// plain <details> form — the no-JS baseline — then this flips and the
	// button+dialog take over. Restoring the draft happens in the same effect
	// so the enhanced branch never renders un-seeded fields.
	let enhanced = $state(false)
	$effect(() => {
		const d = loadDraft(draftKey)
		handle = d.handle ?? ''
		displayName = d.displayName ?? ''
		content = d.content ?? ''
		enhanced = true
	})

	// Every edit persists; dismissing the dialog can never lose writing.
	$effect(() => {
		if (enhanced) saveDraft(draftKey, { handle, displayName, content })
	})

	// The badge signals resumable WRITING — a remembered handle alone isn't a draft.
	const hasDraft = $derived(!!content.trim())

	const submit: SubmitFunction = () =>
		async ({ result, update }) => {
			if (result.type === 'failure') {
				error = typeof result.data?.error === 'string' ? result.data.error : 'Something went wrong'
			} else if (result.type === 'error') {
				error = 'Something went wrong'
			} else {
				// Confirmed success: only now does the draft die. Handle and
				// display name stay — they're identity, not writing — and the
				// save effect persists that trimmed state.
				error = ''
				content = ''
				dialog?.close()
			}
			await update()
		}
</script>

{#if enhanced}
	<button
		type="button"
		class="composer-open"
		onclick={() => {
			isOpen = true
			dialog?.showModal()
		}}
	>
		{title}{#if hasDraft}<span class="draft-badge">draft</span>{/if}
	</button>
	<!-- Click-on-backdrop closes; Esc is the native keyboard equivalent. -->
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
	<dialog
		bind:this={dialog}
		class="composer-dialog"
		aria-labelledby="composer-dialog-title"
		onclick={(e) => {
			if (e.target === dialog) dialog?.close()
		}}
		onclose={() => (isOpen = false)}
	>
		<div class="composer-dialog-body">
			<header>
				<h2 id="composer-dialog-title">{title}</h2>
				<button type="button" class="dialog-close" aria-label="Close" onclick={() => dialog?.close()}>×</button>
			</header>
			{#if error}<p class="error" role="alert">{error}</p>{/if}
			<form method="POST" {action} class="composer" use:enhance={submit}>
				<input name="handle" placeholder="your handle" required bind:value={handle} />
				{#if showDisplayName}
					<input name="displayName" placeholder="display name (optional)" bind:value={displayName} />
				{/if}
				{#if isOpen}
					<MarkdownComposer {placeholder} bind:value={content} />
				{/if}
				<button>{submitLabel}</button>
			</form>
		</div>
	</dialog>
{:else}
	<details class="panel" open>
		<summary>{title}</summary>
		<form method="POST" {action} class="composer">
			<input name="handle" placeholder="your handle" required />
			{#if showDisplayName}
				<input name="displayName" placeholder="display name (optional)" />
			{/if}
			<MarkdownComposer {placeholder} />
			<button>{submitLabel}</button>
		</form>
	</details>
{/if}
