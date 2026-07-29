# Design System Master File

> **LOGIC:** When building a specific page, first check `design-system/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.

---

**Project:** RSC
**System:** Modernist (Swiss modernism, applied)
**Revised:** 2026-07-28 — replaces the 2026-07-15 magazine/editorial revision
**Category:** App surface (feeds-native timeline), not a marketing site

---

## What changed and why

The previous revision was magazine/editorial: Libre Bodoni headings, rounded cards
with shadows, pill badges, an 8–16px radius scale. This revision keeps the product
thesis and every accessibility constraint but replaces the visual language with
Modernist — flat, architectural, set entirely in Archivo, organised by alignment
and rule weight rather than by cards and elevation.

Three things did **not** change, and outrank anything below if they ever conflict:
no-JS must read correctly, live prepends must not jank, and local vs remote must
be legible by more than colour.

The accent stays **RSS orange**. Modernist's own accent is red; RSC's orange is
load-bearing — it is the RSS mark's colour, and the feed badge, feed icons and
firehose links all trade on that recognition.

---

## Global Rules

### Color Palette (light + dark)

Both themes ship. Every colour in a component comes from a variable — no raw hex
outside this table.

| Role | Light | Dark | CSS Variable |
|------|-------|------|--------------|
| Background (the ground) | `#F3F2F2` | `#1A1918` | `--color-background` |
| Surface (fields, overlays) | `#EAE9E9` | `#2D2B2B` | `--color-surface` |
| Foreground (ink) | `#201E1D` | `#F8F4F4` | `--color-foreground` |
| Primary | `#201E1D` | `#F8F4F4` | `--color-primary` |
| On Primary | `#F3F2F2` | `#1A1918` | `--color-on-primary` |
| Secondary (muted text) | `#605D5D` | `#BAB6B6` | `--color-secondary` |
| Accent (fills, icons, rules, labels) | `#C2410C` | `#EA580C` | `--color-accent` |
| Accent, body-size text | `#7C2D12` | `#F79A5F` | `--color-accent-text` |
| Accent, hover/pressed | `#9A3412` | `#F79A5F` | `--color-accent-hover` |
| On Accent (label on a fill) | `#F3F2F2` | `#1A1918` | `--color-on-accent` |
| Muted (code, tint fills) | `#EAE7E7` | `#444141` | `--color-muted` |
| Border (1px row rules) | ink @ 22% | ink @ 22% | `--color-border` |
| Divider (2px section rules) | ink @ 40% | ink @ 38% | `--color-divider` |
| Destructive | `#DC2626` | `#EF4444` | `--color-destructive` |
| Ring (focus) | = accent | = accent | `--color-ring` |
| Code string/regexp | `#15803D` | `#4ADE80` | `--color-code-string` |
| Code number/title/attr | `#1D4ED8` | `#93C5FD` | `--color-code-value` |

**Colour notes.**

- The ground/surface/ink values are Modernist's own on light, and are derived on
  the same OKLCH neutral ramp on dark: surface is `neutral-900`, the ground sits
  one step below it, ink is `neutral-100`. Nothing here was invented by eye.
- `--color-secondary` is `neutral-700` on light and `neutral-400` on dark — the
  same perceptual step of one ramp, which is why they read as the same weight.
- **Accent has three roles, and they are not interchangeable.** `--color-accent`
  is for fills, icons, the 2px kind rules and the uppercase meta labels — all
  interface chrome, where the accent/ground pair's 3:1 is enough.
  `--color-accent-text` (a deep ramp step) is for anything at paragraph size:
  links in body copy, `.post .source`, `.edit`, the identity CTA, the clamp
  label. `--color-accent-hover` steps one past the base — **darker on light,
  lighter on dark.** That reversal is deliberate; a darker hover on a dark
  ground reads as a disabled state.
- **A label on an accent fill is the ground colour, never white.** White on
  `#EA580C` is 3.5:1. `--color-on-accent` handles it in both themes.
- Borders and dividers are ink at opacity rather than fixed greys, so they stay
  visible in dark mode without a second token set. Separation never depends on a
  shadow.

