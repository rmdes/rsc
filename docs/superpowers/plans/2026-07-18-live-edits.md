# Live Edits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a local author edit their own posts; edits update the body, keep full revision history, show an "edited" marker + history view, and propagate over the feed so instances that ingested the post stay current.

**Architecture:** One storage primitive (`recordEdit` → snapshot prior into `post_revisions`, overwrite `posts`, stamp `edited_at`, emit on the existing `new-post` bus channel) serves both the **produce** side (`PATCH /posts/:id`) and the **consume** side (ingest re-poll detection). The web layer adds an edit route, a history route, an "edited" marker, and an idempotent SSE upsert-by-id.

**Tech Stack:** core = Hono + Kysely + better-sqlite3 (Node 22 native type-stripping, ESM `.ts` imports); web = SvelteKit (Svelte 5 runes, adapter-node); feedsmith for feeds; the `markdown.ts`/`render.ts` sanitize twin for display HTML.

**Spec:** `docs/superpowers/specs/2026-07-18-live-edits-design.md` (read it first; Rev 1 records three review folds — edits ride `new-post`, the ingest else-branch is unconditional, prefer-incoming needs the RSS branch wired).

## Global Constraints

Every task's requirements implicitly include these:

- **Node 22 native type-stripping in `core/src`** — NO TypeScript parameter properties; constructors/objects assign plainly. ESM imports carry the `.ts` extension.
- **The sanitizer is the one XSS gate.** Display HTML is produced only by `core/src/domain/markdown.ts` / `web/src/lib/server/render.ts` (the drift-canary twins — do not touch their pipeline/config). Edited bodies render through `renderPostHtml`. **`{@html}` stays in exactly one component — `web/src/lib/PostBody.svelte`.** The history page renders every version *through* `PostBody`, never a second `{@html}`.
- **guid/permalink stability:** an edit changes `content`/`title`/`content_markdown`/`edited_at` only. Never `guid`, `url`, `published_at` (an edit must not re-order the timeline).
- **No raw hex in web components** — every colour is a `--color-*` token from `web/src/app.css` (mirrors `design-system/textcaster/MASTER.md`). UI tasks MUST invoke `ui-ux-pro-max:ui-ux-pro-max` first and follow MASTER.md; Svelte tasks consult the relevant `svelte-skills`.
- **Probe libraries against the installed source** (feedsmith, carta) — never code an API from memory.
- **Git:** shared checkout — stage explicit paths, never `git add -A`. Commit-message trailer is unresolved: project CLAUDE.md says `Co-Authored-By: Claude Fable 5` but this session is Opus 4.8 — **confirm the trailer with the maintainer before the first commit; do not guess.**
- **Tests:** core → `npm run -w core test` (a single file: `npm run -w core test -- <name>`). web → inside the dev container: `docker compose exec -T web env -u CORE_API_URL npm test` (host runs fail on the container-owned `.vite-temp`; the `env -u` drops the container's `CORE_API_URL` so localhost-fallback tests pass).
- **Core tests live in `core/test/*.test.ts`** — `core/vitest.config.ts` is `include: ['test/**/*.test.ts']`, so a test under `core/src/` collects as ZERO tests. Import source as `../src/...`. Reuse the harness in `core/test/api.test.ts` + `core/test/auth-helper.ts` (`makeAuth`, `anonSession(app)`, `registeredSession(app, email, repo)`; drive via `app.request(path, { headers: { cookie } })`). Web tests live beside code (`*.test.ts`).

## File Structure

**Core (Tasks 1–5):**
- `core/src/domain/types.ts` — `Post.editedAt?`; new `PostRevision` interface.
- `core/src/domain/repository.ts` — interface: `getEditableByGuid`, `recordEdit`, `getRevisions`.
- `core/src/storage/sqlite.ts` — migration 9 (`edited_at` col + `post_revisions` table + index); `PostsTable.edited_at`; `rowToPost`; `PostRevisionsTable` + `DB.post_revisions`; the three new methods.
- `core/src/domain/service.ts` — `editLocalPost`; `getRevisions` passthrough.
- `core/src/domain/ingest.ts` — `ParsedItem.updatedAt` + `toParsedItem`; parse branches; the unconditional edit-detecting else-branch.
- `core/src/api/app.ts` — `PATCH /posts/:id`; `GET /posts/:id/revisions`.
- `core/src/domain/feed.ts` — `<atom:updated>` (RSS + firehose) + `date_modified` (JSON) + `ensureAtomNs`.

**Web (Tasks 6–9):**
- `web/src/lib/types.ts` — `TimelineEntry.editedAt`.
- `web/src/lib/api.ts` — `editPost`, `getRevisions`.
- `web/src/lib/live.ts` (new) — `mergeIncoming` pure reducer + `web/src/lib/live.test.ts`.
- `web/src/lib/EditedMarker.svelte` (new).
- `web/src/lib/PostBody.svelte` — widen prop type (still the only `{@html}`).
- `web/src/routes/+page.svelte`, `post/[id]/+page.svelte`, `u/[handle]/+page.svelte`, `web/src/lib/ReplyTree.svelte` — marker + edit link; SSE upsert on the two live pages.
- `web/src/routes/post/[id]/edit/+page.server.ts` + `+page.svelte` (new).
- `web/src/routes/post/[id]/history/+page.server.ts` + `+page.svelte` (new).
- `web/src/app.css` — `.edited`, `.edit`, edit/history page styles (tokens only).

**Docs (Task 10):** `docs/superpowers/documentation/RUNNING.md`.

---

### Task 1: Storage primitive — schema, Post type, revision reads/writes

**Files:**
- Modify: `core/src/domain/types.ts`
- Modify: `core/src/domain/repository.ts`
- Modify: `core/src/storage/sqlite.ts` (migration array ~line 574; `PostsTable` ~line 9; `rowToPost` ~line 22; `DB` type; new methods near `backfillItemExtras` ~line 307)
- Modify: `core/test/migrations.test.ts` (three `toBe(8)` version pins → `toBe(9)`)
- Test: `core/test/sqlite-edits.test.ts` (new)

**Interfaces:**
- Produces:
  - `Post.editedAt?: string | null`
  - `interface PostRevision { id: string; postId: string; title: string | null; content: string; contentMarkdown: string | null; seenAt: string }`
  - `getEditableByGuid(authorId: string, guid: string): Promise<{ id: string; title: string | null; content: string; contentMarkdown: string | null } | undefined>`
  - `recordEdit(postId: string, next: { title: string | null; content: string; contentMarkdown: string | null; editedAt: string }): Promise<void>` — atomic: snapshots the *current* stored `{title,content,content_markdown}` into `post_revisions` (with `seen_at = next.editedAt`), then overwrites `posts` and sets `edited_at`.
  - `getRevisions(postId: string): Promise<PostRevision[]>` — oldest→newest by `seen_at, id`.

- [ ] **Step 1: Write the failing test**

Create `core/test/sqlite-edits.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import type { Repository } from '../src/domain/repository.ts'
import type { Post } from '../src/domain/types.ts'

function localPost(over: Partial<Post> = {}): Post {
  const id = over.id ?? crypto.randomUUID()
  return { id, authorId: 'u1', source: 'local', guid: over.guid ?? id, title: null, content: 'v1',
    url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z',
    inReplyTo: null, inReplyToPostId: null, threadRootId: null, sourceName: null, sourceFeedUrl: null,
    contentMarkdown: null, ...over }
}

describe('edit primitive', () => {
  let repo: Repository
  beforeEach(async () => {
    repo = await createSqliteRepository(':memory:')
    await repo.createLocalUser({ id: 'u1', handle: 'alice', displayName: 'Alice' })
  })

  it('records an edit: snapshots prior, overwrites current, stamps edited_at', async () => {
    const p = localPost({ content: 'original' })
    await repo.insertPost(p)
    await repo.recordEdit(p.id, { title: null, content: 'corrected', contentMarkdown: null, editedAt: '2026-02-02T00:00:00.000Z' })
    const cur = await repo.getPost(p.id)
    expect(cur?.content).toBe('corrected')
    expect(cur?.editedAt).toBe('2026-02-02T00:00:00.000Z')
    const revs = await repo.getRevisions(p.id)
    expect(revs.map((r) => r.content)).toEqual(['original'])
    expect(revs[0].seenAt).toBe('2026-02-02T00:00:00.000Z')
  })

  it('never-edited post has no revisions and null edited_at', async () => {
    const p = localPost()
    await repo.insertPost(p)
    expect((await repo.getPost(p.id))?.editedAt ?? null).toBeNull()
    expect(await repo.getRevisions(p.id)).toEqual([])
  })

  it('getEditableByGuid returns stored fields by (author, guid)', async () => {
    const p = localPost({ guid: 'g-1', content: 'body', title: 'T' })
    await repo.insertPost(p)
    expect(await repo.getEditableByGuid('u1', 'g-1')).toMatchObject({ id: p.id, title: 'T', content: 'body', contentMarkdown: null })
    expect(await repo.getEditableByGuid('u1', 'missing')).toBeUndefined()
  })

  it('two edits accumulate two revisions oldest-first', async () => {
    const p = localPost({ content: 'a' })
    await repo.insertPost(p)
    await repo.recordEdit(p.id, { title: null, content: 'b', contentMarkdown: null, editedAt: '2026-02-01T00:00:00.000Z' })
    await repo.recordEdit(p.id, { title: null, content: 'c', contentMarkdown: null, editedAt: '2026-02-02T00:00:00.000Z' })
    expect((await repo.getRevisions(p.id)).map((r) => r.content)).toEqual(['a', 'b'])
    expect((await repo.getPost(p.id))?.content).toBe('c')
  })
})
```

- [ ] **Step 2: Run it — expect failure**

Run: `npm run -w core test -- sqlite-edits`
Expected: FAIL (methods/columns don't exist; `getPost().editedAt` undefined).

- [ ] **Step 3: Add the `edited_at` column + `post_revisions` table (migration 9)**

In `core/src/storage/sqlite.ts`, append a new entry to the `MIGRATIONS` array (after the better-auth migration, becoming version 9):

```ts
  [
    'ALTER TABLE posts ADD COLUMN edited_at text',
    `CREATE TABLE post_revisions (
      id text PRIMARY KEY,
      post_id text NOT NULL REFERENCES posts(id),
      title text,
      content text NOT NULL,
      content_markdown text,
      seen_at text NOT NULL
    )`,
    'CREATE INDEX post_revisions_post_idx ON post_revisions (post_id, seen_at)',
  ],
```

- [ ] **Step 4: Thread the column + table through the types**

`core/src/storage/sqlite.ts`:
- `PostsTable`: add `edited_at: string | null`.
- add `interface PostRevisionsTable { id: string; post_id: string; title: string | null; content: string; content_markdown: string | null; seen_at: string }` and add `post_revisions: PostRevisionsTable` to the `DB` interface.
- `rowToPost`: add `editedAt: r.edited_at`.

`core/src/domain/types.ts`:
- `Post`: add `editedAt?: string | null` (after `contentMarkdown`).
- add `export interface PostRevision { id: string; postId: string; title: string | null; content: string; contentMarkdown: string | null; seenAt: string }`.

(No change to `insertPost`: an omitted `edited_at` inserts SQLite NULL — new posts are never edited.)

- [ ] **Step 5: Implement the three methods**

Add to `core/src/domain/repository.ts` interface:

```ts
  getEditableByGuid(authorId: string, guid: string): Promise<{ id: string; title: string | null; content: string; contentMarkdown: string | null } | undefined>
  recordEdit(postId: string, next: { title: string | null; content: string; contentMarkdown: string | null; editedAt: string }): Promise<void>
  getRevisions(postId: string): Promise<PostRevision[]>
```
(import `PostRevision` in `repository.ts`.)

Add to `SqliteRepository` in `core/src/storage/sqlite.ts` (near `backfillItemExtras`):

```ts
  async getEditableByGuid(authorId: string, guid: string) {
    const r = await this.db.selectFrom('posts').select(['id', 'title', 'content', 'content_markdown'])
      .where('author_id', '=', authorId).where('guid', '=', guid).executeTakeFirst()
    return r ? { id: r.id, title: r.title, content: r.content, contentMarkdown: r.content_markdown } : undefined
  }

  async recordEdit(postId: string, next: { title: string | null; content: string; contentMarkdown: string | null; editedAt: string }) {
    // Atomic: snapshot the CURRENT stored version, then overwrite. seen_at on the
    // snapshot = the moment it was superseded (this edit's time).
    await this.db.transaction().execute(async (trx) => {
      const cur = await trx.selectFrom('posts').select(['title', 'content', 'content_markdown'])
        .where('id', '=', postId).executeTakeFirst()
      if (!cur) return
      await trx.insertInto('post_revisions').values({
        id: randomUUID(), post_id: postId, title: cur.title, content: cur.content,
        content_markdown: cur.content_markdown, seen_at: next.editedAt,
      }).execute()
      await trx.updateTable('posts').set({
        title: next.title, content: next.content, content_markdown: next.contentMarkdown, edited_at: next.editedAt,
      }).where('id', '=', postId).execute()
    })
  }

  async getRevisions(postId: string) {
    const rows = await this.db.selectFrom('post_revisions').selectAll()
      .where('post_id', '=', postId).orderBy('seen_at', 'asc').orderBy('id', 'asc').execute()
    return rows.map((r) => ({ id: r.id, postId: r.post_id, title: r.title, content: r.content, contentMarkdown: r.content_markdown, seenAt: r.seen_at }))
  }
```

- [ ] **Step 6: Update the migration version pins**

Migration 9 bumps `user_version` 8 → 9, which breaks `core/test/migrations.test.ts` (it pins `toBe(8)` in three tests: fresh-DB, v1-upgrade, v2-upgrade). Replace all three `toBe(8)` with `toBe(9)`. (Leave the `migration 8: better-auth tables` test name — it names a specific migration, not the current version.)

- [ ] **Step 7: Run tests — expect pass**

Run: `npm run -w core test -- sqlite-edits` → PASS (4). Then `npm run -w core test` — full suite green, including the updated `migrations` pins.

- [ ] **Step 8: Commit** (confirm trailer first — see Global Constraints)

```bash
git add core/src/domain/types.ts core/src/domain/repository.ts core/src/storage/sqlite.ts core/test/sqlite-edits.test.ts core/test/migrations.test.ts
git commit -m "core: edit storage primitive — edited_at + post_revisions + recordEdit/getEditableByGuid/getRevisions"
```

---

### Task 2: Produce side — `PATCH /posts/:id` + `service.editLocalPost`

**Files:**
- Modify: `core/src/domain/service.ts` (near `createLocalPostAs` ~line 38)
- Modify: `core/src/api/app.ts` (near `POST /posts` ~line 95)
- Test: `core/test/posts-edit.test.ts` (new) — reuse the real harness: `createApp({ service, bus, token, auth: makeAuth(repo), users: repo })`, mint with `anonSession(app)` (a second `anonSession` = a distinct user), drive via `app.request`, read state via the `repo` handle.

**Interfaces:**
- Consumes: `recordEdit`, `getPost` (Task 1).
- Produces: `service.editLocalPost(post: Post, content: string, author: User): Promise<TimelineEntry>`; route `PATCH /posts/:id`.

- [ ] **Step 1: Write the failing test**

Create `core/test/posts-edit.test.ts`:

```ts
import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'
import { makeAuth, anonSession } from './auth-helper.ts'

async function makeApp() {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const app = createApp({ service: createService(repo, bus), bus, token: 'secret', auth: makeAuth(repo), users: repo })
  return { app, repo }
}
const patch = (cookie: string, content: string) => ({ method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ content }) })
async function createPost(app: Awaited<ReturnType<typeof makeApp>>['app'], cookie: string, content: string): Promise<string> {
  const res = await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ content }) })
  return (await res.json()).post.id
}

test('owner edits own local post → 200, one revision (original), edited_at set', async () => {
  const { app, repo } = await makeApp()
  const cookie = await anonSession(app)
  const pid = await createPost(app, cookie, 'original')
  const res = await app.request(`/posts/${pid}`, patch(cookie, 'corrected'))
  expect(res.status).toBe(200)
  expect((await res.json()).post.content).toBe('corrected')
  expect((await repo.getRevisions(pid)).map((r) => r.content)).toEqual(['original'])
  expect((await repo.getPost(pid))?.editedAt).toBeTruthy()
})

test('no-op edit (same content) → 200, no revision', async () => {
  const { app, repo } = await makeApp()
  const cookie = await anonSession(app)
  const pid = await createPost(app, cookie, 'same')
  expect((await app.request(`/posts/${pid}`, patch(cookie, 'same'))).status).toBe(200)
  expect(await repo.getRevisions(pid)).toEqual([])
})

test('a different session (non-owner) → 403; missing → 404', async () => {
  const { app } = await makeApp()
  const owner = await anonSession(app)
  const pid = await createPost(app, owner, 'mine')
  const other = await anonSession(app)
  expect((await app.request(`/posts/${pid}`, patch(other, 'x'))).status).toBe(403)
  expect((await app.request(`/posts/does-not-exist`, patch(owner, 'x'))).status).toBe(404)
})

test('editing without a session → 401', async () => {
  const { app } = await makeApp()
  const cookie = await anonSession(app)
  const pid = await createPost(app, cookie, 'mine')
  expect((await app.request(`/posts/${pid}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'x' }) })).status).toBe(401)
})
```

- [ ] **Step 2: Run it — expect failure**

Run: `npm run -w core test -- posts-edit`
Expected: FAIL (route 404s / method not allowed).

- [ ] **Step 3: Add `service.editLocalPost`**

In `core/src/domain/service.ts`, after `createLocalPostAs`:

```ts
    async editLocalPost(post: Post, content: string, author: User): Promise<TimelineEntry> {
      const now = new Date().toISOString()
      await repo.recordEdit(post.id, { title: post.title, content, contentMarkdown: post.contentMarkdown ?? null, editedAt: now })
      const entry: TimelineEntry = { ...post, content, editedAt: now, author }
      bus.emitNewPost(entry) // existing channel → SSE swap + push.onLocalPost fires (edit propagates)
      return entry
    },
