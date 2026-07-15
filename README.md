# Textcaster

A multi-user, real-time social timeline built natively on feeds — where the
line between "post here" and "bring your own site" disappears. People who post
through the instance and people whose posts arrive from their own website's
feed live side by side in the same timeline.

Textcaster deliberately unites two traditions that have kept their distance:
**RSS / OPML / JSON Feed / Textcasting** and the **IndieWeb** (Micropub,
Webmention, IndieAuth, microformats). It takes the useful building blocks from
both and leaves the ideological blocks behind.

> **Status: the spine is runnable end to end.** Local posts and remote feed
> items live in one timeline, server-rendered and updating live over SSE. See
> [`docs/RUNNING.md`](docs/RUNNING.md) to run it. The founding design is in
> [`docs/superpowers/specs/2026-07-15-textcaster-design.md`](docs/superpowers/specs/2026-07-15-textcaster-design.md).

## The idea in one paragraph

A "user" is one of three kinds — **local** (posts through the instance),
**claimed remote** (a person who proved their own domain via IndieAuth and
feeds the instance from their site), or **unclaimed remote** (any external
feed added as a followable entity) — and the timeline treats all three
identically. A headless TypeScript core exposes a token-accepting HTTP + SSE
API; the web app (SvelteKit) is just one client of it, so alternate frontends
and IndieWeb endpoints can be built against the same API later. Real-time is
first-class (SSE within an instance; WebSub/rssCloud between instances), and
the site works without JavaScript.

## Credits and lineage

The name is an attribution. Textcaster stands on ideas and standards it did
not invent:

- **Dave Winer** and [textcasting.org](https://textcasting.org) — the
  Textcasting manifesto, RSS, OPML, rssCloud, and the
  [rss.chat](https://github.com/scripting/rss.chat) idea this reimagines.
- **The IndieWeb community** — Micropub, Webmention, IndieAuth, and
  microformats2.
- **JSON Feed** — Manton Reece and Brent Simmons.
- **WebSub** and the broader open-feed ecosystem.

Textcaster's job is to make these work together, credited, in one place.

## License

TBD (to be chosen before first release).
