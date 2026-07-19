# SP2 four-tab timeline — final whole-branch review

Feature: 6 commits `9ea04a7..483a43d` on main (spec rev 3, plan rev 1, SDD
6 tasks each with clean per-task review). Reviewer: most capable model,
whole-branch altitude, gates re-run independently.

**Verdict: READY TO MERGE.** Core 396/396 + tsc 0; web 148/148 + svelte-check
0 errors (1 pre-existing warning). No Critical, no Important findings.

## Why it coheres

Server filter and client lens are the same predicate over the same wire field
for every tab (source / feedType / follows+self-minus-instances / none), and
the live-emission paths (`rowToUser` on ingest emits, `getTimelineAfter` on
SSE replay) carry `feedType`, so both halves see the same data. Lens semantics
are fail-closed: a missing field drops the event — the worst failure anywhere
is a missing live prepend that a reload fixes. Edit overlays can never strand
(an edit passes the same lens its post did). `tabHome` allowlists `?tab`
before echoing into redirects.

All six load-bearing invariants HELD: sanitizer gate ({@html} only in
PostBody), /api/auth proxy untouched, core stays non-browser-facing, tokens
only (no raw hex), no-JS first-class (SSR aria-current, plain-form fallbacks,
`?tab=x&/action` verified against installed SvelteKit source), jank-free
prepends (constant-height tab bar above the list).

## Minors (none block merge)

1. **`/u/:handle/following` live lens omits the page owner** (new divergence:
   the server timeline is now self-inclusive but that page's `followIds`
   isn't) — missing-prepend only. Same page has a **pre-existing** sibling
   gap: its lens doesn't exclude vestigial instance follows (wrong-content
   live case, SP1-era). **Both → SP3 touch-up** alongside the subscribe-
   surface rework.
2. Personal-tab `followIds` is a load-time snapshot (follow/unfollow after
   load lags until navigation) — standing pattern, implied by the spec's
   first-page-only design. Accepted.
3. Personal + core-down-then-recover: catch branch has no `followIds`, so a
   reconnected SSE stream drops everything until reload. Fail-closed,
   cosmetic. Accepted.

Ledger'd Task-4 Minor (`following && me`) triaged **not a defect** — the `me`
narrowing is required under strict null checks.

## Residual risk

Pixel/theme rendering was verified structurally (DOM/aria/filtering via
headless browser) but not visually — the headless env has no CSS engine. Risk
low: the CSS reuses the shipped `.admin-nav` pattern and standing tokens; only
`text-transform: capitalize` and `min-height: 44px` are novel, neither
theme-sensitive. **Eyeball both themes at deploy.**
