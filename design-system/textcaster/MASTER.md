# Design System Master File

> **LOGIC:** When building a specific page, first check `design-system/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.

---

**Project:** Textcaster
**Generated:** 2026-07-15 20:21:54
**Category:** Magazine/Blog

---

## Global Rules

### Color Palette (light + dark)

Both themes ship from day one. Every color in components comes from a variable — no raw hex outside this table.

| Role | Light | Dark | CSS Variable |
|------|-------|------|--------------|
| Primary | `#18181B` | `#FAFAFA` | `--color-primary` |
| On Primary | `#FFFFFF` | `#09090B` | `--color-on-primary` |
| Secondary | `#3F3F46` | `#A1A1AA` | `--color-secondary` |
| Accent/CTA | `#C2410C` | `#EA580C` | `--color-accent` |
| On Accent | `#FFFFFF` | `#09090B` | `--color-on-accent` |
| Background | `#FAFAFA` | `#09090B` | `--color-background` |
| Surface (cards, composer) | `#FFFFFF` | `#18181B` | `--color-surface` |
| Foreground | `#09090B` | `#FAFAFA` | `--color-foreground` |
| Muted | `#E8ECF0` | `#27272A` | `--color-muted` |
| Border | `#E4E4E7` | `#27272A` | `--color-border` |
| Destructive | `#DC2626` | `#EF4444` | `--color-destructive` |
| Ring | `#18181B` | `#FAFAFA` | `--color-ring` |
| Code string/regexp | `#15803D` | `#4ADE80` | `--color-code-string` |
| Code number/title/attr | `#1D4ED8` | `#93C5FD` | `--color-code-value` |

**Color Notes:** Editorial black/zinc + RSS orange accent. Contrast verified per theme: light accent `#C2410C` on white 4.9:1, dark accent `#EA580C` on `#09090B` 5.4:1; dark-mode accent buttons use near-black text (`--color-on-accent`), white on `#EA580C` is only 3.5:1.

### Theming mechanism

CSS custom properties, three-state: system default, explicit light, explicit dark.

```css
:root {
  color-scheme: light dark; /* native form controls, scrollbars */
  /* light tokens */
}
:root[data-theme='dark'] { /* dark tokens */ }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) { /* dark tokens (same block, duplicated or via mixin) */ }
}
```

- **No-JS default:** the system preference (`prefers-color-scheme`) — no toggle needed to get dark mode.
- **The toggle is progressive enhancement:** a small JS island sets `data-theme` on `<html>` and persists to `localStorage`; an inline script in `app.html` re-applies it before first paint (no flash). Without JS the toggle control is absent, the page still themes correctly.
- Explicit `data-theme` always beats the media query — both directions.

### Typography

- **Heading Font:** Libre Bodoni
- **Body Font:** Public Sans
- **Mood:** magazine, editorial, publishing, refined, journalism, print
- **Google Fonts:** [Libre Bodoni + Public Sans](https://fonts.googleapis.com/css2?family=Libre+Bodoni:wght@400;500;600;700&family=Public+Sans:wght@300;400;500;600;700&display=swap)

**CSS Import:**
```css
@import url('https://fonts.googleapis.com/css2?family=Libre+Bodoni:wght@400;500;600;700&family=Public+Sans:wght@300;400;500;600;700&display=swap');
```

### Spacing Variables

| Token | Value | Usage |
|-------|-------|-------|
| `--space-xs` | `4px` / `0.25rem` | Tight gaps |
| `--space-sm` | `8px` / `0.5rem` | Icon gaps, inline spacing |
| `--space-md` | `16px` / `1rem` | Standard padding |
| `--space-lg` | `24px` / `1.5rem` | Section padding |
| `--space-xl` | `32px` / `2rem` | Large gaps |
| `--space-2xl` | `48px` / `3rem` | Section margins |
| `--space-3xl` | `64px` / `4rem` | Hero padding |

### Shadow Depths

| Level | Value | Usage |
|-------|-------|-------|
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.05)` | Subtle lift |
| `--shadow-md` | `0 4px 6px rgba(0,0,0,0.1)` | Cards, buttons |
| `--shadow-lg` | `0 10px 15px rgba(0,0,0,0.1)` | Modals, dropdowns |
| `--shadow-xl` | `0 20px 25px rgba(0,0,0,0.15)` | Hero images, featured cards |

---

## Component Specs

### Buttons

```css
/* Primary Button */
.btn-primary {
  background: var(--color-accent);
  color: var(--color-on-accent);
  padding: 12px 24px;
  border-radius: 8px;
  font-weight: 600;
  transition: all 200ms ease;
  cursor: pointer;
}

.btn-primary:hover {
  opacity: 0.9;
  transform: translateY(-1px);
}

