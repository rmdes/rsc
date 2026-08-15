import { test, expect } from 'vitest'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLocalPost, editLocalPost, deleteLocalPost, deleteLocalAccount, removeLocalPost, synthesizeLocalItem, materializeLocalChain } from '../src/logical/local.ts'
import { getJournalMetadata, readJournalBatch } from '../src/logical/journal.ts'
import type { User } from '../src/domain/types.ts'

type Raw = InstanceType<typeof Database>

const NOW = '2026-07-23T00:00:00.000Z'
const LATER = '2026-07-23T01:00:00.000Z'

function count(raw: Raw, table: string, where = '', ...args: unknown[]): number {
  return (raw.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get(...args) as { n: number }).n
}

// Seeds a local user row directly (the author the commands attribute posts to).
function seedUser(raw: Raw, id: string, handle: string): User {
  raw.prepare(
    `INSERT INTO users (id, kind, handle, display_name, feed_url, created_at, auth_user_id, feed_type)
     VALUES (?, 'local', ?, ?, NULL, ?, NULL, NULL)`,
  ).run(id, handle, handle, NOW)
  return { id, kind: 'local', handle, displayName: handle, feedUrl: null, createdAt: NOW, authUserId: null, feedType: null }
}

async function fresh() {
  const repo = await createSqliteRepository(':memory:')
  return { raw: repo.raw, db: createDatabaseContext(repo.raw) }
}

test('createLocalPost gives the logical item the post id and one restrictive local origin', async () => {
  const { raw, db } = await fresh()
  const author = seedUser(raw, 'u1', 'alice')
  const dto = db.write((tx) => createLocalPost({ tx, author, content: 'hello world', replyToId: null, now: NOW }))

  const post = raw.prepare(`SELECT id, content FROM posts WHERE author_id = 'u1'`).get() as { id: string; content: string }
  expect(dto.id).toBe(post.id) // logicalId === post.id
  expect(dto.origin).toBe('local')
  expect(dto.content).toBe('hello world')
  expect(post.content).toBe('hello world') // posts is the sole content authority

  const origin = raw.prepare(`SELECT logical_item_id, post_id FROM logical_local_origins_v2 WHERE post_id = ?`).get(post.id) as { logical_item_id: string; post_id: string }
  expect(origin.logical_item_id).toBe(dto.id)
  expect(count(raw, 'logical_local_origins_v2')).toBe(1) // exactly one, unique
  expect(count(raw, 'logical_items_v2', 'WHERE origin = ?', 'local')).toBe(1)
})

test('createLocalPost commits the post, the logical row, and one upsert journal effect atomically', async () => {
  const { raw, db } = await fresh()
  const author = seedUser(raw, 'u1', 'alice')
  const dto = db.write((tx) => createLocalPost({ tx, author, content: 'atomic', replyToId: null, now: NOW }))

  const rows = db.read((tx) => readJournalBatch(tx, 0, 10))
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ kind: 'upsert', logicalItemId: dto.id })
})

test('a fault inside the local create rolls back the post AND the logical rows together', async () => {
  const { raw, db } = await fresh()
  const author = seedUser(raw, 'u1', 'alice')
  expect(() =>
    db.write((tx) => {
      createLocalPost({ tx, author, content: 'doomed', replyToId: null, now: NOW })
      throw new Error('fault-mid-mutation')
    }),
  ).toThrow('fault-mid-mutation')
  expect(count(raw, 'posts')).toBe(0)
  expect(count(raw, 'logical_items_v2')).toBe(0)
  expect(count(raw, 'logical_journal_v2')).toBe(0)
})

test('a local reply resolves its parent by construction and roots to the top item', async () => {
  const { raw, db } = await fresh()
  const author = seedUser(raw, 'u1', 'alice')
  const root = db.write((tx) => createLocalPost({ tx, author, content: 'root', replyToId: null, now: NOW }))
  const reply = db.write((tx) => createLocalPost({ tx, author, content: 'reply', replyToId: root.id, now: LATER }))

  expect(reply.parentResolutionState).toBe('resolved')
  expect(reply.parentLogicalItemId).toBe(root.id)
  expect(reply.threadRootId).toBe(root.id)
  const edge = raw.prepare(`SELECT parent_logical_item_id, parent_state FROM logical_items_v2 WHERE id = ?`).get(reply.id) as { parent_logical_item_id: string; parent_state: string }
  expect(edge).toEqual({ parent_logical_item_id: root.id, parent_state: 'resolved' })
})

