# Modernist Timeline Legibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the "too flat to scan" timeline complaint from the shipped
Modernist design migration — three targeted, verified changes (remove the
inter-post hairline in favor of whitespace, quiet the byline meta relative
to the author name, restore the letter-avatar on the two surfaces that
lost/never had it) — without touching any other part of the migration.

**Architecture:** One global CSS change (`app.css`, three rule edits) plus a
markup restoration in exactly two Svelte files. Three other byline surfaces
already render correctly today and are explicitly not touched. No new
dependencies, no behavior change, no schema/API change.

**Tech Stack:** SvelteKit (Svelte 5 runes), `web/src/app.css`.

**Source material:** Read
`docs/superpowers/specs/2026-07-29-modernist-timeline-legibility-design.md`
first — it contains the full diagnosis, the exact current-vs-new CSS
values, and the verified per-file markup shapes this plan's tasks are
transcribed from.

## Global Constraints

- No new dependencies, no new CSS custom-property names — only value/rule
  changes to existing classes (`.timeline`, `.post`, `.post .byline`,
  `.post .byline-name`).
- The **2px local/remote left rule** (`.post::before` / `.post.remote::before`)
  and the kind label text are completely untouched — local/remote legibility
  must still be signalled by rule colour **and** label text, never colour
  alone.
- **Only** `web/src/routes/+page.svelte` and `web/src/routes/u/[handle]/+page.svelte`
  get markup changes. `web/src/lib/ReplyTree.svelte`,
  `web/src/routes/post/[id]/+page.svelte`, and
  `web/src/routes/u/[handle]/following/+page.svelte` already render
  `<Avatar>` correctly today — do not add, remove, or modify Avatar usage in
  these three files. If any task's own testing suggests a change is needed
  in one of these three, stop and report rather than editing them — that
  would mean the spec's verified claim about their current state was wrong,
  which is a plan defect to escalate, not silently route around.
- Both themes (light/dark) must be checked independently for every visual
  change — this design system's dark mode is not an inversion pass.
- `--radius: 0` stays on the avatar (no rounded corners) — `Avatar.svelte`
  itself is not modified by this plan; its existing `.avatar` CSS already
  satisfies this.
- Contrast: the byline meta row's font-weight change must not be
  accompanied by any color/opacity change (the spec explicitly rejected an
  `opacity: 0.75` variant tested live as a contrast risk) — verify 4.5:1
  minimum on the byline row, both themes, after the change.
- If a test breaks because markup legitimately moved (e.g. a new `.avatar`
  element now present in a snapshot-style assertion), update the test. If a
  test fails for any other reason, that's a bug in the task — stop and find
  the root cause, don't paper over it.

---

### Task 1: Global CSS — whitespace, byline hierarchy, avatar alignment

**Files:**
- Modify: `web/src/app.css`

**Interfaces:**
- Consumes: nothing new.
- Produces: three rule changes consumed by every page rendering `.post`/`.timeline`/`.byline` markup (all pages, automatically, since these are shared global classes with zero local per-page overrides — verified in the spec).

- [ ] **Step 1: Read the current rules to confirm exact context**

```bash
grep -n "^\.timeline {" -A 8 web/src/app.css
grep -n "^\.post {" -A 12 web/src/app.css
grep -n "^\.post \.byline {" -A 12 web/src/app.css
grep -n "^\.post \.byline-name {" -A 8 web/src/app.css
```
Confirm the current values match: `.timeline { gap: 0; }`, `.post { ...
border-bottom: 1px solid var(--color-border); ... }`, `.post .byline {
... font-weight: var(--font-heading-weight); ... }`, `.post .byline-name {
... align-items: baseline; ... }`. If any of these have drifted from what's
shown, stop and report — the plan's exact replacement text below assumes
this starting state.

- [ ] **Step 2: Remove the inter-post hairline, widen the gap**

Change:
```css
.timeline {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	flex-direction: column;
	gap: 0;
}
```
to:
```css
.timeline {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	flex-direction: column;
	gap: var(--space-sm);
}
```

Change:
```css
.post {
	display: grid;
	grid-template-columns: 2px minmax(0, 1fr);
	gap: var(--space-lg);
	background: none;
	border: 0;
	border-bottom: 1px solid var(--color-border);
	border-radius: var(--radius);
	padding: var(--space-lg) 0;
	overflow-wrap: break-word;
}
```
to:
```css
.post {
	display: grid;
	grid-template-columns: 2px minmax(0, 1fr);
	gap: var(--space-lg);
	background: none;
	border: 0;
	border-radius: var(--radius);
	padding: var(--space-lg) 0;
	overflow-wrap: break-word;
}
```
(Only the `border-bottom` line is removed — nothing else in this rule
changes. Do not touch `.post::before` / `.post.remote::before` at all.)

