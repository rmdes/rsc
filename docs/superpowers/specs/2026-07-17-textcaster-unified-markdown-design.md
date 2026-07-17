# Textcaster — unified markdown pipeline design

Date: 2026-07-17 (rev 2 — folds in
`docs/superpowers/reviews/2026-07-17-unified-markdown-spec-review.md`:
allowedClasses-only correction, version-pin discipline, emoji mode pin,
load-bearing goal declared, core-swap decision made conscious, residual
divergences named)
Status: design approved; rev 3 (plan-time probe amendments — see addendum
at end; plan: `docs/superpowers/plans/2026-07-17-textcaster-unified-markdown.md`)
Author: Ricardo (rmdes) with Claude Code
Basis: rich-content milestone (render-on-read, sanitizer twins), Carta
composer milestone (preview = remark, published = marked — the parity gap
this design closes).

## Why — and what is load-bearing

Carta's preview renders through remark/unified; the published post renders
through marked. Every remark plugin we could enable in the editor previews
syntax the server will never honor — the ecosystem is decorative. The fix is
structural: the server speaks remark too, with one plugin story across
preview and published output. The sanitizer stays exactly where it is — the
XSS gate after ANY parser — and is widened deliberately, per feature, never
generally.

**The load-bearing goal is remark-ecosystem compatibility, not this v1
feature set** (review flag, answered). The review is right that all four v1
features have marked equivalents (`breaks:true`, `marked-emoji`,
`marked-highlight`) at ~3 small deps. That alternative is REJECTED because
it only covers plugins that happen to have marked ports and re-opens the
preview-parity gap on every future plugin — the operator's stated goal is
making Carta's plugin ecosystem genuinely usable, which means: enabling a
remark plugin = add it to both twin chains, done. AST-structure agreement
with the preview's parser (edge cases included) comes with that and is
wanted, but the ecosystem property is the requirement.

**Core swaps too — a product decision, not reflex** (review flag, answered).
Keeping marked in core would save it ~7 deps but would make a local post's
feed `<description>` diverge from its on-site HTML (no breaks/emoji for
external readers) and would break the twins' byte-identity canary. Feed ==
site is wanted: the description a feed reader shows must be the same
rendering members see. Both twins swap.

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
   emoji TEXT — zero HTML surface change, no sanitizer change. PINNED
   (review): `accessible` stays at its default `false`; `accessible: true`
   would wrap emoji in `<span role="img" aria-label>` the allowlist doesn't
   carry, silently degrading a11y. A fixture asserts emoji renders as bare
   text. Editor uses `@cartamd/plugin-emoji` for autocomplete + preview
   (map-source divergence: see residual divergences).

4. **code highlight** (`rehype-highlight`, both twins): fenced code blocks
   gain `<span class="hljs-…">` token markup. Sanitizer widening is ONE
   config line per twin:

   ```ts
   allowedClasses: { code: ['hljs*', 'language-*'], span: ['hljs-*'] }
   ```

   `allowedClasses` is the WHOLE mechanism (review-probed against
   sanitize-html 2.17.6): it filters class values per-tag and per-pattern
   without `class` ever entering `allowedAttributes`. `class` MUST NOT be
   added to `allowedAttributes` — that is redundant at best, and an
   implementer who adds it while dropping `allowedClasses` would open
   arbitrary class values. The bare `hljs*` glob on `code` is deliberate:
   rehype-highlight emits a bare `class="hljs"` there that `hljs-*` would
   miss. A `class="hljs-x"` on any other tag dies (probed). Expected
   stripping (review pin — do not "fix"): highlight.js sub-scope classes
   like `class="hljs-title function_"` lose the non-`hljs` part; our theme
   only styles `hljs-*` tokens, so this is harmless. `app.css` colors the
   hljs token classes from theme tokens (light + dark via the established
   mechanism, no raw hex). `detect` stays at its default `false`: unlabeled
   fences get no highlighting (see residual divergences).

5. **slash** (`@cartamd/plugin-slash`): editor-only UX (slash command
   menu). No render-path impact.

## Preview parity

Carta's internal pipeline already runs remark-gfm. The editor adds the
matching transformers (breaks, emoji) through Carta's extension API so that
preview and published output agree in structure and meaning. The
implementation plan MUST probe carta-md 4.11.2's installed source for the
exact transformer wiring (`Plugin.transformers`, execution order) before
coding — no API calls from memory.

Named residual divergences (honest, bounded — the complete list):

1. **Highlight palette**: shiki in preview, highlight.js in published
   output — same token structure, different colors.
2. **Unlabeled fences**: `rehype-highlight` `detect` defaults to `false`,
   so a fence without a language gets no `hljs` markup server-side. The
   plan probes what carta's shiki preview does with a bare fence and pins
   the observed pair as the contract; `detect` is not turned on (guessed
   languages are wrong often enough to be worse than plain).
