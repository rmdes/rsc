# Textcaster Spine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A runnable walking skeleton proving Textcaster's thesis — local users (post through the instance) and remote users (an external feed the instance polls) coexisting in ONE live timeline — with a headless Core API and a SvelteKit web client that is just a client of it.

**Architecture:** Two deployables in an npm-workspaces monorepo. `core/` is a headless Hono HTTP+SSE API over a storage-agnostic repository (SQLite adapter now, via Kysely). `web/` is a SvelteKit app that renders the timeline via SSR (works with no JavaScript) by calling the Core API server-side, and upgrades to live updates with one SSE island. Real-time is an in-process event bus (no DB pub/sub), so it is storage-agnostic by construction.

**Tech Stack:** TypeScript (ESM), Node 20+ (dev on 24), Hono + @hono/node-server, Kysely + better-sqlite3, rss-parser, Vitest, SvelteKit, tsx.

**Spec:** `docs/superpowers/specs/2026-07-15-textcaster-design.md`

## Global Constraints

- **TypeScript, ESM everywhere** (`"type": "module"`). Node 20+.
- **Clean backend/frontend separation:** `web/` talks to `core/` only over HTTP (a base URL). `web/` NEVER imports from `core/`'s internals. This is what lets alternate frontends exist.
- **Storage-agnostic core:** domain logic depends only on the `Repository` interface, never on SQLite/Kysely specifics. No SQL in domain/service/API code. Real-time is the in-process event bus, NOT any DB pub/sub.
- **No-JS is first-class:** every page renders and every form works with JavaScript disabled. JS only *enhances* (live SSE updates).
- **One repository contract test-suite** (`runRepositoryContract`) that any adapter must pass; SQLite is the only adapter now, but the suite is adapter-neutral.
- **TDD:** failing test first, then minimal code. **Vitest** is the test runner in both packages.
- **DEFERRED — do NOT build:** per-user feed output, WebSub/rssCloud, following/filtering, reply threading, IndieAuth/three-tier accounts, Micropub, Postgres/Mongo adapters, Webmention, ActivityPub, media.
- Commit after each task; end every commit message with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## File structure (what gets built)

```
package.json                      # npm workspaces root
tsconfig.base.json                # shared TS config
core/
  package.json
  tsconfig.json
  vitest.config.ts
  src/
    domain/types.ts               # User, Post, NewLocalPost, NewRemoteUser
    domain/repository.ts          # Repository interface (the storage contract)
    domain/repository-contract.ts # runRepositoryContract(makeRepo) — adapter-neutral suite
    domain/bus.ts                 # in-process typed event bus
    domain/service.ts             # createLocalPost, addRemoteUser, getTimeline
    domain/ingest.ts              # fetchAndIngest(remoteUser) + parseFeed
    storage/sqlite.ts             # SqliteRepository (Kysely + better-sqlite3) + schema bootstrap
    api/app.ts                    # Hono app: POST /users, POST /posts, GET /timeline, GET /timeline/stream
    api/auth.ts                   # bearer-token middleware
    config.ts                     # env config (DB path, token, port, poll interval, etc.)
    server.ts                     # entrypoint: serve(app) + start poller
  test/                           # *.test.ts
web/
  (SvelteKit app — created by `sv create`)
  src/lib/api.ts                  # thin server-side Core API client (fetch wrapper)
  src/routes/+page.server.ts      # load (SSR timeline) + form actions (compose, add-remote)
  src/routes/+page.svelte         # timeline render + compose/add forms + <LiveTimeline/> island
  src/lib/LiveTimeline.svelte     # SSE island (progressive enhancement)
```

---

### Task 1: Monorepo + core package scaffold

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `core/package.json`, `core/tsconfig.json`, `core/vitest.config.ts`, `core/src/smoke.ts`, `core/test/smoke.test.ts`

**Interfaces:**
- Produces: a working `npm test -w core` toolchain (Vitest running TS). Nothing importable by later tasks except that the toolchain exists.

- [ ] **Step 1: Root workspace + base TS config**

`package.json`:
```json
{
  "name": "textcaster",
  "private": true,
  "type": "module",
  "workspaces": ["core", "web"],
  "engines": { "node": ">=20" }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "types": []
  }
}
```

- [ ] **Step 2: Core package files**

`core/package.json`:
```json
{
  "name": "@textcaster/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "dev": "tsx watch src/server.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "hono": "^4.6.0",
    "@hono/node-server": "^1.13.0",
    "kysely": "^0.27.0",
    "better-sqlite3": "^11.3.0",
    "rss-parser": "^3.13.0"
  },
  "devDependencies": {
    "vitest": "^2.1.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^22.0.0"
  }
}
```

`core/tsconfig.json`:
```json
{ "extends": "../tsconfig.base.json", "compilerOptions": { "types": ["node"] }, "include": ["src", "test"] }
```

`core/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } })
```

- [ ] **Step 3: Write the failing smoke test**

`core/test/smoke.test.ts`:
```ts
import { test, expect } from 'vitest'
import { hello } from '../src/smoke.ts'

test('toolchain runs TypeScript tests', () => {
  expect(hello()).toBe('textcaster')
})
```

- [ ] **Step 4: Install and run — verify it fails**

Run: `npm install && npm test -w core`
Expected: FAIL — cannot find `../src/smoke.ts` (module missing).

- [ ] **Step 5: Minimal implementation**

`core/src/smoke.ts`:
```ts
export function hello(): string {
  return 'textcaster'
}
```

- [ ] **Step 6: Run — verify it passes**

