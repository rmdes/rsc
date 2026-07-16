# Plan review — reply threading (pre-execution)

Date: 2026-07-16
Target: `docs/superpowers/plans/2026-07-16-textcaster-threading.md` (eb27b6f)
Grounded: every claim from a file read or a live probe (feedsmith 2.9.6,
mf2tojf2 3.0.0, better-sqlite3, node 24).

**Verdict: executable, NOT green as-is — 1 blocker (F1) + 1 real gap (F4),
plus 3 low findings. The load-bearing parts are sound: the adoption engine is
correct across all worst-case arrival orders, all three wire paths are
probe-verified, resolve-once + optional-field normalization hold, and the
money test genuinely proves the Winer-native ending.**

## Must fix before running

### F1 — HIGH (blocker): Task 2's GREEN assertion fails on same-ms ordering

Task 2 Step 2's "corrected" assertion `expect(ids[0]).toBe('root')` — but in
that test `root`/`r1`/`rr` all use `mkPost`'s default `publishedAt`
(`2026-01-01T00:00:00.000Z`), and `getThread` orders `(published_at ASC, id
ASC)`. With equal times it falls to `id ASC` → `['r1','root','rr']`, so
`ids[0] === 'r1'`, not `'root'`. Task 2 cannot reach GREEN as written. **Fix:**
give `root` an earlier `publishedAt`, or drop the `ids[0]` root-first
assertion and keep the length + `Set`-membership checks (Task 1's getThread
test already uses distinct days precisely to avoid this). Same class as the
following milestone's same-ms flake.

## Should fix (won't block the suite; bites in production/edge)

### F4 — MEDIUM: the source:comments injector silently skips guids with `& < > "`

Probed feedsmith's real output: it **CDATA-wraps** any guid value containing
`& < >` (`<guid …><![CDATA[a&b]]></guid>`) and entity-escapes `"`. The
injector's marker `>${xmlEscape(guid)}</guid>` matches neither, so
`indexOf(marker) === -1 → continue`: it **cannot corrupt XML** (the stated
safety property holds — it's `indexOf`, not regex), but it **silently omits**
`source:comments`. Blast radius is bounded: the main `feed.xml` renders only
local posts (`getPostsByAuthor` on a local user; remote users 302-redirect)
whose guids are `randomUUID` — always safe, so the money test and normal ops
are fine. The gap bites only the **nested** `source:comments` on a
comments-feed item that is a *remote* reply with a URL-style guid
(`?a=1&b=2` — common). **Fix:** make the marker CDATA-aware (match both
`>${guid}</guid>` and `<![CDATA[${guid}]]>`), or add a `ponytail:` ceiling +
a test that documents the omission. Cheap to close; recommend the CDATA-aware
marker.

## Low (document or tidy)

- **F5 — LOW/MED:** `adoptOrphans` uses a cross-arm union holder check
  (url ∪ guid) while `findPostByRef` checks only the *winning* arm. For a ref
  `X` where `url=X` is unique to P but another post has `guid=X`, forward
  ingest attaches to P while backward adoption refuses — same ref, opposite
  outcome. Never mis-threads (adoption errs to honest-orphan, the safe
  direction), but it contradicts the plan's own "both arms same guard" claim.
  Reconcile the two, or document the asymmetry as deliberate.
- **F3 — LOW:** api-threading test 1 asserts `[root.id, re.id]` order on two
  local posts created by sequential in-process POSTs (`publishedAt = new
  Date().toISOString()`); sub-ms inserts can share a ms → ~50% flake on
  `id ASC` over UUIDs. Give the reply a later time or assert order-independently.
- **F2 — LOW:** the raw code block at ~L250 is nonsense (`[...].sort() ===
  [...]` array-identity, always false); the prose fixes it right after — just
  delete the dead block.

## Verified sound (probe/trace-backed — don't re-check)

- **Adoption engine:** traced against its invariant (a non-null
  `thread_root_id` is only set alongside `in_reply_to_post_id`, so every
  descendant of an orphan O points at O.id → one `WHERE thread_root_id = O.id`
  sweep catches the whole subtree). Correct under deep-chain-leaf-first,
  two-subtree-merge, and reply-before-parent-and-grandparent. Ambiguous refs
  refused on both arms → no mis-thread; Hole B residual only; **no
  re-orphaning code anywhere** (confirmed).
- **Wire paths:** feedsmith generate `source:inReplyTo{value,isPermaLink}`
  (bare guid → `isPermaLink="false"`), `thr:in-reply-to ref/href`, and DROPS
  `sourceNs.comments` (injector justified); parse RSS `sourceNs.inReplyTo` +
  `thr.inReplyTos`; **Atom exposes `thr` only, `sourceNs` undefined even when
  `source:inReplyTo` is in the XML** — the plan's `sourceNs ?? thr` fallback
  is correct; mf2tojf2 `in-reply-to` string-for-one / array-for-many, take-first
  handled.
- **Optional Post fields:** no `undefined` leak — `insertPost` writes `?? null`,
  `rowToPost` returns concrete nulls, every classify path goes through the DB
  or freshly-assigned fields, the web marker treats `undefined`/`null` alike.
- **Money test:** local UUID-guid ref round-trips B→A, A resolves bob's reply
  to orig, alice's feed advertises `count="1"` (UUID guid → injector-safe),
  `comments.xml` serves the reply. Winer-native ending proven; mf2 sibling
  resolves via `op.url`.
- Migration 5 append-only, index names don't collide; REDs genuine for
  T1/T3/T4/T5.
- **Spec staleness (not a plan defect):** spec §Sequencing still lists
  `_textcaster` in the emit step, contradicting §JSON Feed's cut — the plan
  correctly omits it. Worth a one-line spec tidy.

## What must change before execution
Fix F1 (blocker). Close or document-with-test F4 (recommend CDATA-aware
marker). F2/F3/F5 are one-line tidies/decisions. The adoption engine, wire
paths, and money test need no change.
