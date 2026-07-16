# Spec review — Carta markdown composer (ponytail + adversarial)

Date: 2026-07-16
Target: `docs/superpowers/specs/2026-07-16-textcaster-carta-composer-design.md` (03ace72)
Grounded: files read, carta-md@4.11.2 tarball probed (deps not yet installed —
`npm ls carta-md dompurify -w web` empty).

**Verdict: not ready to plan — ONE architectural change removes the two HIGH
findings AND is less code (ponytail and correctness converge). Then two pins
and one honest rewording. The DOMPurify scoping, field-name contract, and
lazy-chunk approach are sound.**

## The decisive finding: don't reinvent Carta's form-native textarea

Probed carta-md's real source: `<MarkdownEditor>` renders its OWN `<textarea>`
and spreads caller `textarea={{...}}` props onto it —
`dist/internal/textarea-props.d.ts` explicitly allows `name`, `required`,
`form`, `id`, etc. `value` is `$bindable` (`bind:value` binds the real
element, synchronous on input). So **Carta's textarea can BE the form field**:
`<MarkdownEditor textarea={{ name:'content', required:true }} bind:value>`.

The spec's "keep the original textarea hidden, mirror Carta's value into it on
every edit, submit reads the hidden one" reinvents this — and in doing so
manufactures both HIGH findings. Replace it: SSR a plain
`<textarea name=content required>`, and after the dynamic import swap to
Carta's editor with its textarea named `content`. One `content` field always,
no mirror, no race, less code.

## Findings

### H1 — HIGH (architectural): the manual-sync design is fragile-by-construction

Both composers do native full-page POSTs (no `use:enhance` — grep-confirmed),
so the browser serializes fields synchronously on submit. A hidden textarea fed
by an async Svelte reactive mirror can serialize a STALE value if a submit
fires before the microtask flush — and toolbar/paste mutations (no keystroke)
widen the window. The spec provides no submit-flush, input-sync, or bind
guarantee. **Dissolves** if Carta's own textarea is the field (native
`bind:value`).

### H2 — HIGH: `required` on a hidden textarea is broken both ways

`display:none`/`hidden` → browser SKIPS constraint validation → empty compose
submits (silent UX regression; server still `fail(400)`s, so no corruption).
Visually-hidden-but-rendered → Chrome throws "An invalid form control … is not
focusable" and silently blocks submit, or points the bubble at a 1px element.
The spec picks neither. **Dissolves** if `required` lives on Carta's VISIBLE
textarea.

### H3 — MEDIUM: the GFM preview-vs-display divergence is bigger than "slight"

The server allowlist (`render.ts` `SANITIZE_CONFIG.allowedTags`) has NO
`table`/`thead`/`tr`/`td`, no `del`/`s`, no `input`, no `h5/h6`. Carta's
remark-gfm preview renders GFM **tables, strikethrough (`~~`), task lists** —
which sanitize-html then STRIPS from the canonical display everyone else sees.
An author composes a clean table in preview that VANISHES for readers. These
are headline GFM features, not edge cases. **Decide:** either widen the server
allowlist to match (note: that touches the security-reviewed rich-content
sanitizer — adding `table`/`td`/`del` is benign, but task-lists need `input`,
a bigger surface; weigh it), OR rewrite the spec's "edge-case renders may
differ slightly" to name the real casualties honestly. Recommend the honest
rewording unless table support is a product requirement.

### H4 — LOW (hydration): swap on a post-mount flag, not `browser`

If the Carta-vs-textarea `{#if}` keys off `browser` from `$app/environment`,
SSR renders textarea and hydration immediately renders Carta → hydration
mismatch. Gate the swap on a `$state` flag flipped in `onMount` after the
dynamic import resolves, so hydration matches SSR then swaps. Spec intent is
right ("on mount") but must state this.

## Ponytail
- **The architecture is over-built** (H1) — the shadow-textarea mirror is dead
  complexity Carta makes unnecessary. Delete it.
- **2 deps understate the cost:** `carta-md` drags `shiki@^3` + `unified` +
  `remark-parse/gfm/rehype` + `rehype-stringify` + `diff`. A lighter path —
  plain textarea + a preview pane via the ALREADY-installed `marked` +
  DOMPurify (1 new dep, ~30 lines, zero shiki) — delivers live preview without
  Carta. Carta earns its weight ONLY if syntax-highlighted *source* editing is
  a hard requirement. The operator approved Carta → flag, not block.
- Zero-plugins-v1, one-shared-component, `required?: boolean = true` prop: lean,
  confirmed. Nothing else speculative.

## Ambiguities to pin
1. Drop the hidden textarea (strongly recommended). If kept: mandate a bind or
   submit-flush AND the hiding method AND guarantee there aren't TWO `content`
   fields (Carta's + the hidden one → `formData.get('content')` gets the first).
2. Carta `mode` — unspecified; `mode='auto'` split-view is wrong for the narrow
   `aside.tools` home sidebar and inconsistent across the two surfaces. Pin
   `mode='tabs'`.
3. Bundle-split assertion mechanism — "inspect the chunks" is hand-wavy. Pin:
   parse `.svelte-kit/output/client/.vite/manifest.json` and assert `carta-md`
   is a `dynamicImports` edge (not a static `imports`) of the composer chunk.

## Verified sound
- Field names: `?/compose` AND `?/reply` both read `content` — default
  `name='content'` correct for both. (But NO reply-action test exists — only
  the home action is pinned; "the tests pin the contract" is narrower than
  claimed.)
- Form-action tests are DOM-free (synthetic Request) → editor swap invisible to
  them; the "pass unmodified" contract holds.
- DOMPurify preview sanitizer: default strips script/on*/javascript:, adequate
  for self-XSS; blast radius correctly limited (preview client-only, only raw
  markdown POSTed, server path unchanged — no route to other users).
- Bundle split: `await import('carta-md')` on mount IS a valid Rollup split
  (carta+shiki+unified land in a lazy chunk) PROVIDED nothing statically
  imports it; CSS splits if imported inside the dynamic import. shiki heavy but
  composer-only post-hydration — acceptable.
- SSR baseline: only the plain textarea renders server-side; no-JS degradation
  is genuinely the baseline; deps not installed yet (plan installs them).

## What must change before planning
Re-architect to Carta's form-native textarea (removes H1+H2, less code); pin
`mode='tabs'` and the bundle-split assertion mechanism; and either widen the
server allowlist for GFM tables/strikethrough or reword the divergence note to
name the real casualties (H3). Add a reply-action test to genuinely pin both
contracts.