Run: `npm test -w core`
Expected: PASS (1 test).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(printf 'core: monorepo + core scaffold (vitest toolchain)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 2: Domain types + Repository interface + SQLite adapter + contract suite

**Files:**
- Create: `core/src/domain/types.ts`, `core/src/domain/repository.ts`, `core/src/domain/repository-contract.ts`, `core/src/storage/sqlite.ts`, `core/test/sqlite-repository.test.ts`

**Interfaces:**
- Produces:
  - Types: `User = { id: string; kind: 'local' | 'remote'; handle: string; displayName: string; feedUrl: string | null; createdAt: string }`; `Post = { id: string; authorId: string; source: 'local' | 'remote'; guid: string; content: string; url: string | null; publishedAt: string; createdAt: string }`; `NewRemoteUser = { handle: string; displayName: string; feedUrl: string }`; `NewLocalUser = { handle: string; displayName: string }`.
  - `interface Repository` with: `createLocalUser(u: NewLocalUser): Promise<User>`; `createRemoteUser(u: NewRemoteUser): Promise<User>`; `getUser(id: string): Promise<User | undefined>`; `getUserByHandle(handle: string): Promise<User | undefined>`; `listRemoteUsers(): Promise<User[]>`; `insertPost(p: Post): Promise<void>`; `hasPostGuid(guid: string): Promise<boolean>`; `getTimeline(limit: number): Promise<Array<Post & { author: User }>>`.
  - `runRepositoryContract(makeRepo: () => Promise<Repository>)` — a Vitest describe block any adapter reuses.
  - `class SqliteRepository implements Repository`, and `createSqliteRepository(filename: string): Promise<SqliteRepository>` (bootstraps schema, `filename` may be `:memory:`).
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Types + interface (no test yet — these are contracts consumed below)**

`core/src/domain/types.ts`:
```ts
export type UserKind = 'local' | 'remote'
export type PostSource = 'local' | 'remote'

export interface User {
  id: string
  kind: UserKind
  handle: string
  displayName: string
  feedUrl: string | null
  createdAt: string
}

export interface Post {
  id: string
  authorId: string
  source: PostSource
  guid: string
  content: string
  url: string | null
  publishedAt: string
  createdAt: string
}

export interface NewLocalUser { handle: string; displayName: string }
export interface NewRemoteUser { handle: string; displayName: string; feedUrl: string }
export type TimelineEntry = Post & { author: User }
```

`core/src/domain/repository.ts`:
```ts
import type { User, Post, NewLocalUser, NewRemoteUser, TimelineEntry } from './types.ts'

export interface Repository {
  createLocalUser(u: NewLocalUser): Promise<User>
  createRemoteUser(u: NewRemoteUser): Promise<User>
  getUser(id: string): Promise<User | undefined>
  getUserByHandle(handle: string): Promise<User | undefined>
  listRemoteUsers(): Promise<User[]>
  insertPost(p: Post): Promise<void>
  hasPostGuid(guid: string): Promise<boolean>
  getTimeline(limit: number): Promise<TimelineEntry[]>
}
```

- [ ] **Step 2: Write the adapter-neutral contract suite (the failing test)**

`core/src/domain/repository-contract.ts`:
```ts
import { describe, test, expect } from 'vitest'
import type { Repository } from './repository.ts'

export function runRepositoryContract(makeRepo: () => Promise<Repository>) {
  describe('Repository contract', () => {
    test('creates and reads a local user', async () => {
      const repo = await makeRepo()
      const u = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      expect(u.kind).toBe('local')
      expect(u.feedUrl).toBeNull()
      expect(await repo.getUserByHandle('alice')).toEqual(u)
    })

    test('creates a remote user and lists it among remotes only', async () => {
      const repo = await makeRepo()
      await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      const r = await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
      expect(r.kind).toBe('remote')
      expect(r.feedUrl).toBe('https://ex.com/f.xml')
      const remotes = await repo.listRemoteUsers()
      expect(remotes.map((x) => x.handle)).toEqual(['news'])
    })

    test('inserts posts and returns a newest-first timeline with authors', async () => {
      const repo = await makeRepo()
      const a = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      await repo.insertPost({ id: 'p1', authorId: a.id, source: 'local', guid: 'g1', content: 'first', url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
      await repo.insertPost({ id: 'p2', authorId: a.id, source: 'local', guid: 'g2', content: 'second', url: null, publishedAt: '2026-01-02T00:00:00.000Z', createdAt: '2026-01-02T00:00:00.000Z' })
      const tl = await repo.getTimeline(10)
      expect(tl.map((e) => e.id)).toEqual(['p2', 'p1'])
      expect(tl[0].author.handle).toBe('alice')
    })

    test('hasPostGuid detects duplicates for idempotent ingestion', async () => {
      const repo = await makeRepo()
      const a = await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
      expect(await repo.hasPostGuid('g1')).toBe(false)
      await repo.insertPost({ id: 'p1', authorId: a.id, source: 'remote', guid: 'g1', content: 'x', url: 'https://ex.com/1', publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
      expect(await repo.hasPostGuid('g1')).toBe(true)
    })
  })
}
```

`core/test/sqlite-repository.test.ts`:
```ts
import { runRepositoryContract } from '../src/domain/repository-contract.ts'
import { createSqliteRepository } from '../src/storage/sqlite.ts'

runRepositoryContract(() => createSqliteRepository(':memory:'))
```

- [ ] **Step 3: Run — verify it fails**

Run: `npm test -w core`
Expected: FAIL — cannot resolve `../src/storage/sqlite.ts`.

- [ ] **Step 4: Implement the SQLite adapter**

`core/src/storage/sqlite.ts`:
```ts
import { Kysely, SqliteDialect } from 'kysely'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { Repository } from '../domain/repository.ts'
import type { User, Post, NewLocalUser, NewRemoteUser, TimelineEntry } from '../domain/types.ts'

interface UsersTable { id: string; kind: 'local' | 'remote'; handle: string; display_name: string; feed_url: string | null; created_at: string }
interface PostsTable { id: string; author_id: string; source: 'local' | 'remote'; guid: string; content: string; url: string | null; published_at: string; created_at: string }
interface DB { users: UsersTable; posts: PostsTable }

function rowToUser(r: UsersTable): User {
  return { id: r.id, kind: r.kind, handle: r.handle, displayName: r.display_name, feedUrl: r.feed_url, createdAt: r.created_at }
}

export class SqliteRepository implements Repository {
  constructor(private db: Kysely<DB>) {}

  private async insertUser(kind: 'local' | 'remote', handle: string, displayName: string, feedUrl: string | null): Promise<User> {
    const row: UsersTable = { id: randomUUID(), kind, handle, display_name: displayName, feed_url: feedUrl, created_at: new Date().toISOString() }
    await this.db.insertInto('users').values(row).execute()
    return rowToUser(row)
  }
  createLocalUser(u: NewLocalUser) { return this.insertUser('local', u.handle, u.displayName, null) }
  createRemoteUser(u: NewRemoteUser) { return this.insertUser('remote', u.handle, u.displayName, u.feedUrl) }

  async getUser(id: string) {
    const r = await this.db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst()
    return r ? rowToUser(r) : undefined
  }
  async getUserByHandle(handle: string) {
    const r = await this.db.selectFrom('users').selectAll().where('handle', '=', handle).executeTakeFirst()
    return r ? rowToUser(r) : undefined
  }
  async listRemoteUsers() {
    const rs = await this.db.selectFrom('users').selectAll().where('kind', '=', 'remote').execute()
    return rs.map(rowToUser)
  }
  async insertPost(p: Post) {
    await this.db.insertInto('posts').values({ id: p.id, author_id: p.authorId, source: p.source, guid: p.guid, content: p.content, url: p.url, published_at: p.publishedAt, created_at: p.createdAt }).execute()
  }
  async hasPostGuid(guid: string) {
    const r = await this.db.selectFrom('posts').select('id').where('guid', '=', guid).executeTakeFirst()
    return r !== undefined
  }
  async getTimeline(limit: number): Promise<TimelineEntry[]> {
    const rows = await this.db
      .selectFrom('posts')
      .innerJoin('users', 'users.id', 'posts.author_id')
      .selectAll('posts')
      .select(['users.id as u_id', 'users.kind as u_kind', 'users.handle as u_handle', 'users.display_name as u_display_name', 'users.feed_url as u_feed_url', 'users.created_at as u_created_at'])
      .orderBy('posts.published_at', 'desc')
      .orderBy('posts.id', 'desc')
      .limit(limit)
      .execute()
    return rows.map((r) => ({
      id: r.id, authorId: r.author_id, source: r.source, guid: r.guid, content: r.content, url: r.url, publishedAt: r.published_at, createdAt: r.created_at,
      author: { id: r.u_id, kind: r.u_kind, handle: r.u_handle, displayName: r.u_display_name, feedUrl: r.u_feed_url, createdAt: r.u_created_at },
    }))
  }
}

export async function createSqliteRepository(filename: string): Promise<SqliteRepository> {
  const db = new Kysely<DB>({ dialect: new SqliteDialect({ database: new Database(filename) }) })
  await db.schema.createTable('users').ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('handle', 'text', (c) => c.notNull().unique())
    .addColumn('display_name', 'text', (c) => c.notNull())
    .addColumn('feed_url', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute()
  await db.schema.createTable('posts').ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('author_id', 'text', (c) => c.notNull().references('users.id'))
    .addColumn('source', 'text', (c) => c.notNull())
    .addColumn('guid', 'text', (c) => c.notNull().unique())
    .addColumn('content', 'text', (c) => c.notNull())
    .addColumn('url', 'text')
    .addColumn('published_at', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute()
  await db.schema.createIndex('posts_published_idx').ifNotExists().on('posts').column('published_at').execute()
  return new SqliteRepository(db)
}
```

- [ ] **Step 5: Run — verify the contract passes on SQLite**

Run: `npm test -w core`
Expected: PASS — the 4 contract tests + Task 1 smoke.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(printf 'core: domain types, Repository contract, SQLite adapter\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 3: In-process event bus

**Files:**
- Create: `core/src/domain/bus.ts`, `core/test/bus.test.ts`

**Interfaces:**
- Produces: `interface EventBus { emitNewPost(e: TimelineEntry): void; onNewPost(fn: (e: TimelineEntry) => void): () => void }` and `createEventBus(): EventBus`. `onNewPost` returns an unsubscribe function.
- Consumes: `TimelineEntry` from `domain/types.ts`.

- [ ] **Step 1: Failing test**

`core/test/bus.test.ts`:
```ts
import { test, expect, vi } from 'vitest'
import { createEventBus } from '../src/domain/bus.ts'
import type { TimelineEntry } from '../src/domain/types.ts'

const entry: TimelineEntry = { id: 'p1', authorId: 'a', source: 'local', guid: 'g1', content: 'hi', url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', author: { id: 'a', kind: 'local', handle: 'alice', displayName: 'Alice', feedUrl: null, createdAt: '2026-01-01T00:00:00.000Z' } }

test('delivers emitted posts to subscribers and stops after unsubscribe', () => {
  const bus = createEventBus()
  const fn = vi.fn()
  const off = bus.onNewPost(fn)
  bus.emitNewPost(entry)
  expect(fn).toHaveBeenCalledWith(entry)
  off()
  bus.emitNewPost(entry)
  expect(fn).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: Run — verify it fails** — Run: `npm test -w core`; Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`core/src/domain/bus.ts`:
```ts
import { EventEmitter } from 'node:events'
import type { TimelineEntry } from './types.ts'

export interface EventBus {
  emitNewPost(e: TimelineEntry): void
  onNewPost(fn: (e: TimelineEntry) => void): () => void
}

export function createEventBus(): EventBus {
  const emitter = new EventEmitter()
  emitter.setMaxListeners(0)
  return {
    emitNewPost(e) { emitter.emit('new-post', e) },
    onNewPost(fn) {
      emitter.on('new-post', fn)
      return () => emitter.off('new-post', fn)
    },
  }
}
```

- [ ] **Step 4: Run — verify it passes** — Run: `npm test -w core`; Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(printf 'core: in-process event bus for the real-time firehose\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 4: Domain service (compose, add-remote, timeline)

**Files:**
- Create: `core/src/domain/service.ts`, `core/test/service.test.ts`

**Interfaces:**
- Produces `createService(repo: Repository, bus: EventBus)` returning `{ addRemoteUser(input: NewRemoteUser): Promise<User>; createLocalPost(input: { handle: string; content: string }): Promise<TimelineEntry>; getTimeline(limit?: number): Promise<TimelineEntry[]> }`. `createLocalPost` inserts a post (source `'local'`, guid = the new post id, publishedAt = now) authored by the local user with `handle`, then emits it on the bus and returns the `TimelineEntry`. Throws `Error('unknown local user')` if the handle is not a local user.
- Consumes: `Repository` (Task 2), `EventBus` (Task 3), types (Task 2).

- [ ] **Step 1: Failing test**

`core/test/service.test.ts`:
```ts
import { test, expect, vi } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'

async function setup() {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  return { repo, bus, svc: createService(repo, bus) }
}

test('createLocalPost stores, emits, and appears in the timeline', async () => {
  const { bus, svc } = await setup()
  await svc.addRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' }) // remote coexists
  const seen = vi.fn()
  bus.onNewPost(seen)
  await svc.createLocalPostAs('alice', 'Alice', 'hello world')
  expect(seen).toHaveBeenCalledTimes(1)
  const tl = await svc.getTimeline()
  expect(tl.map((e) => e.content)).toContain('hello world')
  expect(tl[0].author.kind).toBe('local')
})
```

Note: to keep the spine simple, local users are auto-created on first post by handle. The service method is `createLocalPostAs(handle, displayName, content)`.

- [ ] **Step 2: Run — verify it fails** — Run: `npm test -w core`; Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`core/src/domain/service.ts`:
```ts
import { randomUUID } from 'node:crypto'
import type { Repository } from './repository.ts'
import type { EventBus } from './bus.ts'
import type { NewRemoteUser, TimelineEntry, User, Post } from './types.ts'

export function createService(repo: Repository, bus: EventBus) {
  async function ensureLocalUser(handle: string, displayName: string): Promise<User> {
    const existing = await repo.getUserByHandle(handle)
    if (existing) {
      if (existing.kind !== 'local') throw new Error('handle belongs to a remote user')
      return existing
    }
    return repo.createLocalUser({ handle, displayName })
  }

  return {
    addRemoteUser(input: NewRemoteUser) {
      return repo.createRemoteUser(input)
    },
    async createLocalPostAs(handle: string, displayName: string, content: string): Promise<TimelineEntry> {
      const author = await ensureLocalUser(handle, displayName)
      const now = new Date().toISOString()
      const post: Post = { id: randomUUID(), authorId: author.id, source: 'local', guid: randomUUID(), content, url: null, publishedAt: now, createdAt: now }
      await repo.insertPost(post)
      const entry: TimelineEntry = { ...post, author }
      bus.emitNewPost(entry)
      return entry
    },
    getTimeline(limit = 100) {
      return repo.getTimeline(limit)
    },
  }
}

export type Service = ReturnType<typeof createService>
```

- [ ] **Step 4: Run — verify it passes** — Run: `npm test -w core`; Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(printf 'core: domain service (local compose, add remote, timeline)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 5: Remote-feed ingestion

**Files:**
- Create: `core/src/domain/ingest.ts`, `core/test/ingest.test.ts`

**Interfaces:**
- Produces:
  - `parseFeed(body: string, contentType: string): Array<{ guid: string; content: string; url: string | null; publishedAt: string }>` — handles JSON Feed (contentType containing `json`) and RSS/Atom (via rss-parser `parseString`). `guid` falls back to the item link; `content` is title+summary/content; `publishedAt` falls back to now.
  - `ingestRemoteUser(repo, bus, user, fetchFn = fetch): Promise<number>` — fetches `user.feedUrl`, parses, and for each item whose guid is not already stored, inserts a `remote` post authored by `user` and emits it. Returns the count of newly-inserted posts. Idempotent (dedup by guid).
  - `pollAll(repo, bus, fetchFn?): Promise<void>` — runs `ingestRemoteUser` for every remote user, swallowing per-user errors (logs them).
- Consumes: Repository, EventBus, types.

- [ ] **Step 1: Failing test (fake fetch, RSS + JSON fixtures, dedup)**

`core/test/ingest.test.ts`:
```ts
import { test, expect, vi } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { ingestRemoteUser } from '../src/domain/ingest.ts'

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>News</title>
<item><title>Hello</title><link>https://ex.com/1</link><guid>https://ex.com/1</guid><description>Body one</description><pubDate>Wed, 01 Jan 2026 00:00:00 GMT</pubDate></item>
</channel></rss>`

function fakeFetch(body: string, contentType: string) {
  return async () => new Response(body, { headers: { 'content-type': contentType } })
}

test('ingests RSS items as remote posts, once (idempotent), and emits new ones', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const user = await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
  const seen = vi.fn()
  bus.onNewPost(seen)

  const n1 = await ingestRemoteUser(repo, bus, user, fakeFetch(RSS, 'application/rss+xml'))
  expect(n1).toBe(1)
  expect(seen).toHaveBeenCalledTimes(1)

  const n2 = await ingestRemoteUser(repo, bus, user, fakeFetch(RSS, 'application/rss+xml'))
  expect(n2).toBe(0) // dedup by guid
  expect(seen).toHaveBeenCalledTimes(1)

  const tl = await repo.getTimeline(10)
  expect(tl[0].source).toBe('remote')
  expect(tl[0].author.handle).toBe('news')
  expect(tl[0].content).toContain('Hello')
})

test('parses JSON Feed items too', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const user = await repo.createRemoteUser({ handle: 'jf', displayName: 'JF', feedUrl: 'https://ex.com/f.json' })
  const json = JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', items: [{ id: 'a1', url: 'https://ex.com/a1', title: 'JF One', content_text: 'jf body', date_published: '2026-01-01T00:00:00Z' }] })
  const n = await ingestRemoteUser(repo, bus, user, fakeFetch(json, 'application/feed+json'))
  expect(n).toBe(1)
  const tl = await repo.getTimeline(10)
  expect(tl[0].guid).toBe('a1')
})
```

- [ ] **Step 2: Run — verify it fails** — Run: `npm test -w core`; Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`core/src/domain/ingest.ts`:
```ts
import { randomUUID } from 'node:crypto'
import Parser from 'rss-parser'
import type { Repository } from './repository.ts'
import type { EventBus } from './bus.ts'
import type { User, Post } from './types.ts'

export interface ParsedItem { guid: string; content: string; url: string | null; publishedAt: string }

const rss = new Parser()

export async function parseFeed(body: string, contentType: string): Promise<ParsedItem[]> {
  const now = new Date().toISOString()
  if (contentType.includes('json')) {
    const feed = JSON.parse(body) as { items?: Array<Record<string, unknown>> }
    return (feed.items ?? []).map((it) => {
      const title = typeof it.title === 'string' ? it.title : ''
      const text = typeof it.content_text === 'string' ? it.content_text : typeof it.content_html === 'string' ? it.content_html : ''
      const url = typeof it.url === 'string' ? it.url : null
      const guid = typeof it.id === 'string' ? it.id : url ?? randomUUID()
      const date = typeof it.date_published === 'string' ? new Date(it.date_published).toISOString() : now
      return { guid, content: [title, text].filter(Boolean).join(' — '), url, publishedAt: date }
    })
  }
  const feed = await rss.parseString(body)
  return (feed.items ?? []).map((it) => {
    const url = it.link ?? null
    const guid = it.guid ?? url ?? randomUUID()
    const text = it.contentSnippet ?? it.content ?? ''
    const date = it.isoDate ? new Date(it.isoDate).toISOString() : now
    return { guid, content: [it.title, text].filter(Boolean).join(' — '), url, publishedAt: date }
  })
}

export async function ingestRemoteUser(repo: Repository, bus: EventBus, user: User, fetchFn: typeof fetch = fetch): Promise<number> {
  if (!user.feedUrl) return 0
  const res = await fetchFn(user.feedUrl)
  const body = await res.text()
  const contentType = res.headers.get('content-type') ?? ''
  const items = await parseFeed(body, contentType)
  let inserted = 0
  for (const item of items) {
    if (await repo.hasPostGuid(item.guid)) continue
    const now = new Date().toISOString()
    const post: Post = { id: randomUUID(), authorId: user.id, source: 'remote', guid: item.guid, content: item.content, url: item.url, publishedAt: item.publishedAt, createdAt: now }
    await repo.insertPost(post)
    bus.emitNewPost({ ...post, author: user })
    inserted++
  }
  return inserted
}

export async function pollAll(repo: Repository, bus: EventBus, fetchFn: typeof fetch = fetch): Promise<void> {
  for (const user of await repo.listRemoteUsers()) {
    try { await ingestRemoteUser(repo, bus, user, fetchFn) }
    catch (err) { console.error(`ingest failed for ${user.handle}:`, err instanceof Error ? err.message : err) }
  }
}
```

- [ ] **Step 4: Run — verify it passes** — Run: `npm test -w core`; Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(printf 'core: remote-feed ingestion (RSS/Atom + JSON Feed, idempotent)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 6: Hono Core API — JSON routes + auth

**Files:**
- Create: `core/src/api/auth.ts`, `core/src/api/app.ts`, `core/test/api.test.ts`

**Interfaces:**
- Produces: `createApp({ service, bus, token }): Hono` with routes:
  - `POST /users` — body `{ handle, displayName, feedUrl }` → creates a remote user; returns `201 { user }`. No auth (adding a followable remote is open in the spine).
  - `POST /posts` — bearer-token required; body `{ handle, displayName, content }` → `createLocalPostAs`; returns `201 { post }`.
  - `GET /timeline` — returns `200 { timeline }` (array of TimelineEntry).
  - `GET /timeline/stream` — SSE (Task 7).
  - Auth: `bearerAuth(token)` middleware reads `Authorization: Bearer <token>`; 401 on mismatch.
- Consumes: `Service` (Task 4), `EventBus` (Task 3).

- [ ] **Step 1: Failing test (via app.request, no port)**

`core/test/api.test.ts`:
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
  return createApp({ service, bus, token: 'secret' })
}

test('POST /posts requires the bearer token', async () => {
  const app = await makeApp()
  const res = await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', displayName: 'Alice', content: 'hi' }) })
  expect(res.status).toBe(401)
})

test('POST /posts then GET /timeline shows the post', async () => {
  const app = await makeApp()
  const post = await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: JSON.stringify({ handle: 'alice', displayName: 'Alice', content: 'hi there' }) })
  expect(post.status).toBe(201)
  const tl = await app.request('/timeline')
  const body = await tl.json()
  expect(body.timeline[0].content).toBe('hi there')
})

