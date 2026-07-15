// Stand-in for SvelteKit's $env/dynamic/private under plain vitest (no SvelteKit
// runtime available in unit tests). Aliased in vitest.config.ts.
export const env = process.env