- [ ] **Step 3: Quiet the byline meta, give the name slightly more presence**

Change:
```css
.post .byline {
	display: flex;
	align-items: baseline;
	gap: var(--space-3);
	flex-wrap: wrap;
	font-family: var(--font-heading);
	font-size: 0.6875rem;
	font-weight: var(--font-heading-weight);
	letter-spacing: 0.1em;
	text-transform: uppercase;
	color: var(--color-secondary);
}
```
to:
```css
.post .byline {
	display: flex;
	align-items: baseline;
	gap: var(--space-3);
	flex-wrap: wrap;
	font-family: var(--font-heading);
	font-size: 0.6875rem;
	font-weight: 400;
	letter-spacing: 0.1em;
	text-transform: uppercase;
	color: var(--color-secondary);
}
```
(Only `font-weight` changes, from `var(--font-heading-weight)` to the
literal `400`. Color, size, tracking, transform all stay exactly as they
are — this is deliberately not touching contrast.)

Change:
```css
.post .byline-name strong {
	font-family: var(--font-heading);
	font-weight: var(--font-heading-weight);
	font-size: 1.0625rem;
}
```
to:
```css
.post .byline-name strong {
	font-family: var(--font-heading);
	font-weight: var(--font-heading-weight);
	font-size: 1.125rem;
}
```
(Only `font-size` changes.)

- [ ] **Step 4: Fix avatar vertical alignment in the byline-name row**

Change:
```css
.post .byline-name {
	display: flex;
	align-items: baseline;
	gap: var(--space-sm);
	flex-wrap: wrap;
	margin-top: var(--space-sm);
}
```
to:
```css
.post .byline-name {
	display: flex;
	align-items: center;
	gap: var(--space-sm);
	flex-wrap: wrap;
	margin-top: var(--space-sm);
}
```
(Only `align-items` changes, from `baseline` to `center`. This class only
exists on the home river — it has no effect anywhere else, since no other
file in this codebase has a `.byline-name` element.)

- [ ] **Step 5: Typecheck and svelte-check**

```bash
npm run typecheck -w core && npm run check -w web
```
Expected: 0 errors both (pure CSS value changes, no markup/type surface
touched).

- [ ] **Step 6: Run the full web test suite**

```bash
npm test -w web
```
Expected: all passing, unchanged count — this task touches no markup, so no
test should be affected. If anything fails, stop and find the actual cause
before proceeding; do not assume it's unrelated.

- [ ] **Step 7: Visual check — both themes, before Task 2 lands**