test('POST /users adds a remote user', async () => {
  const app = await makeApp()
  const res = await app.request('/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' }) })
  expect(res.status).toBe(201)
  expect((await res.json()).user.kind).toBe('remote')
})
```

- [ ] **Step 2: Run — verify it fails** — Run: `npm test -w core`; Expected: FAIL (module missing).

- [ ] **Step 3: Implement auth + app**

`core/src/api/auth.ts`:
```ts
import type { MiddlewareHandler } from 'hono'

export function bearerAuth(token: string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header('authorization') ?? ''
    if (header !== `Bearer ${token}`) return c.json({ error: 'unauthorized' }, 401)
    await next()
  }
}
```

`core/src/api/app.ts`:
```ts
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { bearerAuth } from './auth.ts'
import type { Service } from '../domain/service.ts'
import type { EventBus } from '../domain/bus.ts'

export function createApp(deps: { service: Service; bus: EventBus; token: string }): Hono {
  const { service, bus, token } = deps
  const app = new Hono()

  app.get('/health', (c) => c.json({ ok: true }))

  app.post('/users', async (c) => {
    const { handle, displayName, feedUrl } = await c.req.json()
    const user = await service.addRemoteUser({ handle, displayName, feedUrl })
    return c.json({ user }, 201)
  })

  app.post('/posts', bearerAuth(token), async (c) => {
    const { handle, displayName, content } = await c.req.json()
    const post = await service.createLocalPostAs(handle, displayName, content)
    return c.json({ post }, 201)
  })

  app.get('/timeline', async (c) => {
    const timeline = await service.getTimeline(100)
    return c.json({ timeline })
  })

  app.get('/timeline/stream', (c) =>
    streamSSE(c, async (stream) => {
      const off = bus.onNewPost((entry) => { void stream.writeSSE({ event: 'post', data: JSON.stringify(entry) }) })
      stream.onAbort(off)
      while (!stream.aborted) { await stream.sleep(15000); await stream.writeSSE({ event: 'ping', data: '' }) }
    }),
  )

  return app
}
```

- [ ] **Step 4: Run — verify it passes** — Run: `npm test -w core`; Expected: PASS (the 3 API tests; the SSE route is covered in Task 7).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(printf 'core: Hono API routes (users, posts, timeline) + bearer auth\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 7: SSE stream test (the live firehose)

**Files:**
- Create: `core/test/sse.test.ts`

**Interfaces:**
- Consumes: `createApp` (Task 6). No new production code — this task proves the `GET /timeline/stream` route wired in Task 6 pushes bus events. If the test reveals a wiring bug, fix `api/app.ts` here.

- [ ] **Step 1: Failing test — read one SSE frame produced by a bus emit**

`core/test/sse.test.ts`:
```ts
import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'

