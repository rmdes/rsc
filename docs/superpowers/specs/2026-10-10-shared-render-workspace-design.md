# Shared render workspace — Design

**Status:** Rev 1, 2026-10-10. Approved section-by-section in brainstorming.
**Origin:** item 1 of the recommended order in
`docs/superpowers/reviews/2026-08-06-architecture-debt-review.md`.

## Problem

The XSS gate exists twice. `core/src/domain/markdown.ts` (83 lines) and
`web/src/lib/server/render.ts` (92 lines) each carry the same `unified`
pipeline and the same `sanitize-html` config, kept in step by discipline: a
CLAUDE.md invariant ("change both or neither") and a canonical fixture copied
into both test suites. Both workspaces also declare the same 12 dependencies.

Single-sourcing the gate makes "there is one sanitizer" a structural fact
instead of a rule people have to remember.

## What exploration established (verified 2026-10-10)

These correct the 2026-08-06 review, which this design otherwise follows.

| Review claimed | Actually |
|---|---|
| The twins are byte-identical modulo whitespace | **No.** The pipeline + `SANITIZE_CONFIG` + `HIGHLIGHT_MAX_CHARS` + `skipOversizedFences` are identical. The **exports differ**: core has `renderLocalHtml(md)`; web has `renderPostHtml(post)` (with precedence policy) and `enrichEntries(entries)`. |
| A drift canary guards them | **No real canary.** Two independent test files (`core/test/rich-content.test.ts`, `web/src/lib/server/render.test.ts`) that cannot see each other; they catch drift only if someone forgets to update expectations too. |
| ~9 duplicated deps | **12**: 10 runtime (`unified`, `remark-parse`, `remark-gfm`, `remark-breaks`, `remark-emoji`, `remark-rehype`, `rehype-highlight`, `rehype-stringify`, `sanitize-html`, `unist-util-visit`) + `@types/hast` + `@types/sanitize-html`. Grep-verified: **none** is imported anywhere in core or web outside the twins. |
| A third workspace is feasible | **Proven, not assumed.** Core runs on Node native type stripping with no build step, and Node refuses to strip types for files under `node_modules`. Probe in the core container: `import('@rsc/mcp/src/tools.ts')` succeeded and type-stripped — the workspace symlink (`node_modules/@rsc/mcp -> ../../mcp`) resolves to a realpath outside `node_modules`. |

One finding the review missed entirely, and which drives the API below. Web's
own test comment (`web/src/lib/server/render.test.ts`, hostile-fixtures test)
records that the twins are **not behaviourally identical**: core always parses
as markdown, so a raw-HTML block is dropped wholesale; web sanitizes remote HTML
directly, so benign text survives. Same input, two correct outputs:

| Input `<script>alert(1)</script>ok` | Result | Why |
|---|---|---|
| through the markdown pipeline | `''` | raw-HTML block dropped at the parser (`allowDangerousHtml` never set) |
| through direct sanitize | `'ok'` | script dies, benign text survives |

The "twins" were always **two functions sharing one config**.

## Design

### Ground rule: a pure move

Zero behaviour change. No sanitizer option, pipeline plugin, plugin order, or
dependency version changes. The canonical fixture's existing expected string is
the proof (success criterion 1).

### Package

A fourth npm workspace, mirroring `mcp/` (the proven precedent):

```
render/
  package.json        "@rsc/render", "type": "module"
  tsconfig.json       extends ../tsconfig.base.json — copied from mcp/
  vitest.config.ts    copied from mcp/
  src/render.ts       the gate
  test/render.test.ts
```

- Root `package.json` `workspaces`: `["core", "web", "mcp"]` → add `"render"`.
- `render/package.json` declares the 10 runtime deps at their **current exact
  pins** and the two `@types` packages as devDependencies.
- `core/package.json` and `web/package.json` each **remove all 12**.
- Consumers import by deep path, matching `web/src/routes/mcp/+server.ts:2`
  (`@rsc/mcp/src/tools.ts`): `@rsc/render/src/render.ts`. **No `exports`
  field** — the deep path is the resolution route proven under core's type
  stripping; an `exports` field is a different route, unverified here.