Bring up a dev server against the shared, already-running core (do NOT
touch the shared main-checkout's docker containers — check first with `ps
aux`/`ss -tlnp` for anything already on 5173/8787, and never kill anything
you didn't start yourself):
```bash
echo "CORE_API_URL=http://localhost:8787" > web/.env
npm run dev -w web
```
Vite will report whichever port it picked (5173 is likely taken). Using a
real browser tool (prefer one that gives genuine screenshots/computed
styles over one that returns synthetic geometry — cross-check with a real
screenshot if uncertain), confirm on the home timeline (`/`), both light
and dark:
- No line/rule between posts; clear whitespace gap instead.
- The `.post::before` 2px local/remote left rule is still present and
  correctly coloured per post (unaffected by this task).
- The byline meta row (kind + date) visibly reads lighter/thinner than the
  author name below it.
- Measure contrast on the byline meta row text against its background in
  both themes (real computed `color`/`background-color`, not an assumption)
  — confirm it still meets 4.5:1. If it doesn't, stop: this task's Global
  Constraints explicitly forbid a contrast regression, and the spec's own
  reasoning for keeping color/opacity untouched was to avoid exactly this —
  something would be wrong with the starting assumption, not something to
  patch around with a color change of your own invention.

Note the `<Avatar>` element will not exist on the home river/author-lens
pages yet (Task 2 hasn't landed) — this is expected, not a bug to fix here.

Clean up: kill only your own dev server process by exact PID (no broad
`pkill` pattern — the shared stack's containers run similarly-named
processes and must not be touched), remove `web/.env`.

- [ ] **Step 8: Commit**

```bash
git add web/src/app.css
git commit -m "$(cat <<'COMMIT'
design: whitespace-separated timeline, byline hierarchy

Removes the inter-post hairline (was bisecting an already-adequate 48px
gap) in favor of pure whitespace separation, and gives the byline meta
row a lighter font-weight relative to the author name so the two stop
competing at identical visual weight. Local/remote's 2px rule + label
signal is untouched.

developed with the help of AI tools
COMMIT
)"
```

---

### Task 2: Restore the letter-avatar on the two affected surfaces

**Files:**
- Modify: `web/src/routes/+page.svelte`
- Modify: `web/src/routes/u/[handle]/+page.svelte`
- Test: `web/src/routes/page.load.test.ts`, `web/src/routes/page.actions.test.ts`, `web/src/routes/u/[handle]/u-page.test.ts`

**Interfaces:**
- Consumes: `Avatar.svelte`'s existing props (`author: TimelineEntry['author']`, `sourceName?: string | null`) — unchanged, no modification to `Avatar.svelte` itself in this plan.
- Produces: no new exports — both are leaf page components.

- [ ] **Step 1: Read both files' current byline markup to confirm exact context**

```bash
grep -n "byline-name\|import ThemeToggle\|<script" web/src/routes/+page.svelte | head -10
sed -n '1,20p' web/src/routes/u/\[handle\]/+page.svelte
grep -n "byline\|<script\|{#each groups" web/src/routes/u/\[handle\]/+page.svelte | head -10
```
Confirm: `+page.svelte` has a `.byline-name` div (no `<Avatar>` inside it
currently, no `Avatar` import); `u/[handle]/+page.svelte` has a single flat
`.byline` div (no `.byline-name`, no `<Avatar>`, no `Avatar` import), with
the loop `{#each groups as { top: post, others } (post.threadRootId ??
post.id)}` binding the variable as `post`. If either doesn't match, stop
and report — the exact edits below assume this shape.

- [ ] **Step 2: Restore Avatar in the home river (`+page.svelte`)**

Add the import, alongside the other `$lib` imports near the top of the
`<script>` block:
```ts
import Avatar from '$lib/Avatar.svelte'
```

In the byline-name block, add `<Avatar>` as the first child, before the
`<strong>`:

```svelte
				<div class="byline-name">
					<Avatar author={post.author} sourceName={post.sourceName} />
					<strong>{post.sourceName ?? post.author.displayName}</strong>
					{#if post.publisherId}
						<a class="handle" id="by-{post.id}" href="/p/{encodeURIComponent(post.publisherId)}">{post.author.displayName}</a>
					{:else if post.author.handle}
						<a class="handle" id="by-{post.id}" href="/u/{post.author.handle}">@{post.author.handle}</a>
					{/if}
				</div>
```
(Only the `<Avatar ... />` line is new — everything else in this block is
unchanged, shown here only for exact insertion context.)

- [ ] **Step 3: Restore Avatar in the author lens (`u/[handle]/+page.svelte`)**

Add the import, alongside the other `$lib` imports:
```ts
import Avatar from '$lib/Avatar.svelte'
```

In the byline block, add `<Avatar>` as the first child, before the
conditional `<strong>`:

```svelte
				<div class="byline">
					<Avatar author={post.author} sourceName={post.sourceName} />
					{#if post.sourceName}<strong>{post.sourceName}</strong>{/if}
					<a class="permalink" id="by-{post.id}" href="/post/{post.id}"><time datetime={post.publishedAt}>{post.publishedAt.slice(0, 10)}</time></a>
					<EditedMarker {post} />
				</div>
```
(Only the `<Avatar ... />` line is new.)

- [ ] **Step 4: Confirm the three other byline surfaces are untouched**

```bash
git diff --stat
```
Expected: exactly the two files above, nothing under `ReplyTree.svelte`,
`post/[id]/+page.svelte`, or `following/+page.svelte`. If any of those
three appear in the diff, something went wrong — revert and redo just the
two intended files.

- [ ] **Step 5: Typecheck and svelte-check**

```bash
npm run typecheck -w core && npm run check -w web
```
Expected: 0 errors both.

- [ ] **Step 6: Run the targeted and full test suites**

```bash
npm test -w web -- page.load page.actions u-page
npm test -w web
```
Expected: both pass. If `u-page.test.ts` or the page tests assert on exact
byline child structure/count and now fail because `<Avatar>` is present,
update the assertion to match the new (correct) structure — this is
markup that legitimately moved. If a test fails for a different reason
(e.g. `post.author`/`post.sourceName` not being what `Avatar` expects for
some data shape), that's a real bug — stop and find the root cause.

- [ ] **Step 7: Visual check — both themes, both pages**

Bring up a dev server the same way as Task 1, Step 7 (reuse the same
shared-core pattern, same cleanup discipline). Confirm on `/` (home) and
`/u/<a-real-handle>` (author lens), both light and dark:
- A small square letter-avatar now renders in every post's byline, aligned
  with the author name (not baseline-shifted oddly against it).
- The avatar has zero corner radius (a true square, not rounded).
- Local vs remote posts are still visually distinguished by the 2px rule +
  label text (the avatar addition doesn't interfere with or duplicate that
  signal).
- Spot-check `/post/<id>` (a conversation with replies) and
  `/u/<handle>/following` — confirm their avatars still render exactly as
  they did before this plan (unchanged), i.e. this task didn't
  accidentally affect them.

Clean up: kill only your own dev server process by exact PID, remove
`web/.env`.

- [ ] **Step 8: Commit**

```bash
git add web/src/routes/+page.svelte web/src/routes/u/\[handle\]/+page.svelte
# plus any test files updated in Step 6
git commit -m "$(cat <<'COMMIT'
design: restore the letter-avatar on the home river and author lens

These are the only two byline surfaces that ever lost (or never had)
the avatar; the other three (ReplyTree, conversation root, following
page) already render it correctly and are untouched.

developed with the help of AI tools
COMMIT
)"
```

---

### Task 3: MASTER.md update and final verification

**Files:**
- Modify: `design-system/rsc/MASTER.md`

**Interfaces:** None — documentation only, describing the now-shipped state.

- [ ] **Step 1: Read the current Avatar section**

```bash
grep -n "Avatar" design-system/rsc/MASTER.md
```
Find the paragraph describing the avatar as "Dropped from the river... a
second marker on the same left edge as the 2px kind rule... Identity in the
meantime lives in the name row."

- [ ] **Step 2: Rewrite it to describe the shipped state**

Replace that paragraph with something to this effect (adapt wording to fit
the surrounding document's voice, but the factual content must match):

> **Avatar.** Present in every post's byline as a small (1.75rem)
> `--radius: 0` letter-square — the initial of the author's display name (or
> `sourceName` for an aggregate lens), matching `rss.chat`'s original
> `populateAvatar` fallback. Feeds carry no avatar images today, so the
> letter *is* the avatar; `Avatar.svelte` already has the `<img>`/`.grayscale`
> branch prepared for when a real image URL becomes available, unchanged by
> this revision. The author-lens page header's own, separate 48px
> profile-style avatar slot remains a distinct, still-deferred concern — not
> to be confused with this per-post scanning aid.

- [ ] **Step 3: Note the byline font-weight exception**

Find MASTER.md's description of the 11px uppercase label as "the workhorse
of this system" (used for `.badge-kind`, kind rules, etc.) and add a short
note that the post byline's meta row is a deliberate, narrow exception:
lighter weight (400, not 800) specifically because it sits on the same line
as the author name and the two would otherwise compete at identical weight
— every other use of the label style elsewhere in the app is unchanged.

- [ ] **Step 4: Spot-check the Pre-Delivery Checklist and Anti-Patterns sections**

```bash
grep -n "avatar\|Avatar" design-system/rsc/MASTER.md
```
Confirm no remaining line in either section still asserts "avatar dropped
from the river" or similar as if it were current — the spec's own review
found none referencing it directly, but re-confirm against the actual
current file text, not the spec's memory of it.

- [ ] **Step 5: Full verification pass**

```bash
npm test -w core
npm test -w web
npm run typecheck -w core
npm run check -w web
```
Expected: all green (core suite untouched by this whole plan, included here
only as the standard full-repo gate before calling this done).

- [ ] **Step 6: Commit**

```bash
git add design-system/rsc/MASTER.md
git commit -m "$(cat <<'COMMIT'
docs: MASTER.md reflects the restored avatar and byline weight exception

developed with the help of AI tools
COMMIT
)"
```

---

### Task 4: Whole-change review

- [ ] Dispatch a task reviewer (per superpowers:subagent-driven-development)
      covering all three commits together as one diff — small enough not to
      need a separate "whole-branch" review pass the way the original
      14-task migration did, but still worth one fresh set of eyes on the
      combined result before merging: confirm the three CSS changes and the
      two avatar restorations compose correctly (e.g. that Task 1's
      `align-items: center` and Task 2's inserted `<Avatar>` actually look
      right together, not just individually), and that the three
      untouched surfaces are genuinely unchanged in the final diff.
- [ ] Fold any findings, re-run the full verification from Task 3 Step 5,
      then hand back to the operator for the merge/push decision — nothing
      merges to `main` without explicit approval (this plan's execution
      should happen in a dedicated worktree per
      superpowers:using-git-worktrees, merged back the same way the
      previous Modernist migration was).
