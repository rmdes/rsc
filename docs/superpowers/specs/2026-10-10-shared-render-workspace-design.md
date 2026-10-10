# Shared render workspace — Design

**Status:** Rev 2, 2026-10-10. Rev 1 approved section-by-section in
brainstorming; rev 2 folds a clean-context ponytail review (verdict on rev 1:
NOT READY — 1 Critical, 4 Important). Every folded finding was re-verified
against the code before folding. See "Rev 2 changes" at the end.
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
| ~9 duplicated deps | **12**: 10 runtime (`unified`, `remark-parse`, `remark-gfm`, `remark-breaks`, `remark-emoji`, `remark-rehype`, `rehype-highlight`, `rehype-stringify`, `sanitize-html`, `unist-util-visit`) + `@types/hast` + `@types/sanitize-html`. In **core**, none is imported outside the twin. In **web**, two are: `MarkdownComposer.svelte:26-27` dynamically imports `remark-breaks` and `rehype-highlight` for the client preview (rev 1 claimed "none" — a static-import-only grep missed these). Ranges are copied verbatim: `sanitize-html` and `@types/sanitize-html` are caret ranges, not exact pins. |
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

A fourth npm workspace containing **only the source**. No test runner, no
tsconfig of its own:

```
render/
  package.json        "@rsc/render", "type": "module"
  src/render.ts       the gate
```

Its tests live in core's suite and its types are checked by core's `tsc`, which
follows the import into the realpath `render/src/render.ts` (to be confirmed at
implementation by planting a deliberate type error — see success criteria).
A runner of its own would need `vitest`, which does **not** hoist in this repo
(the lockfile has it only at `core/`, `mcp/`, `web/node_modules`), so it would
install into `render/node_modules` on the dev host bind mount, root-owned —
the bug class fixed in `89700c7`. Add a runner only if a consumer core
doesn't cover ever appears.

- Root `package.json` `workspaces`: `["core", "web", "mcp"]` → add `"render"`.
- `render/package.json` declares the 10 runtime deps (as `dependencies`) and
  the two `@types` packages, **ranges copied verbatim** from today.
- `core/package.json` **removes all 12** — nothing else in core uses them.
- `web/package.json` **removes nothing.** This follows the actual mcp
  precedent (`acec537`, "declare mcp's deps in web"): adapter-node externalizes
  only `pkg.dependencies` (`node_modules/@sveltejs/adapter-node/index.js:75-77`)
  and bundles everything else with rollup. Today the gate's deps are external
  in `web/build`; undeclaring them would inline sanitize-html, htmlparser2,
  postcss and highlight.js into the production bundle via rollup-commonjs — a
  different artifact for the XSS gate, violating the pure-move rule. Two of
  them are also used directly by `MarkdownComposer.svelte`. Web's `@types`
  stay too, so `svelte-check` keeps resolving them when it follows the import.
- Net: the gate's **code** is single-sourced; the dependency **declaration**
  is removed from core only. That is the honest scope.
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

**→ `core/test/render.test.ts`** (gate behaviour; imports
`@rsc/render/src/render.ts`, runs in core's suite):

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
  output) — exercises the config, not web policy.
- **Dedupe while merging.** Drop exact duplicates: core's "hljs classes
  survive" and "small fence still gets hljs" use the same input with
  overlapping assertions — keep one. Web's "GFM autolink" is already covered by
  core's SEC-4 test (autolink + forced `rel`) — drop it. The smaller tests the
  canonical fixture also pins (`<br>`, emoji, `del`) stay: they are failure
  locators, not duplicates.

**core `rich-content.test.ts` keeps its 6 feed/ingest contracts:**
`source:markdown` captured into `ParsedItem.contentMarkdown`; RSS dual contract;
RSS pass-through; JSON Feed local output; JSON Feed ingest prefers
`content_html`; reply + markdown co-occurrence. These exercise `feed.ts`, which
calls the gate.

**web `render.test.ts` keeps 4:** precedence; `enrichEntries`; the DOMPurify
preview parity pin; and **one** hostile smoke test through `renderPostHtml`
proving the adapter routes remote HTML into `sanitize`. That smoke test is
**load-bearing**: the precedence test passes even if the adapter were written
`: post.content` instead of `: sanitize(post.content)` — only the smoke test
catches remote HTML shipping unsanitized.

**Liveness rule.** Every negative assertion keeps a paired positive one. A test
of only negatives passes when the function returns `''` — mutation-proven on
both twins on 2026-08-07. Each entry point gets its own liveness assertion.

**Expected count change.** Core's `rich-content.test.ts` 19 → 6 plus a new
`core/test/render.test.ts` of ~14; web 17 → 4. About 36 → 24 overall.
Duplicates collapse; coverage does not shrink. The plan pins exact numbers.

### Packaging

