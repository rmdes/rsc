import { randomUUID } from 'node:crypto'
import type { WriteTx } from './database.ts'
import type { LogicalItemDto } from './types.ts'
import type { User, AuditCategory } from '../domain/types.ts'
import { appendJournal } from './journal.ts'
import { resolveInitialParent, wouldCycle, sweepStructuralTombstones, scheduleOrphanWork, isDeletedMarker } from './threading.ts'
import { reapSourceIfOrphaned } from '../domain/source-repository.ts'
import { deriveRoot } from './roots.ts'
// parentReplyRef must mirror what projectRemote emits, so it lives there; local.ts
// already reaches projector.ts through threading.ts, so this adds no cycle.
import { parentReplyRef } from './projector.ts'

export { resolveInitialParent }

// Local-origin bridge (spec §2.6). `posts`/`post_revisions` stay the SOLE
// authority for local content, revisions, and authorship; logical metadata never
// duplicates mutable content. A local logical item has id === post.id and exactly
// one restrictive local-origin reference. Create/edit/delete and account deletion
// commit local storage + logical metadata + journal effects in the caller's ONE
// write transaction (the passed `tx`) — a fault before commit rolls back all of it.
//
// ponytail: reply counts and Local/Public classification in the returned DTO are
// read-time projection authority (spec §3.1); the commands return them as 0/false
// placeholders — the projector (Task 8) derives the real values. Only the fields a
// mutation actually owns (id, origin, content, ancestry edge, permalink, timing)
// are authoritative here.

// A local post's canonical permalink. Deployment-independent path form: the
// commands take no public base URL, and this value only has to be locally unique
// and stable (it keys the identity row and the terminal deletion marker).
// ponytail: path-form permalink; if remote-echo matching needs the absolute URL,
// pass a base through the command signature then — see the Task 3 report.
const permalinkFor = (id: string): string => `/post/${id}`

type PostRow = {
  id: string; title: string | null; content: string; content_markdown: string | null
  url: string | null; published_at: string; edited_at: string | null
  in_reply_to: string | null; in_reply_to_post_id: string | null; thread_root_id: string | null
}

function loadPost(tx: WriteTx, id: string): PostRow | undefined {
  return tx.prepare(
    `SELECT id, title, content, content_markdown, url, published_at, edited_at, in_reply_to, in_reply_to_post_id, thread_root_id
     FROM posts WHERE id = ?`,
  ).get(id) as PostRow | undefined
}

// Race-safe materialization: INSERT OR IGNORE so two concurrent writers (or an
// edit re-running it) never double-insert. Ordinary reads synthesize WITHOUT
// calling this (read-without-write, spec §2.6).
function materializeLocalItem(
  tx: WriteTx,
  input: { id: string; permalink: string; timelineSortAt: string; parentLogicalItemId: string | null },
): void {
  const parentState = input.parentLogicalItemId ? 'resolved' : 'none'
  tx.prepare(
    `INSERT OR IGNORE INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, created_at)
     VALUES (?, 'local', ?, ?, ?, NULL, NULL, ?)`,
  ).run(input.id, input.timelineSortAt, parentState, input.parentLogicalItemId, input.timelineSortAt)
  tx.prepare(`INSERT OR IGNORE INTO logical_local_origins_v2 (logical_item_id, post_id) VALUES (?, ?)`).run(input.id, input.id)
  const claimed = tx.prepare(`INSERT OR IGNORE INTO logical_identity_keys_v2 (kind, key, logical_item_id) VALUES ('permalink', ?, ?)`).run(input.permalink, input.id).changes > 0
  // A newly-materialized local permalink is a new resolvable alias: any remote
  // reply already sitting at parent_state 'missing' on this URL adopts via the
  // orphan worker (spec §4.2) — same producer wiring as reconcile's claims.
  if (claimed) scheduleOrphanWork(tx, { aliasKind: 'permalink', aliasKey: input.permalink, candidateHighWater: input.timelineSortAt, createdAt: input.timelineSortAt })
}