### Theming mechanism

Unchanged from the previous revision — three-state, `light-dark()` in `:root`
with `data-theme` overriding in both directions, an inline pre-paint script in
`app.html`, and the toggle as pure progressive enhancement.

One exception: `--shadow-*` cannot use `light-dark()`, because that function's
arguments are comma-separated and so are shadow lists. Dark elevation therefore
needs an explicit `[data-theme='dark']` block plus its `prefers-color-scheme`
twin.

### Typography

- **Heading font:** Archivo, weight 800
- **Body font:** Archivo, weight 400
- **Mood:** architectural, rational, international style, flush left
- **Google Fonts:** `Archivo:wght@400;600;800`

```css
@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;800&display=swap');
```

Type scale — headings at `line-height: 1.12`, `letter-spacing: -0.015em`:

| Element | Size | Used for |
|---|---|---|
| `h1` | 42px | page identity: `@handle`, Conversation, Admin |
| `h2` | 32px | river heading ("You and everyone you follow") |
| `h3` | 27px | a post title |
| `h4` | 20px | in-body headings |
| `.label` / `h6` | 11px, 800, `0.1em`, uppercase | every meta label in the app |
| body | 15px / 1.55 | post text, at `max-width: 68ch` |

**The 11px uppercase label is the workhorse of this system.** It replaces every
pill badge: the local/remote kind, `.badge-kind`, federation status, the reply
count, the "N more in this conversation" wedge, admin stat captions. Flush left,
tracked, weight 800. If you are reaching for a rounded chip, you want this
instead.

One narrow, deliberate exception: `.post .byline` drops to weight 400 — every
other use of the label elsewhere in the app stays 800. What that row actually
contains differs by surface, and the weight drop applies to the whole row
either way:

- **Home river** (`/`): `.byline` holds only the meta (kind · date · edited ·
  feed link) at weight 400, sitting directly above a separate `.byline-name`
  row where the display name (`.byline-name strong`, Archivo 800, 18px) and
  handle live. Splitting meta from name into two rows is what makes the 400
  read as a hierarchy instead of a competing weight.
- **Every other byline-rendering surface** (author lens, publisher lens, the
  conversation/post page, `following`, `ReplyTree`) has no second row: `.byline`
  is a single row carrying the meta *and* the name/handle together, all
  inheriting the same weight-400 unless an element sets its own. `.here`,
  `.edited`/`.edit`/`.post .source`, and `.avatar` each declare an explicit
  `font-weight: 800` and stay bold regardless of `.byline`'s weight. The plain
  `<strong>` wrapping the author's name on these single-row surfaces (e.g. the
  publisher lens's `<strong>{post.author.displayName}</strong>`) has **no**
  explicit weight rule of its own here — unlike `.byline-name strong` on the
  home river — so it renders at whatever the browser's default `<strong>`
  bolding computes against the inherited 400, not a deliberate 800 step.

Everything is flush left — headings, copy, and the labels inside wide buttons.
Nothing is centred, including the "Show more" clamp affordance and the "Older
posts" link.

### Spacing

| Token | Value |
|-------|-------|
| `--space-xs` | `4px` |
| `--space-sm` | `8px` |
| `--space-3` | `12px` |
| `--space-md` | `16px` |
| `--space-lg` | `24px` |
| `--space-xl` | `32px` |

`--space-3` is new — Modernist's 12px step, which its button and card padding
need.

### Radius

`--radius: 0px`. There is no scale. **Do not round a corner anywhere** — not
cards, not buttons, not inputs, not badges, not the letter avatar, not the feed
badge, not the composer dialog.

### Rules and elevation

Structure is drawn, not implied by whitespace:

- **2px `--color-divider`** between major sections: the header nav's underside,
  the boundaries between the three rails, above each rail section heading, the
  river heading, the footer's top, the current revision in edit history.
- **1px `--color-border`** between peers: table rows, following-list rows,
  thread nesting rules.