```
(ensure `User` is imported in service.ts if not already.)

- [ ] **Step 4: Add the route**

In `core/src/api/app.ts`, after the `POST /posts` handler:

```ts
  app.patch('/posts/:id', authed, async (c) => {
    const me = c.get('coreUser')
    const post = await service.getPost(c.req.param('id'))
    if (!post) return c.json({ error: 'unknown post' }, 404)
    if (post.source !== 'local' || post.authorId !== me.id) return c.json({ error: 'not editable' }, 403)
    const body = await readJsonBody(c)
    if (!body) return c.json({ error: 'body invalid' }, 400)
    const { content } = body
    if (!isString(content, 1, 100000)) return c.json({ error: 'content invalid' }, 400)
    if (content === post.content) return c.json({ post }, 200) // no-op: no phantom revision
    const entry = await service.editLocalPost(post, content, me)
    return c.json({ post: entry }, 200)
  })
```

- [ ] **Step 5: Run tests — expect pass**

Run: `npm run -w core test -- posts-edit` → PASS. Then `npm run -w core test` → full suite green.

- [ ] **Step 6: Commit** (confirm trailer)

```bash
git add core/src/domain/service.ts core/src/api/app.ts core/test/posts-edit.test.ts
git commit -m "core: PATCH /posts/:id — edit own local post (owner+local gate, no-op guard, rides new-post)"
```

---

### Task 3: Consume side — ingest edit-detection + `updatedAt` plumbing

**Files:**
- Modify: `core/src/domain/ingest.ts` (`ParsedItem` ~line 10; `toParsedItem` ~line 56; RSS/Atom/JSON parse branches ~line 84–121; the `insertPost === false` else-branch ~line 168)
- Test: `core/test/ingest-edits.test.ts` (new) — reuse the `core/test/ingest.test.ts` style: a real `createEventBus()` with `bus.onNewPost(cb)` collecting emitted entries, a remote `User` from `repo.createRemoteUser`, and `ingestItems`. (`ParsedItem` is exported from `ingest.ts`, not `types.ts`.)

**Interfaces:**
- Consumes: `getEditableByGuid`, `recordEdit`, `getPost`, `backfillItemExtras` (Tasks 1 + existing).
- Produces: `ParsedItem.updatedAt: string | null`; edit-detecting `ingestItems`.

- [ ] **Step 1: Write the failing test**

Create `core/test/ingest-edits.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { ingestItems } from '../src/domain/ingest.ts'
import type { ParsedItem } from '../src/domain/ingest.ts'
import type { Repository } from '../src/domain/repository.ts'
import type { EventBus } from '../src/domain/bus.ts'
import type { User, TimelineEntry } from '../src/domain/types.ts'

