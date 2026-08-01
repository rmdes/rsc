# Ingest-Aware Retention — Design

**Status:** Rev 2 (brainstormed 2026-08-01; clean-context review folded —
`docs/superpowers/reviews/2026-08-01-ingest-aware-retention-review.md`).

**Goal:** Stop the retention delete↔re-ingest churn loop, and repair the
`timeline_sort_at` regression that amplifies it. Items outside a source's
retention window are **never ingested** instead of ingested-then-deleted-then-
re-ingested every poll.

## Background — the bug (root-caused live 2026-08-01)

`trimSourceToCap` runs after **every** poll (`runtime.ts:412-433`) and deletes
the deliveries + observation-versions of items beyond `maxCount` or older than
`maxAgeDays` (`tombstones.ts:244-250`). But the feed **still serves those
items**, so the next poll's `commitAcquisition` finds no delivery
(`findDelivery` miss, `acquisition.ts:632`) → creates a **new** delivery +
version + reconciliation job → the old item resurfaces as "new" and fires a
journal `upsert` to every firehose client → the trim deletes it again → forever.

**Confirmed on the live fleet (read-only):** rsc.rmdes.be (caps 200 / 120 days)
spawned **1342 new deliveries/hour, all brand-new delivery rows**, re-ingesting
**2020–2021** back-catalog every poll. rsc.rmendes.net has the same caps but is
healthy — its feeds are under-cap, so retention never fires.

### The compounding regression (review C1 — verified in code)

Reconciliation derives an item's `timeline_sort_at` from
`material.published` (`reconcile.ts:378`), where `material` is parsed from
`canonical_material` (`reconcile.ts:260`). But the fingerprint fix `00bc235`
(2026-07-31) **removed `published` from `canonicalMaterialFor`** — so
`material.published` is now `undefined` and **`timeline_sort_at = arrival` for
every remote item.** Consequences:
- Remote items sort by *when this instance first saw them*, not their publish
  date. For fresh items arrival ≈ publish (invisible); for **back-catalog /
  re-ingested items it's the amplifier** — a 2021 episode re-created by the loop
  gets `timeline_sort_at = now` and rockets to the top as "just now" (a large
  part of the "hundreds of thousands in the last X minutes" symptom).
- The age trim keys off `timeline_sort_at`, so it currently trims by *arrival*
  age, not content age.

See [[remote-content-retention-milestone]], [[obs-versions-runaway-purge]].

## The fix

### Phase 1 — ship now (no schema): regression fix + age gate

**Task A — repair `timeline_sort_at` (review C1, prerequisite).**
`createRemoteItem` (`reconcile.ts:375-381`) must read the published date from
`raw_evidence_json` (already parsed as `raw` at `reconcile.ts:264`, and it
carries `published: it.rawDate` from `acquisition.ts:324`) instead of from
`material`. Restores content-date sorting for remote items AND makes the age
trim key off real content age again. After this, the item's published date is
the single, consistent "content date" that the timeline, the trim, and the gate
all use.

**Task B — the age ingest gate, in `commitAcquisition` (new-delivery branch).**
In the observation loop (`acquisition.ts:627`), **only when about to create a
new delivery** (`existing === undefined`, line 633) — an already-tracked
delivery getting a new version (a genuine edit) is never gated out — compute the
item's content date and skip if:

```
maxAgeDays > 0 && contentDate < (now − maxAgeDays)   →  skip
```

where `contentDate = (pub && pub <= arrival) ? pub : arrival` (the SAME formula
Task A restores in reconcile; `pub` = the item's `rawDate`, `arrival` =
`committedAt`). "Skip" = create **no** delivery, version, or job; increment a new
`retentionFiltered` field on `AdminAcquisitionCounters` so the filtering is
observable, not a silent black hole.

This alone breaks the current live loop: the flooding items are old-published
back-catalog, so even when the *count* cap is what deleted them, the age gate
refuses to re-create them — they can never bounce back.

**Task C — second insert path (review Important).** `verification.ts:352` is a
second delivery-insert path outside `commitAcquisition`. Confirm whether it can
ingest an out-of-window item; if so, the gate must cover it too (extract the
window check into a shared helper both call).

