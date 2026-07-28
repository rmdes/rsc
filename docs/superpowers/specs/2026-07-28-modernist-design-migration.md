# Modernist design migration — spec

**Status:** design already produced externally (Claude Design tool), reviewed, and
handed off as `MASTER.md` + `app.css` + `svelte-changes.md` + `MIGRATION.md`
(source: `C:\Users\Rick\Downloads\RSC design with Modernist preview\handoff`,
not checked into this repo). This document is the repo-side record of that
handoff plus the decisions made while turning it into an implementation plan.
It is not a from-scratch brainstorm — the visual system is a given; what
follows is what's needed to apply it correctly to *this* codebase.

## What changed and why

RSC moves from its current magazine/editorial look (Libre Bodoni headings,
rounded cards, shadows, pill badges) to **Modernist**: flat, architectural,
set entirely in Archivo, zero corner radius, organised by 2px/1px rules and
flush-left alignment rather than cards and elevation.

Two things do **not** change:

- The accent stays **RSS orange** (`#C2410C` light / `#EA580C` dark).
  Modernist's own accent is red — never use it.
- Every existing CSS custom-property **name** is unchanged; only values and
  shape rules change. Routes not explicitly touched below inherit the new
  look for free.

Full component/page specs, colour table, type scale, and the Pre-Delivery
Checklist live in `design-system/rsc/MASTER.md` once Task 1 of the plan lands
it — that file is the enduring source of truth from here on, not this spec.

## Decisions made during planning

1. **Three-state theme toggle (System / Light / Dark).** The handoff flagged
   that `localStorage.theme` is only ever set, never cleared, making "follow
   system preference" unreachable once a user has ever tapped the toggle, and
   explicitly said to raise this rather than decide it. **Decision: fix it
   now**, as part of the mobile menu's segmented `ThemeToggle` control (the
   only place in this system with room for three options).
2. **Author-lens stat row (posts/following/followers).** No cheap existing
   endpoint returns these three counts for a handle today, so investigation
   was required before finalizing this plan. **Result: all three are cheap.**
   Following is already free (existing `v2.publicFollowing`, `.length`).
   Followers is a single indexed `COUNT` on the live `follows` table
   (`Repository.countFollowers`, already used in production). Posts needed
   one new method (`countPostsByAuthor`), but it's a single indexed `COUNT`
   against `posts_author_pub_idx`, which already exists. All three ship with
   real data — see Task 7 for the full, concrete implementation (one new
   core route, tested).
3. **Skip §2f (rivers panel → sources list swap in the desktop meta rail).**
   The handoff itself labels this optional. It's a feature reorg (surfacing
   OPML import/export in the rail), not part of the visual migration — logged
   as a follow-up idea instead of folded into this branch's scope.

## Corrections to the handoff (drift since it was authored)

The handoff explicitly warns it was "produced against this codebase" and may
have drifted. Verified against the current tree, four real gaps found:

1. **`app.html` still links Libre Bodoni + Public Sans directly** (a
   `<link rel="stylesheet">` in the `<head>`, independent of `app.css`'s own
   `@import` for Archivo). Neither `MIGRATION.md` nor `svelte-changes.md`
   mentions `app.html`. Left alone, the old fonts still download (wasted
   bytes, and a first-paint risk) even though Archivo renders correctly via
   `app.css`. Fix: delete the stale `<link>`, rely on `app.css`'s `@import`
   alone (single source, matches how the handoff already ships it).
2. **The mobile menu's "New post" link (`/?compose=1`) does nothing.**
   `ComposerDialog.svelte` has no query-param handling — it only opens via
   its own button's click handler. Meanwhile `.tools { display: none; }`
   below 768px in the new `app.css` (confirmed in the handoff's own file),
   with the CSS's own comment stating "the tools rail's content lives in the
   menu panel at this width" — but the `svelte-changes.md` §5 snippet's
   `nav-menu-panel` never actually includes `<ComposerDialog>` or the real
   subscribe form, only static text links. Also: composing/subscribing has
   never worked from any route other than `/` — there's no existing
   cross-route form-action plumbing to reuse, and building one is a real
   feature, not a visual fix. Fix (Task 8): render a second real
   `<ComposerDialog>`/subscribe form instance directly in the layout's mobile
   panel (same `draftKey`, so both stay in sync via `localStorage`), gated to
   `page.url.pathname === '/'` — i.e., reachable exactly where it already
   works today, just now visible at narrow widths too. "New post" is a
   same-page anchor into that panel, shown only on `/`. Compose-from-any-route
   is logged as a follow-up idea, not built here.
3. **`ReplyTree.svelte`, not `post/[id]/+page.svelte`, is where most
   `reply.id === highlightId` bylines render.** The handoff's one-liner names
   the file where the *root* post's highlight lives, but every non-root
   highlighted post renders through `ReplyTree.svelte`'s own
   `class:highlight={reply.id === highlightId}`. The "You are here" span
   needs adding in both places to cover every position in the tree.
4. **`admin/feeds/+page.svelte` cannot safely become a literal `<table>`.**
   MASTER.md's blanket "Users and feeds are `.table`s" was written against a
   simpler admin surface than what exists today: nested federation members,
   per-row moderation panels with multiple stacked action forms (block/
   quarantine/approve/reject/…), category selects, and a tombstones section.
   Forcing this into `<table>` cells risks exactly what the handoff's own
   top-level instruction forbids — behaviour change disguised as a visual
   migration. **Decision: exclude `admin/feeds` from the table conversion.**
   Apply the same ruled, flat visual language to its existing card-list
   markup (no rounded corners, no shadow, rule dividers, uppercase labels)
   without restructuring the DOM. `admin/users` and the following/
   subscriptions list *are* flat enough to convert safely and do so.

## Non-negotiables (verify before calling this done)

Copied from the handoff, unchanged in priority:

1. No-JS still works — tabs are links, composer falls back to plain textarea,
   mobile menu is a native `<details>`.
2. Local vs remote is never colour alone — the 2px rule's colour **and** the
   uppercase label's text (naming the source host on remote rows).
3. Live prepends must not jank — no `.post.remote` background tint.
4. Both themes designed and tested independently; dark hover steps *lighter*.
5. Accent at the right weight (`--color-accent` for chrome, `--color-accent-text`
   for paragraph-size, `--color-on-accent` for labels on a fill).
6. 44px minimum touch targets; 2px accent `:focus-visible` ring; no leftover
   soft `box-shadow` focus overrides.
7. `prefers-reduced-motion` kills every transition.

See `design-system/rsc/MASTER.md`'s own Pre-Delivery Checklist (landed by
Task 1) for the full list to run through at the end.
