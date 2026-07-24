// Additive logical-v2 schema (spec §7.1, plan Appendix A). ONE migration entry,
// appended strictly at the TAIL of the MIGRATIONS array in sqlite.ts — mid-array
// insertion would renumber applied migrations and corrupt user_version on the
// live databases. Pure additive: CREATE TABLE / CREATE INDEX / one ALTER ADD
// COLUMN, plus the two singleton rows. Creates only the INACTIVE activation row
// and empty journal — Task 2 does not reconcile or mark v2 active.
//
// Contract invariants (frozen across all four verticals):
//  - SQL CHECKs carry the FULL foundation vocabulary; TS types stay narrower.
//    presentation_entries_v2.provenance is three-wide (incl. 'legacy_unknown',
//    written only by V4's legacy conversion); reconciliation_jobs_v2 is
//    verification-ready from day one though V2 writes only kind='observation'.
//  - Every FK is ON DELETE RESTRICT except source_aliases_v2 (ON DELETE
//    CASCADE — V3's purge copies aliases into tombstones before the cascade).
//  - Every INSERT names its columns explicitly.

export const LOGICAL_V2_SCHEMA: string[] = [
  // --- activation + journal --------------------------------------------
  `CREATE TABLE logical_activation_v2 (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    schema_version INTEGER NOT NULL CHECK(schema_version = 1),
    state TEXT NOT NULL CHECK(state IN('never_activated','active','reconciliation_required')),
    last_activated_at TEXT, last_reconciled_at TEXT
  )`,
  `CREATE TABLE logical_journal_meta_v2 (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    high_water_seq INTEGER NOT NULL, reset_generation INTEGER NOT NULL
  )`,
  `CREATE TABLE logical_journal_v2 (
    sequence INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN('upsert','remove','reset')),
    logical_item_id TEXT, change_mask INTEGER NOT NULL, created_at TEXT NOT NULL
  )`,

  // --- publishers + names ----------------------------------------------
  `CREATE TABLE remote_publishers_v2 (
    id TEXT PRIMARY KEY, canonical_feed_url TEXT UNIQUE,
    identity_level TEXT NOT NULL CHECK(identity_level IN('feed_anchored','source_scoped_fallback')),
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE publisher_names_v2 (
    id TEXT PRIMARY KEY,
    publisher_id TEXT NOT NULL REFERENCES remote_publishers_v2(id) ON DELETE RESTRICT,
    source_id TEXT NOT NULL REFERENCES remote_sources_v2(id) ON DELETE RESTRICT,
    observation_version_id TEXT NOT NULL, evidence_level TEXT NOT NULL,
    normalized_name TEXT, first_seen_at TEXT NOT NULL,
    effective INTEGER NOT NULL CHECK(effective IN(0,1))
  )`,

  // --- logical items + local bridge + identity -------------------------
  `CREATE TABLE logical_items_v2 (
    id TEXT PRIMARY KEY,
    origin TEXT NOT NULL CHECK(origin IN('local','remote')),
    timeline_sort_at TEXT NOT NULL,
    parent_state TEXT NOT NULL CHECK(parent_state IN('none','missing','ambiguous','resolved')),
    parent_logical_item_id TEXT REFERENCES logical_items_v2(id) ON DELETE RESTRICT,
    selected_delivery_id TEXT,
    selected_publisher_id TEXT REFERENCES remote_publishers_v2(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE logical_local_origins_v2 (
    logical_item_id TEXT PRIMARY KEY REFERENCES logical_items_v2(id) ON DELETE RESTRICT,
    post_id TEXT NOT NULL UNIQUE REFERENCES posts(id) ON DELETE RESTRICT
  )`,
  `CREATE TABLE logical_deleted_local_v2 (
    logical_item_id TEXT PRIMARY KEY REFERENCES logical_items_v2(id) ON DELETE RESTRICT,
    canonical_permalink TEXT NOT NULL UNIQUE, deleted_at TEXT NOT NULL
  )`,
  `CREATE TABLE logical_identity_keys_v2 (
    kind TEXT NOT NULL, key TEXT NOT NULL,
    logical_item_id TEXT NOT NULL REFERENCES logical_items_v2(id) ON DELETE RESTRICT,
    PRIMARY KEY(kind, key)
  )`,

  // --- deliveries + observation versions + presentation ----------------
  `CREATE TABLE deliveries_v2 (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES remote_sources_v2(id) ON DELETE RESTRICT,
    key_kind TEXT NOT NULL, key TEXT NOT NULL,
    first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, last_seen_run_id TEXT NOT NULL,
    seen_count INTEGER NOT NULL, UNIQUE(source_id, key_kind, key)
  )`,
  `CREATE TABLE observation_versions_v2 (
    id TEXT PRIMARY KEY,
    delivery_id TEXT NOT NULL REFERENCES deliveries_v2(id) ON DELETE RESTRICT,
    fingerprint_version INTEGER NOT NULL, fingerprint TEXT NOT NULL,
    canonical_material BLOB NOT NULL, arrival_at TEXT NOT NULL, run_id TEXT NOT NULL,
    wire_ordinal INTEGER NOT NULL, last_seen_at TEXT NOT NULL, last_seen_run_id TEXT NOT NULL,
    seen_count INTEGER NOT NULL, raw_evidence_json TEXT NOT NULL, normalized_json TEXT NOT NULL,
    UNIQUE(delivery_id, fingerprint_version, fingerprint)
  )`,
  `CREATE TABLE presentation_entries_v2 (
    delivery_id TEXT NOT NULL REFERENCES deliveries_v2(id) ON DELETE RESTRICT,
    sequence INTEGER NOT NULL,
    observation_version_id TEXT NOT NULL UNIQUE REFERENCES observation_versions_v2(id) ON DELETE RESTRICT,
    effective_updated_at TEXT,
    provenance TEXT CHECK(provenance IN('explicit','arrival','legacy_unknown')),
    material_fingerprint TEXT NOT NULL, PRIMARY KEY(delivery_id, sequence)
  )`,

  // --- claims + conflicts + orphan work --------------------------------
  `CREATE TABLE publisher_claims_v2 (
    id TEXT PRIMARY KEY,
    logical_item_id TEXT NOT NULL REFERENCES logical_items_v2(id) ON DELETE RESTRICT,
    publisher_id TEXT NOT NULL REFERENCES remote_publishers_v2(id) ON DELETE RESTRICT,
    source_id TEXT NOT NULL REFERENCES remote_sources_v2(id) ON DELETE RESTRICT,
    observation_version_id TEXT NOT NULL REFERENCES observation_versions_v2(id) ON DELETE RESTRICT,
    evidence_level TEXT NOT NULL, first_seen_at TEXT NOT NULL
  )`,
  `CREATE TABLE logical_conflicts_v2 (
    id TEXT PRIMARY KEY,
    logical_item_id TEXT REFERENCES logical_items_v2(id) ON DELETE RESTRICT,
    observation_version_id TEXT REFERENCES observation_versions_v2(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL, evidence_json TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE orphan_work_v2 (
    id TEXT PRIMARY KEY, alias_kind TEXT NOT NULL, alias_key TEXT NOT NULL,
    candidate_high_water TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN('pending','processing','complete')),
    created_at TEXT NOT NULL
  )`,

  // --- runs + commands + health + validators + aliases + evidence ------
  `CREATE TABLE acquisition_runs_v2 (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES remote_sources_v2(id) ON DELETE RESTRICT,
    reason TEXT NOT NULL CHECK(reason IN('scheduled','administrator_refresh')),
    status TEXT NOT NULL CHECK(status IN('processing','terminal')),
    started_at TEXT NOT NULL, acquisition_committed_at TEXT, completed_at TEXT,
    outcome TEXT NOT NULL, counters_json TEXT NOT NULL, failure_category TEXT, diagnostic TEXT,
    -- nullable inert parse-time push-capability evidence (cutover spec §9): the
    -- JSON.stringify of choosePushTarget's {mode,endpoint,topic}, or NULL.
    -- Written inert by V2, validated only by Vertical 4, exposed by no projection.
    push_capability_json TEXT
  )`,
  `CREATE TABLE acquisition_commands_v2 (
    actor_id TEXT NOT NULL, command_id TEXT NOT NULL, request_fingerprint TEXT NOT NULL,
    run_id TEXT REFERENCES acquisition_runs_v2(id) ON DELETE RESTRICT,
    refusal_json TEXT, created_at TEXT NOT NULL, PRIMARY KEY(actor_id, command_id)
  )`,
  `CREATE TABLE source_health_v2 (
    source_id TEXT PRIMARY KEY REFERENCES remote_sources_v2(id) ON DELETE RESTRICT,
    last_poll_at TEXT, last_success_at TEXT, last_failure_at TEXT,
    consecutive_failures INTEGER NOT NULL
  )`,
  `CREATE TABLE source_validators_v2 (
    source_id TEXT NOT NULL REFERENCES remote_sources_v2(id) ON DELETE RESTRICT,
    effective_url TEXT NOT NULL, etag TEXT, last_modified TEXT,
    PRIMARY KEY(source_id, effective_url)
  )`,
  `CREATE TABLE source_aliases_v2 (
    url TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES remote_sources_v2(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE redirect_observations_v2 (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES acquisition_runs_v2(id) ON DELETE RESTRICT,
    ordinal INTEGER NOT NULL, status INTEGER, from_evidence TEXT NOT NULL, to_evidence TEXT NOT NULL,
    permanent_proof INTEGER NOT NULL CHECK(permanent_proof IN(0,1))
  )`,
  `CREATE TABLE acquisition_findings_v2 (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES acquisition_runs_v2(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL, evidence_json TEXT NOT NULL, created_at TEXT NOT NULL
  )`,

  // --- reconciliation jobs (verification-ready; V3 lockstep amendment 1) -
  `CREATE TABLE reconciliation_jobs_v2 (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'observation' CHECK(kind IN('observation','verification')),
    run_id TEXT REFERENCES acquisition_runs_v2(id) ON DELETE RESTRICT,
    observation_version_id TEXT UNIQUE REFERENCES observation_versions_v2(id) ON DELETE RESTRICT,
    verification_batch_key TEXT,
    status TEXT NOT NULL CHECK(status IN('pending','processing','retrying','reconciled','conflicted','failed')),
    attempts INTEGER NOT NULL, next_attempt_at TEXT NOT NULL,
    failure_category TEXT, diagnostic TEXT, created_at TEXT NOT NULL,
    CHECK((kind = 'observation') = (observation_version_id IS NOT NULL AND run_id IS NOT NULL)),
    CHECK((kind = 'verification') = (verification_batch_key IS NOT NULL))
  )`,

  // --- additive ALTER on the V1 source table (cutover spec §10.2) -------
  `ALTER TABLE remote_sources_v2 ADD COLUMN policy_generation INTEGER NOT NULL DEFAULT 0`,

  // --- indexes: timeline ordering + the V1 index-debt handoff -----------
  // ponytail: only the timeline ordering index ships; the other composites are
  // deferred until a real query measurably slows (plan Appendix A).
  `CREATE INDEX logical_items_v2_timeline ON logical_items_v2(timeline_sort_at DESC, id DESC)`,
  // V1's reapSourceIfOrphaned counts subscribers by source_id but the only
  // existing index is (owner_id,state,source_id) — a covering scan. (V1 handoff.)
  `CREATE INDEX source_subscriptions_v2_source ON source_subscriptions_v2(source_id)`,

  // --- inactive singletons ---------------------------------------------
  `INSERT INTO logical_activation_v2 (singleton, schema_version, state, last_activated_at, last_reconciled_at)
   VALUES (1, 1, 'never_activated', NULL, NULL)`,
  `INSERT INTO logical_journal_meta_v2 (singleton, high_water_seq, reset_generation)
   VALUES (1, 0, 0)`,
]

