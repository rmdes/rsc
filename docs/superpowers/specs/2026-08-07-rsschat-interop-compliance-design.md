# rss.chat interop compliance — design

**Status:** rev 2 — ready to plan.
**Spec of record for:** the six findings reported by `valid.rss.chat` v0.4.0
against our live feeds on 2026-08-06.

**Revision history**
- **rev 1** (2026-08-07) — first design, approved conversationally.
- **rev 2** (2026-08-07) — folded a ponytail-review pass that verified every code
  claim against source and found three of them wrong. Changes: markdown is
  **already stored** for the v1-converted corpus, so most of §4.3 collapses into
  a one-line read (C1); populating it **is** a visible render change and rev 1
  denied that (C2); the comments feed has no sort today and rev 1's wording read
  as if it did (C3); the guid test is `guid === url`, not URL-shape inference,
  which also drops a helper (I1); the reply ref uses the resolved parent's
  advertised guid rather than a verbatim string that may not match (I2); the
  heal is one guarded UPDATE, not a widened shared helper (I3). Test list cut
  from 8 assertions to 4 new tests + 4 folded.

Textcasting originates with Dave Winer; rss.chat (`/home/rmdes/rss.chat-upstream/`)
is his implementation. RSC's standing goal is to be **equal or better, and always
interoperable**. This spec closes the gap the validator found — while explicitly
declining one rule, for a reason recorded below.

---

## 1. How the findings were obtained

`valid.rss.chat` is a client-side app over a streaming NDJSON endpoint:

```
GET https://valid.rss.chat/validatestreaming?url=<percent-encoded-feed-url>
```

One JSON object per line — a `{reading:…}` line per address probed, then a final
`{result:…}` carrying `kind`, `ctErrors`, `ctWarnings`, and `findings[]`. The
validator follows what a feed hands out: item guids, `source:comments` feeds,
the author feed named by `<source>`, and each reply's target.

**Baseline.** rss.chat's own three files validate clean, which establishes that
the validator encodes his conventions exactly and that a 0/0 result is achievable:

| File | kind | errors | warnings |
|---|---|---|---|
| `rss.chat/users/rss.xml` | aggregateFeed | 0 | 0 |
| `rss.chat/users/dave/rss.xml` | userFeed | 0 | 0 |
| `rss.chat/data/subs.opml` | subscriptionList | 0 | 0 |

**Ours, 2026-08-06** (`rsc.rmdes.be`): all-users feed 1 error / 2 warnings; the
`paul` user feed 1 error / 3 warnings; one comments feed 0 errors / 5 warnings.

---

## 2. Root cause

Local posts emit a complete Textcasting item. **Remote items relayed into our
comments feeds are stripped of their Textcasting metadata.** Observed on the
wire at `rsc.rmdes.be/post/e0d403d4-…/comments.xml`:

| element | item 1 (local reply) | item 2 (relayed from alice) |
|---|---|---|
| `source:inReplyTo` | present | **absent — the ERROR** |
| `thr:in-reply-to` | present | absent |
| `source:markdown` | present | absent |
| `<guid>` | bare permalink | `isPermaLink="false"` on an absolute URL |

Three separate causes, all on the remote path:

