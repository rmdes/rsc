# All-Users RSS Firehose Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `/users/rss.xml` — an RSS 2.0 firehose of all local posts with rss.chat-grade interop (`<source>` attribution, `source:markdown`/`inReplyTo`/`comments`/`account`, permalinks), pushed over WebSub + rssCloud.

**Architecture:** A new repo query (`getRecentLocalPosts` → `TimelineEntry[]`, author inline) feeds a new renderer in `core/src/domain/feed.ts` that reuses the per-user item mapping plus the RSS core `<source>` element; the existing string injector generalizes to carry `source:account` beside `source:comments`; `resolveLocalTopic` grows a firehose arm (discriminated union, zero caller changes); `onLocalPost` notifies the firehose topic in all three push modes. Local posts additionally gain a permalink `url` at creation.

**Tech Stack:** feedsmith (existing — generation of item `source`, channel `sourceNs.self`, permalink guids probed 2026-07-17 against installed 2.9.6; `sourceNs.account` is DROPPED on generate, hence the injector), Hono, Kysely, Vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-17-textcaster-firehose-design.md` (rev 2). It wins on ambiguity.
- Firehose contains LOCAL posts only — never re-broadcast remote content.
- Item limit: the existing `FEED_LIMIT` constant in `core/src/api/app.ts` (currently 50) — reuse it, do not mint another.
- guid stays the stored UUID with `isPermaLink="false"` everywhere (named divergence from rss.chat; guid VALUES must never change — subscriber dedup and cross-instance reply refs depend on them).
- `source:account` is OUTBOUND-ONLY (spec F-3): never add ingest-side consumption of `sourceNs.account`; attribution stays on the RSS core `<source url>`.
- Per-user feeds must stay byte-identical for EXISTING posts (url null → no `<link>`, same guid): the feed contract tests must pass unmodified except where a test itself creates a post through the changed creation path.
- better-auth landed (4c88ed6..5cea86d): `POST /posts` is session-authed; test helpers `anonSession`/`registeredSession` live in `core/test/auth-helper.ts`.
- Shared checkout with a parallel session: stage EXPLICIT paths only (never `git add -A`). Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Local posts gain a permalink URL at creation

**Files:**
- Modify: `core/src/domain/service.ts` (`createService` signature + `createLocalPostAs`)
- Modify: `core/src/server.ts` (pass `config.publicUrl`)
- Test: `core/test/service.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new.
- Produces: `createService(repo, bus, publicUrl?: string | null)` — third optional param, `undefined`/`null` = no permalinks (existing behavior). Local posts created with a publicUrl carry `url = ${publicUrl}/post/${id}`.

- [ ] **Step 1: Write the failing tests** (append to `core/test/service.test.ts`, matching its existing repo/bus setup helpers):

```ts
test('local posts get a permalink url when publicUrl is configured', async () => {
  const repo = await createSqliteRepository(':memory:')
  const service = createService(repo, createEventBus(), 'https://tc.example')
  const entry = await service.createLocalPostAs('alice', 'Alice', 'hello')
  expect(entry.url).toBe(`https://tc.example/post/${entry.id}`)
})

test('local posts keep url null without publicUrl (existing behavior)', async () => {
  const repo = await createSqliteRepository(':memory:')
  const service = createService(repo, createEventBus())
  const entry = await service.createLocalPostAs('alice', 'Alice', 'hello')
  expect(entry.url).toBeNull()
})

