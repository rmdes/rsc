# Spec review — rich content rendering (UI-6), security-first

Date: 2026-07-16
Target: `docs/superpowers/specs/2026-07-16-textcaster-rich-content-design.md` (b3cbff9)
Grounded: every claim from a file read or a probe/doc fetch (marked, sanitize-html).

**Verdict: NOT ready to plan as written. One security-latent gap (SEC-1),
two HIGH correctness bugs in the backfill path (COR-1/COR-2), and one
under-scoped piece (COR-3). The sanitizer config, marked→sanitize order,
migration numbering, clamp, and dedup are all sound.**

## Security

### SEC-1 — HIGH: the client-fetch wedge is a THIRD, un-enriched ingress the spec omits

The spec claims enrichment at exactly two points (page `load`, `/stream`) and
"the browser never sees raw content." Incomplete. Trace: `toggleWedge` →
`wedge.ts` `fetchThread` does a CLIENT-side `fetch('/post/<id>/thread.json')`
→ `web/src/routes/post/[id]/thread.json/+server.ts` pipes core's thread JSON
straight through with **no `contentHtml` enrichment** → populates `expanded`
→ `<ReplyTree>` → `PostBody`. So wedge-revealed replies (which include remote
firehose content — the untrusted kind) reach `PostBody` with no `contentHtml`.
As-specced (fallback = `plaintext()`) they silently degrade to plaintext (a
rendering-inconsistency bug); the real danger is the **latent XSS**: an
implementer who "fixes" the ugly degrade by rendering raw `content` in the
fallback ships stored-XSS on remote HTML. The spec's undercount of ingress
points is exactly what invites that.
**Fix (root-cause, lazy):** enrich in the `thread.json` proxy too — same
server-side proxy shape as `/stream` but simpler (plain JSON, no SSE framing).
Then `ReplyTree` entries carry `contentHtml` on every path. THREE ingress
points, all server-side. The spec must say so, and the plan must resolve it —
not discover it in implementation.

### SEC-2 — sanitizer config safe + achievable, with one gotcha to pin

Verified against sanitize-html's real defaults: `allowedSchemes` default has
NO `data:` (the "default allows data: for img" worry is backwards — it's
dropped), and `allowedSchemesAppliedToAttributes` covers both `href` and
`src`. To honor http(s)-only literally, set `allowedSchemes: ['http','https']`
(drops ftp/mailto/tel). `script`/`style` content discarded (nonTextTags),
`iframe`/`svg`/`on*`/`class`/`style` dropped. `rel`/`loading` forced via
`transformTags`. **Gotcha:** attributes ADDED by transformTags must ALSO be in
`allowedAttributes` (`a: ['href','rel']`, `img: ['src','loading','alt']`) or
attribute filtering strips the forced `rel`/`loading` right back off. The
spec's allowlist lists only `a[href]`/`img[src]` — add `rel`/`loading`.

### SEC-3 — marked→sanitize order correct; fallback genuinely raw-safe
marked has had no built-in sanitizer since v8 — it passes embedded raw HTML
through, so the load-bearing fixture (raw `<script>`/`<img onerror>` in a
Markdown doc) is caught by sanitize-html downstream. Order right. GFM default
autolinks bare URLs. Fallback `plaintext()` strips tags + Svelte-escapes; no
`{@html}`. And there is ZERO existing `{@html}` in web today — this spec
introduces the first, so the whole boundary is new.

### SEC-4 — MED: core emits UNSANITIZED rendered HTML in its own feeds
Local `<description>` = `marked(content)` and core "does NOT sanitize" — so a
local author's `<script>` in Markdown lands in Textcaster's OWN
`feed.xml`/`feed.json` and ships to any naive aggregator. Rests entirely on
"all consumers sanitize" + "local authors trusted." For a multi-user instance
that assumption should be explicit, or core should sanitize its outbound HTML.
Intersects the ponytail question below.

