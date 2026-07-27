import { createHash, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { normalizeSourceUrl } from '../domain/source-url.ts'
import { isPrivateIp } from '../domain/push-guard.ts'
import { insertAudit } from '../storage/sqlite.ts'
import { normalizePermalink } from '../logical/roots.ts'
import { normalizeUtc, presentationFingerprint } from '../logical/projector.ts'
import { materializeLocalChain } from '../logical/local.ts'
import { EMPTY_COUNTERS } from '../logical/verification.ts'
import type { WriteTx } from '../logical/database.ts'
import type { AttributionMode } from '../domain/types.ts'
import type { Manifest } from './preflight.ts'

// V4 §3 — the one atomic legacy conversion. Part 1 (Task 5): sources,
// publishers, federation, follows, and permanent handle reservations. Tasks 6-7
// extend the SAME function with items/deliveries/ancestry/revisions and exact
// push preservation.
//
// CONTRACT (three halves of one rule): runConversion is pure SQL over the
// CALLER's write transaction. It opens no transaction, sends NO network request
// (no subscribe/unsubscribe/verify/fetch), and writes neither the conversion
// marker nor the journal reset — the runtime (Task 8) owns both, marker-guarded,
// in the same pre-listen activation transaction. A throw anywhere in here (or
// after it, before the caller commits) rolls the whole conversion back and
// leaves the database legacy-intact.
//
// Preflight (Task 4) runs immediately before and aborts startup on ANY finding,
// so its guarantees are relied on and never re-checked here: every remote
// feed_url normalizes cleanly, no two normalize alike, no legacy handle is
// already reserved, no legacy URL already exists as a converted source, and any
// manifest is shape-valid and entry-consistent.
//
// Zero-row conversion is the same code path, not a special case (spec §3).

export type ConversionFindingKind =
  | 'default_person' | 'default_webfeed' | 'instance_quarantined' | 'manifest_approved'
  | 'attribution_conflict' | 'unresolved_reference' | 'permalink_collision' | 'guid_collision'
  | 'push_preserved' | 'push_expired' | 'push_invalid' | 'over_cap_grandfathered'

export type ConversionCounts = Record<ConversionFindingKind, number>

// Counts ARE the report: there is no findings relation and no report route
// (spec §3.6, WP2), so every kind the conversion can produce is initialized
// here and the caller stores the whole record in the marker. Tasks 6-7 fill
// the kinds they own; a kind nobody emits stays a truthful 0.
function zeroCounts(): ConversionCounts {
  return {
    default_person: 0, default_webfeed: 0, instance_quarantined: 0, manifest_approved: 0,
    attribution_conflict: 0, unresolved_reference: 0, permalink_collision: 0, guid_collision: 0,
    push_preserved: 0, push_expired: 0, push_invalid: 0, over_cap_grandfathered: 0,
  }
}

interface LegacyRemote { id: string; handle: string; feed_url: string; feed_type: string | null }
interface ConvertedSource { publisherId: string; mode: AttributionMode; canonicalUrl: string }

interface LegacyPush {
  id: string; user_id: string; mode: string; endpoint: string; topic: string
  callback_token: string; secret: string | null; state: string
  expires_at: string; created_at: string
}

// The endpoint revalidation of spec §3.4, and a DELIBERATE narrowing of the
// plan's "checkCallbackUrl on the endpoint": that function is ASYNC because it
// resolves DNS, and runConversion is synchronous, transaction-bound and
// network-free by contract. This is therefore checkCallbackUrl's synchronous
// prefix (push-guard.ts:56-69) — for the SAME REASON verification.ts's
// normalizeVerificationUrl is narrowed (a gate running inside a write
// transaction cannot do DNS), but NOT with the same SAFETY NET.
// normalizeVerificationUrl's narrowing is BACKSTOPPED downstream: its own
// comment (verification.ts:32-35) names checkFetchHop as the authoritative
// guard, re-resolving DNS on the initial URL and every redirect hop inside
// fetchBounded, so a stored verification URL is never trusted. The push
// endpoint has NO equivalent backstop — renewDue (push.ts:228, :230) POSTs
// straight to the stored row.endpoint with zero revalidation, ever. See the
// dated plan-correction note.
//
// The DNS half is deferred, not lost: every legacy row passed the FULL gate at
// v1 registration time (v1's deleted push-in.ts). The residual this leaves — a
// converted row whose endpoint later resolves to a private address is
// blind-POSTed by renewDue — is real, but not a regression: it is exactly the
// "host does not resolve" / "any resolved address is private" pair
// checkCallbackUrl would also catch (push-guard.ts:70-77), and v1's own
// renewal sweep POSTed to the same drifted rows without re-resolving either
// (push-guard.ts:54-55). Ledgered in docs/superpowers/ideas.md.
// isIP guards isPrivateIp exactly as checkCallbackUrl does, so a hostname that
// merely starts with fc/fd/fe8 is not mistaken for an IPv6 private prefix.
function publicEndpoint(raw: string): boolean {
  let url: URL
  try { url = new URL(raw) } catch { return false }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.replace(/^\[|\]$/g, '') // strip IPv6 brackets
  if (host === 'localhost' || host.endsWith('.localhost')) return false
  return !(isIP(host) && isPrivateIp(host))
}

interface LegacyPost {
  id: string; author_id: string; guid: string; title: string | null; content: string
  url: string | null; published_at: string; created_at: string
  in_reply_to: string | null; in_reply_to_post_id: string | null
  source_name: string | null; source_feed_url: string | null
  content_markdown: string | null; edited_at: string | null
  reply_context_author: string | null; reply_context_snippet: string | null
}

// THE DELIVERY KEY A CONVERTED POST MUST CARRY
// ============================================================================
// THE PRINCIPLE (2026-07-24, replaces the earlier "never write fallback" rule,
// which the reviewer-run matrix falsified — it came from the implementer's
// BLOCKED escalation, a stop-and-report that was correct). Conversion writes
// the identity-key KIND the first poll will re-derive. Where that kind is
// `fallback` — a LINK-LESS item, whose poll itself derives `fallback`, and onto
// whose `fallback` delivery an `opaque`/`permalink` delivery does NOT converge
// (reconcile gives a fallback delivery no identity key at all) — conversion must
// reproduce the EXACT fallback key. Convergence there requires the poll's
// derivation to be deterministic from stored data: true for RSS (one hash of the
// material = the stored guid) and made true for h-feed by F1 (un-double-hash) in
// acquisition.ts.
//
// V1 stored ONE identifier per item, `posts.guid` = `guid ?? url ??
// fallbackGuid(title, content, rawDate)` (ingest.ts toParsedItem). v2 acquisition
// derives THREE kinds from the same wire item (acquisition.ts parseCandidates):
// the exact opaque id, else the normalized permalink, else `'fallback:' +
// sha256(title \0 content \0 rawDate)`. A delivery is looked up by (source_id,
// key_kind, key), so conversion writes per stored row:
//  - `url` null — the fallback branch: `'fallback:' + guid` (v1 fallbackGuid and
//    v2 fallbackKey hash identical material, so the stored guid IS the hash — the
//    64-hex shape, up to a real guid of 64 lowercase hex digits). Reproduced
//    exactly, per the principle: a mismatch here is a permanent DUPLICATE ITEM.
//  - `url` non-null — `opaque` = the guid. A link-bearing item's poll derives
//    `opaque` (a present <guid>/id) OR `permalink` (a synthesized guid == link);
//    conversion cannot tell a real <guid>==<link> from a link-synthesized guid,
//    and keys `opaque` for BOTH. On the rss.chat shape (a present <guid> equal to
//    the url, no <link>) this MATCHES the poll's opaque exactly — the interop
//    case, kept exact. On a link-synthesized-guid item it costs one extra
//    (benign) permalink delivery the poll adds, since conversion ALSO claims the
//    `permalink` identity key (below) so that delivery converges onto the SAME
//    item. 143a6a5 routed `guid == url` to `permalink` and thereby forked the
//    extra delivery onto the rss.chat shape instead; reverted here.
//
// THE RESIDUAL, AND WHY IT IS BOUNDED. On `url` non-null, conversion ALSO claims
// `permalink` = normalized url AND `opaque:publisher:<publisherId>` = the guid
// (below), so whichever kind the poll derives resolves onto the converted item
// through one of those keys: the cost is at most one extra delivery, NEVER a
// second item. The `url` null branch has no such backstop, which is why its key
// must be reproduced exactly.
const FALLBACK_HASH = /^[0-9a-f]{64}$/

function deliveryKeyFor(post: LegacyPost): { kind: 'opaque' | 'permalink' | 'fallback'; key: string } {
  // url null → the fallback branch, reproduced exactly (no opaque/permalink
  // backstop converges onto a poll's fallback delivery).
  if (post.url === null && FALLBACK_HASH.test(post.guid)) return { kind: 'fallback', key: `fallback:${post.guid}` }
  // url non-null → opaque = guid. `guid == url` (rss.chat, or a link-synthesized
  // guid) keys opaque too: the poll's opaque matches on the rss.chat shape, and
  // the permalink identity key conversion claims catches the synthesized case.
  return { kind: 'opaque', key: post.guid }
}

// ============================================================================
// THE SYNTHETIC OBSERVATION EVIDENCE CONTRACT (spec §3.2, adjudication FC2)
// ============================================================================
// A converted post has no fetched feed document behind it, so its observation
// evidence is BUILT from the legacy row's own fields and wrapped in a marked
// envelope: `synthetic: 'migration'` is the FIRST key of canonical_material,
// raw_evidence_json and normalized_json alike. Nothing here fabricates a feed
// document, a wire body, or a publisher assertion the legacy row did not carry.
//
// WHY INTEGRITY HOLDS — converted evidence can never masquerade as fetched
// proof, because nothing treats stored evidence as proof of anything:
//  - reconciliation reads `normalized_json` for identity/ancestry/presentation
//    material, and that JSON IS the correct converted content — it is the
//    payload, never the warrant;
//  - origin verification (V3 §7.1) proves attribution by FETCHING the live
//    publisher feed URL and matching containment there; it never re-reads
//    stored evidence. A converted item's claimed origin therefore has to be
//    re-earned against the live web exactly like an acquired item's;
//  - the `synthetic` marker means any future reader that DOES want to
//    distinguish provenance can, without re-deriving this argument.
//
// The synthetic values, chosen deliberately (plan Task 6 Step 1a):
//  - `wire_ordinal` = the presentation sequence: 0 for the ordinary
//    single-version post (the pinned value), 0..n when legacy revisions make
//    the chain deeper. The first-arrival tuple is
//    (committed_at, run_id, wire_ordinal, version_id) and every migration
//    version of a source shares the first two, so the ordinal is the ONLY
//    component that can order a delivery's revisions deterministically —
//    leaving them all 0 would fall through to random UUID order.
//  - `seen_count` = 1 and `last_seen_run_id` = the migration run: conversion
//    observes each version exactly once. A legacy revision whose material
//    repeats an earlier one is skipped entirely (live acquisition likewise
//    creates no second version for identical material); the legacy tables
//    never recorded re-appearances, so the count stays a truthful 1.
//  - `last_seen_at` = the conversion timestamp (when this evidence was
//    written); `arrival_at` = the legacy `created_at` (when the item actually
//    arrived), so the durable arrival fact is preserved, not overwritten.
//
// THE SYNTHETIC RUN. `observation_versions_v2.run_id` carries no FK, but every
// comparator and the whole ordinary projection JOIN through
// `acquisition_runs_v2` for the arrival tuple, and `reconciliation_jobs_v2`
// (which DOES have an FK to it) gates ordinary eligibility. So conversion
// writes ONE terminal run per source that has posts, plus one 'reconciled'
// observation job per version — exactly V3's persistVerifiedDelivery pattern
// (verification.ts), the established house precedent for durable evidence that
// no drain produced. Because a run belongs to ONE source, the pinned literal
// `run_id = 'migration'` is per-source `migration:<sourceId>`: still marked,
// still recognizable, and now JOIN-able. See the dated plan-correction note.
const SYNTHETIC = 'migration'

export function runConversion(tx: WriteTx, input: { manifest: Manifest | null; now: string; log: (line: string) => void }): ConversionCounts {
  const { manifest, now, log } = input
  const counts = zeroCounts()
  // One synthetic command for every audit row this conversion writes — there is
  // no ledger command behind it (conversion is not a request), and the actor is
  // the system, so actor_id stays NULL.
  const command = { commandId: `migration:${randomUUID()}`, actorId: null }

  const rows = tx.prepare(
    `SELECT id, handle, feed_url, feed_type FROM users WHERE kind = 'remote' ORDER BY id`,
  ).all() as LegacyRemote[]
  const approvals = new Map((manifest?.entries ?? []).map((e) => [e.sourceId, e]))
  // feed_type per converted source id — the follow rule below keys off the
  // LEGACY kind, not the resulting attribution mode (a manifest-approved
  // instance is still an instance follow).
  const wasInstance = new Set<string>()
  // what the item pass (below) needs about each converted source
  const converted = new Map<string, ConvertedSource>()

  for (const row of rows) {
    const canonicalUrl = normalizeSourceUrl(row.feed_url)
    let mode: AttributionMode = 'single_publisher'
    let governance: 'allowed' | 'quarantined' = 'allowed'
    let note: string | null = null
    let federation: 'pending' | 'approved' | null = null

    if (row.feed_type === 'instance') {
      wasInstance.add(row.id)
      const entry = approvals.get(row.id)
      if (entry) {
        // PRECEDENCE: the manifest is the operator's explicit, reviewed
        // decision, so it wins over the aggregate the data implies. A
        // disagreement is COUNTED rather than silently resolved (spec §3.6).
        mode = entry.attributionMode
        note = entry.note
        federation = 'approved'
        counts.manifest_approved++
        if (mode !== 'aggregate') {
          counts.attribution_conflict++
          log(`attribution_conflict: manifest approves ${row.id} (@${row.handle}) as ${mode}; the legacy instance implies aggregate — manifest wins`)
        }
        log(`manifest_approved: ${row.id} (@${row.handle}) -> ${mode}, allowed + federation approved`)
      } else {
        mode = 'aggregate'
        governance = 'quarantined'
        federation = 'pending'
        counts.instance_quarantined++
        log(`instance_quarantined: ${row.id} (@${row.handle}) -> aggregate, quarantined + federation pending`)
      }
    } else if (row.feed_type === 'person') {
      counts.default_person++
      log(`default_person: ${row.id} (@${row.handle}) -> single_publisher, allowed`)
    } else {
      // migration 11 backfilled every non-instance remote row to 'webfeed';
      // a NULL that predates it takes the same default.
      counts.default_webfeed++
      log(`default_webfeed: ${row.id} (@${row.handle}) -> single_publisher, allowed`)
    }

    // Same ID as the legacy user row (spec §3.1) — every existing /post/:id
    // and admin reference keeps resolving across cutover.
    tx.prepare(
      `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, policy_generation, created_at)
       VALUES (?, ?, ?, 'enabled', ?, 'migration', ?, 0, 0, ?)`,
    ).run(row.id, canonicalUrl, mode, governance, note, now)

    // A NEW publisher identity per source — never the recycled user id
    // (foundation §12) — minted EXACTLY as reconcile.ts's getOrCreatePublisher
    // mints one: keyed on canonical_feed_url alone, identity_level
    // 'feed_anchored', for aggregates too.
    //
    // ADJUDICATED 2026-07-24 (spec §3.2 dated note). §3.2 asks for
    // 'source_scoped_fallback' on aggregates, but §3.6 gives a publisher page
    // only to feed-anchored publishers, and projector.ts's resolvePublisher
    // implements §3.6 faithfully — so a fallback row is one no reader will
    // serve, and §3.5's PERMANENT /u/:handle -> /p/:publisherId redirect would
    // point at a 404. §3.6 governs, because it is what every reader depends on.
    // Keying identically also means the first post-cutover reconcile FINDS this
    // row instead of minting a second identity beside it and forking the items.
    // V4 preserves; it does not reform live publisher semantics — §2.4
    // attribution stays recorded, accepted debt, and now inherits a single
    // uniform population to migrate rather than two regimes to reconcile.
    const publisherId = randomUUID()
    tx.prepare(
      `INSERT INTO remote_publishers_v2 (id, canonical_feed_url, identity_level, created_at) VALUES (?, ?, 'feed_anchored', ?)`,
    ).run(publisherId, canonicalUrl, now)
    converted.set(row.id, { publisherId, mode, canonicalUrl })

    if (federation) {
      tx.prepare(
        `INSERT INTO federation_relationships_v2 (source_id, status, provenance_note, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(row.id, federation, note, now, now)
    }

    // The permanent impersonation guard (spec §3.5). NO foreign keys by design:
    // the reservation outlives source removal and purge.
    tx.prepare(
      `INSERT INTO handle_reservations_v2 (handle, source_id, publisher_id, created_at) VALUES (?, ?, ?, ?)`,
    ).run(row.handle, row.id, publisherId, now)

    // One system-actor migration_review audit row for each source whose outcome
    // is NOT the plain allowed default — the quarantined instances and the
    // manifest approvals (spec §3.1). This is migration_review's first emitter.
    // ponytail: audit the governance-bearing outcomes; the finding counts carry
    // the bulk (person/webfeed defaults are counts only).
    if (federation) {
      insertAudit(tx, {
        sourceId: row.id, command, actorKind: 'system',
        action: federation === 'approved' ? 'migration_approve' : 'migration_quarantine',
        category: 'migration_review', note,
        result: { canonicalUrl, attributionMode: mode, governance, federation }, now,
      })
    }
  }

  // --- follows -----------------------------------------------------------
  // local -> local follows are preserved unchanged: they stay in `follows` and
  // this loop never sees them. Legacy rows are never deleted or rewritten
  // (upheld decision #4 — `posts`/`follows` stay the legacy authority, inert).
  const remoteFollows = tx.prepare(
    `SELECT f.follower_id AS owner_id, f.followed_id AS source_id FROM follows f
     JOIN users owner ON owner.id = f.follower_id
     JOIN users target ON target.id = f.followed_id
     WHERE owner.kind = 'local' AND target.kind = 'remote'
     ORDER BY f.follower_id, f.followed_id`,
  ).all() as { owner_id: string; source_id: string }[]

  const perOwner = new Map<string, number>()
  for (const f of remoteFollows) {
    // Every legacy INSTANCE follow becomes pending_review regardless of whether
    // the source was approved: it counts toward the cap and stays removable,
    // but exposes no Personal content until explicitly reviewed (foundation §12).
    const state = wasInstance.has(f.source_id) ? 'pending_review' : 'active'
    tx.prepare(
      `INSERT INTO source_subscriptions_v2 (id, owner_id, source_id, state, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(randomUUID(), f.owner_id, f.source_id, state, now)
    perOwner.set(f.owner_id, (perOwner.get(f.owner_id) ?? 0) + 1)
  }

  // Over-cap users are GRANDFATHERED: every existing follow converts. The cap
  // is not re-applied here — the ordinary `n >= cap` check in
  // resolveAndSubscribeSource/importSourceSubscriptions then refuses any NEW
  // subscription until the user is back under it, with no extra code.
  const capRow = tx.prepare(`SELECT value FROM instance_settings WHERE key = 'max_subs_per_user'`).get() as { value: string } | undefined
  const cap = Number(capRow?.value ?? '500')
  for (const [ownerId, n] of perOwner) {
    if (n > cap) {
      counts.over_cap_grandfathered++
      log(`over_cap_grandfathered: ${ownerId} keeps ${n} subscriptions over the cap of ${cap}; no new subscription until back under it`)
    }
  }

  // --- push leases (spec §3.4) ---------------------------------------------
  // Exact preservation is what lets a hub's in-flight lease keep delivering
  // across cutover with NO re-subscription: protocol, endpoint, topic, callback
  // token, secret, state, expiry and creation time convert byte-for-byte onto
  // the same-ID source, so the next fat ping — signed with the legacy secret and
  // addressed to the legacy callback token — authenticates against the converted
  // row and takes the ordinary acquisition path. The legacy row id is kept too:
  // nothing outside this table references it, and it keeps the converted row
  // traceable to the legacy one for free.
  //
  // THE WP1 PIN. `push_subscriptions_v2.state` is a two-value CHECK, and the
  // legacy table has NO CHECK on state or mode (sqlite.ts:1291-1303), so a
  // legacy row may hold values v2 refuses. Such a row — like an expired one, a
  // revalidation-failing one, or one whose user did not convert — becomes a
  // COUNTED, LOGGED finding and NO row. That is the whole point of the narrow
  // CHECK: migration cannot resurrect a dead lease as a re-attemptable row. The
  // durable fact is the latest run's capability claim, so the first post-cutover
  // poll pass simply re-registers (spec §1.2) and mints fresh token/secret.
  //
  // CONTINUITY CEILING (recorded honestly): preservation holds for a lease that
  // is LIVE at conversion, not indefinitely afterwards. v1 never purged this
  // table — purgeExpiredSubscriptions (sqlite.ts:602-604, v1's deleted push-in.ts) deletes
  // from the OUTBOUND `subscriptions` table — so under v1 R1 token/secret reuse
  // was permanent. Under v2, spec §1.2 mandates purging expired push rows every
  // poll cycle, so after a lapse the row is gone and re-registration generates
  // fresh material. Consequence to know: a hub verification arriving more than
  // PENDING_TTL_MS (10 min) after registration now 404s and self-heals on the
  // next poll pass. Conversion neither causes nor can compensate for that.
  const legacyPush = tx.prepare(
    `SELECT id, user_id, mode, endpoint, topic, callback_token, secret, state, expires_at, created_at
     FROM push_subscriptions ORDER BY user_id, mode`,
  ).all() as LegacyPush[]
  const insertPush = tx.prepare(
    `INSERT INTO push_subscriptions_v2 (id, source_id, mode, endpoint, topic, callback_token, secret, state, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const p of legacyPush) {
    const drop = (finding: 'push_expired' | 'push_invalid', why: string): void => {
      counts[finding]++
      log(`${finding}: ${p.mode} lease for ${p.user_id} (${p.topic}) dropped — ${why}; the poll pass re-registers if the source still advertises the capability`)
    }
    if (!converted.has(p.user_id)) { drop('push_invalid', 'its user is not a converted remote source'); continue }
    // Expiry first: it is the dominant and most benign explanation, and a row
    // that is both lapsed and unusable must be counted exactly once.
    if (p.expires_at <= now) { drop('push_expired', `the lease expired at ${p.expires_at}`); continue }
    if (p.mode !== 'websub' && p.mode !== 'rsscloud') { drop('push_invalid', `unknown protocol ${JSON.stringify(p.mode)}`); continue }
    if (p.state !== 'pending' && p.state !== 'active') { drop('push_invalid', `legacy state ${JSON.stringify(p.state)} has no live v2 equivalent`); continue }
    if (!publicEndpoint(p.endpoint)) { drop('push_invalid', `endpoint ${JSON.stringify(p.endpoint)} fails revalidation`); continue }

    insertPush.run(p.id, p.user_id, p.mode, p.endpoint, p.topic, p.callback_token, p.secret, p.state, p.expires_at, p.created_at)
    counts.push_preserved++
    log(`push_preserved: ${p.mode} lease for ${p.user_id} (${p.topic}) kept ${p.state} until ${p.expires_at}; callback token and secret unchanged`)
  }

  // --- items, deliveries, presentation, ancestry ---------------------------
  // Legacy remote posts become logical items with the SAME post id (spec §3.2),
  // so every pre-cutover /post/:id keeps resolving. TWO passes: every item row
  // exists before any ancestry edge is written, so a reply converted ahead of
  // its parent still finds it (parent_logical_item_id is RESTRICT).
  const legacyPosts = tx.prepare(
    `SELECT id, author_id, guid, title, content, url, published_at, created_at,
            in_reply_to, in_reply_to_post_id, source_name, source_feed_url,
            content_markdown, edited_at, reply_context_author, reply_context_snippet
     FROM posts WHERE source = 'remote' ORDER BY published_at, id`,
  ).all() as LegacyPost[]

  const insertRun = tx.prepare(
    `INSERT INTO acquisition_runs_v2 (id, source_id, reason, status, started_at, acquisition_committed_at, completed_at, outcome, counters_json, failure_category, diagnostic, push_capability_json, delivery_mechanism)
     VALUES (?, ?, 'scheduled', 'terminal', ?, ?, ?, 'parsed', ?, NULL, NULL, NULL, NULL)`,
  )
  const insertDelivery = tx.prepare(
    `INSERT INTO deliveries_v2 (id, source_id, key_kind, key, first_seen_at, last_seen_at, last_seen_run_id, seen_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
  )
  const insertItem = tx.prepare(
    `INSERT INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, created_at)
     VALUES (?, 'remote', ?, 'none', NULL, ?, ?, ?)`,
  )
  const insertVersion = tx.prepare(
    `INSERT INTO observation_versions_v2 (id, delivery_id, fingerprint_version, fingerprint, canonical_material, arrival_at, run_id, wire_ordinal, last_seen_at, last_seen_run_id, seen_count, raw_evidence_json, normalized_json)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  )
  const insertJob = tx.prepare(
    `INSERT INTO reconciliation_jobs_v2 (id, kind, run_id, observation_version_id, verification_batch_key, status, attempts, next_attempt_at, failure_category, diagnostic, created_at)
     VALUES (?, 'observation', ?, ?, NULL, 'reconciled', 0, ?, NULL, NULL, ?)`,
  )
  const insertEntry = tx.prepare(
    `INSERT INTO presentation_entries_v2 (delivery_id, sequence, observation_version_id, effective_updated_at, provenance, material_fingerprint)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  const insertClaim = tx.prepare(
    `INSERT INTO publisher_claims_v2 (id, logical_item_id, publisher_id, source_id, observation_version_id, evidence_level, first_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertConflict = tx.prepare(
    `INSERT INTO logical_conflicts_v2 (id, logical_item_id, observation_version_id, kind, evidence_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  )
  const keyOwner = tx.prepare(`SELECT logical_item_id FROM logical_identity_keys_v2 WHERE kind = ? AND key = ?`)
  const insertKey = tx.prepare(`INSERT INTO logical_identity_keys_v2 (kind, key, logical_item_id) VALUES (?, ?, ?)`)
  const revisionsOf = tx.prepare(`SELECT title, content, content_markdown, seen_at FROM post_revisions WHERE post_id = ? ORDER BY seen_at, id`)

  // Historical items are NEVER merged (spec §3.2): a contested key is left with
  // its first owner, both items are kept, and the collision is counted.
  const claimKey = (kind: string, key: string, itemId: string, finding: 'permalink_collision' | 'guid_collision'): void => {
    const owner = keyOwner.get(kind, key) as { logical_item_id: string } | undefined
    if (!owner) { insertKey.run(kind, key, itemId); return }
    if (owner.logical_item_id === itemId) return
    counts[finding]++
    log(`${finding}: ${itemId} and ${owner.logical_item_id} both claim ${kind} ${key}; both kept, neither merged`)
  }

  const runs = new Set<string>()
  const convertedItems = new Set<string>()

  for (const post of legacyPosts) {
    const src = converted.get(post.author_id)
    // ponytail: a remote post whose author is not a converted remote user is a
    // legacy anomaly with nothing to attach to — skipped, not crashed.
    if (!src) continue
    convertedItems.add(post.id)

    const runId = `${SYNTHETIC}:${post.author_id}`
    if (!runs.has(runId)) { insertRun.run(runId, post.author_id, now, now, now, EMPTY_COUNTERS); runs.add(runId) }

    // The delivery key the first post-cutover poll will re-derive for this same
    // wire item — per V1 branch, see THE DELIVERY KEY A CONVERTED POST MUST
    // CARRY above. Getting it right is what lets that poll FIND this delivery
    // instead of forking a second one beside it.
    const deliveryKey = deliveryKeyFor(post)
    const deliveryId = randomUUID()
    insertDelivery.run(deliveryId, post.author_id, deliveryKey.kind, deliveryKey.key, post.created_at, now, runId)

    // timeline_sort_at preserves the legacy publication instant exactly (spec
    // §3.2): V1 already ordered the timeline by it, so preserving it is what
    // keeps the timeline looking identical across cutover.
    const timelineSortAt = normalizeUtc(post.published_at) ?? normalizeUtc(post.created_at) ?? now
    insertItem.run(post.id, timelineSortAt, deliveryId, src.publisherId, now)

    const permalink = normalizePermalink(post.url)
    insertKey.run('delivery', deliveryId, post.id)
    if (permalink) claimKey('permalink', permalink, post.id, 'permalink_collision')
    claimKey(`opaque:publisher:${src.publisherId}`, post.guid, post.id, 'guid_collision')

    // Per-item attribution. An aggregate is EXPECTED to carry it, and the
    // claimed origin is retained in normalized_json so V3 verification can
    // fetch it live; a BOUND single-publisher source asserting a different
    // origin feed is the conflict (spec §3.2). Names are not identity —
    // publishers are feed-anchored — so a bare source_name is evidence only.
    const perItemUrl = post.source_feed_url && /^https?:\/\//i.test(post.source_feed_url) ? post.source_feed_url : null
    if (src.mode === 'single_publisher' && perItemUrl) {
      let normalizedPerItem: string | null = null
      try { normalizedPerItem = normalizeSourceUrl(perItemUrl) } catch { normalizedPerItem = null }
      if (normalizedPerItem !== src.canonicalUrl) {
        counts.attribution_conflict++
        insertConflict.run(randomUUID(), post.id, null, 'attribution_conflict', JSON.stringify({ sourceId: post.author_id, boundUrl: src.canonicalUrl, claimedUrl: perItemUrl, claimedName: post.source_name }), now)
        log(`attribution_conflict: ${post.id} claims origin ${perItemUrl} on bound source ${post.author_id} (${src.canonicalUrl}); the bound publisher wins`)
      }
    }

    // The accepted presentation chain: legacy revisions oldest-first, then the
    // post's CURRENT state (post_revisions holds superseded snapshots, and
    // seen_at is the moment each was superseded — sqlite.ts recordEdit).
    const revisions = revisionsOf.all(post.id) as { title: string | null; content: string; content_markdown: string | null; seen_at: string }[]
    const steps = [
      ...revisions.map((r) => ({ title: r.title, content: r.content, contentMarkdown: r.content_markdown, updated: r.seen_at })),
      { title: post.title, content: post.content, contentMarkdown: post.content_markdown, updated: post.edited_at },
    ]

    let sequence = 0
    let baselineVersionId: string | null = null
    const seenFingerprints = new Set<string>()
    for (const step of steps) {
      const material = {
        synthetic: SYNTHETIC, v: 1, keyKind: deliveryKey.kind, key: deliveryKey.key,
        title: step.title, content: step.content, link: post.url,
        published: post.published_at, updated: step.updated, inReplyTo: post.in_reply_to, enclosures: [],
      }
      const canonicalMaterial = Buffer.from(JSON.stringify(material), 'utf8')
      const fingerprint = createHash('sha256').update(canonicalMaterial).digest('hex')
      // Repeated material creates no second version — the UNIQUE(delivery_id,
      // fingerprint_version, fingerprint) rule live acquisition obeys too.
      if (seenFingerprints.has(fingerprint)) continue
      seenFingerprints.add(fingerprint)

      const normalized = {
        synthetic: SYNTHETIC, keyKind: deliveryKey.kind, key: deliveryKey.key,
        permalink, inReplyTo: post.in_reply_to, enclosures: [], originFeedUrl: perItemUrl,
        // Retained legacy detail the v2 remote projection has no field for yet
        // (contentMarkdown is remote-null in V2, reply context is URL-only) —
        // preserved here so conversion loses nothing.
        contentMarkdown: step.contentMarkdown,
        replyContext: { author: post.reply_context_author, snippet: post.reply_context_snippet },
      }
      const rawEvidence = {
        synthetic: SYNTHETIC, title: step.title, sourceName: post.source_name,
        link: post.url, published: post.published_at, updated: step.updated, enclosureCount: 0,
      }
      const versionId = randomUUID()
      insertVersion.run(versionId, deliveryId, fingerprint, canonicalMaterial, post.created_at, runId, sequence, now, runId, JSON.stringify(rawEvidence), JSON.stringify(normalized))
      insertJob.run(randomUUID(), runId, versionId, now, now)
      // provenance legacy_unknown (spec §3.2, V2 rev 6's widened CHECK): a
      // legacy timestamp is NOT an authoritative explicit watermark, and the
      // watermark query reads provenance = 'explicit' only — so a converted
      // chain leaves the watermark unset and the first post-cutover explicit
      // update starts it fresh.
      insertEntry.run(deliveryId, sequence, versionId, normalizeUtc(step.updated), step.updated ? 'legacy_unknown' : null, presentationFingerprint({
        title: step.title, content: step.content, contentMarkdown: null,
        permalink, sourceLink: post.url, enclosures: [], inReplyTo: post.in_reply_to,
      }))
      baselineVersionId ??= versionId
      sequence++
    }

    // One claim on the SOURCE's converted publisher (2026-07-24 adjudication):
    // the same identity a post-cutover reconcile resolves, so nothing forks.
    insertClaim.run(randomUUID(), post.id, src.publisherId, post.author_id, baselineVersionId, src.mode === 'aggregate' ? 'aggregate_assertion' : 'bound_single_publisher', now)
  }

  // Ancestry (spec §3.2): a resolved legacy edge copies AS-IS — V2 §4.1 permits
  // preserving it without recreating the retired global-uniqueness fallback, so
  // no depth/cycle re-derivation is done here. Only a direct self-edge (pid ===
  // post.id) is guarded below; V1's adoptOrphans (sqlite.ts:465-494) can also
  // leave a longer cycle in place (p1 orphan-references p2's URL, p2 resolves
  // onto p1, then adopts p1) that conversion copies verbatim. Nothing hangs —
  // logicalDepth/deriveRoot/remoteThreadRoot/projectThread are all
  // walk-bounded — but logicalDepth then returns the walk bound, so a NEW
  // reply posted under such an item resolves permanently as
  // ambiguous('excessive_depth'). Rare, bounded, and out of scope to detect.
  // Everything else — a reference legacy ingest never resolved, a parent since
  // deleted, a self-edge — converts to `missing` with its bounded asserted
  // context (canonical_material.inReplyTo, which the projector renders as the
  // asserted external reply context) and is COUNTED.
  //
  // Known carry (V2): a `missing` converted reply is not enqueued for orphan
  // adoption — a reference legacy ingest never resolved converges going forward
  // only, exactly as V2 already behaves. A legacy edge v1 DID resolve converts
  // here in both directions, local parent and local child alike (the cutover's
  // materialization pass, which runs after this, carries the local-child half).
  for (const post of legacyPosts) {
    if (!convertedItems.has(post.id)) continue
    if (!post.in_reply_to && !post.in_reply_to_post_id) continue

    let parent: string | null = null
    const pid = post.in_reply_to_post_id
    if (pid && pid !== post.id) {
      // V2 §2.6's explicit-backfill site: the local bridge row must exist for the
      // edge endpoint to be referenceable. materializeLocalChain backfills the
      // parent AND its own local ancestors, so a local parent that is itself a
      // reply is referenceable too, and a chain that cannot be materialized says
      // so instead of FK-violating.
      if (convertedItems.has(pid) || materializeLocalChain(tx, pid)) parent = pid
    }
    if (parent) {
      tx.prepare(`UPDATE logical_items_v2 SET parent_state = 'resolved', parent_logical_item_id = ? WHERE id = ?`).run(parent, post.id)
    } else {
      tx.prepare(`UPDATE logical_items_v2 SET parent_state = 'missing' WHERE id = ?`).run(post.id)
      counts.unresolved_reference++
      log(`unresolved_reference: ${post.id} references ${JSON.stringify(pid ?? post.in_reply_to)}, which is not a convertible parent; converted as missing`)
    }
  }

  return counts
}