- `core/src/logical/projector.ts:601` — `inReplyToRef: null`, hardcoded with a
  comment describing it as intentional ("remote items keep the current
  firehose/comments behavior"). The value is available: `mat.material.inReplyTo`
  is already read at `:579` to build `replyContext`.
- `core/src/logical/projector.ts:594` — `contentMarkdown: null`, hardcoded. This
  is a **projection** gap, not a storage gap: `core/src/migration/convert.ts:553-559`
  already persists `contentMarkdown` into `normalized_json` for every v1-converted
  item ("preserved here so conversion loses nothing"), sourced from
  `posts.content_markdown` which v1 ingest populated from `source:markdown`
  (`core/src/domain/ingest.ts:114`). What is genuinely missing is capture for
  items acquired **natively by v2 after cutover** — `RawItem`
  (`core/src/logical/acquisition.ts:114`) has no markdown field.
- `core/src/domain/feed.ts:257` — the remote branch stamps `isPermaLink="false"`
  unconditionally, including on guids that are byte-identical to the item's
  permalink. Alice emits that same post with a bare guid; we downgrade it on relay.

---

## 3. Scope

**In scope**

| # | Finding | Severity | Section |
|---|---|---|---|
| 1 | `replyDoesntPointBack` | **error** | §4.1 |
| 2 | `guidNotPermalink` | warning | §4.2 |
| 3 | `markupWithoutMarkdown` | warning | §4.3 |
| 4 | `selfMissing` | warning | §4.4 |
| 5 | `itemsOutOfOrder` | warning | §4.5 |

**Out of scope, with reasons**

- **`sourceNamespaceUnexpected` — declined.** We declare
  `xmlns:source="http://source.scripting.com/"`; rss.chat declares `https://`.
  Per the W3C XML Namespaces spec a namespace name is an **opaque identifier
  compared by exact string match** — never dereferenced, with no scheme
  equivalence. This is why the canonical namespaces are frozen in `http://`
  long after their hosts moved to TLS (`http://www.w3.org/2005/Atom`,
  `http://purl.org/dc/elements/1.1/`). Changing ours would mint a *different*
  namespace and break any consumer keyed on the current one. The URI is emitted
  by feedsmith (`node_modules/feedsmith/dist/namespaces/source/common/config.js`
  `uris[0]`) and is **not configurable**; feedsmith's parser accepts all four
  scheme/trailing-slash variants, and Dave's validator makes this a *warning*,
  not an error, which suggests the same reading. Our emission is self-consistent
  (feedsmith and the `feed.ts:221` injector both use `http://`), and consistency
  is the property that actually matters.
  *If this is ever revisited, the correct venue is upstream — feedsmith and/or
  Dave — not post-processing our own XML.*
- **`urlAnsweredWithAnError` — not ours.** A user replied to a reddit URL that
  answers 403 to the validator's fetch. Nothing in our code produces or can fix
  this.

---

## 4. Design

### 4.1 Remote replies carry a reply ref that resolves  *(closes the ERROR)*

`projector.ts:601` stops hardcoding null. For a remote item:

- **parent resolved** (always true in a comments feed — `read.ts:188` filters on
  `parentLogicalItemId === id`): emit the **parent's own advertised guid** via
  `parentReplyRef` (`core/src/logical/local.ts:52`), the function local replies
  already use at `local.ts:175`. Its docblock states the contract exactly: "a
  peer string-matches it against the parent's own `<guid>` exactly as under v1."
- **parent unresolved**: emit `safeUrl(mat.material.inReplyTo)` verbatim — the
  honest record of what the origin claimed.

**Why not verbatim in both cases.** `replyDoesntPointBack` is a *string compare*
of the ref against the parent's guid. An origin can legitimately cite a different
URL form than the one we emit for that post (scheme, trailing slash, alias,
syndicated copy) and still resolve to it on our side, in which case a verbatim
ref does not match and the error survives. Using the resolved parent's advertised
identity closes the finding **by construction** rather than by luck, and reuses
a function that already exists rather than adding one.

`parentReplyRef` is typed `WriteTx` but performs only SELECTs; widen its
parameter to `ReadTx` so the projector can call it (both `Tx` types are defined
in `core/src/logical/database.ts`).

`itemContentFields` (`feed.ts:111`) then emits `source:inReplyTo` **and**
`thr:in-reply-to` through the existing path; `feed.ts` needs no change.

**Blast radius.** The firehose (`renderFirehoseRss`) and user feeds
(`renderRssFeed`) are fed by `projectLocalActivity` (`read.ts:142,163`) and are
local-only. Remote items reach an outbound feed **only** via `renderCommentsFeed`.
`inReplyToRef` additionally becomes non-null in `/timeline` and `/post/:id` JSON
for remote items — additive, and the web has no consumer of it.

**No federation loop.** Nothing auto-subscribes to `source:comments` feeds, and
we re-emit a remote item under its origin wire guid (`logicalToFeedEntry`,
`feed.ts:33`), so a peer re-ingesting its own item dedupes on the guid it minted.

### 4.2 Stop declaring true permalinks non-permalinks

`feed.ts:257`'s remote branch becomes:

```ts
guid: p.source === 'local'
  ? localGuid(p)
  : { value: p.guid, ...(p.guid === p.url ? {} : { isPermaLink: false }) }
```

**Why identity, not URL-shape.** A URL-shape test (`startsWith('http')`) would
*upgrade* guids the origin explicitly declared non-permalinks: `acquisition.ts:243`
stores `opaqueId: str(it.guid?.value)` and **discards `isPermaLink`**, so a
WordPress-style `<guid isPermaLink="false">https://example.com/?p=123</guid>`
arrives as an http-shaped key. Emitting that bare would assert a permalink the
origin denied — the same dishonesty as the current bug, inverted. `guid === url`
is provable from stored data and needs no helper. It covers the observed failing
case: alice's `<link>` and `<guid>` are byte-identical, and `normalizePermalink`
(`core/src/logical/roots.ts:34`) only strips the fragment.

The remote guid **value** stays `p.guid` verbatim — never swapped to `p.url` —
preserving the invariant at `feed.ts:253-257`. The permalink branch **omits**
`isPermaLink` rather than emitting `isPermaLink="true"`, matching the pin at
`feed.ts:60-61` (a `true` attribute breaks Dave's walker); feedsmith's
`generateBoolean` omits the attribute on `undefined`.

**Injector interaction.** `injectItemElements` (`feed.ts:211`) keys on the marker
`` >${guid}</guid> ``, which still matches once the attribute disappears — so
`source:comments` injection keeps working. `feed.test.ts:313` already proves
injection lands on an attribute-free bare permalink guid.

### 4.3 Project the markdown that is already stored; capture what isn't

**Reuse the existing key name.** `normalized_json` already carries
`contentMarkdown` for converted items (`convert.ts:553-559`). Use that name
throughout — a second key meaning the same thing in the same blob is a bug
waiting to happen.

- `materialOf`'s `normalized` type (`projector.ts:480`) gains `contentMarkdown`.
- `projector.ts:594` becomes `contentMarkdown: mat.normalized.contentMarkdown ?? null`.
  **This one line backfills the entire v1-converted corpus** — no migration, no
  heal, no re-poll.
- `RawItem` (`acquisition.ts:114`) gains `contentMarkdown?: string | null`; the
  **RSS adapter branch only** (`acquisition.ts:242-254`) sets
  `str(it.sourceNs?.markdown ?? null)`, mirroring the adjacent
  `inReplyTo: it.sourceNs?.inReplyTo?.value ?? …` at `:249`. Atom, JSON Feed, RDF
  and h-feed have no `source:markdown` equivalent and are left alone.
- It rides `normalized` (`acquisition.ts:329`) — the blob that already carries
  `replyContextAuthor`/`replyContextSnippet` for exactly this reason.

**It must NOT enter the fingerprint.** `canonicalMaterialFor`
(`acquisition.ts:262`) is untouched. It builds an explicit object literal, so
adding a `RawItem` field cannot change its output — but the constraint is stated
because violating it re-fingerprints every remote item on the next poll of every
feed, which is the 2026-07-25 runaway (763k `observation_versions`, 2.6GB on
`rsc.rmendes.net`).

**This is a deliberate, visible presentation change.** `web/src/lib/server/render.ts:85`
is the one render path and takes `contentMarkdown` at top precedence:
`post.contentMarkdown ?? (post.source === 'local' ? post.content : null)`.
Remote items therefore move from *displaying the origin's HTML* to *our pipeline
rendering the origin's markdown* — across the timeline, thread view, and history
view (`web/src/routes/post/[id]/history/+page.server.ts:18`). This restores v1
behavior and is the Textcasting point: `source:markdown` is the writer's
original, HTML is derived. Two consequences to own:

- **The sanitizer remains the gate.** Both branches end in `sanitizeHtml`
  (`render.ts:87`), so this is not an XSS surface change. That invariant is
  load-bearing and must not be weakened while touching this path.
- **No live propagation.** The heal below fires no journal effect and no SSE, so
  an open client keeps showing the previous HTML until it reloads. Accepted:
  the change is cosmetic-per-item and self-corrects on next navigation.

**Heal — scoped to post-cutover items only.** Converted items need nothing (they
already have the key). Items v2 acquired natively since cutover have no markdown
stored and cannot be backfilled from stored data. For those, in the **unchanged**
branch of `commitAcquisition` (`acquisition.ts:673-677`), when the candidate
carries markdown, run one guarded statement:

```sql
UPDATE observation_versions_v2 SET normalized_json = ?
 WHERE id = ? AND json_extract(normalized_json, '$.contentMarkdown') IS NULL
```

- No new version row, no `resetObservationJob`, no journal effect — off the churn
  path entirely.
- **No change to `findCurrentDeliveryVersion`** (`acquisition.ts:594`): it is
  shared with `verification.ts:358` and `storage/sqlite.ts:1665` under a
  documented "never drift apart" contract, and the SQL guard removes any need to
  SELECT and parse the blob in JS. SQLite's JSON1 is built in.
- The guard matches both key-absent and key-null, and is false forever after the
  first pass — so it is idempotent by construction.
- **It rewrites the whole blob**, not just markdown, so fresh enclosure URLs and
  `replyContext*` ride along. Harmless, arguably desirable, but stated so it
  isn't a surprise.
- **Known bounded flip-flop:** if an *aggregate* feed carries `source:markdown`
  but the item's *origin* feed does not, re-verification (`verification.ts:192`,
  which builds `normalizedJson` from the same `parseCandidates`) can overwrite
  the healed blob with a markdown-less one, and the heal re-fires on the next
  poll. This costs one UPDATE per cycle — no version row, no job, no journal —
  so it is bounded, not churn. Left as accepted behavior.

### 4.4 Self-pointer on the feeds that lack one

- `renderCommentsFeed` gains **both** `atom:link rel="self"` (the standard) and
  `source:self` (what the validator checks). It currently emits neither, so
  unlike the user feed this is a real gap, not only a lint.
- `renderRssFeed` gains `source:self` (it already emits `atom:link rel="self"`
  at `feed.ts:126`). `renderFirehoseRss` already has both (`feed.ts:170,184`).
- **There is no shared comments-URL helper today** — the URL is an inline
  template literal at `read.ts:136` (`` `${pub}/post/${d.id}/comments.xml` ``),
  and `renderCommentsFeed` cannot reach it. Extract
  `commentsFeedUrl(publicUrl, id)` into `feed.ts` beside `feedUrls`/`firehoseUrl`
  (`feed.ts:74,78`) and use it in **both** places, so a feed's advertised
  `source:comments feedUrl` and that feed's own self-pointer can never disagree.
- Both self elements are emitted **only when `ctx.publicUrl` is set**, matching
  how `renderRssFeed`/`renderFirehoseRss` already gate their `atom:link`/`cloud`
  (`feed.ts:125`, `:169`) and how `injectComments` early-returns at `read.ts:133`.

### 4.5 Comments feed ordering

The comments feed is **oldest-first today** — `read.ts:187` is a filter+map with
no sort, and the order comes from `threading.ts:427` (`kept.sort(byOrder)` =
depth ASC, then `timelineSortAt` ASC), which is why `itemsOutOfOrder` fired.

Add a newest-first sort at `read.ts:189`, and let the same sorted array feed both
`renderCommentsFeed` and `injectComments` (`read.ts:193-194`).

Verified safe: `injectComments` keys by guid and is order-independent, and the
web UI never fetches `comments.xml` (it uses `/post/:id/thread`), so the
chronological conversation order users see is unaffected. Feed bytes only.

---

## 5. Testing

Wire-contract tests asserting on emitted XML rather than intermediate objects —
the contract broke at serialization, so that is where it must be held. Per house
flow each fix starts from a failing test. `core/test/feed.test.ts` already pins
local emission from seven angles (`:293,299,304,313,324,338,391`) plus a
`:259` self-round-trip, so **no byte-identity golden fixture is added** — it
would be a brittle snapshot to re-bless on every feedsmith bump.

**New tests (4):**

1. A relayed remote reply in a comments feed carries `source:inReplyTo` and
   `thr:in-reply-to` pointing at the parent's advertised guid — **including a
   fixture where the origin's ref differs from our emitted permalink** (§4.1's
   divergent case, the one verbatim emission would fail).
