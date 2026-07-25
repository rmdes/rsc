# Admin governance visibility — spec review (2026-07-25)

Target: `docs/superpowers/specs/2026-07-25-admin-governance-visibility-design.md`
(rev 1, `0be85e9` — authoring session's own fold; this is the independent
second pass, both lenses in one agent, 16 findings + verified-clean table in
the review transcript). **Verdict: NOT READY — rev 2 must SPLIT the spec.**

## Adjudication

1. **BLOCKER — scope honesty.** The motivating incident (763k-version
   Gutenberg feed) is a per-user feed with a subscription; the spec's own
   always-enforced guard (`COUNT(*)>0` any-state, mirroring
   `source-repository.ts:228`) excludes it from the orphan/reap surface
   permanently. Goals 3–5 can never reach the incident. Only `?q=` and
   `addedBy` help find it, and the remedy remains block→purge. Rev 2 states
   this in the Motivation.
2. **BLOCKER — the churn bug has no home.** No fix, no incident record, no
   backlog entry anywhere; the Non-goals defer to a "storage-hardening
   backlog" that was never written. Minimum companion: an `ideas.md` entry
   naming 763k/2.6GB, the candidate mechanisms (per-delivery version
   retention cap; or an `acquisition_findings_v2` churn finding +
   auto-pause), and a testable promotion trigger. Recommended: a real
   hardening task — the mechanism is armed on every instance against every
   feed.
3. **SPLIT (the shape of rev 2):**
   - **Ship-now half (no collision):** `?q=` search + prev link; `addedBy`
     attribution (matching the three per-row sibling lookups, no batched
     query, no query-count test — the `ponytail:` ceiling at
     `sqlite.ts:812` governs); users pagination (all EIGHT call sites, not
     3); the v2 `deleteUserCascade` reap-leak fix at `local.ts:279` WITH
     the journal-barrier ordering pinned (reaps subsumed under the one
     account reset — never N+1 barriers).
   - **Deferred half (blocked on the members work):** the orphan group and
     the operator-reap command. 46 of 49 "orphans" are `origin_verification`
     members whose real home is the members spec's instance roll-up — two
     specs currently give the same 46 rows different homes in the same
     three web files. The residual genuine leaks are 2–3 rows per instance
     with an existing three-click path (block → purge → unblock-tombstone);
     a new ledgered command + force flag + confirm dance for that volume
     fails YAGNI. Revisit after members lands; most of the group will have
     vanished.
4. **Frozen-guard discipline:** any surviving surface change states the
   web guard's intent change explicitly (`source-actions.test.ts:122-124`
   — the comment says "no retention flag"; `retention` slipping the regex
   by accident is not an amendment) and updates the exact per-row action
   lists.
5. **Cross-spec record:** the members spec's one-instance-audit-row
   decision was justified partly by reap-guard interaction; if reap ever
   becomes operator-overridable, that rationale rests on volume/noise
   alone — record in whichever doc revs next so it isn't re-litigated.
6. Mechanical fixes from the transcript ride the rev: authz matrices for
   any new route (both the admin matrix and the ops-token 401 list), the
   `convert.ts` path, the addedBy count basis, the dangling incident link,
   the guard-order prose, `listSources` signature scope.

## Handoff

Fold as rev 2 (split) + the `ideas.md` churn entry in the same commit.
The ship-now half may then go to a small plan; the deferred half re-enters
after the instance-governed-members feature lands. The churn hardening
decision (task now vs. backlog+trigger) is the maintainer's call — flagged
as the more urgent item than either spec.
