import { randomUUID } from 'node:crypto'
import type { WriteTx } from './database.ts'
import type { LogicalItemDto } from './types.ts'
import type { User } from '../domain/types.ts'
import { appendJournal } from './journal.ts'
import { resolveInitialParent, wouldCycle, sweepStructuralTombstones, scheduleOrphanWork } from './threading.ts'

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
  in_reply_to_post_id: string | null; thread_root_id: string | null
}

function loadPost(tx: WriteTx, id: string): PostRow | undefined {
  return tx.prepare(
    `SELECT id, title, content, content_markdown, url, published_at, edited_at, in_reply_to_post_id, thread_root_id
     FROM posts WHERE id = ?`,
  ).get(id) as PostRow | undefined
}

// The derived root of the chain that ends at `parentId` (inclusive) — the topmost
// ancestor. Roots are derived, never stored authority (spec §4.1).
// ponytail: LOCKSTEP with runtime.ts's deriveRoot and store.ts's
// adminDeriveRoot — a thread root must read the same from the write path, the
// projection overlay and the admin store. Exported only for the behavioural
// canary in test/logical-lockstep.test.ts. Change one copy, change all three.
// projector.ts's remoteThreadRoot is a FOURTH parent-chain walk, deliberately
// OUTSIDE this lockstep set: it stops at the first non-`resolved`
// parent_state, so it must NOT agree with these three. Don't fold it in.
export function deriveRoot(tx: WriteTx, parentId: string): string {
  const parentOf = tx.prepare(`SELECT parent_logical_item_id FROM logical_items_v2 WHERE id = ?`)
  let root = parentId
  let cur: string | null = parentId
  for (let i = 0; i < 1000 && cur; i++) {
    root = cur
    const row = parentOf.get(cur) as { parent_logical_item_id: string | null } | undefined
    cur = row ? row.parent_logical_item_id : null
  }
  return root
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
// Bounded at 1000 hops — the same bound as this codebase's other three parent
// walks (deriveRoot here and in runtime.ts, adminDeriveRoot in store.ts). Ordinary
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
  post: { id: string; title: string | null; content: string; contentMarkdown: string | null; permalink: string | null; publishedAt: string; editedAt: string | null },
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
    sourceLink: null,
    replyContext: null,
    enclosures: [],
    publishedAt: post.publishedAt,
    updatedAt: post.editedAt,
    updatedAtProvenance: post.editedAt ? 'explicit' : null,
    directReplyCount: 0,
    conversationReplyCount: 0,
    classification: { personal: false, federated: false },
  }
}

export function createLocalPost(input: { tx: WriteTx; author: User; content: string; replyToId: string | null; now: string }): LogicalItemDto {
  const { tx, author, content, replyToId, now } = input
  const id = randomUUID()
  const permalink = permalinkFor(id)

  // Local replies resolve their parent by construction (spec §4.2). Guard the
  // degenerate cycle; a brand-new item cannot deepen an existing chain past the
  // bound by a single edge unless the parent is itself already at the limit —
  // that is threading's concern (Task 7), not the local create.
  const parentLogicalItemId = replyToId && !wouldCycle(tx, replyToId, id) ? replyToId : null
  const threadRootId = parentLogicalItemId ? deriveRoot(tx, parentLogicalItemId) : null

  tx.prepare(
    `INSERT INTO posts (id, author_id, source, guid, title, content, url, published_at, created_at, in_reply_to, in_reply_to_post_id, thread_root_id, source_name, source_feed_url, content_markdown, edited_at, reply_context_author, reply_context_snippet)
     VALUES (?, ?, 'local', ?, NULL, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)`,
  ).run(id, author.id, randomUUID(), content, permalink, now, now, parentLogicalItemId, threadRootId)

  materializeLocalItem(tx, { id, permalink, timelineSortAt: now, parentLogicalItemId })
  appendJournal(tx, { kind: 'upsert', logicalItemId: id, changeMask: 'presentation' }, now)

  return buildDto(
    { id, title: null, content, contentMarkdown: null, permalink, publishedAt: now, editedAt: null },
    author,
    { state: parentLogicalItemId ? 'resolved' : 'none', parentLogicalItemId, threadRootId },
  )
}

export function editLocalPost(input: { tx: WriteTx; postId: string; authorId: string; content: string; now: string }): LogicalItemDto {
  const { tx, postId, authorId, content, now } = input
  const cur = loadPost(tx, postId)
  if (!cur) throw new Error(`editLocalPost: unknown post ${postId}`)

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
    { id: postId, title: cur.title, content, contentMarkdown: cur.content_markdown, permalink, publishedAt: cur.published_at, editedAt: now },
    { id: authorId, handle: '', displayName: '' },
    { state: cur.in_reply_to_post_id ? 'resolved' : 'none', parentLogicalItemId: cur.in_reply_to_post_id, threadRootId: cur.thread_root_id },
  )
}

// Terminal deletion (spec §2.6): remove content + revisions, keep the logical
// item (its descendants may reference it) and a permanent marker holding only the
// logical id, canonical permalink, deletion time. No content/author/source/remote
// attribution survives; the marker has no FK on the removed account.
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

  // Clear the account's edges before removing the user row (posts/follows/push all
  // hold RESTRICT references). The logical markers carry no FK on the account, so
  // they survive its removal (spec §2.6).
  tx.prepare(`DELETE FROM follows WHERE follower_id = ? OR followed_id = ?`).run(accountId, accountId)
  tx.prepare(`DELETE FROM push_subscriptions WHERE user_id = ?`).run(accountId)
  tx.prepare(`DELETE FROM users WHERE id = ?`).run(accountId)

  // ONE reset barrier for the whole account, not one journal effect per post.
  appendJournal(tx, { kind: 'reset', changeMask: 'barrier' }, now)
}

// Read-without-write synthesis (spec §2.6): project a local post as a logical item
// WITHOUT touching the database. The ordinary read path uses this so an untouched
// local post never forces a logical-row insert.
export function synthesizeLocalItem(
  post: { id: string; title: string | null; content: string; contentMarkdown?: string | null; url: string | null; publishedAt: string; editedAt?: string | null; inReplyToPostId?: string | null; threadRootId?: string | null },
  author: Pick<User, 'id' | 'handle' | 'displayName'>,
): LogicalItemDto {
  const parentLogicalItemId = post.inReplyToPostId ?? null
  return buildDto(
    { id: post.id, title: post.title, content: post.content, contentMarkdown: post.contentMarkdown ?? null, permalink: post.url, publishedAt: post.publishedAt, editedAt: post.editedAt ?? null },
    author,
    { state: parentLogicalItemId ? 'resolved' : 'none', parentLogicalItemId, threadRootId: post.threadRootId ?? null },
  )
}
