# rss.chat interop compliance — design

**Status:** rev 1 — design approved 2026-08-07, not yet planned.
**Spec of record for:** the six findings reported by `valid.rss.chat` v0.4.0
against our live feeds on 2026-08-06.

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
- `core/src/logical/projector.ts:594` — `contentMarkdown: null`, hardcoded. The
  deeper cause: `RawItem` (`core/src/logical/acquisition.ts:114`) has **no
  markdown field at all**, so v2 acquisition never captures `source:markdown`
  from a remote feed. (The retired v1 ingest did — `core/src/domain/ingest.ts:114`.)
- `core/src/domain/feed.ts:257` — the remote branch stamps `isPermaLink="false"`
  unconditionally, including on absolute-URL guids that *are* permalinks. Alice
  emits that same post with a bare guid; we downgrade it on relay.

---

## 3. Scope

**In scope**

| # | Finding | Severity | Section |
|---|---|---|---|
| 1 | `replyDoesntPointBack` | **error** | §4.1 |
| 2 | `guidNotPermalink` | warning | §4.2 |
| 3 | `markupWithoutMarkdown` | warning | §4.3 |
| 4 | `selfMissing` | warning | §4.4 |
| 5 | `itemsOutOfOrder` | warning | §4.4 |

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
  `uris[0]`) and is not configurable from our side; feedsmith's parser accepts
  all four scheme/trailing-slash variants, and Dave's validator makes this a
  *warning*, not an error, which suggests the same reading. Our emission is
  self-consistent (feedsmith and the `feed.ts:221` injector both use `http://`),
  and consistency is the property that actually matters.
  *If this is ever revisited, the correct venue is upstream — feedsmith and/or
  Dave — not post-processing our own XML.*
- **`urlAnsweredWithAnError` — not ours.** A user replied to a reddit URL that
  answers 403 to the validator's fetch. Nothing in our code produces or can fix
  this.

---

## 4. Design

### 4.1 Remote replies keep their reply ref  *(closes the ERROR)*

`projector.ts:601` becomes `inReplyToRef: safeUrl(mat.material.inReplyTo)` —
the same expression already used at `:579`. `itemContentFields`
(`feed.ts:111`) then emits `source:inReplyTo` **and** `thr:in-reply-to` through
the existing path; `feed.ts` needs no change.

The ref is emitted **verbatim as the origin stated it**, including when the
parent is unresolved locally (`parentResolutionState` of `missing`/`ambiguous`).
That is the honest record of what the origin claimed, and it is what makes the
thread walkable downstream.

**Blast radius.** The firehose (`renderFirehoseRss`) and user feeds
(`renderRssFeed`) are local-only. Remote items reach an outbound feed **only**
via `renderCommentsFeed`. So this change is confined to comments feeds.

**No federation loop.** We re-emit a remote item under its origin wire guid
(`logicalToFeedEntry`, `feed.ts:33`), so a peer re-ingesting its own item
dedupes on the guid it minted.

### 4.2 Stop declaring true permalinks non-permalinks

`feed.ts:257`'s remote branch becomes conditional:

```ts
guid: p.source === 'local'
  ? localGuid(p)
  : { value: p.guid, ...(isHttpUrl(p.guid) ? {} : { isPermaLink: false }) }
```

The URL test already exists twice (`localGuid` implicitly, `replyWireElements`
at `feed.ts:101`). Extract **one** `isHttpUrl` helper and use it in both places
rather than adding a third copy.