test('GET /timeline/stream emits an SSE "post" frame when a post is created', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const app = createApp({ service, bus, token: 'secret' })

  const res = await app.request('/timeline/stream')
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()

  // Give the stream a tick to subscribe, then emit.
  await new Promise((r) => setTimeout(r, 20))
  await service.createLocalPostAs('alice', 'Alice', 'live post')

  let buf = ''
  while (!buf.includes('event: post')) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value)
  }
  await reader.cancel()
  expect(buf).toContain('event: post')
  expect(buf).toContain('live post')
})
```

- [ ] **Step 2: Run — verify it passes (or fails and you fix the wiring)**

Run: `npm test -w core`
Expected: PASS. If it hangs or fails, the likely cause is the subscribe/emit ordering — ensure `bus.onNewPost` is registered before the first `sleep`, exactly as written in Task 6. (The 20ms wait before emitting covers the subscribe tick.)

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "$(printf 'core: test the SSE firehose end to end\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 8: Config + server entrypoint + poller

**Files:**
- Create: `core/src/config.ts`, `core/src/server.ts`, `core/.env.example`

**Interfaces:**
- Produces: a runnable Core API. `config.ts` reads env: `TEXTCASTER_DB` (default `./data/textcaster.db`), `TEXTCASTER_TOKEN` (required), `TEXTCASTER_PORT` (default `8787`), `TEXTCASTER_POLL_SECONDS` (default `60`), `TEXTCASTER_CORS_ORIGIN` (default `http://localhost:5173`). `server.ts` wires repo+bus+service+app, adds a permissive-to-the-web-origin CORS, `serve()`s on the port, and starts a `setInterval` poller calling `pollAll`.
- Consumes: everything above.