- Never soften either into a hairline, and never drop one for whitespace —
  **except** the timeline's post-to-post boundary, a deliberate carve-out:
  `.post` draws no `border-bottom` at all, and `.timeline` separates its rows
  with whitespace instead (`gap: var(--space-sm)`). This is the one place a
  rule is dropped for proximity on purpose; every other peer rule above
  (section-level 2px rules, table rows, following-list rows, thread nesting)
  keeps its rule unchanged.

Elevation exists only for things that genuinely float — the composer overlay and
the slash/emoji popups.

| Level | Light | Dark |
|---|---|---|
| `--shadow-sm` | `0 1px 2px rgba(45,43,43,.14)` | `0 0 0 1px rgba(248,244,244,.14)` |
| `--shadow-md` | `0 3px 10px rgba(45,43,43,.16)` | hairline + `0 8px 24px rgba(0,0,0,.55)` |
| `--shadow-lg` | `0 12px 32px rgba(45,43,43,.22)` | hairline + `0 12px 32px rgba(0,0,0,.6)` |

On dark the 1px hairline does the separating and the soft shadow only sets depth.

### Icons

Lucide, `currentColor`, `stroke-width: 2`. Two exceptions stay as they are —
the RSS mark in `FeedIcon.svelte` and the sidebar feed badge are the classic
RSS square, drawn from the rss.chat port; they are a recognised mark, not an
interface icon.

### Imagery

Every content photograph goes through `.grayscale` (`filter: grayscale(1)
contrast(1.08)`). Never tint or colourise. This matters for the roadmap's
avatar-harvesting work — see **Avatar** below.

### Interaction states

- Hover and pressed come from the accent ramp via `--color-accent-hover`; never
  `opacity: 0.9` (the old button hover) and never a transform that shifts layout.
- Focus is `outline: 2px solid var(--color-accent); outline-offset: 2px` on
  `:focus-visible`. This replaces the old ink ring **and** the soft
  `box-shadow` focus overrides in the tab bar and admin nav — delete those.
- `::selection` is `color-mix(in srgb, var(--color-accent) 30%, transparent)`.
- Disabled drops to 45% opacity.
- Transitions 150–300ms, and `prefers-reduced-motion` still kills them all.

---

## Component Specs

### Buttons

```css
.btn, button {
  display: inline-flex;
  align-items: center;
  justify-content: flex-start; /* FLUSH LEFT — a wide button starts its label
                                  at the padding edge, never centred */
  gap: 6px;
  background: var(--color-accent);
  color: var(--color-on-accent);
  border: 1px solid transparent;
  border-radius: var(--radius);
  padding: var(--space-sm) var(--space-3);
  font-family: var(--font-heading);
  font-weight: 800;
  font-size: 14px;
  cursor: pointer;
  transition: background-color 200ms ease;
}
.btn:hover  { background: var(--color-accent-hover); }
.btn-secondary { background: transparent; border-color: var(--color-divider); color: var(--color-foreground); }
.btn-secondary:hover { background: color-mix(in srgb, var(--color-foreground) 7%, transparent); }
.btn-ghost { background: none; color: var(--color-accent-text); padding-inline: var(--space-xs); }
.btn-block { width: 100%; }
```

The flush-left rule is the one most likely to look wrong if skipped — a
full-width "Subscribe" with a centred label reads as a different system.

### The post — a ruled row, whitespace-separated

This is the largest change in the revision. `.post` is a two-column grid: a 2px
full-height rule, then the content. No card background, no border box, no
radius, no shadow, no tint — and, since this revision, no ruled bottom edge
either. `.post` carries no `border-bottom` at all; posts in the river are
separated from each other by proximity instead, via `.timeline`'s own
`gap: var(--space-sm)`. The 2px local/remote rule down the left is still a
rule — only the horizontal divider between posts is gone.

```css
.timeline {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}
.post {
  display: grid;
  grid-template-columns: 2px 1fr;
  gap: var(--space-lg);
  padding: var(--space-lg) 0;
  background: none;
}
.post::before { content: ''; background: var(--color-primary); }  /* local */
.post.remote::before { background: var(--color-accent); }         /* remote */
.post > * { grid-column: 2; }
```