test('editLocalPost snapshots a revision, updates content, and emits one upsert', async () => {
  const { raw, db } = await fresh()
  const author = seedUser(raw, 'u1', 'alice')
  const created = db.write((tx) => createLocalPost({ tx, author, content: 'v1', replyToId: null, now: NOW }))
  const before = db.read((tx) => getJournalMetadata(tx))

  const edited = db.write((tx) => editLocalPost({ tx, postId: created.id, authorId: author.id, content: 'v2', now: LATER }))
  expect(edited.content).toBe('v2')
  expect(edited.updatedAt).toBe(LATER)
  expect(edited.updatedAtProvenance).toBe('explicit')

  expect((raw.prepare(`SELECT content FROM posts WHERE id = ?`).get(created.id) as { content: string }).content).toBe('v2')
  expect(count(raw, 'post_revisions', 'WHERE post_id = ?', created.id)).toBe(1) // the v1 snapshot
  const after = db.read((tx) => getJournalMetadata(tx))
  expect(after.highWaterSeq).toBe(before.highWaterSeq + 1)
  const last = db.read((tx) => readJournalBatch(tx, before.highWaterSeq, 10))
  expect(last[0]).toMatchObject({ kind: 'upsert', logicalItemId: created.id })
})

test('deleteLocalPost is terminal: content and revisions go, a permanent marker with no author/source remains', async () => {
  const { raw, db } = await fresh()
  const author = seedUser(raw, 'u1', 'alice')
  const created = db.write((tx) => createLocalPost({ tx, author, content: 'to delete', replyToId: null, now: NOW }))
  db.write((tx) => editLocalPost({ tx, postId: created.id, authorId: author.id, content: 'edited', now: LATER }))

  db.write((tx) => deleteLocalPost({ tx, postId: created.id, actorId: author.id, now: LATER }))

  expect(count(raw, 'posts', 'WHERE id = ?', created.id)).toBe(0)
  expect(count(raw, 'post_revisions', 'WHERE post_id = ?', created.id)).toBe(0)
  expect(count(raw, 'logical_local_origins_v2')).toBe(0) // origin reference released
  // logical item survives as a terminal marker
  expect(count(raw, 'logical_items_v2', 'WHERE id = ?', created.id)).toBe(1)
  const marker = raw.prepare(`SELECT logical_item_id, canonical_permalink, deleted_at FROM logical_deleted_local_v2 WHERE logical_item_id = ?`).get(created.id) as { logical_item_id: string; canonical_permalink: string; deleted_at: string }
  expect(marker.logical_item_id).toBe(created.id)
  expect(marker.canonical_permalink).toBeTruthy()
  expect(marker.deleted_at).toBe(LATER)
  // a remove effect is journalled
  const rows = db.read((tx) => readJournalBatch(tx, 0, 20))
  expect(rows.at(-1)).toMatchObject({ kind: 'remove', logicalItemId: created.id })
})

test('removeLocalPost keeps the row and replaces the content with a moderator notice', async () => {
  const { raw, db } = await fresh()
  const author = seedUser(raw, 'u1', 'alice')
  const created = db.write((tx) => createLocalPost({ tx, author, content: 'spammy thing', replyToId: null, now: NOW }))
  // Posts created here never carry a title, but a migrated v1 post can — and a
  // surviving headline would publish the very words being removed. Set one so the
  // assertion below can actually fail if the clear is dropped.
  raw.prepare(`UPDATE posts SET title = 'Buy cheap pills now' WHERE id = ?`).run(created.id)
  const before = raw.prepare(`SELECT url, published_at FROM posts WHERE id = ?`).get(created.id) as { url: string | null; published_at: string }

  db.write((tx) => removeLocalPost({ tx, postId: created.id, actor: { kind: 'administrator', category: 'spam', note: null }, now: LATER }))

  const post = raw.prepare(`SELECT title, content, url, published_at, edited_at FROM posts WHERE id = ?`).get(created.id) as
    { title: string | null; content: string; url: string | null; published_at: string; edited_at: string }
  expect(post.content).toBe('This post was removed by a moderator (spam).')
  expect(post.title).toBeNull()
  // identity and position are untouched — this is what lets a peer overwrite in place
  expect(post.url).toBe(before.url)
  expect(post.published_at).toBe(before.published_at)
  expect(post.edited_at).toBe(LATER)
  // the marker is what every removal-aware path keys on
  expect(count(raw, 'logical_deleted_local_v2', 'WHERE logical_item_id = ?', created.id)).toBe(1)
  // an EDIT, not a removal: a remove frame would make peers drop the item
  const rows = db.read((tx) => readJournalBatch(tx, 0, 20))
  expect(rows.at(-1)).toMatchObject({ kind: 'upsert', logicalItemId: created.id })
})

