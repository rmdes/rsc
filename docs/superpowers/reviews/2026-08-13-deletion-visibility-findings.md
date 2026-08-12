# Deletion and visibility — findings

**Date:** 2026-08-13 · **Observed at HEAD `653b5e9`** · **Status:** open, unfixed

A point-in-time record, not a convention. Every claim below was read from source
on the date above; line numbers drift, so re-open before relying on one. If you
fix one of these, mark it here rather than deleting the entry — the reasoning is
worth more than a clean file.

Surfaced while designing delete propagation across federation
(spec written, then reverted in `6782d88` — it rested on unverified claims).
These four survived verification and stand independently of that milestone.

---

## 1. `replyCounts` and the renderer use different visibility predicates

Counts are wrong in **both directions today**, with no federation involved.

- **Rendering** gates on `ORDINARY_ITEM_VISIBLE_SQL` =
  `li.hidden_at IS NULL AND li.structural_tombstone = 0`
  (`core/src/logical/projector.ts:368`).
- **Counting** uses `nodeVisible` → `remoteVisible` =
  `eligibleDeliveries(tx, itemId).length > 0` (`:456-458`), which **never checks
  `hidden_at` or `structural_tombstone`**.
- `replyCounts` (`:486-505`) runs `if (!nodeVisible(tx, cid)) continue` *before*
  pushing children, so an invisible node **drops its entire subtree** from the
  count.

Consequences: a deleted local post (no `posts` row → `nodeVisible` false)
under-counts *and* swallows live replies beneath it — a card can read "0 replies"
above a thread that visibly shows two. A hidden remote item does the opposite: it
renders as a placeholder but still counts.

Plausible fix, unverified: count a node only when the renderer would show it, but
**always descend into its children regardless**. That is one change addressing
both directions.

## 2. `itemOrdinaryVisible` ignores `hidden_at`

`itemOrdinaryVisible` (`core/src/logical/projector.ts:464-466`) is `nodeVisible`,
and is exported with a comment naming it *the reply-target gate*. Since
`remoteVisible` ignores `hidden_at`, **a hidden item still accepts replies**.

Matters most if deletion propagation is ever built: a propagated deletion would
hide an item that then continues to accept replies pointing at it.

## 3. Ordinary users cannot delete their own posts from the web UI

- Both delete surfaces are gated on `data.me?.isAdmin`
  (`web/src/routes/+page.svelte:231`,
  `web/src/routes/post/[id]/+page.svelte:104`).
- The self-serve `DELETE /me/posts/:id` is `apiKeyAuth`-gated
  (`core/src/api/logical-routes/personal.ts:137`) and has **zero callers in
  `web/`**.

Deletion is currently an admin or API-key action, not a user action. Worth
settling deliberately: it bears directly on whether federated delete propagation
is the right next milestone, since it would federate an action most people on a
given instance cannot perform.

## 4. Handle reservation already exists, and already covers rename

`assertHandleUnreserved` (`core/src/logical/schema.ts:417-420`) is called by both
handle-claiming paths — user insert (`core/src/storage/sqlite.ts:218`) and
`PATCH /me` handle change (`core/src/logical/store.ts:394`).

Any new handle rule should extend **this guard**. A registration-only check
misses rename. Note `handle_reservations_v2` (`schema.ts:304-309`) has
`NOT NULL source_id/publisher_id` and is written only by legacy publisher
conversion, so a new reservation *kind* may need a different row shape — but the
guard is the reuse point.

---

## Related

`docs/superpowers/ideas.md` — "Delete propagation" entry (still unspecced).
Reverted spec: `056445b`, reverted by `6782d88`.