describe('ingest edit-detection', () => {
  let repo: Repository, bus: EventBus, feed: User, emitted: TimelineEntry[]
  beforeEach(async () => {
    repo = await createSqliteRepository(':memory:')
    bus = createEventBus()
    emitted = []
    bus.onNewPost((e) => emitted.push(e))
    feed = await repo.createRemoteUser({ handle: 'blog', displayName: 'Blog', feedUrl: 'https://blog.example/f.xml' })
  })
  const parsed = (over: Partial<ParsedItem> = {}): ParsedItem => ({
    guid: 'g1', title: null, content: 'x', url: null, publishedAt: '2026-01-01T00:00:00.000Z',
    inReplyTo: null, sourceName: null, sourceFeedUrl: null, contentMarkdown: null, updatedAt: null, ...over,
  })

  it('re-ingest same guid with changed body → revision + edited_at + emitted on new-post', async () => {
    await ingestItems(repo, bus, feed, [parsed({ content: 'first' })])
    emitted.length = 0
    await ingestItems(repo, bus, feed, [parsed({ content: 'second' })])
    const stored = await repo.getEditableByGuid(feed.id, 'g1')
    expect(stored?.content).toBe('second')
    expect((await repo.getRevisions(stored!.id)).map((r) => r.content)).toEqual(['first'])
    expect(emitted.some((e) => e.id === stored!.id)).toBe(true)
  })

  it('unchanged re-ingest → no revision, no emit', async () => {
    await ingestItems(repo, bus, feed, [parsed({ content: 'x' })])
    emitted.length = 0
    await ingestItems(repo, bus, feed, [parsed({ content: 'x' })])
    const stored = await repo.getEditableByGuid(feed.id, 'g1')
    expect(await repo.getRevisions(stored!.id)).toEqual([])
    expect(emitted).toEqual([])
  })

  it('attribution-only change → backfill, NOT an edit', async () => {
    await ingestItems(repo, bus, feed, [parsed({ content: 'x', sourceName: null })])
    await ingestItems(repo, bus, feed, [parsed({ content: 'x', sourceName: 'Origin' })])
    const stored = await repo.getEditableByGuid(feed.id, 'g1')
    expect(await repo.getRevisions(stored!.id)).toEqual([])
  })

  it('plain body edit with NO attribution/url/markdown is still detected (unconditional branch)', async () => {
    await ingestItems(repo, bus, feed, [parsed({ content: 'a' })])
    await ingestItems(repo, bus, feed, [parsed({ content: 'b' })])
    const stored = await repo.getEditableByGuid(feed.id, 'g1')
    expect((await repo.getRevisions(stored!.id)).length).toBe(1)
  })

  it('edited_at prefers a valid incoming updatedAt, else now', async () => {
    await ingestItems(repo, bus, feed, [parsed({ content: 'a' })])
    await ingestItems(repo, bus, feed, [parsed({ content: 'b', updatedAt: '2030-05-05T00:00:00.000Z' })])
    const stored = await repo.getEditableByGuid(feed.id, 'g1')
    expect((await repo.getPost(stored!.id))?.editedAt).toBe('2030-05-05T00:00:00.000Z')
  })
})
```

- [ ] **Step 2: Run — expect failure**

Run: `npm run -w core test -- ingest-edits`
Expected: FAIL (`parsed` needs `updatedAt`; detection not implemented).

- [ ] **Step 3: Add `updatedAt` to `ParsedItem` + `toParsedItem`**

`core/src/domain/ingest.ts`:
- `ParsedItem`: add `updatedAt: string | null`.
- `toParsedItem(...)`: add a final param `updatedAt: string | null = null` and include `updatedAt` in the returned object.
- RSS branch (`parseFeedWithMeta`, ~line 107): pass `it.atom?.updated ?? null` as the new arg.
- Atom branch (~line 96): pass `it.updated ?? null`.
- JSON branch (~line 90): pass `it.date_modified ?? null`.
- RDF branch (~line 103): leave defaulted (`null`).

Probe first: confirm feedsmith's parsed RSS item exposes `it.atom?.updated` and Atom item exposes `it.updated` (read the installed feedsmith types). If a name differs, use the real one.

- [ ] **Step 4: Make the else-branch unconditional edit-detection**

Replace the `else if (item.sourceName || …)` block in `ingestItems` (`ingest.ts:168`) with:

```ts
    } else {
      const stored = await repo.getEditableByGuid(user.id, item.guid)
      const changed = stored && (item.content !== stored.content || item.title !== stored.title || item.contentMarkdown !== stored.contentMarkdown)
      if (stored && changed) {
        const parsedUpdated = item.updatedAt ? new Date(item.updatedAt) : null
        const editedAt = parsedUpdated && !Number.isNaN(parsedUpdated.getTime()) ? parsedUpdated.toISOString() : now.toISOString()
        await repo.recordEdit(stored.id, { title: item.title, content: item.content, contentMarkdown: item.contentMarkdown, editedAt })
      }
      // Attribution/url still fill in place (per-column COALESCE), edit or not.
      await repo.backfillItemExtras(user.id, item.guid, item.sourceName, item.sourceFeedUrl, item.contentMarkdown, item.url)
      if (stored && changed && !backfill) {
        const updated = await repo.getPost(stored.id)
        if (updated) bus.emitNewPost({ ...updated, author: user })
      }
    }