- `cloudron/Dockerfile`: add `COPY render/package.json render/package.json`
  beside the mcp line (`:21`), before `npm ci`, with a comment stating the
  failure mode: without it `npm ci` silently installs none of render's deps and
  **the XSS gate fails to load in production** — a build that succeeds and a
  runtime that cannot render. This is why success criterion 5 is mandatory.
- `compose.yaml`: **no change.** Core's single `npm ci` populates the shared
  root `node_modules`, where the `@rsc/render` symlink lands. Each of the 12
  packages has exactly one version in the lockfile, so they stay hoisted at
  root; with no test runner in render, nothing has a reason to install into
  `render/node_modules`. Checked at implementation, not assumed.
- Vite: **no config change**, *because web keeps declaring the deps*. web →
  `@rsc/mcp` proves a linked workspace's `.ts` resolves in dev, SSR and the
  adapter-node build — but only with its deps declared in web (`acec537`).
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
- No `TESTING.md` change: render's tests run inside core's existing gate.
- "Twin" wording survives in a few comments and test names
  (`history/+page.server.ts:17`, `history.load.test.ts:14,39`,
  `u-page.test.ts:70`, `item-review.test.ts:234`, `MarkdownComposer.svelte:44`,
  `TESTING.md:25`). Harmless and out of scope for a pure move; this spec does
  not claim the word is gone.
- Historical specs, plans and reviews are left untouched, per convention.

## Success criteria

1. The canonical fixture passes against its **existing expected string,
   unedited**.
2. Core's 6 feed/ingest tests and web's precedence / `enrichEntries` tests pass
   **without modification**.
3. `SANITIZE_CONFIG` is defined in **exactly one file** repo-wide (grep).
4. All gates green: core and web tests; core typecheck; `svelte-check`
   0 errors / 0 warnings. **Core's `tsc` proven to cover render**: plant a type
   error in `render/src/render.ts`, confirm `npm run typecheck -w core` fails,
   revert.
5. **Local production-image check, before any deploy:** build
   `cloudron/Dockerfile` locally, run it, and confirm a page renders and a feed
   is well-formed; plus `node -e "import('@rsc/render/src/render.ts')"` inside
   the image. This catches a missing Dockerfile COPY line, confirms type
   stripping across the workspace on the image's **Node 22.22.2** (the earlier
   probe ran on the dev container's Node 24), and needs no live instance.
6. Lockfile diff: the version of every one of the 12 packages is unchanged.
   (Each has a single lockfile entry, so an unchanged version set is the proof.)

Deployment afterwards follows the normal canary procedure — it is no longer
the test.

## Out of scope

- The DOMPurify preview sanitizer in `MarkdownComposer.svelte`.
- Any change to sanitizer options, pipeline plugins, or their order.
- Renaming `web/src/lib/server/render.ts` or its exports.
- An `exports` field on `@rsc/render`.
- Roadmap items 2–5 from the 2026-08-06 review.

## Risks

| Risk | Mitigation |
|---|---|
| Dockerfile line forgotten → gate absent in production, build still green | Criterion 5: local image build + run, before any deploy |
| Undeclaring deps in web changes the production bundle | Web removes nothing (rev 2, following `acec537`) |
| A fixture dropped while merging two suites | Union rule; review the merged test against both originals line by line |
| Adapter written `: post.content` → remote HTML unsanitized | Web's retained hostile smoke test fails |
| Lockfile churn moves a version | Criterion 6 lockfile diff |

## Rev 2 changes

Folded from the clean-context review; each finding re-verified first.

- **C1 (Critical)** — rev 1 removed the 10 runtime deps from web. That
  inverts the mcp precedent it cited and would inline the gate's deps into the
  production web bundle. Now: web removes nothing; core removes all 12.
- **I1** — rev 1's "none imported outside the twins" was false for web
  (`MarkdownComposer.svelte:26-27`, dynamic imports missed by a static grep).
  Fact table corrected.
- **I2 + P1** — vitest does not hoist here, so render's own runner would
  install root-owned files on the dev bind mount. Cut: render is source only;
  its tests live in core's suite; core's `tsc` covers it (proven by a planted
  error).
- **I3** — "exact pins" was false for `sanitize-html` and its types. Now
  "ranges copied verbatim".
- **I4 + P4** — rev 1 used a live production deploy as a test step, and the
  type-stripping probe ran on Node 24 while production runs 22.22.2. Now a
  local image build + run, on the real image.
- **P2** — dropped the unrelated "add mcp's TESTING.md commands" item.
- **P3** — two exact duplicate tests dropped while merging.
- **P5** — `npm audit` criterion merged into the lockfile diff check.
- **M1** — residual "twin" wording listed and explicitly left out of scope.
- **Kept as load-bearing** (confirmed by the review): web's `render.ts` path
  and exports, two entry points, the Dockerfile COPY line with its comment,
  the liveness rule, the security comments moved verbatim, and web's hostile
  smoke test.
