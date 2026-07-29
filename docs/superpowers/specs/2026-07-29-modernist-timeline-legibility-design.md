# Modernist timeline legibility — design

**Status:** brainstormed and approved in conversation; not yet planned or implemented.

## Context

The Modernist design migration (`docs/superpowers/specs/2026-07-28-modernist-design-migration.md`,
shipped and merged) replaced RSC's magazine/editorial look with a flat,
rule-based system. After living with it, the operator's read: the overall
direction is right, but the timeline itself reads as *too* flat — hard to
tell where one post ends and the next begins at a glance, and the ruled
structure that works for section-level layout (nav, page-head, rail
boundaries) doesn't do enough for the post-to-post distinction a fast-scanned
social feed needs.

This is a **narrow refinement**, not a reversal of the migration: same
tokens, same accent, same zero-radius, same no-shadow-for-structure
principle. Three specific, verified changes to the post/byline component.

## Diagnosis (verified against the live app, both themes)

Three compounding causes, confirmed by screenshotting the real running app
before touching anything:

1. **The inter-post divider sits in the middle of already-adequate
   whitespace and cuts it in half.** `.post` (`web/src/app.css`) has
   `padding: var(--space-lg) 0` (24px top/bottom) plus a `border-bottom: 1px
   solid var(--color-border)`. The ~48px of combined padding between two
   posts is real, but the hairline exactly bisecting it makes each half read
   as "padding before a fence," and the 1px weight is identical to a data
   table's row divider — a post boundary and a table row boundary currently
   look the same.
2. **The byline meta row (kind label + date) and the author name compete at
   identical visual weight.** Both are Archivo 800; the only difference is
   size (11px vs 17px) and uppercase tracking on the meta row. Nothing tells
   the eye "this part is secondary, that part is who this is."
3. **No per-item visual anchor — but only on the home river specifically.**
   Verified by grep before writing this spec: the original migration's Task 4
   removed `<Avatar>` from **only** `web/src/routes/+page.svelte` (the home
   timeline). `web/src/lib/ReplyTree.svelte`, `web/src/routes/post/[id]/+page.svelte`
   (conversation root post), and `web/src/routes/u/[handle]/following/+page.svelte`
   **still render `<Avatar>` today and were never touched** — only the author
   lens (`web/src/routes/u/[handle]/+page.svelte`) never had it, confirmed
   during the original migration's own review. This means the flatness
   complaint is disproportionately about the home page specifically: it's the
   one primary surface missing what every other surface already has.
   Confirmed by live testing on the home river: reintroducing it there was
   the single largest improvement to scannability of the three changes
   tried, and it costs nothing structurally — `Avatar.svelte` already exists,
   is already `--radius: 0` square, and needs no new dependency or asset
   (feeds still carry no avatar images, so this ships as the existing
   letter-fallback, matching what the three untouched surfaces already show).

## Decisions (made in conversation, not to be re-litigated during planning)

- **Avatar returns to the river permanently** — this reverses
  `design-system/rsc/MASTER.md`'s current "dropped from the river" language.
  MASTER.md's Avatar section needs updating to reflect this as the shipped
  decision, not a deferred one.
- **Avatar applies everywhere a byline renders** — but per the diagnosis
  above, this only requires markup changes in **two** files:
  - `web/src/routes/+page.svelte` (home river) — restore the `<Avatar
    author={post.author} sourceName={post.sourceName} />` call and its
    import, removed in the original migration's Task 4.
  - `web/src/routes/u/[handle]/+page.svelte` (author lens) — add `<Avatar>`
    fresh; confirmed this file has never imported it.

  The other three byline surfaces (`web/src/lib/ReplyTree.svelte`,
  `web/src/routes/post/[id]/+page.svelte`'s root post,
  `web/src/routes/u/[handle]/following/+page.svelte`) **already render
  `<Avatar>` today and need no markup change** — only verify (during
  implementation) that they still look right once the shared `.post
  .byline-name { align-items: center }` CSS change below lands, since that
  rule applies to all of them identically.
- This is the small, per-post **letter-square** avatar (`.avatar`,
  1.75rem/28px, already defined in `app.css`) — **not** the larger 48px
  profile-style avatar MASTER.md separately describes for the author-lens
  page *header* (a different, still-genuinely-deferred concern about a
  larger portrait slot once feeds carry real images — out of scope here,
  not to be conflated with this per-post scanning aid).
- Spacing and typography changes are **global, `app.css`-only** — `.post`,
  `.timeline`, `.post .byline`, `.post .byline-name` are already shared
  classes with zero local per-page overrides (verified via grep before
  writing this spec), so one change in `app.css` applies consistently to
  every surface automatically. No page-by-page CSS work needed for those two
  changes — only the avatar needs markup changes, and only in the five files
  listed above.