- [ ] **Step 1: Config with a tiny test**

`core/src/config.ts`:
```ts
export interface Config { dbPath: string; token: string; port: number; pollSeconds: number; corsOrigin: string }

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env.TEXTCASTER_TOKEN
  if (!token) throw new Error('TEXTCASTER_TOKEN is required')
  return {
    dbPath: env.TEXTCASTER_DB ?? './data/textcaster.db',
    token,
    port: Number(env.TEXTCASTER_PORT ?? '8787'),
    pollSeconds: Number(env.TEXTCASTER_POLL_SECONDS ?? '60'),
    corsOrigin: env.TEXTCASTER_CORS_ORIGIN ?? 'http://localhost:5173',
  }
}
```

`core/test/config.test.ts`:
```ts
import { test, expect } from 'vitest'
import { loadConfig } from '../src/config.ts'

test('requires a token', () => {
  expect(() => loadConfig({})).toThrow('TEXTCASTER_TOKEN')
})
test('applies defaults', () => {
  const c = loadConfig({ TEXTCASTER_TOKEN: 't' })
  expect(c.port).toBe(8787)
  expect(c.pollSeconds).toBe(60)
})
```

- [ ] **Step 2: Run — verify the config test passes** — Run: `npm test -w core`; Expected: PASS.

