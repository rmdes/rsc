# Cross-vertical contract review — RSC source-governance milestone (2026-07-23)

Executed per V4 plan Task 12 (rev 2, 8ca6025) over the four READY plans, their
governing specs, and the roadmap. Verified as LANDINGS with proving quotes
(file:line in the gate transcript); not a content re-review.

## Verdict: GATE OPEN — Vertical 1 implementation may begin.

| # | Item | Verdict |
|---|---|---|
| 1 | SQL CHECKs foundation-wide, TS enums per-vertical narrow (V1 source_audit nine-wide :296; V3 item_audit/tombstones nine-wide :714/:718; V2 provenance three-wide :568; reason stays two-wide) | PASS |
| 2 | Capability chain frozen once: V1 boolean → V2 widens endpoint+toEqual+client type (:408-416, :517-521) → V4 value-only flip (:584-586) | PASS |
| 3 | Command conventions uniform: body commandId, [command, resource, actor(, payload)] fingerprints, jsonWrite export pin (V2 :394), consistent 409 bodies | PASS |
| 4 | Every lockstep amendment landed at its named location (V2 rev 5: aliases+writer, verification-ready jobs DDL+named-column pin, FK-graph cleanup, export; V2 rev 6: provenance CHECK, both pointer fixes, shape comment; V3 §1.2 note; foundation §6/§7 amendments) | PASS |
| 5 | Supersessions declared where they bite (verified_origin names the widened V2 suites :447/:461; SourceSummary.push V1-deferred/V4-first-written; updatedAtProvenance membership :462; ops fingerprint verbatim :618) | PASS |
| 6 | No vertical leaks: push_ping/push_delivery 0; epoch/fence/leaseUntil/four-slot only in changelogs; findings-relation only as negations; push states pending|active only | PASS |
| 7 | Roadmap conformance: review order 1→2→3→4 per rev headers; all four READY; implementation gated behind this review | PASS |
| 8 | V4 Task 12's own checklist walked item-by-item | PASS |

Non-blocking notes: V3 :374's ponytail note declines (not uses) lease/fence
machinery — inverse of a leak; this file is the Task 12 deliverable itself.

## Milestone record

Specs: V1 (foundation + amendments) · V2 rev 1 (9892757) · V3 rev 1+lockstep
(1d62e23, 0b4d3f9) · V4 rev 1 (0b4d3f9). Plans: V1 rev 5 (3939fea) · V2 rev 6
(8ca6025; revs 3-5 at 183b0aa/ed7e8ad/00b95ba) · V3 rev 2 (00b95ba) · V4 rev 2
(8ca6025). Reviews: v1/v2/v3/v4 records in this directory. Every artifact
dual-reviewed (ponytail + correctness), findings folded as numbered revs.

Execution proceeds per the roadmap: Vertical 1 → 2 → 3 → 4, V4 Task 12's
record being this file.
