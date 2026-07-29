# Header navigation consolidation — design

**Status:** brainstormed and approved in conversation; not yet planned or implemented.

## Context

Two bugs were reported against the shipped header (`web/src/routes/+layout.svelte`):

1. **Duplicate "New post" button.** On desktop (≥768px), `.nav .new-post-desktop`
   links to `#compose-desktop`, which is `web/src/routes/+page.svelte`'s
   `<aside class="tools" id="compose-desktop">` — the always-visible left
   sidebar composer on the home page. The header button does nothing the
   sidebar doesn't already show; it's a pure duplicate, present only because
   the header gates on `page.url.pathname === '/'` (the only page with a
   composer).
2. **Admin link unreachable on desktop.** `.nav-menu-toggle` (the "Menu"
   hamburger trigger) is `display: none` by default in `web/src/app.css` and
   only becomes visible via `@media (max-width: 767px)`. The Admin link only
   exists inside that hamburger's panel (`.nav-menu-panel`'s "Signed in"
   group), so on desktop the trigger to open it doesn't exist at all — not
   just Admin, but the entire panel's mobile-only duplicate content
   (Rivers list, composer, subscribe form, "Signed in" group, segmented theme
   toggle) is unreachable above 767px.

Root cause, common to both: the header was built mobile-first. Everything
that didn't fit a narrow screen — rivers, compose, subscribe, identity/admin
items, theme toggle — was put into one hamburger drawer that only mobile can
open, without separately verifying each of those things had a working
desktop path. Some do (composer and subscribe already have desktop-visible
equivalents in the `.tools` sidebar; rivers has desktop-visible tabs in
`.nav` itself); the identity/admin/theme-toggle content does not — its only
other home is `.identity-bar`, a separate top strip that duplicates *some*
but not all of it (no Admin, no theme toggle).

This surfaced a further, related complaint: the header is two full rows on
every page (`.identity-bar` above `.nav`), and it isn't clear which row is
"app navigation" (rivers, compose) versus "user/system" (identity, settings,
admin, log out, theme). This is a **structural header redesign**, not a
two-line patch — decided in conversation via `superpowers:brainstorming`
after the user opted for a full redesign over a minimal patch.

## Decisions (made in conversation, not to be re-litigated during planning)

- **"One row" is a desktop-width goal only** (≥768px). Mobile keeps a
  collapsed/hamburger-style control for overflow content, as long as it
  doesn't repeat today's bug (something reachable on one breakpoint only).
- **User/system items collapse into one account menu**, not inline
  always-visible links. Settings, Admin, Log out, and the theme toggle all
  move behind a single account-menu control.
- **Guest state (`data.me` is null) uses the same row slot as the account
  menu** — it renders as plain `Log in · Register` text in that position,
  not a dropdown (nothing to hide), and not a separate banner row.
- **The account menu is one component, rendered once, never
  breakpoint-hidden.** This is the actual fix for bug 2: nothing
  account/identity-related lives inside an element any `@media` query ever
  sets to `display: none`. CSS may restyle its trigger (e.g. compact to a
  letter-square on narrow widths) but never hides it.
- **The existing mobile "Menu" hamburger (`.nav-menu`) survives**, scope
  narrowed to genuinely mobile-only overflow: the rivers list, the composer,
  and the subscribe-to-feed form — the three things that already have a
  working desktop-visible equivalent elsewhere (nav tabs, `.tools` sidebar).
  It loses the "Signed in" group and the segmented theme-toggle group, both
  of which move to the new account menu.
- **`.identity-bar` is retired.** Its guest nudge, identity display,
  verify-email nudge, "register to keep this account" nudge, Settings, and
  Log out all move into the account menu. No replacement top strip.
- **Nudges (unverified email / anonymous-account) live inside the account
  menu's dropdown as a flagged top item**, with a small indicator dot on the
  closed trigger (`.account-menu-dot`) so they're not silently buried —
  chosen over a separate always-conditional banner row, to keep the
  single-row goal unconditional (no "one row, except when there's a nudge").
- **The desktop "New post" header shortcut is removed outright**, not
  replaced. Mobile keeps its own "New post" button (`.new-post-mobile`,
  unchanged) since mobile has no visible sidebar composer to jump to instead.