2. A remote item whose guid equals its permalink emits **no** `isPermaLink`
   attribute. (The non-URL half is already pinned at `feed.test.ts:299,331`.)
   Include the origin-declared-non-permalink case from §4.2: guid ≠ url ⇒
   attribute retained.
3. An unchanged re-poll carrying markdown heals `normalized_json` **without**
   creating a version row or re-pending a job; a second pass is a no-op; a
   converted item already carrying `contentMarkdown` is untouched.
4. Comments feed items are newest-first.

**Folded into existing tests (4):**

- `canonicalMaterialFor` is byte-identical with and without markdown — 3 lines in
  `core/test/logical-acquisition.test.ts`. Structurally unreachable given the
  explicit literal, but the incident earns a cheap regression guard.
- `source:comments` injection still lands on an attribute-free guid — one extra
  `expect` in the existing remote-comments test (`feed.test.ts:360`).
- Self elements omitted without `publicUrl` — add the comments feed to
  `feed.test.ts:122` ("links are omitted without config").
- Remote render precedence (§4.3) — extend the existing `render.ts` twin tests to
  cover a remote item with `contentMarkdown`, confirming the sanitizer still runs.

Gates: `core` suite + `tsc` (native type-stripping means vitest passes on type
errors — `tsc` is not optional), plus the web suite and `svelte-check` since
§4.3 changes remote rendering. Web tests run in-container.

