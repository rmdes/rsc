// Shared between +page.server.ts (parses submitted checkboxes into the
// permissions body) and +page.svelte (renders the checkboxes) — kept out of
// +page.server.ts itself because SvelteKit forbids importing a *.server.ts
// module from client-visible code.
//
// Phase 2 added timeline:read/posts:read; phase 3 adds the write
// permissions its new key-authed routes gate on (posts:write, follows:write,
// profile:write) — both here and in ALLOWED_KEY_PERMISSIONS
// (core/src/api/logical-routes.ts), which is the real enforcement boundary
// regardless of what this list offers.
export const PERMISSION_OPTIONS = [
	{ formKey: 'timeline:read', resource: 'timeline', action: 'read', label: 'Read my personal timeline' },
	{ formKey: 'posts:read', resource: 'posts', action: 'read', label: 'Read my own posts' },
	{ formKey: 'posts:write', resource: 'posts', action: 'write', label: 'Create, edit, and delete my posts' },
	{ formKey: 'follows:write', resource: 'follows', action: 'write', label: 'Follow, unfollow, and manage my subscriptions' },
	{ formKey: 'profile:write', resource: 'profile', action: 'write', label: 'Edit my profile' }
] as const