The remote guid **value** stays `p.guid` verbatim — never swapped to `p.url` —
preserving the existing invariant at `feed.ts:253-257`. And the URL branch
**omits** `isPermaLink` entirely rather than emitting `isPermaLink="true"`,
matching the pin at `feed.ts:60-61` (a `true` attribute breaks Dave's walker).

**Injector interaction — must be pinned by a test.** `injectItemElements`
(`feed.ts:207`) keys on the marker `` >${guid}</guid> ``. Removing the attribute
changes `<guid isPermaLink="false">v</guid>` to `<guid>v</guid>`, which still
matches that marker — so `source:comments` injection keeps working. This is a
non-obvious coupling; a test must hold it.

### 4.3 Capture remote `source:markdown`, heal on next poll

**Capture**

- `RawItem` (`acquisition.ts:114`) gains `markdown?: string | null`.
- The **RSS adapter branch only** (`acquisition.ts:242-254`) sets
  `markdown: str(it.sourceNs?.markdown ?? null)`, mirroring the adjacent
  `inReplyTo: it.sourceNs?.inReplyTo?.value ?? …` at `:248`. Atom, JSON Feed,
  RDF and h-feed have no `source:markdown` equivalent and are left alone.
- It rides `normalized` (`acquisition.ts:329`) — the same blob that already
  carries `replyContextAuthor`/`replyContextSnippet` for exactly this reason.
- `materialOf`'s `normalized` type (`projector.ts:480`) gains `markdown`.
- `projector.ts:594` becomes `contentMarkdown: mat.normalized.markdown ?? null`.

**It must NOT enter the fingerprint.** `canonicalMaterialFor`
(`acquisition.ts:262`) is untouched. Adding a field there re-fingerprints every
remote item on the next poll of every feed — the 2026-07-25 runaway
(763k `observation_versions`, 2.6GB on `rsc.rmendes.net`). **A test asserting
the fingerprint is byte-identical with and without markdown present is the
guardrail, and is not optional.**

**Heal (strategy B)**

Markdown cannot be backfilled from stored data — it was never captured. And the
unchanged path never rewrites `normalized_json`:

```
acquisition.ts:673-677  fingerprint match + identical material → bumpVersion only
acquisition.ts:686      overwriteObservationVersion → rewrites normalized_json,
                        but only when the fingerprint changed (a real edit)
```

Without a heal, the existing corpus would keep emitting markup-without-markdown
essentially forever. So: in the **unchanged** branch, when the stored
`normalized_json` carries no markdown and the incoming candidate does, UPDATE
`normalized_json` alone.

- No new version row, no `resetObservationJob`, no journal effect — markdown is
  not rendered in the UI (remote `description` is), so no presentation change
  needs to propagate. This keeps the heal off the churn path entirely.
- `findCurrentDeliveryVersion` must add `normalized_json` to its SELECT so the
  comparison is possible.
- Idempotent: once the key is present, the condition is false forever after.
- Convergence is per-feed on natural poll cadence — asynchronous, not at deploy.

### 4.4 Comments feed self-pointer and ordering

- `renderCommentsFeed` gains **both** `atom:link rel="self"` (the standard) and
  `source:self` (what the validator checks). It currently emits neither, so
  unlike the user feed this is a real gap, not only a lint.
- `renderRssFeed` gains `source:self` (it already emits `atom:link rel="self"`
  at `feed.ts:126`). `renderFirehoseRss` already has both (`feed.ts:170,184`).
- **There is no shared comments-URL helper today** — the URL is an inline
  template literal at `read.ts:136` (`` `${pub}/post/${d.id}/comments.xml` ``),
  and `renderCommentsFeed` cannot reach it. Extract
  `commentsFeedUrl(publicUrl, id)` into `feed.ts` beside `feedUrls`/`firehoseUrl`
  and use it in **both** places, so a feed's advertised `source:comments feedUrl`
  and that feed's own self-pointer can never disagree.
- Both self elements are emitted **only when `ctx.publicUrl` is set**, matching
  how `renderRssFeed`/`renderFirehoseRss` already gate their `atom:link`/`cloud`
  (`feed.ts:125`, `:169`) and how `injectComments` early-returns at `read.ts:133`.
  Without a configured public URL there is no honest absolute URL to emit.
- Ordering: `core/src/api/logical-routes/read.ts:187` sorts replies
  **newest-first** once; the same sorted array feeds `renderCommentsFeed` and
  `injectComments` (`read.ts:193-194`). Feed bytes only — the web UI's
  chronological conversation order is unaffected.

---

## 5. Testing

Fixture-based **wire-contract** tests in `core/test/`, asserting on emitted XML
rather than intermediate objects — the contract broke at serialization, so that
is where it must be held. Per house flow each fix starts from a failing test.

Minimum assertions:

1. A relayed remote reply in a comments feed carries `source:inReplyTo` and
   `thr:in-reply-to` pointing at the parent's guid.
2. A remote item whose guid is an absolute URL emits **no** `isPermaLink`
   attribute; a non-URL guid still emits `isPermaLink="false"`.
3. `source:comments` injection still lands on an item whose guid lost the
   attribute (§4.2).
4. `canonicalMaterialFor` is byte-identical with and without `markdown` (§4.3).
5. An unchanged re-poll carrying markdown heals `normalized_json` **without**
   creating a version row or re-pending a job; a second pass is a no-op.
6. Comments feed items are newest-first.
7. Local-item emission is byte-identical to today (no regression on the path
   that already validates).
8. With `ctx.publicUrl` unset, no self elements are emitted and rendering still
   succeeds (§4.4).

Gates: `core` suite + `tsc` (native type-stripping means vitest passes on type
errors — `tsc` is not optional), and the web suite if any web file is touched.

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
`markupWithoutMarkdown` clears **asynchronously** as each feed polls (§4.3) —
its presence immediately after deploy is expected, not a regression.

Deploy is the fleet's five live Cloudron instances; see the deployment-topology
notes for canary order.

---

## 7. Rejected alternatives

- **Markdown in the fingerprint** — re-versions every remote item on the next
  poll of every feed. This is the 2026-07-25 incident's exact mechanism.
- **Forward-healing only (no §4.3 heal)** — smallest diff, but the existing
  corpus never gains markdown unless an origin genuinely edits a post, so the
  warning persists indefinitely across a mostly-static backlog.
- **One-shot backfill migration force-repolling every remote source** — faster
  convergence, but a fleet-wide fetch storm across five instances at startup.
- **Switching the source namespace to `https://`** — see §3.
- **Automated live-validator check in CI** — an external network dependency that
  fails for reasons unrelated to our code. Fixture tests hold the contract
  offline; the validator stays a manual post-deploy check (§6).
