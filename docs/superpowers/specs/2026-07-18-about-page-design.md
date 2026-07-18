# About page — design

Date: 2026-07-18
Status: design approved (brainstorm); implementation not started
Author: Ricardo (rmdes) with Claude Code

## What it is

A single, self-contained `/about` page in the web app that explains
Textcaster's **why, what, how, and who** — its reason to exist — to a curious
newcomer first, while keeping the technical substance present for RSS/IndieWeb
peers. Hybrid tone: a short manifesto-style opening, then scannable sections.

Grounding: content is distilled from `README.md` and the founding design
(`docs/superpowers/specs/2026-07-15-textcaster-design.md`). No new claims —
every statement traces to those two documents.

## Why it's needed

The project is "pre-release, but deep": it's at the point where it's worth
showing people, but there is nowhere in the running app that says what it is
or why it exists. A newcomer landing on the timeline sees posts, not purpose.
`/about` is that front door.

## Route and rendering

- **File:** `web/src/routes/about/+page.svelte`. Static prose only — **no
  `load`, no server data, no form actions.** Works fully with JavaScript off.
- Reuses the existing masthead idiom (a `Textcaster` wordmark link home + the
  `ThemeToggle` island) so it reads as part of the app, not a detached
  marketing site.
- Inherits the app's three-state theming and `--color-*` / `--space-*` / font
  tokens automatically via `app.css`. No raw hex; no new tokens.

## Layout

Single centered reading column (`max-width` ≈ 44rem, matching the timeline's
middle column), generous vertical rhythm. Editorial, document-like — Libre
Bodoni headings, Public Sans body, RSS-orange (`--color-accent`) reserved for
links and one hero accent. Not a grid of cards; this is a page you read.

## Structure (hybrid)

1. **Hero / one-breath why** — wordmark, a one-line definition, and a short
   manifesto paragraph: two worlds that kept their distance — Dave Winer's
   RSS / Textcasting lineage and the IndieWeb — unified, with local posters
   and bring-your-own-site posters as equal citizens of one live timeline.
2. **Why it exists** — 2–3 short paragraphs: the problem (feeds and IndieWeb
   siloed; social locked inside proprietary APIs) and the bet (following,
   threading, and whole conversations that travel as plain RSS).
3. **What it is** — scannable list from README's "What works today": one live
   timeline (no-JS), rich Markdown posting, real conversations over RSS
   threading, feeds in / feeds out, live federation, rss.chat interop,
   accounts, self-hosting.
4. **How it works** — plain-language: headless core + web client; open
   standards (RSS, OPML, JSON Feed, WebSub, rssCloud) do the federating; one
   sanitized render path. Newcomer-first phrasing; technical depth downstream.
5. **Who / lineage** — attribution to Dave Winer & textcasting.org, the
   IndieWeb community, JSON Feed (Manton Reece & Brent Simmons), the rss.chat
   lineage; built by Ricardo (rmdes); MIT-licensed and self-hostable. Links to
   the GitHub repo, the README, and the founding spec.

## Honesty guardrail

The page mirrors the README's careful framing. Working features are stated
plainly; **roadmap items (IndieAuth sign-in, Micropub, Webmention,
ActivityPub) are clearly marked as next, not done.** The page must never imply
a roadmap capability already works.

## Discoverability — global footer

Add one minimal `<footer>` to the root `web/src/routes/+layout.svelte` so the
About link is reachable from every page (the timeline masthead/chrome is left
untouched). The footer carries:

- an **About** link (`/about`),
- the existing all-users feed link (`/users/rss.xml`),
- a repo link.

This is the smallest change that makes a "footer link" actually discoverable.

## Accessibility

Semantic landmarks (`<main>`, one `<h1>`, section `<h2>`s), theme inherited in
both directions, focus-visible rings intact, a descriptive `<title>` and meta
description. Link contrast already verified in MASTER.md.

## Out of scope

- No i18n / multiple languages.
- No dynamic instance stats (peer counts, user counts) — static prose only.
- No new design tokens or components; reuse `ThemeToggle` and existing CSS.
- Roadmap page, changelog, or docs hub — this is one page.

## Testing

Proportionate to a static page: a SvelteKit route smoke test in the existing
`web` suite asserting `/about` renders (200, contains the wordmark and the
section headings) and works without JS (plain SSR GET). No island to test.