---

## 6. Verification after deploy

Re-run the validator against `rsc.rmdes.be`:

```bash
curl -sS -N "https://valid.rss.chat/validatestreaming?url=$(python3 -c \
  "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" \
  "https://rsc.rmdes.be/users/rss.xml")"
```

Expected after deploy: the `replyDoesntPointBack` **error gone**, and
`guidNotPermalink` / `selfMissing` / `itemsOutOfOrder` gone.
`sourceNamespaceUnexpected` **deliberately remains** (§3).
`urlAnsweredWithAnError` remains (not ours).
`markupWithoutMarkdown` clears **immediately for v1-converted items** (§4.3's
one-line projection fix) and **asynchronously** for post-cutover items as each
feed polls — so its presence on newer items right after deploy is expected, not
a regression.

Also spot-check that remote post bodies still render correctly in the web UI
(§4.3 is a deliberate render change) before promoting past the first canary.

**Fleet:** four RSC instances verified on `my.infinitespace.click` via
`cloudron list` — `rsc.rmdes.be`, `alice.rmdes.be`, `bob.rmdes.be`,
`rsc.rmendes.net` — plus `skyfleet.blue` on `my.openbuddhism.org`, which this
session could not reach. Confirm the full list and canary order before deploying.

---

## 7. Rejected alternatives