**Local vs remote — the product thesis, restated.** Two signals, never colour
alone: the left rule changes colour, **and** the flush-left uppercase label
changes text (`LOCAL` / `REMOTE · ordinarynotes.example`, which also names the
source host). The old 4% accent background tint is **gone** — a tinted row on a
ruled river reads as a selection state, and dropping it means an SSE prepend
cannot shift anything.

**Byline, two rows.** First a meta row in the 11px label style (kind · date ·
edited · feed link, pushed right); then the name row, display name in Archivo
800 at 18px beside the muted handle. Then title (`h3`, 27px, `max-width: 30ch`),
then body (`max-width: 68ch`, `text-wrap: pretty`), then the action row — reply
count, Reply, Permalink, Edit, Remove — all in the 11px label style.

**Long posts.** Clamp at `18rem` (up from 14rem — the measure is wider now). The
affordance is **not** a centred gradient pill: the clipped body ends on a 1px
rule with a flush-left uppercase "Show more". There is no card surface to
dissolve into, so nothing fades, and the remote-specific gradient override is
deleted along with the tint.

**Blockquotes** inside a body are display-grade: 2px divider rule on the left,
Archivo 800 at 19px, `max-width: 44ch`, full-strength ink rather than muted.

**Avatar.** Present in every post's byline: a small (1.75rem), `--radius: 0`
letter-square carrying the initial of the author's display name (or
`sourceName` for an aggregate lens) — `rss.chat`'s original `populateAvatar`
fallback. Feeds carry no avatar images today, so the letter *is* the avatar;
`Avatar.svelte` stays a plain letter-span until a real image URL turns up, at
which point it grows an `<img>` branch reusing the `.grayscale` filter already
applied to enclosure images in `PostBody`. A separate, larger profile-style
avatar for the author-lens page header is still just a roadmap idea, not
built — don't confuse it with this per-post scanning aid.

