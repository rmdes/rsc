# SP3 subscribe & manage — spec review (rev 0 → rev 1)

Spec: `docs/superpowers/specs/2026-07-19-subscribe-manage-design.md`
Reviewers: clean-context correctness (13 findings, file:line-verified) +
ponytail (8 cuts). All dispositions folded as rev 1.

## Correctness findings

- **F1 Important — local-feed-URL shadow.** `subscribeByUrl` has no local-URL
  resolve (`getRemoteUserByFeedUrl` matches remote only); pasting a
  same-instance feed URL (even your own) mints a remote clone that re-ingests
  duplicate posts. **Folded:** fifth ride-along — `localHandleForUrl` resolve
  (OPML Case-2 pattern) before the remote lookup.
- **F2 Important — case-sensitive owner check.** Handles are stored/lowered
  lowercase; `isOwner`/lens compares on raw `params.handle` would demote the
  owner on a mixed-case URL. **Folded:** load lowercases the param.
- **F3 Important — backfill guard vs discovery rewrite.** R1's `updateFeedUrl`
  breaks `display_name === feed_url` forever for the most common flow (pasting
  a page URL). **Folded:** backfill runs before `updateFeedUrl`.
- **F4 Important — title not parsed anywhere; fat-ping path.**
  `parseFeedWithMeta` discards feed titles; function names corrected
  (`ingestRemoteUser`/`ingestViaDiscovery`); fat-ping feeds heal on the
  every-10th-tick full poll. **Folded:** title threading specified; fat-ping
  explicitly accepted out of scope.
- **F5 Important — "at source" overstated.** OPML Case-1 still mints vestigial
  instance follows. **Folded (with ponytail thinking):** the guard moved to
  `service.addFollow` itself — one central guard covers reuse, OPML Case-1,
  the re-resolve winner, and direct `POST /me/follows`.
- F6 Minor line refs (`updateFeedUrl` is sqlite.ts:108) — fixed.
- F7 Minor `subscribe.test.ts:77` strict `toEqual` breaks on `created` — called
  out in §7.
- F8 Minor OPML re-resolve needs `ImportDeps.getRemoteUserByFeedUrl` +
  `subCount++` + instance-winner handling — all specified.
- F9 Minor three deleted `addRemote` action tests — called out in §7.
- F10 Minor cap bypass via uncapped `POST /me/follows` — documented as
  known/accepted in §6, gating deferred.
- F11 Minor OPML silent cap-skips — import-result copy gains a reason hint.
- F12 Minor tab-override coherence — confirmed intentional, asymmetry noted in §3.
- F13 Minor guest/anon ambiguity in viewerFollowIds — dissolved (feature cut).

## Ponytail cuts (all folded)

1. Lens `ownerHandle` extension → one inline disjunct in the following page's
   `onPost`; `lens.ts` untouched.
2. `viewerFollowIds` fetch + branch deleted — `addFollow` is idempotent and
   the instance guard no-ops instance rows; always render Follow.
3. Duplicate `?/subscribe` actions → the following-page form posts cross-route
   to `/?/subscribe` (one action, one error rail).
4. feedType badge on every row → `instance` badge only.
5. Two bespoke flash strings → one ("Now following @handle."), redirect
   ternary keeps `personal`/`federated` landing.
6. Per-button "Follow as you" title/aria → the existing auth-note suffices.
7. §6 "open details" forward references → inlined where used.
8. Tests for cut features pruned (lens unit test, viewerFollowIds load test,
   duplicate action suite, admin-settings load test).

Net effect: rev 1 closes five real design holes and sheds ~100 implementation
lines relative to rev 0.