// Materialize a local post's bridge row on demand (spec §2.6), reusing the same
// race-safe INSERT OR IGNORE path as create/edit/delete. Reconciliation calls
// this before recording a conflict against a local post whose bridge row is not
// yet materialized, so the conflict's FK to logical_items_v2 holds. Idempotent:
// a no-op when the post is already materialized or gone (a deleted marker).
export function materializeLocalPost(tx: WriteTx, postId: string): void {
  const cur = loadPost(tx, postId)
  if (!cur) return
  const permalink = cur.url ?? permalinkFor(postId)
  materializeLocalItem(tx, { id: postId, permalink, timelineSortAt: cur.published_at, parentLogicalItemId: cur.in_reply_to_post_id })
}

// Materialize a local post AND every local ancestor above it, parent-before-child,
// so the unconditional parent edge materializeLocalItem writes always has a row to
// point at. Returns false when the chain leaves the local `posts` table at an id
// that has NO logical row — a legacy reference to a post that is gone, or a remote
// post that was not converted: nothing to reference, so the caller's child is left
// unmaterialized rather than FK-violating. This is the ONE backfill path for a
// legacy local post (the cutover pass and conversion's ancestry pass both use it),
// which is what makes it order-independent: an id that already HAS a logical row is
// satisfied as-is, whether this walk put it there, an earlier one did, or — the
// cutover case — conversion minted the remote parent before the pass ran.
//
// Bounded at 1000 hops — the same bound as the shared deriveRoot (roots.ts,
// used here, in runtime.ts and in store.ts as adminDeriveRoot). Ordinary
// commands can never produce a self-edge or cycle (createLocalPost's wouldCycle
// guard), so this is hand-corruption only; but this walk runs inside the
// pre-listen activation transaction, so an unhandled RangeError there is a
// hard startup crash, not an ordinary-path bug — a depth bound, not cycle
// detection, is what its siblings use and what this needed too.
export function materializeLocalChain(tx: WriteTx, postId: string, depth = 0): boolean {
  if (depth >= 1000) return false
  if (tx.prepare(`SELECT 1 FROM logical_items_v2 WHERE id = ?`).get(postId)) return true
  const row = tx.prepare(`SELECT in_reply_to_post_id AS parent FROM posts WHERE id = ? AND source = 'local'`).get(postId) as
    { parent: string | null } | undefined
  if (!row) return false
  if (row.parent && !materializeLocalChain(tx, row.parent, depth + 1)) return false
  materializeLocalPost(tx, postId)
  return true
}

function buildDto(
  post: { id: string; title: string | null; content: string; contentMarkdown: string | null; permalink: string | null; inReplyToRef: string | null; publishedAt: string; editedAt: string | null },
  author: Pick<User, 'id' | 'handle' | 'displayName'>,
  edge: { state: LogicalItemDto['parentResolutionState']; parentLogicalItemId: string | null; threadRootId: string | null },
): LogicalItemDto {
  return {
    kind: 'logical_item',
    id: post.id,
    origin: 'local',
    parentResolutionState: edge.state,
    parentLogicalItemId: edge.parentLogicalItemId,
    threadRootId: edge.threadRootId,
    selectedAuthor: { kind: 'local', id: author.id, handle: author.handle, displayName: author.displayName },
    title: post.title,
    content: post.content,
    contentMarkdown: post.contentMarkdown,
    permalink: post.permalink,
    originGuid: null, // local items derive their guid from permalink/id (localGuid)
    inReplyToRef: post.inReplyToRef,
    sourceLink: null,
    replyContext: null,
    enclosures: [],
    publishedAt: post.publishedAt,
    updatedAt: post.editedAt,
    updatedAtProvenance: post.editedAt ? 'explicit' : null,
    directReplyCount: 0,
    conversationReplyCount: 0,
    classification: { personal: false, federated: false },
    removed: false, // a just-created/edited post is never the removal marker
  }
}

