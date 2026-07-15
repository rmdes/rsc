# Textcaster Feed Output + Push-Out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit per-local-user RSS 2.0 + JSON Feed and publish-side push (WebSub external/self hub, rssCloud), closing the federation loop: another Textcaster instance ingests our users as remotes over plain RSS.

**Architecture:** All core-side; web/ untouched. One shared feed mapper (`domain/feed.ts`) feeds two public routes; one push subsystem (`domain/push.ts` + `domain/push-guard.ts`) with a single `subscriptions` registry (migration 2) behind the Repository contract, reacting to the existing event bus, with protocol adapters for WebSub fat-ping and rssCloud thin-ping. Push is opt-in and off by default.

**Tech Stack:** Existing only — feedsmith 2.9.6 (generate APIs probed), Hono, Kysely/better-sqlite3, node:crypto, node:dns, node:net. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-15-textcaster-feed-output-design.md` (rev 3, binding). Review context: `docs/superpowers/reviews/2026-07-15-feed-output-spec-review.md`.

## Global Constraints

- TypeScript/ESM; no new dependencies; Node 22.18+ (engines already pinned).
- Storage-agnostic core: no Kysely/SQLite outside `core/src/storage/`; contract suite exercises only the `Repository` interface; web/ untouched this milestone.
- **Push is opt-in**: `TEXTCASTER_WEBSUB` defaults `off`; `TEXTCASTER_RSSCLOUD` defaults `off`; existing `.env`s upgrade unchanged. Fail-fast on missing/invalid `TEXTCASTER_PUBLIC_URL` ONLY when push is explicitly enabled.
- Textcasting profile: item title ONLY when `post.title` is non-null (never synthesized); full content, no truncation; `guid isPermaLink="false"`; channel description unconditional (`Posts by <displayName>`).
- H2 hardening (all three, structural — not rate limiting): challenge-verify EVERY registration including no-domain rssCloud; reject loopback/link-local/private/`localhost` callback hosts at registration (DNS-resolved); caps MAX 20 active subscriptions per callback_host, MAX 500 per topic.
- H3: topic validity = exact string equality against re-minted `PUBLIC_URL + '/users/' + handle + '/feed.xml|json'` of an existing LOCAL user. No normalization, no prefix matching.
- H4: `push.onLocalPost` NEVER rejects (top-level try/catch); wired as `bus.onNewPost((e) => { void push.onLocalPost(e) })`.
- Feedsmith facts (probed): `generateJsonFeed` returns an OBJECT (stringify it); empty `registerProcedure` is omitted from `<cloud>` output (expected); channel `description` required.
- Fat-ping body regenerated once per topic per event; same body (and HMAC input) for every subscriber of that topic.
- TDD; failing test first. Commit after each task; end every commit message with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Scoped `git add` of named files only — never `-A`.

## File structure

```
core/src/config.ts               # + publicUrl, websub mode, rssCloud (Task 1)
core/src/domain/types.ts         # + Subscription (Task 2)
core/src/domain/repository.ts    # + subscription methods, getPostsByAuthor (Tasks 2-3)
core/src/domain/repository-contract.ts  # + pins (Tasks 2-3)
core/src/storage/sqlite.ts       # + migration 2, subscription queries, getPostsByAuthor (Tasks 2-3)
core/src/domain/feed.ts          # NEW: mapper + hubLinkUrl + feedUrls (Task 4)
core/src/api/app.ts              # + feed routes (Task 4), /hub + /rsscloud routes (Tasks 6-7)
core/src/domain/push-guard.ts    # NEW: SSRF guard (Task 5)
core/src/domain/push.ts          # NEW: onLocalPost + registrations + deliveries (Tasks 5-7)
core/src/server.ts               # + push wiring, purge in poller (Task 5)
core/test/*                      # per task
docs/superpowers/documentation/RUNNING.md  # feeds & push section (Task 8)
```

---

### Task 1: Config — public URL + push modes

**Files:**
- Modify: `core/src/config.ts` (whole-file replacement below)
- Modify: `core/test/config.test.ts` (append tests)

**Interfaces:**
- Consumes: nothing new.
- Produces (later tasks rely on these exact shapes):
  - `type WebSubMode = { mode: 'off' } | { mode: 'self' } | { mode: 'external'; hubUrl: string }`
  - `Config` gains `publicUrl: string | null` (trailing slashes stripped), `websub: WebSubMode`, `rssCloud: boolean`.

- [ ] **Step 1: Write the failing tests**

Append to `core/test/config.test.ts`:
```ts
test('push defaults off and publicUrl defaults null', () => {
  const c = loadConfig({ TEXTCASTER_TOKEN: 't' })
  expect(c.websub).toEqual({ mode: 'off' })
  expect(c.rssCloud).toBe(false)
  expect(c.publicUrl).toBeNull()
})
test('publicUrl is normalized and must be http(s)', () => {
  const c = loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_PUBLIC_URL: 'https://cast.example.com/' })
  expect(c.publicUrl).toBe('https://cast.example.com')
  expect(() => loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_PUBLIC_URL: 'ftp://x' })).toThrow('TEXTCASTER_PUBLIC_URL')
})
test('websub modes parse: self, external URL, garbage rejected', () => {
  const base = { TEXTCASTER_TOKEN: 't', TEXTCASTER_PUBLIC_URL: 'https://cast.example.com' }
  expect(loadConfig({ ...base, TEXTCASTER_WEBSUB: 'self' }).websub).toEqual({ mode: 'self' })
  expect(loadConfig({ ...base, TEXTCASTER_WEBSUB: 'https://websubhub.com/hub' }).websub).toEqual({ mode: 'external', hubUrl: 'https://websubhub.com/hub' })
  expect(() => loadConfig({ ...base, TEXTCASTER_WEBSUB: 'not a url' })).toThrow('TEXTCASTER_WEBSUB')
})
test('explicitly enabled push without publicUrl fails fast', () => {
  expect(() => loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_WEBSUB: 'self' })).toThrow('TEXTCASTER_PUBLIC_URL')
  expect(() => loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_RSSCLOUD: 'on' })).toThrow('TEXTCASTER_PUBLIC_URL')
})
test('rssCloud accepts only on/off', () => {
  const base = { TEXTCASTER_TOKEN: 't', TEXTCASTER_PUBLIC_URL: 'https://cast.example.com' }
  expect(loadConfig({ ...base, TEXTCASTER_RSSCLOUD: 'on' }).rssCloud).toBe(true)
  expect(() => loadConfig({ ...base, TEXTCASTER_RSSCLOUD: 'yes' })).toThrow('TEXTCASTER_RSSCLOUD')
})
```

- [ ] **Step 2: Run — verify RED**

Run: `npm test -w core`
Expected: FAIL — `c.websub`/`c.rssCloud`/`c.publicUrl` are `undefined` (properties don't exist), the throw-cases don't throw.

- [ ] **Step 3: Implement — replace `core/src/config.ts` entirely**

```ts
export type WebSubMode = { mode: 'off' } | { mode: 'self' } | { mode: 'external'; hubUrl: string }

export interface Config {
  dbPath: string
  token: string
  port: number
  pollSeconds: number
  publicUrl: string | null
  websub: WebSubMode
  rssCloud: boolean
}

function positiveInt(name: string, raw: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`)
  return n
}

function httpUrl(name: string, raw: string): string {
  try {
    const protocol = new URL(raw).protocol
    if (protocol === 'http:' || protocol === 'https:') return raw
  } catch {
    // fall through to the throw below
  }
  throw new Error(`${name} must be an http(s) URL, got "${raw}"`)
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env.TEXTCASTER_TOKEN
  if (!token) throw new Error('TEXTCASTER_TOKEN is required')

  const rawPublic = env.TEXTCASTER_PUBLIC_URL
  const publicUrl = rawPublic ? httpUrl('TEXTCASTER_PUBLIC_URL', rawPublic).replace(/\/+$/, '') : null

  const rawWebsub = env.TEXTCASTER_WEBSUB ?? 'off'
  let websub: WebSubMode
  if (rawWebsub === 'off') websub = { mode: 'off' }
  else if (rawWebsub === 'self') websub = { mode: 'self' }
  else websub = { mode: 'external', hubUrl: httpUrl('TEXTCASTER_WEBSUB', rawWebsub) }

  const rawRssCloud = env.TEXTCASTER_RSSCLOUD ?? 'off'
  if (rawRssCloud !== 'on' && rawRssCloud !== 'off') throw new Error(`TEXTCASTER_RSSCLOUD must be "on" or "off", got "${rawRssCloud}"`)
  const rssCloud = rawRssCloud === 'on'

  // Fail-fast ONLY for explicitly enabled push (spec H1): defaults stay bootable.
  if ((websub.mode !== 'off' || rssCloud) && !publicUrl) {
    throw new Error('TEXTCASTER_PUBLIC_URL is required when TEXTCASTER_WEBSUB or TEXTCASTER_RSSCLOUD is enabled')
  }

  return {
    dbPath: env.TEXTCASTER_DB ?? './data/textcaster.db',
    token,
    port: positiveInt('TEXTCASTER_PORT', env.TEXTCASTER_PORT ?? '8787'),
    pollSeconds: positiveInt('TEXTCASTER_POLL_SECONDS', env.TEXTCASTER_POLL_SECONDS ?? '60'),
    publicUrl,
    websub,
    rssCloud,
  }
}
```

- [ ] **Step 4: Run — verify GREEN**

Run: `npm test -w core` then `npm run typecheck -w core`
Expected: all tests pass (existing config tests untouched and still green); typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add core/src/config.ts core/test/config.test.ts
git commit -m "$(printf 'core: config for public URL and opt-in push modes (websub/rsscloud)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 2: Migration 2 — subscriptions registry + contract pins + upgrade test

**Files:**
- Modify: `core/src/domain/types.ts` (append `Subscription`)
- Modify: `core/src/domain/repository.ts` (5 new methods)
- Modify: `core/src/storage/sqlite.ts` (table type, migration 2, queries)
- Modify: `core/src/domain/repository-contract.ts` (pins)
- Modify: `core/test/migrations.test.ts` (fresh-DB version bump + 1→2 upgrade test)

**Interfaces:**
- Produces (exact shapes later tasks rely on):
  - `interface Subscription { id: string; protocol: 'websub' | 'rsscloud'; topic: string; callback: string; callbackHost: string; secret: string | null; expiresAt: string; createdAt: string }`
  - `upsertSubscription(s: Subscription): Promise<void>` — conflict on `(protocol, topic, callback)` DOES UPDATE `secret`, `expires_at`, `callback_host`.
  - `deleteSubscription(protocol: 'websub' | 'rsscloud', topic: string, callback: string): Promise<void>`
  - `listActiveSubscriptions(topic: string, now: string): Promise<Subscription[]>` — `expires_at > now`, both protocols.
  - `countActiveSubscriptions(filter: { callbackHost?: string; topic?: string }, now: string): Promise<number>`
  - `purgeExpiredSubscriptions(now: string): Promise<void>`

- [ ] **Step 1: Write the failing contract tests**

Add the import at the top of `core/src/domain/repository-contract.ts` if not importing types yet beyond Repository (append to the existing type import from `./types.ts` — the file already imports `HandleTakenError`):
```ts
import type { Subscription } from './types.ts'
```
Append inside the describe block (match file style — no semicolons):
```ts
    function sub(over: Partial<Subscription>): Subscription {
      return { id: crypto.randomUUID(), protocol: 'websub', topic: 'https://ex.com/users/alice/feed.xml', callback: 'https://cb.example.com/receive', callbackHost: 'cb.example.com', secret: null, expiresAt: '2027-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', ...over }
    }

    test('upsertSubscription inserts, and refreshes secret/expiry on the same triple', async () => {
      const repo = await makeRepo()
      await repo.upsertSubscription(sub({}))
      await repo.upsertSubscription(sub({ secret: 's3cret', expiresAt: '2028-01-01T00:00:00.000Z' }))
      const active = await repo.listActiveSubscriptions('https://ex.com/users/alice/feed.xml', '2026-06-01T00:00:00.000Z')
      expect(active.length).toBe(1)
      expect(active[0].secret).toBe('s3cret')
      expect(active[0].expiresAt).toBe('2028-01-01T00:00:00.000Z')
    })

    test('listActiveSubscriptions filters expired rows and returns both protocols', async () => {
      const repo = await makeRepo()
      await repo.upsertSubscription(sub({ callback: 'https://cb1.example.com/a', callbackHost: 'cb1.example.com' }))
      await repo.upsertSubscription(sub({ protocol: 'rsscloud', callback: 'http://cb2.example.com:5337/notify', callbackHost: 'cb2.example.com' }))
      await repo.upsertSubscription(sub({ callback: 'https://cb3.example.com/x', callbackHost: 'cb3.example.com', expiresAt: '2026-01-02T00:00:00.000Z' }))
      const active = await repo.listActiveSubscriptions('https://ex.com/users/alice/feed.xml', '2026-06-01T00:00:00.000Z')
      expect(active.map((s) => s.callbackHost).sort()).toEqual(['cb1.example.com', 'cb2.example.com'])
    })

    test('deleteSubscription removes exactly the triple', async () => {
      const repo = await makeRepo()
      await repo.upsertSubscription(sub({}))
      await repo.deleteSubscription('websub', 'https://ex.com/users/alice/feed.xml', 'https://cb.example.com/receive')
      expect(await repo.listActiveSubscriptions('https://ex.com/users/alice/feed.xml', '2026-06-01T00:00:00.000Z')).toEqual([])
    })

    test('countActiveSubscriptions counts by callbackHost and by topic, excluding expired', async () => {
      const repo = await makeRepo()
      await repo.upsertSubscription(sub({ callback: 'https://cb.example.com/a' }))
      await repo.upsertSubscription(sub({ callback: 'https://cb.example.com/b' }))
      await repo.upsertSubscription(sub({ callback: 'https://cb.example.com/dead', expiresAt: '2026-01-02T00:00:00.000Z' }))
      await repo.upsertSubscription(sub({ topic: 'https://ex.com/users/bob/feed.xml', callback: 'https://other.example.com/x', callbackHost: 'other.example.com' }))
      const now = '2026-06-01T00:00:00.000Z'
      expect(await repo.countActiveSubscriptions({ callbackHost: 'cb.example.com' }, now)).toBe(2)
      expect(await repo.countActiveSubscriptions({ topic: 'https://ex.com/users/alice/feed.xml' }, now)).toBe(2)
    })

    test('purgeExpiredSubscriptions deletes only expired rows', async () => {
      const repo = await makeRepo()
      await repo.upsertSubscription(sub({}))
      await repo.upsertSubscription(sub({ callback: 'https://cb.example.com/dead', expiresAt: '2026-01-02T00:00:00.000Z' }))
      await repo.purgeExpiredSubscriptions('2026-06-01T00:00:00.000Z')
      expect(await repo.countActiveSubscriptions({ callbackHost: 'cb.example.com' }, '2020-01-01T00:00:00.000Z')).toBe(1)
    })
```
(`crypto.randomUUID()` is global in Node 22+ — no import needed in the contract file.)

- [ ] **Step 2: Update migration tests**

In `core/test/migrations.test.ts`: change the fresh-DB assertion `expect(raw.pragma('user_version', { simple: true })).toBe(1)` to `.toBe(2)`. Then append the upgrade test — it hand-builds a REAL version-1 database from the frozen v1 schema (copied literally; migration arrays must never be edited retroactively):
```ts
const V1_SCHEMA = [
  `CREATE TABLE users (
      id text PRIMARY KEY,
      kind text NOT NULL,
      handle text NOT NULL UNIQUE,
      display_name text NOT NULL,
      feed_url text,
      created_at text NOT NULL
    )`,
  `CREATE TABLE posts (
      id text PRIMARY KEY,
      author_id text NOT NULL REFERENCES users(id),
      source text NOT NULL,
      guid text NOT NULL,
      title text,
      content text NOT NULL,
      url text,
      published_at text NOT NULL,
      created_at text NOT NULL,
      CONSTRAINT posts_author_guid_uq UNIQUE (author_id, guid)
    )`,
  'CREATE INDEX posts_published_idx ON posts (published_at, id)',
  'CREATE INDEX posts_created_idx ON posts (created_at, id)',
]

test('a version-1 database upgrades in place to version 2 with data preserved', async () => {
  const file = tempDb()
  const raw = new Database(file)
  for (const stmt of V1_SCHEMA) raw.exec(stmt)
  raw.prepare("INSERT INTO users VALUES ('u1','local','alice','Alice',NULL,'2026-01-01T00:00:00.000Z')").run()
  raw.prepare("INSERT INTO posts VALUES ('p1','u1','local','g1',NULL,'kept','','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')").run()
  raw.pragma('user_version = 1')
  raw.close()

  const repo = await createSqliteRepository(file)
  expect((await repo.getUserByHandle('alice'))?.displayName).toBe('Alice')
  expect((await repo.getTimeline(10)).map((e) => e.content)).toEqual(['kept'])
  await repo.upsertSubscription({ id: 'x1', protocol: 'websub', topic: 't', callback: 'c', callbackHost: 'h', secret: null, expiresAt: '2027-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
  const check = new Database(file, { readonly: true })
  expect(check.pragma('user_version', { simple: true })).toBe(2)
  check.close()
})
```

- [ ] **Step 3: Run — verify RED**

Run: `npm test -w core`
Expected: FAIL — `TypeError: repo.upsertSubscription is not a function` in the contract tests; the fresh-DB test fails on `2 !== 1`; the upgrade test fails the same way.

- [ ] **Step 4: Implement**

`core/src/domain/types.ts` — append:
```ts
export type PushProtocol = 'websub' | 'rsscloud'

export interface Subscription {
  id: string
  protocol: PushProtocol
  topic: string
  callback: string
  callbackHost: string
  secret: string | null
  expiresAt: string
  createdAt: string
}
```

`core/src/domain/repository.ts` — extend the type import with `Subscription, PushProtocol` and append to the interface:
```ts
  upsertSubscription(s: Subscription): Promise<void>
  deleteSubscription(protocol: PushProtocol, topic: string, callback: string): Promise<void>
  listActiveSubscriptions(topic: string, now: string): Promise<Subscription[]>
  countActiveSubscriptions(filter: { callbackHost?: string; topic?: string }, now: string): Promise<number>
  purgeExpiredSubscriptions(now: string): Promise<void>
```

`core/src/storage/sqlite.ts`:

1. Extend the type import with `Subscription, PushProtocol`. Add the table type and register it:
```ts
interface SubscriptionsTable { id: string; protocol: 'websub' | 'rsscloud'; topic: string; callback: string; callback_host: string; secret: string | null; expires_at: string; created_at: string }
interface DB { users: UsersTable; posts: PostsTable; subscriptions: SubscriptionsTable }
```
2. Row mapper next to the others:
```ts
function rowToSubscription(r: SubscriptionsTable): Subscription {
  return { id: r.id, protocol: r.protocol, topic: r.topic, callback: r.callback, callbackHost: r.callback_host, secret: r.secret, expiresAt: r.expires_at, createdAt: r.created_at }
}
```
3. Append **migration 2** to the `MIGRATIONS` array (a new inner array AFTER migration 1 — never edit migration 1):
```ts
  [
    `CREATE TABLE subscriptions (
      id text PRIMARY KEY,
      protocol text NOT NULL,
      topic text NOT NULL,
      callback text NOT NULL,
      callback_host text NOT NULL,
      secret text,
      expires_at text NOT NULL,
      created_at text NOT NULL,
      CONSTRAINT subscriptions_triple_uq UNIQUE (protocol, topic, callback)
    )`,
    'CREATE INDEX subscriptions_topic_idx ON subscriptions (topic, expires_at)',
    'CREATE INDEX subscriptions_host_idx ON subscriptions (callback_host, expires_at)',
  ],
```
4. Class methods (inside `SqliteRepository`):
```ts
  async upsertSubscription(s: Subscription) {
    await this.db
      .insertInto('subscriptions')
      .values({ id: s.id, protocol: s.protocol, topic: s.topic, callback: s.callback, callback_host: s.callbackHost, secret: s.secret, expires_at: s.expiresAt, created_at: s.createdAt })
      // Explicit conflict target + DO UPDATE: refreshes replace secret/expiry.
      // (The posts-table bare doNothing() pattern must not be copied here.)
      .onConflict((oc) => oc.columns(['protocol', 'topic', 'callback']).doUpdateSet({ secret: s.secret, expires_at: s.expiresAt, callback_host: s.callbackHost }))
      .execute()
  }
  async deleteSubscription(protocol: PushProtocol, topic: string, callback: string) {
    await this.db.deleteFrom('subscriptions').where('protocol', '=', protocol).where('topic', '=', topic).where('callback', '=', callback).execute()
  }
  async listActiveSubscriptions(topic: string, now: string): Promise<Subscription[]> {
    const rows = await this.db.selectFrom('subscriptions').selectAll().where('topic', '=', topic).where('expires_at', '>', now).execute()
    return rows.map(rowToSubscription)
  }
  async countActiveSubscriptions(filter: { callbackHost?: string; topic?: string }, now: string): Promise<number> {
    let q = this.db.selectFrom('subscriptions').select(({ fn }) => fn.countAll().as('n')).where('expires_at', '>', now)
    if (filter.callbackHost !== undefined) q = q.where('callback_host', '=', filter.callbackHost)
    if (filter.topic !== undefined) q = q.where('topic', '=', filter.topic)
    const row = await q.executeTakeFirst()
    return Number(row?.n ?? 0)
  }
  async purgeExpiredSubscriptions(now: string) {
    await this.db.deleteFrom('subscriptions').where('expires_at', '<=', now).execute()
  }
```

- [ ] **Step 5: Repair the racy Repository stub (plan-review P1 — REQUIRED for typecheck)**

`core/test/service.test.ts` (~line 51) has a structurally-typed `const racy: Repository = { ...ten explicit delegations... }` stub. Growing the interface breaks it at `tsc --noEmit`. Replace the whole `racy` literal with a prototype-inheritance override so interface growth never breaks it again (NOTE: `{ ...repo }` spread does NOT work here — `repo` is a class instance and spread drops prototype methods):

```ts
  let firstLookup = true
  const racy: Repository = Object.assign(Object.create(repo), {
    getUserByHandle: async (h: string) => {
      if (firstLookup) { firstLookup = false; return undefined } // simulate pre-race view
      return repo.getUserByHandle(h)
    },
  })
```
(All other methods — current and future — are inherited from `repo` via the prototype chain; `this.db` still resolves through it. Delete the ten explicit delegation lines. The `import type { Repository }` stays.)

- [ ] **Step 6: Run — verify GREEN**

Run: `npm test -w core` then `npm run typecheck -w core`
Expected: all pass — 5 new contract tests, both migration changes, the repaired race test, everything prior. Typecheck exit 0.

- [ ] **Step 7: Commit**

```bash
git add core/src/domain/types.ts core/src/domain/repository.ts core/src/storage/sqlite.ts core/src/domain/repository-contract.ts core/test/migrations.test.ts core/test/service.test.ts
git commit -m "$(printf 'core: migration 2 — subscriptions registry in the Repository contract\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 3: `getPostsByAuthor`

**Files:**
- Modify: `core/src/domain/repository.ts`, `core/src/storage/sqlite.ts`, `core/src/domain/repository-contract.ts`

**Interfaces:**
- Produces: `getPostsByAuthor(authorId: string, limit: number): Promise<Post[]>` — ordered `published_at DESC, id DESC` (same display ordering as the timeline).

- [ ] **Step 1: Failing contract test** — append inside the describe block:
```ts
    test('getPostsByAuthor returns only that author, display-ordered, limited', async () => {
      const repo = await makeRepo()
      const a = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      const b = await repo.createLocalUser({ handle: 'bob', displayName: 'Bob' })
      for (let i = 1; i <= 3; i++) {
        await repo.insertPost({ id: `a${i}`, authorId: a.id, source: 'local', guid: `ga${i}`, title: null, content: `alice ${i}`, url: null, publishedAt: `2026-01-0${i}T00:00:00.000Z`, createdAt: `2026-01-0${i}T00:00:00.000Z` })
      }
      await repo.insertPost({ id: 'b1', authorId: b.id, source: 'local', guid: 'gb1', title: null, content: 'bob 1', url: null, publishedAt: '2026-01-09T00:00:00.000Z', createdAt: '2026-01-09T00:00:00.000Z' })
      const posts = await repo.getPostsByAuthor(a.id, 2)
      expect(posts.map((p) => p.id)).toEqual(['a3', 'a2'])
    })
```

- [ ] **Step 2: Run — verify RED** — `npm test -w core`; expected `TypeError: repo.getPostsByAuthor is not a function`.

- [ ] **Step 3: Implement**

`core/src/domain/repository.ts` — append to the interface:
```ts
  getPostsByAuthor(authorId: string, limit: number): Promise<Post[]>
```
`core/src/storage/sqlite.ts` — append to the class:
```ts
  async getPostsByAuthor(authorId: string, limit: number): Promise<Post[]> {
    const rows = await this.db.selectFrom('posts').selectAll().where('author_id', '=', authorId).orderBy('published_at', 'desc').orderBy('id', 'desc').limit(limit).execute()
    return rows.map(rowToPost)
  }
```

- [ ] **Step 4: Run — verify GREEN** — `npm test -w core` all pass; `npm run typecheck -w core` exit 0.

- [ ] **Step 5: Commit**

```bash
git add core/src/domain/repository.ts core/src/storage/sqlite.ts core/src/domain/repository-contract.ts
git commit -m "$(printf 'core: getPostsByAuthor for per-user feed windows\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 4: Feed mapper + the two feed routes

**Files:**
- Create: `core/src/domain/feed.ts`
- Modify: `core/src/domain/service.ts` (two passthroughs), `core/src/api/app.ts` (routes + deps)
- Create: `core/test/feed.test.ts`

**Interfaces:**
- Consumes: `getPostsByAuthor` (Task 3), `Config['websub']`/`publicUrl`/`rssCloud` shapes (Task 1), feedsmith generate APIs (probed).
- Produces:
  - `feedUrls(publicUrl: string, handle: string): { xml: string; json: string }`
  - `hubLinkUrl(websub: WebSubMode, publicUrl: string | null): string | null` — external → its hubUrl; self → `${publicUrl}/hub`; off or no publicUrl → null.
  - `interface FeedContext { publicUrl: string | null; hubUrl: string | null; rssCloud: boolean }`
  - `renderRssFeed(user: User, posts: Post[], ctx: FeedContext): string`
  - `renderJsonFeed(user: User, posts: Post[], ctx: FeedContext): string` (already stringified).
  - `createApp` deps gain optional `feeds?: FeedContext` (defaults `{ publicUrl: null, hubUrl: null, rssCloud: false }` so every existing test keeps compiling unchanged).
  - Service passthroughs: `getUserByHandle(handle: string)`, `getPostsByAuthor(authorId: string, limit: number)`.
  - Routes: `GET /users/:handle/feed.xml` (`application/rss+xml; charset=utf-8`), `GET /users/:handle/feed.json` (`application/feed+json; charset=utf-8`); 404 unknown/null-feedUrl-remote; 302 remote.

- [ ] **Step 1: Failing tests**

`core/test/feed.test.ts`:
```ts
import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'
import { parseFeed } from '../src/domain/ingest.ts'
import type { FeedContext } from '../src/domain/feed.ts'

const CTX: FeedContext = { publicUrl: 'https://cast.example.com', hubUrl: 'https://cast.example.com/hub', rssCloud: true }

async function makeApp(feeds?: FeedContext) {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const app = createApp({ service, bus, token: 'secret', feeds })
  return { repo, service, app }
}

async function seedAlice(service: Awaited<ReturnType<typeof makeApp>>['service']) {
  await service.createLocalPostAs('alice', 'Alice', 'first body')
  await service.createLocalPostAs('alice', 'Alice', 'second body')
}

test('RSS feed round-trips through our own parser (Textcasting profile intact)', async () => {
  const { service, app } = await makeApp(CTX)
  await seedAlice(service)
  const res = await app.request('/users/alice/feed.xml')
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('application/rss+xml')
  const body = await res.text()
  const items = await parseFeed(body)
  expect(items.length).toBe(2)
  expect(items.map((i) => i.content)).toContain('first body')
  expect(items[0].title).toBeNull() // local posts are title-less; never synthesized
  expect(items[0].guid).toBeTruthy()
})

test('RSS raw output carries the profile and discovery markers', async () => {
  const { service, app } = await makeApp(CTX)
  await seedAlice(service)
  const body = await (await app.request('/users/alice/feed.xml')).text()
  expect(body).toContain('<guid isPermaLink="false">')
  expect(body).toContain('rel="self"')
  expect(body).toContain('rel="hub"')
  expect(body).toContain('<cloud ')
  expect(body).toContain('<description>Posts by Alice</description>')
  expect(body).not.toContain('<title></title>') // no synthesized empty titles
})

test('JSON Feed round-trips and carries version + hub', async () => {
  const { service, app } = await makeApp(CTX)
  await seedAlice(service)
  const res = await app.request('/users/alice/feed.json')
  expect(res.headers.get('content-type')).toContain('application/feed+json')
  const raw = await res.text()
  expect(raw).toContain('"version": "https://jsonfeed.org/version/1.1"')
  const items = await parseFeed(raw)
  expect(items.map((i) => i.content)).toContain('second body')
})

test('links are omitted without config: no self/hub/cloud when unset', async () => {
  const { service, app } = await makeApp() // defaults: all null/off
  await seedAlice(service)
  const body = await (await app.request('/users/alice/feed.xml')).text()
  expect(body).not.toContain('rel="hub"')
  expect(body).not.toContain('<cloud ')
})

test('unknown handle 404s; remote handle 302s to its canonical feed; null-feedUrl remote 404s', async () => {
  const { repo, app } = await makeApp(CTX)
  expect((await app.request('/users/nobody/feed.xml')).status).toBe(404)
  await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://news.example.com/feed.xml' })
  const redir = await app.request('/users/news/feed.xml')
  expect(redir.status).toBe(302)
  expect(redir.headers.get('location')).toBe('https://news.example.com/feed.xml')
})
```
(The null-feedUrl remote case is unreachable through the public API — service validation requires a feedUrl — so it is covered at the route level by the `user.kind === 'remote' && !user.feedUrl` guard; assert it exists via code, and the 302 test pins the reachable path. Do not contort a test to fabricate an impossible row through the contract.)

- [ ] **Step 2: Run — verify RED** — `npm test -w core`; expected: module not found `../src/domain/feed.ts`, then 404s once routes are missing.

- [ ] **Step 3: Implement the mapper**

`core/src/domain/feed.ts`:
```ts
import { generateRssFeed, generateJsonFeed } from 'feedsmith'
import type { WebSubMode } from '../config.ts'
import type { Post, User } from './types.ts'

export interface FeedContext {
  publicUrl: string | null
  hubUrl: string | null
  rssCloud: boolean
}

export function feedUrls(publicUrl: string, handle: string): { xml: string; json: string } {
  return { xml: `${publicUrl}/users/${handle}/feed.xml`, json: `${publicUrl}/users/${handle}/feed.json` }
}

export function hubLinkUrl(websub: WebSubMode, publicUrl: string | null): string | null {
  if (websub.mode === 'external') return websub.hubUrl
  if (websub.mode === 'self' && publicUrl) return `${publicUrl}/hub`
  return null
}

// Channel link is required by RSS 2.0; without a configured public URL there
// is no honest absolute URL, so use an explicitly-invalid placeholder host.
function channelLink(ctx: FeedContext, handle: string): string {
  return ctx.publicUrl ? `${ctx.publicUrl}/users/${handle}` : `https://textcaster.invalid/users/${handle}`
}

export function renderRssFeed(user: User, posts: Post[], ctx: FeedContext): string {
  const atomLinks: Array<{ href: string; rel: string; type?: string }> = []
  let cloud
  if (ctx.publicUrl) {
    atomLinks.push({ href: feedUrls(ctx.publicUrl, user.handle).xml, rel: 'self', type: 'application/rss+xml' })
    if (ctx.hubUrl) atomLinks.push({ href: ctx.hubUrl, rel: 'hub' })
    if (ctx.rssCloud) {
      const u = new URL(ctx.publicUrl)
      cloud = {
        domain: u.hostname,
        port: u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80,
        path: '/rsscloud/pleaseNotify',
        registerProcedure: '', // feedsmith omits the empty attribute — expected output
        protocol: 'http-post',
      }
    }
  }
  return generateRssFeed({
    title: user.displayName,
    link: channelLink(ctx, user.handle),
    description: `Posts by ${user.displayName}`,
    ...(atomLinks.length ? { atom: { links: atomLinks } } : {}),
    ...(cloud ? { cloud } : {}),
    items: posts.map((p) => ({
      ...(p.title !== null ? { title: p.title } : {}), // Textcasting: never synthesize a title
      description: p.content,
      guid: { value: p.guid, isPermaLink: false },
      ...(p.url !== null ? { link: p.url } : {}),
      pubDate: p.publishedAt,
    })),
  })
}

export function renderJsonFeed(user: User, posts: Post[], ctx: FeedContext): string {
  const feed = generateJsonFeed({
    title: user.displayName,
    description: `Posts by ${user.displayName}`,
    ...(ctx.publicUrl ? { feed_url: feedUrls(ctx.publicUrl, user.handle).json } : {}),
    ...(ctx.hubUrl ? { hubs: [{ type: 'WebSub', url: ctx.hubUrl }] } : {}),
    items: posts.map((p) => ({
      id: p.guid,
      ...(p.title !== null ? { title: p.title } : {}),
      content_text: p.content,
      ...(p.url !== null ? { url: p.url } : {}),
      date_published: p.publishedAt,
    })),
  })
  return JSON.stringify(feed, null, 1) // generateJsonFeed returns an OBJECT (probed)
}
```

- [ ] **Step 4: Service passthroughs + routes**

`core/src/domain/service.ts` — add to the returned object:
```ts
    getUserByHandle(handle: string) {
      return repo.getUserByHandle(handle)
    },
    getPostsByAuthor(authorId: string, limit: number) {
      return repo.getPostsByAuthor(authorId, limit)
    },
```

`core/src/api/app.ts`:
1. Imports:
```ts
import { renderRssFeed, renderJsonFeed } from '../domain/feed.ts'
import type { FeedContext } from '../domain/feed.ts'
```
2. Signature + defaults:
```ts
export function createApp(deps: { service: Service; bus: EventBus; token: string; feeds?: FeedContext }): Hono {
  const { service, bus, token } = deps
  const feeds: FeedContext = deps.feeds ?? { publicUrl: null, hubUrl: null, rssCloud: false }
```
3. Add above the timeline route (a shared resolver + the two routes):
```ts
  const FEED_LIMIT = 50

  async function resolveFeedUser(c: Context): Promise<{ user: import('../domain/types.ts').User } | Response> {
    const handle = c.req.param('handle').toLowerCase()
    const user = await service.getUserByHandle(handle)
    if (!user) return c.json({ error: 'unknown user' }, 404)
    if (user.kind === 'remote') {
      // Pass-through, not republishing. 302 (not 301): feedUrl is mutable.
      if (!user.feedUrl) return c.json({ error: 'unknown user' }, 404)
      return c.redirect(user.feedUrl, 302)
    }
    return { user }
  }

  app.get('/users/:handle/feed.xml', async (c) => {
    const r = await resolveFeedUser(c)
    if (r instanceof Response) return r
    const posts = await service.getPostsByAuthor(r.user.id, FEED_LIMIT)
    return c.body(renderRssFeed(r.user, posts, feeds), 200, { 'content-type': 'application/rss+xml; charset=utf-8' })
  })

  app.get('/users/:handle/feed.json', async (c) => {
    const r = await resolveFeedUser(c)
    if (r instanceof Response) return r
    const posts = await service.getPostsByAuthor(r.user.id, FEED_LIMIT)
    return c.body(renderJsonFeed(r.user, posts, feeds), 200, { 'content-type': 'application/feed+json; charset=utf-8' })
  })
```

- [ ] **Step 5: Run — verify GREEN** — `npm test -w core` (all, incl. every pre-existing suite — the optional `feeds` dep must not break any existing `createApp` call); `npm run typecheck -w core` exit 0.

- [ ] **Step 6: Commit**

```bash
git add core/src/domain/feed.ts core/src/domain/service.ts core/src/api/app.ts core/test/feed.test.ts
git commit -m "$(printf 'core: per-user RSS 2.0 + JSON Feed output (Textcasting profile)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 5: Push guard + push module (external-hub mode) + server wiring

**Files:**
- Create: `core/src/domain/push-guard.ts`, `core/test/push-guard.test.ts`
- Create: `core/src/domain/push.ts`, `core/test/push.test.ts`
- Modify: `core/src/server.ts`

**Interfaces:**
- Consumes: `Config` (Task 1), `feedUrls` (Task 4), `Subscription` methods (Task 2).
- Produces:
  - `push-guard.ts`: `type LookupFn = (hostname: string) => Promise<{ address: string }>`; `isPrivateIp(ip: string): boolean`; `checkCallbackUrl(raw: string, lookup?: LookupFn): Promise<{ ok: true; host: string } | { ok: false; reason: string }>` — http(s) only, rejects `localhost`/`*.localhost` and hosts resolving to loopback/link-local/private/ULA ranges. Default lookup = `node:dns/promises` `lookup`.
  - `push.ts`: `createPush(deps: { repo: Repository; config: Config; fetchFn?: typeof fetch }): Push` where `interface Push { onLocalPost(entry: TimelineEntry): Promise<void> }`. **`onLocalPost` never rejects** (H4). External mode: per topic, form-POST `hub.mode=publish&hub.topic=<topic>&hub.url=<topic>`.
  - `server.ts` wiring: `bus.onNewPost((e) => { void push.onLocalPost(e) })`; `repo.purgeExpiredSubscriptions(new Date().toISOString())` inside the poller loop's try block; `createApp` receives `feeds` built via `hubLinkUrl`.

- [ ] **Step 1: Failing guard tests**

`core/test/push-guard.test.ts`:
```ts
import { test, expect } from 'vitest'
import { isPrivateIp, checkCallbackUrl } from '../src/domain/push-guard.ts'

const publicLookup = async () => ({ address: '93.184.216.34' })
const privateLookup = async () => ({ address: '10.0.0.5' })

test('isPrivateIp classifies the RFC ranges', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.0.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1']) {
    expect(isPrivateIp(ip), ip).toBe(true)
  }
  for (const ip of ['93.184.216.34', '8.8.8.8', '2606:2800:220:1:248:1893:25c8:1946', '172.32.0.1']) {
    expect(isPrivateIp(ip), ip).toBe(false)
  }
})

test('checkCallbackUrl accepts a public host and reports it', async () => {
  const r = await checkCallbackUrl('https://cb.example.com/receive', publicLookup)
  expect(r).toEqual({ ok: true, host: 'cb.example.com' })
})

test('checkCallbackUrl rejects non-http, localhost names, literal and resolved private IPs', async () => {
  expect((await checkCallbackUrl('ftp://cb.example.com/x', publicLookup)).ok).toBe(false)
  expect((await checkCallbackUrl('http://localhost:9/x', publicLookup)).ok).toBe(false)
  expect((await checkCallbackUrl('http://evil.localhost/x', publicLookup)).ok).toBe(false)
  expect((await checkCallbackUrl('http://127.0.0.1/x', publicLookup)).ok).toBe(false)
  expect((await checkCallbackUrl('http://[::1]/x', publicLookup)).ok).toBe(false)
  expect((await checkCallbackUrl('https://rebound.example.com/x', privateLookup)).ok).toBe(false)
})

test('checkCallbackUrl rejects when DNS resolution fails', async () => {
  const failing = async () => { throw new Error('ENOTFOUND') }
  expect((await checkCallbackUrl('https://nx.example.com/x', failing)).ok).toBe(false)
})
```

- [ ] **Step 2: Failing push tests**

`core/test/push.test.ts`:
```ts
import { test, expect, vi } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createPush } from '../src/domain/push.ts'
import { loadConfig } from '../src/config.ts'

const EXT_ENV = { TEXTCASTER_TOKEN: 't', TEXTCASTER_PUBLIC_URL: 'https://cast.example.com', TEXTCASTER_WEBSUB: 'https://hub.example.com/hub' }

async function setup(env: Record<string, string>) {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const config = loadConfig(env)
  return { repo, bus, service, config }
}

test('external mode publishes a ping per topic on a local post', async () => {
  const { repo, service, config } = await setup(EXT_ENV)
  const fetchFn = vi.fn(async () => new Response('ok', { status: 204 }))
  const push = createPush({ repo, config, fetchFn: fetchFn as unknown as typeof fetch })
  const entry = await service.createLocalPostAs('alice', 'Alice', 'ping-worthy')
  await push.onLocalPost(entry)
  expect(fetchFn).toHaveBeenCalledTimes(2)
  const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('https://hub.example.com/hub')
  const params = new URLSearchParams(init.body as string)
  expect(params.get('hub.mode')).toBe('publish')
  expect(params.get('hub.topic')).toBe('https://cast.example.com/users/alice/feed.xml')
  expect(params.get('hub.url')).toBe(params.get('hub.topic'))
})

test('remote posts and websub-off both produce no pings', async () => {
  const { repo, service, config } = await setup(EXT_ENV)
  const fetchFn = vi.fn(async () => new Response('ok'))
  const push = createPush({ repo, config, fetchFn: fetchFn as unknown as typeof fetch })
  const remote = await service.addRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://news.example.com/f.xml' })
  await push.onLocalPost({ id: 'x', authorId: remote.id, source: 'remote', guid: 'g', title: null, content: 'c', url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', author: remote })
  expect(fetchFn).not.toHaveBeenCalled()

  const off = await setup({ TEXTCASTER_TOKEN: 't' })
  const offPush = createPush({ repo: off.repo, config: off.config, fetchFn: fetchFn as unknown as typeof fetch })
  const entry = await off.service.createLocalPostAs('bob', 'Bob', 'silent')
  await offPush.onLocalPost(entry)
  expect(fetchFn).not.toHaveBeenCalled()
})

test('onLocalPost never rejects, even when fetch explodes (H4)', async () => {
  const { repo, service, config } = await setup(EXT_ENV)
  const fetchFn = vi.fn(async () => { throw new Error('network down') })
  const push = createPush({ repo, config, fetchFn: fetchFn as unknown as typeof fetch })
  const entry = await service.createLocalPostAs('alice', 'Alice', 'doomed ping')
  await expect(push.onLocalPost(entry)).resolves.toBeUndefined()
})
```

- [ ] **Step 3: Run — verify RED** — `npm test -w core`; expected: both new files unresolvable (`Failed to load ... push-guard.ts / push.ts`).

- [ ] **Step 4: Implement the guard**

`core/src/domain/push-guard.ts`:
```ts
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export type LookupFn = (hostname: string) => Promise<{ address: string }>

export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number)
    if (a === 127 || a === 10 || a === 0) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    return false
  }
  const v6 = ip.toLowerCase()
  if (v6 === '::1' || v6 === '::') return true
  if (v6.startsWith('fc') || v6.startsWith('fd')) return true // ULA fc00::/7
  if (v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb')) return true // link-local fe80::/10
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7)) // v4-mapped
  return false
}

// SSRF gate for subscriber callbacks (spec H2 rule 2). Resolution happens at
// registration only; the rebinding residual is an accepted, ledgered decision.
export async function checkCallbackUrl(raw: string, lookupFn: LookupFn = lookup): Promise<{ ok: true; host: string } | { ok: false; reason: string }> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'callback is not a URL' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'callback must be http(s)' }
  const host = url.hostname.replace(/^\[|\]$/g, '') // strip IPv6 brackets
  if (host === 'localhost' || host.endsWith('.localhost')) return { ok: false, reason: 'callback host is local' }
  if (isIP(host)) {
    if (isPrivateIp(host)) return { ok: false, reason: 'callback host is private' }
    return { ok: true, host }
  }
  try {
    const { address } = await lookupFn(host)
    if (isPrivateIp(address)) return { ok: false, reason: 'callback host resolves to a private address' }
  } catch {
    return { ok: false, reason: 'callback host does not resolve' }
  }
  return { ok: true, host }
}
```

- [ ] **Step 5: Implement the push module (external mode + skeleton)**

`core/src/domain/push.ts`:
```ts
import type { Repository } from './repository.ts'
import type { Config } from '../config.ts'
import type { TimelineEntry } from './types.ts'
import { feedUrls } from './feed.ts'

const PUSH_TIMEOUT_MS = 10_000

export interface Push {
  onLocalPost(entry: TimelineEntry): Promise<void>
}

export interface PushDeps {
  repo: Repository
  config: Config
  fetchFn?: typeof fetch
}

async function publishPing(hubUrl: string, topic: string, fetchFn: typeof fetch): Promise<void> {
  await fetchFn(hubUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    // hub.url duplicates hub.topic for hub compatibility (websubhub.com et al).
    body: new URLSearchParams({ 'hub.mode': 'publish', 'hub.topic': topic, 'hub.url': topic }).toString(),
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
  })
}

export function createPush(deps: PushDeps): Push {
  const { repo, config } = deps
  const fetchFn = deps.fetchFn ?? fetch
  void repo // used from Task 6 onward (self-hub delivery)

  return {
    // Seam contract (spec H4): this method NEVER rejects. It runs inside a
    // synchronous EventEmitter dispatch with no global rejection handler —
    // an escape here is process-fatal.
    // ponytail: N rapid posts = N regenerations × M subscribers, no
    // coalescing; debounce per topic when it matters.
    async onLocalPost(entry: TimelineEntry): Promise<void> {
      try {
        if (entry.source !== 'local') return
        if (!config.publicUrl) return
        const pushEnabled = config.websub.mode !== 'off' || config.rssCloud
        if (!pushEnabled) return
        const topics = feedUrls(config.publicUrl, entry.author.handle)

        if (config.websub.mode === 'external') {
          for (const topic of [topics.xml, topics.json]) {
            try {
              await publishPing(config.websub.hubUrl, topic, fetchFn)
            } catch (err) {
              console.error(`websub publish ping failed for ${topic}:`, err instanceof Error ? err.message : err)
            }
          }
        }
      } catch (err) {
        console.error('push dispatch failed:', err instanceof Error ? err.message : err)
      }
    },
  }
}
```

- [ ] **Step 6: Wire the server**

`core/src/server.ts` — replace the whole file:
```ts
import { serve } from '@hono/node-server'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { loadConfig } from './config.ts'
import { createSqliteRepository } from './storage/sqlite.ts'
import { createEventBus } from './domain/bus.ts'
import { createService } from './domain/service.ts'
import { createApp } from './api/app.ts'
import { hubLinkUrl } from './domain/feed.ts'
import { createPush } from './domain/push.ts'
import { pollAll } from './domain/ingest.ts'

const config = loadConfig()
if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true })

const repo = await createSqliteRepository(config.dbPath)
const bus = createEventBus()
const service = createService(repo, bus)
const push = createPush({ repo, config })
const app = createApp({
  service,
  bus,
  token: config.token,
  feeds: { publicUrl: config.publicUrl, hubUrl: hubLinkUrl(config.websub, config.publicUrl), rssCloud: config.rssCloud },
})

// H4 seam: onLocalPost never rejects; void is safe here by contract.
bus.onNewPost((e) => { void push.onLocalPost(e) })

async function loop() {
  try {
    await pollAll(repo, bus)
    await repo.purgeExpiredSubscriptions(new Date().toISOString())
  } catch (err) {
    console.error('pollAll failed:', err instanceof Error ? err.message : err)
  }
  setTimeout(loop, config.pollSeconds * 1000)
}
setTimeout(loop, config.pollSeconds * 1000)

serve({ fetch: app.fetch, port: config.port })
console.log(`textcaster core listening on :${config.port}`)
```

- [ ] **Step 7: Run — verify GREEN** — `npm test -w core` all pass; `npm run typecheck -w core` exit 0.

- [ ] **Step 8: Commit**

```bash
git add core/src/domain/push-guard.ts core/src/domain/push.ts core/src/server.ts core/test/push-guard.test.ts core/test/push.test.ts
git commit -m "$(printf 'core: push subsystem — SSRF guard, external-hub publish pings, bus wiring\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 6: Self-hosted WebSub hub — registration, verification, fat-ping delivery

**Files:**
- Modify: `core/src/domain/push.ts` (registration + delivery), `core/src/api/app.ts` (`POST /hub`)
- Modify: `core/test/push.test.ts`, `core/test/api.test.ts` (route-level checks)

**Interfaces:**
- Consumes: guard (Task 5), subscriptions repo (Task 2), renderers (Task 4).
- Produces (exact shapes Task 7 mirrors):
  - In `push.ts`: `interface RegistrationResult { status: 202 | 400 | 404 | 429; error?: string }`;
    `resolveLocalTopic(repo, publicUrl, topic): Promise<{ user: User; format: 'xml' | 'json' } | null>` (H3 equality rule);
    `handleWebSubRequest(deps: PushDeps & { lookupFn?: LookupFn }, form: Record<string, string>): Promise<RegistrationResult>` — 202 + fire-and-forget verification.
  - `createApp` deps gain optional `pushApi?: { websub?: (form: Record<string, string>) => Promise<RegistrationResult>; rsscloud?: (form: Record<string, string>, requesterIp: string | null) => Promise<RegistrationResult> }`; `POST /hub` exists only when `pushApi.websub` is provided (else 404).
  - Constants: `MAX_SUBS_PER_HOST = 20`, `MAX_SUBS_PER_TOPIC = 500`, `DEFAULT_LEASE_SECONDS = 864000` (10 days), `MAX_LEASE_SECONDS = 2592000` (30 days).

- [ ] **Step 1: Failing tests**

Append to `core/test/push.test.ts` (add imports: `handleWebSubRequest`, `resolveLocalTopic` from push.ts; `createApp` where needed):
```ts
const SELF_ENV = { TEXTCASTER_TOKEN: 't', TEXTCASTER_PUBLIC_URL: 'https://cast.example.com', TEXTCASTER_WEBSUB: 'self' }
const publicLookup = async () => ({ address: '93.184.216.34' })

function subForm(over: Record<string, string> = {}): Record<string, string> {
  return { 'hub.mode': 'subscribe', 'hub.topic': 'https://cast.example.com/users/alice/feed.xml', 'hub.callback': 'https://cb.example.com/receive', ...over }
}

test('resolveLocalTopic: exact equality only, local users only', async () => {
  const { repo, service } = await setup(SELF_ENV)
  await service.createLocalPostAs('alice', 'Alice', 'seed')
  const publicUrl = 'https://cast.example.com'
  expect(await resolveLocalTopic(repo, publicUrl, 'https://cast.example.com/users/alice/feed.xml')).toMatchObject({ format: 'xml' })
  expect(await resolveLocalTopic(repo, publicUrl, 'https://cast.example.com/users/alice/feed.json')).toMatchObject({ format: 'json' })
  expect(await resolveLocalTopic(repo, publicUrl, 'https://cast.example.com/users/alice/feed.xml/')).toBeNull() // trailing slash
  expect(await resolveLocalTopic(repo, publicUrl, 'https://cast.example.com/users/ALICE/feed.xml')).toBeNull() // case variant
  expect(await resolveLocalTopic(repo, publicUrl, 'https://cast.example.com/users/nobody/feed.xml')).toBeNull()
})

test('websub subscribe: challenge echoed -> stored; wrong echo -> not stored', async () => {
  const { repo, service, config } = await setup(SELF_ENV)
  await service.createLocalPostAs('alice', 'Alice', 'seed')
  let challenged: URL | null = null
  const goodFetch = vi.fn(async (url: string | URL | Request) => {
    challenged = new URL(String(url))
    return new Response(challenged.searchParams.get('hub.challenge') ?? '', { status: 200 })
  })
  const r = await handleWebSubRequest({ repo, config, fetchFn: goodFetch as unknown as typeof fetch, lookupFn: publicLookup }, subForm({ 'hub.secret': 'shh' }))
  expect(r.status).toBe(202)
  await vi.waitFor(async () => {
    const subs = await repo.listActiveSubscriptions('https://cast.example.com/users/alice/feed.xml', '2020-01-01T00:00:00.000Z')
    expect(subs.length).toBe(1)
    expect(subs[0].secret).toBe('shh')
  })
  expect(challenged!.searchParams.get('hub.mode')).toBe('subscribe')
  expect(challenged!.searchParams.get('hub.lease_seconds')).toBeTruthy() // present on subscribe (H7)

  const badFetch = vi.fn(async () => new Response('nope', { status: 200 }))
  const r2 = await handleWebSubRequest({ repo, config, fetchFn: badFetch as unknown as typeof fetch, lookupFn: publicLookup }, subForm({ 'hub.callback': 'https://cb2.example.com/x' }))
  expect(r2.status).toBe(202) // 202 first, verification decides later
  await vi.waitFor(() => expect(badFetch).toHaveBeenCalledTimes(1)) // verification GET happened...
  await new Promise((res) => setImmediate(res)) // ...and its rejection settled
  expect(await repo.countActiveSubscriptions({ callbackHost: 'cb2.example.com' }, '2020-01-01T00:00:00.000Z')).toBe(0)
})

test('websub unsubscribe verification carries NO lease_seconds and deletes (H7)', async () => {
  const { repo, service, config } = await setup(SELF_ENV)
  await service.createLocalPostAs('alice', 'Alice', 'seed')
  const echo = vi.fn(async (url: string | URL | Request) => new Response(new URL(String(url)).searchParams.get('hub.challenge') ?? '', { status: 200 }))
  const deps = { repo, config, fetchFn: echo as unknown as typeof fetch, lookupFn: publicLookup }
  await handleWebSubRequest(deps, subForm())
  await vi.waitFor(async () => expect(await repo.countActiveSubscriptions({ callbackHost: 'cb.example.com' }, '2020-01-01T00:00:00.000Z')).toBe(1))
  await handleWebSubRequest(deps, subForm({ 'hub.mode': 'unsubscribe' }))
  await vi.waitFor(async () => expect(await repo.countActiveSubscriptions({ callbackHost: 'cb.example.com' }, '2020-01-01T00:00:00.000Z')).toBe(0))
  const unsubUrl = new URL(String(echo.mock.calls[1][0]))
  expect(unsubUrl.searchParams.get('hub.mode')).toBe('unsubscribe')
  expect(unsubUrl.searchParams.get('hub.lease_seconds')).toBeNull()
})

test('websub subscribe rejects bad topics, private callbacks, and over-cap hosts', async () => {
  const { repo, service, config } = await setup(SELF_ENV)
  await service.createLocalPostAs('alice', 'Alice', 'seed')
  const echo = vi.fn(async (url: string | URL | Request) => new Response(new URL(String(url)).searchParams.get('hub.challenge') ?? '', { status: 200 }))
  const deps = { repo, config, fetchFn: echo as unknown as typeof fetch, lookupFn: publicLookup }
  expect((await handleWebSubRequest(deps, subForm({ 'hub.topic': 'https://elsewhere.example.com/feed.xml' }))).status).toBe(404)
  expect((await handleWebSubRequest(deps, subForm({ 'hub.callback': 'http://127.0.0.1/x' }))).status).toBe(400)
  expect((await handleWebSubRequest(deps, subForm({ 'hub.mode': 'dance' }))).status).toBe(400)
  // fill the per-host cap directly, then one more is refused
  for (let i = 0; i < 20; i++) {
    await repo.upsertSubscription({ id: `cap${i}`, protocol: 'websub', topic: 'https://cast.example.com/users/alice/feed.xml', callback: `https://full.example.com/cb${i}`, callbackHost: 'full.example.com', secret: null, expiresAt: '2027-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
  }
  const capLookup = async () => ({ address: '93.184.216.34' })
  expect((await handleWebSubRequest({ ...deps, lookupFn: capLookup }, subForm({ 'hub.callback': 'https://full.example.com/one-more' }))).status).toBe(429)
})

test('self mode delivers the fat ping with HMAC signature; expired subs skipped; failures retried once', async () => {
  const { repo, service, config } = await setup(SELF_ENV)
  const entrySeed = await service.createLocalPostAs('alice', 'Alice', 'first body')
  const topic = 'https://cast.example.com/users/alice/feed.xml'
  await repo.upsertSubscription({ id: 's1', protocol: 'websub', topic, callback: 'https://cb.example.com/receive', callbackHost: 'cb.example.com', secret: 'shh', expiresAt: '2027-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
  await repo.upsertSubscription({ id: 's2', protocol: 'websub', topic, callback: 'https://dead.example.com/receive', callbackHost: 'dead.example.com', secret: null, expiresAt: '2020-01-01T00:00:00.000Z', createdAt: '2019-01-01T00:00:00.000Z' })
  const calls: Array<{ url: string; body: string; sig: string | null; ct: string | null }> = []
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body), sig: new Headers(init?.headers).get('x-hub-signature'), ct: new Headers(init?.headers).get('content-type') })
    return new Response('', { status: 200 })
  })
  const push = createPush({ repo, config, fetchFn: fetchFn as unknown as typeof fetch })
  await push.onLocalPost(entrySeed)
  const xmlDeliveries = calls.filter((c) => c.url === 'https://cb.example.com/receive')
  expect(xmlDeliveries.length).toBe(1)
  expect(xmlDeliveries[0].ct).toContain('application/rss+xml')
  expect(xmlDeliveries[0].body).toContain('first body')
  const { createHmac } = await import('node:crypto')
  expect(xmlDeliveries[0].sig).toBe('sha256=' + createHmac('sha256', 'shh').update(xmlDeliveries[0].body).digest('hex'))
  expect(calls.some((c) => c.url === 'https://dead.example.com/receive')).toBe(false)

  // failure path: one retry then drop, never throwing
  const flaky = vi.fn(async () => { throw new Error('conn refused') })
  const push2 = createPush({ repo, config, fetchFn: flaky as unknown as typeof fetch })
  await expect(push2.onLocalPost(entrySeed)).resolves.toBeUndefined()
  expect(flaky.mock.calls.length).toBe(2) // 1 attempt + 1 retry for the one live xml-topic subscriber
})
```
Append to `core/test/api.test.ts`:
```ts
test('POST /hub is 404 when no pushApi is wired', async () => {
  const app = await makeApp()
  expect((await app.request('/hub', { method: 'POST', body: new URLSearchParams({ 'hub.mode': 'subscribe' }) })).status).toBe(404)
})
```

- [ ] **Step 2: Run — verify RED** — `npm test -w core`; expected: `handleWebSubRequest`/`resolveLocalTopic` not exported; delivery assertions fail (no fat-ping code); `/hub` route already 404s so that specific test passes (it pins the default).

- [ ] **Step 3: Implement registration + delivery in `core/src/domain/push.ts`**

Add imports:
```ts
import { createHmac, randomBytes } from 'node:crypto'
import { checkCallbackUrl } from './push-guard.ts'
import type { LookupFn } from './push-guard.ts'
import { feedUrls, renderRssFeed, renderJsonFeed, hubLinkUrl } from './feed.ts'
import type { User, Subscription } from './types.ts'
```
(adjust the existing `feedUrls` import line to this combined one). Add constants and code:
```ts
export const MAX_SUBS_PER_HOST = 20
export const MAX_SUBS_PER_TOPIC = 500
export const DEFAULT_LEASE_SECONDS = 864000 // 10 days
export const MAX_LEASE_SECONDS = 2592000 // 30 days

export interface RegistrationResult { status: 202 | 400 | 404 | 429; error?: string }

// H3: exact string equality against the re-minted URL of an existing LOCAL user.
export async function resolveLocalTopic(repo: Repository, publicUrl: string, topic: string): Promise<{ user: User; format: 'xml' | 'json' } | null> {
  const m = /^.*\/users\/([a-z0-9-]{1,64})\/feed\.(xml|json)$/.exec(topic)
  if (!m) return null
  const [, handle, format] = m
  const minted = format === 'xml' ? feedUrls(publicUrl, handle).xml : feedUrls(publicUrl, handle).json
  if (topic !== minted) return null
  const user = await repo.getUserByHandle(handle)
  if (!user || user.kind !== 'local') return null
  return { user, format: format as 'xml' | 'json' }
}

async function verifyWebSub(deps: Required<Pick<PushDeps, 'repo'>> & { fetchFn: typeof fetch }, mode: 'subscribe' | 'unsubscribe', topic: string, callback: string, callbackHost: string, secret: string | null, leaseSeconds: number): Promise<void> {
  try {
    const url = new URL(callback)
    const challenge = randomBytes(16).toString('hex')
    url.searchParams.set('hub.mode', mode)
    url.searchParams.set('hub.topic', topic)
    url.searchParams.set('hub.challenge', challenge)
    if (mode === 'subscribe') url.searchParams.set('hub.lease_seconds', String(leaseSeconds)) // H7: omitted on unsubscribe
    const res = await deps.fetchFn(url.toString(), { signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) })
    if (!res.ok || (await res.text()) !== challenge) return // no state change
    if (mode === 'subscribe') {
      await deps.repo.upsertSubscription({
        id: crypto.randomUUID(),
        protocol: 'websub',
        topic,
        callback,
        callbackHost,
        secret,
        expiresAt: new Date(Date.now() + leaseSeconds * 1000).toISOString(),
        createdAt: new Date().toISOString(),
      })
    } else {
      await deps.repo.deleteSubscription('websub', topic, callback)
    }
  } catch (err) {
    console.error('websub verification failed:', err instanceof Error ? err.message : err)
  }
}

export async function handleWebSubRequest(deps: PushDeps & { lookupFn?: LookupFn }, form: Record<string, string>): Promise<RegistrationResult> {
  const { repo, config } = deps
  const fetchFn = deps.fetchFn ?? fetch
  const mode = form['hub.mode']
  if (mode !== 'subscribe' && mode !== 'unsubscribe') return { status: 400, error: 'hub.mode invalid' }
  if (!config.publicUrl) return { status: 404, error: 'push not configured' }
  const topic = form['hub.topic'] ?? ''
  if (!(await resolveLocalTopic(repo, config.publicUrl, topic))) return { status: 404, error: 'unknown topic' }
  const callback = form['hub.callback'] ?? ''
  const gate = await checkCallbackUrl(callback, deps.lookupFn)
  if (!gate.ok) return { status: 400, error: gate.reason }
  const secret = form['hub.secret'] ?? null
  if (secret !== null && Buffer.byteLength(secret) >= 200) return { status: 400, error: 'hub.secret too long' }
  const leaseSeconds = Math.min(Number(form['hub.lease_seconds']) > 0 ? Math.floor(Number(form['hub.lease_seconds'])) : DEFAULT_LEASE_SECONDS, MAX_LEASE_SECONDS)
  if (mode === 'subscribe') {
    const now = new Date().toISOString()
    if ((await repo.countActiveSubscriptions({ callbackHost: gate.host }, now)) >= MAX_SUBS_PER_HOST) return { status: 429, error: 'too many subscriptions for this callback host' }
    if ((await repo.countActiveSubscriptions({ topic }, now)) >= MAX_SUBS_PER_TOPIC) return { status: 429, error: 'too many subscriptions for this topic' }
  }
  // 202 first, verification decides asynchronously (spec).
  void verifyWebSub({ repo, fetchFn }, mode, topic, callback, gate.host, secret, leaseSeconds)
  return { status: 202 }
}

async function deliverOnce(fetchFn: typeof fetch, callback: string, body: string, headers: Record<string, string>): Promise<void> {
  // Best-effort: one attempt + one immediate retry, then drop (spec ceiling).
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fetchFn(callback, { method: 'POST', headers, body, signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) })
      return
    } catch (err) {
      if (attempt === 1) console.error(`delivery to ${callback} dropped:`, err instanceof Error ? err.message : err)
    }
  }
}
```
Extend `onLocalPost` — inside the existing outer try, after the external-mode block (the fat ping must carry the CURRENT feed, so fetch the author's posts once per event):
```ts
        if (config.websub.mode === 'self') {
          const now = new Date().toISOString()
          const ctx = { publicUrl: config.publicUrl, hubUrl: hubLinkUrl(config.websub, config.publicUrl), rssCloud: config.rssCloud }
          const posts = await repo.getPostsByAuthor(entry.author.id, 50)
          for (const [format, topic] of [['xml', topics.xml], ['json', topics.json]] as const) {
            const subs = (await repo.listActiveSubscriptions(topic, now)).filter((s) => s.protocol === 'websub')
            if (subs.length === 0) continue
            // Body regenerated ONCE per topic per event; same body (and HMAC input) for every subscriber.
            const body = format === 'xml' ? renderRssFeed(entry.author, posts, ctx) : renderJsonFeed(entry.author, posts, ctx)
            const contentType = format === 'xml' ? 'application/rss+xml; charset=utf-8' : 'application/feed+json; charset=utf-8'
            for (const sub of subs) {
              const headers: Record<string, string> = {
                'content-type': contentType,
                link: `<${topic}>; rel="self", <${ctx.hubUrl}>; rel="hub"`,
              }
              if (sub.secret) headers['x-hub-signature'] = 'sha256=' + createHmac('sha256', sub.secret).update(body).digest('hex')
              await deliverOnce(fetchFn, sub.callback, body, headers)
            }
          }
        }
```

- [ ] **Step 4: The `/hub` route in `core/src/api/app.ts`**

Extend the deps type and destructuring:
```ts
export interface PushApi {
  websub?: (form: Record<string, string>) => Promise<{ status: 202 | 400 | 404 | 429; error?: string }>
  rsscloud?: (form: Record<string, string>, requesterIp: string | null) => Promise<{ status: 202 | 400 | 404 | 429; error?: string }>
}

export function createApp(deps: { service: Service; bus: EventBus; token: string; feeds?: FeedContext; pushApi?: PushApi }): Hono {
```
Add the route (near the feed routes):
```ts
  app.post('/hub', async (c) => {
    if (!deps.pushApi?.websub) return c.json({ error: 'not found' }, 404)
    const parsed = await c.req.parseBody()
    const form = Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'string')) as Record<string, string>
    const result = await deps.pushApi.websub(form)
    return c.json(result.error ? { error: result.error } : { ok: true }, result.status)
  })
```
And wire in `core/src/server.ts` (add import of `handleWebSubRequest` from `./domain/push.ts`, then):
```ts
const app = createApp({
  service,
  bus,
  token: config.token,
  feeds: { publicUrl: config.publicUrl, hubUrl: hubLinkUrl(config.websub, config.publicUrl), rssCloud: config.rssCloud },
  pushApi: config.websub.mode === 'self' ? { websub: (form) => handleWebSubRequest({ repo, config }, form) } : undefined,
})
```

- [ ] **Step 5: Run — verify GREEN** — `npm test -w core` all pass (including `vi.waitFor` verification tests); `npm run typecheck -w core` exit 0.

- [ ] **Step 6: Commit**

```bash
git add core/src/domain/push.ts core/src/api/app.ts core/src/server.ts core/test/push.test.ts core/test/api.test.ts
git commit -m "$(printf 'core: self-hosted WebSub hub — verified registrations, HMAC fat-ping delivery\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 7: rssCloud — registration endpoint + thin-ping delivery

**Files:**
- Modify: `core/src/domain/push.ts`, `core/src/api/app.ts`, `core/src/server.ts`
- Modify: `core/test/push.test.ts`

**Interfaces:**
- Consumes: everything from Task 6 (same registry, same guard, same result shape).
- Produces: `handleRssCloudRequest(deps: PushDeps & { lookupFn?: LookupFn }, form: Record<string, string>, requesterIp: string | null): Promise<RegistrationResult>`; `POST /rsscloud/pleaseNotify` route (404 unless `pushApi.rsscloud` wired); thin-ping delivery for `protocol === 'rsscloud'` subscriptions of the XML topic; `RSSCLOUD_LEASE_SECONDS = 90000` (25 hours).

- [ ] **Step 1: Failing tests** — append to `core/test/push.test.ts` (import `handleRssCloudRequest`):
```ts
const CLOUD_ENV = { TEXTCASTER_TOKEN: 't', TEXTCASTER_PUBLIC_URL: 'https://cast.example.com', TEXTCASTER_RSSCLOUD: 'on' }

function cloudForm(over: Record<string, string> = {}): Record<string, string> {
  return { notifyProcedure: '', port: '5337', path: '/rsscloud/notify', protocol: 'http-post', url1: 'https://cast.example.com/users/alice/feed.xml', domain: 'cb.example.com', ...over }
}

test('rsscloud registration is challenge-verified even without domain (spec deviation, deliberate)', async () => {
  const { repo, service, config } = await setup(CLOUD_ENV)
  await service.createLocalPostAs('alice', 'Alice', 'seed')
  const echo = vi.fn(async (url: string | URL | Request) => {
    const u = new URL(String(url))
    return new Response('confirming challenge ' + u.searchParams.get('challenge'), { status: 200 })
  })
  const deps = { repo, config, fetchFn: echo as unknown as typeof fetch, lookupFn: publicLookup }
  // with domain
  expect((await handleRssCloudRequest(deps, cloudForm(), null)).status).toBe(202)
  await vi.waitFor(async () => expect(await repo.countActiveSubscriptions({ callbackHost: 'cb.example.com' }, '2020-01-01T00:00:00.000Z')).toBe(1))
  // without domain: requester IP becomes the callback host — still challenged
  expect((await handleRssCloudRequest(deps, cloudForm({ domain: '' }), '93.184.216.34')).status).toBe(202)
  await vi.waitFor(async () => expect(await repo.countActiveSubscriptions({ callbackHost: '93.184.216.34' }, '2020-01-01T00:00:00.000Z')).toBe(1))
  // registered callback shape: http://host:port/path
  const subs = await repo.listActiveSubscriptions('https://cast.example.com/users/alice/feed.xml', '2020-01-01T00:00:00.000Z')
  expect(subs.map((s) => s.callback).sort()).toEqual(['http://93.184.216.34:5337/rsscloud/notify', 'http://cb.example.com:5337/rsscloud/notify'])
  // 25h expiry
  const in24h = new Date(Date.now() + 24 * 3600 * 1000).toISOString()
  const in26h = new Date(Date.now() + 26 * 3600 * 1000).toISOString()
  expect(await repo.countActiveSubscriptions({ topic: 'https://cast.example.com/users/alice/feed.xml' }, in24h)).toBe(2)
  expect(await repo.countActiveSubscriptions({ topic: 'https://cast.example.com/users/alice/feed.xml' }, in26h)).toBe(0)
})

test('rsscloud rejects non-http-post, unknown topics, and missing ip+domain', async () => {
  const { repo, service, config } = await setup(CLOUD_ENV)
  await service.createLocalPostAs('alice', 'Alice', 'seed')
  const deps = { repo, config, fetchFn: (async () => new Response('')) as unknown as typeof fetch, lookupFn: publicLookup }
  expect((await handleRssCloudRequest(deps, cloudForm({ protocol: 'xml-rpc' }), null)).status).toBe(400)
  expect((await handleRssCloudRequest(deps, cloudForm({ url1: 'https://cast.example.com/users/alice/feed.json' }), null)).status).toBe(404) // rssCloud is RSS-only
  expect((await handleRssCloudRequest(deps, cloudForm({ domain: '' }), null)).status).toBe(400)
})

test('rsscloud thin ping goes to xml-topic subscribers on a local post', async () => {
  const { repo, service, config } = await setup(CLOUD_ENV)
  const entry = await service.createLocalPostAs('alice', 'Alice', 'ping me thin')
  await repo.upsertSubscription({ id: 'rc1', protocol: 'rsscloud', topic: 'https://cast.example.com/users/alice/feed.xml', callback: 'http://cb.example.com:5337/rsscloud/notify', callbackHost: 'cb.example.com', secret: null, expiresAt: '2027-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
  const fetchFn = vi.fn(async () => new Response('', { status: 200 }))
  const push = createPush({ repo, config, fetchFn: fetchFn as unknown as typeof fetch })
  await push.onLocalPost(entry)
  const call = fetchFn.mock.calls.find((c2) => String(c2[0]) === 'http://cb.example.com:5337/rsscloud/notify')
  expect(call).toBeTruthy()
  const init = call![1] as RequestInit
  expect(new URLSearchParams(String(init.body)).get('url')).toBe('https://cast.example.com/users/alice/feed.xml')
})
```

- [ ] **Step 2: Run — verify RED** — `npm test -w core`; expected `handleRssCloudRequest` not exported; thin-ping test finds no call.

- [ ] **Step 3: Implement in `core/src/domain/push.ts`**

```ts
export const RSSCLOUD_LEASE_SECONDS = 90000 // 25 hours; subscribers re-register daily

export async function handleRssCloudRequest(deps: PushDeps & { lookupFn?: LookupFn }, form: Record<string, string>, requesterIp: string | null): Promise<RegistrationResult> {
  const { repo, config } = deps
  const fetchFn = deps.fetchFn ?? fetch
  if (!config.publicUrl) return { status: 404, error: 'push not configured' }
  if (form.protocol !== 'http-post') return { status: 400, error: 'only http-post is supported' }
  const topic = form.url1 ?? ''
  const resolved = await resolveLocalTopic(repo, config.publicUrl, topic)
  if (!resolved || resolved.format !== 'xml') return { status: 404, error: 'unknown topic' } // rssCloud is RSS-only
  const port = Number(form.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { status: 400, error: 'port invalid' }
  const path = form.path ?? ''
  if (!path.startsWith('/')) return { status: 400, error: 'path invalid' }
  const host = form.domain || requesterIp
  if (!host) return { status: 400, error: 'no domain and no requester address' }
  const callback = `http://${host}:${port}${path}`
  const gate = await checkCallbackUrl(callback, deps.lookupFn)
  if (!gate.ok) return { status: 400, error: gate.reason }
  const now = new Date().toISOString()
  if ((await repo.countActiveSubscriptions({ callbackHost: gate.host }, now)) >= MAX_SUBS_PER_HOST) return { status: 429, error: 'too many subscriptions for this callback host' }
  if ((await repo.countActiveSubscriptions({ topic }, now)) >= MAX_SUBS_PER_TOPIC) return { status: 429, error: 'too many subscriptions for this topic' }
  void verifyRssCloud({ repo, fetchFn }, topic, callback, gate.host)
  return { status: 202 }
}

// Deliberate deviation from rssCloud convention: EVERY registration is
// challenge-verified, including the no-domain path (spec H2 rule 1). A
// compliant subscriber answers; a coerced third-party server does not.
async function verifyRssCloud(deps: { repo: Repository; fetchFn: typeof fetch }, topic: string, callback: string, callbackHost: string): Promise<void> {
  try {
    const challenge = randomBytes(16).toString('hex')
    const url = new URL(callback)
    url.searchParams.set('url', topic)
    url.searchParams.set('challenge', challenge)
    const res = await deps.fetchFn(url.toString(), { signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) })
    if (!res.ok || !(await res.text()).includes(challenge)) return // rssCloud convention: body CONTAINS the challenge
    await deps.repo.upsertSubscription({
      id: crypto.randomUUID(),
      protocol: 'rsscloud',
      topic,
      callback,
      callbackHost,
      secret: null,
      expiresAt: new Date(Date.now() + RSSCLOUD_LEASE_SECONDS * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    })
  } catch (err) {
    console.error('rsscloud verification failed:', err instanceof Error ? err.message : err)
  }
}
```
Extend `onLocalPost` — after the self-hub block, inside the outer try:
```ts
        if (config.rssCloud) {
          const now = new Date().toISOString()
          const subs = (await repo.listActiveSubscriptions(topics.xml, now)).filter((s) => s.protocol === 'rsscloud')
          for (const sub of subs) {
            // Thin ping: subscriber re-fetches the feed itself.
            await deliverOnce(fetchFn, sub.callback, new URLSearchParams({ url: topics.xml }).toString(), { 'content-type': 'application/x-www-form-urlencoded' })
          }
        }
```
(The Task 5 `void repo` placeholder line is deleted once `repo` has real uses.)

- [ ] **Step 4: Route + wiring**

`core/src/api/app.ts` — next to `/hub`:
```ts
  app.post('/rsscloud/pleaseNotify', async (c) => {
    if (!deps.pushApi?.rsscloud) return c.json({ error: 'not found' }, 404)
    const parsed = await c.req.parseBody()
    const form = Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'string')) as Record<string, string>
    const requesterIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null
    const result = await deps.pushApi.rsscloud(form, requesterIp)
    return c.json(result.error ? { error: result.error } : { ok: true }, result.status)
  })
```
(`x-forwarded-for` is the deployment reality behind any proxy; a direct-exposed core without XFF simply requires the `domain` parameter — RUNNING.md documents this in Task 8.)

`core/src/server.ts` — build `pushApi` from both handlers:
```ts
  pushApi:
    config.websub.mode === 'self' || config.rssCloud
      ? {
          ...(config.websub.mode === 'self' ? { websub: (form: Record<string, string>) => handleWebSubRequest({ repo, config }, form) } : {}),
          ...(config.rssCloud ? { rsscloud: (form: Record<string, string>, ip: string | null) => handleRssCloudRequest({ repo, config }, form, ip) } : {}),
        }
      : undefined,
```
(import `handleRssCloudRequest` alongside `handleWebSubRequest`).

- [ ] **Step 5: Run — verify GREEN** — `npm test -w core` all pass; `npm run typecheck -w core` exit 0.

- [ ] **Step 6: Commit**

```bash
git add core/src/domain/push.ts core/src/api/app.ts core/src/server.ts core/test/push.test.ts
git commit -m "$(printf 'core: rssCloud publish-side — verified registrations, thin pings\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 8: The federation loop test + RUNNING.md

**Files:**
- Create: `core/test/federation.test.ts`
- Modify: `docs/superpowers/documentation/RUNNING.md`

**Interfaces:**
- Consumes: everything. This test is the milestone's definition of done.

- [ ] **Step 1: Write the loop test (expected to pass immediately — it is the integration proof, not a RED/GREEN unit)**

`core/test/federation.test.ts`:
```ts
import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'
import { ingestRemoteUser } from '../src/domain/ingest.ts'

test('the loop closes: instance B ingests instance A user as a remote over plain RSS', async () => {
  // Instance A: emits alice's feed
  const repoA = await createSqliteRepository(':memory:')
  const busA = createEventBus()
  const serviceA = createService(repoA, busA)
  const appA = createApp({ service: serviceA, bus: busA, token: 'a', feeds: { publicUrl: 'http://a.example', hubUrl: null, rssCloud: false } })
  await serviceA.createLocalPostAs('alice', 'Alice', 'hello from instance A — ünïcode ✓')
  await serviceA.createLocalPostAs('alice', 'Alice', 'second transmission')

  // Instance B: ingests A's feed URL through the normal remote-user path
  const repoB = await createSqliteRepository(':memory:')
  const busB = createEventBus()
  const serviceB = createService(repoB, busB)
  const aliceAtB = await serviceB.addRemoteUser({ handle: 'alice-a', displayName: 'Alice (A)', feedUrl: 'http://a.example/users/alice/feed.xml' })

  const bridge = (async (url: string | URL | Request) => appA.request(String(url).replace('http://a.example', ''))) as unknown as typeof fetch
  const inserted = await ingestRemoteUser(repoB, busB, aliceAtB, bridge)
  expect(inserted).toBe(2)

  const timeline = await repoB.getTimeline(10)
  const contents = timeline.map((e) => e.content)
  expect(contents).toContain('hello from instance A — ünïcode ✓')
  expect(timeline.every((e) => e.source === 'remote')).toBe(true)
  expect(timeline[0].author.handle).toBe('alice-a')

  // guids survive the wire: A's post guids === B's stored guids
  const aGuids = (await repoA.getTimeline(10)).map((e) => e.guid).sort()
  const bGuids = timeline.map((e) => e.guid).sort()
  expect(bGuids).toEqual(aGuids)

  // idempotent re-ingest — the poller can hit A forever without duplicating
  expect(await ingestRemoteUser(repoB, busB, aliceAtB, bridge)).toBe(0)
})
```

- [ ] **Step 2: Run** — `npm test -w core`; expected PASS. If it fails, that is a REAL defect in Tasks 3-4 — debug there, do not weaken the test.

- [ ] **Step 3: RUNNING.md — add a "Feeds & push" section** (after the env-var tables):

```markdown
## Feeds & push

Every local user's posts are published as standard feeds:

- `GET /users/<handle>/feed.xml` — RSS 2.0
- `GET /users/<handle>/feed.json` — JSON Feed 1.1

Another Textcaster instance can add either URL as a remote user — that is
the federation loop. A remote user's handle redirects (302) to their
canonical feed instead.

Push is **opt-in** (default: plain feeds, polling only):

| Variable | Values | Meaning |
|---|---|---|
| `TEXTCASTER_PUBLIC_URL` | `https://your.host` | Public origin; required for any push mode. |
| `TEXTCASTER_WEBSUB` | `off` (default) \| `self` \| hub URL | `self` runs a WebSub hub at `POST /hub`; a URL advertises that external hub and pings it on every local post. |
| `TEXTCASTER_RSSCLOUD` | `off` (default) \| `on` | Adds `<cloud>` to RSS feeds and serves `POST /rsscloud/pleaseNotify` (thin pings). |

Notes:
- Subscriber callbacks are verified with a challenge and must be public
  hosts — loopback/private addresses are rejected by design.
- Behind a reverse proxy, forward `X-Forwarded-For` — the rssCloud
  no-`domain` registration path needs the requester's address.
- Delivery is best-effort (one retry). Subscribers that miss a ping catch
  up on their next poll.
```

- [ ] **Step 4: Full gates**

Run: `npm test -w core && npm test -w web && npm run typecheck -w core && npm run check -w web && npm run build -w web`
Expected: all green (web untouched; its gates prove that).

- [ ] **Step 5: Commit**

```bash
git add core/test/federation.test.ts docs/superpowers/documentation/RUNNING.md
git commit -m "$(printf 'core: the federation loop test — instance B ingests instance A over plain RSS\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 9: Whole-milestone verification (no code)

**Files:** none modified (a commit happens only if the smoke exposes a fix).

- [ ] **Step 1: Full gates** — same five commands as Task 8 Step 4; all green.

- [ ] **Step 2: Manual smoke (feeds + hub endpoints live)**

```bash
TEXTCASTER_DB=:memory: TEXTCASTER_TOKEN=dev TEXTCASTER_PUBLIC_URL=http://localhost:8787 TEXTCASTER_WEBSUB=self TEXTCASTER_RSSCLOUD=on npm run dev -w core &
sleep 2
curl -s -XPOST localhost:8787/posts -H 'authorization: Bearer dev' -H 'content-type: application/json' -d '{"handle":"alice","displayName":"Alice","content":"smoke post"}' >/dev/null
curl -s localhost:8787/users/alice/feed.xml | grep -o 'rel="hub"\|<cloud \|isPermaLink="false"\|smoke post' | sort -u
# Expected 4 lines: <cloud , isPermaLink="false", rel="hub", smoke post
curl -s localhost:8787/users/alice/feed.json | grep -o '"version": "https://jsonfeed.org/version/1.1"'
curl -s -o /dev/null -w '%{http_code}\n' -XPOST localhost:8787/hub -d 'hub.mode=subscribe&hub.topic=http://localhost:8787/users/nobody/feed.xml&hub.callback=https://cb.example.com/x'
# Expected: 404 (unknown topic)
curl -s -o /dev/null -w '%{http_code}\n' -XPOST localhost:8787/rsscloud/pleaseNotify -d 'protocol=xml-rpc&port=80&path=/x&url1=http://localhost:8787/users/alice/feed.xml'
# Expected: 400 (only http-post)
kill %1
```
(A full subscribe cannot be smoked locally — the SSRF guard rejects loopback callbacks by design; the vitest suite covers that path with stubbed lookups.)

- [ ] **Step 3: Report** — capture gate + smoke output; no commit unless something was fixed.

---

## Self-Review (done at plan-writing time)

- **Spec coverage:** §1 feeds/mapper/routes/302/404/round-trip/raw-strings → Tasks 3-4; §2 config incl. H1 opt-in defaults + fail-fast → Task 1; §3 storage/migration 2/upsert-DO-UPDATE/caps counter → Task 2, H2 guard → Task 5, external ping → Task 5, self hub + H7 lease asymmetry + fat ping/HMAC/once-per-topic → Task 6, rssCloud incl. deliberate no-domain challenge → Task 7; H3 equality (incl. trailing-slash/case rejection tests) → Task 6; H4 never-rejects seam + `void` wiring + ponytail coalescing ceiling → Task 5 (comment + test); §4 money test → Task 8; RUNNING.md → Task 8; non-goals built nowhere (no push-in, no retry queue, no Atom/OPML, web untouched — Task 8/9 web gates prove it).
- **Placeholder scan:** one deliberately-marked illustrative block in Task 6 Step 3 is immediately followed by the real, complete code with an explicit "implement it concretely as follows" instruction; all other steps carry full code.
- **Type consistency:** `WebSubMode`/`Config` (Task 1) consumed by feed.ts (4), push.ts (5-7), server.ts (5,7); `Subscription`/`PushProtocol` (Task 2) used by push.ts (6-7) and contract tests; `RegistrationResult {status: 202|400|404|429}` identical in push.ts handlers (6-7) and `PushApi` (6); `FeedContext {publicUrl, hubUrl, rssCloud}` identical in feed.ts (4), app.ts (4), push.ts delivery ctx (6), tests; `feedUrls`/`hubLinkUrl` signatures consistent across 4-7; `checkCallbackUrl` returns `{ok:true; host}|{ok:false; reason}` consumed as `gate.host`/`gate.reason` in 6-7.
