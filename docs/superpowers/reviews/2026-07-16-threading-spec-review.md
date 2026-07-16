# Spec review — reply threading & conversations (ponytail + adversarial)

## Re-review of rev 3 (d5a664f): all 5 prior items landed; resolve-once is right — but its "can never mis-thread" claim has 2 narrow residuals

All five carryover items are genuinely in: H2 fixed STRUCTURALLY via
`in_reply_to_post_id` (resolve once at insert/adoption, key everything on the
id — comments feed, count, thread — no render-time re-matching); `_textcaster`
emission CUT with three re-add signals; `getPost` dropped (names `sqlite.ts:152`);
adoption wording now "one adopt UPDATE + one re-root UPDATE per adopted orphan —
a loop"; the dead isPermaLink-fallback testing line removed; mf2 `in-reply-to`
string-vs-array pinned. The resolve-once approach is the right call — it kills
the common (render-time) mis-match class entirely. Two residual holes remain in
the *strong* claim "a guid collision can at worst leave an honest orphan — it
can never mis-thread, mis-count, or leak":

### Hole A — the `url` arm has NO ambiguity check (asymmetric with guid; needs a decision)

Rule (1) is "a post with `url = R` wins" — no exactly-one guard, unlike the
guid arm (rule 2). But two posts CAN share a `url`: two followed feeds
syndicating the same article/link (planet feeds, aggregators, cross-posts) each
ingest a row with `url = R`. A reply with `in_reply_to = R` then resolves to
whichever row the query returns first → a mis-thread, the exact failure the guid
arm was hardened against. "Permalinks are the trusted identifier" doesn't hold
when two DB rows (different authors) claim the same permalink. **Fix (one-line,
consistent with the design's own principle):** apply the same exactly-one guard
to the url arm — a duplicated url resolves to NOTHING (honest orphan), not to an
arbitrary row. Cheap, symmetric, and better an orphan than a mis-thread.

### Hole B — temporal guid collision: first-arriver captures orphans before ambiguity appears (soften the claim, or document)

The guid arm's existence check ("adopt via `guid` only when no OTHER post carries
it") is evaluated at adoption time, so it can't see a FUTURE collision:
1. Orphan O arrives referencing guid `g` (a guid-only ref — target had no url).
2. Post P1 (guid `g`) arrives → at this instant P1 is the only holder → check
   passes → O is adopted to P1 (`in_reply_to_post_id = P1.id`).
3. Post P2 (guid `g`, possibly O's REAL parent) arrives → guid now ambiguous →
   P2's check fails → P2 does NOT adopt. O stays wrongly attached to P1.

So an orphan CAN mis-thread when it arrives before a guid that later proves
ambiguous — the "can never mis-thread" claim is too strong. Narrow (guid-only
refs — local posts use UUIDs, so it's remote guid-only items — and the
orphan-before-both-parents ordering), but real. **Options:** (a) soften the claim
to document this residual (ponytail — don't build for a narrow case), or (b) fully
close it by re-orphaning on collision detection (when a second post with guid `g`
inserts, null the `in_reply_to_post_id`/`thread_root_id` of anything resolved via
that guid) — more machinery. Recommend (a): document, since Hole A's url fix +
this note make the guarantee honest without new code.

**Rev-3 verdict:** the design is sound and all prior fixes landed. Before
planning: apply the exactly-one guard to the url arm (Hole A — one line), and
either soften the "never mis-thread" claim to name the temporal guid residual or
close it with re-orphaning (Hole B — recommend document). Neither touches the
resolve-once architecture or the federation path, both still verified sound.

---


## Re-review of rev 2 (ece6b00): source:comments SOUND, but 4 prior items still open (1 is the correctness fix)

`source:comments` shipping this milestone is well-designed and correctly
modeled on rss.chat. Probe-confirmed: feedsmith 2.9.6 serializes only RSS's
plain `<comments>URL</comments>`, NOT the attributed
`<source:comments count feedUrl/>` sourceNs element — so the post-generation
injector is genuinely required, and feedsmith's deterministic
`<item>…<guid …>value</guid>…</item>` structure makes guid-keyed injection
viable. On-request rendering (no S3 republish, always-current counts) is a
real win over Dave's implementation. **Keep it.** Plan-time: pin the injector
to match the `<guid>` ELEMENT for the value (not the value appearing anywhere)
and inject before that item's following `</item>`; unit-test against
feedsmith's exact item serialization.

**But four of the five rev-1 edits were NOT applied, and one is the sole
correctness gap:**

### H2 — STILL OPEN, and source:comments now AMPLIFIES it (must fix)

`findPostByRef` still matches `url OR guid` globally (§Repository), and
`posts.guid` is unique only per `(author_id, guid)`. Real feed guids collide.
In rev 1 this mis-threaded a reply; in rev 2 the SAME ref-matching now also
drives `countRepliesByRef` (the `count="n"` attribute) and the comments feed's
"direct replies" query — so a guid collision corrupts the thread AND the
advertised reply count AND the served comments feed. This makes H2 more
load-bearing, not less. Pin the multi-match resolution (prefer a `url` match;
or scope guid matches; or documented best-effort first-match) and own the
feed-guid-collision case. Local UUID guids dodge it in the money test; real
federation does not.

### Three carried-over cleanups (not applied)

- **`getPost` still listed** in the repo additions (§Repository, Testing) — it
  already exists (`sqlite.ts:152`). Drop it; 3 new methods (now +
  `countRepliesByRef` = 4 genuinely-new), not 5.
- **"two-UPDATE" wording still wrong** (§Data model: "Both are indexed single
  UPDATEs", §Repository: "the two UPDATEs above"). Adoption step 2 is a LOOP —
  one re-root UPDATE per directly-adopted orphan. Reword so the implementer
  codes the loop (the mechanism is correct; only the wording misleads).
- **Dead testing wording:** §Testing still says "no `source:inReplyTo` for bare
  guids unless attrs probe passes" — the probe RESOLVED positive (§Wire now
  says the `isPermaLink` attr IS supported, "no fallback tier"), so this line
  contradicts the spec. Remove it.

### _textcaster emission — kept (operator's call, re-flagged)

Rev 2 kept the JSON Feed `_textcaster` emission. It remains **write-only**:
probed, `parseJsonFeed` drops unknown item keys, so nothing (not even us) reads
it back. Not a correctness issue and the operator may want emission ahead of a
future reader — but it's speculative interop (RSS is the federation path).
Ponytail still says defer; flagging, not blocking.

**Rev-2 verdict:** `source:comments` is ready. Before planning, pin H2 (the
correctness gap, now amplified), drop `getPost`, fix the two-UPDATE wording,
remove the dead isPermaLink-fallback testing line. Optionally cut the
write-only `_textcaster` emission. The adoption engine and federation path
remain verified sound.

---


Date: 2026-07-16
Target: `docs/superpowers/specs/2026-07-16-textcaster-threading-design.md` (c102b8d)
Verified against the real code and the installed feedsmith 2.9.6 / mf2tojf2 /
microformats-parser (all wire claims probed live).

**Verdict: ready to plan after five edits — only ONE is a correctness fix
(H2). The load-bearing adoption engine is sound in every arrival order, and
the money-test federation path is verified end to end.**

## The good news (verified sound — don't re-check)

- **Adoption invariant holds across ALL arrival orders.** Stress-tested
  A←B←C←D leaf-first, middle-first, interleaved, two-subtree-merge, and
  reply-before-parent-and-grandparent. `thread_root_id` always points at the
  TOP root (resolution sets `tr = target.tr ?? target.id`, so descendants
  never point at an intermediate node) — so re-rooting an adopted orphan is
  one indexed `WHERE thread_root_id = O.id` sweep of its whole subtree. No
  recursion, no third level ever needed.
- **`getThread` flattens multi-level threads correctly** (reply-to-a-reply):
  a flat `id=root OR thread_root_id=root` catches every depth because tr is
  always the true root.
- **Cross-instance money-test ref path works** (H4): A composes (url=null,
  guid=g1) → B ingests (guid=g1) → B replies (in_reply_to = url ?? guid =
  g1) → A ingests → `findPostByRef(g1)` hits A's original. The url-vs-guid
  asymmetry doesn't break it because a local post's null url falls through to
  the guid, which survives the round-trip verbatim.
- Null-url adoption `IN (NULL, guid)` correctly never false-matches (SQL
  semantics). Migration append-only + two indexes match the pattern.

## The one correctness fix

### H2 — `findPostByRef` mis-resolves on guid collisions (needs a decision)

`posts.guid` is unique only per `(author_id, guid)` (`sqlite.ts:238`), but
`findPostByRef` matches `url OR guid` **globally**. Two feeds shipping an
item with the same `guid` (or a remote guid equal to another post's url) both
exist as rows; `in_reply_to="<that guid>"` resolves to whichever
`executeTakeFirst` returns → wrong thread. The money test dodges this (local
guids are `randomUUID`), but real feed guids collide constantly. **Pin the
multi-match resolution** (prefer a `url` match over a `guid` match? restrict
guid matches? accept documented best-effort first-match?), and acknowledge
cross-author guid non-uniqueness. This is the only silent-mis-thread risk.

## Four cheap edits (ponytail + probe-driven, not correctness)

- **Remove the `isPermaLink`-unsupported fallback — it's dead code.** The
  spec's key open question resolves POSITIVE: feedsmith's `sourceNs`
  generation DOES support the attribute — probed, it emits
  `<source:inReplyTo isPermaLink="false">bareguid</source:inReplyTo>`. So
  `source:inReplyTo` always works for bare-guid refs; drop the "guid refs get
  thr: only" branch and always emit both. Simplifies the RSS emit.
- **Cut/defer the JSON Feed `_textcaster` EMISSION.** Probe: `generateJsonFeed`
  passes it through, but `parseJsonFeed` DROPS it (unknown item keys not
  retained) — so it's write-only, a proprietary key no consumer (not even us)
  reads back. RSS is the federation path; defer until a reader exists or JSON
  Feed standardizes a reply field. Trims the JSON half of task 3.
- **Drop `getPost` from the repo additions** — it already exists
  (`sqlite.ts:152`) from the replay milestone; the spec even hedges "if not
  already present." 3 new methods, not 4.
- **Fix the "two-UPDATE" wording** — adoption is **1 UPDATE (adopt direct
  children) + one re-root UPDATE per directly-adopted orphan** (a loop when
  several orphans point at P), not a single fixed second UPDATE. Write it so
  an implementer codes the loop.
- **Pin the mf2 `in-reply-to` shape** — probe: a single `u-in-reply-to` comes
  back as a **string**, multiple as an **array**. "Take the first URL" must
  handle both `string` and `string[]`.

## Probe findings (installed 2.9.6 / mf2tojf2)

- RSS parse: `item.sourceNs.inReplyTo.value` ✓, `item.thr.inReplyTos[].ref/.href` ✓.
- RSS generate: `source:inReplyTo` WITH `isPermaLink="false"` ✓, `thr:in-reply-to ref/href` ✓.
- mf2tojf2: surfaces `in-reply-to` (string for single) ✓.
- JSON Feed: `generateJsonFeed` emits `_textcaster` ✓, `parseJsonFeed` DROPS it ✗ (ingestion impossible).

## Ambiguities to pin
- H2 multi-match resolution order for `findPostByRef`.
- Whether `_textcaster` JSON emission survives (recommend cut).
- mf2 `in-reply-to` string-vs-array (pin both).
- `POST /posts` inReplyTo 404-on-unknown-target ordering (match the existing
  handle-resolution: cheap check placement).

## What must change before planning
Pin H2 (the one correctness gap); remove the dead `isPermaLink` fallback;
cut/defer the write-only `_textcaster` emission; drop `getPost`; fix the
two-UPDATE wording + mf2 string/array shape. The adoption engine and the
federation path need no change.