**Nested replies.** The 1px indent rule stays (`.replies`'s `border-left`).
Reply rows are whitespace-separated from each other the same way top-level
posts are — `.replies` carries the same `gap: var(--space-sm)` as `.timeline`,
since `.post` no longer draws its own `border-bottom` for them to rely on. The
author lens's folded, stacked view is the one exception that keeps a literal
rule between its rows (`.post.stacked .replies > li`'s own `border-bottom`,
alongside the same gap) — it is a denser, date-keyed record list rather than
the ordinary reply river, and the `.post.stacked::before/::after` peeking card
edges are deleted (they depended on rounded corners).

### Inputs

```css
.input, input, textarea, select {
  background: var(--color-surface);
  color: var(--color-foreground);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius);
  padding: 6px 10px;
  min-height: 36px;
  font-size: 14px;
  caret-color: var(--color-accent);
}
.input:focus { border-color: var(--color-accent); box-shadow: none; }
```

The soft 3px focus glow is gone — the ring is `:focus-visible`. Field labels are
12px, weight 400, `--color-secondary` (not 600 bold).

### Rail sections (was: `.panel`)

The boxed `<details>` panel loses its border, radius and surface. It becomes a
labelled section under a 2px rule: `summary` in the 11px uppercase label style at
13px, content flush left beneath. Still native `<details>`, still works with no
JS.

### Reply-count control (`ReplyToggle`)

Keeps every behavioural contract from the previous revision — real `<a>` first,
44×44 minimum target from padding, `aria-expanded`, `aria-busy` during the fetch,
`aria-label` as the accessible name, visible glyph+count `aria-hidden`,
secondary at rest / accent when expanded, no rotation animation.

What changes: `border-radius: 0`, and the visible count adopts the 11px uppercase
label style ("3 REPLIES") instead of a bare numeral, so it sits in the action row
with Reply and Permalink rather than floating as a chip.

### Tables

New in this revision, and the right answer for the connected-instances list and
every admin list:

```css
.table th { font-size: 11px; letter-spacing: .08em; text-transform: uppercase;
            color: var(--color-secondary); border-bottom: 2px solid var(--color-divider); }
.table td { border-bottom: 1px solid var(--color-border); }
```

Prefer a table over `.following-list` boxes wherever the content is genuinely
tabular — sources, users, feeds, instances.

### Notices

No box. A 2px left rule in `--color-destructive` (or `--color-accent` for the
affirmative `.confirm`) and flush-left text at 12px padding-left. Square.

### Modal / composer overlay

```css
.dialog { background: var(--color-surface); border: 0; border-radius: 0;
          box-shadow: var(--shadow-lg); }
.dialog::backdrop { background: color-mix(in srgb, #2D2B2B 50%, transparent); }
```

No blur — Modernist doesn't blur. The dialog header sits above a 2px rule and
carries a kicker (`LOCAL · @handle`) over the title. The draft badge loses its
tinted pill and becomes a trailing muted label, which suits the flush-left
button.

### Carta composer

Keep every `body`-prefixed selector — `default.css` loads after `app.css` via
dynamic import, so equal specificity loses the tie. Keep the `.carta-input` font
metrics rules exactly as they are; the caret layer and the highlight overlay must
share metrics.

What changes: the editor frame is square with a 1px divider border; the active
Write/Preview tab becomes a solid accent cell with ground-coloured label
(Modernist's segmented-control treatment) rather than an underline; the tab labels
adopt the 11px uppercase style; the icons menu and the slash/emoji popups are
square with `--shadow-md`, and their `--group-color` is the accent.

---

## Page Patterns

### Shell — the timeline (`/`)

A full-width header nav, then a three-column modular grid separated by 2px
rules. The old centred `max-width: 90rem` container with 32px gaps is gone: the
grid runs edge to edge and the rules do the dividing.

```
┌──────────────────────────────────────────────────────────────┐
│ .nav  RSC · Local Federated Personal Public · Firehose       │  2px rule
│       … @handle (no disclosure glyph) / Log in · Register    │
├────────────┬─────────────────────────────────┬───────────────┤
│ tools rail │ river                           │ meta rail     │
│ 16.5rem    │ 1fr                             │ 18.75rem      │
│  (2px rule between rails)                                    │
└──────────────────────────────────────────────────────────────┘
```

There is one header row, not two. Identity is no longer a separate strip above
the nav — it is the `AccountMenu` control, right-aligned in the `.nav` row
itself, present at every width. Guests see `Log in · Register`; anyone with a
session sees an `@handle` disclosure that opens identity, a contextual nudge
when one applies (register-to-keep-this-account for anonymous sessions,
verify-your-email otherwise), Your lens, Settings, Admin (if applicable), the
theme toggle, and Log out. This is the one place all of that lives, at any
width — there is no separate desktop vs. mobile account surface to keep in
sync.

**The tabs move into the nav.** They were a bordered tab strip above the river;
as nav links they free the river's full measure and give the brand, the rivers
and the primary action one horizontal line. Delete the `.tabs` block in
`+page.svelte`'s `<style>`.

**Duplication rule:** a control appears once. "New post" lives in the `.tools`
rail's composer at 768px and up, and in the nav only below 768px — never both
at once. The rivers live in the nav, not also as a rail list — the rail
lists *sources* instead (with OPML import/export), which is the thing that was
missing. Account/identity content lives in the `AccountMenu` disclosure, not
also in the mobile menu panel.

River order is unchanged: newest first, root-only, "Older posts" at the foot.

### Author lens (`/u/[handle]`)

Was a 42rem centred column. Now: a ruled masthead (kicker `AUTHOR LENS · LOCAL`,
`@handle` at 42px, Follow + feed badge right-aligned), then a **stat row** of
three equal cells divided by 1px rules — posts / following / followers — then the
river full width.

The card-stack whisper is replaced: a conversation with more of the author's
posts unfolds as a date-keyed ruled sub-list (`6rem` date column, then the text),
under the top row's own rule.

### Conversation (`/post/[id]`)

Same masthead treatment: kicker `CONVERSATION`, and the "Replying to" way-up link
in the 11px label style beneath it. The root row then the fully-unfolded tree,
each level indented behind a 1px rule. The `highlight` state for the post you
arrived at is a 2px accent left rule — the same mechanism as `.post.remote`, not
a box-shadow — so it reads at a glance in a deep tree.

The Reply composer stays a `<details>` at the foot, now as a labelled rail
section rather than a boxed panel.

### Edit history (`/post/[id]/history`)

Already a ruled list rather than boxed cards — that instinct was right and
survives intact. Versions run oldest to newest; each `<li>` is separated by a 1px
rule, the timestamp is an 11px uppercase label, and the current version is
marked by a **2px accent** top rule (was 2px ink). "← back to the post" is an
11px label link.

### Following (`/u/[handle]/following`)

Three forms (subscribe, follow, import OPML) become labelled rail sections
stacked under 2px rules rather than three boxed `<details>`. The subscriptions
list becomes a `.table` — label, kind, state, action — which handles the
`awaiting review` state far better than a badge on a rounded row. The timeline
below it uses the standard ruled river.

### Admin (`/admin/*`)

The section tabs adopt the same treatment as the timeline tabs: a nav row over a
2px rule, accent for the current page, no soft focus glow (delete the
`box-shadow` focus override in `+layout.svelte`).

The overview's four stat cards become a **single ruled row of equal cells** — the
same construction as the author lens stat row, no card borders, 1px rules
between, number in Archivo 800 at 28px over an 11px uppercase caption. Federation
status becomes a two-column `.table` (setting / state), with `on` in the accent
and `off` in secondary — plus the word itself, so it is not colour alone. Users
and feeds are `.table`s.

### Auth pages (`login` / `register` / `forgot` / `reset`)

No layout change needed; the token swap and the button/input rules carry them.
`form.auth-form` keeps its 24rem measure, flush left on the page rather than
centred.

### Narrow widths

Three breakpoints, and the rule at each is *what drops*, not *what shrinks*.

**1024 and below — the meta rail drops.** It becomes a two-cell ruled band below
the river (About | Connected instances), divided by a 1px rule. The tools rail
stays: subscribing and the source list are actions, About and the peer list are
reference, and actions keep their place longer.

**767 and below — one column, and the nav collapses into a menu.** The header
holds four things: brand, New post, `AccountMenu`, `MENU`. The `AccountMenu`
does not move into the panel — it stays visible in the header at every width,
since it is the same control on mobile as on desktop. The `MENU` panel's scope
narrows to what has no other on-page equivalent at this width: the rivers, the
composer, and subscribing to a feed. The whole tools rail folds in here too;
the river then has to name itself on the page, which it should have been
doing anyway.

**The menu is a full-bleed ruled panel, not a dropdown** — nothing floats in this
system, so a floating sheet would be the wrong object. It is a poster page: groups
divided by 2px rules, entries flush left in Archivo 800 at 22px on 56px rows,
ordinary rows at 44px. The current river is a solid accent cell (the
segmented-control treatment) and says `here` in words as well, so it is never
colour alone. Built as a native `<details>` with the toggle as its `<summary>`, so
it opens with JavaScript off and needs no `aria-expanded` management. The
`AccountMenu` is a second, independent `<details>` for the same reason — its own
JS-off-safe disclosure, not gated by the `MENU` toggle.

Within a row at this width: the gap goes 24 → 12px, titles 27 → 22px, the byline
wraps, and every item in the action row takes the 44px floor. **The 2px kind rule
does not get quieter** — it is the local/remote signal, and it is the same weight
at 375px as at 1440px.

**Tables become records below 700px.** A four-column table cannot survive 375px.
Mark it `.table.table-records`, give each `<td>` a `data-label`, and the `<thead>`
hides while each row becomes a stacked ruled record — the column heading printed
as an 11px uppercase label line, the first cell as the record's title. It stays a
real table in the markup, so wide screens and screen readers are unaffected.

**768 to 1023 is the two-rail layout:** rivers back in the nav, tools rail back at
15rem, meta as the band below. So the menu is a 767-and-below concern only.

---

## RSC-specific constraints (override anything above that conflicts)

1. **No-JS first-class.** Every style must read correctly on plain SSR HTML. No
   CSS that depends on a JS-added class. The ruled river helps here — there is no
   hover-elevation state to miss.
2. **Live timeline.** The SSE island prepends at the top. Fixed row padding, no
   entrance animation, `prefers-reduced-motion` respected. Dropping the
   `.post.remote` background tint removes the last thing that could reflow on
   insert.
3. **Local vs remote must be legible.** Two signals minimum: the 2px left rule's
   colour **and** the uppercase label's text. Never colour alone.
4. **Theme toggle is an enhancement.** No-JS gets the right theme from
   `prefers-color-scheme`. Design and test both themes independently — dark is
   not an inversion pass. The toggle lives inside the `AccountMenu` disclosure
   in the nav bar, at every width — not a separate control that only exists
   below 768px.
5. **Text first, enclosures second.** Unchanged: native `<audio>` / `<video>` /
   `<img loading="lazy">`, an attachment block *below* the text, never a hero,
   declared aspect-ratio. Enclosure images are square-cornered now, and content
   photographs go through `.grayscale`.
6. **Root-only rivers.** Unchanged: Local / Federated / Personal / Public and the
   following-management timeline show each conversation once, at its root. Author
   profiles and the conversation page remain full/activity views.

---

## Anti-Patterns (Do NOT Use)

- ❌ **Any rounded corner.** `--radius` is `0` on purpose.
- ❌ **Centred button labels or centred page copy.**
- ❌ **Pill badges.** Use the 11px uppercase label.
- ❌ **Cards with shadows** as the river's unit of content. Rules divide; nothing floats.
- ❌ **Softening a 2px rule to 1px, or replacing a rule with whitespace** —
  except the timeline's post-to-post boundary, the one deliberate carve-out
  (see Rules and elevation, above). Don't extend that exception anywhere else.
- ❌ **Tinted or colourised imagery.** `.grayscale`, always.
- ❌ **`--color-accent` at paragraph size** — that is `--color-accent-text`.
- ❌ **White text on an accent fill** — that is `--color-on-accent`.
- ❌ **A darker hover on the dark ground** — hover steps lighter there.
- ❌ **Emojis as icons.** Lucide SVG.
- ❌ **Missing `cursor: pointer`** on anything clickable.
- ❌ **Layout-shifting hovers**, `opacity` hovers, instant state changes.
- ❌ **Invisible or default-blue focus states.**
- ❌ **Low contrast text** — 4.5:1 minimum for body copy, per theme.

---

## Pre-Delivery Checklist

- [ ] No rounded corners anywhere
- [ ] No pill badges — meta reads as 11px uppercase flush-left labels
- [ ] Every wide button's label starts at the left padding edge
- [ ] 2px rules between sections, 1px between peers; none softened or dropped
      — except the timeline's post-to-post boundary (whitespace by design)
- [ ] Accent used at the right weight: fill/icon/label vs body text vs hover
- [ ] Accent-fill labels use `--color-on-accent`, not white
- [ ] Dark hover steps *lighter*, not darker
- [ ] Both themes: text contrast 4.5:1, checked independently
- [ ] Dark mode separation comes from borders/rules, not shadows
- [ ] Theme toggle overrides system preference both ways; no flash on load
- [ ] Focus ring is the 2px accent `:focus-visible`; no leftover soft glows
- [ ] Local vs remote distinguished by rule colour **and** label text
- [ ] Live prepends can't shift layout (no tint, fixed row padding)
- [ ] `prefers-reduced-motion` respected
- [ ] Photographs through `.grayscale`
- [ ] Icons from Lucide (RSS mark excepted)
- [ ] Responsive: 375px, 768px, 1024px, 1440px
- [ ] At 767 and below: rivers and tools rail live in the menu panel; the
      `AccountMenu` stays in the header at every width, nowhere twice
- [ ] The menu panel is a ruled full-bleed page, opens with JS off, rows ≥ 44px
- [ ] Multi-column tables carry `data-label` and collapse to records below 700px
- [ ] The 2px kind rule is the same weight at every width
- [ ] No content hidden behind the nav; no horizontal scroll on mobile
- [ ] Reads correctly with JavaScript off