### API

Two exports. Everything else is module-private.

```ts
export function renderMarkdown(md: string): string // markdown → pipeline → sanitize
export function sanitize(html: string): string      // untrusted HTML → sanitize
```

- Two, not one, because web's third precedence branch sanitizes remote HTML
  that never passes through the markdown pipeline.
- `SANITIZE_CONFIG`, `HIGHLIGHT_MAX_CHARS`, `skipOversizedFences` and the
  pipeline stay **unexported**: nothing outside the gate can read or alter the
  config.
- Named `sanitize`, not `sanitizeHtml`, so it does not shadow the `sanitize-html`
  default import inside the module.
- Every security comment moves **verbatim**: SEC-4 (we never ship dirty HTML we
  generate), the `allowedClasses`-never-`class` rationale, I1's per-document
  highlight budget, and the "everything here is sync — the SSE path cannot
  await" note. These comments are why the rules haven't regressed.
- The twin-contract comments ("The twin of web/src/lib/server/render.ts…") are
  **deleted**, not moved — there is no twin any more.

### Consumers

**core** — delete `core/src/domain/markdown.ts`. In `core/src/domain/feed.ts`,
replace the import at `:5` with `renderMarkdown` from
`@rsc/render/src/render.ts` and rename the two call sites (`:132`, `:371`).
These are the only production uses of `renderLocalHtml`.

The remote branch at `:132` (`p.source === 'local' ? … : p.content`) passes
remote content through untouched. That is a deliberate, tested RSS pass-through
contract and is **not touched**.

**web** — `web/src/lib/server/render.ts` keeps its **path and both exports**
(`renderPostHtml`, `enrichEntries`). Consequently none of these change: the 8
route files that import it, the comment in `PostBody.svelte`, the
`item-review.test.ts` assertion that matches `/server\/render/`, and the
`history.load.test.ts` sanitize test. Its body reduces to the precedence policy:

```ts
const md = post.contentMarkdown ?? (post.source === 'local' ? post.content : null)
return md !== null ? renderMarkdown(md) : sanitize(post.content)
```

This is equivalent to today's `sanitizeHtml(md !== null ? pipeline(md) :
post.content, SANITIZE_CONFIG)`, because `renderMarkdown` is exactly
`sanitize(pipeline(md))`.

### Tests

Tests are sorted by **what they exercise**, not by which file holds them today.

**→ `render/test/render.test.ts`** (gate behaviour):

- Hostile fixtures against **both** entry points, each with its own positive
  assertions. Fixture set is the **union** of both suites — none dropped. Core
  contributes the markdown-link vectors (`[x](javascript:alert(1))`,
  `[x](//evil.com)`); web contributes markdown-that-embeds-raw-HTML
  (`safe **md**\n\n<script>…`).
- Canonical fixture — **once**, input and expected string copied unedited.
- GFM parity (tables/`del` survive, task-list checkboxes never), `<br>`,
  emoji-as-bare-text, hljs classes survive only on `code`/`span`, unlabeled
  fence gets no hljs, raw inline HTML dies at the parser, hljs sub-scope
  stripping, the three `HIGHLIGHT_MAX_CHARS` tests (over-budget fence, small
  fence still highlighted, per-document budget), SEC-4.
- Web's transform-attributes test (`rel="noreferrer"`, `loading="lazy"` survive
  output) and GFM autolink — both exercise the config, not web policy.

**core `rich-content.test.ts` keeps its 6 feed/ingest contracts:**
`source:markdown` captured into `ParsedItem.contentMarkdown`; RSS dual contract;
RSS pass-through; JSON Feed local output; JSON Feed ingest prefers
`content_html`; reply + markdown co-occurrence. These exercise `feed.ts`, which
calls the gate.