```

`ponytail:` this adds one `getEditableByGuid` SELECT per already-seen item per poll (~50/feed/cycle). Fine at current scale; add a hash-column short-circuit only if poll read-volume ever bites. (Mark with a `ponytail:` comment at the branch.)

- [ ] **Step 5: Run tests — expect pass**

Run: `npm run -w core test -- ingest-edits` → PASS (5). Then `npm run -w core test` → full suite green (existing ingest tests unaffected: unchanged re-polls still no-op, attribution backfill still runs).

- [ ] **Step 6: Commit** (confirm trailer)

```bash
git add core/src/domain/ingest.ts core/test/ingest-edits.test.ts
git commit -m "core: ingest edit-detection — unconditional dedup branch, updatedAt plumbing, prefer-incoming edited_at"
```

---

### Task 4: Feed wire signal — `<atom:updated>` + `date_modified`

**Files:**
- Modify: `core/src/domain/feed.ts` (`renderRssFeed` items ~line 104; `renderFirehoseRss` items ~line 142; `renderJsonFeed` items ~line 236; add `ensureAtomNs`)
- Test: `core/test/feed-edits.test.ts` (new)

**Interfaces:**
- Consumes: `Post.editedAt` (Task 1).

- [ ] **Step 1: Write the failing test**

Create `core/test/feed-edits.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { renderRssFeed, renderFirehoseRss, renderJsonFeed } from '../src/domain/feed.ts'
import type { Post, User, TimelineEntry } from '../src/domain/types.ts'

const user: User = { id: 'u1', kind: 'local', handle: 'alice', displayName: 'Alice', feedUrl: null, createdAt: '2026-01-01T00:00:00.000Z', authUserId: null }
function post(over: Partial<Post> = {}): Post {
  return { id: 'p1', authorId: 'u1', source: 'local', guid: 'p1', title: null, content: 'hi', url: null,
    publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', inReplyTo: null,
    inReplyToPostId: null, threadRootId: null, sourceName: null, sourceFeedUrl: null, contentMarkdown: null, editedAt: null, ...over }
}
const ctx = { publicUrl: 'https://ex.test', hubUrl: null, rssCloud: false }

it('edited post emits <atom:updated> in the personal RSS feed', () => {
  const xml = renderRssFeed(user, [post({ editedAt: '2026-02-02T00:00:00.000Z' })], ctx)
  expect(xml).toContain('<atom:updated>2026-02-02T00:00:00.000Z</atom:updated>')
  expect(xml).toMatch(/<rss[^>]*xmlns:atom=/)
})

it('never-edited post omits atom:updated', () => {
  expect(renderRssFeed(user, [post()], ctx)).not.toContain('<atom:updated>')
})

