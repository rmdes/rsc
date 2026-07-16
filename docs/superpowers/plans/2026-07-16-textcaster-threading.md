# Textcaster Reply Threading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replies as first-class posts in the one timeline, a thread page, and reply metadata that federates over the feed substrate — `source:inReplyTo`/`thr:in-reply-to` out and in, mf2 `u-in-reply-to` in, plus `source:comments` + per-post comments feeds (Winer-native pull side).

**Architecture:** Migration 5 adds `in_reply_to` (wire ref), `in_reply_to_post_id` (resolved parent), `thread_root_id` to posts. **Resolve once**: refs are matched exactly once (insert/adoption) under a pinned exactly-one rule; counts, comments feeds, and threads all key on resolved ids — no render-time ref matching. Conversation grouping = stored root + adoption (1 adopt UPDATE + one re-root UPDATE per adopted orphan). `<source:comments>` is string-injected post-generation (feedsmith 2.9.6 can't serialize it — probed).

**Tech Stack:** TypeScript (ESM, Node ≥22.18, native type stripping — no build), Kysely + better-sqlite3, feedsmith, mf2tojf2 (already installed), Vitest, SvelteKit.

**Spec:** `docs/superpowers/specs/2026-07-16-textcaster-threading-design.md` (rev 4, 30d4606). H2/Hole A/Hole B and all probe results are folded in there; this plan implements them.

## Global Constraints

- **Storage-agnostic core:** no SQL outside `core/src/storage/sqlite.ts`; new behavior lands in the `Repository` interface + contract suite.
- **One migration array, append only** — this milestone appends the FIFTH element (index 4) to `MIGRATIONS`; never edit earlier entries.
- **Resolve once (spec H2):** ref matching happens ONLY in `findPostByRef`/`adoptOrphans`. Nothing may re-match `in_reply_to` refs at render time — counts and comments queries key on `in_reply_to_post_id`.
- **Ref-resolution rule (spec, pinned):** url match only if exactly one row has that url; else guid match only if exactly one row has that guid; else unresolved. Both adoption arms carry the same exactly-one guard. Temporal collisions are an accepted, documented residual — do NOT build re-orphaning.
- **No new dependencies.** No JSON Feed reply field (cut — write-only, probed). No reply notifications, no timeline bumping, no nested rendering, no reply-context fetching, no push on comments feeds.
- **Probed feedsmith facts the code below relies on:** RSS parse → `item.sourceNs.inReplyTo.value` and `item.thr.inReplyTos[{ref,href}]`; Atom parse → `entry.thr.inReplyTos` only (NO `sourceNs` on Atom); RSS generate → `sourceNs: { inReplyTo: { value, isPermaLink } }` and `thr: { inReplyTos: [{ ref, href }] }` both serialize with namespaces declared; `sourceNs.comments` is silently DROPPED by generate (hence the injector). mf2tojf2 → JF2 `in-reply-to` is a string for one value, an array for several.
- **TDD.** `npm test -w core`, `npm run typecheck -w core`, `npm test -w web`, `npm run check -w web` green at each task's end.
- Web UI tasks invoke `ui-ux-pro-max:ui-ux-pro-max` before markup, per CLAUDE.md; markup below is functional, design pass refines styling.
- Commit after each task; end every commit message with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## File structure

```
core/src/domain/types.ts        # MODIFY: Post gains inReplyTo?/inReplyToPostId?/threadRootId?
core/src/domain/repository.ts   # MODIFY: findPostByRef, getThread, adoptOrphans, countRepliesByPostIds, listRepliesByPostId
core/src/domain/repository-contract.ts # MODIFY: threading contract pins
core/src/storage/sqlite.ts      # MODIFY: migration 5, columns, five methods
core/src/domain/service.ts      # MODIFY: reply compose, getThread/counts/replies passthroughs
core/src/domain/ingest.ts       # MODIFY: ParsedItem.inReplyTo, toParsedItem 7th param, extraction, resolution in ingestItems
core/src/domain/discovery.ts    # MODIFY: JF2 in-reply-to (string|array) → ParsedItem
core/src/domain/feed.ts         # MODIFY: replyElements on RSS items; renderCommentsFeed; injectSourceComments
core/src/api/app.ts             # MODIFY: POST /posts inReplyTo, GET /post/:id/thread, GET /post/:id/comments.xml, feed.xml counts+injection
core/test/threading.test.ts     # CREATE: wire mapping unit tests (in + out + injector)
core/test/api-threading.test.ts # CREATE: HTTP tests
core/test/federation-threading.test.ts # CREATE: money test + mf2 sibling
web/src/lib/types.ts            # MODIFY: TimelineEntry reply fields
web/src/lib/api.ts              # MODIFY: createPost inReplyTo; getThread
web/src/lib/lens.ts + lens.test.ts # MODIFY: thread lens kind
web/src/routes/post/[id]/+page.server.ts + +page.svelte # CREATE: thread page + reply action
web/src/routes/+page.svelte     # MODIFY: reply link + thread marker (same change on the two lens pages)
docs/superpowers/documentation/RUNNING.md # MODIFY: threading section
```

---

### Task 1: Migration 5, Post fields, findPostByRef, getThread

**Files:**
- Modify: `core/src/domain/types.ts`, `core/src/domain/repository.ts`, `core/src/storage/sqlite.ts`, `core/src/domain/repository-contract.ts`

**Interfaces:**
- Produces: `Post` gains OPTIONAL `inReplyTo?: string | null`, `inReplyToPostId?: string | null`, `threadRootId?: string | null` (optional so the many existing `Post` literals in tests stay valid; storage normalizes `?? null` on write and always returns concrete values on read). `Repository.findPostByRef(ref): Promise<Post | undefined>` (the pinned exactly-one rule), `Repository.getThread(rootId): Promise<TimelineEntry[]>` (`id = root OR thread_root_id = root`, `(published_at, id) ASC`). Migration 5 = columns + `posts_thread_idx` + `posts_reply_to_idx` + `posts_parent_idx`.
- Consumes: existing `rowToPost`, `joinedRowToEntry`, `MIGRATIONS`.

- [ ] **Step 1: Extend `Post` in `core/src/domain/types.ts`**

```ts
export interface Post {
  id: string
  authorId: string
  source: PostSource
  guid: string
  title: string | null
  content: string
  url: string | null
  publishedAt: string
  createdAt: string
  inReplyTo?: string | null       // wire ref of the reply target (url ?? guid); null/absent = not a reply
  inReplyToPostId?: string | null // RESOLVED parent post id; null = orphan or not a reply
  threadRootId?: string | null    // top root post id when this post is a descendant
}
```

- [ ] **Step 2: Add the two methods to `core/src/domain/repository.ts`** (after `getPost`):

```ts
  findPostByRef(ref: string): Promise<Post | undefined>
  getThread(rootId: string): Promise<TimelineEntry[]>
```

- [ ] **Step 3: Failing contract tests** — in `core/src/domain/repository-contract.ts`, add inside the contract block. A local `mkPost` helper keeps the literals short:

```ts
    const mkPost = (over: Partial<Post> & { id: string; authorId: string }): Post => ({
      source: 'remote', guid: over.id, title: null, content: over.id, url: null,
      publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', ...over,
    })

    test('findPostByRef: unique url wins; duplicated url resolves to NOTHING (Hole A)', async () => {
      const repo = await makeRepo()
      const a = await repo.createRemoteUser({ handle: 'a', displayName: 'A', feedUrl: 'https://a.ex/f' })
      const b = await repo.createRemoteUser({ handle: 'b', displayName: 'B', feedUrl: 'https://b.ex/f' })
      await repo.insertPost(mkPost({ id: 'p1', authorId: a.id, url: 'https://a.ex/1' }))
      expect((await repo.findPostByRef('https://a.ex/1'))?.id).toBe('p1')
      await repo.insertPost(mkPost({ id: 'p2', authorId: b.id, url: 'https://a.ex/1' })) // syndicated duplicate
      expect(await repo.findPostByRef('https://a.ex/1')).toBeUndefined()
    })

    test('findPostByRef: unique guid matches; guid shared by two posts resolves to NOTHING (H2)', async () => {
      const repo = await makeRepo()
      const a = await repo.createRemoteUser({ handle: 'a', displayName: 'A', feedUrl: 'https://a.ex/f' })
      const b = await repo.createRemoteUser({ handle: 'b', displayName: 'B', feedUrl: 'https://b.ex/f' })
      await repo.insertPost(mkPost({ id: 'g1', authorId: a.id, guid: 'shared-guid' }))
      expect((await repo.findPostByRef('shared-guid'))?.id).toBe('g1')
      await repo.insertPost(mkPost({ id: 'g2', authorId: b.id, guid: 'shared-guid' })) // guid unique per (author,guid) only
      expect(await repo.findPostByRef('shared-guid')).toBeUndefined()
      expect(await repo.findPostByRef('nope')).toBeUndefined()
    })

    test('reply fields round-trip through insertPost/getPost and default to null', async () => {
      const repo = await makeRepo()
      const a = await repo.createLocalUser({ handle: 'a', displayName: 'A' })
      await repo.insertPost(mkPost({ id: 'root', authorId: a.id }))
      await repo.insertPost(mkPost({ id: 're', authorId: a.id, inReplyTo: 'root', inReplyToPostId: 'root', threadRootId: 'root' }))
      const re = await repo.getPost('re')
      expect([re?.inReplyTo, re?.inReplyToPostId, re?.threadRootId]).toEqual(['root', 'root', 'root'])
      const root = await repo.getPost('root')
      expect([root?.inReplyTo, root?.inReplyToPostId, root?.threadRootId]).toEqual([null, null, null])
    })

    test('getThread returns root + all descendants flat, (published_at, id) ASC', async () => {
      const repo = await makeRepo()
      const a = await repo.createLocalUser({ handle: 'a', displayName: 'A' })
      const day = (d: string) => `2026-01-0${d}T00:00:00.000Z`
      await repo.insertPost(mkPost({ id: 'root', authorId: a.id, publishedAt: day('1') }))
      await repo.insertPost(mkPost({ id: 'r1', authorId: a.id, publishedAt: day('2'), inReplyTo: 'root', inReplyToPostId: 'root', threadRootId: 'root' }))
      await repo.insertPost(mkPost({ id: 'r2', authorId: a.id, publishedAt: day('3'), inReplyTo: 'r1', inReplyToPostId: 'r1', threadRootId: 'root' }))
      await repo.insertPost(mkPost({ id: 'other', authorId: a.id, publishedAt: day('4') }))
      expect((await repo.getThread('root')).map((e) => e.id)).toEqual(['root', 'r1', 'r2'])
    })
```

Add `Post` to the contract file's type imports: `import type { Subscription, PushSubscription, Post } from './types.ts'`.

- [ ] **Step 4: Run — verify RED**

Run: `npm test -w core`
Expected: FAIL — `repo.findPostByRef is not a function` (and the reply-fields test fails on nulls).

- [ ] **Step 5: Implement in `core/src/storage/sqlite.ts`**

(a) Append the migration (fifth element of `MIGRATIONS`, after the follows entry):
```ts
  [
    'ALTER TABLE posts ADD COLUMN in_reply_to text',
    'ALTER TABLE posts ADD COLUMN in_reply_to_post_id text',
    'ALTER TABLE posts ADD COLUMN thread_root_id text',
    'CREATE INDEX posts_thread_idx ON posts (thread_root_id)',
    'CREATE INDEX posts_reply_to_idx ON posts (in_reply_to)',
    'CREATE INDEX posts_parent_idx ON posts (in_reply_to_post_id)',
  ],
```

(b) Extend `PostsTable`:
```ts
interface PostsTable { id: string; author_id: string; source: 'local' | 'remote'; guid: string; title: string | null; content: string; url: string | null; published_at: string; created_at: string; in_reply_to: string | null; in_reply_to_post_id: string | null; thread_root_id: string | null }
```

(c) Extend `rowToPost` (concrete nulls on read):
```ts
function rowToPost(r: PostsTable): Post {
  return { id: r.id, authorId: r.author_id, source: r.source, guid: r.guid, title: r.title, content: r.content, url: r.url, publishedAt: r.published_at, createdAt: r.created_at, inReplyTo: r.in_reply_to, inReplyToPostId: r.in_reply_to_post_id, threadRootId: r.thread_root_id }
}
```
`JoinedRow = PostsTable & …` picks the new columns up automatically; every `getTimeline`/`getThread` join must also SELECT nothing extra (`selectAll('posts')` already covers them).

(d) Extend `insertPost`'s `.values({ … })` with (normalize optionals):
```ts
in_reply_to: p.inReplyTo ?? null, in_reply_to_post_id: p.inReplyToPostId ?? null, thread_root_id: p.threadRootId ?? null,
```

(e) Add the two methods to `SqliteRepository` (after `getPostsByAuthor`):
```ts
  async findPostByRef(ref: string): Promise<Post | undefined> {
    // Pinned rule (spec H2 + Hole A): each arm matches ONLY when exactly one
    // row holds the ref — ambiguity resolves to nothing, never to an arbitrary row.
    const byUrl = await this.db.selectFrom('posts').selectAll().where('url', '=', ref).limit(2).execute()
    if (byUrl.length === 1) return rowToPost(byUrl[0])
    if (byUrl.length > 1) return undefined
    const byGuid = await this.db.selectFrom('posts').selectAll().where('guid', '=', ref).limit(2).execute()
    return byGuid.length === 1 ? rowToPost(byGuid[0]) : undefined
  }
  async getThread(rootId: string): Promise<TimelineEntry[]> {
    const rows = await this.db
      .selectFrom('posts')
      .innerJoin('users', 'users.id', 'posts.author_id')
      .selectAll('posts')
      .select(['users.id as u_id', 'users.kind as u_kind', 'users.handle as u_handle', 'users.display_name as u_display_name', 'users.feed_url as u_feed_url', 'users.created_at as u_created_at'])
      .where((eb) => eb.or([eb('posts.id', '=', rootId), eb('posts.thread_root_id', '=', rootId)]))
      .orderBy('posts.published_at', 'asc')
      .orderBy('posts.id', 'asc')
      .execute()
    return rows.map(joinedRowToEntry)
  }
```

- [ ] **Step 6: Run — verify GREEN + typecheck**

Run: `npm test -w core && npm run typecheck -w core`
Expected: PASS; typecheck exit 0. (Delete any dev DB if the runner uses a file — tests use `:memory:`, so normally nothing to do.)

- [ ] **Step 7: Commit**

```bash
git add core/src/domain/types.ts core/src/domain/repository.ts core/src/storage/sqlite.ts core/src/domain/repository-contract.ts
git commit -m "$(printf 'core: migration 5 — reply columns; findPostByRef (exactly-one rule) + getThread\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 2: adoptOrphans + reply-count/list queries

**Files:**
- Modify: `core/src/domain/repository.ts`, `core/src/storage/sqlite.ts`, `core/src/domain/repository-contract.ts`

**Interfaces:**
- Produces: `adoptOrphans(parent: Post): Promise<void>` — both-arm exactly-one guard; 1 adopt UPDATE + one re-root UPDATE per adopted orphan. `countRepliesByPostIds(ids: string[]): Promise<Map<string, number>>` and `listRepliesByPostId(id: string): Promise<Post[]>` — both key on `in_reply_to_post_id` ONLY.
- Consumes: Task 1's columns, `mkPost` contract helper.

- [ ] **Step 1: Interface additions** in `core/src/domain/repository.ts`:

```ts
  adoptOrphans(parent: Post): Promise<void>
  countRepliesByPostIds(ids: string[]): Promise<Map<string, number>>
  listRepliesByPostId(id: string): Promise<Post[]>
```

- [ ] **Step 2: Failing contract tests** (append inside the contract block):

```ts
    test('adoptOrphans attaches earlier orphans and re-roots their whole subtree', async () => {
      const repo = await makeRepo()
      const a = await repo.createRemoteUser({ handle: 'a', displayName: 'A', feedUrl: 'https://a.ex/f' })
      // Arrival order: reply-to-reply first, then reply, then the root (worst case).
      await repo.insertPost(mkPost({ id: 'rr', authorId: a.id, inReplyTo: 'https://a.ex/r1' }))
      await repo.insertPost(mkPost({ id: 'r1', authorId: a.id, url: 'https://a.ex/r1', inReplyTo: 'root-guid' }))
      await repo.adoptOrphans((await repo.getPost('r1'))!) // rr adopted by r1 (r1 is its own root for now)
      expect((await repo.getPost('rr'))?.threadRootId).toBe('r1')
      await repo.insertPost(mkPost({ id: 'root', authorId: a.id, guid: 'root-guid' }))
      await repo.adoptOrphans((await repo.getPost('root'))!)
      // r1 adopted by root; rr's subtree re-rooted to the TOP root in the same pass
      expect((await repo.getPost('r1'))?.threadRootId).toBe('root')
      expect((await repo.getPost('r1'))?.inReplyToPostId).toBe('root')
      expect((await repo.getPost('rr'))?.threadRootId).toBe('root')
      expect((await repo.getThread('root')).map((e) => e.id)).toEqual(['root', 'rr', 'r1'].sort((x, y) => x < y ? -1 : 1) === ['root', 'rr', 'r1'] ? ['root', 'rr', 'r1'] : (await repo.getThread('root')).map((e) => e.id))
    })

    test('adoption refuses ambiguous refs on BOTH arms (H2 + Hole A)', async () => {
      const repo = await makeRepo()
      const a = await repo.createRemoteUser({ handle: 'a', displayName: 'A', feedUrl: 'https://a.ex/f' })
      const b = await repo.createRemoteUser({ handle: 'b', displayName: 'B', feedUrl: 'https://b.ex/f' })
      await repo.insertPost(mkPost({ id: 'orphan', authorId: a.id, inReplyTo: 'dup-guid' }))
      await repo.insertPost(mkPost({ id: 'h1', authorId: a.id, guid: 'dup-guid' }))
      await repo.insertPost(mkPost({ id: 'h2', authorId: b.id, guid: 'dup-guid' }))
      await repo.adoptOrphans((await repo.getPost('h2'))!) // dup-guid held by h1 AND h2 → refuse
      expect((await repo.getPost('orphan'))?.inReplyToPostId).toBeNull()
      // url arm: same shape
      await repo.insertPost(mkPost({ id: 'orphan2', authorId: a.id, inReplyTo: 'https://dup.ex/1' }))
      await repo.insertPost(mkPost({ id: 'u1', authorId: a.id, url: 'https://dup.ex/1' }))
      await repo.insertPost(mkPost({ id: 'u2', authorId: b.id, url: 'https://dup.ex/1' }))
      await repo.adoptOrphans((await repo.getPost('u2'))!)
      expect((await repo.getPost('orphan2'))?.inReplyToPostId).toBeNull()
    })

    test('countRepliesByPostIds and listRepliesByPostId key on resolved ids only', async () => {
      const repo = await makeRepo()
      const a = await repo.createLocalUser({ handle: 'a', displayName: 'A' })
      await repo.insertPost(mkPost({ id: 'root', authorId: a.id }))
      await repo.insertPost(mkPost({ id: 'r1', authorId: a.id, publishedAt: '2026-01-02T00:00:00.000Z', inReplyTo: 'root', inReplyToPostId: 'root', threadRootId: 'root' }))
      await repo.insertPost(mkPost({ id: 'r2', authorId: a.id, publishedAt: '2026-01-03T00:00:00.000Z', inReplyTo: 'root', inReplyToPostId: 'root', threadRootId: 'root' }))
      // an UNRESOLVED reply whose raw ref happens to equal the root's guid must NOT count
      await repo.insertPost(mkPost({ id: 'stray', authorId: a.id, inReplyTo: 'root' }))
      const counts = await repo.countRepliesByPostIds(['root', 'r1'])
      expect(counts.get('root')).toBe(2)
      expect(counts.get('r1')).toBeUndefined()
      expect(await repo.countRepliesByPostIds([])).toEqual(new Map())
      expect((await repo.listRepliesByPostId('root')).map((p) => p.id)).toEqual(['r1', 'r2'])
    })
```

Fix the first test's last assertion — replace the self-referential line with the direct form:
```ts
      const ids = (await repo.getThread('root')).map((e) => e.id)
      expect(ids[0]).toBe('root')
      expect(ids).toHaveLength(3)
      expect(new Set(ids)).toEqual(new Set(['root', 'r1', 'rr']))
```
(All three share the same `published_at`, so assert membership + root-first, not a total order.)

- [ ] **Step 3: Run — verify RED**

Run: `npm test -w core`
Expected: FAIL — `repo.adoptOrphans is not a function`.

- [ ] **Step 4: Implement in `core/src/storage/sqlite.ts`** (after `getThread`):

```ts
  async adoptOrphans(parent: Post) {
    const newRoot = parent.threadRootId ?? parent.id
    for (const ref of [parent.url, parent.guid]) {
      if (!ref) continue
      // Exactly-one guard (both arms): adopt via this ref only when the parent is its sole holder.
      const urlHolders = await this.db.selectFrom('posts').select('id').where('url', '=', ref).limit(2).execute()
      const guidHolders = await this.db.selectFrom('posts').select('id').where('guid', '=', ref).limit(2).execute()
      const holders = new Set([...urlHolders, ...guidHolders].map((r) => r.id))
      if (holders.size > 1) continue
      const orphans = await this.db
        .selectFrom('posts').select('id')
        .where('in_reply_to', '=', ref)
        .where('in_reply_to_post_id', 'is', null)
        .where('id', '!=', parent.id)
        .execute()
      if (orphans.length === 0) continue
      await this.db.updateTable('posts')
        .set({ in_reply_to_post_id: parent.id, thread_root_id: newRoot })
        .where('id', 'in', orphans.map((o) => o.id))
        .execute()
      // One re-root UPDATE per adopted orphan — a loop, not a single second UPDATE.
      // Each sweep catches the orphan's WHOLE subtree because thread_root_id always
      // points at the top root, never an intermediate node.
      for (const o of orphans) {
        await this.db.updateTable('posts').set({ thread_root_id: newRoot }).where('thread_root_id', '=', o.id).execute()
      }
    }
  }
  async countRepliesByPostIds(ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map()
    const rows = await this.db
      .selectFrom('posts')
      .select('in_reply_to_post_id')
      .select(({ fn }) => fn.countAll().as('n'))
      .where('in_reply_to_post_id', 'in', ids)
      .groupBy('in_reply_to_post_id')
      .execute()
    return new Map(rows.map((r) => [r.in_reply_to_post_id as string, Number(r.n)]))
  }
  async listRepliesByPostId(id: string): Promise<Post[]> {
    const rows = await this.db.selectFrom('posts').selectAll()
      .where('in_reply_to_post_id', '=', id)
      .orderBy('published_at', 'asc').orderBy('id', 'asc')
      .execute()
    return rows.map(rowToPost)
  }
```

(The cross-arm holder check — url holders + guid holders of the same ref — also covers a remote guid equal to another post's url, per the spec's rule that resolution and adoption see the same ambiguity.)

- [ ] **Step 5: Run — verify GREEN + typecheck**

Run: `npm test -w core && npm run typecheck -w core`
Expected: PASS; typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add core/src/domain/repository.ts core/src/storage/sqlite.ts core/src/domain/repository-contract.ts
git commit -m "$(printf 'core: adoption engine + resolved-id reply queries\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 3: service + API — reply compose, resolution at ingest, thread endpoint

**Files:**
- Modify: `core/src/domain/service.ts`, `core/src/domain/ingest.ts`, `core/src/domain/discovery.ts`, `core/src/api/app.ts`
- Create: `core/test/api-threading.test.ts`

**Interfaces:**
- Produces: `service.createLocalPostAs(handle, displayName, content, replyTo?: Post)`; `service.getThread(rootId)`, `service.countRepliesByPostIds(ids)`, `service.listRepliesByPostId(id)` passthroughs. `ParsedItem` gains `inReplyTo: string | null`; `toParsedItem` gains a 7th parameter `inReplyTo: string | null` (all five call sites updated — the four in `parseFeedWithMeta` pass `null` in THIS task; Task 4 fills in real extraction; `discovery.ts` passes `null` here too). Routes: `POST /posts` accepts `inReplyTo` (post id, 404 unknown); `GET /post/:id/thread` → `{ thread: TimelineEntry[] }`.
- Consumes: Tasks 1–2 repo methods.

- [ ] **Step 1: Failing HTTP tests** — create `core/test/api-threading.test.ts`:

```ts
import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'

async function makeApp() {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const app = createApp({ service, bus, token: 'secret' })
  return { app, repo, service }
}
const auth = { authorization: 'Bearer secret', 'content-type': 'application/json' }

test('reply compose: stores refs, resolves parent, thread endpoint returns the conversation', async () => {
  const { app } = await makeApp()
  const root = await (await app.request('/posts', { method: 'POST', headers: auth, body: JSON.stringify({ handle: 'alice', content: 'root post' }) })).json()
  const re = await (await app.request('/posts', { method: 'POST', headers: auth, body: JSON.stringify({ handle: 'bob', content: 'a reply', inReplyTo: root.post.id }) })).json()
  expect(re.post.inReplyTo).toBe(root.post.guid) // local posts have url null → ref falls to guid
  expect(re.post.inReplyToPostId).toBe(root.post.id)
  expect(re.post.threadRootId).toBe(root.post.id)
  // thread endpoint works from BOTH the root id and the reply id
  for (const id of [root.post.id, re.post.id]) {
    const t = await (await app.request(`/post/${id}/thread`)).json()
    expect(t.thread.map((e: { id: string }) => e.id)).toEqual([root.post.id, re.post.id])
  }
})

test('reply compose errors: unknown target 404; thread of unknown post 404', async () => {
  const { app } = await makeApp()
  const res = await app.request('/posts', { method: 'POST', headers: auth, body: JSON.stringify({ handle: 'a', content: 'x', inReplyTo: 'ghost' }) })
  expect(res.status).toBe(404)
  expect((await app.request('/post/ghost/thread')).status).toBe(404)
})

test('reply-to-reply threads to the TOP root', async () => {
  const { app } = await makeApp()
  const root = await (await app.request('/posts', { method: 'POST', headers: auth, body: JSON.stringify({ handle: 'a', content: '1' }) })).json()
  const r1 = await (await app.request('/posts', { method: 'POST', headers: auth, body: JSON.stringify({ handle: 'b', content: '2', inReplyTo: root.post.id }) })).json()
  const r2 = await (await app.request('/posts', { method: 'POST', headers: auth, body: JSON.stringify({ handle: 'c', content: '3', inReplyTo: r1.post.id }) })).json()
  expect(r2.post.threadRootId).toBe(root.post.id) // not r1
  const t = await (await app.request(`/post/${root.post.id}/thread`)).json()
  expect(t.thread).toHaveLength(3)
})
```

- [ ] **Step 2: Run — verify RED**

Run: `npm test -w core`
Expected: FAIL — reply fields null / thread route 404s.

- [ ] **Step 3: `ParsedItem` + `toParsedItem` 7th param (nulls for now)** — in `core/src/domain/ingest.ts`:

```ts
export interface ParsedItem { guid: string; title: string | null; content: string; url: string | null; publishedAt: string; inReplyTo: string | null }
```
```ts
export function toParsedItem(guid: string | undefined, title: string | null, content: string, url: string | null, rawDate: string, now: string, inReplyTo: string | null = null): ParsedItem {
  return { guid: guid ?? url ?? fallbackGuid(title, content, rawDate), title, content, url, publishedAt: toIsoOrNow(rawDate, now), inReplyTo }
}
```
(Defaulted parameter — the five existing call sites in `parseFeedWithMeta`/`discovery.ts` compile unchanged and yield `inReplyTo: null`; Task 4 threads the real values.)

- [ ] **Step 4: Resolution in `ingestItems`** — replace the loop body's post construction in `core/src/domain/ingest.ts`:

```ts
  for (const item of items) {
    const now = new Date()
    const publishedAt = new Date(item.publishedAt).getTime() > now.getTime() ? now.toISOString() : item.publishedAt
    // Resolve once (spec H2): the wire ref is matched here and never again.
    const target = item.inReplyTo ? await repo.findPostByRef(item.inReplyTo) : undefined
    const post: Post = {
      id: randomUUID(), authorId: user.id, source: 'remote', guid: item.guid, title: item.title,
      content: item.content, url: item.url, publishedAt, createdAt: now.toISOString(),
      inReplyTo: item.inReplyTo, inReplyToPostId: target?.id ?? null,
      threadRootId: target ? target.threadRootId ?? target.id : null,
    }
    if (await repo.insertPost(post)) {
      await repo.adoptOrphans(post)
      if (!backfill) bus.emitNewPost({ ...post, author: user })
      inserted++
    }
  }
```

- [ ] **Step 5: Service** — in `core/src/domain/service.ts`, extend `createLocalPostAs` and add passthroughs:

```ts
    async createLocalPostAs(handle: string, displayName: string, content: string, replyTo?: Post): Promise<TimelineEntry> {
      const author = await ensureLocalUser(handle, displayName)
      const now = new Date().toISOString()
      const post: Post = {
        id: randomUUID(), authorId: author.id, source: 'local', guid: randomUUID(), title: null, content, url: null,
        publishedAt: now, createdAt: now,
        inReplyTo: replyTo ? replyTo.url ?? replyTo.guid : null,
        inReplyToPostId: replyTo?.id ?? null, // local replies are resolved by construction
        threadRootId: replyTo ? replyTo.threadRootId ?? replyTo.id : null,
      }
      await repo.insertPost(post)
      await repo.adoptOrphans(post)
      const entry: TimelineEntry = { ...post, author }
      bus.emitNewPost(entry)
      return entry
    },
```
and (near `getPost`):
```ts
    getThread(rootId: string) {
      return repo.getThread(rootId)
    },
    countRepliesByPostIds(ids: string[]) {
      return repo.countRepliesByPostIds(ids)
    },
    listRepliesByPostId(id: string) {
      return repo.listRepliesByPostId(id)
    },
```

- [ ] **Step 6: Routes** — in `core/src/api/app.ts`, extend `POST /posts` (insert the `inReplyTo` handling before the `createLocalPostAs` call):

```ts
    const { handle, displayName, content, inReplyTo } = body
    // …existing handle/displayName/content validation stays…
    if (inReplyTo !== undefined && !isString(inReplyTo, 1, 64)) return c.json({ error: 'inReplyTo invalid' }, 400)
    let replyTarget
    if (typeof inReplyTo === 'string') {
      replyTarget = await service.getPost(inReplyTo)
      if (!replyTarget) return c.json({ error: 'unknown post' }, 404)
    }
    const post = await service.createLocalPostAs(handle, effectiveDisplayName, content, replyTarget)
```
and add the thread route (after the `GET /users/:handle/follows` block):
```ts
  app.get('/post/:id/thread', async (c) => {
    const post = await service.getPost(c.req.param('id') ?? '')
    if (!post) return c.json({ error: 'unknown post' }, 404)
    const thread = await service.getThread(post.threadRootId ?? post.id)
    return c.json({ thread })
  })
```

- [ ] **Step 7: Run — verify GREEN + typecheck**

Run: `npm test -w core && npm run typecheck -w core`
Expected: PASS (new tests + whole suite — the ingest changes are null-inert until Task 4); typecheck exit 0.

- [ ] **Step 8: Commit**

```bash
git add core/src/domain/service.ts core/src/domain/ingest.ts core/src/api/app.ts core/test/api-threading.test.ts
git commit -m "$(printf 'core: reply compose + resolve-once ingest wiring + thread endpoint\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 4: wire in/out — source:inReplyTo + thr: emit, three-path extraction

**Files:**
- Modify: `core/src/domain/ingest.ts` (extraction), `core/src/domain/discovery.ts` (JF2), `core/src/domain/feed.ts` (emit), `core/src/domain/mf2tojf2.d.ts` (`in-reply-to` field)
- Create: `core/test/threading.test.ts`

**Interfaces:**
- Produces: RSS/Atom/mf2 items carry `inReplyTo` into `ParsedItem`; `renderRssFeed` reply items emit `source:inReplyTo` (with `isPermaLink="false"` for non-http refs) + `thr:in-reply-to`. Exports `replyWireElements(ref: string)` from `feed.ts` (reused by Task 5's comments feed).
- Consumes: Task 3's `toParsedItem(…, inReplyTo)` param.

- [ ] **Step 1: Failing unit tests** — create `core/test/threading.test.ts`:

```ts
import { test, expect } from 'vitest'
import { parseFeedWithMeta } from '../src/domain/ingest.ts'
import { discoverFeed } from '../src/domain/discovery.ts'
import { renderRssFeed } from '../src/domain/feed.ts'
import type { User, Post } from '../src/domain/types.ts'

const RSS_NS = 'xmlns:source="http://source.scripting.com/" xmlns:thr="http://purl.org/syndication/thread/1.0"'

test('RSS in: source:inReplyTo preferred, thr fallback', async () => {
  const both = `<?xml version="1.0"?><rss version="2.0" ${RSS_NS}><channel><title>t</title>
    <item><guid>g1</guid><description>d</description><source:inReplyTo>https://a.ex/1</source:inReplyTo><thr:in-reply-to ref="WRONG"/></item>
    <item><guid>g2</guid><description>d</description><thr:in-reply-to ref="https://a.ex/2" href="https://a.ex/2"/></item>
    <item><guid>g3</guid><description>d</description></item>
  </channel></rss>`
  const { items } = await parseFeedWithMeta(both)
  expect(items.map((i) => i.inReplyTo)).toEqual(['https://a.ex/1', 'https://a.ex/2', null])
})

test('Atom in: thr:in-reply-to ref', async () => {
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:thr="http://purl.org/syndication/thread/1.0"><title>t</title>
    <entry><id>e1</id><title>re</title><content>c</content><updated>2026-01-01T00:00:00Z</updated><thr:in-reply-to ref="https://a.ex/1"/></entry></feed>`
  const { items } = await parseFeedWithMeta(atom)
  expect(items[0].inReplyTo).toBe('https://a.ex/1')
})

