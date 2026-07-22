# V2 spec review — logical items & ordinary reads (2026-07-22)

Target: `docs/superpowers/specs/2026-07-22-rsc-logical-items-ordinary-reads-design.md`
(committed; 1492 lines). Two independent subagent passes — ponytail lens (P1–P8)
and correctness/grounding (C1–C5) — de-duplicated (no overlap) and adjudicated
by the review orchestrator against the roadmap's own constraints, the V1
review, and root-only rev 1. **Verdict: the domain model, flag-OFF isolation,
security bounds, and read contracts are strong; but the spec carries a
substantially larger over-build than root-only did — concurrency/durability
machinery the roadmap itself forbids for this single-user, single-process
system — plus one HIGH that reintroduces the exact OFF-state regression the V1
review closed. Fold as spec rev 1 BEFORE the V2 plan is reviewed (the plan,
currently mid-edit, will have inherited these).**

## HIGH

### C1 — §5.6's fail-closed rule reintroduces the V1 OFF-state regression, on a wider surface (line 1074)

"Capability failure → never fall back to v1, discard/close/error" conflates
two cases the V1 review (Findings 1/8, adjudicated + hardened) explicitly
separates: a successful capability read reporting v2 followed by a malformed
envelope (correctly fail-closed) vs **the capability endpoint being
unreachable** (must degrade to legacy — which is exactly what OFF is — with
only successful readings memoized, never failures). As written, a cold-cache
web pod hitting one `/capabilities` blip during a rolling deploy error-pages
surfaces that today have zero capability dependency (post detail, thread,
history). **Fix:** carve the rule: fetch-failure ⇒ treat as legacy/OFF for
that request and retry next request; successful-v2 + bad envelope ⇒ fail
closed. Same sticky-cache pin as V1: memoize success only.

### P1 — Durable parent+root count fan-out is the machinery root-only rev 1 already cut (§5.5, line 1023)

Every resolved-reply mutation appends the reply's upsert PLUS a parent upsert
PLUS a root upsert (deduplicated), with a reset-fallback branch when the set
can't be enumerated in-transaction — 2–3 journal rows per reply plus a whole
fallback path and its test matrix. Root-only rev 1 proved the need is ONE
authoritative number on the reply's own stream frame (idempotent under
replay), with SSR reads computing counts at query time. **Fix:** drop the
parent/root fan-out and reset branch; carry the authoritative conversation
count on the reply's stream event; SSR projections read counts via the
existing query-time pattern.

### P5 — Journal epochs, 10k ring, and replayFloorSeq are multi-version rollback machinery the roadmap forbids (line 955)

Today's SSE recovery is: subscribe-before-replay, inclusive replay from
Last-Event-ID, else the client falls back to SSR. The spec's persistent
epoch + pruned-floor arithmetic + below-floor/at-floor replayability
distinction + epoch-changing reconstruction is a state machine serving no
single-user need. **Fix:** monotonic `seq` + ONE reset-generation integer;
any unknown/stale/reset cursor emits a single `reset` event and the client
refetches SSR. Keep the reset event (genuinely new — reads are now
policy-projected); drop epochs and floor bookkeeping.

## Machinery for contention that cannot exist (single Node process; roadmap: "no distributed locks")

### P4 — Acquisition claim fences/expiry-recovery/command-joining (line 104)

Today's poller is one global serial loop (`server.ts:60`). Monotonic fences,
expiry recovery on the same run ID, and "commands join only the active claim"
arbitrate racers that structurally don't exist. **Fix:** per-source in-flight
boolean (or the existing serial loop) + the policy/reason recheck at
commit-time — the only real correctness need.

### P6 — Reconciliation worker leases + fences for a worker that cannot race itself (line 271)

"One worker, one job at a time, one process" — 60-second leases, monotonic
fences, a 16-job candidate window, and startup lease recovery collapse to: an
in-process serial drain after each acquisition and at startup, an attempt
counter for backoff, and the policy-generation check at commit.

### P7 — Durable four-slot scheduler + per-source health/backoff vs today's serial loop (line 78)

