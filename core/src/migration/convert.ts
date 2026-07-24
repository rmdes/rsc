import { randomUUID } from 'node:crypto'
import { normalizeSourceUrl } from '../domain/source-url.ts'
import { insertAudit } from '../storage/sqlite.ts'
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
    } else {
      // migration 11 backfilled every non-instance remote row to 'webfeed';
      // a NULL that predates it takes the same default.
      counts.default_webfeed++
    }

    // Same ID as the legacy user row (spec §3.1) — every existing /post/:id
    // and admin reference keeps resolving across cutover.
    tx.prepare(
      `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, policy_generation, created_at)
       VALUES (?, ?, ?, 'enabled', ?, 'migration', ?, 0, 0, ?)`,
    ).run(row.id, canonicalUrl, mode, governance, note, now)

    // A NEW publisher identity per source — never the recycled user id
    // (foundation §12). A single_publisher source anchors its publisher on its
    // own feed; an aggregate gets the source-scoped fallback, which by
    // definition has no feed anchor. Deliberately NOT reconcile.ts's private
    // getOrCreatePublisher: that one is find-or-create by feed URL and cannot
    // express the anchorless fallback.
    const publisherId = randomUUID()
    tx.prepare(
      `INSERT INTO remote_publishers_v2 (id, canonical_feed_url, identity_level, created_at) VALUES (?, ?, ?, ?)`,
    ).run(publisherId, mode === 'aggregate' ? null : canonicalUrl, mode === 'aggregate' ? 'source_scoped_fallback' : 'feed_anchored', now)

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

  return counts
}