test('removeLocalPost renders an underscored category as prose and appends the note', async () => {
  const { raw, db } = await fresh()
  const author = seedUser(raw, 'u1', 'alice')
  const created = db.write((tx) => createLocalPost({ tx, author, content: 'x', replyToId: null, now: NOW }))

  db.write((tx) => removeLocalPost({ tx, postId: created.id, actor: { kind: 'administrator', category: 'illegal_content', note: 'court order 12/3' }, now: LATER }))

  const { content } = raw.prepare(`SELECT content FROM posts WHERE id = ?`).get(created.id) as { content: string }
  expect(content).toBe('This post was removed by a moderator (illegal content).\n\ncourt order 12/3')
})

test('an author removing their own post purges its revisions; a moderator keeps them', async () => {
  const { raw, db } = await fresh()
  const author = seedUser(raw, 'u1', 'alice')

  const byAuthor = db.write((tx) => createLocalPost({ tx, author, content: 'v1', replyToId: null, now: NOW }))
  db.write((tx) => editLocalPost({ tx, postId: byAuthor.id, authorId: author.id, content: 'v2', now: LATER }))
  expect(count(raw, 'post_revisions', 'WHERE post_id = ?', byAuthor.id)).toBe(1)
  db.write((tx) => removeLocalPost({ tx, postId: byAuthor.id, actor: { kind: 'author' }, now: LATER }))
  // the words go with them — nothing is left for /post/:id/history to serve
  expect(count(raw, 'post_revisions', 'WHERE post_id = ?', byAuthor.id)).toBe(0)
  expect((raw.prepare(`SELECT content FROM posts WHERE id = ?`).get(byAuthor.id) as { content: string }).content)
    .toBe('This post was removed by its author.')

  const byMod = db.write((tx) => createLocalPost({ tx, author, content: 'evidence', replyToId: null, now: NOW }))
  db.write((tx) => removeLocalPost({ tx, postId: byMod.id, actor: { kind: 'administrator', category: 'abuse', note: null }, now: LATER }))
  // retained as an admin-only record of what was actioned
  const kept = raw.prepare(`SELECT content FROM post_revisions WHERE post_id = ?`).get(byMod.id) as { content: string }
  expect(kept.content).toBe('evidence')
})

test('a repeat removal by the same actor is a no-op: no revision, no new journal entry', async () => {
  const { raw, db } = await fresh()
  const author = seedUser(raw, 'u1', 'alice')
  const created = db.write((tx) => createLocalPost({ tx, author, content: 'evidence', replyToId: null, now: NOW }))

  db.write((tx) => removeLocalPost({ tx, postId: created.id, actor: { kind: 'administrator', category: 'spam', note: null }, now: LATER }))
  expect(count(raw, 'post_revisions', 'WHERE post_id = ?', created.id)).toBe(1) // the first removal's real-content snapshot
  const afterFirst = db.read((tx) => getJournalMetadata(tx))

  // Same actor, same category, same note: an identical resulting notice.
  db.write((tx) => removeLocalPost({ tx, postId: created.id, actor: { kind: 'administrator', category: 'spam', note: null }, now: '2026-07-23T02:00:00.000Z' }))

  // no fabricated revision from the repeat call
  expect(count(raw, 'post_revisions', 'WHERE post_id = ?', created.id)).toBe(1)
  // no new journal entry
  const afterSecond = db.read((tx) => getJournalMetadata(tx))
  expect(afterSecond.highWaterSeq).toBe(afterFirst.highWaterSeq)
  // edited_at was NOT bumped by the no-op repeat
  const post = raw.prepare(`SELECT edited_at FROM posts WHERE id = ?`).get(created.id) as { edited_at: string }
  expect(post.edited_at).toBe(LATER)
})

