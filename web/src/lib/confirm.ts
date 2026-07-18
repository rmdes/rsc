import type { SubmitFunction } from '@sveltejs/kit'

/** use:enhance guard — confirm() before submit, then apply the result. No-JS falls through to a plain POST. */
export function confirmSubmit(message: string): SubmitFunction {
	return ({ cancel }) => {
		if (typeof confirm === 'function' && !confirm(message)) cancel()
		return async ({ update }) => update()
	}
}