export function createLocalPost(input: { tx: WriteTx; author: User; content: string; replyToId: string | null; now: string; publicUrl?: string | null }): LogicalItemDto {
  const { tx, author, content, replyToId, now } = input
  const id = randomUUID()
  // v1-parity storage (service.ts): the stored url is the ABSOLUTE permalink under a
  // public URL (or null without one); that same value is the item's rss.chat guid.
  // The identity/marker key needs a non-null local-unique string, so it falls back
  // to the relative path form (matching materializeLocalPost's `cur.url ?? …`).
  const url = input.publicUrl ? `${input.publicUrl}/post/${id}` : null
  const permalink = url ?? permalinkFor(id)

  // Local replies resolve their parent by construction (spec §4.2). Guard the
  // degenerate cycle; a brand-new item cannot deepen an existing chain past the
  // bound by a single edge unless the parent is itself already at the limit —
  // that is threading's concern (Task 7), not the local create.
  const parentLogicalItemId = replyToId && !wouldCycle(tx, replyToId, id) ? replyToId : null
  const threadRootId = parentLogicalItemId ? deriveRoot(tx, parentLogicalItemId) : null
  // Store the parent's absolute wire reference (v1 parity) so the outbound feed
  // emits <source:inReplyTo> and cross-instance conversations reassemble.
  const inReplyToRef = parentLogicalItemId ? parentReplyRef(tx, parentLogicalItemId) : null

  // Guest posts never federate (migration 24). Stamped HERE and not derived
  // from the author on read, because onLinkAccount (auth.ts) re-points the same
  // core row at a registered auth user — a derived rule would publish the whole
  // back-catalogue the moment a guest signs up.
  const isGuest = !!tx.prepare(
    `SELECT 1 FROM users u JOIN user au ON au.id = u.auth_user_id WHERE u.id = ? AND au.isAnonymous = 1`,
  ).get(author.id)

  tx.prepare(
    `INSERT INTO posts (id, author_id, source, guid, title, content, url, published_at, created_at, in_reply_to, in_reply_to_post_id, thread_root_id, source_name, source_feed_url, content_markdown, edited_at, reply_context_author, reply_context_snippet, local_only)
     VALUES (?, ?, 'local', ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
  ).run(id, author.id, randomUUID(), content, url, now, now, inReplyToRef, parentLogicalItemId, threadRootId, isGuest ? 1 : 0)

  materializeLocalItem(tx, { id, permalink, timelineSortAt: now, parentLogicalItemId })
  appendJournal(tx, { kind: 'upsert', logicalItemId: id, changeMask: 'presentation' }, now)

  return buildDto(
    { id, title: null, content, contentMarkdown: null, permalink: url, inReplyToRef, publishedAt: now, editedAt: null },
    author,
    { state: parentLogicalItemId ? 'resolved' : 'none', parentLogicalItemId, threadRootId },
  )
}

// Thrown by editLocalPost when the target carries the removed marker — the
// moderation-bypass guard below. A distinct class (not a bare Error, not
// DomainError, which app.onError maps to a fixed 400) so callers can
// recognize it and choose the status themselves.
export class PostRemovedError extends Error {}

export function editLocalPost(input: { tx: WriteTx; postId: string; authorId: string; content: string; now: string }): LogicalItemDto {
  const { tx, postId, authorId, content, now } = input
  const cur = loadPost(tx, postId)
  if (!cur) throw new Error(`editLocalPost: unknown post ${postId}`)

  // A removed post's row survives as an edit (removeLocalPost, below) — it no
  // longer disappears from getPost, so the routes' old "!post -> 404" guard
  // no longer blocks editing it. Refuse unconditionally, regardless of who
  // removed it (the marker doesn't record that, and an author-vs-moderator
  // split isn't worth a schema change): otherwise the author of a
  // moderator-removed post PATCHes their own content straight back, and that
  // PATCH republishes it (service.editLocalPost's bus.emitNewPost). Checked
  // inside THIS write tx, not a separate read, so there is no TOCTOU window
  // between the check and the write below.
  if (isDeletedMarker(tx, postId)) throw new PostRemovedError(`editLocalPost: post ${postId} has been removed`)

  // Snapshot the superseded version, then overwrite (posts is the sole content
  // authority; post_revisions is the sole history authority — spec §2.6).
  tx.prepare(
    `INSERT INTO post_revisions (id, post_id, title, content, content_markdown, seen_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), postId, cur.title, cur.content, cur.content_markdown, now)
  tx.prepare(`UPDATE posts SET content = ?, edited_at = ? WHERE id = ?`).run(content, now, postId)

  // Edit is also a materialization point: an untouched local post read-synthesized
  // until now gets its logical row here, idempotently.
  const permalink = cur.url ?? permalinkFor(postId)
  materializeLocalItem(tx, { id: postId, permalink, timelineSortAt: cur.published_at, parentLogicalItemId: cur.in_reply_to_post_id })
  appendJournal(tx, { kind: 'upsert', logicalItemId: postId, changeMask: 'presentation' }, now)

  return buildDto(
    { id: postId, title: cur.title, content, contentMarkdown: cur.content_markdown, permalink, inReplyToRef: cur.in_reply_to, publishedAt: cur.published_at, editedAt: now },
    { id: authorId, handle: '', displayName: '' },
    { state: cur.in_reply_to_post_id ? 'resolved' : 'none', parentLogicalItemId: cur.in_reply_to_post_id, threadRootId: cur.thread_root_id },
  )
}