test('mf2 in: u-in-reply-to as string and as array', () => {
  const single = `<div class="h-entry"><a class="u-in-reply-to" href="https://a.ex/1">re</a><p class="e-content">agree</p></div>`
  const multi = `<div class="h-entry"><a class="u-in-reply-to" href="https://a.ex/1">re</a><a class="u-in-reply-to" href="https://a.ex/2">re2</a><p class="e-content">agree</p></div>`
  expect(discoverFeed(single, 'https://b.ex/').hentries[0].inReplyTo).toBe('https://a.ex/1')
  expect(discoverFeed(multi, 'https://b.ex/').hentries[0].inReplyTo).toBe('https://a.ex/1')
})

const user: User = { id: 'u1', kind: 'local', handle: 'alice', displayName: 'Alice', feedUrl: null, createdAt: '2026-01-01T00:00:00.000Z' }
const post = (over: Partial<Post>): Post => ({ id: 'p1', authorId: 'u1', source: 'local', guid: 'guid-1', title: null, content: 'c', url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', ...over })
const ctx = { publicUrl: 'https://cast.example', hubUrl: null, rssCloud: false }

test('RSS out: reply items dual-emit; bare-guid ref carries isPermaLink=false; non-replies emit neither', () => {
  const xml = renderRssFeed(user, [post({ inReplyTo: 'https://a.ex/1' }), post({ id: 'p2', guid: 'guid-2', inReplyTo: 'bare-guid-ref' }), post({ id: 'p3', guid: 'guid-3' })], ctx)
  expect(xml).toContain('<source:inReplyTo>https://a.ex/1</source:inReplyTo>')
  expect(xml).toContain('<thr:in-reply-to ref="https://a.ex/1" href="https://a.ex/1"/>')
  expect(xml).toContain('<source:inReplyTo isPermaLink="false">bare-guid-ref</source:inReplyTo>')
  expect(xml.match(/source:inReplyTo/g)!.length).toBe(4) // 2 open + 2 close tags — p3 emits none
})
```

- [ ] **Step 2: Run — verify RED**

Run: `npm test -w core`
Expected: FAIL — `inReplyTo` is null everywhere / no source elements emitted.

- [ ] **Step 3: Extraction** — in `core/src/domain/ingest.ts`, add one helper above `parseFeedWithMeta`:

```ts
// source:inReplyTo (Textcasting) preferred, thr:in-reply-to (RFC 4685) fallback.
// Shapes probed against feedsmith 2.9.6; Atom exposes thr only (no sourceNs).
function itemInReplyTo(it: { sourceNs?: { inReplyTo?: { value?: string } }; thr?: { inReplyTos?: Array<{ ref?: string; href?: string }> } }): string | null {
  return it.sourceNs?.inReplyTo?.value ?? it.thr?.inReplyTos?.[0]?.ref ?? it.thr?.inReplyTos?.[0]?.href ?? null
}
```
Then thread it through the RSS and Atom mappers (the JSON Feed and RDF mappers keep the default `null` — no readable reply field exists there):
```ts
  if (parsed.format === 'atom') {
    const items = (parsed.feed.entries ?? []).map((it) => {
      const url = it.links?.find((l) => l.href && (!l.rel || l.rel === 'alternate'))?.href ?? null
      return toParsedItem(it.id, it.title ?? null, it.content ?? it.summary ?? '', url, it.published ?? it.updated ?? '', now, itemInReplyTo(it))
    })
    return { items, discovery: { ...linksToDiscovery(parsed.feed.links), cloud: null } }
  }
```
```ts
  const items = (parsed.feed.items ?? []).map((it) =>
    toParsedItem(it.guid?.value, it.title ?? null, it.description ?? it.content?.encoded ?? '', it.link ?? null, it.pubDate ?? '', now, itemInReplyTo(it)))
```
(If `itemInReplyTo`'s parameter type fights feedsmith's item types, accept the item as a structural parameter exactly as written — it is deliberately minimal.)

- [ ] **Step 4: JF2** — in `core/src/domain/mf2tojf2.d.ts`, add to `Jf2`:
```ts
    'in-reply-to'?: string | string[]
```
In `core/src/domain/discovery.ts`, inside the `.map((e) => { … })`, add before the `return`:
```ts
      const irt = e['in-reply-to']
      const inReplyTo = Array.isArray(irt) ? (typeof irt[0] === 'string' ? irt[0] : null) : typeof irt === 'string' ? irt : null
```
and pass it as `toParsedItem(e.uid ?? e.url, title, content, e.url ?? null, rawDate, now, inReplyTo)`.

- [ ] **Step 5: Emit** — in `core/src/domain/feed.ts`, add (exported — Task 5 reuses it):

```ts
// Dual-emit reply metadata: source:inReplyTo (Textcasting; isPermaLink=false for
// non-permalink refs, per source-namespace docs) + thr:in-reply-to (RFC 4685).
export function replyWireElements(ref: string) {
  const isUrl = ref.startsWith('http://') || ref.startsWith('https://')
  return {
    sourceNs: { inReplyTo: { value: ref, ...(isUrl ? {} : { isPermaLink: false }) } },
    thr: { inReplyTos: [{ ref, ...(isUrl ? { href: ref } : {}) }] },
  }
}
```
and in `renderRssFeed`'s `items:` mapping add one spread line:
```ts
      items: posts.map((p) => ({
        ...(p.title !== null ? { title: p.title } : {}), // Textcasting: never synthesize a title
        description: p.content,
        guid: { value: p.guid, isPermaLink: false },
        ...(p.url !== null ? { link: p.url } : {}),
        pubDate: p.publishedAt,
        ...(p.inReplyTo ? replyWireElements(p.inReplyTo) : {}),
      })),
```

- [ ] **Step 6: Run — verify GREEN + typecheck**

Run: `npm test -w core && npm run typecheck -w core`
Expected: PASS; typecheck exit 0.

- [ ] **Step 7: Commit**

```bash
git add core/src/domain/ingest.ts core/src/domain/discovery.ts core/src/domain/mf2tojf2.d.ts core/src/domain/feed.ts core/test/threading.test.ts
git commit -m "$(printf 'core: reply wire — source:inReplyTo/thr dual-emit; RSS+Atom+mf2 extraction\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 5: comments feed + source:comments injector

**Files:**
- Modify: `core/src/domain/feed.ts`, `core/src/api/app.ts`
- Modify: `core/test/threading.test.ts` (append)

**Interfaces:**
- Produces: `renderCommentsFeed(post: Post, replies: Post[], ctx: FeedContext): string` (plain RSS, one item per direct reply, each with its own reply wire elements); `injectSourceComments(xml: string, ads: Array<{ guid: string; count: number; feedUrl: string }>): string` (guid-keyed insertion before the matching `</item>`, declares `xmlns:source` on `<rss` when absent). Route `GET /post/:id/comments.xml`. `GET /users/:handle/feed.xml` now injects `source:comments` for items with replies (only when `ctx.publicUrl`).
- Consumes: Task 2's `countRepliesByPostIds`/`listRepliesByPostId`, Task 4's `replyWireElements`.

- [ ] **Step 1: Failing tests** — append to `core/test/threading.test.ts`:

```ts
import { renderCommentsFeed, injectSourceComments } from '../src/domain/feed.ts'

test('injectSourceComments: lands inside the RIGHT item, declares xmlns:source when absent', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel><title>t</title><link>x</link><description>d</description>
    <item><title>one</title><guid isPermaLink="false">g-one</guid></item>
    <item><title>two</title><guid isPermaLink="false">g-two</guid></item>
  </channel>
</rss>`
  const out = injectSourceComments(xml, [{ guid: 'g-two', count: 3, feedUrl: 'https://cast.example/post/p2/comments.xml' }])
  expect(out).toContain('xmlns:source="http://source.scripting.com/"')
  const itemTwo = out.slice(out.indexOf('g-two'))
  expect(itemTwo).toContain('<source:comments count="3" feedUrl="https://cast.example/post/p2/comments.xml"/>')
  expect(out.slice(0, out.indexOf('g-two'))).not.toContain('source:comments') // not in item one
  expect(injectSourceComments(xml, [])).toBe(xml) // no ads → untouched
})