/* Secondary Button */
.btn-secondary {
  background: transparent;
  color: var(--color-primary);
  border: 2px solid var(--color-primary);
  padding: 12px 24px;
  border-radius: 8px;
  font-weight: 600;
  transition: all 200ms ease;
  cursor: pointer;
}
```

### Cards

```css
.card {
  background: var(--color-surface);
  border: 1px solid var(--color-border); /* borders carry separation in dark mode, where shadows vanish */
  border-radius: 12px;
  padding: 24px;
  box-shadow: var(--shadow-md);
  transition: all 200ms ease;
  cursor: pointer;
}

.card:hover {
  box-shadow: var(--shadow-lg);
  transform: translateY(-2px);
}
```

### Inputs

```css
.input {
  background: var(--color-surface);
  color: var(--color-foreground);
  padding: 12px 16px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  font-size: 16px;
  transition: border-color 200ms ease;
}

.input:focus {
  border-color: var(--color-ring);
  outline: none;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-ring) 15%, transparent);
}
```

### Modals

```css
.modal-overlay {
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
}

.modal {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 16px;
  padding: 32px;
  box-shadow: var(--shadow-xl);
  max-width: 500px;
  width: 90%;
}
```

---

## Style Guidelines

**Style:** Swiss Modernism 2.0

**Keywords:** Grid system, Helvetica, modular, asymmetric, international style, rational, clean, mathematical spacing

**Best For:** Corporate sites, architecture, editorial, SaaS, museums, professional services, documentation

**Key Effects:** display: grid, grid-template-columns: repeat(12 1fr), gap: 1rem, mathematical ratios, clear hierarchy

### Page Pattern

**Pattern Name:** Timeline / Content First (app surface, not a marketing page)

- **Section Order:** 1. Masthead (site name), 2. Composer + add-remote forms, 3. Unified timeline (newest first), 4. "Older posts" pagination link
- **Layout:** single centered column, `max-width: 42rem` (~65ch) — long-form text measure governs the width, not a 12-col grid
- **Post anatomy:** author display name + `@handle` + kind badge (`local`/`remote`) · optional title (heading font) · body text · media enclosure (below text) · source link / timestamp

### Textcaster-specific constraints (from the spec — override anything above that conflicts)

1. **No-JS first-class:** every style must read correctly on plain SSR HTML; JS only enhances. No CSS that depends on JS-added classes.
2. **Live timeline:** SSE island prepends posts at the top. Insertions must not jank — fixed post paddings, no entrance animations taller than the post, respect `prefers-reduced-motion`.
3. **Local vs remote must be legible:** this is the product thesis. Distinguish with the kind badge + a subtle border/marker on `.post.remote` — never color alone.
4. **Theme toggle is an enhancement, not a requirement:** no-JS users get the correct theme from `prefers-color-scheme`; the toggle (JS island) only overrides it. Design and test every component in both themes — dark is not an inversion pass at the end.
5. **Text first, enclosures second:** body text is the primary content. Media enclosures (podcast audio, images, video) render as an attachment block *below* the text, never as a hero. Use native `<audio controls>` / `<video controls>` / `<img loading="lazy">` — no player libraries. Images: `max-width: 100%`, declared aspect-ratio to avoid CLS.

---

## Anti-Patterns (Do NOT Use)

- ❌ Poor typography
- ❌ Slow loading

### Additional Forbidden Patterns

- ❌ **Emojis as icons** — Use SVG icons (Heroicons, Lucide, Simple Icons)
- ❌ **Missing cursor:pointer** — All clickable elements must have cursor:pointer
- ❌ **Layout-shifting hovers** — Avoid scale transforms that shift layout
- ❌ **Low contrast text** — Maintain 4.5:1 minimum contrast ratio
- ❌ **Instant state changes** — Always use transitions (150-300ms)
- ❌ **Invisible focus states** — Focus states must be visible for a11y

---

## Pre-Delivery Checklist

Before delivering any UI code, verify:

- [ ] No emojis used as icons (use SVG instead)
- [ ] All icons from consistent icon set (Heroicons/Lucide)
- [ ] `cursor-pointer` on all clickable elements
- [ ] Hover states with smooth transitions (150-300ms)
- [ ] Both themes: text contrast 4.5:1 minimum, checked independently
- [ ] Theme toggle overrides system preference in both directions; no flash on load
- [ ] Borders/dividers and interaction states visible in dark mode (not shadow-only)
- [ ] Focus states visible for keyboard navigation
- [ ] `prefers-reduced-motion` respected
- [ ] Responsive: 375px, 768px, 1024px, 1440px
- [ ] No content hidden behind fixed navbars
- [ ] No horizontal scroll on mobile