- [ ] **Step 3: Add `@hono/node-server` CORS + entrypoint**

Add dependency `@hono/node-server` (already in Task 1's package.json). Hono ships CORS at `hono/cors`.

`core/src/server.ts`:
```ts
import { serve } from '@hono/node-server'
import { cors } from 'hono/cors'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { loadConfig } from './config.ts'
import { createSqliteRepository } from './storage/sqlite.ts'
import { createEventBus } from './domain/bus.ts'
import { createService } from './domain/service.ts'
import { createApp } from './api/app.ts'
import { pollAll } from './domain/ingest.ts'

const config = loadConfig()
if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true })

const repo = await createSqliteRepository(config.dbPath)
const bus = createEventBus()
const service = createService(repo, bus)
const app = createApp({ service, bus, token: config.token })
app.use('*', cors({ origin: config.corsOrigin, credentials: true }))

setInterval(() => { void pollAll(repo, bus) }, config.pollSeconds * 1000)

serve({ fetch: app.fetch, port: config.port })
console.log(`textcaster core listening on :${config.port}`)
```

`core/.env.example`:
```
TEXTCASTER_TOKEN=change-me
TEXTCASTER_DB=./data/textcaster.db
TEXTCASTER_PORT=8787
TEXTCASTER_POLL_SECONDS=60
TEXTCASTER_CORS_ORIGIN=http://localhost:5173
```

Note: `app.use('*', cors(...))` must run before routes match for preflight; if CORS headers are missing in manual testing, move the `app.use` into `createApp` before the routes. Keep it in `server.ts` for now (tests don't need CORS).

- [ ] **Step 4: Smoke-run the server manually**

Run:
```bash
TEXTCASTER_TOKEN=dev npm run dev -w core &
sleep 2
curl -s localhost:8787/health
curl -s -XPOST localhost:8787/posts -H 'authorization: Bearer dev' -H 'content-type: application/json' -d '{"handle":"alice","displayName":"Alice","content":"first post"}'
curl -s localhost:8787/timeline
kill %1
```
Expected: `{"ok":true}`, a `201` post, and a timeline containing "first post".

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(printf 'core: config, server entrypoint, background poller\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 9: SvelteKit web app scaffold + API client

**Files:**
- Create: the SvelteKit app in `web/` (via `sv create`), `web/src/lib/api.ts`, `web/.env.example`
- Modify: `web/package.json` (name, ensure vitest)

**Interfaces:**
- Produces: a running SvelteKit dev server, and `src/lib/api.ts` — a *server-side* Core API client: `getTimeline(fetch)`, `createPost(fetch, { handle, displayName, content })`, `addRemoteUser(fetch, { handle, displayName, feedUrl })`. Base URL from `CORE_API_URL` (server env), token from `CORE_API_TOKEN` (server env, never shipped to the browser).
- Consumes: the Core API HTTP surface (Task 6). NEVER imports from `core/`.

- [ ] **Step 1: Scaffold SvelteKit**

Run (from repo root):
```bash
cd web && npx sv create . --template minimal --types ts --no-add-ons && cd ..
```
If `web/` must be created first: `npm create svelte@latest web` with the "Skeleton project" + TypeScript options. Ensure `web/package.json` name is `@textcaster/web` and `"type": "module"`.

- [ ] **Step 2: The server-side API client (with a test)**

`web/src/lib/api.ts`:
```ts
import { env } from '$env/dynamic/private'
import type { TimelineEntry } from './types.ts'

const base = () => env.CORE_API_URL ?? 'http://localhost:8787'
const token = () => env.CORE_API_TOKEN ?? ''

export async function getTimeline(f: typeof fetch): Promise<TimelineEntry[]> {
  const res = await f(`${base()}/timeline`)
  if (!res.ok) throw new Error(`timeline ${res.status}`)
  return (await res.json()).timeline
}

export async function createPost(f: typeof fetch, input: { handle: string; displayName: string; content: string }): Promise<void> {
  const res = await f(`${base()}/posts`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` }, body: JSON.stringify(input) })
  if (!res.ok) throw new Error(`createPost ${res.status}`)
}