test('renderCommentsFeed: one item per reply, each with its own inReplyTo elements', () => {
  const parent = post({ id: 'root', guid: 'root-guid', title: 'Root', content: 'root body' })
  const replies = [
    post({ id: 'c1', guid: 'c1-guid', content: 'first reply', inReplyTo: 'root-guid', publishedAt: '2026-01-02T00:00:00.000Z' }),
    post({ id: 'c2', guid: 'c2-guid', content: 'second reply', inReplyTo: 'root-guid', publishedAt: '2026-01-03T00:00:00.000Z' }),
  ]
  const xml = renderCommentsFeed(parent, replies, ctx)
  expect(xml).toContain('Comments on')
  expect(xml.match(/<item>/g)!.length).toBe(2)
  expect(xml).toContain('first reply')
  expect(xml.match(/<source:inReplyTo isPermaLink="false">root-guid<\/source:inReplyTo>/g)!.length).toBe(2)
})
```

- [ ] **Step 2: Run — verify RED**

Run: `npm test -w core`
Expected: FAIL — cannot import `renderCommentsFeed`/`injectSourceComments`.

- [ ] **Step 3: Implement in `core/src/domain/feed.ts`**:

```ts
const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const xmlAttrEscape = (s: string) => xmlEscape(s).replace(/"/g, '&quot;')

// feedsmith 2.9.6 cannot serialize <source:comments count feedUrl/> (probed —
// silently dropped), so it is injected into XML WE generated: feedsmith's item
// output is deterministic, and guids are matched as the <guid> ELEMENT value.
// ponytail: delete this the day feedsmith's sourceNs types grow `comments`.
export function injectSourceComments(xml: string, ads: Array<{ guid: string; count: number; feedUrl: string }>): string {
  let out = xml
  let injected = false
  for (const ad of ads) {
    const marker = `>${xmlEscape(ad.guid)}</guid>`
    const at = out.indexOf(marker)
    if (at === -1) continue
    const close = out.indexOf('</item>', at)
    if (close === -1) continue
    out = out.slice(0, close) + `<source:comments count="${ad.count}" feedUrl="${xmlAttrEscape(ad.feedUrl)}"/>` + out.slice(close)
    injected = true
  }
  if (injected && !out.includes('xmlns:source=')) {
    out = out.replace('<rss ', '<rss xmlns:source="http://source.scripting.com/" ')
  }
  return out
}

export function renderCommentsFeed(post: Post, replies: Post[], ctx: FeedContext): string {
  const label = post.title ?? (post.content.length > 60 ? `${post.content.slice(0, 60)}…` : post.content)
  return generateRssFeed(
    {
      title: `Comments on "${label}"`,
      link: post.url ?? channelLink(ctx, ''),
      description: `Replies to "${label}"`,
      items: replies.map((p) => ({
        ...(p.title !== null ? { title: p.title } : {}),
        description: p.content,
        guid: { value: p.guid, isPermaLink: false },
        ...(p.url !== null ? { link: p.url } : {}),
        pubDate: p.publishedAt,
        ...(p.inReplyTo ? replyWireElements(p.inReplyTo) : {}),
      })),
    },
    { lenient: true },
  )
}
```
(`channelLink` already exists in `feed.ts` — reuse; check its signature and pass what the file's other caller passes for a non-user context, adjusting the second argument if it requires a handle: `channelLink(ctx, post.authorId)` is NOT meaningful — if `channelLink` demands a handle, use `ctx.publicUrl ?? ''` directly for `link` instead. Match the file.)

- [ ] **Step 4: Routes** — in `core/src/api/app.ts`:

Comments feed (after the thread route):
```ts
  app.get('/post/:id/comments.xml', async (c) => {
    const post = await service.getPost(c.req.param('id') ?? '')
    if (!post) return c.json({ error: 'unknown post' }, 404)
    const replies = await service.listRepliesByPostId(post.id)
    const counts = await service.countRepliesByPostIds(replies.map((r) => r.id))
    let xml = renderCommentsFeed(post, replies, feeds)
    if (feeds.publicUrl) {
      const pub = feeds.publicUrl
      xml = injectSourceComments(xml, replies.filter((r) => (counts.get(r.id) ?? 0) > 0)
        .map((r) => ({ guid: r.guid, count: counts.get(r.id)!, feedUrl: `${pub}/post/${r.id}/comments.xml` })))
    }
    return c.body(xml, 200, { 'content-type': 'application/rss+xml; charset=utf-8' })
  })
```
Main feed injection — in the existing `GET /users/:handle/feed.xml` handler, replace the return with:
```ts
    let xml = renderRssFeed(r.user, posts, feeds)
    if (feeds.publicUrl) {
      const pub = feeds.publicUrl
      const counts = await service.countRepliesByPostIds(posts.map((p) => p.id))
      xml = injectSourceComments(xml, posts.filter((p) => (counts.get(p.id) ?? 0) > 0)
        .map((p) => ({ guid: p.guid, count: counts.get(p.id)!, feedUrl: `${pub}/post/${p.id}/comments.xml` })))
    }
    return c.body(xml, 200, { 'content-type': 'application/rss+xml; charset=utf-8' })
```
Import `renderCommentsFeed, injectSourceComments` alongside the existing `renderRssFeed` import.

- [ ] **Step 5: HTTP test** — append to `core/test/api-threading.test.ts`:

```ts
test('comments.xml serves direct replies; feed.xml advertises source:comments', async () => {
  const { app } = await makeApp()
  // makeApp has no publicUrl — rebuild with one for this test
  const repo2 = await createSqliteRepository(':memory:')
  const bus2 = createEventBus()
  const service2 = createService(repo2, bus2)
  const app2 = createApp({ service: service2, bus: bus2, token: 'secret', feeds: { publicUrl: 'https://cast.example', hubUrl: null, rssCloud: false } })
  const root = await (await app2.request('/posts', { method: 'POST', headers: auth, body: JSON.stringify({ handle: 'alice', content: 'root' }) })).json()
  await app2.request('/posts', { method: 'POST', headers: auth, body: JSON.stringify({ handle: 'bob', content: 'the reply', inReplyTo: root.post.id }) })
  const comments = await (await app2.request(`/post/${root.post.id}/comments.xml`)).text()
  expect(comments).toContain('the reply')
  const feed = await (await app2.request('/users/alice/feed.xml')).text()
  expect(feed).toContain(`<source:comments count="1" feedUrl="https://cast.example/post/${root.post.id}/comments.xml"/>`)
  expect((await app2.request('/post/ghost/comments.xml')).status).toBe(404)
  void app // silence unused
})
```

- [ ] **Step 6: Run — verify GREEN + typecheck**

Run: `npm test -w core && npm run typecheck -w core`
Expected: PASS; typecheck exit 0.

- [ ] **Step 7: Commit**

```bash
git add core/src/domain/feed.ts core/src/api/app.ts core/test/threading.test.ts core/test/api-threading.test.ts
git commit -m "$(printf 'core: per-post comments feeds + source:comments injection\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 6: web — reply buttons, thread page, live thread lens

**REQUIRED before writing markup:** invoke `ui-ux-pro-max:ui-ux-pro-max` (per CLAUDE.md + `design-system/textcaster/MASTER.md`). Markup below is functional; the design pass refines styling only.

**Files:**
- Modify: `web/src/lib/types.ts`, `web/src/lib/api.ts`, `web/src/lib/lens.ts`, `web/src/lib/lens.test.ts`, `web/src/routes/+page.svelte`
- Create: `web/src/routes/post/[id]/+page.server.ts`, `web/src/routes/post/[id]/+page.svelte`

**Interfaces:**
- Produces: thread page at `/post/<id>` (SSR conversation + no-JS reply form + live island), reply links + thread markers on the home timeline (mirror the same two-line change on `web/src/routes/u/[handle]/+page.svelte` and `.../following/+page.svelte`).
- Consumes: core `GET /post/:id/thread`, `POST /posts` with `inReplyTo`.

- [ ] **Step 1: Wire types** — in `web/src/lib/types.ts` add to `TimelineEntry`:
```ts
	inReplyTo?: string | null
	inReplyToPostId?: string | null
	threadRootId?: string | null
```

- [ ] **Step 2: Lens predicate test first** — append to `web/src/lib/lens.test.ts`:
```ts
test('thread lens keeps the root and its descendants only', () => {
  const lens = { kind: 'thread' as const, rootId: 'root' }
  expect(keepEvent({ ...entry('a'), id: 'root' }, lens)).toBe(true)
  expect(keepEvent({ ...entry('a'), threadRootId: 'root' }, lens)).toBe(true)
  expect(keepEvent(entry('a'), lens)).toBe(false)
})
```
Run `npm test -w web` — FAIL (type error / false). Then in `web/src/lib/lens.ts`:
```ts
export type Lens =
	| { kind: 'author'; authorId: string }
	| { kind: 'followed'; followIds: Set<string> }
	| { kind: 'thread'; rootId: string }

export function keepEvent(entry: TimelineEntry, lens: Lens): boolean {
	if (lens.kind === 'author') return entry.author.id === lens.authorId
	if (lens.kind === 'thread') return entry.id === lens.rootId || entry.threadRootId === lens.rootId
	return lens.followIds.has(entry.author.id)
}
```
Run `npm test -w web` — PASS.

- [ ] **Step 3: api client** — in `web/src/lib/api.ts`: extend `createPost`'s input and body with optional `inReplyTo` (add `inReplyTo?: string` to its params type and include it in the JSON body when set — match the existing function's shape), and add:
```ts
export async function getThread(f: typeof fetch, id: string): Promise<TimelineEntry[]> {
	const res = await f(`${base()}/post/${encodeURIComponent(id)}/thread`)
	if (!res.ok) throw new Error(await errorMessage(res, `thread ${res.status}`))
	return (await res.json()).thread
}
```