## The three changes

### 1. Remove the inter-post hairline, widen the gap

```css
.timeline {
	gap: var(--space-sm); /* was 0 */
}
.post {
	border-bottom: none; /* was 1px solid var(--color-border) */
}
```
`.post`'s own `padding: var(--space-lg) 0` stays unchanged. Net effect:
~56px of pure whitespace between posts (24px + 8px gap + 24px), no rule,
proximity alone signals the boundary. Verified live: reads as clearly
separated without feeling like a hard cut.

The **2px local/remote left rule** (`.post::before`) is completely
untouched by this — it stays the non-negotiable local/remote signal
(colour + label text), independent of the horizontal divider being removed.

### 2. Quiet the byline meta, give the name slightly more presence

```css
.post .byline {
	font-weight: 400; /* was var(--font-heading-weight), i.e. 800 */
}
.post .byline-name strong {
	font-size: 1.125rem; /* was 1.0625rem */
}
```
Deliberately **not** touching `.post .byline`'s color (`--color-secondary`
stays) or adding opacity on top of it — an early live test used
`opacity: 0.75` stacked on an already-muted color and that's a contrast risk
this design system explicitly checks for (4.5:1 minimum, both themes,
independently — see MASTER.md's Pre-Delivery Checklist). Font-weight alone
gets the "this recedes" effect without touching contrast ratios; verify
contrast is unaffected during implementation regardless, since `.post
.byline` also carries other content (source-host label, edited marker) whose
contrast should be re-checked.

This is a **narrow, byline-scoped override** of the 800-weight "uppercase
label" pattern MASTER.md calls its system's workhorse — everywhere else that
pattern is used (`.badge-kind`, table headers, `.here`, admin captions) is
untouched. The byline is the one place two label-weight elements compete
directly for attention in the same line, which is why it gets the exception.

### 3. Reintroduce the letter-avatar in the byline-name row

In the two files that lost/never had it, add `<Avatar author={...}
sourceName={...} />` as the first child of `.byline-name`, before the
`<strong>` name — exact prop expression per file:

- `web/src/routes/+page.svelte`: `<Avatar author={post.author}
  sourceName={post.sourceName} />` plus `import Avatar from
  '$lib/Avatar.svelte'` (both were removed in Task 4; restore verbatim).
- `web/src/routes/u/[handle]/+page.svelte`: `<Avatar author={post.author}
  sourceName={post.sourceName} />` plus a fresh `import Avatar from
  '$lib/Avatar.svelte'` (check the actual loop variable name — the file's
  `{#each groups as { top: post, others }}` binds it as `post`).

The other three surfaces (`ReplyTree.svelte`, `post/[id]/+page.svelte`'s
root, `following/+page.svelte`) already have the correct call — no markup
change, just re-verify their rendering once change #2's CSS lands.

```css
.post .byline-name {
	align-items: center; /* was baseline — the avatar needs vertical centering
	                         against the name text, baseline alignment looks
	                         wrong with a fixed-height square avatar in the row */
}
```

`Avatar.svelte` itself needs no changes — it already renders the
`--radius: 0` letter-square (`.avatar`, 1.75rem, `--color-muted` background,
1px border) and already accepts `author`/`sourceName` props matching every
call site's existing data shape.

## MASTER.md updates required

- **Avatar section**: replace "Dropped from the river... Identity in the
  meantime lives in the name row" with a description matching the shipped
  state — avatar present in the byline-name row everywhere, still a letter
  square until feeds carry real images (at which point it grows the
  `.grayscale` `<img>` branch already prepared in `Avatar.svelte`, unchanged
  by this work).
- **Byline description**: note the font-weight exception for the meta row
  relative to the general uppercase-label rule, and why.
- Pre-Delivery Checklist and Anti-Patterns sections should be spot-checked
  for any line that assumed "avatar dropped from the river" — none currently
  reference it directly, but verify during implementation.

## Non-negotiables carried forward unchanged

Everything from the original Modernist migration's non-negotiables list
still applies and is untouched by this work: no-JS, live-prepend
jank-safety, local/remote legibility via rule colour **and** label text
(this spec doesn't touch either signal), both themes independently
verified, 44px touch targets, `prefers-reduced-motion`, focus ring. This
spec adds one new thing to verify: **contrast on the now-lighter-weight
byline meta row, both themes, independently** — flagged above, not assumed.

## Scope check

Three CSS rule changes (all in `app.css`) plus a markup addition in two
files, with three already-correct surfaces to re-verify rather than change.
Small enough for a single implementation plan, likely 2-3 tasks (global CSS
change; avatar restoration in the two files + verification of the other
three; MASTER.md update). Not large enough to warrant the
multi-task-with-heavy-parallelization structure the original migration
plan used.