3. **Emoji map source**: published uses remark-emoji (node-emoji map),
   preview uses `@cartamd/plugin-emoji`. The plan compares the shortcode
   sets at probe time; overlap gaps are documented, not chased.

Task-list inputs remain excluded everywhere (unchanged decision);
`contains-task-list`/`task-list-item` classes on `ul`/`li` die because
those tags have no `allowedClasses` entry. `PREVIEW_SANITIZE_OPTS` is
unchanged.

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
`@cartamd/plugin-emoji`.

Version discipline (review pin — this is what makes byte-identity real):
web ALREADY carries the deduped unified-11 stack transitively via
carta-md 4.11.2 (`unified@11.0.5`, `remark-parse@11`, `remark-gfm@4`,
`remark-rehype@11.1.2`, `rehype-stringify@10`); the genuinely new packages
web-side are only `remark-breaks@4`, `remark-emoji@5`,
`rehype-highlight@7` (+ the two `@cartamd/*`). Core takes the whole set
fresh. Both package.json files pin EXACT, IDENTICAL versions so the
hoisted root dedupes to one copy of each — divergent pins would break the
byte-identity canary and can ship two unified copies in the bundle.

## Security posture

- The sanitizer remains the LAST step of every render path; a plugin is
  enabled only together with an explicit decision about the HTML surface it
  emits. This design's ENTIRE security delta is the one `allowedClasses`
  line above (review-verified; remark-breaks emits already-allowlisted
  `<br>`, remark-emoji default emits bare text).
- Hostile fixtures (script injection, javascript: URLs, event handlers,
  task-list inputs) re-run UNCHANGED against the new pipeline in both
  suites — the engine swap must not alter any hostile outcome.
- `allowDangerousHtml` is NEVER opted into — and note this is the default,
  not a delta: `remark-rehype` DROPS raw HTML written in markdown before
  the sanitizer ever runs (review-probed: `<script>`, `<div onclick>`,
  `<img onerror>` all die at the parser, only inert text remains). That is
  a STRONGER posture than marked, which passed raw HTML through with the
  sanitizer as sole backstop. The sanitizer still runs after: defense in
  depth. A fixture pins `<script>` written INLINE in markdown.
- UX consequence worth one RUNNING.md line (review note, not security): a
  member who types literal HTML like `<div>x</div>` in a post sees the tag
  vanish and the text remain — expected, not a bug.

## Testing

- **Byte-identity canary — NEW work, not an existing check** (review pin):
  today's canary is behavioral (same hostile fixtures, separate asserts).
  This milestone adds one canonical fixture document exercising breaks,
  emoji, fenced code, GFM table/strikethrough, and hostile input, with the
  EXPECTED OUTPUT STRING asserted identically in both suites — which only
  holds under the identical version pins above.
- Hostile fixtures: unchanged, must pass unmodified.
- New: `class="hljs-…"` survives on `code`/`span` only; dies on `div`/`a`;
  emoji is bare unicode text (no span wrapper); `hljs-title function_`
  sub-scope strips to `hljs-title` (expected).
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

## Rev 3 addendum — plan-time probe amendments (2026-07-17)

Three findings from executing the plan-time probes (composed chain +
sanitizer + installed carta source), each strengthening or correcting rev 2:

1. **`span` must join `allowedTags`** (correction). Composing the pipeline
   WITH the sanitizer (the review probed them separately) showed
   `allowedClasses` alone is moot: without `span` in `allowedTags`, the
   hljs token spans are stripped bodily and highlighting silently no-ops.
   The security delta is therefore: `span` in `allowedTags` (inert, no
   attributes beyond the class patterns) + the one `allowedClasses` line.
2. **The preview uses the SAME highlighter — palette and bare-fence
   divergences dissolve** (improvement). Probing carta 4.11.2's processor
   showed its preview does NOT highlight code at all (shiki only styles the
   editor's input overlay). The plan wires `rehype-highlight` into the
   preview as a sync rehype transformer via carta's probed
   `extensions[].transformers` API — same library, same classes, same token
   CSS as published output. `@cartamd/plugin-code` is not used.
3. **The emoji map divergence dissolves** (improvement).
   `@cartamd/plugin-emoji@4.3.0` depends on `remark-emoji` itself (same
   `node-emoji` map as the server twins). One mapping everywhere.

Net: the residual-divergence list from rev 2 is now EMPTY apart from the
pre-existing `PREVIEW_SANITIZE_OPTS` scope difference, which predates this
milestone.

Post-merge amendment (final review I1, 2026-07-17): the server twins cap
synchronous highlighting at a per-document `HIGHLIGHT_MAX_CHARS = 10_000`
budget (DoS guard — sync SSE render path, ~10ms/KB measured highlight
cost). The Carta preview deliberately does NOT mirror the cap: an
over-budget fence highlights in the author's own browser but publishes
plain. Client-side self-cost only; accepted as the one new residual
divergence.
