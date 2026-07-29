# Header Navigation Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the two-row header (`.identity-bar` + `.nav`) into a single desktop row and a working mobile equivalent, fixing two verified bugs (a redundant desktop "New post" button, and an Admin link that's unreachable on desktop) by moving all account/identity content into one new `AccountMenu` component that is rendered once and never breakpoint-hidden.

**Architecture:** One new presentational Svelte component (`AccountMenu.svelte`), wired into the existing root layout in place of `.identity-bar` and the standalone theme toggle; CSS changes confined to `web/src/app.css`; a documentation update to `design-system/rsc/MASTER.md`. No new routes, no new server/load-function data, no new dependency — pure refactor of data already fetched by `+layout.server.ts`.

**Tech Stack:** SvelteKit (Svelte 5 runes), vanilla CSS custom properties (`web/src/app.css`).

**Spec:** `docs/superpowers/specs/2026-07-29-header-nav-consolidation-design.md` (rev 1 — ponytail-review dropped a speculative letter-square-avatar collapse state; the trigger uses a fixed max-width with ellipsis instead).

## Global Constraints

- **No raw hex in components** — every color comes from a `--color-*` variable already defined in `web/src/app.css`. (project CLAUDE.md)
- **No-JS first-class** — `AccountMenu` must work with JavaScript disabled: native `<details>`/`<summary>` disclosure (same mechanism `.nav-menu` already uses), `<form method="POST">` for the logout action, no JS-driven click-outside-to-close (the existing `.nav-menu` doesn't have this either — don't add asymmetric behavior).
- **`ThemeToggle` is itself JS-only** (`{#if browser}` — existing, unchanged, confirmed in `web/src/lib/ThemeToggle.svelte:34`) — this is expected and matches MASTER.md's "theme toggle as enhancement only" non-negotiable; do not work around it.
- **44px minimum touch target** on every interactive row (existing precedent: `.nav-menu-list a { min-height: 44px }`, `.nav-menu-rivers a { min-height: 56px }`).
- **WCAG 4.5:1 contrast**, both themes, verified independently via real computed styles — use the real Chrome browser tool (`mcp__plugin_superpowers-chrome_chrome__use_browser`), never any `obscura` tool (confirmed unreliable/synthetic in this project this session).
- **Shared checkout** — never `git add -A`; stage explicit paths. A parallel session may commit to `main` concurrently.
- **Commit messages end with** `developed with the help of AI tools`.
- **Exact `me` prop shape** (from `web/src/lib/api.ts:76`, consumed via `LayoutData` in `+layout.svelte`):
  ```ts
  { user: { displayName: string; handle: string }; isAnonymous: boolean; emailVerified?: boolean; isAdmin?: boolean } | null
  ```
- **No dedicated unit test file for `AccountMenu.svelte`.** This codebase's existing convention: simple presentational components with no real logic (`Avatar.svelte`, `ThemeToggle.svelte`) have no `*.test.ts` file; components with actual algorithmic behavior (`ReplyTree.svelte`, `FeedIcon.svelte`) do. `AccountMenu` has one one-line boolean derivation and otherwise mirrors prop shape directly in the template — it matches the untested-component precedent. Verification is `svelte-check` (type safety) plus live-browser checks of every identity state in both themes, not a new test file. State this explicitly in each task's report so it doesn't read as a skipped step.
- **Every task's live-verification step uses the real Chrome tool**, screenshots or `getBoundingClientRect()`/computed-style reads as evidence — matching the standard already established on the timeline-legibility branch (`docs/superpowers/plans/2026-07-29-modernist-timeline-legibility-plan.md`).

## File Structure

- Create: `web/src/lib/AccountMenu.svelte` — the new consolidated account/identity control. One component, one job: render the right identity state (guest / anonymous / registered / admin) as either plain login links or a native disclosure menu.
- Modify: `web/src/routes/+layout.svelte` — remove `.identity-bar`, the redundant desktop "New post" link, and the standalone icon `ThemeToggle`; add `AccountMenu`; strip the now-redundant "Signed in" and theme-toggle groups out of `.nav-menu`'s panel.
- Modify: `web/src/app.css` — remove `.identity-bar` and superseded `.nav` rules; add `.account-menu` and related rules, reusing `.nav-menu-group`/`.nav-menu-list`/`.nav-menu-identity` wherever the shape matches rather than duplicating CSS.
- Modify: `design-system/rsc/MASTER.md` — describe the shipped one-row header and account-menu pattern as current, not the old two-row description.