export async function addRemoteUser(f: typeof fetch, input: { handle: string; displayName: string; feedUrl: string }): Promise<void> {
  const res = await f(`${base()}/users`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  if (!res.ok) throw new Error(`addRemoteUser ${res.status}`)
}
```

`web/src/lib/types.ts` — a frontend-owned copy of the wire shape (NOT imported from core; this is the clean boundary):
```ts
export interface TimelineEntry {
  id: string; content: string; url: string | null; publishedAt: string; source: 'local' | 'remote'
  author: { handle: string; displayName: string; kind: 'local' | 'remote' }
}
```

`web/src/lib/api.test.ts`:
```ts
import { test, expect, vi } from 'vitest'
import { getTimeline } from './api.ts'

test('getTimeline calls the core /timeline and returns entries', async () => {
  const f = vi.fn(async () => new Response(JSON.stringify({ timeline: [{ id: 'p1', content: 'hi', url: null, publishedAt: '', source: 'local', author: { handle: 'a', displayName: 'A', kind: 'local' } }] }), { status: 200 }))
  const tl = await getTimeline(f as unknown as typeof fetch)
  expect(tl[0].content).toBe('hi')
  expect(f).toHaveBeenCalledWith('http://localhost:8787/timeline')
})
```

`web/.env.example`:
```
CORE_API_URL=http://localhost:8787
CORE_API_TOKEN=change-me
PUBLIC_CORE_SSE_URL=http://localhost:8787/timeline/stream
```

- [ ] **Step 3: Run the web test** — Run: `npm test -w web` (or `npx vitest run` in `web/`); Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "$(printf 'web: SvelteKit scaffold + server-side Core API client\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 10: Timeline page — SSR, works with no JavaScript

**Files:**
- Create/Modify: `web/src/routes/+page.server.ts`, `web/src/routes/+page.svelte`

**Interfaces:**
- Produces: `load` returns `{ timeline }` by calling `getTimeline(fetch)` server-side; `+page.svelte` renders the list. No client JS required to see the timeline.
- Consumes: `getTimeline` (Task 9).

- [ ] **Step 1: `load` (with a test of the load function)**

`web/src/routes/+page.server.ts` (load only for now; actions in Task 11):
```ts
import type { PageServerLoad } from './$types'
import { getTimeline } from '$lib/api.ts'

export const load: PageServerLoad = async ({ fetch }) => {
  const timeline = await getTimeline(fetch)
  return { timeline }
}
```

`web/src/routes/page.load.test.ts`:
```ts
import { test, expect, vi } from 'vitest'
import { load } from './+page.server.ts'

test('load returns the timeline from the core API', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ timeline: [{ id: 'p1', content: 'hello', url: null, publishedAt: '', source: 'local', author: { handle: 'a', displayName: 'A', kind: 'local' } }] }), { status: 200 }))
  const result = await load({ fetch } as never)
  expect(result.timeline[0].content).toBe('hello')
})
```

- [ ] **Step 2: Run — verify it fails then passes** — Run: `npm test -w web`; write `+page.server.ts` to make it pass. Expected: PASS.

- [ ] **Step 3: Render the timeline (no-JS)**

`web/src/routes/+page.svelte`:
```svelte
<script lang="ts">
  import type { PageData } from './$types'
  export let data: PageData
</script>

<h1>Textcaster</h1>

<ul class="timeline">
  {#each data.timeline as post (post.id)}
    <li class="post" class:remote={post.source === 'remote'}>
      <strong>{post.author.displayName}</strong>
      <span class="handle">@{post.author.handle}</span>
      <span class="kind">{post.source}</span>
      <p>{post.content}</p>
      {#if post.url}<a href={post.url} rel="noreferrer">source</a>{/if}
    </li>
  {/each}
</ul>
```

- [ ] **Step 4: Manual no-JS check**

Run the core (Task 8) + `npm run dev -w web`; open the site with JavaScript disabled in the browser. Expected: the timeline renders fully (SSR). Post something via `curl` to the core and reload — it appears.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(printf 'web: SSR timeline page (renders with no JavaScript)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 11: Compose + add-remote forms — plain POSTs, no-JS

**Files:**
- Modify: `web/src/routes/+page.server.ts` (add `actions`), `web/src/routes/+page.svelte` (add two `<form method="POST">`)

**Interfaces:**
- Produces: two SvelteKit form actions — `?/compose` (fields `handle`, `displayName`, `content` → `createPost`) and `?/addRemote` (fields `handle`, `displayName`, `feedUrl` → `addRemoteUser`). Both are plain HTML form POSTs that work with no JS; on success they redirect back to `/` (so the SSR reload shows the new state).
- Consumes: `createPost`, `addRemoteUser` (Task 9).

- [ ] **Step 1: Actions (with a test)**

Append to `web/src/routes/+page.server.ts`:
```ts
import { fail, redirect } from '@sveltejs/kit'
import { createPost, addRemoteUser } from '$lib/api.ts'

export const actions = {
  compose: async ({ request, fetch }) => {
    const form = await request.formData()
    const handle = String(form.get('handle') ?? '').trim()
    const displayName = String(form.get('displayName') ?? '').trim() || handle
    const content = String(form.get('content') ?? '').trim()
    if (!handle || !content) return fail(400, { error: 'handle and content are required' })
    await createPost(fetch, { handle, displayName, content })
    throw redirect(303, '/')
  },
  addRemote: async ({ request, fetch }) => {
    const form = await request.formData()
    const handle = String(form.get('handle') ?? '').trim()
    const displayName = String(form.get('displayName') ?? '').trim() || handle
    const feedUrl = String(form.get('feedUrl') ?? '').trim()
    if (!handle || !feedUrl) return fail(400, { error: 'handle and feedUrl are required' })
    await addRemoteUser(fetch, { handle, displayName, feedUrl })
    throw redirect(303, '/')
  },
}
```

`web/src/routes/page.actions.test.ts`:
```ts
import { test, expect, vi } from 'vitest'
import { actions } from './+page.server.ts'

function formRequest(fields: Record<string, string>): Request {
  const body = new URLSearchParams(fields)
  return new Request('http://x/?/compose', { method: 'POST', body })
}

test('compose posts to the core and redirects', async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 201 }))
  await expect(actions.compose({ request: formRequest({ handle: 'alice', content: 'hi' }), fetch } as never))
    .rejects.toMatchObject({ status: 303 }) // redirect throws
  expect(fetch).toHaveBeenCalled()
})