test('a moderator changing the category on an already-removed post updates the notice but adds no revision row', async () => {
  const { raw, db } = await fresh()
  const author = seedUser(raw, 'u1', 'alice')
  const created = db.write((tx) => createLocalPost({ tx, author, content: 'evidence', replyToId: null, now: NOW }))

  db.write((tx) => removeLocalPost({ tx, postId: created.id, actor: { kind: 'administrator', category: 'spam', note: null }, now: LATER }))
  expect(count(raw, 'post_revisions', 'WHERE post_id = ?', created.id)).toBe(1) // the real 'evidence' content
  const afterFirst = db.read((tx) => getJournalMetadata(tx))

  const recategorized = '2026-07-23T02:00:00.000Z'
  db.write((tx) => removeLocalPost({ tx, postId: created.id, actor: { kind: 'administrator', category: 'abuse', note: null }, now: recategorized }))

  // the notice reflects the corrected category
  const post = raw.prepare(`SELECT content, edited_at FROM posts WHERE id = ?`).get(created.id) as { content: string; edited_at: string }
  expect(post.content).toBe('This post was removed by a moderator (abuse).')
  expect(post.edited_at).toBe(recategorized)
  // still exactly one revision row — the original 'evidence' snapshot, not the superseded 'spam' notice
  expect(count(raw, 'post_revisions', 'WHERE post_id = ?', created.id)).toBe(1)
  const kept = raw.prepare(`SELECT content FROM post_revisions WHERE post_id = ?`).get(created.id) as { content: string }
  expect(kept.content).toBe('evidence')
  // a legitimate update still journals (it is not a no-op)
  const afterSecond = db.read((tx) => getJournalMetadata(tx))
  expect(afterSecond.highWaterSeq).toBe(afterFirst.highWaterSeq + 1)
})

test('the first removal is unaffected by the idempotency guard', async () => {
  const { raw, db } = await fresh()
  const author = seedUser(raw, 'u1', 'alice')
  const created = db.write((tx) => createLocalPost({ tx, author, content: 'spammy thing', replyToId: null, now: NOW }))
  const before = db.read((tx) => getJournalMetadata(tx))

  db.write((tx) => removeLocalPost({ tx, postId: created.id, actor: { kind: 'administrator', category: 'spam', note: null }, now: LATER }))

  const post = raw.prepare(`SELECT content, edited_at FROM posts WHERE id = ?`).get(created.id) as { content: string; edited_at: string }
  expect(post.content).toBe('This post was removed by a moderator (spam).')
  expect(post.edited_at).toBe(LATER)
  expect(count(raw, 'post_revisions', 'WHERE post_id = ?', created.id)).toBe(1)
  const after = db.read((tx) => getJournalMetadata(tx))
  expect(after.highWaterSeq).toBe(before.highWaterSeq + 1)
})

test('a removed post keeps its place in the thread and its replies', async () => {
  const { raw, db } = await fresh()
  const author = seedUser(raw, 'u1', 'alice')
  const parent = db.write((tx) => createLocalPost({ tx, author, content: 'parent', replyToId: null, now: NOW }))
  const child = db.write((tx) => createLocalPost({ tx, author, content: 'reply', replyToId: parent.id, now: NOW }))

  db.write((tx) => removeLocalPost({ tx, postId: parent.id, actor: { kind: 'author' }, now: LATER }))

  expect(count(raw, 'posts', 'WHERE id = ?', child.id)).toBe(1)
  const edge = raw.prepare(`SELECT parent_logical_item_id FROM logical_items_v2 WHERE id = ?`).get(child.id) as { parent_logical_item_id: string | null }
  expect(edge.parent_logical_item_id).toBe(parent.id)
  // the local-origin bridge survives too — terminallyDelete releases it, this must not
  expect(count(raw, 'logical_local_origins_v2', 'WHERE post_id = ?', parent.id)).toBe(1)
})

test('deleting a parent that still has a child keeps the logical row and the descendant edge intact', async () => {
  const { raw, db } = await fresh()
  const author = seedUser(raw, 'u1', 'alice')
  const parent = db.write((tx) => createLocalPost({ tx, author, content: 'parent', replyToId: null, now: NOW }))
  const child = db.write((tx) => createLocalPost({ tx, author, content: 'child', replyToId: parent.id, now: LATER }))

  db.write((tx) => deleteLocalPost({ tx, postId: parent.id, actorId: author.id, now: LATER }))

  expect(count(raw, 'logical_items_v2', 'WHERE id = ?', parent.id)).toBe(1) // marker keeps it
  expect(count(raw, 'logical_deleted_local_v2', 'WHERE logical_item_id = ?', parent.id)).toBe(1)
  const edge = raw.prepare(`SELECT parent_logical_item_id FROM logical_items_v2 WHERE id = ?`).get(child.id) as { parent_logical_item_id: string }
  expect(edge.parent_logical_item_id).toBe(parent.id) // descendant connectivity preserved
})