// Additive logical-v3 schema (moderation/events/verification, spec
// 2026-07-22-rsc-moderation-events-verification-design.md, plan Appendix A).
// ONE migration entry, appended strictly at the TAIL of MIGRATIONS in
// sqlite.ts, AFTER LOGICAL_V2_SCHEMA — mid-array insertion would renumber
// applied migrations and corrupt user_version on the live databases. Pure
// additive: two ALTER TABLE ADD COLUMN on logical_items_v2, seven CREATE
// TABLE, one CREATE INDEX. source_audit_v2 is untouched — no rebuild.
//
// item_audit_v2 defines its OWN nine-value category CHECK — never a mirror
// of the narrowed TS AuditCategory (domain/types.ts re-adds only
// 'false_positive'/'remediated'; 'migration_review' stays deferred to V4).
// A CHECK mirroring the six/eight-value TS enum would fail restore/unblock
// at runtime the moment they write a category the TS enum never carried
// before this widening. blocked_source_tombstones_v2 gets the same nine-wide
// CHECK for the same reason.
//
// Every FK defaults ON DELETE RESTRICT except tombstone_aliases_v2 (ON
// DELETE CASCADE — the alias row is meaningless once its tombstone is gone).
// Every INSERT names its columns explicitly.
export const LOGICAL_V3_SCHEMA: string[] = [
  `ALTER TABLE logical_items_v2 ADD COLUMN hidden_at TEXT`,
  `ALTER TABLE logical_items_v2 ADD COLUMN structural_tombstone INTEGER NOT NULL DEFAULT 0 CHECK(structural_tombstone IN(0,1))`,
  `CREATE TABLE item_audit_v2 (
    id TEXT PRIMARY KEY,
    logical_item_id TEXT NOT NULL REFERENCES logical_items_v2(id),
    command_id TEXT NOT NULL, actor_id TEXT,
    actor_kind TEXT NOT NULL CHECK(actor_kind IN('administrator','system')),
    action TEXT NOT NULL,
    category TEXT CHECK(category IS NULL OR category IN('spam','abuse','illegal_content','compromised_source','migration_review','operator_policy','false_positive','remediated','other')),
    note TEXT, result_json TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE policy_fanout_v2 (
    source_id TEXT PRIMARY KEY REFERENCES remote_sources_v2(id),
    generation INTEGER NOT NULL, last_item_cursor TEXT,
    state TEXT NOT NULL CHECK(state IN('pending','running','done','superseded')),
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE verification_checks_v2 (
    id TEXT PRIMARY KEY,
    logical_item_id TEXT NOT NULL REFERENCES logical_items_v2(id),
    source_id TEXT NOT NULL REFERENCES remote_sources_v2(id),
    publisher_feed_url TEXT NOT NULL, batch_key TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN('pending','verified','unverified')),
    created_at TEXT NOT NULL, resolved_at TEXT,
    UNIQUE(logical_item_id, publisher_feed_url)
  )`,
  `CREATE TABLE publisher_feed_aliases_v2 (
    url TEXT PRIMARY KEY,
    publisher_id TEXT NOT NULL REFERENCES remote_publishers_v2(id),
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE blocked_source_tombstones_v2 (
    id TEXT PRIMARY KEY, canonical_url TEXT NOT NULL UNIQUE,
    action TEXT NOT NULL CHECK(action IN('block','purge')),
    category TEXT NOT NULL CHECK(category IN('spam','abuse','illegal_content','compromised_source','migration_review','operator_policy','false_positive','remediated','other')),
    actor_id TEXT, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE tombstone_aliases_v2 (
    url TEXT PRIMARY KEY,
    tombstone_id TEXT NOT NULL REFERENCES blocked_source_tombstones_v2(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX item_audit_v2_page ON item_audit_v2(logical_item_id,created_at DESC,id DESC)`,
]