---

### Task 1: `AccountMenu` component and layout wiring

**Files:**
- Create: `web/src/lib/AccountMenu.svelte`
- Modify: `web/src/routes/+layout.svelte`

**Interfaces:**
- Produces: `AccountMenu` — a Svelte component with one prop, `me: { user: { displayName: string; handle: string }; isAnonymous: boolean; emailVerified?: boolean; isAdmin?: boolean } | null`. Internally derives `needsAttention = me != null && (me.isAnonymous || me.emailVerified === false)`.
- Consumes: `data.me` — already available in `+layout.svelte`'s existing `$props()` destructure (`let { data, children } = $props()`), no new load-function work needed.
- Consumes (indirectly, unchanged): `ThemeToggle` (`web/src/lib/ThemeToggle.svelte`), prop `variant?: 'icon' | 'segmented'` (default `'icon'`) — `AccountMenu` uses `variant="segmented"`.

**No dedicated test file for this task** — per the Global Constraints note, this is a deliberate, precedented deviation from this plan template's usual TDD steps, not an omission. Verification for this task is `svelte-check` (Step 3) plus visual/functional confirmation folded into Task 2's live-browser pass (this task's markup has no CSS yet to look right, so a meaningful screenshot only makes sense once Task 2 lands).

- [ ] **Step 1: Write `AccountMenu.svelte`**

```svelte
<script lang="ts">
	import ThemeToggle from '$lib/ThemeToggle.svelte'

	type Me = {
		user: { displayName: string; handle: string }
		isAnonymous: boolean
		emailVerified?: boolean
		isAdmin?: boolean
	} | null

	let { me }: { me: Me } = $props()
	const needsAttention = $derived(me != null && (me.isAnonymous || me.emailVerified === false))
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
			<div class="nav-menu-group">
				<div class="nav-menu-identity">{me.user.displayName}</div>
			</div>
			<div class="nav-menu-group">
				<div class="nav-menu-list">
					{#if me.isAnonymous}
						<a class="accent" href="/register">Register to keep this account</a>
					{:else if me.emailVerified === false}
						<a class="accent" href="/login">Verify your email — email me a login link</a>
					{/if}
					<a href="/u/{me.user.handle}">Your lens</a>
					<a href="/settings">Settings</a>
					{#if me.isAdmin}<a href="/admin">Admin</a>{/if}
					{#if !me.isAnonymous}
						<form method="POST" action="/login?/logout">
							<button class="destructive" type="submit">Log out</button>
						</form>
					{/if}
				</div>
			</div>
			<div class="nav-menu-group">
				<ThemeToggle variant="segmented" />
			</div>
		</div>
	</details>
{/if}
```

Note on `needsAttention`: written as `$derived` (Svelte 5 rune), not a plain `const`, since it's computed from a reactive prop (`me` can change if the session state changes client-side navigation) — `const needsAttention = ...` evaluated once at component init would go stale; `$derived` recomputes when `me` changes. This is the correct rune per `svelte-runes` skill guidance (`$derived` for any prop-computed value).

Note (ponytail-review rev 1): the panel's CTA/nudge and Log out rows live *inside* the same `.nav-menu-list` as Your lens/Settings/Admin, using `class="accent"` and `class="destructive"` respectively — matching the existing `.nav-menu-list a.destructive` precedent (a one-line color override on a shared row style) instead of two new ~10-line standalone classes duplicating `.nav-menu-list a`'s row shape. The guest branch's root `<div>` also carries `class="account-menu account-menu-guest"` (not `account-menu-guest` alone) so it inherits `.account-menu`'s `margin-left: auto` instead of redeclaring it.

- [ ] **Step 2: Wire it into `+layout.svelte`**

Read the current file first (`web/src/routes/+layout.svelte`) to get exact current text — the edits below describe *what* changes, not literal line numbers, since other work may have touched this file since this plan was written.

1. Add the import: `import AccountMenu from '$lib/AccountMenu.svelte'` (alongside the existing `ThemeToggle` and `ComposerDialog` imports).
2. Delete the entire `.identity-bar` block (all three `{#if}` branches — guest, anonymous, registered — currently the first thing rendered after `<svelte:head>`).
3. In `<nav class="nav">`: delete the `<a class="spacer btn new-post-desktop" href="#compose-desktop">New post</a>` line (keep `.new-post-mobile` exactly as-is). Delete the standalone `<ThemeToggle />` line. Add `<AccountMenu me={data.me} />` as the last child of `<nav>`, after the (conditionally-rendered) `.new-post-mobile` link and before the `<details class="nav-menu">` block.
4. Inside `<details class="nav-menu">`'s panel: delete the `<div class="nav-menu-group"><h6>Signed in</h6>...</div>` block in its entirety (identity display, Your lens, Settings, Admin, Log out — all now live in `AccountMenu`). Delete the final `<div class="nav-menu-group"><ThemeToggle variant="segmented" /></div>` block (also now in `AccountMenu`). Leave the Rivers group, the New-post/composer group, and the Subscribe-to-feed group untouched.

- [ ] **Step 3: Type-check**

```bash
npm run check -w web
```
Expected: 0 errors, 0 warnings (same clean baseline as before this task — the `me` prop type here is narrower than `LayoutData['me']` only in that it doesn't need the rest of `LayoutData`, so this should typecheck without friction; if it doesn't, the mismatch is real and must be fixed, not suppressed).

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/AccountMenu.svelte web/src/routes/+layout.svelte
git commit -m "$(cat <<'EOF'
design: consolidate identity-bar and nav-menu account items into AccountMenu

developed with the help of AI tools
EOF
)"
```

---

### Task 2: CSS — one-row desktop header, live-verified

**Files:**
- Modify: `web/src/app.css`

**Interfaces:**
- Consumes: the class names `AccountMenu` renders that are new to this branch (`.account-menu`, `.account-menu-guest`, `.account-menu-toggle`, `.account-menu-dot`, `.account-menu-panel`) from Task 1, plus the existing `.nav-menu-group`, `.nav-menu-list`, `.nav-menu-identity`, `.destructive` classes (reused as-is, with `.nav-menu-list`'s row rule and `.destructive` both broadened in this task to also match `<button>` — see Step 3) and one new one-line modifier (`.nav-menu-list a.accent`, parallel to the existing `.destructive` pattern).

- [ ] **Step 1: Delete the superseded rules**

Grep first to confirm current locations (the file has changed since this plan was drafted):
```bash
grep -n "^\.identity-bar\|identity-bar \|identity-bar\.\|new-post-desktop\|nav > \.theme-toggle" web/src/app.css
```

Delete:
- The `.identity-bar` rule and its four descendant rules (`.identity-bar > div`, `.identity-bar .handle`, `.identity-bar .identity-cta`, `.identity-bar .logout-form`) — currently a contiguous block.
- The comment + rule `.nav .new-post-desktop` is never given its own base rule (only referenced in the shared `.nav .spacer` and a mobile-hide query) — delete the `@media (max-width: 767px) { .nav .new-post-desktop { display: none } }` rule (the element no longer exists, so hiding it is a no-op) and the comment above `.nav .new-post-mobile` that explains the two-target scheme (rewrite it — see Step 2).
- The standalone `.nav > .theme-toggle` rule and its `@media (max-width: 767px) { .nav > .theme-toggle { display: none } }` counterpart (the toggle no longer sits directly in `.nav`; it's inside `AccountMenu`'s panel now).

- [ ] **Step 2: Update the "New post" comment**

The comment above `.nav .new-post-mobile` currently explains a two-target (`#compose` / `#compose-desktop`) scheme. Since the desktop target is gone, rewrite it to describe the current, simpler state: mobile-only "New post" shortcut, because mobile has no persistently-visible composer to jump to (unlike desktop, where the `.tools` sidebar composer is already on-screen).

