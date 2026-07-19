# Plan review — reply-context implementation plan (2026-07-19, rev = 36334e3)

High-effort review of `docs/superpowers/plans/2026-07-19-reply-context.md`
(4 finder angles: core sketches, choke-point coverage, web sketches, spec↔plan
alignment; every claim grounded in the real files, key ones re-verified
directly). **Verdict: one more rev before execution.** The architecture is
sound — the 4-task split, the parse shapes, the choke-point idea, and the
folded F1–F10 all check out — but P1–P5 would each derail an implementing
subagent, and two of the plan's own code sketches contain bugs.

**What verified clean (no action):** `toParsedItem` slot-by-slot arg
alignment in Step 5; defaulted-param-after-optional is fine for TS and
type-stripping; `discoverFeed` returns `{feedUrl, hentries}`;
`ingestItems(repo, bus, user, items)` order; MIGRATIONS tail = the
edited_at/post_revisions entry; the four sqlite touch-sites; `findPostByRef`
url-match; SSE live + **reconnect-replay genuinely closed** by
`joinedRowToEntry` + `emitNewPost` (the rev-1 catch is real); thread route
gated for both `viewed` and replies; feeds provably never re-emit context;
bus.ts sketch matches; no circular imports; `.reply-context` specificity beats
the global `a` accent rule; `enrichEntries`/api.ts spread (fields pass
through); F7 fold consistent (spec softened, plan matches); the no-URL
legible-orphan path coherent end-to-end.

## Findings (ranked)

### P1 — Task 4 Step 4 is unbuildable: no web component-render harness exists

**CONFIRMED.** `web/vitest.config.ts` sets no DOM environment; there is no
jsdom/happy-dom/`@testing-library/svelte` anywhere in web (all 19 tests are
pure unit/load/action tests; `render.test.ts` tests string functions, not
components). The mandated failing render test — mounted markup, `↗` is an
`<a href>`, `<b>x</b>` escaped — cannot be written in the existing harness,
and Global Constraints forbid new deps. **Fix (pick one in the plan):**
(a) test via `render()` from `svelte/server` (already installed — SSR to
string, assert on markup; needs the block extracted into a testable snippet or
the page rendered with mocked `data`), or (b) explicitly authorize the small
dev-dep harness, or (c) drop to a cheaper check (e.g. assert the four files
contain the identical block + no `{@html}` via a source-level test). Don't
leave the step as "extend the nearest render test" — there is none.

### P2 — The choke-point coverage claim is false: `GET /posts/:id/revisions` ships raw `getPost`

**CONFIRMED** (re-verified: `app.ts:127-130` returns
`c.json({ post, revisions })` with `post` from `service.getPost`). The web
history page fetches this endpoint, so after Task 2 a **resolved** remote
reply's untrusted author/snippet crosses the wire ungated — falsifying
"covers every client-facing path" and "getPost is internal". Benign today
(the history surface renders no context) but it's the exact
forgot-one-surface failure F8 exists to prevent. **Fix:** null the two fields
in that route's response (one line), or type `hideResolvedReplyContext` on a
minimal structural pick so it can wrap the `Post` there too. Note the latent
cousins: `POST /posts` and `PATCH /posts/:id` also serialize entries ungated —
safe only via the local-posts-never-have-context invariant; worth one comment.

### P3 — The plan's own `truncate` renders the forbidden bare-ellipsis snippet

**CONFIRMED.** Step 3's sketch appends `…` before trimming: an all-whitespace
(or whitespace-padded past 200 cp) `content.text` yields
`cut = 200-spaces + '…'` → `.trim()` → `'…'` (truthy) → snippet `'…'`,
rendering `In reply to x: "…"` — violating the spec's "empty/whitespace →
null". **Fix:** trim the raw string (or check emptiness) *before* the cut and
ellipsis; also `trimEnd()` the kept prefix before appending `…` to avoid the
cosmetic `word …`.

### P4 — Snippet-only context (author null) is stored but can never render

**CONFIRMED.** `parseInReplyTo` can return `contextAuthor: null` +
`contextSnippet: 'hi'` (cite with `content` but no `author`); Task 4's primary
guard is `!inReplyToPostId && post.replyContextAuthor`, so that entry falls to
the bare link and the stored snippet is dead data — a case neither spec rev 2
nor the plan addresses. **Fix (lazy):** at parse time, require an author for
any context: `if (!author) return { ref, contextAuthor: null,
contextSnippet: null }` — matches the "In reply to {author}" template, keeps
guard and storage consistent, one line + one test.