test('deleteLocalAccount removes every post under one reset barrier and leaves markers with no FK on the account', async () => {
  const { raw, db } = await fresh()
  const author = seedUser(raw, 'u1', 'alice')
  const p1 = db.write((tx) => createLocalPost({ tx, author, content: 'one', replyToId: null, now: NOW }))
  const p2 = db.write((tx) => createLocalPost({ tx, author, content: 'two', replyToId: null, now: LATER }))
  const before = db.read((tx) => getJournalMetadata(tx))

  db.write((tx) => deleteLocalAccount({ tx, accountId: author.id, actorId: author.id, now: LATER }))

  expect(count(raw, 'posts', 'WHERE author_id = ?', author.id)).toBe(0)
  expect(count(raw, 'users', 'WHERE id = ?', author.id)).toBe(0) // account removed
  // both posts have a terminal marker that survives the account removal
  expect(count(raw, 'logical_deleted_local_v2', 'WHERE logical_item_id IN (?, ?)', p1.id, p2.id)).toBe(2)
  expect(count(raw, 'logical_items_v2')).toBe(2)
  // exactly ONE reset barrier, not one journal effect per post
  const rows = db.read((tx) => readJournalBatch(tx, before.highWaterSeq, 20))
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ kind: 'reset', logicalItemId: null })
})

test('a remote echo can attach an identity key to a local item but never creates a second ordinary item', async () => {
  const { raw, db } = await fresh()
  const author = seedUser(raw, 'u1', 'alice')
  const created = db.write((tx) => createLocalPost({ tx, author, content: 'mine', replyToId: null, now: NOW }))

  // the local permalink identity key points at the one local logical item
  const key = raw.prepare(`SELECT logical_item_id FROM logical_identity_keys_v2 WHERE kind = 'permalink'`).get() as { logical_item_id: string } | undefined
  expect(key?.logical_item_id).toBe(created.id)
  // exactly one ordinary (non-deleted) local item exists; an echo resolves here, it does not fork
  expect(count(raw, 'logical_items_v2', 'WHERE origin = ?', 'local')).toBe(1)
})

test('synthesizeLocalItem projects a post as a logical item WITHOUT writing a logical row', async () => {
  const { raw } = await fresh()
  const author = seedUser(raw, 'u1', 'alice')
  const post = {
    id: 'p1', authorId: 'u1', source: 'local' as const, guid: 'g1', title: null, content: 'read me',
    url: '/post/p1', publishedAt: NOW, createdAt: NOW, inReplyTo: null, inReplyToPostId: null, threadRootId: null,
  }
  const dto = synthesizeLocalItem(post, author)
  expect(dto.id).toBe('p1')
  expect(dto.origin).toBe('local')
  expect(dto.content).toBe('read me')
  // read-without-write: nothing was materialized
  expect(count(raw, 'logical_items_v2')).toBe(0)
  expect(count(raw, 'logical_local_origins_v2')).toBe(0)
})

test('materialization is race-safe: a second create-time materialize of the same post inserts nothing new', async () => {
  const { raw, db } = await fresh()
  const author = seedUser(raw, 'u1', 'alice')
  const created = db.write((tx) => createLocalPost({ tx, author, content: 'once', replyToId: null, now: NOW }))
  // editing re-runs materialization (mutation path); it must be idempotent, not double-insert
  db.write((tx) => editLocalPost({ tx, postId: created.id, authorId: author.id, content: 'twice', now: LATER }))
  expect(count(raw, 'logical_items_v2')).toBe(1)
  expect(count(raw, 'logical_local_origins_v2')).toBe(1)
})

// materializeLocalChain walks ancestry via recursion with no cycle guard of its
// own (unlike deriveRoot/adminDeriveRoot's iterative 1000-hop bound). Ordinary
// commands can never produce a self-edge or a cycle (createLocalPost's wouldCycle
// guard), so this is hand-corruption only — but the walk is reachable from the
// pre-listen activation transaction (runtime.ts's materializePreexistingLocalPosts
// and convert.ts's ancestry backfill both call it), so an unbounded recursion
// there is a startup crash (RangeError: Maximum call stack size exceeded), not an
// ordinary-path bug. The bound must fail closed (false, nothing materialized)
// rather than crash the process.
test('materializeLocalChain is bounded: a hand-corrupted self-edge does not recurse forever', async () => {
  const { raw, db } = await fresh()
  seedUser(raw, 'u1', 'alice')
  raw.prepare(
    `INSERT INTO posts (id, author_id, source, guid, content, url, published_at, created_at, in_reply_to_post_id)
     VALUES ('c1', 'u1', 'local', 'g1', 'corrupt', '/post/c1', ?, ?, 'c1')`,
  ).run(NOW, NOW)

  const ok = db.write((tx) => materializeLocalChain(tx, 'c1'))

  expect(ok).toBe(false)
  expect(count(raw, 'logical_items_v2')).toBe(0)
})