test('replies to permalinked posts reference the permalink, not the guid', async () => {
  const repo = await createSqliteRepository(':memory:')
  const service = createService(repo, createEventBus(), 'https://tc.example')
  const parent = await service.createLocalPostAs('alice', 'Alice', 'root')
  const parentPost = await repo.getPost(parent.id)
  const reply = await service.createLocalPostAs('bob', 'Bob', 'reply', parentPost!)
  expect(reply.inReplyTo).toBe(`https://tc.example/post/${parent.id}`)
  expect(reply.threadRootId).toBe(parent.id)
})
```

- [ ] **Step 2: Run to verify failure** — `npm test -w core -- service`. Expected: FAIL (`createService` takes 2 args / url null).

- [ ] **Step 3: Implement.** In `core/src/domain/service.ts`:

```ts
export function createService(repo: Repository, bus: EventBus, publicUrl?: string | null) {
```

and in `createLocalPostAs`, replace the post construction's first line:

```ts
      const id = randomUUID()
      const post: Post = {
        // Permalink minted at creation (spec: Dave-style permalink refs for
        // future replies via the existing `replyTo.url ?? replyTo.guid`).
        // guid stays an opaque UUID — never a URL (guid stability contract).
        id, authorId: author.id, source: 'local', guid: randomUUID(), title: null, content,
        url: publicUrl ? `${publicUrl}/post/${id}` : null,
```

(keep the remaining fields exactly as they are; `id` now comes from the const).

In `core/src/server.ts`, find the `createService(` call and pass `config.publicUrl` as the third argument.

- [ ] **Step 4: Run** — `npm test -w core` → ALL PASS. Existing tests construct `createService(repo, bus)` → url stays null → feed/api contracts unchanged. If any test asserts `url: null` on a post created WITH a publicUrl-bearing service, that test is exercising the changed path — update only such tests, and say so in the report.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck -w core
git add core/src/domain/service.ts core/src/server.ts core/test/service.test.ts
git commit -m "core: local posts mint a permalink url at creation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `getRecentLocalPosts` repository surface

**Files:**
- Modify: `core/src/storage/sqlite.ts` (one method)
- Modify: `core/src/domain/repository.ts` (contract)
- Modify: `core/src/domain/service.ts` (passthrough)
- Test: `core/src/domain/repository-contract.ts` (extend — it is the shared contract-test module)

**Interfaces:**
- Consumes: nothing new.
- Produces: `getRecentLocalPosts(limit: number): Promise<TimelineEntry[]>` (author inline — the renderer needs displayName + handle per item) on Repository AND as a service passthrough of the same name.

- [ ] **Step 1: Failing contract test** (append inside the contract suite in `core/src/domain/repository-contract.ts`, using its existing `makeRepo`/`mkPost` helpers):

```ts
    test('getRecentLocalPosts: local authors only, newest first, limited', async () => {
      const repo = await makeRepo()
      const local = await repo.createLocalUser({ handle: 'loc', displayName: 'Loc' })
      const remote = await repo.createRemoteUser({ handle: 'rem', displayName: 'Rem', feedUrl: 'https://r.ex/f' })
      await repo.insertPost(mkPost({ id: 'l1', authorId: local.id, guid: 'l1', publishedAt: '2026-01-01T00:00:00.000Z' }))
      await repo.insertPost(mkPost({ id: 'l2', authorId: local.id, guid: 'l2', publishedAt: '2026-01-02T00:00:00.000Z' }))
      await repo.insertPost(mkPost({ id: 'r1', authorId: remote.id, guid: 'r1', publishedAt: '2026-01-03T00:00:00.000Z' }))
      const entries = await repo.getRecentLocalPosts(10)
      expect(entries.map((e) => e.id)).toEqual(['l2', 'l1']) // remote excluded, newest first
      expect(entries[0].author.handle).toBe('loc') // author joined inline
      expect((await repo.getRecentLocalPosts(1)).map((e) => e.id)).toEqual(['l2'])
    })
```

- [ ] **Step 2: Run to verify failure** — `npm test -w core -- sqlite-repository` (the contract runs through that suite). Expected: FAIL (method missing).

- [ ] **Step 3: Implement** in `SqliteRepository` (same joined-select shape as `getThread` — copy its `.innerJoin('users', ...)` select list including `u_auth_user_id`, and reuse `joinedRowToEntry`):

```ts
  async getRecentLocalPosts(limit: number): Promise<TimelineEntry[]> {
    const rows = await this.db
      .selectFrom('posts')
      .innerJoin('users', 'users.id', 'posts.author_id')
      .selectAll('posts')
      .select(['users.id as u_id', 'users.kind as u_kind', 'users.handle as u_handle', 'users.display_name as u_display_name', 'users.feed_url as u_feed_url', 'users.created_at as u_created_at', 'users.auth_user_id as u_auth_user_id'])
      .where('users.kind', '=', 'local')
      .orderBy('posts.published_at', 'desc')
      .orderBy('posts.id', 'desc')
      .limit(limit)
      .execute()
    return rows.map(joinedRowToEntry)
  }
```

Contract: add `getRecentLocalPosts(limit: number): Promise<TimelineEntry[]>` to the `Repository` type in `core/src/domain/repository.ts`. Service: add the passthrough `getRecentLocalPosts: (limit: number) => repo.getRecentLocalPosts(limit),` in the returned object in `service.ts`.

- [ ] **Step 4: Run + commit**

```bash
npm test -w core && npm run typecheck -w core
git add core/src/storage/sqlite.ts core/src/domain/repository.ts core/src/domain/service.ts core/src/domain/repository-contract.ts
git commit -m "core: getRecentLocalPosts — the firehose window query

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Firehose renderer + injector generalization

**Files:**
- Modify: `core/src/domain/feed.ts` (firehose renderer, `firehoseUrl`, injector core + `injectSourceAccounts`)
- Test: `core/test/feed.test.ts` (extend)

**Interfaces:**
- Consumes: `TimelineEntry[]` from Task 2; existing `FeedContext`, `itemContentFields`, `hubLinkUrl`.
- Produces (Tasks 4–5 call these):
  - `firehoseUrl(publicUrl: string): string` → `` `${publicUrl}/users/rss.xml` ``
  - `renderFirehoseRss(entries: TimelineEntry[], ctx: FeedContext): string`
  - `injectSourceAccounts(xml: string, ads: Array<{ guid: string; service: string; name: string }>): string`
  - `injectSourceComments` keeps its EXACT current signature (both existing call sites unchanged).

- [ ] **Step 1: Failing tests** (append to `core/test/feed.test.ts`, reusing its user/post fixture style):

```ts
test('firehose: RSS 2.0 channel + <source> attribution on every item', () => {
  const ctx = { publicUrl: 'https://tc.example', hubUrl: 'https://tc.example/hub', rssCloud: true }
  const alice = { id: 'u1', kind: 'local' as const, handle: 'alice', displayName: 'Alice', feedUrl: null, createdAt: '2026-01-01T00:00:00.000Z', authUserId: null }
  const entries = [{
    id: 'p1', authorId: 'u1', source: 'local' as const, guid: 'guid-1', title: null,
    content: 'hello **world**', url: 'https://tc.example/post/p1',
    publishedAt: '2026-01-02T00:00:00.000Z', createdAt: '2026-01-02T00:00:00.000Z',
    inReplyTo: null, inReplyToPostId: null, threadRootId: null,
    sourceName: null, sourceFeedUrl: null, contentMarkdown: null, author: alice,
  }]
  const xml = renderFirehoseRss(entries, ctx)
  expect(xml).toContain('<title>tc.example: all posts</title>')
  expect(xml).toContain('<link>https://tc.example</link>')
  expect(xml).toContain('Posts from all users on tc.example')
  expect(xml).toContain('<source:self>https://tc.example/users/rss.xml</source:self>')
  expect(xml).toContain('rel="self" href="https://tc.example/users/rss.xml"')
  expect(xml).toContain('<cloud ')
  expect(xml).toContain('<source url="https://tc.example/users/alice/feed.xml">Alice</source>')
  expect(xml).toContain('<guid isPermaLink="false">guid-1</guid>')
  expect(xml).toContain('<link>https://tc.example/post/p1</link>')
  expect(xml).toContain('<source:markdown>')
})

test('injectSourceAccounts: element lands inside the right item; xmlns declared once with comments', () => {
  const ctx = { publicUrl: 'https://tc.example', hubUrl: null, rssCloud: false }
  const alice = { id: 'u1', kind: 'local' as const, handle: 'alice', displayName: 'Alice', feedUrl: null, createdAt: '2026-01-01T00:00:00.000Z', authUserId: null }
  const entries = [{
    id: 'p1', authorId: 'u1', source: 'local' as const, guid: 'guid-1', title: null,
    content: 'x', url: null, publishedAt: '2026-01-02T00:00:00.000Z', createdAt: '2026-01-02T00:00:00.000Z',
    inReplyTo: null, inReplyToPostId: null, threadRootId: null,
    sourceName: null, sourceFeedUrl: null, contentMarkdown: null, author: alice,
  }]
  let xml = renderFirehoseRss(entries, ctx)
  xml = injectSourceAccounts(xml, [{ guid: 'guid-1', service: 'tc.example', name: 'alice' }])
  xml = injectSourceComments(xml, [{ guid: 'guid-1', count: 2, feedUrl: 'https://tc.example/post/p1/comments.xml' }])
  expect(xml).toContain('<source:account service="tc.example">alice</source:account>')
  expect(xml).toContain('<source:comments count="2"')
  expect(xml.match(/xmlns:source=/g)?.length).toBe(1)
})
```

(Import `renderFirehoseRss` and `injectSourceAccounts` at the top of the test file alongside the existing feed imports.)

- [ ] **Step 2: Run to verify failure** — `npm test -w core -- feed`. Expected: FAIL (exports missing).

- [ ] **Step 3: Implement in `core/src/domain/feed.ts`.**

(a) URL helper next to `feedUrls`:

```ts
export function firehoseUrl(publicUrl: string): string {
  return `${publicUrl}/users/rss.xml`
}
```

(b) The renderer (below `renderRssFeed`, same style):

```ts
// The all-users firehose (rss.chat's /users/rss.xml convention): every LOCAL
// post, with RSS core <source> naming the item's author and linking their
// personal feed — the same element our ingest attributes rss.chat items by.
export function renderFirehoseRss(entries: TimelineEntry[], ctx: FeedContext): string {
  const host = ctx.publicUrl ? new URL(ctx.publicUrl).host : 'textcaster.invalid'
  const atomLinks: Array<{ href: string; rel: string; type?: string }> = []
  let cloud
  if (ctx.publicUrl) {
    atomLinks.push({ href: firehoseUrl(ctx.publicUrl), rel: 'self', type: 'application/rss+xml' })
    if (ctx.hubUrl) atomLinks.push({ href: ctx.hubUrl, rel: 'hub' })
    if (ctx.rssCloud) {
      const u = new URL(ctx.publicUrl)
      cloud = { domain: u.hostname, port: urlPort(u), path: '/rsscloud/pleaseNotify', registerProcedure: '', protocol: 'http-post' }
    }
  }
  return generateRssFeed(
    {
      title: `${host}: all posts`,
      link: ctx.publicUrl ?? 'https://textcaster.invalid',
      description: `Posts from all users on ${host}`,
      ...(atomLinks.length ? { atom: { links: atomLinks } } : {}),
      ...(cloud ? { cloud } : {}),
      ...(ctx.publicUrl ? { sourceNs: { self: firehoseUrl(ctx.publicUrl) } } : {}),
      items: entries.map((p) => ({
        ...(p.title !== null ? { title: p.title } : {}),
        guid: { value: p.guid, isPermaLink: false },
        ...(p.url !== null ? { link: p.url } : {}),
        pubDate: p.publishedAt,
        // RSS core <source>: the item's author and their personal feed.
        ...(ctx.publicUrl ? { source: { title: p.author.displayName, url: feedUrls(ctx.publicUrl, p.author.handle).xml } } : {}),
        ...itemContentFields(p),
      })),
    },
    { lenient: true },
  )
}
```

(Add `TimelineEntry` to the type imports from `./types.ts`.)

(c) Generalize the injector: rename the body of `injectSourceComments` into a private core that takes prebuilt fragments, and make both public functions thin wrappers. The existing exported signature MUST NOT change:

```ts
// Shared injector core: feedsmith cannot serialize these sourceNs elements
// (probed: comments AND account are silently dropped), so they are injected
// into XML WE generated, keyed by the <guid> element value.
// ponytail: delete all of this the day feedsmith serializes them.
function injectItemElements(xml: string, ads: Array<{ guid: string; fragment: string }>): string {
  let out = xml
  let injected = false
  for (const ad of ads) {
    const markers = [`<![CDATA[${ad.guid}]]>`, `>${xmlAttrEscape(ad.guid)}</guid>`]
    let at = -1
    for (const m of markers) { at = out.indexOf(m); if (at !== -1) break }
    if (at === -1) continue
    const close = out.indexOf('</item>', at)
    if (close === -1) continue
    out = out.slice(0, close) + ad.fragment + out.slice(close)
    injected = true
  }
  if (injected && !out.slice(0, out.indexOf('>') + 1).includes('xmlns:source=')) {
    out = out.replace('<rss ', '<rss xmlns:source="http://source.scripting.com/" ')
  }
  return out
}

export function injectSourceComments(xml: string, ads: Array<{ guid: string; count: number; feedUrl: string }>): string {
  return injectItemElements(xml, ads.map((ad) => ({ guid: ad.guid, fragment: `<source:comments count="${ad.count}" feedUrl="${xmlAttrEscape(ad.feedUrl)}"/>` })))
}

// Outbound-only interop (spec F-3): our ingest never reads source:account —
// attribution comes from the RSS core <source url> element.
export function injectSourceAccounts(xml: string, ads: Array<{ guid: string; service: string; name: string }>): string {
  return injectItemElements(xml, ads.map((ad) => ({ guid: ad.guid, fragment: `<source:account service="${xmlAttrEscape(ad.service)}">${xmlEscape(ad.name)}</source:account>` })))
}
```

Delete the old inline body of `injectSourceComments` (its comment block moves onto `injectItemElements`).

- [ ] **Step 4: Run** — `npm test -w core -- feed` → PASS, then full `npm test -w core` (the two existing injectSourceComments call sites and their tests must pass untouched).

- [ ] **Step 5: Commit**

```bash
git add core/src/domain/feed.ts core/test/feed.test.ts
git commit -m "core: firehose RSS renderer + source:account injector sibling

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: The route + the round-trip money test

**Files:**
- Modify: `core/src/api/app.ts` (one route)
- Test: `core/test/feed.test.ts` (route + round-trip tests; the file already builds an app via `createApp` for feed routes — follow its pattern)

**Interfaces:**
- Consumes: `service.getRecentLocalPosts` (Task 2), `renderFirehoseRss`/`injectSourceAccounts`/`firehoseUrl` (Task 3), existing `FEED_LIMIT`, `feeds` context, `injectSourceComments`, `countRepliesByPostIds`.
- Produces: `GET /users/rss.xml` (public, no auth).

- [ ] **Step 1: Add the route** in `core/src/api/app.ts`, ABOVE the `/users/:handle/feed.xml` route (static-before-param clarity; Hono matches static first regardless, but the reading order should say what wins):

```ts
  app.get('/users/rss.xml', async (c) => {
    const entries = await service.getRecentLocalPosts(FEED_LIMIT)
    let xml = renderFirehoseRss(entries, feeds)
    if (feeds.publicUrl) {
      const pub = feeds.publicUrl
      const host = new URL(pub).host
      xml = injectSourceAccounts(xml, entries.map((p) => ({ guid: p.guid, service: host, name: p.author.handle })))
      const counts = await service.countRepliesByPostIds(entries.map((p) => p.id))
      xml = injectSourceComments(xml, entries.filter((p) => (counts.get(p.id) ?? 0) > 0)
        .map((p) => ({ guid: p.guid, count: counts.get(p.id)!, feedUrl: `${pub}/post/${p.id}/comments.xml` })))
    }
    return c.body(xml, 200, { 'content-type': 'application/rss+xml; charset=utf-8' })
  })
```

(Extend the existing `from './feed.ts'`-style import in app.ts — it already imports `renderRssFeed`/`injectSourceComments`; add `renderFirehoseRss`, `injectSourceAccounts`.)

Note the definition of `FEED_LIMIT` currently sits below some routes — if it is defined after the insertion point, move the route below the constant instead; do not re-declare it.

- [ ] **Step 2: Route + round-trip tests** (append to `core/test/feed.test.ts`; build the app the way the file's existing route tests do, with a publicUrl-configured feeds context and a session cookie from `core/test/auth-helper.ts` for creating posts):

```ts
test('GET /users/rss.xml serves the firehose; a user literally named rss keeps their feed', async () => {
  // build app with publicUrl configured, create local users+posts via the file's helpers
  const res = await app.request('/users/rss.xml')
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('application/rss+xml')
  const xml = await res.text()
  expect(xml).toContain(': all posts</title>')
  expect(xml).toContain('<source url=')
  expect(xml).toContain('<source:account ')
  // non-collision: a local user named "rss" still resolves per-user
  // (create user 'rss' via the ops-token POST /users pattern the file already uses, then:)
  const perUser = await app.request('/users/rss/feed.xml')
  expect(perUser.status).toBe(200)
  expect(await perUser.text()).not.toContain(': all posts</title>')
})

test('ROUND TRIP: our own ingest consumes the firehose with full attribution and threading', async () => {
  // 1. Two local users; alice posts a root, bob replies to it (created through
  //    the service with publicUrl set, so the reply references alice's permalink).
  // 2. Fetch /users/rss.xml, run the XML through parseFeedWithMeta + ingestItems
  //    into a FRESH repo under a remote user (the rss.chat consumption path).
  const { items } = await parseFeedWithMeta(xml)
  const freshRepo = await createSqliteRepository(':memory:')
  const sub = await freshRepo.createRemoteUser({ handle: 'tc-firehose', displayName: 'TC', feedUrl: 'https://tc.example/users/rss.xml' })
  await ingestItems(freshRepo, createEventBus(), sub, items)
  const timeline = await freshRepo.getTimeline(50)
  const root = timeline.find((e) => e.content.includes('root post text'))!
  const reply = timeline.find((e) => e.content.includes('reply text'))!
  // attribution: item author, not the subscription
  expect(root.sourceName).toBe('Alice')
  expect(root.sourceFeedUrl).toBe('https://tc.example/users/alice/feed.xml')
  expect(reply.sourceName).toBe('Bob')
  // threading: the reply resolved against the root's permalink (adoption
  // covers newest-first order: the reply arrives before its parent)
  expect(reply.inReplyToPostId).toBe(root.id)
  expect(reply.threadRootId).toBe(root.id)
})
```

These sketches name the assertions; the implementer wires the setup with the file's existing helpers (app construction, ops-token user creation, session-cookie post creation) — the assertion strings and structure above are the requirements. Use distinctive post contents ('root post text', 'reply text') so the finds are unambiguous.

- [ ] **Step 3: Run** — `npm test -w core -- feed` → PASS; full suite green.

- [ ] **Step 4: Commit**

```bash
git add core/src/api/app.ts core/test/feed.test.ts
git commit -m "core: GET /users/rss.xml — the all-users firehose, round-trip tested

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Push-out for the firehose topic + docs

**Files:**
- Modify: `core/src/domain/push.ts` (`resolveLocalTopic` union + `onLocalPost` firehose notifications)
- Modify: `docs/superpowers/documentation/RUNNING.md`
- Test: `core/test/push.test.ts` (extend)

**Interfaces:**
- Consumes: `firehoseUrl`, `renderFirehoseRss`, `injectSourceAccounts` (Task 3), `repo.getRecentLocalPosts` (Task 2).
- Produces: `resolveLocalTopic` returns `{ kind: 'user'; user: User; format: 'xml' | 'json' } | { kind: 'firehose'; format: 'xml' } | null`. Verified at plan time: BOTH existing callers keep working unchanged (`handleWebSubRequest:84` checks truthiness only; `handleRssCloudRequest:112` checks `resolved.format !== 'xml'`, which the firehose arm satisfies).

- [ ] **Step 1: Failing tests** (append to `core/test/push.test.ts`, matching its existing deps/fixture style — it already tests `resolveLocalTopic` and `onLocalPost` with mock fetch):

```ts
test('resolveLocalTopic recognizes the firehose topic', async () => {
  const repo = await createSqliteRepository(':memory:')
  const r = await resolveLocalTopic(repo, 'https://tc.example', 'https://tc.example/users/rss.xml')
  expect(r).toEqual({ kind: 'firehose', format: 'xml' })
  // per-user still resolves, now with kind
  await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
  const u = await resolveLocalTopic(repo, 'https://tc.example', 'https://tc.example/users/alice/feed.xml')
  expect(u?.kind).toBe('user')
  // near-misses stay null
  expect(await resolveLocalTopic(repo, 'https://tc.example', 'https://evil.example/users/rss.xml')).toBeNull()
})

test('onLocalPost fat-pings firehose subscribers with the firehose XML (self-hub mode)', async () => {
  // Arrange: self-hub config with publicUrl; a websub subscription whose topic
  // is the FIREHOSE url (insert via repo.upsertSubscription like the file's
  // other onLocalPost tests); mock fetch capturing deliveries.
  // Act: createPush(deps).onLocalPost(<local entry>)
  // Assert: one delivery to the firehose subscriber whose body contains
  // ': all posts</title>' AND '<source url=' (it is the firehose, not the
  // author feed), with content-type application/rss+xml and a link header
  // whose rel="self" is the firehose topic.
})

test('onLocalPost rssCloud thin-pings the firehose topic too', async () => {
  // Arrange: rssCloud enabled; one rsscloud subscription on the author topic
  // and one on the firehose topic; mock fetch.
  // Assert: two thin pings; one body url=<author feed.xml>, one url=<firehose>.
})
```

(The two sketched tests name the exact assertions; wire arrange/act with the file's established helpers. If the file has no upsertSubscription-based onLocalPost test to copy, report NEEDS_CONTEXT rather than inventing a new harness.)

- [ ] **Step 2: Run to verify failure**, then implement in `core/src/domain/push.ts`:

(a) The resolver:

```ts
export type ResolvedTopic =
  | { kind: 'user'; user: User; format: 'xml' | 'json' }
  | { kind: 'firehose'; format: 'xml' }

// H3: exact string equality against re-minted URLs of known topics.
export async function resolveLocalTopic(repo: Repository, publicUrl: string, topic: string): Promise<ResolvedTopic | null> {
  if (topic === firehoseUrl(publicUrl)) return { kind: 'firehose', format: 'xml' }
  const m = /^.*\/users\/([a-z0-9-]{1,64})\/feed\.(xml|json)$/.exec(topic)
  if (!m) return null
  const [, handle, format] = m
  const minted = format === 'xml' ? feedUrls(publicUrl, handle).xml : feedUrls(publicUrl, handle).json
  if (topic !== minted) return null
  const user = await repo.getUserByHandle(handle)
  if (!user || user.kind !== 'local') return null
  return { kind: 'user', user, format: format as 'xml' | 'json' }
}
```

(import `firehoseUrl` from `./feed.ts`; note `/users/rss.xml` cannot match the per-user regex — no `/feed.` segment — so arm order is belt-and-braces, not load-bearing.)

(b) `onLocalPost` — three additions, one per protocol block:

- external hub: after the per-user loop, `await publishPing(config.websub.hubUrl, firehoseUrl(config.publicUrl), fetchFn)` inside its own try/catch identical to the per-user one.
- self hub: after the per-user `for (const [format, topic] ...)` loop, a firehose block:

```ts
          const fhTopic = firehoseUrl(config.publicUrl)
          const fhSubs = (await repo.listActiveSubscriptions(fhTopic, now)).filter((s) => s.protocol === 'websub')
          if (fhSubs.length > 0) {
            const recent = await repo.getRecentLocalPosts(50)
            let body = renderFirehoseRss(recent, ctx)
            const host = new URL(config.publicUrl).host
            body = injectSourceAccounts(body, recent.map((p) => ({ guid: p.guid, service: host, name: p.author.handle })))
            const fhCounts = await repo.countRepliesByPostIds(recent.map((p) => p.id))
            body = injectSourceComments(body, recent.filter((p) => (fhCounts.get(p.id) ?? 0) > 0)
              .map((p) => ({ guid: p.guid, count: fhCounts.get(p.id)!, feedUrl: `${ctx.publicUrl}/post/${p.id}/comments.xml` })))
            for (const sub of fhSubs) {
              const headers: Record<string, string> = {
                'content-type': 'application/rss+xml; charset=utf-8',
                link: `<${fhTopic}>; rel="self", <${ctx.hubUrl}>; rel="hub"`,
              }
              if (sub.secret) headers['x-hub-signature'] = 'sha256=' + createHmac('sha256', sub.secret).update(body).digest('hex')
              await deliverOnce(fetchFn, sub.callback, body, headers)
            }
          }
```

- rssCloud: extend the existing block to also ping firehose-topic subscribers:

```ts
          const fhTopic = firehoseUrl(config.publicUrl)
          const fhCloudSubs = (await repo.listActiveSubscriptions(fhTopic, now)).filter((s) => s.protocol === 'rsscloud')
          for (const sub of fhCloudSubs) {
            await deliverOnce(fetchFn, sub.callback, new URLSearchParams({ url: fhTopic }).toString(), { 'content-type': 'application/x-www-form-urlencoded' })
          }
```

(import `renderFirehoseRss`, `injectSourceAccounts`, `firehoseUrl` in push.ts's existing `./feed.ts` import; mind variable-name collisions with the per-user block — the `fh` prefix exists for that reason.)

(c) Any existing push test that destructures `resolveLocalTopic`'s return as `{ user, format }` updates to the union (`r?.kind === 'user' ? r.user : ...` or asserts on `kind`). That is the contract growing; list each such edit in the report.

- [ ] **Step 3: RUNNING.md** — add under the feeds section: the firehose URL (`/users/rss.xml`), what it carries (all local posts, `<source>` attribution per item, same push protocols as user feeds), and the divergence note (permalinks in `<link>`, guids opaque and stable).

- [ ] **Step 4: Run** — `npm test -w core` → ALL PASS; `npm run typecheck -w core` → clean.

- [ ] **Step 5: Commit**

```bash
git add core/src/domain/push.ts core/test/push.test.ts docs/superpowers/documentation/RUNNING.md
git commit -m "core: firehose is a first-class push topic (websub + rsscloud) + docs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Plan self-review notes (done at write time)

- Spec coverage: endpoint (T4), channel/items incl. skips (T3), permalink url (T1), guid divergence (Global Constraints + T1 comment), push-out F-1 as real work (T5 — union type, and the plan-time discovery that both existing resolver call sites need ZERO changes: websub checks truthiness, rssCloud checks `format !== 'xml'`), getRecentLocalPosts F-2 (T2, returns TimelineEntry[] because the renderer needs authors inline — a refinement of the spec's `Post[]`, noted here deliberately), account outbound-only F-3 (T3 comment + no ingest change anywhere), routing non-collision (T4 test), round-trip money test (T4), FEED_LIMIT reuse (T4), RUNNING.md (T5), validator.w3.org left as the user's post-deploy click-check.
- Deviation from spec, deliberate: `getRecentLocalPosts` returns `TimelineEntry[]` (author joined) instead of `Post[]` — the firehose renderer and push fat-ping both need displayName+handle per item; a `Post[]` would force N author lookups at every render. Same data, one query.
- Type consistency: `firehoseUrl(publicUrl)`, `renderFirehoseRss(entries, ctx)`, `injectSourceAccounts(xml, {guid,service,name}[])`, `getRecentLocalPosts(limit) → TimelineEntry[]`, `ResolvedTopic` union, `createService(repo, bus, publicUrl?)` used identically across tasks.
- Two test blocks in T4/T5 are assertion-sketches over the files' existing harnesses rather than fully-wired code — deliberate: those harnesses (app construction with session auth, push mock-fetch fixtures) changed under better-auth this week, and verbatim plan code would drift; the sketches pin the assertions and name the helpers to copy, with NEEDS_CONTEXT as the escape hatch.
