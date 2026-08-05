// Shared between +page.server.ts (parses submitted checkboxes into the
// permissions body) and +page.svelte (renders the checkboxes) — same split
// as settings/api-keys/permissions.ts, kept out of +page.server.ts itself
// because SvelteKit forbids importing a *.server.ts module from
// client-visible code.
//
// Scoped to the admin.* vocabulary this panel offers, mirroring
// ALLOWED_ADMIN_KEY_PERMISSIONS (core/src/api/logical-routes.ts) exactly —
// that whitelist, plus the Task 3a/4/5 apiKeyAuthAdmin before-hook, is the
// real enforcement boundary, not this list.
export const PERMISSION_OPTIONS = [
	{ formKey: 'admin.read:read', resource: 'admin.read', action: 'read', label: 'Read sources, users, overview, and settings' },
	{ formKey: 'admin.sources:write', resource: 'admin.sources', action: 'write', label: 'Governance actions (pause, resume, quarantine, allow, block, unblock, establish federation)' },
	{ formKey: 'admin.moderation:write', resource: 'admin.moderation', action: 'write', label: 'Hard removal (delete a user account or a post)' }
] as const
