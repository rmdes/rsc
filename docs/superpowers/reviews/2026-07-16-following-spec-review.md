# Spec review — following/filtering (ponytail + adversarial), pre-implementation

Date: 2026-07-16
Target: `docs/superpowers/specs/2026-07-16-textcaster-following-design.md` (d8f9f83)
Verified against the real code (core/src/) and the installed feedsmith OPML API.

**Verdict: not ready as-is — but every fix is a sentence. H1 would ship a
broken flagship feature (foldered OPML imports nothing), verified against the
installed parser. H2/H3 are the import path's two composition bugs. H4/H5 are
one-line decisions. The ponytail pass found nothing to cut — the model is the
minimal correct shape and its cursor/index/feedsmith/migration foundations
all check out.**

## Ponytail: nothing to cut

`WITHOUT ROWID` (real win for a 2-TEXT PK, not cargo-cult), the three repo
methods (distinct verbs), the `getTimeline` filter object (matches the
`findPushSubscription` precedent), self-follow-as-data (verified genuinely
zero-code — pin one contract test), and client-side lens filtering all
survive. The model is minimal; everything below is a correctness pin, not
added machinery.

## Holes

### H1 — HIGH: OPML import reads only top-level outlines; foldered exports import zero feeds

Probed feedsmith: `parseOpml` returns NESTED `outlines` arrays for folder
groups, and folders are the norm in real reader exports (Feedly,
NetNewsWire). The spec's "for each outline carrying an `xmlUrl`" must
**walk the outline tree recursively** or the flagship import case is a
silent no-op. One sentence.

### H2 — MEDIUM: case-2 self-feed detection misses `feed.json`, recreating the bug it prevents

M1 mints both `…/feed.xml` and `…/feed.json` (`feed.ts` `feedUrls()`) and
both are live routes. Case 2 matches only `feed.xml`; an OPML carrying our
own `feed.json` URL falls to case 3 and creates a remote shadow of a local
user. Pin: compare against BOTH minted URLs (`feedUrls()` returns the pair).
Keep M1's exact-equality (no trailing-slash/case normalization — degradation
to case 3 for hand-mangled URLs is acceptable and consistent).

### H3 — MEDIUM (two-part): the collision loop emits invalid handles and is unbounded

(1) Slugify truncates to 64, but `HANDLE_RE` is `{1,64}` — suffixing `-2`
onto a 64-char slug makes 66 chars, so `addRemoteUser` throws
`DomainError('invalid handle')`, NOT `HandleTakenError`; the outline is
miscounted "skipped" instead of retried. Truncate to 64 minus suffix room.
(2) "retry through HandleTakenError" is unbounded and O(n²) for same-slug
batches; two same-slug outlines in one file dedup by xmlUrl only, so they
collide on handle. Pin: an in-batch `Set` of assigned handles (kills the
common case with zero DB round-trips) plus an attempt cap (~50), after which
the outline counts skipped.

### H4 — DECISION: relative `xmlUrl` export is junk, not a degradation

Without `PUBLIC_URL`, exported local-user outlines carry relative URLs —
useless to every external aggregator; on re-import they fail the http(s)
scheme check and skip (verified: no broken-shadow creation, good). But
shipping known-junk URLs is noise. Recommend: omit local-user outlines when
`PUBLIC_URL` is unset. One line either way — decide.

### H5 — DECISION: no outline cap per import

1 MB OPML ≈ 5–10k outlines → that many user creations, each a per-tick
polled feed. Consistent with the caps-not-ratelimits philosophy (M1's
20/host, 500/topic): one constant (~1000 outlines, rest skipped) stops an
operator self-inflicting a poller DoS. One constant, one test.

### H6 — half-sentence: unfollow staleness is real but unstated

The island's follow-set comes from `load`; EventSource reconnects don't
re-run `load`, so an unfollowed author's posts keep appearing live until
refresh — the mirror of the stated follow-staleness. Add the sentence so
nobody "fixes" it with a refetch loop.

## Ambiguities to pin

- `GET /timeline` check order: both-params → 400 before handle-resolution
  404 (cheap check first, deterministic tests).
- `POST …/follows` returns 200 deliberately (idempotent), not 201 — say so.
- Import content-type: accept anything, read `c.req.text()`; don't gate on
  `text/xml`.
- Author lens works for remote authors (repo filter is kind-agnostic) —
  intended; one test pins it.
- Migration 4 is being written anyway: decide whether it ships
  `posts_author_pub_idx (author_id, published_at, id)`. Filtered lenses are
  correct without it but scan the whole published_at index; one line now vs
  a migration later — the debt-batch cheap-now argument.

## Verified sound (don't re-check)

- Cursor + filter compose correctly: the keyset `refTuple < tuple`
  predicate and the new `author_id` conjuncts share the same ORDER BY — no
  tie mis-paging, no cursor-semantics change; fine at spine scale without a
  new index (filtered scan of `posts_published_idx`).
- feedsmith OPML API real: `parseOpml` → `body.outlines[{text, title, type,
  xmlUrl, htmlUrl, outlines?}]`; `generateOpml({head, body:{outlines}})`
  emits the export shape the spec assumes.
- Migration runner applies 3→4 generically; service-layer kind enforcement
  has the `ensureLocalUser` precedent; idempotent `addFollow` via ON
  CONFLICT DO NOTHING has the posts-table precedent; 1 MB `bodyLimit` is the
  same hono middleware already on four routes; import inherits the http(s)
  scheme check so garbage xmlUrls skip rather than create broken users.
- SSE replay staying firehose is correct with client-side filtering.

## What must change before planning

Fold in H1 (recursive outline walk), H2 (both minted URLs), H3 (suffix-room
truncation + in-batch Set + attempt cap). Decide H4 (omit vs relative) and
H5 (outline cap). Add the H6 sentence and the five ambiguity pins. Then plan.