test('compose fails without content', async () => {
  const fetch = vi.fn()
  const res = await actions.compose({ request: formRequest({ handle: 'alice' }), fetch } as never)
  expect(res).toMatchObject({ status: 400 })
})
```

- [ ] **Step 2: Run — verify it fails then passes** — Run: `npm test -w web`; Expected: PASS.

- [ ] **Step 3: Add the forms (no-JS) to `+page.svelte`**

Insert above the `<ul class="timeline">`:
```svelte
<form method="POST" action="?/compose" class="composer">
  <input name="handle" placeholder="your handle" required />
  <input name="displayName" placeholder="display name (optional)" />
  <textarea name="content" placeholder="what's happening?" required></textarea>
  <button>Post</button>
</form>

<form method="POST" action="?/addRemote" class="add-remote">
  <input name="handle" placeholder="remote handle" required />
  <input name="displayName" placeholder="display name (optional)" />
  <input name="feedUrl" type="url" placeholder="https://their-site.com/feed.xml" required />
  <button>Add remote user</button>
</form>
```

- [ ] **Step 4: Manual no-JS check**

With JS disabled: submit the compose form → page reloads showing your post; submit add-remote with a real feed URL → within one poll interval its posts appear in the timeline. This is the thesis working end to end without any client JavaScript.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(printf 'web: compose + add-remote forms as plain no-JS POSTs\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 12: Live island — SSE progressive enhancement

**Files:**
- Create: `web/src/lib/LiveTimeline.svelte`
- Modify: `web/src/routes/+page.svelte` (mount the island, give the list an anchor)

**Interfaces:**
- Produces: a component that, **only in the browser**, opens an `EventSource` to `PUBLIC_CORE_SSE_URL` and prepends incoming `post` events to the top of the list. It renders nothing itself (it augments the SSR list). No-JS users are unaffected (the SSR list already showed everything).
- Consumes: `PUBLIC_CORE_SSE_URL` (a `PUBLIC_`-prefixed env var, safe for the browser).

- [ ] **Step 1: The island**

`web/src/lib/LiveTimeline.svelte`:
```svelte
<script lang="ts">
  import { onMount } from 'svelte'
  import { env } from '$env/dynamic/public'
  import type { TimelineEntry } from './types.ts'

  export let onPost: (entry: TimelineEntry) => void

  onMount(() => {
    const url = env.PUBLIC_CORE_SSE_URL
    if (!url) return
    const es = new EventSource(url)
    es.addEventListener('post', (ev) => {
      try { onPost(JSON.parse((ev as MessageEvent).data)) } catch {}
    })
    return () => es.close()
  })
</script>
```

- [ ] **Step 2: Wire it into the page**

Modify `web/src/routes/+page.svelte` `<script>` to hold a reactive live list and merge:
```svelte
<script lang="ts">
  import type { PageData } from './$types'
  import type { TimelineEntry } from '$lib/types.ts'
  import LiveTimeline from '$lib/LiveTimeline.svelte'
  export let data: PageData
  let live: TimelineEntry[] = []
  $: posts = [...live, ...data.timeline]
  function onPost(entry: TimelineEntry) {
    if (!posts.some((p) => p.id === entry.id)) live = [entry, ...live]
  }
</script>

<LiveTimeline {onPost} />
```
Then change the `{#each data.timeline ...}` to `{#each posts as post (post.id)}`.

- [ ] **Step 3: Manual live check (the payoff)**

Run core + web. Open the site in two browser tabs (JS enabled). In tab A, post via the compose form (or `curl` the core). Tab B's timeline shows the new post **without a refresh**. Add a remote feed; when the poller ingests new items, they appear live too. Then disable JS and confirm the page still fully works (just without live updates).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "$(printf 'web: live SSE island (progressive enhancement, no-JS unaffected)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 13: Run docs + whole-spine verification

**Files:**
- Create: `docs/RUNNING.md`
- Modify: `README.md` (link RUNNING.md; mark the spine as runnable)

**Interfaces:**
- Consumes: everything. Produces operator-facing run instructions and a scripted end-to-end check of the thesis.

- [ ] **Step 1: Write `docs/RUNNING.md`**

Cover: prerequisites (Node 20+); `npm install`; copy `core/.env.example` → `core/.env` (set `TEXTCASTER_TOKEN`) and `web/.env.example` → `web/.env` (set `CORE_API_TOKEN` to the same value, `CORE_API_URL`, `PUBLIC_CORE_SSE_URL`); run `npm run dev -w core` and `npm run dev -w web` in two terminals; open `http://localhost:5173`. Include the two-tab live test and the JS-disabled test. Note the two deployables and that the web app only ever talks to the core over HTTP.

- [ ] **Step 2: Full suite + end-to-end**

Run:
```bash
npm test -w core && npm test -w web
```
Expected: all green.

Then, manually (or scripted): start core, `curl` a local post, add a remote feed pointing at any real RSS URL, confirm both a local post and remote items appear in one `GET /timeline`, and confirm the web timeline shows both kinds — one live, unified timeline of local + remote users. That is the spine's thesis, proven.

- [ ] **Step 3: Commit + push**

```bash
git add -A
git commit -m "$(printf 'docs: running guide; spine is runnable end to end\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
# push once a remote is configured for the textcaster repo
```

---

## Self-Review (done at plan-writing time)

- **Spec coverage:** headless Core API + SvelteKit client → the whole plan; storage-agnostic Repository + SQLite adapter + contract suite → Task 2; local compose → Task 4/6; remote-feed ingestion (RSS/Atom + JSON Feed, idempotent) → Task 5; unified timeline → Task 2/4/6/10; in-process event bus → Task 3; SSE firehose → Task 6/7/12; token auth → Task 6; no-JS by construction → Tasks 10/11 (SSR + form actions), enhancement in 12; two deployables → core (1-8) + web (9-13); clean separation (web never imports core; own wire types) → Task 9. Deferred items appear nowhere. ✅
- **Placeholder scan:** every code step has complete code; no TBD/TODO in tasks. The one intentional prose step is `docs/RUNNING.md`'s outline (Task 13), whose exact commands are defined in earlier tasks.
- **Type consistency:** `User`/`Post`/`TimelineEntry` defined in Task 2 and used verbatim in 3/4/5/6; `Repository` method names identical across contract (2), service (4), ingest (5); `createLocalPostAs(handle, displayName, content)` named identically in service (4), API (6), SSE test (7); `EventBus.onNewPost`/`emitNewPost` identical in 3/6; the web wire type `TimelineEntry` (Task 9) is intentionally a separate, smaller frontend copy (the clean boundary) — noted so it is not mistaken for a drift.