- **A second `markdown` key in `normalized_json`** — `contentMarkdown` is already
  there for converted items (`convert.ts:553-559`). Two keys, one meaning.
- **Markdown in the fingerprint** — re-versions every remote item on the next
  poll of every feed. The 2026-07-25 incident's exact mechanism.
- **A heal for the whole corpus** — unnecessary: converted items are backfilled by
  the §4.3 projection line alone. The heal is scoped to post-cutover items.
- **One-shot backfill migration force-repolling every remote source** — faster
  convergence for post-cutover items, but a fleet-wide fetch storm at startup.
- **Widening `findCurrentDeliveryVersion` to SELECT `normalized_json`** — touches a
  helper shared by three call sites under a "never drift apart" contract, to
  enable a JS-side parse the SQL guard makes unnecessary (§4.3).
- **An `isHttpUrl` helper for the guid test** — URL-shape inference upgrades guids
  the origin declared non-permalinks (§4.2). `guid === url` is correct *and*
  needs no helper.
- **Verbatim reply ref in all cases** — does not guarantee the string compare the
  ERROR is about (§4.1).
- **Switching the source namespace to `https://`** — see §3.
- **Automated live-validator check in CI** — an external network dependency that
  fails for reasons unrelated to our code. Fixture tests hold the contract
  offline; the validator stays a manual post-deploy check (§6).