// Who removed a post, and why. An author needs no reason; a moderator picks from
// the audit vocabulary already used by hide/restore (domain/types.ts AuditCategory)
// and may add a note. Both end up as PUBLIC content — the notice federates.
export type RemovalActor =
  | { kind: 'author' }
  | { kind: 'administrator'; category: AuditCategory; note: string | null }

// The replacement body. Plain markdown: it is rendered to HTML for the feed's
// <description> and emitted verbatim as <source:markdown>, so it must read as
// prose in both. Categories are snake_case in the schema ('illegal_content');
// the underscore swap is the whole "label" mapping — a lookup table here would
// have to be kept in step with the CHECK constraint for no gain.
export function removalNotice(actor: RemovalActor): string {
  if (actor.kind === 'author') return 'This post was removed by its author.'
  const head = `This post was removed by a moderator (${actor.category.replace(/_/g, ' ')}).`
  return actor.note ? `${head}\n\n${actor.note}` : head
}

// Removal as an EDIT (not a destruction): the post keeps its row, id, permalink,
// published_at and place in the thread, and its content becomes the notice. That
// is what lets the removal federate for free — the outgoing feed already carries
// this item at the same <guid>, so a peer ingests it as an ordinary edit and
// overwrites its copy in place. No side channel, no consumer to build.
//
// The logical_deleted_local_v2 marker is still written, and is now the ONLY way
// to tell a removed post from an ordinary one (the posts row no longer vanishes).
// Every path that already keys on that marker — the orphan-adoption guard, the
// admin item state, the permalink-owner check — keeps working untouched.
//
// No sweepStructuralTombstones call, unlike deleteLocalPost: that collapses a
// parent tombstone left CHILDLESS by a deletion, and this post survives as a
// child, so the sweep could only ever be a no-op here.
export function removeLocalPost(input: { tx: WriteTx; postId: string; actor: RemovalActor; now: string }): void {
  const { tx, postId, actor, now } = input
  const cur = loadPost(tx, postId)
  if (!cur) return
  const permalink = cur.url ?? permalinkFor(postId)
  const notice = removalNotice(actor)
  const alreadyRemoved = isDeletedMarker(tx, postId)

  // Idempotent repeat (mirrors the PATCH no-op idiom in personal.ts/app.ts,
  // "no-op: no phantom revision"): a retry that lands on the SAME notice — a
  // client timeout retry, a double-clicked button — changes nothing, so it
  // writes nothing: no content write, no revision, no journal entry. That does
  // NOT suppress the outbound publish: service.deletePost calls bus.emitNewPost
  // unconditionally after this returns, so a repeated delete still fires one
  // redundant fat-ping/WebSub-ping. Accepted: peers ingest it as an unchanged
  // item, so the redundancy is harmless, just not free.
  if (alreadyRemoved && cur.content === notice) return

  // History splits on the actor, but ONLY on the transition INTO removal.
  // cur.content is real user content exclusively on the first call; on any
  // repeat, cur.content is already a PRIOR NOTICE — snapshotting that as
  // "superseded content" would fabricate post_revisions history out of the
  // removal machinery's own output (e.g. a moderator correcting spam→abuse
  // must still update the notice, but must not manufacture a revision row).
  if (!alreadyRemoved) {
    if (actor.kind === 'administrator') {
      // A moderator removal keeps the superseded text as an admin-only record
      // of what was actioned.
      tx.prepare(
        `INSERT INTO post_revisions (id, post_id, title, content, content_markdown, seen_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(randomUUID(), postId, cur.title, cur.content, cur.content_markdown, now)
    } else {
      // An author removing their own post takes it with them, matching what
      // deletion has always meant for them.
      tx.prepare(`DELETE FROM post_revisions WHERE post_id = ?`).run(postId)
    }
  }

  // Title and content_markdown are cleared too. Posts created here never carry
  // either, but a migrated v1 post can — and a surviving headline or markdown
  // source above a removal notice would publish the very words being removed.
  tx.prepare(`UPDATE posts SET title = NULL, content = ?, content_markdown = NULL, edited_at = ? WHERE id = ?`)
    .run(notice, now, postId)

  materializeLocalItem(tx, { id: postId, permalink, timelineSortAt: cur.published_at, parentLogicalItemId: cur.in_reply_to_post_id })
  tx.prepare(
    `INSERT OR IGNORE INTO logical_deleted_local_v2 (logical_item_id, canonical_permalink, deleted_at) VALUES (?, ?, ?)`,
  ).run(postId, permalink, now)
  // upsert, NOT remove: this is an edit. A remove frame would make peers and open
  // SSE clients drop the item instead of showing the notice.
  appendJournal(tx, { kind: 'upsert', logicalItemId: postId, changeMask: 'presentation' }, now)
}

// Terminal deletion (spec §2.6): remove content + revisions, keep the logical
// item (its descendants may reference it) and a permanent marker holding only the
// logical id, canonical permalink, deletion time. No content/author/source/remote
// attribution survives; the marker has no FK on the removed account.
//
// Used ONLY by account deletion now. A single-post removal goes through
// removeLocalPost above; posts.author_id is a RESTRICT reference to users(id),
// so surviving post rows would make DELETE FROM users fail and roll the whole
// account deletion back.
function terminallyDelete(tx: WriteTx, postId: string, now: string): void {
  const cur = loadPost(tx, postId)
  if (!cur) return
  const permalink = cur.url ?? permalinkFor(postId)
  // Ensure the logical row exists before releasing the post (a never-touched post
  // has no logical row yet) so the marker's FK holds.
  materializeLocalItem(tx, { id: postId, permalink, timelineSortAt: cur.published_at, parentLogicalItemId: cur.in_reply_to_post_id })
  // Release the RESTRICT references to posts, then drop content + revisions. The
  // permalink identity key is retained (a necessary alias, spec §2.6).
  tx.prepare(`DELETE FROM logical_local_origins_v2 WHERE post_id = ?`).run(postId)
  tx.prepare(`DELETE FROM post_revisions WHERE post_id = ?`).run(postId)
  tx.prepare(`DELETE FROM posts WHERE id = ?`).run(postId)
  tx.prepare(
    `INSERT OR IGNORE INTO logical_deleted_local_v2 (logical_item_id, canonical_permalink, deleted_at) VALUES (?, ?, ?)`,
  ).run(postId, permalink, now)
}

export function deleteLocalPost(input: { tx: WriteTx; postId: string; actorId: string; now: string }): void {
  const { tx, postId, now } = input
  // The deleted post's parent edge, captured before the delete. terminallyDelete
  // keeps the logical row (as a deleted_local marker), so this is a no-op for the
  // ordinary no-tombstone case; it only fires if the post ever edged directly to a
  // remote structural tombstone (spec §5.3 descendant-deletion sweep hook).
  const parent = (loadPost(tx, postId)?.in_reply_to_post_id) ?? null
  terminallyDelete(tx, postId, now)
  sweepStructuralTombstones(tx, [parent], now)
  appendJournal(tx, { kind: 'remove', logicalItemId: postId, changeMask: 'presentation' }, now)
}

export function deleteLocalAccount(input: { tx: WriteTx; accountId: string; actorId: string; now: string }): void {
  const { tx, accountId, now } = input
  const posts = tx.prepare(`SELECT id FROM posts WHERE author_id = ?`).all(accountId) as { id: string }[]
  for (const p of posts) terminallyDelete(tx, p.id, now)

  // The account's v2 source subscriptions go with it via source_subscriptions_v2's
  // own ON DELETE CASCADE on owner_id — read the subscribed source ids first, so
  // they can be re-evaluated for retention after the user row is gone (the cascade
  // removes the subscription row but can't tell whether the source itself is still
  // wanted by anyone else). Empty when the account has no source subscriptions.
  const sourceIds = (tx.prepare(`SELECT source_id FROM source_subscriptions_v2 WHERE owner_id = ?`).all(accountId) as { source_id: string }[]).map((r) => r.source_id)

  // Clear the account's edges before removing the user row (posts/follows/push all
  // hold RESTRICT references). The logical markers carry no FK on the account, so
  // they survive its removal (spec §2.6).
  tx.prepare(`DELETE FROM follows WHERE follower_id = ? OR followed_id = ?`).run(accountId, accountId)
  tx.prepare(`DELETE FROM push_subscriptions WHERE user_id = ?`).run(accountId)
  tx.prepare(`DELETE FROM users WHERE id = ?`).run(accountId)
  for (const sourceId of sourceIds) reapSourceIfOrphaned(tx, sourceId, now)

  // ONE reset barrier for the whole account, not one journal effect per post.
  appendJournal(tx, { kind: 'reset', changeMask: 'barrier' }, now)
}

// Read-without-write synthesis (spec §2.6): project a local post as a logical item
// WITHOUT touching the database. The ordinary read path uses this so an untouched
// local post never forces a logical-row insert.
export function synthesizeLocalItem(
  post: { id: string; title: string | null; content: string; contentMarkdown?: string | null; url: string | null; publishedAt: string; editedAt?: string | null; inReplyTo?: string | null; inReplyToPostId?: string | null; threadRootId?: string | null },
  author: Pick<User, 'id' | 'handle' | 'displayName'>,
): LogicalItemDto {
  const parentLogicalItemId = post.inReplyToPostId ?? null
  return buildDto(
    { id: post.id, title: post.title, content: post.content, contentMarkdown: post.contentMarkdown ?? null, permalink: post.url, inReplyToRef: post.inReplyTo ?? null, publishedAt: post.publishedAt, editedAt: post.editedAt ?? null },
    author,
    { state: parentLogicalItemId ? 'resolved' : 'none', parentLogicalItemId, threadRootId: post.threadRootId ?? null },
  )
}