Speculative throughput engineering for a load profile a single-user instance
doesn't have. **Fix:** keep the global loop; add per-source `lastPollAt` +
skip-if-recent; add backoff only when a real feed misbehaves
(`ponytail: single-lane poll, add slots if feed count grows`).

## IMPORTANT (contract gaps — same classes as the V1 review)

### C2 — The refresh POST doesn't state the `jsonWrite`/bodyLimit guard (line 1118)

Every authed JSON write composes `jsonWrite` (`core/src/api/app.ts:65`; e.g.
the PATCH at app.ts:132). Say it explicitly — the V1 review's IMPORTANT #6,
same class.

### C3 — The refresh idempotency fingerprint inputs are undefined (line 1131)

The 409 mismatched-fingerprint branch is untestable until the inputs are
pinned (body is always `{}`; sourceId is in the path). Define them (e.g.
`[command, sourceId, actor]`) — V1 review IMPORTANT #4, same class.

### C4 — Command-ID keying idiom drifts from V1: header vs body field (line 1119)

V1 commands carry `commandId` in the JSON body; V2's refresh uses an
`Idempotency-Key` header into the same shared ledger. Pick one (recommend the
V1 body-field convention — the body is `{}` anyway) or document the header
convention as a deliberate empty-body-route exception, so the shared ledger
helper isn't forked.

### C5 — V2 silently widens V1's capability wire shape and client type (line 1054)

V1's plan types `getCapabilities → {sourceModelV2: boolean}` and asserts the
ON body with exact `toEqual({sourceModelV2:true})`. V2 adds `model`,
`journalCursorVersion`, `streamProtocolVersion` and consumes them client-side.
State the supersession explicitly: V2 widens the wire shape, updates the V1
exact-equality test, and widens the client type.

## Deferral class (the V1 appetite decision applies verbatim)

### P2 — `verified_origin` is a dead enum rung with no V2 producer (line 432)

Comparator branch + DTO enum value + ranking-test states for an evidence
level V2 cannot create. Ship 3 levels; V3 prepends the strongest rung when it
adds verification (strongest-first comparator makes it purely additive).

### P3 — Inert WebSub/rssCloud capability claims stored + admin-exposed for V3 (line 66)

Schema + parser + admin DTO field + isolation tests for data nothing reads,
feeding a V3 push subsystem that "must revalidate" anyway. V3 re-parses from
the stored raw feed evidence; V2 stores and exposes nothing.

### P8 — `eligibleSourceIds` array per DTO so the client re-derives what core already computed (line 538)

The spec's own rule is "client lens filtering is never the visibility
boundary," and `classification.federated` is already a boolean on the same
DTO. Make Personal membership a boolean too; drop the per-item id array and
its bound/sort/dedup invariants.

## Verified clean (keep at full strength — both reviewers concur)

Flag-OFF isolation (`RSC_SOURCE_MODEL_V2` startup-immutability, §7.4
cross-model guarantees, configured-v2-init-failure fails startup rather than
serving v1); SSRF/redirect bounds, 301/308-only alias proof, digest-backed
evidence rules; Core-semantic-text + web-side shared sanitizer reuse
(`markdown.ts` — no second pipeline); a11y/no-JS inherited from root-only
rev 1 with no `enhanced` prop; admin retry command-ID retention. Grounding
that verified: no bare `GET /post/:id` exists (the v2-only single-item route
claim is correct, no OFF-state collision); `/posts/:id/revisions` and
`/post/:id/thread` route names match app.ts:147/:260; §6.1 avoids the V1
authz trap (no unsatisfiable 403 cells; consistent with 401-before-403 at
auth.ts:64-66); SSE proxy naming matches `stream/+server.ts:12-17`;
direct-vs-conversation count split matches root-only rev 1 and the real
`countRepliesByPostIds`; snapshot-only threads consistent with rev 1;
additive-migration claims well-founded (MIGRATIONS user_version-indexed at
sqlite.ts:566,706-709 — the rev should also restate append-at-tail).

## Handoff

Fold as **spec rev 1** before reviewing the V2 plan (currently mid-edit —
it will have inherited P1/P4–P7's task structure and C1's web branch).
Cite `core/src/api/app.ts:65` for `jsonWrite` in the rev text. The review
loop re-reviews the folded rev and then the revised plan.