- **The guest explanatory sentence ("Browsing as a guest — post or follow to
  get an identity.") is dropped**, not relocated. `Log in · Register` is
  self-explanatory link text; keeping the sentence would need its own row or
  wrapping treatment, contradicting the one-row goal for the one state that
  needs it least (a first-time visitor reads the two links fine unaided).

## The new structure

### `.nav` (single row, desktop ≥768px)

```
[RSC brand]   [Everything] [Personal] [Federated] [...]          [@handle ▾]
```

Guest state, same slot:

```
[RSC brand]   [Everything] [Personal] [Federated] [...]    [Log in · Register]
```

Brand and river tabs are unchanged from today. The account-menu control is
the last child of `.nav`, right-aligned (takes over the `.spacer`
margin-left:auto role currently held by whichever "New post" link is
visible).

### New component: `web/src/lib/AccountMenu.svelte`

Rendered exactly once in `.nav` (not duplicated per breakpoint):

```svelte
<script>
	let { me } = $props();
	const needsAttention = me && (me.isAnonymous || me.emailVerified === false);
</script>

{#if !me}
	<div class="account-menu account-menu-guest">
		<a href="/login">Log in</a> · <a href="/register">Register</a>
	</div>
{:else}
	<details class="account-menu">
		<summary class="account-menu-toggle">
			{#if needsAttention}<span class="account-menu-dot" aria-hidden="true"></span>{/if}
			@{me.user.handle}
		</summary>
		<div class="account-menu-panel">
			<div class="account-menu-identity">{me.user.displayName}</div>
			{#if me.isAnonymous}
				<a class="account-menu-cta" href="/register">Register to keep this account</a>
			{:else if me.emailVerified === false}
				<a class="account-menu-cta" href="/login">Verify your email — email me a login link</a>
			{/if}
			<a href="/u/{me.user.handle}">Your lens</a>
			<a href="/settings">Settings</a>
			{#if me.isAdmin}<a href="/admin">Admin</a>{/if}
			<ThemeToggle variant="segmented" />
			{#if !me.isAnonymous}
				<form method="POST" action="/login?/logout"><button class="destructive" type="submit">Log out</button></form>
			{/if}
		</div>
	</details>
{/if}
```

Uses the same native `<details>`/`<summary>` disclosure `.nav-menu` already
uses — no-JS first-class (works with JS disabled), no click-outside-to-close
script needed, matches an established pattern rather than inventing a new
one.

`me`'s shape matches `LayoutData['me']` exactly as consumed today in
`+layout.svelte` (`isAnonymous`, `user.displayName`, `user.handle`,
`emailVerified`, `isAdmin`) — no new server/load-function data is required,
this is a pure presentation refactor of data already fetched.

### `+layout.svelte` changes

- Delete the `.identity-bar` block entirely (all three branches: guest,
  anonymous, registered).
- In `.nav`: keep brand and river tabs as-is; keep `.new-post-mobile` as-is
  (still gated on `page.url.pathname === '/'`); **delete
  `.new-post-desktop`** (the redundant link); **delete the standalone
  `<ThemeToggle />`** (icon variant, moves into the account menu); add
  `<AccountMenu me={data.me} />` as the last child.
- Inside `.nav-menu`'s panel: **delete** the "Signed in" group
  (`.nav-menu-list` with Your lens/Settings/Admin/Log out) and **delete**
  the standalone segmented `<ThemeToggle variant="segmented" />` group — both
  now live in `AccountMenu`. Keep the Rivers group, the New-post/composer
  group, and the Subscribe group unchanged.

### CSS changes (`web/src/app.css`)

- Delete `.identity-bar`, `.identity-bar > div`, `.identity-bar .handle`,
  `.identity-bar .identity-cta`, `.identity-bar .logout-form`.
- Delete `.nav .new-post-desktop`'s comment/rule and the
  `@media (max-width: 767px) { .nav .new-post-desktop { display: none } }`
  counterpart (the element is gone, not just hidden).
- Delete the standalone `.nav > .theme-toggle` rule and its
  `@media (max-width: 767px) { .nav > .theme-toggle { display: none } }`
  counterpart (moved into the account menu, no longer a direct `.nav` child).
- Add `.account-menu` (the `.nav`-row trigger) and `.account-menu-panel`
  (the dropdown), styled as a right-anchored dropdown reusing the existing
  `.nav-menu-list`/`.nav-menu-group` row patterns (44px row height, 1px
  `--color-border` between rows, `--color-accent` for the flagged CTA item)
  rather than inventing new list styling — MASTER.md's existing "ordinary
  menu rows" pattern already covers this shape.
- `.account-menu-dot`: a small solid `--color-accent` circle, positioned on
  the trigger, `aria-hidden` (the nudge text itself carries the meaning for
  screen readers, the dot is a sighted-user affordance only).
- `.account-menu` gets the `margin-left: auto` (`.spacer`) treatment
  currently on whichever "New post" link is visible, so it right-aligns
  whether or not `.new-post-mobile` is present.
- Responsive trigger: on narrow mobile widths, `@handle` text may collapse
  to a small letter-square reusing `Avatar.svelte`'s existing visual style
  (1.75rem, `--radius: 0`, initial-letter fallback) rather than inventing a
  second avatar-like token — exact breakpoint value decided during
  implementation by live-testing header fit at common widths (say 375–414px)
  alongside brand + New-post + this trigger + the Menu toggle.
- `.nav-menu-toggle`'s existing mobile-only visibility rule
  (`display: none` by default, visible at `max-width: 767px`) is unchanged —
  it's now correct rather than accidentally hiding account content, since
  everything left inside `.nav-menu` genuinely only needs to exist below
  768px.

## Non-negotiables carried forward unchanged

No-JS first-class (native `<details>`, `<form>` actions — nothing here
depends on JS to function), both themes independently verified, 44px touch
targets on every interactive row, `prefers-reduced-motion`, visible focus
ring, WCAG 4.5:1 contrast on new text (the CTA nudge color, the dot's
against-background contrast is decorative/aria-hidden so exempt, but the
`account-menu-cta` text itself must be checked in both themes).

## MASTER.md updates required

`design-system/rsc/MASTER.md` documents the current identity-bar and nav
structure; it needs to describe the new one-row desktop header and the
account-menu pattern as the shipped state, not as a deferred idea. This
plan's final task should include a spot-check pass equivalent to the one
that just landed for the timeline-legibility branch (grep for
"identity-bar", the old two-row description, and any nav-menu prose that
assumed "Signed in" lived in the mobile panel).

## Scope check

One new component (`AccountMenu.svelte`), edits confined to
`+layout.svelte` and `app.css`, plus the MASTER.md documentation update.
No new routes, no new server/load-function data, no new dependency. Small
enough for a single implementation plan — likely 3 tasks (component +
layout wiring; CSS incl. responsive trigger sizing, live-tested at common
mobile widths in both themes; MASTER.md update + full verification), matching
the shape of the just-shipped timeline-legibility plan rather than the
larger original Modernist migration.
