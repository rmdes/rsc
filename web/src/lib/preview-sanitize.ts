// Preview parity: the preview must never show what publishing strips.
// FORBID_TAGS input = task-list checkboxes (server allowlist excludes input);
// FORBID_ATTR align = td/th alignment (server strips all attributes there).
export const PREVIEW_SANITIZE_OPTS = { FORBID_TAGS: ['input'], FORBID_ATTR: ['align'] }