- [ ] **Step 4: Thread page** — create `web/src/routes/post/[id]/+page.server.ts`:
```ts
import type { PageServerLoad, Actions } from './$types'
import { fail, redirect } from '@sveltejs/kit'
import { getThread, createPost } from '$lib/api'

export const load: PageServerLoad = async ({ fetch, params }) => {
	try {
		const thread = await getThread(fetch, params.id)
		return { postId: params.id, thread, rootId: thread[0]?.id ?? params.id }
	} catch {
		return { postId: params.id, thread: [], rootId: params.id, coreDown: true }
	}
}

export const actions = {
	reply: async ({ request, fetch, params }) => {
		const form = await request.formData()
		const handle = String(form.get('handle') ?? '').trim()
		const content = String(form.get('content') ?? '').trim()
		if (!handle || !content) return fail(400, { error: 'handle and content are required' })
		try {
			await createPost(fetch, { handle, displayName: handle, content, inReplyTo: params.id })
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'reply failed' })
		}
		throw redirect(303, `/post/${params.id}`)
	}
} satisfies Actions
```
Create `web/src/routes/post/[id]/+page.svelte`:
```svelte
<script lang="ts">
	import type { PageData, ActionData } from './$types'
	import type { TimelineEntry } from '$lib/types'
	import LiveTimeline from '$lib/LiveTimeline.svelte'
	import { keepEvent } from '$lib/lens'
	import { plaintext } from '$lib/plaintext'

	let { data, form }: { data: PageData; form: ActionData } = $props()
	let live = $state<TimelineEntry[]>([])
	const posts = $derived([...data.thread, ...live])
	function onPost(entry: TimelineEntry) {
		if (keepEvent(entry, { kind: 'thread', rootId: data.rootId }) && !posts.some((p) => p.id === entry.id)) live = [...live, entry]
	}
</script>

<LiveTimeline {onPost} />

<h1>Conversation</h1>
{#if data.coreDown}<p role="alert">Core API unreachable.</p>{/if}
{#if form?.error}<p role="alert">{form.error}</p>{/if}

<ul class="timeline">
	{#each posts as post (post.id)}
		<li class="post" class:remote={post.source === 'remote'} class:highlight={post.id === data.postId}>
			<div class="byline"><a href="/u/{post.author.handle}">@{post.author.handle}</a></div>
			{#if post.title}<h2>{post.title}</h2>{/if}
			<p>{plaintext(post.content)}</p>
			{#if post.url}<a href={post.url} rel="noreferrer">source</a>{/if}
		</li>
	{:else}
		<li class="timeline-empty">No such conversation.</li>
	{/each}
</ul>

<form method="POST" action="?/reply">
	<input name="handle" placeholder="your handle" required />
	<textarea name="content" placeholder="write a reply" required></textarea>
	<button>Reply</button>
</form>
```
(Thread pages append live replies at the END — conversations read oldest-first, unlike the timeline's newest-first prepends.)

- [ ] **Step 5: Reply links + markers on the timeline** — in `web/src/routes/+page.svelte`, inside the post `<li>` markup add (after the content `<p>`):
```svelte
			<a href="/post/{post.id}">{post.threadRootId || post.inReplyToPostId ? 'View conversation' : 'Reply'}</a>
			{#if post.inReplyTo && !post.inReplyToPostId && post.inReplyTo.startsWith('http')}
				<a href={post.inReplyTo} rel="noreferrer">in reply to ↗</a>
			{/if}
```
Apply the same two-line block to `web/src/routes/u/[handle]/+page.svelte` and `web/src/routes/u/[handle]/following/+page.svelte` post items.

- [ ] **Step 6: Run web gates**

Run: `npm test -w web && npm run check -w web`
Expected: PASS; svelte-check 0 errors.

- [ ] **Step 7: Commit**

```bash
git add web/src
git commit -m "$(printf 'web: thread page, reply compose, conversation markers, live thread lens\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 7: federation money test + RUNNING.md + whole-milestone gates

**Files:**
- Create: `core/test/federation-threading.test.ts`
- Modify: `docs/superpowers/documentation/RUNNING.md`

**Interfaces:**
- Consumes everything above. No new production code — if the money test fails, fix the offending task's code; do not weaken the test.

- [ ] **Step 1: The money test** — create `core/test/federation-threading.test.ts`:

```ts
import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'
import { ingestRemoteUser } from '../src/domain/ingest.ts'

async function instance(publicUrl: string) {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const app = createApp({ service, bus, token: 'secret', feeds: { publicUrl, hubUrl: null, rssCloud: false } })
  // fetchFn that serves this instance's own routes for its public origin
  const serve = (base: string) => async (url: string | URL | Request) => {
    const u = new URL(String(url))
    return app.request(u.pathname + u.search)
  }
  return { repo, bus, service, app, serve }
}
const auth = { authorization: 'Bearer secret', 'content-type': 'application/json' }

test('MONEY TEST: a conversation federates over plain RSS, round trip, threadwalker-walkable', async () => {
  const A = await instance('https://a.example')
  const B = await instance('https://b.example')

  // A: alice posts
  const orig = await (await A.app.request('/posts', { method: 'POST', headers: auth, body: JSON.stringify({ handle: 'alice', content: 'hello from A' }) })).json()

  // B follows alice's feed and ingests the post
  const aliceOnB = await B.repo.createRemoteUser({ handle: 'alice-a', displayName: 'Alice', feedUrl: 'https://a.example/users/alice/feed.xml' })
  await ingestRemoteUser(B.repo, B.bus, aliceOnB, A.serve('https://a.example') as unknown as typeof fetch)
  const ingested = (await B.repo.getTimeline(10)).find((e) => e.content === 'hello from A')!

  // B: bob replies via the reply button (target = the ingested copy)
  await B.app.request('/posts', { method: 'POST', headers: auth, body: JSON.stringify({ handle: 'bob', content: 'reply from B', inReplyTo: ingested.id }) })

  // B's feed carries both reply forms
  const bobFeed = await (await B.app.request('/users/bob/feed.xml')).text()
  expect(bobFeed).toContain(`<source:inReplyTo isPermaLink="false">${orig.post.guid}</source:inReplyTo>`) // local posts have no url → guid ref
  expect(bobFeed).toContain('<thr:in-reply-to')

  // A ingests bob's feed → the reply resolves to alice's original by guid
  const bobOnA = await A.repo.createRemoteUser({ handle: 'bob-b', displayName: 'Bob', feedUrl: 'https://b.example/users/bob/feed.xml' })
  await ingestRemoteUser(A.repo, A.bus, bobOnA, B.serve('https://b.example') as unknown as typeof fetch)

  const thread = await (await A.app.request(`/post/${orig.post.id}/thread`)).json()
  expect(thread.thread.map((e: { content: string }) => e.content)).toEqual(['hello from A', 'reply from B'])

  // Winer-native pull side: A's feed advertises the conversation…
  const aliceFeed = await (await A.app.request('/users/alice/feed.xml')).text()
  expect(aliceFeed).toContain(`<source:comments count="1" feedUrl="https://a.example/post/${orig.post.id}/comments.xml"/>`)
  // …and the advertised comments feed serves the reply (threadwalker-walkable)
  const comments = await (await A.app.request(`/post/${orig.post.id}/comments.xml`)).text()
  expect(comments).toContain('reply from B')
})

test('mf2 sibling: an h-entry reply with u-in-reply-to threads on ingest', async () => {
  const A = await instance('https://a.example')
  const orig = await A.repo.createRemoteUser({ handle: 'orig', displayName: 'O', feedUrl: 'https://o.ex/feed.xml' })
  await A.repo.insertPost({ id: 'op', authorId: orig.id, source: 'remote', guid: 'op-guid', title: null, content: 'original', url: 'https://o.ex/1', publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
  const indie = await A.repo.createRemoteUser({ handle: 'indie', displayName: 'I', feedUrl: 'https://indie.ex/' })
  const html = `<html><body><div class="h-feed"><div class="h-entry"><a class="u-in-reply-to" href="https://o.ex/1">re</a><p class="e-content">indie reply</p><a class="u-url" href="https://indie.ex/n1">l</a></div></div></body></html>`
  const fetchFn = (async () => new Response(html, { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch
  await ingestRemoteUser(A.repo, A.bus, indie, fetchFn)
  const thread = await (await A.app.request('/post/op/thread')).json()
  expect(thread.thread.map((e: { content: string }) => e.content)).toEqual(['original', 'indie reply'])
})
```

- [ ] **Step 2: Run — verify GREEN (or fix the wiring it exposes)**

Run: `npm test -w core && npm run typecheck -w core`
Expected: PASS. A failure here is a bug in Tasks 1–5 — fix there.

- [ ] **Step 3: RUNNING.md** — add a "Replies & conversations" section after "Following & lenses": reply from any post ("Reply"/"View conversation" → `/post/<id>`, plain form, no JS needed); replies federate as `source:inReplyTo` (Textcasting) + `thr:in-reply-to` in RSS and are ingested from RSS/Atom (`source:`/`thr:`) and IndieWeb h-entry `u-in-reply-to`; every post with replies advertises `<source:comments count feedUrl>` pointing at `GET /post/<id>/comments.xml` (needs `TEXTCASTER_PUBLIC_URL`); `GET /post/<id>/thread` returns the conversation as JSON.

- [ ] **Step 4: Whole-milestone gates**

Run: `npm test -w core && npm run typecheck -w core && npm test -w web && npm run check -w web`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add core/test/federation-threading.test.ts docs/superpowers/documentation/RUNNING.md
git commit -m "$(printf 'core: threading money test — federated conversation round trip; docs\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

## Self-Review (done at plan-writing time)

- **Spec coverage:** migration 5 + resolve-once columns → Task 1; pinned exactly-one rule both arms (H2 + Hole A) → Tasks 1–2; adoption (adopt UPDATE + per-orphan re-root loop) → Task 2; resolved-id counts/replies → Task 2; reply compose (resolved by construction) + ingest resolution + thread endpoint → Task 3; dual-emit incl. `isPermaLink="false"` + three-path extraction (Atom = thr only) → Task 4; comments feed + injector (+ namespace declaration when no reply items exist) → Task 5; web (thread page, markers, `in reply to ↗` for unresolved http refs, thread lens) → Task 6; money test with the Winer-native ending + mf2 sibling + RUNNING.md → Task 7. Hole B (temporal collision) is an accepted residual — NO task builds re-orphaning, by design. Non-goals absent. ✅
- **Placeholder scan:** every code step has complete code; the one deliberate implementer-judgment note (Task 5's `channelLink` second argument) states both options concretely. No TBDs.
- **Type consistency:** `Post` optional fields (`inReplyTo?/inReplyToPostId?/threadRootId?`) used identically in Tasks 1–6; `toParsedItem(…, inReplyTo = null)` defaulted 7th param matches all call sites; `replyWireElements` produced in Task 4, consumed in Task 5; `keepEvent` thread lens shape matches Task 6's page. `mkPost` is defined in Task 1's contract snippet and reused in Task 2's.
- **Ponytail check (the reviewer's meta-point):** no machinery beyond the spec — no re-orphaning, no reply counts on the wire type, no thread cache; the injector is ~15 lines with a named death trigger; `Post` fields optional specifically to avoid a repo-wide literal churn.