it('firehose emits atom:updated; JSON feed emits date_modified', () => {
  const entry: TimelineEntry = { ...post({ editedAt: '2026-02-02T00:00:00.000Z' }), author: user }
  expect(renderFirehoseRss([entry], ctx)).toContain('<atom:updated>2026-02-02T00:00:00.000Z</atom:updated>')
  expect(renderJsonFeed(user, [post({ editedAt: '2026-02-02T00:00:00.000Z' })], ctx)).toContain('"date_modified"')
})

it('edited post is well-formed (atom ns declared) even with no publicUrl', () => {
  const xml = renderRssFeed(user, [post({ editedAt: '2026-02-02T00:00:00.000Z' })], { publicUrl: null, hubUrl: null, rssCloud: false })
  expect(xml).toContain('<atom:updated>')
  expect(xml).toMatch(/<rss[^>]*xmlns:atom=/) // must be declared or the doc is malformed
})
```

- [ ] **Step 2: Run — expect failure**

Run: `npm run -w core test -- feed-edits`
Expected: FAIL (no atom:updated emitted).

- [ ] **Step 3: Emit the fields**

feedsmith (installed 2.9.6) was verified during plan review to (a) serialize `<atom:updated>` from a per-**item** `atom: { updated }` field, (b) declare `xmlns:atom` on `<rss>` automatically whenever an item carries it — **even with no channel atom-links / no `publicUrl`** — and (c) serialize a per-item JSON `date_modified`. So no namespace guard and no injection fallback are needed; just add the fields.

To each item object in `renderRssFeed` and `renderFirehoseRss`:

```ts
        ...(p.editedAt ? { atom: { updated: p.editedAt } } : {}),
```
To each item in `renderJsonFeed`:
```ts
        ...(p.editedAt ? { date_modified: p.editedAt } : {}),
```
(Re-probe feedsmith before relying on this; if a future version regressed the auto-declared namespace, the no-`publicUrl` test in Step 1 will fail and a string-inject guard becomes necessary — but do not add one speculatively.)

- [ ] **Step 4: Run tests — expect pass**

Run: `npm run -w core test -- feed-edits` → PASS (4, including the no-`publicUrl` well-formedness guard). Then `npm run -w core test` → full suite green. (`core/test/feed.test.ts` uses no snapshots; the "never-edited omits atom:updated" assertion in Step 1 is the regression guard against accidental emission.)

- [ ] **Step 5: Commit** (confirm trailer)

```bash
git add core/src/domain/feed.ts core/test/feed-edits.test.ts
git commit -m "core: emit <atom:updated> (RSS+firehose) and date_modified (JSON) for edited posts"
```

---

### Task 5: `GET /posts/:id/revisions` (public)

**Files:**
- Modify: `core/src/domain/service.ts` (add `getRevisions` passthrough)
- Modify: `core/src/api/app.ts` (new public route)
- Test: `core/test/revisions.test.ts` (new)

**Interfaces:**
- Consumes: `getRevisions`, `getPost` (Task 1).
- Produces: `GET /posts/:id/revisions` → `{ post: Post, revisions: PostRevision[] }` (404 unknown).

- [ ] **Step 1: Write the failing test**

Create `core/test/revisions.test.ts` (same `makeApp`/`anonSession` harness as Task 2):

```ts
import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'
import { makeAuth, anonSession } from './auth-helper.ts'

async function makeApp() {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  return createApp({ service: createService(repo, bus), bus, token: 'secret', auth: makeAuth(repo), users: repo })
}
const patch = (cookie: string, content: string) => ({ method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ content }) })

test('returns current post + revisions oldest-first (public, no auth)', async () => {
  const app = await makeApp()
  const cookie = await anonSession(app)
  const pid = (await (await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ content: 'v1' }) })).json()).post.id
  await app.request(`/posts/${pid}`, patch(cookie, 'v2'))
  await app.request(`/posts/${pid}`, patch(cookie, 'v3'))
  const res = await app.request(`/posts/${pid}/revisions`) // no cookie → public
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.post.content).toBe('v3')
  expect(body.revisions.map((r: { content: string }) => r.content)).toEqual(['v1', 'v2'])
})

test('unknown post → 404', async () => {
  expect((await (await makeApp()).request('/posts/nope/revisions')).status).toBe(404)
})
```

- [ ] **Step 2: Run — expect failure.** `npm run -w core test -- revisions` → FAIL.

- [ ] **Step 3: Service passthrough** — in `service.ts`: `getRevisions(id: string) { return repo.getRevisions(id) },`

- [ ] **Step 4: Route** — in `app.ts` (public, no `authed`):

```ts
  app.get('/posts/:id/revisions', async (c) => {
    const post = await service.getPost(c.req.param('id'))
    if (!post) return c.json({ error: 'unknown post' }, 404)
    return c.json({ post, revisions: await service.getRevisions(post.id) })
  })
```

- [ ] **Step 5: Run tests — expect pass.** `npm run -w core test -- revisions` → PASS; then `npm run -w core test`.

- [ ] **Step 6: Commit** (confirm trailer)

```bash
git add core/src/domain/service.ts core/src/api/app.ts core/test/revisions.test.ts
git commit -m "core: GET /posts/:id/revisions (public) — current post + revision history"
```

---

### Task 6: Web API client + type

**Files:**
- Modify: `web/src/lib/types.ts` (`TimelineEntry`)
- Modify: `web/src/lib/api.ts`
- Test: `web/src/lib/api.test.ts` (extend — mirror the existing `createPost` test)

**Interfaces:**
- Produces: `editPost(f, id, content)`, `getRevisions(f, id)`, `TimelineEntry.editedAt`.

- [ ] **Step 1: Write the failing test** — add `editPost, getRevisions` to the existing `import { … } from './api.ts'` at the top of `web/src/lib/api.test.ts`, then add (matching the file's `vi.fn(async () => new Response(...))` style):

```ts
test('editPost PATCHes /posts/:id with the content', async () => {
  const f = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 200 }))
  await editPost(f as unknown as typeof fetch, 'p1', 'new body')
  expect(f).toHaveBeenCalledWith('http://localhost:8787/posts/p1', expect.objectContaining({ method: 'PATCH' }))
  expect(JSON.parse(String((f.mock.calls[0][1] as RequestInit).body))).toEqual({ content: 'new body' })
})

test('getRevisions GETs /posts/:id/revisions', async () => {
  const f = vi.fn(async () => new Response(JSON.stringify({ post: { id: 'p1' }, revisions: [] }), { status: 200 }))
  const out = await getRevisions(f as unknown as typeof fetch, 'p1')
  expect(f).toHaveBeenCalledWith('http://localhost:8787/posts/p1/revisions')
  expect(out.revisions).toEqual([])
})
```

- [ ] **Step 2: Run — expect failure.** `docker compose exec -T web env -u CORE_API_URL npm test -- api` → FAIL.

- [ ] **Step 3: Add the clients** to `web/src/lib/api.ts`:

```ts
export async function editPost(f: typeof fetch, id: string, content: string): Promise<void> {
	const res = await f(`${base()}/posts/${encodeURIComponent(id)}`, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ content })
	})
	if (!res.ok) throw new Error(await errorMessage(res, `editPost ${res.status}`))
}

