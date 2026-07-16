# Textcaster — Carta markdown composer design

Date: 2026-07-16 (rev 2 — folds in
`docs/superpowers/reviews/2026-07-16-carta-composer-spec-review.md`:
form-native textarea dissolves H1/H2; H3 decided; H4 + mode pins; concrete
bundle gate; reply-action test)
Status: design approved (brainstorm); rev 2 pending review
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

**The form contract (rev 2 — Carta's textarea IS the field):**

Probed against carta-md 4.11.2 source (review): `<MarkdownEditor>` renders
a REAL `<textarea>` and spreads caller `textarea={{ … }}` props onto it —
`name`, `required`, `placeholder` included — with `bind:value` synchronous
on the element. So there is no mirror, no hidden field, no sync:

1. One `value = $state('')` binds BOTH branches.
2. SSR + pre-enhancement: a plain
   `<textarea {name} {placeholder} {required} bind:value>` — byte-equivalent
   to today's markup; no-JS posts exactly as now.
3. On mount the component dynamically imports `carta-md` (+ CSS); when the
   import resolves it flips a POST-MOUNT `$state` flag (H4: never gate on
   `browser` — SSR and first client render must match or hydration
   mismatches) and swaps in
   `<MarkdownEditor {carta} mode="tabs" textarea={{ name, required, placeholder }} bind:value>`
   — Carta's own textarea carries the form semantics. `required` sits on
   the VISIBLE control (constraint validation works); submit serializes the
   element the user typed into (no async-mirror race — H1/H2 dissolved by
   construction).
4. Import failure → the flag never flips → the plain textarea remains. The
   degradation is the baseline.
5. `mode="tabs"` pinned: the home composer lives in the narrow sidebar
   where Carta's default `auto` split-view is wrong; tabs (Write/Preview)
   fit both surfaces.

**Carta configuration:**

```ts
new Carta({ sanitizer: DOMPurify.sanitize })
```

No extensions. GFM is Carta's default pipeline (remark-gfm), matching the
compose dialect the server renders (marked GFM).

**Preview/display parity (H3, decided):** the review found the divergence
was understated — the server allowlist dropped GFM tables and
strikethrough entirely, so the preview showed what readers never got. Rev 2
WIDENS both sanitizer configs (core `markdown.ts` + web `render.ts`, the
drift-canary pair, symmetrically) with the benign GFM tags:
`table thead tbody tr td th del` — tables and strikethrough now survive
end-to-end. Task lists stay OUT: they need `input[type=checkbox]`, an
attribute surface the security-reviewed allowlist deliberately excludes —
`- [ ]` renders as literal text everywhere, and THAT is the named,
honest residual divergence (plus theoretical remark-vs-marked edge cases;
the preview is a draft approximation, the server render is the truth).
Fixtures: table/del survive both configs; a task-list checkbox input never
does.

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
- svelte-check + web test suite green. Bundle gate, concrete: run
  `npm run build -w web`, then parse
  `web/.svelte-kit/output/client/.vite/manifest.json` and assert the module
  importing `carta-md` appears only as a `dynamicImports` edge — never a
  static `imports` edge — of the composer pages' chunks.
- NEW reply-action test (the review found `?/reply` has no action test, so
  "the tests pin the contract" only covered the home half): mirror the
  existing compose-action test for the thread page's reply action —
  formData `content` + hidden target semantics, DOM-free.
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
