# SP3 subscribe & manage — final whole-branch review

Feature: 7 commits `084297d..f5d4e58` on main (spec rev 2, plan rev 1, SDD
7 tasks each with clean per-task review). Reviewer: most capable model,
whole-branch altitude, gates re-run independently. Completes the
per-user-feeds milestone (SP1 engine → SP2 four-tab timeline → SP3).

**Verdict: READY TO MERGE.** Core 404/404 + tsc 0; web 154/154 + svelte-check
0/0. No Critical, no Important findings.

## Why it coheres

- The subscribe journey is sound end to end (form → route → service →
  three-outcome redirect → flash → personal river), and the redirect's
  `kind === 'local'` branch was **proven exhaustive**: every service path
  returning `followed: false` on a remote row is necessarily an instance.
- `followUnlessExcluded` is a genuine root-cause guard: every minting path
  routes through it, the boolean is load-bearing for OPML counts, and its
  blast radius is nil — the poller polls all remote users regardless of
  follower edges, the federated tab filters by `feed_type` not follows, and
  vestigial instance edges remain unfollowable (edge deletes, row exempt from
  cascade).
- The displayName backfill fails closed: single atomic guarded UPDATE
  (`whereRef display_name = feed_url`), backfill-before-rewrite ordering
  commented AND pinned by a dedicated ordering test.
- SP2 regression surface: tab machinery untouched; the two pages' lenses are
  now consistent (both exclude instances).

All six load-bearing invariants HELD (sanitizer/{@html} confinement, /api/auth
proxy, core non-browser-facing, tokens-only, no-JS first-class, jank-free
prepends) — verified explicitly.

## Minors (none block merge)

1. SSR/live asymmetry for pre-guard vestigial instance edges (SSR timeline
   includes them, live lens drops them) — mirrors SP2's accepted home
   asymmetry; self-heals via the Unfollow cleanup this page now provides.
2. Near-miss own-instance URLs (nonexistent handle) fall through and mint a
   404-polling shadow row — pre-existing OPML Case-2 shape, cap+SSRF-gated;
   backlog.
3. Sentinel collision: a displayName deliberately set to the exact feed URL
   gets title-backfilled on next poll — inherent to the design, likely
   desirable.

## Deferred Low — triaged DEFER

Visitor-mode Follow button reuses `.unfollow-form` → destructive red on a
positive action. Not one line (class swap drags flex-container rules); the
clean ~3-line fix (second class + one accent rule) should go through the UI
skill + MASTER.md in its own pass. Queued in ideas.md.