export interface Revision { id: string; title: string | null; content: string; contentMarkdown: string | null; seenAt: string }
export async function getRevisions(f: typeof fetch, id: string): Promise<{ post: TimelineEntry; revisions: Revision[] }> {
	const res = await f(`${base()}/posts/${encodeURIComponent(id)}/revisions`)
	if (!res.ok) throw new Error(await errorMessage(res, `revisions ${res.status}`))
	return (await res.json()) as { post: TimelineEntry; revisions: Revision[] }
}
```
(core returns the post as a bare `Post`; typing it as `TimelineEntry` is safe — the history page reads only `content`/`contentMarkdown`/`source`/`editedAt`, all present.)

- [ ] **Step 4: Add the type field** — `web/src/lib/types.ts` `TimelineEntry`: add `editedAt?: string | null`.

- [ ] **Step 5: Run tests — expect pass.** `docker compose exec -T web env -u CORE_API_URL npm test -- api` → PASS.

- [ ] **Step 6: Commit** (confirm trailer)

```bash
git add web/src/lib/api.ts web/src/lib/types.ts web/src/lib/api.test.ts
git commit -m "web: editPost + getRevisions API clients; TimelineEntry.editedAt"
```

---

### Task 7: Web — SSE upsert, edited marker, edit links

**REQUIRED:** invoke `ui-ux-pro-max:ui-ux-pro-max` first and follow `design-system/textcaster/MASTER.md`; consult `svelte-skills:svelte-runes` (state/derived) for the reducer wiring. No raw hex — tokens only.

**Files:**
- Create: `web/src/lib/live.ts` + `web/src/lib/live.test.ts`
- Create: `web/src/lib/EditedMarker.svelte`
- Modify: `web/src/routes/+page.svelte` (onPost + byline), `web/src/routes/post/[id]/+page.svelte` (onPost + byline), `web/src/routes/u/[handle]/+page.svelte` (byline), `web/src/lib/ReplyTree.svelte` (byline)
- Modify: `web/src/app.css` (`.edited`, `.edit`)

**Interfaces:**
- Consumes: `TimelineEntry.editedAt` (Task 6).
- Produces: `mergeIncoming(live, edited, entry, pageIds)`; `EditedMarker`.

- [ ] **Step 1: Write the failing reducer test** — `web/src/lib/live.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mergeIncoming } from './live.ts'
const e = (id: string, over = {}) => ({ id, content: 'c', ...over }) as any

describe('mergeIncoming', () => {
  it('new id → prepends to live', () => {
    const r = mergeIncoming([], {}, e('n1'), new Set())
    expect(r.live.map((p) => p.id)).toEqual(['n1'])
    expect(r.edited).toEqual({})
  })
  it('id already on the page → overlays into edited (swap, not prepend)', () => {
    const r = mergeIncoming([], {}, e('p1', { editedAt: 'x' }), new Set(['p1']))
    expect(r.live).toEqual([])
    expect(r.edited.p1.editedAt).toBe('x')
  })
  it('id already in live → overlays into edited', () => {
    const r = mergeIncoming([e('l1')], {}, e('l1', { editedAt: 'x' }), new Set())
    expect(r.edited.l1.editedAt).toBe('x')
  })
})
```

- [ ] **Step 2: Run — expect failure.** `docker compose exec -T web env -u CORE_API_URL npm test -- live` → FAIL.

- [ ] **Step 3: Implement the reducer** — `web/src/lib/live.ts`:

```ts
import type { TimelineEntry } from './types.ts'

// One rule for both new posts and edits arriving over SSE: if we already show
// this id (live-prepended OR server-rendered on the page), overlay the fresh
// copy (an edit → swap in place). Otherwise it's new → prepend.
export function mergeIncoming(
	live: TimelineEntry[],
	edited: Record<string, TimelineEntry>,
	entry: TimelineEntry,
	pageIds: Set<string>
): { live: TimelineEntry[]; edited: Record<string, TimelineEntry> } {
	if (pageIds.has(entry.id) || live.some((p) => p.id === entry.id)) {
		return { live, edited: { ...edited, [entry.id]: entry } }
	}
	return { live: [entry, ...live], edited }
}
```

- [ ] **Step 4: Create `EditedMarker.svelte`**

```svelte
<script lang="ts">
	let { post }: { post: { id: string; editedAt?: string | null } } = $props()
</script>