// Additive logical-v4 schema (migration & cutover, spec
// 2026-07-22-rsc-migration-cutover-design.md, plan Appendix A). ONE migration
// entry, appended strictly at the TAIL of MIGRATIONS in sqlite.ts, AFTER
// LOGICAL_V3_SCHEMA — mid-array insertion would renumber applied migrations and
// corrupt user_version on the live databases. Pure additive: two CREATE TABLE,
// one CREATE INDEX, three ALTER TABLE ADD COLUMN. No table is rebuilt.
//
// Three deliberate inversions of the house conventions, all pinned:
//  - push_subscriptions_v2.state is a NARROW two-value CHECK, not the usual
//    wide-SQL/narrow-TS split (spec WP1): the v2 push lifecycle collapses to
//    v1's shape, and migration-time expired/invalid facts become report
//    findings, never rows. A third value resurrects the deleted 4x4 matrix.
//  - push_subscriptions_v2.source_id is ON DELETE CASCADE (V3 §5.2: purge
//    deletes push state with the rest of the operational state), so it is NOT
//    a PURGE_INVENTORY entry — only non-CASCADE children of a purged row are.
//  - handle_reservations_v2 has NO foreign keys: the reservation must survive
//    source removal and purge (foundation §12).
//
// acquisition_runs_v2.reason keeps V2's two values — push provenance is the
// additive nullable delivery_mechanism column, not a new reason (FC1).
// The conversion marker extends V2's activation singleton instead of adding a
// table: converted_at IS NOT NULL is marker-present, conversion_findings_json
// holds the per-kind counts. (Dev reset: clear both columns.)
export const LOGICAL_V4_SCHEMA: string[] = [
  `CREATE TABLE push_subscriptions_v2 (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES remote_sources_v2(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK(mode IN('websub','rsscloud')),
    endpoint TEXT NOT NULL, topic TEXT NOT NULL,
    callback_token TEXT NOT NULL UNIQUE,
    secret TEXT,
    state TEXT NOT NULL CHECK(state IN('pending','active')),
    expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(source_id, mode)
  )`,
  `CREATE INDEX push_subscriptions_v2_expires ON push_subscriptions_v2(state, expires_at)`,
  `CREATE TABLE handle_reservations_v2 (
    handle TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    publisher_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `ALTER TABLE logical_activation_v2 ADD COLUMN converted_at TEXT`,
  `ALTER TABLE logical_activation_v2 ADD COLUMN conversion_findings_json TEXT`,
  `ALTER TABLE acquisition_runs_v2 ADD COLUMN delivery_mechanism TEXT`,
]