### P5 — "Four textually identical copies" breaks on post-detail

**CONFIRMED** (re-verified lines 79-85). Post-detail's affordance is a
**two-branch** structure — `{#if parent}…{:else if viewed?…}` — whose
fallback is `Replying to <a>↗ {url}</a>` inside a `.subnav` `<p>`, not the
`<a class="source">in reply to ↗</a>` of the other three. The representative
block neither slots into that if/else-if chain nor preserves the full-URL
fallback; "only the variable and wrapper differ" is not true there. **Fix:**
show the post-detail-specific block in the plan (insert the context case
between `{#if parent}` and the existing `{:else if}`, keeping `Replying to
… ↗ {url}` as the no-context fallback), and scope "textually identical" to
the three timeline surfaces.

### P6 — `import type` erasure trap on the Task 3 helper

**CONFIRMED** (re-verified: `bus.ts:2` and `sqlite.ts:5` import from
`types.ts` via `import type` only). `hideResolvedReplyContext` is a runtime
value; folding it into those existing lines type-checks clean and then
**erases at runtime** under Node's native type stripping →
`TypeError: hideResolvedReplyContext is not a function` on first timeline map
/ SSE emit. **Fix:** Step 4 must show the explicit value-import lines
(`import { hideResolvedReplyContext } from '../domain/types.ts'`), not just
"import the helper".

### P7 — Task 3's test file doesn't exist: it's `core/test/api.test.ts`, not `app.test.ts`

**CONFIRMED.** The Step 1 sketch and the Step 6 `git add core/test/app.test.ts`
name a nonexistent file — the commit would silently omit the test. The real
harness (`api.test.ts`) supports the sketch (`app.request('/timeline')`,
unauthenticated). **Fix:** name `api.test.ts` in both places.

### P8 — `truncate` has zero regression tests and the export claim is inconsistent

**CONFIRMED.** Spec Testing mandates truncate cases (code-point cut with `…`;
short/empty/null; emoji-at-the-boundary). Task 1's tests feed only short
snippets that never reach the cap; File Structure says "export …`truncate`"
but Step 3 implements it unexported and nothing imports it. The F9 fix (and
the subtle `n*2+2` prefix-slice) ships unguarded. **Fix:** export it and add
the spec's truncate tests, including a >200-cp string with an astral char at
the boundary and the P3 whitespace case.

### P9 — The author-only web case (F5's regression) has no test

**CONFIRMED.** Spec Testing mandates four web cases; Task 4 Step 4 asserts
only author+snippet + escaping. A block that renders `: "{snippet}"`
unconditionally re-ships F5's forbidden `""` for every author-only h-cite and
no test catches it. **Fix:** add the author-only assertion (`In reply to
aaronpk ↗`, no colon, no quotes) to whichever harness P1 lands on.

### P10 — Task 2's test sketch names a nonexistent lookup and hides the FK setup

**CONFIRMED.** No `getPostByGuid` exists on the repository (only
`getEditableByGuid`, whose narrow return shape lacks the context fields — a
false-negative trap); the workable path is `getPostsByAuthor` → find →
`getPost(id)`. And `posts.author_id` is an enforced FK — both the hand-built
parent and the reply need a `createRemoteUser` first (the existing
ingest.test.ts pattern), which the sketch's "(adapt…)" hides. Also
`insertPost` returns a boolean, not the Post. **Fix:** correct the sketch to
the real helpers.

## Minor notes (prose only)

- Plan header says "Spec: … (rev 2)" — stale; point it at rev 3 so no
  executor reconciles against the superseded §5 app-route gate.
- Task 3 writes a route test but has no "invoke the `hono` skill" step
  (CLAUDE.md mandates it for route tests); Task 4 models the right shape with
  its UI-skill step — mirror it.
- The render block's spacing (space before `↗`, none before `:`) rests on
  Svelte interior-whitespace collapse across the multiline block — fine as
  sketched, but the four hand-copies can drift invisibly without P1's test.
- `u/[handle]`'s inner `others` stacked-conversation loop renders no context
  block — benign today (orphans always group as their own `top`; `others` are
  resolved and gated), noted for completeness.