**Keep `trimSourceToCap`** for stored items that cross the age threshold over
time; it's now loop-safe (the gate blocks re-ingest) and, post-Task-A, trims by
real content age.

**Plumbing:** the caps are read live so an admin change takes effect next poll,
no restart. The gate needs them during `acquireSource`; thread the live
`getSetting` into the acquisition engine at its construction site
(`server.ts:37`, per the review — NOT runtime), same source the trim reads.

### Phase 2 — deferred (decide after the pipeline audit): the count gate

The count cap only loops for a source whose feed serves **> maxCount items all
within the age window** (high-volume *recent* feed) — not the current flood
(old back-catalog, handled by Phase 1). Closing it needs a per-source "N-th
newest content date" queryable at commit, i.e. a stored
`deliveries_v2.content_sort_at` column + index + a **synchronous** backfill in
the migration (review Important: an async backfill leaves count-gating disabled
during a window). That's the only part of this whole fix that needs schema —
and a pipeline-simplification audit is queued immediately after Phase 1, which
may change how (or whether) the count cap should exist. So Phase 2 is
**explicitly deferred** until that audit informs it. If the audit is delayed and
a high-volume-recent feed starts looping before then, promote Phase 2.

Also for Phase 2: reconcile the **cap unit** (review Important) — the gate would
count *deliveries* while the cap/trim count *logical items*; they can diverge
(a GUID-reissue leaves one item with two deliveries). Settle on logical items
(the cap's stated meaning) when Phase 2 is designed.

## Load-bearing invariants

- **`maxAgeDays = 0` (and `maxCount = 0`) ⇒ gate disabled** — ingest everything,
  today's unlimited default.
- **Local items are never gated** (remote/source origin only), same exemption
  the trim has.
- **One content date, used everywhere.** After Task A, the item's published date
  (clamped `pub <= arrival ? pub : arrival`) is what the timeline sort, the age
  trim, and the age gate ALL use. The earlier draft's "gate must equal
  `timeline_sort_at`" invariant was written before C1 was understood — the point
  is not "match the current (broken) value" but "there is ONE content date and
  Task A makes it correct everywhere."
- **No user-facing data migration in Phase 1.** On deploy, Task A corrects sort
  order going forward; the gate blocks re-ingest so the over-window backlog the
  trim removes stays gone → self-converges. (No new column in Phase 1.)

## Testing

- **Task A:** a remote item with a real (old) published date gets
  `timeline_sort_at = published`, not arrival — drive a DATED item through the
  real pipeline (parse → commit → reconcile), NOT a hand-built
  `canonical_material` blob. Review C2: the existing `logical-reconcile.test.ts`
  seed hand-builds `canonical_material` **with** `published` — a shape
  production no longer emits — so it green-tests dead code; replace/augment with
  a real dated-item test.
- **Task B:** gate skips an over-age incoming item on a NEW delivery (no
  delivery/version/job created, `retentionFiltered` incremented); a within-age
  item still ingests; an existing in-window delivery still records a genuine
  edit (gate doesn't block updates); `maxAgeDays = 0` → gate inert.
- **Loop is dead:** poll an over-age feed twice (same old items) → zero new
  deliveries on the second poll (today: N new deliveries every poll).
- **Task C:** if `verification.ts:352` can ingest, it honors the same gate.
- `trimSourceToCap` still removes a stored item that aged past the cutoff (now
  by real content age).

## Out of scope (YAGNI / deferred)

- **Phase 2 count-floor gate + `content_sort_at` migration** — deferred to after
  the pipeline audit (see Phase 2).
- Per-user retention; changing cap semantics or the admin UI.
- The `/admin/settings` form-reset bug — already fixed separately (`db7de6d`).
- A retroactive purge of already-created duplicates (the trim converges them).

## Execution

Spec → user review → clean-context review (done, folded) →
`superpowers:writing-plans` → `superpowers:subagent-driven-development`. Phase 1
touches the reconcile/acquisition core (load-bearing) — a whole-branch review on
the most capable model at the end. The pipeline-simplification audit
(`ponytail-audit` over `core/src/logical`) follows Phase 1 and informs Phase 2.
