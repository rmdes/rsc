// Shared between +page.server.ts (parses submitted checkboxes into the
// permissions body) and +page.svelte (renders the checkboxes) — kept out of
// +page.server.ts itself because SvelteKit forbids importing a *.server.ts
// module from client-visible code.
//
// Phase 2 scope only (Global Constraints): timeline:read and posts:read are
// the only enforceable permissions apiKeyAuth checks today. write/follows/
// profile checkboxes land with phase 3's write routes, not before.
export const PERMISSION_OPTIONS = [
	{ formKey: 'timeline:read', resource: 'timeline', action: 'read', label: 'Read my personal timeline' },
	{ formKey: 'posts:read', resource: 'posts', action: 'read', label: 'Read my own posts' }
] as const