- [ ] **Step 3: Add the account-menu rules**

```css
/* Account menu — the one control carrying identity/settings/admin/theme
   content at every width. Unlike .nav-menu, this is never display:none'd —
   that asymmetry was the actual bug (Admin was unreachable on desktop
   because its only trigger only existed below 768px). */
.account-menu {
	position: relative;
	margin-left: auto;
}

.account-menu-guest {
	font-size: 0.875rem;
}

.account-menu-guest a {
	color: inherit;
	text-decoration: none;
}

.account-menu-guest a:hover {
	color: var(--color-accent);
}

.account-menu-toggle {
	display: inline-flex;
	align-items: center;
	gap: var(--space-xs);
	min-height: 44px;
	max-width: 12rem;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-size: 0.875rem;
	font-weight: 600;
	color: var(--color-foreground);
	cursor: pointer;
}

.account-menu[open] .account-menu-toggle {
	color: var(--color-accent);
}

.account-menu-dot {
	display: inline-block;
	width: 6px;
	height: 6px;
	border-radius: 50%;
	background: var(--color-accent);
	flex-shrink: 0;
}

.account-menu-panel {
	position: absolute;
	top: 100%;
	right: 0;
	z-index: 10;
	min-width: 14rem;
	background: var(--color-background);
	border: 1px solid var(--color-divider);
}
```