## Ponytail
- `sanitize-html` (web), `marked` (web): required, don't hand-roll. Keep.
- **`marked` in CORE: questionable.** Its only job is `marked(content)` for the
  feed `<description>`. The lazy alternative — core stays Markdown-only, emit
  raw Markdown as description, let consumers render — drops a core dep AND
  removes the SEC-4 unsanitized-emission surface in one move. Cost: legacy
  readers that don't grok `source:markdown` lose rich rendering. **Confirm the
  legacy-reader requirement is real before adding marked to core;** if real,
  core must also sanitize that HTML (SEC-4).
- `PostBody.svelte` dedup (retires 5 duplicated body blocks): net deletion,
  approved. Render-per-request no-cache: fine, correctly ceilinged.

## Correctness holes
- **COR-1 — HIGH:** `backfillSourceAttribution` (`sqlite.ts:249-259`) gates the
  WHOLE update on `WHERE source_name IS NULL`. Renaming it and adding
  `content_markdown` under that same single-column gate means a post that
  already has `source_name` (migration 6) but null `content_markdown`
  (migration 7) NEVER gets markdown backfilled — the guard excludes it. Use
  per-column `COALESCE(content_markdown, :md)` with an independent predicate
  (`… OR content_markdown IS NULL`).
- **COR-2 — HIGH:** the ingest backfill trigger (`ingest.ts:153`
  `else if (item.sourceName || item.sourceFeedUrl)`) omits `contentMarkdown`,
  so a re-poll newly supplying `source:markdown` never calls the backfill.
  Add `|| item.contentMarkdown`.
- **COR-3 — MED:** the `/stream` transform is real work, not "a transform in
  its pipe" — today the proxy is a pure pass-through. It needs a `TransformStream`
  that parses SSE frames, JSON-parses only `event: post` data, enriches,
  re-serializes, passes `event: ping` and `id:`/`event:` lines byte-intact,
  and buffers across chunk boundaries. "Replay untouched" rests on getting
  id-line preservation right. (Mitigant: `JSON.stringify(entry)` is single-line,
  so frames have no embedded newlines.) Scope it as real work + tests.
- **COR-4 — MED:** `contentMarkdown` must thread through ~7 mechanical sites
  (`ParsedItem` → `toParsedItem` → `Post` → `insertPost`/`PostsTable` →
  `rowToPost` → core `TimelineEntry` on timeline/thread/SSE → web
  `TimelineEntry`), not the one the spec names — else precedence reads
  `undefined`.
- **COR-5 — LOW (pre-existing):** ingest collapses remote text-or-HTML into one
  `content`; the "remote → render as HTML" branch renders a plain-text
  description as HTML. Note only.

## Ambiguities to pin
- Exact `allowedAttributes` (add `rel`/`loading`; decide `alt`); `rel` value
  (`noreferrer` matches existing anchors vs `noopener noreferrer`).
- Core-feed sanitization / whether `marked` belongs in core (SEC-4 + ponytail).
- Wedge enrichment in `thread.json` proxy (SEC-1) — resolve in the plan.
- `PostBody` fallback spelled `contentHtml ? {@html} : plaintext(content)` —
  never `contentHtml ?? content` into `{@html}`.

## Verified sound
- Migration numbering: `MIGRATIONS.length === 6`, next IS 7. ✓
- Clamp works on rich HTML (anchor-exempt, click-time scrollHeight). ✓
- Single-`{@html}` chokepoint starts from zero existing `{@html}`. ✓
- Sanitizer drops script/style/iframe/svg/on*/class/style; data: dropped by
  default. marked→sanitize catches embedded raw HTML; plaintext fallback safe.

## What must change before planning
SEC-1 (enrich the thread.json proxy — the XSS-latent gap), COR-1 + COR-2 (the
backfill per-column predicate + the ingest trigger), COR-3 (scope the SSE
parser as real work), the SEC-4/ponytail marked-in-core decision, and COR-4
(enumerate the ~7 wire sites). Sanitizer config, marked ordering, migration,
clamp, and dedup are sound.
