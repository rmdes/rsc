# Textcaster — Carta markdown composer design

Date: 2026-07-16
Status: design approved (brainstorm); spec pending review
Author: Ricardo (rmdes) with Claude Code
Basis: rich-content milestone (local composes ARE Markdown, server-side
display sanitization at `web/src/lib/server/render.ts`); carta-md 4.11.2
probed: Svelte 5 native (`peerDependencies: svelte ^5.0.0`), remark-gfm +
rehype + shiki pipeline, plugin ecosystem exists but none used in v1.

## What this ships

The two compose surfaces (home `?/compose`, thread page `?/reply`) upgrade
from bare `<textarea>` to Carta — syntax-highlighted Markdown editing with
live preview — as a pure progressive enhancement. No-JS posting, the form
actions, the wire, and the server-side sanitization pipeline are untouched.

Decisions (brainstormed, user-confirmed):

- **Both composers**, one shared component.
- **Zero Carta plugins in v1** — `@cartamd/plugin-attachment` is the natural
  add when the media milestone lands; not now.
- **New deps (user-approved)**: `carta-md` and `dompurify` (+ types), web
  workspace only. DOMPurify is Carta's PREVIEW sanitizer: the preview runs
  client-side and paste-based self-XSS is a real vector ("paste this cool
  markdown" containing script). The server-side display path from the
  rich-content milestone is unchanged and remains the only thing other
  users ever see.

## The component — `web/src/lib/MarkdownComposer.svelte`

Props: `{ name?: string = 'content', placeholder?: string, required?: boolean = true }`.

**The form contract (the invariant everything hangs on):**

1. SSR renders a real `<textarea {name} {placeholder} {required}>` —
   byte-equivalent to today's markup. No JS → the form posts exactly as it
   does now. The server actions read the same `formData.get('content')`.
2. On mount, the component DYNAMICALLY imports `carta-md` (and its CSS) —
   the editor, shiki grammars, and the remark pipeline never enter the
   initial bundle; only composer pages fetch them, post-hydration.
3. Carta's state is seeded from the textarea's CURRENT value (a user who
   started typing before hydration loses nothing), the editor mounts in its
   place, and the textarea stays in the DOM — visually hidden, value synced
   on every edit — as the form's field. Submit reads the textarea; the
   enhancement is invisible to the action layer.
4. If the dynamic import fails (offline, old browser), the textarea simply
   remains — the degradation IS the baseline.

**Carta configuration:**

```ts
new Carta({ sanitizer: DOMPurify.sanitize })
```

No extensions. GFM is Carta's default pipeline (remark-gfm), which matches
the compose dialect the server renders (marked GFM). **Known, accepted
divergence:** preview = remark-gfm, canonical display = marked-gfm +
sanitize-html — edge-case renders may differ slightly; the preview is a
draft approximation, the server render is the truth. Documented, not
"fixed" (unifying pipelines is not worth importing Carta's renderer into
the server path).

## Theming

Carta's base stylesheet is imported by the component (arrives with the
dynamic import, not globally). A scoped override block in `app.css` remaps
Carta's CSS variables/selectors to our tokens — `--color-surface`,
`--color-border`, `--color-foreground`, `--color-accent` for toolbar
accents, the existing monospace stack for the editor — covering BOTH themes
via the established `light-dark()`/`[data-theme]` mechanism. No raw hex.

## What does NOT change

- Form actions, field names, redirect flows.
- The wire (`content` is raw Markdown, as since the rich-content
  milestone).
- Server-side rendering/sanitization (`render.ts`, `markdown.ts`).
- The `displayName`/`handle` inputs beside the composer.
- No drafts, no persistence, no editing of existing posts, no slash
  commands, no attachments (v1 non-goals).

## Testing

- Existing form-action tests already pin the contract (field names
  unchanged) — they must pass UNMODIFIED; any action-test edit is a design
  violation, not fallout.
- svelte-check + web test suite green; `npm run build -w web` (or the dev
  equivalent) confirms the dynamic import splits into its own chunk (the
  initial bundle must not grow by shiki's weight — assert by inspecting the
  build output chunks).
- Obscura (SSR half): pre-hydration markup contains the plain
  `<textarea name="content">` on both composer pages.
- Human click-check (hydrated half — obscura cannot settle dynamic
  imports): editor appears, typing previews, submit posts, and a post
  composed WITH the editor renders identically to one posted no-JS.

## Sequencing

1. Deps + `MarkdownComposer.svelte` (form contract + dynamic import +
   sanitizer) + home composer swap.
2. Thread-page reply swap + Carta theming block in `app.css`.
3. Gates + obscura SSR verification + RUNNING.md one-liner (composing is
   Markdown with live preview when JS is on; plain textarea otherwise).