{#if post.editedAt}
	<a class="edited" href="/post/{post.id}/history" title={post.editedAt}>edited</a>
{/if}
```

- [ ] **Step 5: Wire the home timeline (`web/src/routes/+page.svelte`)**

Replace the `live`/`posts`/`onPost` block:

```ts
	import EditedMarker from '$lib/EditedMarker.svelte'
	import { mergeIncoming } from '$lib/live'

	let live = $state<TimelineEntry[]>([])
	let edited = $state<Record<string, TimelineEntry>>({})
	const pageIds = $derived(new Set(data.timeline.map((p) => p.id)))
	const posts = $derived([...live, ...data.timeline].map((p) => edited[p.id] ?? p))

	function onPost(entry: TimelineEntry) {
		const r = mergeIncoming(live, edited, entry, pageIds)
		live = r.live
		edited = r.edited
	}
```

In the byline (after the `<a class="permalink">…</a>`), add: `<EditedMarker {post} />`. And add the edit link among the `.source` links:

```svelte
					{#if post.source === 'local' && data.me?.user.id === post.author.id}
						<a class="edit" href="/post/{post.id}/edit">Edit</a>
					{/if}
```

- [ ] **Step 6: Wire the conversation page (`post/[id]/+page.svelte`)**

Its `onPost` currently filters by `keepEvent`. Keep that filter, but route accepted entries through `mergeIncoming` so an edit to a thread post swaps in place:

```ts
	import EditedMarker from '$lib/EditedMarker.svelte'
	import { mergeIncoming } from '$lib/live'
	let live = $state<TimelineEntry[]>([])
	let edited = $state<Record<string, TimelineEntry>>({})
	const pageIds = $derived(new Set(data.thread.map((p) => p.id)))
	const posts = $derived([...data.thread, ...live].map((p) => edited[p.id] ?? p))
	function onPost(entry: TimelineEntry) {
		if (!keepEvent(entry, { kind: 'thread', rootId: data.rootId })) return
		const r = mergeIncoming(live, edited, entry, pageIds)
		live = r.live
		edited = r.edited
	}
```
Add `<EditedMarker post={root} />` to the root byline, and the same `{#if root.source === 'local' && data.me?.user.id === root.author.id}` edit link. (Replies get their marker via ReplyTree, Step 8.)

- [ ] **Step 7: Byline marker on `u/[handle]/+page.svelte`** — add `<EditedMarker {post} />` to each post's byline and the own-post edit link (same snippet). This page has no live stream; the marker is purely server-rendered from `editedAt`.

- [ ] **Step 8: Marker in `ReplyTree.svelte`** — add `<EditedMarker post={reply} />` (bind to whatever the per-reply variable is named) to each reply's byline, so edited replies are marked in the thread wedge.

- [ ] **Step 9: Styles** — in `web/src/app.css`, add (tokens only; pick the muted/subtle text token from MASTER.md — do not invent a hex):

```css
.edited { font-size: 0.8em; color: var(--color-text-muted); text-decoration: none; }
.edited:hover { text-decoration: underline; }
.edit { /* match the existing .source link affordance */ }
```
(Confirm the exact muted-text token name in `app.css`; reuse the `.source` link’s treatment for `.edit`.)

- [ ] **Step 10: Run tests + eyeball**

Run: `docker compose exec -T web env -u CORE_API_URL npm test` → green (new `live` test + existing page tests unaffected).
Manual (dev stack up): post as yourself → an "Edit" link shows on your post; a non-owner/remote post shows none. (Live swap is verified end-to-end in Task 8.)

- [ ] **Step 11: Commit** (confirm trailer)

```bash
git add web/src/lib/live.ts web/src/lib/live.test.ts web/src/lib/EditedMarker.svelte web/src/routes/+page.svelte web/src/routes/post/[id]/+page.svelte web/src/routes/u/[handle]/+page.svelte web/src/lib/ReplyTree.svelte web/src/app.css
git commit -m "web: SSE upsert-by-id, edited marker, own-post edit link"
```

---

### Task 8: Web — edit route `/post/[id]/edit`

**REQUIRED:** invoke `ui-ux-pro-max` first; consult `svelte-skills:sveltekit-data-flow` (load + form actions, `error`/`redirect`/`fail`).

**Files:**
- Create: `web/src/routes/post/[id]/edit/+page.server.ts`
- Create: `web/src/routes/post/[id]/edit/+page.svelte`
- Create: `web/src/routes/post/[id]/edit/edit.actions.test.ts` (mirror `post/[id]/reply.actions.test.ts`)

**Interfaces:**
- Consumes: `getThread`, `editPost` (Task 6), `ensureSessionFetch`, layout `me`.

- [ ] **Step 1: Write the failing action test** — mirror `post/[id]/reply.actions.test.ts` exactly (it does NOT `vi.mock('$lib/api')`; it passes a fake `fetch` on the event and asserts on `fetch.mock.calls`, because a session cookie is already present so `ensureSessionFetch` just wraps `fetch`):

```ts
import { test, expect, vi } from 'vitest'
import { actions } from './+page.server.ts'

function formRequest(fields: Record<string, string>): Request {
  return new Request('http://x/?/edit', { method: 'POST', body: new URLSearchParams(fields) })
}
function sessionedEvent(fields: Record<string, string>, fetch: ReturnType<typeof vi.fn>, id = 'p1') {
  return { request: formRequest(fields), fetch, params: { id }, url: new URL('http://x/'),
    cookies: { getAll: () => [{ name: 'textcaster.session_token', value: 's1' }] } }
}

test('edit PATCHes /posts/:id with the content then redirects', async () => {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 200 }))
  await expect(actions.edit(sessionedEvent({ content: 'updated' }, fetch) as never)).rejects.toMatchObject({ status: 303 })
  const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
  expect(String(url)).toContain('/posts/p1')
  expect(init.method).toBe('PATCH')
  expect(JSON.parse(String(init.body)).content).toBe('updated')
})

test('empty content → fail(400), no fetch', async () => {
  const fetch = vi.fn()
  expect(await actions.edit(sessionedEvent({}, fetch) as never)).toMatchObject({ status: 400 })
  expect(fetch).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run — expect failure.** `docker compose exec -T web env -u CORE_API_URL npm test -- edit.actions` → FAIL.

- [ ] **Step 3: `+page.server.ts`**

```ts
import type { PageServerLoad, Actions } from './$types'
import { error, fail, redirect } from '@sveltejs/kit'
import { getThread, editPost } from '$lib/api'
import { ensureSessionFetch } from '$lib/server/session'

export const load: PageServerLoad = async ({ fetch, params, parent }) => {
	const { me } = await parent()
	const post = (await getThread(fetch, params.id).catch(() => [])).find((p) => p.id === params.id)
	if (!post) throw error(404, 'no such post')
	if (post.source !== 'local' || !me || me.user.id !== post.author.id) throw error(403, 'not your post')
	return { post }
}

export const actions = {
	edit: async (event) => {
		const content = String((await event.request.formData()).get('content') ?? '').trim()
		if (!content) return fail(400, { error: 'content is required' })
		try {
			const f = await ensureSessionFetch(event)
			await editPost(f, event.params.id, content)
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'edit failed' })
		}
		throw redirect(303, `/post/${event.params.id}`)
	}
} satisfies Actions
```
(Confirm `me` reaches `parent()` — `+layout.server.ts` returns it. `me.user.id === post.author.id` also permits guests editing their own posts, per spec Decision 6.)

- [ ] **Step 4: `+page.svelte`** — MarkdownComposer prefilled with the post's markdown (`post.content`); `bind:value` seeds BOTH the no-JS textarea and Carta:

```svelte
<script lang="ts">
	import MarkdownComposer from '$lib/MarkdownComposer.svelte'
	import { enhance } from '$app/forms'
	let { data, form } = $props()
	let content = $state(data.post.content)
</script>

<svelte:head><title>Edit — Textcaster</title></svelte:head>

<div class="lens">
	<header class="masthead"><a href="/">Textcaster</a></header>
	<h1>Edit post</h1>
	{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}
	<form method="POST" action="?/edit" class="composer" use:enhance>
		<MarkdownComposer bind:value={content} />
		<button>Save</button>
	</form>
	<p><a href="/post/{data.post.id}">Cancel</a></p>
</div>
```

- [ ] **Step 5: Run tests — expect pass.** `docker compose exec -T web env -u CORE_API_URL npm test -- edit.actions` → PASS; then full web suite.

- [ ] **Step 6: End-to-end verification (dev stack)** — post as yourself → Edit → change the text → Save → redirected to the post with the new body and an "edited" marker; a second browser tab watching the home timeline sees the body **swap in place** (SSE upsert). Confirm no-JS: disable JS, repeat via the plain textarea + Save.

- [ ] **Step 7: Commit** (confirm trailer)

```bash
git add web/src/routes/post/[id]/edit/
git commit -m "web: /post/:id/edit — prefilled composer, owner-gated, no-JS form action"
```

---

### Task 9: Web — history route `/post/[id]/history`

**REQUIRED:** invoke `ui-ux-pro-max` first; follow MASTER.md.

**Files:**
- Create: `web/src/routes/post/[id]/history/+page.server.ts`
- Create: `web/src/routes/post/[id]/history/+page.svelte`
- Modify: `web/src/lib/PostBody.svelte` (widen prop type — still the only `{@html}`)
- Modify: `web/src/app.css` (history list styles)
- Test: `web/src/routes/post/[id]/history/history.load.test.ts`

**Interfaces:**
- Consumes: `getRevisions` (Task 6), `renderPostHtml` (`$lib/server/render`).

- [ ] **Step 1: Write the failing load test**

```ts
it('load renders current + each revision through the sanitize twin, oldest-first', async () => {
  // stub getRevisions → { post: { content: 'now', source: 'local', editedAt: 'x' }, revisions: [{ content: 'first', seenAt: '1' }, { content: 'second', seenAt: '2' }] }
  const out = await load({ fetch: f, params: { id: 'p1' } } as any)
  expect(out.currentHtml).toContain('now')
  expect(out.versions.map((v) => v.seenAt)).toEqual(['1', '2'])
  expect(out.versions[0].html).toContain('first')
})
```

- [ ] **Step 2: Run — expect failure.** `docker compose exec -T web env -u CORE_API_URL npm test -- history.load` → FAIL.

- [ ] **Step 3: `+page.server.ts`** — render every version through the twin server-side (never ship raw):

```ts
import type { PageServerLoad } from './$types'
import { error } from '@sveltejs/kit'
import { getRevisions } from '$lib/api'
import { renderPostHtml } from '$lib/server/render'

export const load: PageServerLoad = async ({ fetch, params }) => {
	let data
	try {
		data = await getRevisions(fetch, params.id)
	} catch {
		throw error(404, 'no such post')
	}
	const source = data.post.source
	const currentHtml = renderPostHtml({ content: data.post.content, contentMarkdown: data.post.contentMarkdown, source })
	const versions = data.revisions.map((r) => ({
		seenAt: r.seenAt,
		html: renderPostHtml({ content: r.content, contentMarkdown: r.contentMarkdown, source })
	}))
	return { postId: params.id, editedAt: data.post.editedAt ?? null, currentHtml, versions }
}
```

- [ ] **Step 4: Widen `PostBody` prop type** so the history page can render each version's HTML through the ONE `{@html}` (no second chokepoint). In `web/src/lib/PostBody.svelte`, change the prop type from `{ post: TimelineEntry }` to accept the minimal shape it actually reads:

```ts
	let { post }: { post: { content: string; contentHtml?: string } } = $props()
```
(logic unchanged — it still only reads `post.contentHtml`/`post.content`.) **Also remove the now-unused `import type { TimelineEntry } from './types'`** at the top of `PostBody.svelte` (widening drops its last use → it would trip `noUnusedLocals`/lint). The widened shape is structurally satisfied by `TimelineEntry`, so every existing `<PostBody {post} />` caller still type-checks.

- [ ] **Step 5: `+page.svelte`** — render current + versions via `PostBody` (oldest→newest, current last, matching `[…revisions, current]`):

```svelte
<script lang="ts">
	import PostBody from '$lib/PostBody.svelte'
	let { data } = $props()
</script>

<svelte:head><title>Edit history — Textcaster</title></svelte:head>

<div class="lens">
	<header class="masthead"><a href="/">Textcaster</a></header>
	<h1>Edit history</h1>
	<p><a href="/post/{data.postId}">← back to the post</a></p>
	<ol class="history">
		{#each data.versions as v (v.seenAt)}
			<li>
				<time datetime={v.seenAt}>{v.seenAt.slice(0, 16).replace('T', ' ')}</time>
				<PostBody post={{ content: '', contentHtml: v.html }} />
			</li>
		{/each}
		<li class="current">
			<span class="badge-kind">current{#if data.editedAt} · edited {data.editedAt.slice(0, 16).replace('T', ' ')}{/if}</span>
			<PostBody post={{ content: '', contentHtml: data.currentHtml }} />
		</li>
	</ol>
</div>
```

- [ ] **Step 6: Styles** — add a `.history` list treatment in `web/src/app.css` (spacing/rule between versions), tokens only, per MASTER.md.

- [ ] **Step 7: Run tests + eyeball.** `docker compose exec -T web env -u CORE_API_URL npm test -- history.load` → PASS; then full web suite. Manually visit `/post/<edited-id>/history` → versions render oldest→newest, current last; a never-edited post shows only "current".

- [ ] **Step 8: Commit** (confirm trailer)

```bash
git add web/src/routes/post/[id]/history/ web/src/lib/PostBody.svelte web/src/app.css
git commit -m "web: /post/:id/history — revision list rendered through the sanitize twin (single {@html})"
```

---

### Task 10: Docs

**Files:**
- Modify: `docs/superpowers/documentation/RUNNING.md`

- [ ] **Step 1: Document the new surface** — add `PATCH /posts/:id` (session, own local posts) and `GET /posts/:id/revisions` (public) to the endpoint list, and note the `post_revisions` table + `edited_at` column in the schema/migration section (migration 9). One or two lines each; match the file's existing tone.

- [ ] **Step 2: Commit** (confirm trailer)

```bash
git add docs/superpowers/documentation/RUNNING.md
git commit -m "docs: RUNNING.md — edit endpoints + post_revisions"
```

---

## Self-Review (author checklist — completed)

- **Spec coverage:** storage primitive (T1) · produce PATCH (T2) · consume detection + updatedAt (T3) · wire atom:updated/date_modified (T4) · revisions endpoint (T5) · web client/type (T6) · SSE upsert + marker + edit link (T7) · edit route (T8) · history route (T9) · docs (T10). Every spec section maps to a task.
- **Invariants:** single `{@html}` preserved (T9 renders versions through `PostBody`); sanitize twin reused, not duplicated (T9 `renderPostHtml`); edits ride `new-post` so push fires (T2/T3); ingest branch unconditional (T3); atom-ns guard (T4).
- **Type consistency:** `recordEdit(postId, {title,content,contentMarkdown,editedAt})`, `getEditableByGuid`, `getRevisions`/`PostRevision`, `TimelineEntry.editedAt`, `editPost`/`getRevisions` web clients, `mergeIncoming` signature — all used identically across tasks.
- **Ordering/deps:** core T1→T5 each build on T1; web T6 (client/type) precedes T7–T9; T9 depends on T6's `getRevisions` + widened `PostBody`.

## Revision history

- **Rev 1 (2026-07-18) — clean-context plan review + shared-checkout reconciliation.** Verified against HEAD `4e94287` (the just-finished SP4 admin milestone — which touched `app.ts`/`service.ts`/`repository.ts`/`sqlite.ts`/`web/src/lib/api.ts`, but left the schema at migration 8, so code signatures used here are current). Folded three **blocking** fixes:
  1. **All core tests moved to `core/test/`** — `core/vitest.config.ts` is `include: ['test/**']`, so tests under `core/src/` collect as zero. Every core test now lives in `core/test/*.test.ts` importing `../src/...`, and uses the real harness (`makeApp` + `core/test/auth-helper.ts`: `anonSession`/`registeredSession`, `app.request(path, { headers: { cookie } })`) instead of invented `aliceFetch`/`bobFetch` helpers. A second user = a second `anonSession`. Ingest tests use `feed.id` (generated), not a literal, and a real `createEventBus()`.
  2. **Migration 9 breaks `core/test/migrations.test.ts`** (three `toBe(8)` pins) — Task 1 now updates them to `toBe(9)` as an explicit step (the earlier "nothing pins the count" claim was wrong).
  3. **`ensureAtomNs` cut as dead code** — feedsmith (probed, 2.9.6) declares `xmlns:atom` automatically even with no channel atom-links / no `publicUrl`, and emits item-level `atom.updated`/`date_modified` natively. The no-`publicUrl` well-formedness test is kept as a regression guard.
  Plus web test-sketch corrections (real `vi.fn(async () => new Response(...))` mocks; T8 mirrors `reply.actions.test.ts`'s fake-`fetch` style, not a `vi.mock`) and removing the orphaned `TimelineEntry` import when `PostBody`'s prop widens. feedsmith item-level fields and the `parent()`/`me` assumption were both **confirmed** by the review.

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-07-18-live-edits.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh implementer subagent per task, task review (spec + quality) between tasks, whole-branch review at the end.
2. **Inline Execution** — batch execution in this session with checkpoints.

Which approach?