**web `render.test.ts` keeps 4:** precedence; `enrichEntries`; the DOMPurify
preview parity pin; and **one** hostile smoke test through `renderPostHtml`
proving the adapter routes remote HTML into `sanitize`.

**Liveness rule.** Every negative assertion keeps a paired positive one. A test
of only negatives passes when the function returns `''` — mutation-proven on
both twins on 2026-08-07. Each entry point gets its own liveness assertion.

**Expected count change.** Roughly core 19 → 6, web 17 → 4, render 0 → ~16:
about 36 → 26 overall. Duplicates collapse; coverage does not shrink. The plan
pins exact numbers.

### Packaging

- `cloudron/Dockerfile`: add `COPY render/package.json render/package.json`
  beside the mcp line (`:21`), before `npm ci`, with a comment stating the
  failure mode: without it `npm ci` silently installs none of render's deps and
  **the XSS gate fails to load in production** — a build that succeeds and a
  runtime that cannot render. This is why success criterion 5 is mandatory.
- `compose.yaml`: **no change expected.** Core's single `npm ci` populates the
  shared root `node_modules`, where the `@rsc/render` symlink lands. The deps
  have no competing versions after the move, so they should hoist. **Verify** at
  implementation that nothing lands under `render/node_modules` on the host bind
  mount (that is the root-owned-files bug class fixed in `89700c7`); `mcp/`
  already has the same exposure, so if it occurs it is an accepted precedent,
  documented rather than worked around.
- Vite: **no config change.** web → `@rsc/mcp` already proves that dev, SSR,
  and the adapter-node production build resolve a linked workspace's `.ts`.
- `.dockerignore`: `render/` is not excluded. No change.

### Documentation

- `CLAUDE.md` "Three npm workspaces in one repo" → four, adding a `render/`
  bullet.
- `CLAUDE.md` sanitizer invariant (currently lines 51–56) replaced. New text in
  substance: *the sanitizer is the XSS gate and there is exactly one, at
  `render/src/render.ts`; core and web both import it; its two entry points are
  deliberately not equivalent (`renderMarkdown` drops raw-HTML blocks at the
  parser, `sanitize` keeps benign text); `{@html}` appears in exactly one web
  component (`PostBody.svelte`); the DOMPurify preview in `MarkdownComposer.svelte`
  is cosmetic, not a gate.*
- `docs/superpowers/documentation/TESTING.md`: add the gate commands for
  `render` — and for `mcp`, which are missing today.
- Historical specs, plans and reviews are left untouched, per convention.

## Success criteria

1. The canonical fixture passes against its **existing expected string,
   unedited**.
2. Core's 6 feed/ingest tests and web's precedence / `enrichEntries` tests pass
   **without modification**.
3. `SANITIZE_CONFIG` is defined in **exactly one file** repo-wide (grep).
4. All gates green: core, web and render tests; core and render typecheck;
   `svelte-check` 0 errors / 0 warnings.
5. **The Cloudron image builds and a deployed canary (skyfleet.blue) renders
   posts and serves a well-formed feed.** The only gate that catches a missing
   Dockerfile line.
6. `npm audit` result unchanged — moving dependencies must not move versions.

## Out of scope

- The DOMPurify preview sanitizer in `MarkdownComposer.svelte`.
- Any change to sanitizer options, pipeline plugins, or their order.
- Renaming `web/src/lib/server/render.ts` or its exports.
- An `exports` field on `@rsc/render`.
- Roadmap items 2–5 from the 2026-08-06 review.

## Risks

| Risk | Mitigation |
|---|---|
| Dockerfile line forgotten → gate absent in production, build still green | Success criterion 5: deploy a canary and render before rolling the fleet |
| A fixture dropped while merging two suites | Union rule; review the merged test against both originals line by line |
| Non-hoisted deps land root-owned on the host bind mount | Verify after `npm ci`; accepted precedent (`mcp/`) if it occurs |
| Lockfile churn moves a version | `npm audit` and a lockfile diff review; versions must be identical |
