# Textcaster — walkable feeds (threadwalker parity) design

Date: 2026-07-17
Status: design approved (brainstorm); spec pending review
Author: Ricardo (rmdes) with Claude Code
Prior art: `2026-07-16-textcaster-threading-design.md` (source:inReplyTo /
thr: dual-emit, comments feeds, injectors); the parallel session's firehose
work (`/users/rss.xml` + source:account injection, push topic); ingest-side
permalink-guid fix (rss.chat items' guid-as-permalink). Motivating
evidence: Dave Winer's reference `threadwalker`
(`rss.chat/examples/threadwalker/walker.js`) run live against a Textcaster
instance on 2026-07-17 — the tree walks, but the starting-post guid match
fails and every author prints `?`. Discussion:
https://github.com/scripting/rss.chat/issues/13.

## What this milestone adds

Two emission-layer changes that make Textcaster conversations walkable by
Dave's threadwalker verbatim, closing our produce/consume asymmetry:

1. **Permalink guids outbound.** Local posts' emitted `<guid>` becomes the
   post's permalink URL (bare element, spec-default `isPermaLink=true`) —
   the rss.chat convention our ingest already honors inbound.
2. **`source:account` on every multi-consumer feed.** Comments feeds and
   per-user feeds gain the injection the firehose already has.

Plus a **walker-parity test** that pins Dave-compatibility permanently by
mimicking walker.js's exact semantics in-process.

## Probed facts (2026-07-17, do not re-derive)

- walker.js matches the starting post with `item.guid === guidStartingPost`
  (plain string compare, xml2js `explicitArray: false`). ANY attribute on
  `<guid>` makes xml2js yield an object → the compare silently never
  matches. Run 1 against our feeds printed nothing for exactly this reason.
- walker.js reads the comments feed URL from `comments.$.feedUrl` — our
  `<source:comments count feedUrl/>` attribute shape is already correct
  (run 2 walked the full tree: 4 posts, 3 authors, correct nesting).
- walker.js prints authors from `item["source:account"]._` — absent on our
  per-user and comments feeds today (firehose only), hence `?`.
- `replyWireElements` (feed.ts:36-42) already emits `source:inReplyTo`
  WITHOUT `isPermaLink=false` (and `thr:` with `href`) when the ref is a
  URL — permalink refs flow through the existing branch untouched.

## Design

### Permalink guids (emission layer only)

One derivation function in `core/src/domain/feed.ts`, keyed off the post's
**stored `url`** — NOT reconstructed from current publicUrl (F-3: guid must
share one source with `<link>` and reply-refs so they can never drift, and
so a post predating url-storage keeps its stable UUID guid):

```ts
// The emitted identity of a local post. A post created under a public URL
// stored url = `${publicUrl}/post/${id}` (service.ts:47) — that stored url
// IS the permalink and becomes the guid, bare (rss.chat's convention, which
// our ingest already honors inbound). A post with no stored url keeps its
// UUID guid with isPermaLink="false" (a bare non-URL guid would be a lie,
// and that post emits no <link> either — consistent).
function localGuid(p: Post): { value: string; isPermaLink?: false }
```

- `p.url` present → `{ value: p.url }` — NO `isPermaLink` key.
- `p.url` null → `{ value: p.guid, isPermaLink: false }` (today's shape).

PIN (verified against feedsmith 2.9.6, load-bearing): the URL-form element
must be **attribute-free** in the emitted XML, because walker.js does a
plain string compare `item.guid === startingGuid` and xml2js turns ANY
attribute into an object that never equals a string. Probed serializer
behavior: `{ value, isPermaLink: true }` emits `<guid isPermaLink="true">`
(an explicit-true attribute STILL breaks the walker); `{ value }` with the
key omitted emits a bare `<guid>` (correct); a bare string emits no guid at
all. So the URL branch MUST be `{ value: p.url }` with the `isPermaLink`
key omitted entirely — not `true`. The walker-parity test asserts the bare
shape.

Applied at every serialization of a LOCAL post:

- per-user RSS items, comments-feed items, firehose items (the three
  render paths in feed.ts) — all three currently hardcode
  `guid: { value: p.guid, isPermaLink: false }`; each becomes `localGuid(p)`;
- JSON Feed `id` (same derived value — one identity everywhere);
- the injectors' guid keying: `injectSourceComments` / `injectSourceAccounts`
  call sites currently pass `p.guid`; they MUST pass `localGuid(p).value`
  (the EMITTED guid), because `injectItemElements` matches on the `<guid>`
  element's value in the XML it injects into — passing the UUID when the
  XML now holds the URL would silently no-op the injection;
- reply refs: `source:inReplyTo` / `thr:in-reply-to` already carry
  `replyTo.url ?? replyTo.guid` (service.ts:49, stored at reply creation) —
  same permalink source, already consistent, and `replyWireElements`
  already emits the URL form attribute-free. No change needed; the plan
  pins it with a test.
- pushed fat-ping bodies: rendered by the same feed renderers — parity is
  free, but the plan verifies it (push.ts renders + injects itself).

**Storage is untouched.** `posts.guid` stays the creation-time UUID; the
permalink form comes from the already-stored `posts.url`. No migration, no
new column, no dual-write; the UUID remains the internal fallback identity
for url-less posts.

**Remote posts are untouched.** Pass-through re-emission keeps the origin's
guid verbatim (their identity, not ours) — only `source: 'local'` posts get
derived guids.

**Accepted one-time break, recorded honestly:** the emitted guid is item
identity to subscribers, and it changes for url-bearing local posts (UUID →
permalink URL) — those items re-appear as new once to anything that already
ingested them. Scope is narrow and the timing is deliberate: url-storage
itself only just landed (firehose work), so url-bearing posts barely
predate this change, and there are no real external peers pre-release. We
do NOT build a transition shim; delete-and-refollow is the dev-era answer.

**Self-ingest coherence:** another Textcaster following our feed stores
guid = our permalink URL; replies referencing that URL resolve by
guid-or-link matching (both match — guid equals link). Our OWN reply
resolution over internal ids is unaffected.

### source:account everywhere

- Comments feeds (`/post/:id/comments.xml`): inject
  `<source:account service="{host}">{author.handle}</source:account>` per
  item — multi-author, this is the real gap.
- Per-user feeds (`/users/:handle/feed.xml`): same injection (single
  author, but rss.chat does it and walker.js reads it on the starting
  item).
- Firehose: already done (parallel session) — untouched.
- `service` = host of publicUrl, `name` = handle: matches the firehose's
  existing choice; consistency beats bikeshedding the value.
- Injection requires publicUrl (host derives from it) — same gating as the
  firehose's injection. Without publicUrl, feeds stay as today.

### Walker-parity test (the money test)

One core test that mimics walker.js's semantics — not a port, a parity pin:

- Build a threaded conversation over HTTP (session helpers), publicUrl set.
- Parser: whatever the test can do with installed deps (feedsmith's parse
  if it exposes guid attributes faithfully, else a minimal targeted
  extraction) — NO new dependency; probed at plan time.
- Fetch the author's feed via `app.request`, parse with an attribute-aware
  XML parse, and locate the starting item by **plain string compare on the
  guid** — this assertion is the whole point: it fails if `<guid>` ever
  grows an attribute again.
- Recursively follow `source:comments`' `feedUrl` attribute through
  `app.request`, collecting `(author-from-source:account, first text line,
  depth)`.
- Assert the exact indented outline: authors by name (never `?`), correct
  nesting, guid === the post's public permalink.

Plus regular unit coverage: `localGuid` both branches; reply-ref URL form;
JSON Feed id parity; remote pass-through guid untouched.

## F-1: Firehose spec reconciliation (on the record)

This spec **reverses** the firehose spec's guid decision. The firehose
design (`2026-07-17-textcaster-firehose-design.md`, the "Named divergence
from Dave (deliberate — do not 'fix')" block) keeps UUID guids emitted with
`isPermaLink="false"`, on the stability argument that changing guid VALUES
makes existing posts reappear as new and breaks cross-instance reply refs.
That reasoning held ONLY under "real external peers exist" — pre-release
they don't, which is exactly why the one-time break is acceptable now and
won't be later. This is a deliberate reversal of that earlier decision (and
of this author's earlier endorsement of it), not an oversight.

Three reconciliation actions (documentation + real test work, no new
design):

1. **Annotate the firehose spec** with a retraction note pointing here, so
   the two committed specs don't contradict on the record. Executed specs
   are historical records — the annotation is a dated superseded-by
   pointer, not a rewrite of the firehose decision's body.
2. **Update the firehose guid-stability tests.** `core/test/feed.test.ts`
   asserts the old shape — line ~117 expects
   `<guid isPermaLink="false">guid-1</guid>` on a firehose fixture whose
   post ALSO carries `url` (`<link>.../post/p1</link>`), so under `localGuid`
   its guid becomes the bare permalink and the assertion must change to the
   new shape. Line ~46's per-user assertion depends on whether `seedAlice`
   sets `url` (probe at plan time — if url-less it still passes, if
   url-bearing it flips). This is real test work, enumerated in the plan.
3. **Sequence so the permalink guid lands once.** The firehose is already
   implemented and committed, so there is no UUID-then-switch churn to
   avoid mid-build — this batch makes the switch in one commit on top of the
   landed firehose. The guid-emission change and its test updates ship
   together.

## Interaction with the shared checkout

The parallel session's firehose/discoverability work has LANDED (it owns the
`feed.ts` / `app.ts` surface this batch edits). Coordinate the usual way:
read current file state before every edit, explicit staged paths, small
commits. No API, schema, or web-app changes in this batch — core emission +
tests only.

## Non-goals

Migrating stored guids; any ingest change (already permalink-aware); a
transition shim for the one-time identity break; PRing walker.js's
object-guid fragility upstream (bare guids make his code work as-is —
that's the point); JSON Feed changes beyond the `id` value; changing
`source:account`'s service/name scheme; WebSub topic URLs (feed URLs,
unaffected); the web UI.
