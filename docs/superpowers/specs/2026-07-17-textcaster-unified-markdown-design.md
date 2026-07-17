# Textcaster — unified markdown pipeline design

Date: 2026-07-17
Status: design approved (brainstorm); spec pending review
Author: Ricardo (rmdes) with Claude Code
Basis: rich-content milestone (render-on-read, sanitizer twins), Carta
composer milestone (preview = remark, published = marked — the parity gap
this design closes).

## Why

Carta's preview renders through remark/unified; the published post renders
through marked. Every remark plugin we could enable in the editor previews
syntax the server will never honor — the ecosystem is decorative. The fix is
structural: the server speaks remark too, with one plugin story across
preview and published output. The sanitizer stays exactly where it is — the
XSS gate after ANY parser — and is widened deliberately, per feature, never
generally.

## What this ships

Both render twins swap engines, and four features land on the shared chain:

1. **Engine swap**: `core/src/domain/markdown.ts` (`renderLocalHtml`, feeds)
   and `web/src/lib/server/render.ts` (`renderPostHtml`, display) replace
   `marked.parse` with the same unified chain:

   ```
   unified()
     .use(remarkParse)
     .use(remarkGfm)
     .use(remarkBreaks)
     .use(remarkEmoji)
     .use(remarkRehype)
     .use(rehypeHighlight)
     .use(rehypeStringify)
     .processSync(md)
   ```

   then into the existing `sanitize-html` gate, unchanged in shape. The
   ENTIRE chain is synchronous (`processSync`) — `renderPostHtml` runs
   inside the SSE frame transformer, which cannot await. This is why the
   server highlighter is rehype-highlight (lowlight, sync), NOT shiki
   (async engine): a hard constraint, not a preference.

   `marked` is REMOVED from both workspaces.

2. **breaks** (`remark-breaks`, both twins): a single newline renders as
   `<br>` — microblog-natural line breaks. No sanitizer change (`br` is
   already allowlisted). Editor preview gains the matching transformer.

3. **emoji** (`remark-emoji`, both twins): `:shortcode:` becomes unicode
   emoji TEXT — zero HTML surface change, no sanitizer change. Editor uses
   `@cartamd/plugin-emoji` (same gemoji mapping) for autocomplete + preview.

4. **code highlight** (`rehype-highlight`, both twins): fenced code blocks
   gain `<span class="hljs-…">` token markup. Sanitizer widening is NARROW:

   ```ts
   allowedClasses: { code: ['hljs*', 'language-*'], span: ['hljs-*'] }
   ```

   `class` joins `allowedAttributes` ONLY for `code` and `span`, constrained
   by those patterns — the attribute never opens generally, and a
   `class="hljs-x"` on any other tag dies. `app.css` colors the hljs token
   classes from theme tokens (light + dark via the established mechanism,
   no raw hex).

5. **slash** (`@cartamd/plugin-slash`): editor-only UX (slash command
   menu). No render-path impact.

## Preview parity

Carta's internal pipeline already runs remark-gfm. The editor adds the
matching transformers (breaks, emoji) through Carta's extension API so that
preview and published output agree in structure and meaning. The
implementation plan MUST probe carta-md 4.11.2's installed source for the
exact transformer wiring (`Plugin.transformers`, execution order) before
coding — no API calls from memory.

Named residual divergence (honest, bounded): code blocks are highlighted by
shiki in the preview and by highlight.js in published output — same
structure, different color palette. Task-list inputs remain excluded
everywhere (unchanged decision). `PREVIEW_SANITIZE_OPTS` is unchanged.

## What does NOT change

- Textcasting dual contract on feeds: `description` = rendered+sanitized
  HTML (SEC-4, own content only), `source:markdown` = raw verbatim.
- Remote content pass-through: never routed through this pipeline.
- The `{@html}` chokepoint (`PostBody.svelte`) and its three ingress points.
- Form actions, wire format, DB schema. No migration: markdown is stored
  raw and rendered on read, so existing posts pick up the new pipeline
  automatically.
- Sanitizer twin-file + drift-canary pattern (user-confirmed over a shared
  workspace package): each side declares its own chain; fixtures keep them
  honest.

## New dependencies (user-approved direction)

Both workspaces: `unified`, `remark-parse`, `remark-gfm`, `remark-breaks`,
`remark-emoji`, `remark-rehype`, `rehype-highlight`, `rehype-stringify`
(replacing `marked`). Web workspace additionally: `@cartamd/plugin-slash`,
`@cartamd/plugin-emoji`. Exact versions pinned at plan time against what
carta-md 4.11.2 itself depends on, to avoid duplicate unified majors in the
bundle.

## Security posture

- The sanitizer remains the LAST step of every render path; a plugin is
  enabled only together with an explicit decision about the HTML surface it
  emits. This design's only widening is the hljs class patterns above.
- Hostile fixtures (script injection, javascript: URLs, event handlers,
  task-list inputs) re-run UNCHANGED against the new pipeline in both
  suites — the engine swap must not alter any hostile outcome.
- remark passes raw HTML through to rehype only if configured to; the chain
  uses the default (raw HTML in markdown is NOT parsed as HTML,
  `remark-rehype` drops it unless `allowDangerousHtml` is set — which this
  design forbids). The sanitizer still runs regardless: defense in depth.
  The plan verifies the raw-HTML behavior against installed source and pins
  it with a fixture (`<script>` written INLINE in markdown).

## Testing

- **Drift canary (grown)**: one canonical fixture document exercising
  breaks, emoji, fenced code, GFM table/strikethrough, and hostile input;
  asserted byte-identical between core and web renders (fixture duplicated
  in both suites, same string).
- Hostile fixtures: unchanged, must pass unmodified.
- New: `class="hljs-…"` survives on `code`/`span` only; dies on `div`/`a`.
- Feed contract: a local post using breaks + emoji + fenced code pins its
  `description` output (core feed test).
- Editor preview: human click-check for slash menu, emoji autocomplete,
  highlighted preview (Playwright headless where it can settle carta).
- Bundle gate unchanged: carta and its plugins reach the app only via
  dynamic import.

## Sequencing

1. Engine swap at GFM parity, both twins + drift canary + hostile re-run.
2. breaks + emoji (both twins + editor transformers + fixtures).
3. rehype-highlight + sanitizer class patterns + hljs token CSS both themes.
4. Editor-side plugins (slash, emoji autocomplete) + bundle gate + click-check.
5. Remove marked, deps audit, RUNNING.md note.