Note: `.account-menu` (not `.account-menu-guest`) owns `margin-left: auto` — the guest `<div>` carries both classes (`class="account-menu account-menu-guest"`, per Task 1's rev-1 note) so it inherits the right-align rule instead of redeclaring it.

Note: `.account-menu-toggle` deliberately has no `list-style` reset — `.nav-menu-toggle` (the existing "Menu" button) doesn't reset its native `<summary>` disclosure marker either, so this matches established precedent rather than introducing a one-off style.

Then broaden the two existing row rules so a `<button>` (the CTA/nudge link is still a plain `<a>`, but Log out is now a `<button>` inside a `<form>`) gets the exact same row treatment as `.nav-menu-list a`, and add the one-line `.accent` modifier alongside the existing `.destructive` one. Locate the current rules first:

```bash
grep -n "\.nav-menu-list" web/src/app.css
```

Change `.nav-menu-list a { ... }` to also match `button`, change `.nav-menu-list a:last-child { border-bottom: 0; }` to also match `button:last-child`, change `.nav-menu-list a.destructive { color: var(--color-destructive); }` to also match `button.destructive`, and add one line for `.accent`:

```css
.nav-menu-list a,
.nav-menu-list button {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-3);
	min-height: 44px;
	border-bottom: 1px solid var(--color-border);
	color: var(--color-foreground);
	text-decoration: none;
	font-size: 0.9375rem;
}

.nav-menu-list button {
	width: 100%;
	padding: 0;
	background: none;
	border: 0;
	border-bottom: 1px solid var(--color-border);
	font: inherit;
	text-align: left;
	cursor: pointer;
}

.nav-menu-list a:last-child,
.nav-menu-list button:last-child {
	border-bottom: 0;
}

.nav-menu-list a.destructive,
.nav-menu-list button.destructive {
	color: var(--color-destructive);
}

.nav-menu-list a.accent {
	color: var(--color-accent-text);
	font-weight: 600;
}
```

(`.nav-menu-list button`'s `border: 0; border-bottom: 1px solid var(--color-border);` resets the browser's default button border on all sides before reapplying just the row divider — a plain `border-bottom: ...` alone would leave the UA default border on the other three sides.)

- [ ] **Step 4: Live-verify every identity state, both themes**

Start the dev stack the way this project's own docs prescribe (`docker compose up`, or reuse whatever is already running — check `docker compose ps` first; do not start a second stack on the shared ports if one is already up). Using the real Chrome tool (`mcp__plugin_superpowers-chrome_chrome__use_browser` — never `obscura`), check each of these at a desktop width (≥768px) and confirm the header is a single row in both light and dark theme:

1. **Guest** (no session / cleared cookies): header shows `Log in · Register` in the account-menu slot, no dropdown. River tabs and brand unaffected.
2. **Anonymous** (register a guest identity, don't complete registration): `@handle` trigger opens a panel showing "Register to keep this account", Your lens, Settings, theme toggle — no Admin, no Log out (matches `me.isAnonymous` gating).
3. **Registered, email unverified** (if reachable in this dev stack — check Mailpit/registration flow): trigger shows the attention dot; panel's top item is "Verify your email — email me a login link" instead of the register CTA.
4. **Registered, admin** (use the existing admin test account per project conventions): panel shows Your lens, Settings, **Admin**, theme toggle, Log out — confirm clicking **Admin** actually navigates to `/admin` and loads (this is the bug this whole plan exists to fix — don't skip this check).
5. **Log out actually works**: click Log out from the new panel and confirm the session actually ends (reload and see the guest/logged-out state). This is a functional regression check, not just a screenshot: the *previous* mobile-menu "Log out" was a bare `<a href="/login?/logout">` link (a GET request), while `AccountMenu`'s version is a `<form method="POST">` (matching `.identity-bar`'s prior, correct pattern) — SvelteKit form actions only fire on POST, so if the old link never actually logged anyone out, this task incidentally fixes a second latent bug. Confirm this either way and note which behavior you observed in your report; do not assume.

Then confirm mobile (≤767px): the "Menu" hamburger still opens and shows Rivers, the composer, and Subscribe (unchanged); the `AccountMenu` trigger is present and independently operable in the same collapsed header row (it must NOT be inside `.nav-menu`'s panel — confirm it's a sibling, always visible, exactly as designed). Confirm the header is now one row at mobile width too (brand, New-post, `AccountMenu` trigger, Menu toggle), not two.

Take screenshots (or record precise computed-style/geometry reads) for each state/theme combination that show the single-row layout and, for the Admin/Log-out checks, the actual navigation/session-state result — not just how it looks.

- [ ] **Step 5: Commit**

```bash
git add web/src/app.css
git commit -m "$(cat <<'EOF'
design: one-row desktop header CSS for the consolidated account menu

developed with the help of AI tools
EOF
)"
```

---

### Task 3: MASTER.md update and full verification

**Files:**
- Modify: `design-system/rsc/MASTER.md`

**Interfaces:** None — documentation only.

- [ ] **Step 1: Locate the current nav/identity-bar description**

```bash
grep -n -i "identity-bar\|identity bar\|nav-menu\|Signed in\|theme toggle" design-system/rsc/MASTER.md
```

- [ ] **Step 2: Rewrite to describe the shipped state**

Replace any prose describing `.identity-bar` as a separate top strip, or describing the mobile "Menu" panel as the place Settings/Admin/Log out/theme-toggle live, with a description matching what Tasks 1–2 actually shipped: one `AccountMenu` control, always present regardless of width, showing `Log in · Register` for guests or an `@handle` disclosure menu (identity, a contextual nudge when one applies, Your lens, Settings, Admin if applicable, the theme toggle, Log out) for anyone with a session. Note that the mobile "Menu" hamburger's scope narrowed to Rivers/composer/subscribe only — content that already has a working desktop-visible equivalent elsewhere on the page.

- [ ] **Step 3: Spot-check for stale references**

```bash
grep -n -i "identity-bar\|two.row\|Signed in" design-system/rsc/MASTER.md
```
Confirm nothing remaining still describes the retired two-row structure as current.

- [ ] **Step 4: Full verification pass**

```bash
npm test -w core
npm test -w web
npm run typecheck -w core
npm run check -w web
```
Expected: all green (core suite is untouched by this whole plan; included as the standard full-repo gate).

- [ ] **Step 5: Commit**

```bash
git add design-system/rsc/MASTER.md
git commit -m "$(cat <<'EOF'
docs: MASTER.md reflects the consolidated one-row header

developed with the help of AI tools
EOF
)"
```
