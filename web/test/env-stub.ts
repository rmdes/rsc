// Stand-in for SvelteKit's $env/dynamic/private under plain vitest (no SvelteKit
// runtime available in unit tests). Aliased in vitest.config.ts.
//
// Real SvelteKit dev/build loads web/.env into process.env via Vite before
// $env/dynamic/private ever reads it; plain vitest does not go through that
// pipeline, so CORE_API_TOKEN would otherwise be undefined here. Fall back to
// a fixed test token so header-shape assertions don't depend on the ambient
// shell environment.
export const env = { CORE_API_TOKEN: 'test-token', ...process.env }
