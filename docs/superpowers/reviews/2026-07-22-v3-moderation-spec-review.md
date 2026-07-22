# V3 spec review — moderation, events, verification (2026-07-22)

Target: `docs/superpowers/specs/2026-07-22-rsc-moderation-events-verification-design.md`
(rev 0, 3d6bd40, 688 lines — loop-authored draft). Dual pass: ponytail
(VP1–VP6) + correctness (VC1–VC4), adjudicated by the orchestrator.
**Verdict: the draft's line-level discipline held (zero citation drift; V2
conventions reused verbatim; authz matrix satisfiable) — the defects are
structural scope and cross-document reasoning. Fold as rev 1.**

## Scope decision (folded as default; maintainer may veto — V1-appetite style)

### VP1 — Defer the entire v2 push subsystem out of V3

§3 builds full WebSub/rssCloud registration/renewal/ingestion (~84 spec lines
+ push tables in §9 + push DTO/web surfaces + push-gated §6 rows and §11
clauses) from roadmap wording that only constrains "paused/blocked push
behavior" — all behind a flag nobody enables before V4, on a single-user
instance where §1.3's poll loop is fully functional and push is pure latency
optimization. **Rev 1 default: defer v2 push to V4 (whose charter is push/
follow preservation anyway) or its own vertical; keep §3.3's pause/block
matrix as a one-paragraph forward constraint on whatever push ships.** This
halves V3's new-mechanism surface, and evaporates VC4 and flagged decision #5
(whose capture-at-poll resolution was verified correct-and-forced — record it
for the future push vertical). Roadmap gets a one-line scope note.

## Structural (ponytail)

- **VP2 — One scheduling idiom:** §4.1's separate verification drain +
  `verification_checks_v2` attempt/next-attempt columns re-implement V2 rev
  1's reconciliation drain (even duplicating its backoff constants verbatim).
  Make origin-verification a job KIND on the existing drain; the checks table
  keeps only per-(item, publisherURL) terminal state + the publisher batch
  key. The milestone runs TWO loops (poll + reconciliation drain), not four.
- **VP3 — Collapse the admin subresource routes:** four cursor-paginated
  per-item routes (deliveries/versions/claims/conflicts) size for volume a
  single-user instance can't reach. Embed them bounded (cap 100, no cursor)
  in `AdminItemDetail`; keep cursors only for the audit list and
  source→items. `ponytail: inline caps, paginate when an item exceeds 100`.
- **VP4 — Justify or merge `structural_tombstone` vs `deleted_local`:** the
  two terminal states differ behaviorally in nothing the spec names except
  origin (already a field). Either document the retained-anchor asymmetry
  (deleted_local keeps the canonical local permalink for echo reattachment)
  as the load-bearing difference, or merge into one terminal state
  discriminated by origin.
- **VP5 — Two tombstone mechanisms, not three:** "purge tombstone" is not a
  mechanism — purge writes into `blocked_source_tombstones_v2` (V1 DDL
  already covers block+purge actions). Fix §Purpose/§5 naming.
- **VP6 — Prune push-gated rows/clauses** from §6 and §11 on deferral; KEEP
  the explicit no-event rows (they prevent readers assuming events fire).

## Correctness (cross-document)

- **VC1 — §1.2/Open-Dep-2 misstate the V1 fold:** the V1 review explicitly
  folds the three unused AuditCategory values as REMOVALS from schema + DTOs
  (six-value CHECK decided, not hypothetical). Rev 1 states the actual
  decision and stops recommending the nine-value CHECK — that call was made.
- **VC2 — The table-rebuild worry is phantom:** `false_positive` is emitted
  into `item_audit_v2` — a NEW table V3 authors with its own CHECK — and
  `remediated` lives only in the command-ledger `result_json` (no CHECK).
  Nothing ever widens `source_audit_v2`. Rev 1 deletes the rebuild concern
  AND makes explicit that `item_audit_v2` must NOT blindly mirror the
  narrowed six-value CHECK (restore's `false_positive` would fail at runtime).
- **VC3 — Foundation contradictions need foundation-doc notes, not in-spec
  flags:** (a) quarantined-evidence: foundation §7 says "may strengthen
  attribution but cannot supply displayed content"; V2 §3.2 (folded) says
  neither comparator — V3 follows V2. (b) fan-out item events: foundation §6
  says fan-out "applies … item events"; V2/V3's read-time-authority model
  correctly drops them. Both are decided; add two dated amendment notes to
  the governance design so future readers (V4!) don't re-implement the stale
  text. The foundation is a live design authority, not an executed record —
  amending is correct under the docs policy.
- **VC4 — §3.2's grounding defects** (cites out-of-scope foundation §12 for
  its schema; `pending|active|expired|invalid` widens the legacy
  `PushSubscription` shape while claiming reuse): moot under VP1's deferral —
  fold the corrected facts into the deferral note so the future push vertical
  inherits them.

## Flagged-decision verdicts (both reviewers concur; record in-spec)

#1 fan-out no-journal-events: RIGHT (+ foundation note per VC3b).
#2 no-unsubscribe/lease-expiry: right-if-push — moves to the push vertical.
#3 ledger-row-as-audit for unblock: RIGHT.
#4 one-transaction purge: RIGHT, ceiling honestly named.
#5 capture-at-parse-time: RIGHT and FORCED (V2 rev 1 stores digests, not
re-parseable channel discovery — V2 §1.2's "re-parse" wording was
unfulfillable); record for the push vertical.

## Verified clean (keep)

All code citations exact (auth.ts:65 401; app.ts:63/65 jsonWrite; app.ts:
407/415 callback routes; sqlite.ts:566/706-709 migrations; ingest.ts:12/87/
246; push-in.ts:16/30/41-46/258; push-guard.ts:39; push-in.test.ts real).
§7.1 reuses V2's command idiom exactly; §6 uses only upsert/remove/reset +
ReplyCountOverlay verbatim; verified_origin prepend matches V2's
strongest-first reservation; §9 appends at tail; authz [401,403,403,200]
satisfiable (requireAdmin 403 at auth.ts:82; bearer-401 correct — no
adminOrToken on these routes); §10 flag-OFF isolation clean (v1 push
byte-identical when off). Open Dependencies #1 (policy_generation owner) and
#3 (V2 interim last-subscription cleanup) are correctly grounded and remain
CROSS-TAB maintainer items.

## Handoff

Fold as rev 1 (this loop). Foundation amendment notes ride the same commit.
Push-deferral is the one veto-able scope call — flagged to the maintainer in
the loop report. V4's draft waits for this rev (its charter inherits push).
