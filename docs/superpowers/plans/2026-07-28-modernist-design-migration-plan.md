# Modernist Design Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace RSC's current magazine/editorial visual system (Libre Bodoni,
rounded cards, shadows, pill badges) with the externally-authored Modernist
system (Archivo, zero radius, rule-based) without changing any behavior,
route, or CSS custom-property name.

**Architecture:** Two file-replacement commits (design-system doc + global
stylesheet) establish the new tokens/components, followed by targeted markup
edits across ~10 Svelte files to match the new component anatomy the CSS
assumes. No new dependencies. One small new core route (`GET
/users/:handle/stats`, Task 7) backed entirely by existing/trivially-indexed
queries — the only functional (non-visual) addition in this plan.

**Tech Stack:** SvelteKit (Svelte 5 runes), `web/src/app.css`, existing Hono
core API.

**Source material:** `MASTER.md`, `app.css`, `svelte-changes.md`,
`MIGRATION.md` at `C:\Users\Rick\Downloads\RSC design with Modernist preview\handoff`
on the Windows host (`/mnt/c/Users/Rick/Downloads/RSC design with Modernist preview/handoff`
from WSL) — already reviewed, not copied into the repo. Read
`docs/superpowers/specs/2026-07-28-modernist-design-migration.md` first: it
records the decisions and corrections this plan encodes.

## Global Constraints

- Accent stays RSS orange: `#C2410C` light / `#EA580C` dark. Never Modernist's own red.
- Every existing CSS custom-property **name** is unchanged — only values/shapes change.
- `--radius: 0` everywhere. No rounded corners anywhere, including inherited/hardcoded page-local values.
- No-JS must keep working: tabs are real `<a>` links, the composer's no-JS fallback is a plain `<details open>` form, the mobile menu is a native `<details>`.
- Local vs remote is never colour alone — the 2px rule's colour **and** the uppercase label's text (naming the source host on remote rows).
- Live SSE prepends must not jank — do not reintroduce the `.post.remote` background tint.
- Both themes are designed/tested independently; dark hover steps **lighter**, not darker.
- 44px minimum touch targets; focus is `outline: 2px solid var(--color-accent); outline-offset: 2px` on `:focus-visible` — delete every leftover soft `box-shadow` focus override.
- `prefers-reduced-motion` kills every transition.
- Carta composer: keep every `body`-prefixed selector in `app.css` and the `.carta-input` font-metric rules exactly as shipped — `carta-md/default.css` loads after `app.css` and equal specificity would silently lose the tie.
- If a test breaks because markup legitimately moved, update the test. If a test breaks because *behavior* changed, that's a bug in the task — stop and fix the cause, don't paper over it with a test edit.
- Never fabricate data: a stat cell only renders when its number was actually queried (Task 7).

---

### Task 1: `design-system/rsc/MASTER.md` → Modernist

**Files:**
- Modify: `design-system/rsc/MASTER.md` (full overwrite)

**Interfaces:** None — this is documentation, consumed by future page work, not by any other task in this plan.

- [ ] **Step 1: Overwrite the file verbatim from the handoff**

```bash
cp "/mnt/c/Users/Rick/Downloads/RSC design with Modernist preview/handoff/MASTER.md" design-system/rsc/MASTER.md
```

- [ ] **Step 2: Diff-review — confirm nothing but this one file changed**

```bash
git status --short
```
Expected: only `design-system/rsc/MASTER.md` modified.

- [ ] **Step 3: Commit**

```bash
git add design-system/rsc/MASTER.md
git commit -m "design: MASTER.md → Modernist (Archivo, ruled river, RSS orange kept)"
```

---

### Task 2: The stylesheet + stale font link + visual baseline

**Files:**
- Modify: `web/src/app.css` (full overwrite)
- Modify: `web/src/app.html` (remove the old Google Fonts `<link>`)
- Create (gitignored, not committed): `web/.env`

**Interfaces:** None consumed. Produces: every CSS custom-property value and
component rule the rest of this plan's markup tasks assume (class names like
`.nav`, `.nav-menu`, `.page-head`, `.kicker`, `.byline-name`, `.lens-stats`,
`.table`, `.table-records` all come from this file).

- [ ] **Step 1: Overwrite the stylesheet verbatim from the handoff**

```bash
cp "/mnt/c/Users/Rick/Downloads/RSC design with Modernist preview/handoff/app.css" web/src/app.css
```

- [ ] **Step 2: Remove the stale Libre Bodoni / Public Sans font link**

`web/src/app.html` currently has (in `<head>`):

```html
		<link rel="preconnect" href="https://fonts.googleapis.com" />
		<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
		<link
			href="https://fonts.googleapis.com/css2?family=Libre+Bodoni:wght@400;500;600;700&family=Public+Sans:wght@300;400;500;600;700&display=swap"
			rel="stylesheet"
		/>
```

`app.css` (just copied) already carries its own `@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;800&display=swap');`
for Archivo — this `<link>` block is for fonts the new system no longer uses.
Delete the whole three-tag block (both `preconnect`s and the `stylesheet`
link). Nothing replaces it; `app.css`'s own `@import` is the single source now.

- [ ] **Step 3: Commit the file swap**

```bash
git add web/src/app.css web/src/app.html
git commit -m "design: Modernist tokens and component rules"
```

- [ ] **Step 4: Point a local dev server at the already-running shared core**

The shared dev stack (`docker compose`, from the main checkout) is already
running on fixed host ports (5173 web, 8787 core, 8025/1025 Mailpit) — do not
stop it, another session may be using it. Run this worktree's web dev server
on the host instead, against the same read-only core:

```bash
echo "CORE_API_URL=http://localhost:8787" > web/.env
npm run dev -w web
```

Vite's default `strictPort: false` means it auto-picks the next free port
(5174) since 5173 is taken by the container — note the port it reports.

- [ ] **Step 5: Visual baseline check**

Using the browser tool, navigate to the reported dev URL (e.g.
`http://localhost:5174/`). Check both `?` no explicit theme (system) and
force light/dark via the existing toggle. Confirm: Archivo renders (not
Libre Bodoni), the accent reads as RSS orange (not Modernist red), square
corners everywhere, 2px/1px rules visible. **Three known cosmetic oddities
are expected and are fixed by later tasks — do not treat them as bugs:** the
brand appears twice (masthead + new nav), the old bordered tab strip still
sits above the river, the letter avatar is still in the byline.

- [ ] **Step 6: STOP — report to the user before continuing**

Report what the browser tool showed (screenshot or description) for both
themes. This is the cheapest point to catch a wrong type or accent — get
explicit confirmation before Task 3 touches any markup.

---

### Task 3: The nav bar (`+layout.server.ts` + `+layout.svelte`)

**Files:**
- Modify: `web/src/routes/+layout.server.ts`
- Modify: `web/src/routes/+layout.svelte`
- Test: `web/src/routes/layout.load.test.ts`

**Interfaces:**
- Consumes: `resolveTab(raw: string | null, me: { isAnonymous: boolean } | null): Tab` from `$lib/tabs` (already exported, used identically in `+page.server.ts:27` — do not change that file, this is a deliberate small duplication of a cheap pure function, not a shared dependency).
- Produces: `LayoutServerLoad` return type gains `tab: Tab`, consumed by `+layout.svelte`'s `data.tab` and, from Task 8 onward, the mobile menu panel.

- [ ] **Step 1: Add `tab` to the layout load**

`web/src/routes/+layout.server.ts` currently:

```ts
import type { LayoutServerLoad } from './$types'
import { getMe } from '$lib/api'
import { authedFetch, base, cookieHeader, hasSession } from '$lib/server/session'

// Fail-soft to false: a core hiccup here should hide email UI, not crash the layout.
async function getMailEnabled(f: typeof fetch): Promise<boolean> {
	try {
		const res = await f(`${base()}/health`)
		if (!res.ok) return false
		const body = (await res.json()) as { mailEnabled?: boolean }
		return body.mailEnabled === true
	} catch {
		return false
	}
}

export const load: LayoutServerLoad = async ({ fetch, cookies, url }) => {
	const mailEnabled = await getMailEnabled(fetch)
	if (!hasSession(cookies)) return { me: null, mailEnabled }
	try {
		return { me: await getMe(authedFetch(fetch, url.origin, cookieHeader(cookies))), mailEnabled }
	} catch {
		return { me: null, mailEnabled }
	}
}
```

Replace with:

```ts
import type { LayoutServerLoad } from './$types'
import { getMe } from '$lib/api'
import { authedFetch, base, cookieHeader, hasSession } from '$lib/server/session'
import { resolveTab } from '$lib/tabs'

// Fail-soft to false: a core hiccup here should hide email UI, not crash the layout.
async function getMailEnabled(f: typeof fetch): Promise<boolean> {
	try {
		const res = await f(`${base()}/health`)
		if (!res.ok) return false
		const body = (await res.json()) as { mailEnabled?: boolean }
		return body.mailEnabled === true
	} catch {
		return false
	}
}

export const load: LayoutServerLoad = async ({ fetch, cookies, url }) => {
	const mailEnabled = await getMailEnabled(fetch)
	const tab = (me: Parameters<typeof resolveTab>[1]) => resolveTab(url.searchParams.get('tab'), me)
	if (!hasSession(cookies)) return { me: null, mailEnabled, tab: tab(null) }
	try {
		const me = await getMe(authedFetch(fetch, url.origin, cookieHeader(cookies)))
		return { me, mailEnabled, tab: tab(me) }
	} catch {
		return { me: null, mailEnabled, tab: tab(null) }
	}
}
```

- [ ] **Step 2: Update the three existing layout-load tests**

`web/src/routes/layout.load.test.ts` has three `toEqual` assertions that will
now fail because the returned object gained a `tab` field. All three URLs are
`http://x/` with no `?tab=` param and either no `me` or an anonymous `me`, so
`resolveTab` resolves to `'public'` in every case:

```ts
	expect(result).toEqual({ me: null, mailEnabled: true, tab: 'public' })
```
(test 1, line 11)

```ts
	expect(result).toEqual({ me: { user: { id: 'u1', handle: 'a' }, isAnonymous: true }, mailEnabled: false, tab: 'public' })
```
(test 2, line 24)

```ts
	expect(result).toEqual({ me: null, mailEnabled: false, tab: 'public' })
```
(test 3, line 35)

- [ ] **Step 3: Run the layout tests**

```bash
npm test -w web -- layout.load
```
Expected: 4 passed (3 updated + the unrelated `healthz` test).

- [ ] **Step 4: Add the nav bar to `+layout.svelte`**

Current `web/src/routes/+layout.svelte` script block:

```svelte
<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();
</script>
```

Add these imports:

```svelte
<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import type { LayoutData } from './$types';
	import ThemeToggle from '$lib/ThemeToggle.svelte'
	import { TABS } from '$lib/tabs'
	import { page } from '$app/state'

	let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();
</script>
```

Insert this immediately after the `<div class="identity-bar">…</div>` block,
before `{@render children()}`:

```svelte
<nav class="nav" aria-label="Timeline">
	<a class="nav-brand" href="/">RSC</a>
	{#each TABS as t (t)}
		<a href="/?tab={t}" aria-current={page.url.pathname === '/' && data.tab === t ? 'page' : undefined}>{t}</a>
	{/each}
	<a class="spacer" href="/users/rss.xml" target="_blank" rel="noreferrer">Firehose</a>
	<ThemeToggle />
</nav>
```

- [ ] **Step 5: Typecheck and svelte-check**

```bash
npm run typecheck -w core && npm run check -w web
```
Expected: 0 errors both.

- [ ] **Step 6: Visual check + commit**

Reload the dev server tab, confirm the nav bar renders with brand, four tab
links, Firehose, theme toggle — underneath the identity strip, above the
still-duplicated old tab strip/masthead (expected, Task 4 removes those).

```bash
git add web/src/routes/+layout.server.ts web/src/routes/+layout.svelte web/src/routes/layout.load.test.ts
git commit -m "design: nav bar with tabs, brand and theme toggle"
```

---

### Task 4: The river (`+page.svelte`)

**Files:**
- Modify: `web/src/routes/+page.svelte`

**Interfaces:**
- Consumes: `data.tab: Tab` (Task 3), existing `TimelineEntry` fields (`source`, `url`, `sourceName`, `author.displayName`, `publisherId`, `author.handle`, `publishedAt`, `id`).
- Produces: no new exports — this is a leaf page component.

- [ ] **Step 1: Delete the tab strip block and its masthead**

Delete this entire block from the `<main>` (the `<nav class="tabs">` element):

```svelte
		<nav class="tabs" aria-label="Timeline">
			{#each TABS as t (t)}
				<a href="/?tab={t}" aria-current={data.tab === t ? 'page' : undefined}>{t}</a>
			{/each}
		</nav>
```

Delete this block from `<aside class="tools">` (the masthead — brand and
toggle now live in the nav):

```svelte
		<header class="masthead">
			<a href="/">RSC</a>
			<ThemeToggle />
		</header>
```

Delete the now-unused `import ThemeToggle from '$lib/ThemeToggle.svelte'` line.

Delete the entire `<style>` block's `.tabs` / `.tabs a` / `.tabs a:hover` /
`.tabs a:focus-visible` / `.tabs a[aria-current='page']` rules (keep
`.danger-link`, which stays).

- [ ] **Step 2: Add the river heading where the tab strip was**

```svelte
		<div class="page-head" style="padding-inline:0">
			<span class="kicker">{data.tab} river</span>
			<h2>Everything from you and the people you follow</h2>
		</div>
```

- [ ] **Step 3: Split the byline, drop the avatar**

Replace the whole current byline block:

```svelte
					<div class="byline">
						<Avatar author={post.author} sourceName={post.sourceName} />
						<strong>{post.sourceName ?? post.author.displayName}</strong>
						{#if post.publisherId}
							<!-- v2 remote publisher: /p, not /u (which stays local-account only) -->
							<a class="handle" id="by-{post.id}" href="/p/{encodeURIComponent(post.publisherId)}">{post.author.displayName}</a>
						{:else if post.author.handle}
							<a class="handle" id="by-{post.id}" href="/u/{post.author.handle}">@{post.author.handle}</a>
						{/if}
						<span class="kind">{post.source}</span>
						<a class="permalink" href="/post/{post.id}"><time datetime={post.publishedAt}>{post.publishedAt.slice(0, 10)}</time></a>
						<EditedMarker {post} />
						<FeedIcon author={post.author} sourceName={post.sourceName} sourceFeedUrl={post.sourceFeedUrl} />
					</div>
```

with:

```svelte
					<div class="byline">
						<span class="kind">{post.source}</span>
						{#if post.source === 'remote' && post.url}<span class="source-host">{URL.parse(post.url)?.hostname}</span>{/if}
						<a class="permalink" href="/post/{post.id}"><time datetime={post.publishedAt}>{post.publishedAt.slice(0, 10)}</time></a>
						<EditedMarker {post} />
						<FeedIcon author={post.author} sourceName={post.sourceName} sourceFeedUrl={post.sourceFeedUrl} />
					</div>
					<div class="byline-name">
						<strong>{post.sourceName ?? post.author.displayName}</strong>
						{#if post.publisherId}
							<a class="handle" id="by-{post.id}" href="/p/{encodeURIComponent(post.publisherId)}">{post.author.displayName}</a>
						{:else if post.author.handle}
							<a class="handle" id="by-{post.id}" href="/u/{post.author.handle}">@{post.author.handle}</a>
						{/if}
					</div>
```

Delete the `import Avatar from '$lib/Avatar.svelte'` line — this page no
longer calls the component (Task 5 keeps the file itself, unused for now).

- [ ] **Step 4: Wrap the action row**

Currently the reply toggle / Reply / source / Edit / Remove sit as loose
siblings after `<PostBody {post} />`. Wrap that whole group (everything from
the `{#if post.replyCount}` block through the `{#if data.me?.isAdmin...}`
form, but stop before `{#if expanded[post.id]}`) in:

```svelte
					<div class="actions">
						<!-- existing ReplyToggle / Reply / source / Edit / Remove blocks, unchanged -->
					</div>
```

`<ReplyTree thread={expanded[post.id]} parentId={post.id} />` stays **outside**
this wrapper, as the last child of the `<li>`.

- [ ] **Step 5: Typecheck, svelte-check, and the page test suite**

```bash
npm run typecheck -w core && npm run check -w web
npm test -w web -- page.load page.actions thread.render
```
Expected: 0 type/check errors. `page.load`/`page.actions` should pass
unchanged (no server-side behavior touched). If `thread.render.test.ts`
asserts on `.byline`/`.masthead`/`.tabs` markup that moved, update its
selectors to match the new structure — do not change what it asserts about
*behavior* (reply nesting, highlight state).

- [ ] **Step 6: Visual check + commit**

Confirm in the browser: no duplicate brand, no old tab strip, byline reads
as two rows, no letter-avatar squares in the river.

```bash
git add web/src/routes/+page.svelte
git commit -m "design: river byline split, kicker heading, drop avatar"
```

---

### Task 5: `Avatar.svelte` — prepare for the roadmap, not re-wired yet

**Files:**
- Modify: `web/src/lib/Avatar.svelte`

**Interfaces:**
- Produces: `{ author: TimelineEntry['author']; sourceName?: string | null; imageUrl?: string | null }` props. No current caller passes `imageUrl` (feeds carry no avatar image today) — this task makes the component ready for when the roadmap's avatar-harvesting work lands a real URL, matching `FeedIcon.svelte`'s existing untrusted-URL scheme guard pattern. No task in this plan adds a new call site for it; Task 4 already removed its only current caller.

- [ ] **Step 1: Replace the component**

Current:

```svelte
<script lang="ts">
	import type { TimelineEntry } from './types'

	// Letter avatar — rss.chat's populateAvatar fallback (theme.js:349): an image
	// when one exists, else the initial. Feeds carry no avatar today (the channel
	// <image> is empty, no per-item element), so the initial IS the avatar; when
	// feeds start carrying one, this component grows an <img> branch.
	let {
		author,
		sourceName = null
	}: { author: TimelineEntry['author']; sourceName?: string | null } = $props()
	const name = $derived(sourceName ?? author.displayName)
	const initial = $derived((Array.from(name.trim())[0] ?? '?').toUpperCase())
</script>

<span class="avatar" aria-hidden="true">{initial}</span>
```

Replace with:

```svelte
<script lang="ts">
	import type { TimelineEntry } from './types'

	let {
		author,
		sourceName = null,
		imageUrl = null
	}: { author: TimelineEntry['author']; sourceName?: string | null; imageUrl?: string | null } = $props()
	const name = $derived(sourceName ?? author.displayName)
	const initial = $derived((Array.from(name.trim())[0] ?? '?').toUpperCase())
	const safe = (u: string | null) => (u && /^https?:\/\//i.test(u) ? u : null)
	const src = $derived(safe(imageUrl))
</script>

{#if src}
	<span class="avatar grayscale"><img {src} alt="" loading="lazy" /></span>
{:else}
	<span class="avatar" aria-hidden="true">{initial}</span>
{/if}
```

- [ ] **Step 2: Typecheck and svelte-check**

```bash
npm run typecheck -w core && npm run check -w web
```
Expected: 0 errors. No test file exists for this component today — none to update.

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/Avatar.svelte
git commit -m "design: Avatar gains the img/.grayscale branch for future feed avatars"
```

---

### Task 6: The author lens (`u/[handle]/+page.svelte`)

**Files:**
- Modify: `web/src/routes/u/[handle]/+page.svelte`
- Test: `web/src/routes/u/[handle]/u-page.test.ts`

**Interfaces:**
- Consumes: existing `data.handle`, `kind`, `groups` (unchanged by this task — Task 7 adds `data.stats`).
- Produces: no new exports.

- [ ] **Step 1: Replace the masthead with a page-head + kicker**

Current:

```svelte
<div class="lens">
	<header class="masthead">
		<a href="/">RSC</a>
		<ThemeToggle />
	</header>

	<div>
		<h1>
			@{data.handle}
			{#if kind}<span class="badge-kind">{kind}</span>{/if}
			{#if data.timeline[0]}<FeedIcon author={data.timeline[0].author} />{/if}
		</h1>
		<p class="subnav"><a href="/u/{data.handle}/following">following &amp; followers</a></p>
	</div>
```

Replace with:

```svelte
<div class="lens">
	<header class="page-head">
		<span class="kicker">Author lens{#if kind} · {kind}{/if}</span>
		<h1>@{data.handle}</h1>
		<p class="subnav">
			<a href="/u/{data.handle}/following">Following &amp; followers</a>
			{#if data.timeline[0]}<FeedIcon author={data.timeline[0].author} />{/if}
		</p>
	</header>
```

Delete the now-unused `import ThemeToggle from '$lib/ThemeToggle.svelte'` line.

- [ ] **Step 2: Date-keyed ruled sub-list for stacked replies**

Replace the folded `<ul class="replies">` block (inside
`{:else if stackOpen[post.id]}`):

```svelte
					{:else if stackOpen[post.id]}
						<ul class="replies">
							<!-- no per-card links: the whole stack is one conversation, and the
							     top card already carries the one "View conversation" that matters -->
							{#each others as p (p.id)}
								<li class="post" class:remote={p.source === 'remote'}>
									<div class="byline">
										{#if p.sourceName}<strong>{p.sourceName}</strong>{/if}
										<a class="permalink" href="/post/{p.id}"><time datetime={p.publishedAt}>{p.publishedAt.slice(0, 10)}</time></a>
										<EditedMarker post={p} />
									</div>
									{#if p.title}<h3 class="title">{p.title}</h3>{/if}
									<PostBody post={p} />
									{#if p.source === 'local' && data.me?.user.id === p.author.id}
										<a class="edit" href="/post/{p.id}/edit">Edit</a>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
```

with:

```svelte
					{:else if stackOpen[post.id]}
						<ul class="replies">
							{#each others as p (p.id)}
								<li>
									<span class="k"><time datetime={p.publishedAt}>{p.publishedAt.slice(5, 10)}</time></span>
									<div>
										{#if p.title}<h3 class="title">{p.title}</h3>{/if}
										<PostBody post={p} />
										{#if p.source === 'local' && data.me?.user.id === p.author.id}
											<a class="edit" href="/post/{p.id}/edit">Edit</a>
										{/if}
									</div>
								</li>
							{/each}
						</ul>
					{/if}
```

(`EditedMarker` is dropped from the sub-list rows per the new anatomy — the
date column already carries the timestamp; keep the import since the top
card's own byline still uses it.)

- [ ] **Step 3: Typecheck, svelte-check, and the page test**

```bash
npm run typecheck -w core && npm run check -w web
npm test -w web -- u-page
```
If `u-page.test.ts` asserts on `.masthead`/`.replies li .byline` markup that
moved, update its selectors — the grouping/threading logic under test is
unchanged.

- [ ] **Step 4: Visual check + commit**

```bash
git add web/src/routes/u/\[handle\]/+page.svelte
git commit -m "design: author-lens page-head kicker and date-keyed sub-list"
```

---

### Task 7: Author-lens stat row — real posts/following/followers counts

**Files:**
- Modify: `core/src/domain/repository.ts` (interface)
- Modify: `core/src/storage/sqlite.ts` (implementation)
- Modify: `core/src/domain/repository-contract.ts` (contract tests)
- Modify: `core/src/domain/service.ts` (thin passthroughs)
- Modify: `core/src/api/app.ts` (new route)
- Test: `core/test/api-follows.test.ts`
- Modify: `web/src/lib/api.ts`
- Modify: `web/src/routes/u/[handle]/+page.server.ts`
- Modify: `web/src/routes/u/[handle]/+page.svelte`
- Test: `web/src/routes/u/[handle]/u-page.test.ts`

**Investigation result (all three cells are cheap — ship all three):**
- **Following:** already free. `getFollowing`/`v2.publicFollowing(user.id)` (`core/src/api/app.ts:272-276`, backed by `core/src/domain/source-service.ts:44`) is the exact mechanism the `/following` page already uses — `.length` on its result is the count, no new query.
- **Followers:** `Repository.countFollowers(userId)` already exists (`core/src/domain/repository.ts:12`) and its `sqlite.ts:253` implementation is `SELECT COUNT(*) FROM follows WHERE followed_id = ?` — a single indexed aggregate on the live, currently-used `follows` table (not a retired v1 concept — `service.ts:114` calls it today in production, in the follow-removal orphan-cleanup path). Genuinely cheap.
- **Posts:** no existing count method, but `posts_author_pub_idx ON posts (author_id, published_at, id)` (`core/src/storage/sqlite.ts:1161`) already indexes exactly this lookup. Adding `countPostsByAuthor(authorId)` as `SELECT COUNT(*) FROM posts WHERE author_id = ?` is a single indexed aggregate, mirroring `countFollowers`'s existing shape exactly. `posts` is still the live table for local authors (confirmed: `deleteLocalAccount` in `core/src/logical/local.ts:252` reads it directly for cascade deletes), and `u/[handle]` is local-accounts-only (the reserved-handle redirect in `+page.server.ts` sends converted remote handles to `/p/:publisherId` instead), so this is the correct table for this page.

- [ ] **Step 1: Add `countPostsByAuthor` to the `Repository` interface**

In `core/src/domain/repository.ts`, add next to `countFollowers`:

```ts
  countFollowers(userId: string): Promise<number>
  countPostsByAuthor(authorId: string): Promise<number>
```

- [ ] **Step 2: Implement it in `sqlite.ts`**

Next to `countFollowers` (`core/src/storage/sqlite.ts:253`):

```ts
  async countFollowers(userId: string) {
    const r = await this.db.selectFrom('follows').select(({ fn }) => fn.countAll().as('n')).where('followed_id', '=', userId).executeTakeFirst()
    return Number(r?.n ?? 0)
  }
  async countPostsByAuthor(authorId: string) {
    const r = await this.db.selectFrom('posts').select(({ fn }) => fn.countAll().as('n')).where('author_id', '=', authorId).executeTakeFirst()
    return Number(r?.n ?? 0)
  }
```

- [ ] **Step 3: Write the failing contract tests**

In `core/src/domain/repository-contract.ts`, add after the `getPostsByAuthor` test (around line 134):

```ts
    test('countPostsByAuthor counts only that author\'s posts', async () => {
      const { repo, logical } = await makeRepoAndStore()
      const a = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      const b = await repo.createLocalUser({ handle: 'bob', displayName: 'Bob' })
      ;[1, 2, 3].forEach((i) => logical.createLocalPost({ author: a, content: `alice ${i}`, replyToId: null, now: `2026-01-0${i}T00:00:00.000Z` }))
      logical.createLocalPost({ author: b, content: 'bob 1', replyToId: null, now: '2026-01-09T00:00:00.000Z' })
      expect(await repo.countPostsByAuthor(a.id)).toBe(3)
      expect(await repo.countPostsByAuthor(b.id)).toBe(1)
      expect(await repo.countPostsByAuthor('no-such-id')).toBe(0)
    })

    test('countFollowers counts followed_id edges and reflects removeLocalFollow', async () => {
      const { repo, logical } = await makeRepoAndStore()
      const a = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      const b = await repo.createLocalUser({ handle: 'bob', displayName: 'Bob' })
      const c = await repo.createLocalUser({ handle: 'carol', displayName: 'Carol' })
      logical.addLocalFollow({ followerId: b.id, followedId: a.id, now: '2026-01-01T00:00:00.000Z' })
      logical.addLocalFollow({ followerId: c.id, followedId: a.id, now: '2026-01-02T00:00:00.000Z' })
      expect(await repo.countFollowers(a.id)).toBe(2)
      logical.removeLocalFollow({ followerId: b.id, followedId: a.id, now: '2026-01-03T00:00:00.000Z' })
      expect(await repo.countFollowers(a.id)).toBe(1)
    })
```

- [ ] **Step 4: Run the new tests, confirm they pass**

```bash
npm test -w core -- repository-contract
```
Expected: both new tests pass against the real sqlite-backed contract run (`core/test/sqlite-repository.test.ts` calls `runRepositoryContract`).

- [ ] **Step 5: Expose both through `Service`**

In `core/src/domain/service.ts`, add near `getPostsByAuthor` (around line 96-98):

```ts
    countFollowers(userId: string) {
      return repo.countFollowers(userId)
    },
    countPostsByAuthor(authorId: string) {
      return repo.countPostsByAuthor(authorId)
    },
```

- [ ] **Step 6: Add the route**

In `core/src/api/app.ts`, next to the existing `/users/:handle/follows` route (line 272-276):

```ts
  app.get('/users/:handle/stats', async (c) => {
    const user = await resolveUser(c.req.param('handle') ?? '')
    if (!user) return c.json({ error: 'unknown user' }, 404)
    const [posts, followers, following] = await Promise.all([
      service.countPostsByAuthor(user.id),
      service.countFollowers(user.id),
      v2.publicFollowing(user.id).then((f) => f.length)
    ])
    return c.json({ posts, followers, following })
  })
```

- [ ] **Step 7: Write the route test**

In `core/test/api-follows.test.ts`, following the file's existing `makeApp()`/`renameTo()` helpers:

```ts
test('GET /users/:handle/stats returns posts, followers and following counts', async () => {
	const { app, repo } = await makeApp()
	const cookie = await registeredSession(app, 'alice@test.example', repo)
	await renameTo(app, cookie, 'alice', 'Alice')
	const bobCookie = await registeredSession(app, 'bob@test.example', repo)
	await renameTo(app, bobCookie, 'bob', 'Bob')

	await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ content: 'hi' }) })
	await app.request('/me/follows', { method: 'POST', headers: { 'content-type': 'application/json', cookie: bobCookie }, body: JSON.stringify({ handle: 'alice' }) })

	const res = await app.request('/users/alice/stats')
	expect(res.status).toBe(200)
	expect(await res.json()).toEqual({ posts: 1, followers: 1, following: 0 })
})

test('GET /users/:handle/stats 404s for an unknown handle', async () => {
	const { app } = await makeApp()
	const res = await app.request('/users/nobody/stats')
	expect(res.status).toBe(404)
})
```

- [ ] **Step 8: Run core tests, typecheck**

```bash
npm test -w core
npm run typecheck -w core
```
Expected: all green, 0 type errors.

- [ ] **Step 9: Add the web API wrapper**

In `web/src/lib/api.ts`, alongside `getFollowing`:

```ts
export async function getHandleStats(f: typeof fetch, handle: string): Promise<{ posts: number; followers: number; following: number }> {
	const res = await f(`${base()}/users/${encodeURIComponent(handle)}/stats`)
	if (!res.ok) throw new Error(await errorMessage(res, `stats ${res.status}`))
	return res.json()
}
```

- [ ] **Step 10: Wire into `+page.server.ts`**

In `web/src/routes/u/[handle]/+page.server.ts`, add a non-blocking `stats`
fetch (a stats failure must not down the whole page, same pattern as the
home page's `getPeers(fetch).catch(() => [])`):

```ts
import { getHandleStats } from '$lib/api'
```

```ts
export const load: PageServerLoad = async ({ fetch, params, url }) => {
	const before = url.searchParams.get('before') ?? undefined
	const isFirstPage = !before
	const stats = await getHandleStats(fetch, params.handle).catch(() => null)
	try {
		const publisherId = await reservedPublisher(fetch, params.handle)
		if (publisherId) throw redirect(308, `/p/${publisherId}`)
		const { entries: timeline, nextCursor } = await getLogicalRiverOrEmpty(fetch, { before, author: params.handle })
		return { handle: params.handle, timeline: enrichEntries(timeline), nextCursor, isFirstPage, stats }
	} catch (e) {
		if (isRedirect(e)) throw e
		return { handle: params.handle, timeline: [], nextCursor: null, isFirstPage, coreDown: true, stats }
	}
}
```

- [ ] **Step 11: Render the row in `+page.svelte`**

Directly after the `<header class="page-head">` block from Task 6:

```svelte
{#if data.stats}
	<dl class="lens-stats">
		<div><dd class="n">{data.stats.posts}</dd><dt class="k">Posts</dt></div>
		<div><dd class="n">{data.stats.following}</dd><dt class="k">Following</dt></div>
		<div><dd class="n">{data.stats.followers}</dd><dt class="k">Followers</dt></div>
	</dl>
{/if}
```

- [ ] **Step 12: Update `u-page.test.ts`, typecheck, run web tests**

`web/src/routes/u/[handle]/+page.server.ts`'s load signature changed
(added `fetch`-based `getHandleStats` call before the existing try block) —
any existing test mocking `fetch` for this load now needs to also answer a
`GET .../stats` call. Check `u-page.test.ts`'s fetch mock and add a branch
returning `{ posts: 0, followers: 0, following: 0 }` (or per-test values
where the test cares) for any URL containing `/stats`.

```bash
npm run typecheck -w core && npm run check -w web
npm test -w web -- u-page
```

- [ ] **Step 13: Visual check + commit**

```bash
git add core/src/domain/repository.ts core/src/storage/sqlite.ts core/src/domain/repository-contract.ts core/src/domain/service.ts core/src/api/app.ts core/test/api-follows.test.ts web/src/lib/api.ts web/src/routes/u/\[handle\]/+page.server.ts web/src/routes/u/\[handle\]/+page.svelte web/src/routes/u/\[handle\]/u-page.test.ts
git commit -m "feat: real posts/following/followers counts for the author-lens stat row"
```

---

### Task 8: Mobile menu, 3-state theme toggle, and the composer/subscribe fix

**Files:**
- Modify: `web/src/routes/+layout.server.ts`
- Modify: `web/src/routes/+layout.svelte`
- Modify: `web/src/lib/ThemeToggle.svelte`

**Interfaces:**
- Consumes: `data.me`, `data.tab` from layout data (Task 3); `ComposerDialog` (`draftKey`, `action`, `title`, `submitLabel`, `placeholder` props, unchanged, imported directly into `+layout.svelte` too).
- Produces: `LayoutServerLoad` gains `subscribeCommandId: string`. `ThemeToggle.svelte` gains a `variant?: 'icon' | 'segmented'` prop (default `'icon'`, so every other existing call site is unaffected).

**Resolved scope decision (composing is home-page-only today):** `<ComposerDialog>`
and the subscribe form only exist in `+page.svelte`'s tools rail today — there
is no cross-route "compose from anywhere" capability on desktop either. A
SvelteKit `+layout.svelte` cannot receive a named snippet back from its child
`+page.svelte` (the `children` prop *is* the page's entire rendered output —
routing composition, not a component slot a page can subdivide), so the panel
can't "borrow" the page's own composer instance. The behavior-preserving fix:
render a **second, independent instance** of the same `<ComposerDialog>` and
subscribe form directly in `+layout.svelte`'s mobile panel, sharing the same
`draftKey="compose"` (so both instances stay in sync via the shared
`localStorage` draft — never both visible at once, CSS picks one per
viewport), and gate the whole group to the home page only
(`page.url.pathname === '/'`) — exactly matching where composing already
works today. This is not a new capability, just the existing one made
reachable at the width where `.tools` is `display: none`.

- [ ] **Step 1: Three-state `ThemeToggle`**

Current `web/src/lib/ThemeToggle.svelte`:

```svelte
<script lang="ts">
	import { browser } from '$app/environment';

	function toggle() {
		const root = document.documentElement;
		const dark = root.dataset.theme
			? root.dataset.theme === 'dark'
			: matchMedia('(prefers-color-scheme: dark)').matches;
		const next = dark ? 'light' : 'dark';
		root.dataset.theme = next;
		localStorage.theme = next;
	}
</script>

{#if browser}
	<button type="button" class="theme-toggle" onclick={toggle} aria-label="Toggle light/dark theme">
		<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
			<circle cx="12" cy="12" r="9" />
			<path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
		</svg>
	</button>
{/if}
```

Replace with (keeps the existing icon button as the default variant for
every current call site — nav bar, `admin/+layout.svelte`, `post/[id]`,
`u/[handle]` mastheads; adds a segmented control only where the mobile menu
opts in):

```svelte
<script lang="ts">
	import { browser } from '$app/environment';

	let { variant = 'icon' }: { variant?: 'icon' | 'segmented' } = $props();

	type Mode = 'system' | 'light' | 'dark'
	const current = (): Mode => {
		const t = browser ? localStorage.theme : undefined
		return t === 'dark' || t === 'light' ? t : 'system'
	}
	let mode = $state<Mode>(browser ? current() : 'system')

	function apply(next: Mode) {
		mode = next
		if (next === 'system') {
			delete localStorage.theme
			delete document.documentElement.dataset.theme
		} else {
			localStorage.theme = next
			document.documentElement.dataset.theme = next
		}
	}

	// Icon-variant toggle: binary, same behavior as before (never touches "system").
	function toggle() {
		const root = document.documentElement;
		const dark = root.dataset.theme
			? root.dataset.theme === 'dark'
			: matchMedia('(prefers-color-scheme: dark)').matches;
		apply(dark ? 'light' : 'dark');
	}
</script>

{#if browser}
	{#if variant === 'segmented'}
		<div class="theme-segmented" role="group" aria-label="Theme">
			{#each (['system', 'light', 'dark'] as const) as m (m)}
				<button type="button" class:active={mode === m} onclick={() => apply(m)}>{m}</button>
			{/each}
		</div>
	{:else}
		<button type="button" class="theme-toggle" onclick={toggle} aria-label="Toggle light/dark theme">
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
				<circle cx="12" cy="12" r="9" />
				<path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
			</svg>
		</button>
	{/if}
{/if}
```

Add a minimal `.theme-segmented` style to `app.css` (three flush buttons, one
row, active one filled with the accent — reuse the existing `.btn`/label
patterns, do not invent new tokens):

```css
.theme-segmented { display: flex; border: 1px solid var(--color-divider); }
.theme-segmented button {
	flex: 1; padding: var(--space-xs) var(--space-sm); background: none; border: 0;
	color: var(--color-secondary); text-transform: uppercase; font-size: 11px; letter-spacing: 0.08em; font-weight: 800;
	cursor: pointer;
}
.theme-segmented button.active { background: var(--color-accent); color: var(--color-on-accent); }
.theme-segmented button + button { border-left: 1px solid var(--color-divider); }
```

- [ ] **Step 2: Mint a `subscribeCommandId` in the layout load**

`+page.server.ts` already mints one per render for its own subscribe form's
no-JS resubmit idempotency (`subscribeCommandId: crypto.randomUUID()`). The
layout's own duplicate subscribe form (Step 3) needs an independent one —
same reasoning as Task 3's duplicated `resolveTab` call, a cheap per-request
value, not shared state. In `web/src/routes/+layout.server.ts`, add to
**every** return branch (the no-session, success, and catch branches added
in Task 3):

```ts
export const load: LayoutServerLoad = async ({ fetch, cookies, url }) => {
	const mailEnabled = await getMailEnabled(fetch)
	const tab = (me: Parameters<typeof resolveTab>[1]) => resolveTab(url.searchParams.get('tab'), me)
	if (!hasSession(cookies)) return { me: null, mailEnabled, tab: tab(null), subscribeCommandId: crypto.randomUUID() }
	try {
		const me = await getMe(authedFetch(fetch, url.origin, cookieHeader(cookies)))
		return { me, mailEnabled, tab: tab(me), subscribeCommandId: crypto.randomUUID() }
	} catch {
		return { me: null, mailEnabled, tab: tab(null), subscribeCommandId: crypto.randomUUID() }
	}
}
```

(This is Task 3's `load` function with one new field — `subscribeCommandId`
— added to all three returns; everything else is unchanged from Task 3.)

Update `layout.load.test.ts`'s three `toEqual` assertions (from Task 3) to
also expect a `subscribeCommandId` field — since it's a fresh UUID each
call, assert its shape rather than an exact value:

```ts
	const result = await load({ fetch, cookies: { getAll: () => [] }, url: new URL('http://x/') } as never)
	expect(result).toMatchObject({ me: null, mailEnabled: true, tab: 'public' })
	expect((result as { subscribeCommandId: string }).subscribeCommandId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
```
(Apply the same pattern to all three tests — switch `toEqual` to
`toMatchObject` for the fixed fields, add the separate UUID-shape assertion.)

- [ ] **Step 3: Wrap the nav in the mobile `<details>` menu**

In `+layout.svelte`, replace the `<nav class="nav">` block from Task 3 with:

```svelte
<details class="nav-menu">
	<nav class="nav" aria-label="Timeline">
		<a class="nav-brand" href="/">RSC</a>
		{#each TABS as t (t)}
			<a href="/?tab={t}" aria-current={page.url.pathname === '/' && data.tab === t ? 'page' : undefined}>{t}</a>
		{/each}
		{#if page.url.pathname === '/'}<a class="spacer btn btn-primary" href="#compose">New post</a>{/if}
		<summary class="nav-menu-toggle">Menu</summary>
	</nav>

	<div class="nav-menu-panel">
		<div class="nav-menu-group nav-menu-rivers">
			<h6>Rivers</h6>
			{#each TABS as t (t)}
				<a href="/?tab={t}" aria-current={data.tab === t ? 'page' : undefined}>
					{t}<span class="n">{data.tab === t ? 'here' : ''}</span>
				</a>
			{/each}
		</div>

		{#if page.url.pathname === '/' && data.me && !data.me.isAnonymous}
			<div class="nav-menu-group" id="compose">
				<h6>New post</h6>
				<ComposerDialog draftKey="compose" action="?tab={data.tab}&/compose" title="New post" submitLabel="Post" placeholder="what's happening?" />
			</div>
			<div class="nav-menu-group">
				<h6>Subscribe to a feed</h6>
				<form method="POST" action="?tab={data.tab}&/subscribe" class="add-remote">
					<label class="visually-hidden" for="menu-sub-url">Feed URL</label>
					<input id="menu-sub-url" name="url" type="url" placeholder="https://their-site.com/feed.xml" required />
					<input type="hidden" name="commandId" value={data.subscribeCommandId} />
					<button>Subscribe</button>
				</form>
			</div>
		{/if}

		<div class="nav-menu-group">
			<h6>Signed in</h6>
			{#if data.me}
				<div class="nav-menu-identity">{data.me.user.displayName}</div>
				<div class="nav-menu-list">
					<a href="/u/{data.me.user.handle}">Your lens</a>
					<a href="/settings">Settings</a>
					{#if data.me.isAdmin}<a href="/admin">Admin</a>{/if}
					{#if !data.me.isAnonymous}<a class="destructive" href="/login?/logout">Log out</a>{/if}
				</div>
			{:else}
				<p class="auth-note"><a href="/login">Log in</a> · <a href="/register">Register</a></p>
			{/if}
		</div>

		<div class="nav-menu-group"><ThemeToggle variant="segmented" /></div>
	</div>
</details>
```

Add `import ComposerDialog from '$lib/ComposerDialog.svelte'` to
`+layout.svelte`'s script block.

Note the **corrections from the handoff's snippet**: (1) "New post" and the
compose/subscribe panel groups only render on `/` — composing has never
worked from any other route, so this reflects existing behavior rather than
inventing cross-route form-action plumbing (an absolute-path `action="/?/compose"`
posting to the home route from elsewhere is a bigger, separate feature, not
part of this visual migration — logged as a follow-up in Task 12). (2) The
subscribe group renders the **real** subscribe form (not the handoff's
static "Your subscriptions"/"Import OPML"/"Export OPML" text links, which
point to pages, not actions). "New post" is a same-page anchor (`#compose`)
into the panel; native anchor navigation auto-expands an ancestor closed
`<details>` to reveal its target, so this works with JavaScript off too (no
`aria-expanded` management needed, same as the menu's own `<summary>`
mechanism).

`Signed-in` is adjusted from the handoff's snippet to handle the guest case
(`data.me` can be `null`) and to only show "Log out" for a non-anonymous
session, matching the identity-bar's existing guest/anonymous/registered
three-way branch in this same file.

- [ ] **Step 4: Typecheck, svelte-check**

```bash
npm run typecheck -w core && npm run check -w web
```

- [ ] **Step 5: Manual check — no-JS**

Disable JavaScript in the browser tool, reload at a narrow viewport (375px).
Confirm: "Menu" `<summary>` opens the panel with no JS, "New post" jumps to
and reveals the composer's plain-textarea fallback, the segmented theme
control's three buttons are plain forms-free buttons that still need JS to
act (document this as an acceptable no-JS gap **only if** true — if it turns
out `apply()` requires JS entirely with no graceful no-JS default, note that
explicitly: the toggle already required JS before this change, so this is
not a regression, just confirm it isn't).

- [ ] **Step 6: Commit**

```bash
git add web/src/routes/+layout.server.ts web/src/routes/+layout.svelte web/src/routes/layout.load.test.ts web/src/lib/ThemeToggle.svelte web/src/app.css
git commit -m "design: mobile menu, 3-state theme toggle, working New-post/subscribe in panel"
```

---

### Task 9: Conversation highlight — "You are here"

**Files:**
- Modify: `web/src/routes/post/[id]/+page.svelte`
- Modify: `web/src/lib/ReplyTree.svelte`
- Test: `web/src/routes/post/[id]/thread.render.test.ts`

**Interfaces:** None new — purely additive markup keyed off existing
`highlightId`/`data.postId` comparisons already used for the `class:highlight` binding.

- [ ] **Step 1: Delete the `.danger-link` style block from `post/[id]/+page.svelte`**

Delete the whole `<style>` block at the end of the file (`.danger-link` and
`.danger-link:hover` — both now come from `app.css`).

- [ ] **Step 2: "You are here" on the root post**

In the root `<li>`'s byline (the block with `class:highlight={root.id === data.postId}`), add the marker right after the permalink/`EditedMarker`:

```svelte
					<EditedMarker post={root} />
					{#if root.id === data.postId}<span class="here">You are here</span>{/if}
```

- [ ] **Step 3: "You are here" on a matching reply**

In `web/src/lib/ReplyTree.svelte`, the reply byline currently ends with
`<EditedMarker post={reply} />`. Add, immediately after it:

```svelte
					<EditedMarker post={reply} />
					{#if reply.id === highlightId}<span class="here">You are here</span>{/if}
```

- [ ] **Step 4: A minimal `.here` style, if `app.css` doesn't already define one**

```bash
grep -n "\.here\b" web/src/app.css
```
If absent, add next to the `.kind`/label styles:

```css
.here { font-size: 11px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; color: var(--color-accent); }
```

- [ ] **Step 5: Typecheck, svelte-check, run the thread test**

```bash
npm run typecheck -w core && npm run check -w web
npm test -w web -- thread.render
```
Update any assertion counting byline children if the new span shifts a
`querySelectorAll` index — the highlight *logic* under test doesn't change.

- [ ] **Step 6: Commit**

```bash
git add web/src/routes/post/\[id\]/+page.svelte web/src/lib/ReplyTree.svelte web/src/app.css
git commit -m "design: You-are-here marker on the highlighted post, danger-link cleanup"
```

---

### Task 10: Admin polish

**Files:**
- Modify: `web/src/routes/admin/+layout.svelte`
- Modify: `web/src/routes/admin/+page.svelte`

**Interfaces:** None — purely visual, no data shape changes.

- [ ] **Step 1: `admin/+layout.svelte` — delete the style block and the duplicate masthead**

Delete the entire `<style>` block (the `.admin-nav` rules and its soft
`box-shadow` focus override both now come from `app.css`).

Delete the masthead — the root nav (Task 3) already carries brand and theme
toggle, so admin pages would otherwise show both twice, the same duplication
Task 4 fixed on the home page:

```svelte
	<header class="masthead">
		<a href="/">RSC</a>
		<ThemeToggle />
	</header>
```

Delete the now-unused `import ThemeToggle from '$lib/ThemeToggle.svelte'` line.

- [ ] **Step 2: `admin/+page.svelte` — stat cards become a ruled row**

Replace the `<style>` block's `.stat-grid`/`.stat-card` rules:

```css
	.stat-grid {
		margin: 0;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
		gap: var(--space-md);
	}

	.stat-card {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: 12px;
		padding: var(--space-md);
	}

	.stat-card dt {
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-secondary);
	}

	.stat-card dd {
		margin: var(--space-xs) 0 0;
		font-family: var(--font-heading);
		font-size: 2rem;
		line-height: 1.1;
	}
```

with:

```css
	.stat-grid {
		margin: 0;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
		gap: 0;
		border-top: 2px solid var(--color-divider);
		border-bottom: 2px solid var(--color-divider);
	}

	.stat-card {
		padding: var(--space-md);
		border-left: 1px solid var(--color-border);
	}

	.stat-card:first-child {
		border-left: 0;
	}

	.stat-card dt {
		font-size: 11px;
		font-weight: 800;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--color-secondary);
	}

	.stat-card dd {
		margin: var(--space-xs) 0 0;
		font-family: var(--font-heading);
		font-weight: 800;
		font-size: 28px;
		line-height: 1.1;
	}
```

`admin/feeds/+page.svelte` needs **no changes** — its page-local `<style>`
block already uses only 1px/2px borders and no hardcoded radius or shadow, so
it inherits the ruled look entirely from Task 2's global stylesheet swap.
Confirmed by reading the file: no `border-radius`, no `box-shadow` anywhere
in its styles.

- [ ] **Step 3: Typecheck, svelte-check, visual check**

```bash
npm run typecheck -w core && npm run check -w web
```
Visually confirm `/admin` and `/admin/feeds` in the browser: no rounded
stat cards, no duplicate brand on any admin page, focus ring on admin nav
links is the accent outline, not a soft glow.

- [ ] **Step 4: Commit**

```bash
git add web/src/routes/admin/+layout.svelte web/src/routes/admin/+page.svelte
git commit -m "design: admin masthead dedup, ruled overview stat row"
```

---

### Task 11: Tables — subscriptions and admin users

**Files:**
- Modify: `web/src/routes/u/[handle]/following/+page.svelte`
- Modify: `web/src/routes/admin/users/+page.svelte`

**Interfaces:** None — same data (`FollowRow[]`, admin `users` list),
restructured markup only. `web/src/routes/u/[handle]/following/following.actions.test.ts`
was confirmed to assert only on form-action behavior, not DOM — safe.
`web/src/routes/admin/users` has no existing render test.

- [ ] **Step 1: Following page — subscriptions list becomes a table**

Replace the `<ul class="following-list">` block in
`web/src/routes/u/[handle]/following/+page.svelte`:

```svelte
			<ul class="following-list">
				{#each data.rows ?? [] as row (row.kind === 'local' ? row.handle : row.sourceId)}
					<li>
						{#if row.kind === 'local'}
							<span><a href="/u/{row.handle}">@{row.handle}</a> <span class="badge-kind">local</span></span>
							<form method="POST" action={data.isOwner ? '?/unfollow' : '?/follow'} class="unfollow-form" class:follow-row={!data.isOwner}>
								<input type="hidden" name="target" value={row.handle} />
								<button>{data.isOwner ? 'Unfollow' : 'Follow'}</button>
							</form>
						{:else}
							<!-- Only the owner's own projection can carry pending, and it
							     says nothing about why — no governance state reaches here. -->
							<span><a href={row.url} rel="noreferrer">{row.label}</a>{#if row.pending}<span class="badge-kind">awaiting review</span>{/if}</span>
							{#if data.isOwner}
								<form method="POST" action="?/unsubscribe" class="unfollow-form">
									<input type="hidden" name="sourceId" value={row.sourceId} />
									<input type="hidden" name="commandId" value={row.commandId} />
									<button>Unsubscribe</button>
								</form>
							{/if}
						{/if}
					</li>
				{/each}
			</ul>
```

with:

```svelte
			<table class="table table-records">
				<thead>
					<tr><th>Label</th><th>Kind</th><th>State</th><th>Action</th></tr>
				</thead>
				<tbody>
					{#each data.rows ?? [] as row (row.kind === 'local' ? row.handle : row.sourceId)}
						<tr>
							<td data-label="Label">{#if row.kind === 'local'}<a href="/u/{row.handle}">@{row.handle}</a>{:else}<a href={row.url} rel="noreferrer">{row.label}</a>{/if}</td>
							<td data-label="Kind">{row.kind === 'local' ? 'local' : 'source'}</td>
							<td data-label="State">{row.kind === 'source' && row.pending ? 'awaiting review' : '—'}</td>
							<td data-label="Action">
								{#if row.kind === 'local'}
									<form method="POST" action={data.isOwner ? '?/unfollow' : '?/follow'}>
										<input type="hidden" name="target" value={row.handle} />
										<button>{data.isOwner ? 'Unfollow' : 'Follow'}</button>
									</form>
								{:else if data.isOwner}
									<form method="POST" action="?/unsubscribe">
										<input type="hidden" name="sourceId" value={row.sourceId} />
										<input type="hidden" name="commandId" value={row.commandId} />
										<button>Unsubscribe</button>
									</form>
								{:else}
									—
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
```

- [ ] **Step 2: Admin users page becomes a table**

Replace the whole `<ul class="user-list">` block **and** delete the entire
`<style>` block (all of it — `.user-list`, `.user-head`, `.user-handle`,
`.user-meta`, `.user-feed`, `.delete-form`, `.danger` — the `.table` classes
in `app.css` replace every one of these) in
`web/src/routes/admin/users/+page.svelte`:

```svelte
	<table class="table table-records">
		<thead>
			<tr><th>Handle</th><th>Kind</th><th>Name</th><th>Verified</th><th>Joined</th><th>Feed</th><th>Action</th></tr>
		</thead>
		<tbody>
			{#each data.users as u (u.handle)}
				<tr>
					<td data-label="Handle">@{u.handle}</td>
					<td data-label="Kind">{u.kind}</td>
					<td data-label="Name">{u.displayName}</td>
					<td data-label="Verified">{verified(u.emailVerified)}</td>
					<td data-label="Joined">{formatDate(u.createdAt)}</td>
					<td data-label="Feed">{u.feedUrl ?? '—'}</td>
					<td data-label="Action">
						{#if u.kind === 'local'}
							<form
								method="POST"
								action="?/deleteUser"
								use:enhance={confirmSubmit(`Delete @${u.handle} and all their posts? This can't be undone.`)}
							>
								<input type="hidden" name="handle" value={u.handle} />
								<button type="submit">Delete account</button>
							</form>
						{:else}
							—
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
```

- [ ] **Step 3: Typecheck, svelte-check, run tests**

```bash
npm run typecheck -w core && npm run check -w web
npm test -w web -- following.actions
```
Expected: unaffected (form-action tests, not markup).

- [ ] **Step 4: Visual + responsive check**

In the browser tool, view `/u/<handle>/following` and `/admin/users` at
1440px (full table) and below 700px (should collapse to stacked records with
`data-label` printed as the row's field labels, per `app.css`'s
`.table-records` breakpoint rule).

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/u/\[handle\]/following/+page.svelte web/src/routes/admin/users/+page.svelte
git commit -m "design: subscriptions and admin-users lists become real tables"
```

---

### Task 12: Log the skipped optional item

**Files:**
- Modify: `docs/superpowers/ideas.md`

- [ ] **Step 1: Append two entries**

Follow the existing format in that file (name · mechanism · why-novel ·
grounding · tradeoff · status).

1. Replacing the meta rail's rivers panel with a sources/OPML list on the
   desktop timeline (svelte-changes.md §2f in the Modernist handoff) —
   optional in the source doc, skipped from this migration since it's a
   feature reorg, not a visual change; status: backlog.
2. Compose-from-any-route: the mobile menu's "New post"/subscribe group
   (Task 8) only appears on the home page today because that's the only
   route with a `compose`/`subscribe` form action — a real cross-route
   compose capability would need an absolute-path form action plus a
   post-submit redirect back to the originating page; status: backlog.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/ideas.md
git commit -m "docs: log rivers-panel-to-sources swap as a follow-up idea"
```

---

### Task 13: Full verification pass

**Files:** none (verification only; fixes land wherever a real break is found).

- [ ] **Step 1: Full test suites**

```bash
npm test -w core
npm test -w web
```
Expected: all green. Any failure from markup that legitimately moved (listed
in the handoff: `thread.render.test.ts`, `history.render.test.ts`,
`ReplyToggle.test.ts`, `ReplyContext.test.ts`, `*.load`/`*.actions` tests) —
update the assertion to the new structure. Any failure that traces to
*different data or behavior* is a bug introduced by an earlier task — go fix
that task, don't adjust the test to match broken behavior.

- [ ] **Step 2: Full typecheck**

```bash
npm run typecheck -w core
npm run check -w web
```
Expected: 0 errors, 0 warnings.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "test: update markup assertions for the Modernist migration"
```
(Only if Step 1 required changes — skip this commit if everything was
already green.)

---

### Task 14: Manual QA against the checklist (no code changes)

Using the browser tool against the worktree's dev server:

- [ ] Walk `design-system/rsc/MASTER.md`'s **Pre-Delivery Checklist** item by
      item (from Task 1's landed file) and record pass/fail for each.
- [ ] At 375px, 768px, 1024px, 1440px, both themes: no rounded corners, no
      pill badges, 2px/1px rules present and not softened, accent used at the
      documented weight (chrome vs paragraph vs hover), dark hover steps
      lighter.
- [ ] Disable JavaScript: tabs still navigate, composer falls back to plain
      textarea (both desktop tools rail and mobile panel), mobile menu opens
      via native `<details>`, "New post" anchor reveals the composer.
- [ ] `prefers-reduced-motion: reduce` — confirm no transition still animates.
- [ ] Local vs remote: confirm the 2px rule colour **and** the label text
      differ, and the label names the source host on remote rows.
- [ ] Trigger an SSE prepend (post from another session or curl) and confirm
      no layout shift.
- [ ] Report findings back to the user — this is a checkpoint, not a commit.

---

### Task 15: Whole-branch review

- [ ] Dispatch a whole-branch review on the most capable model available,
      covering every commit from Task 1 through Task 14's fixes.
- [ ] Dispatch a ponytail-review pass on the same diff (over-engineering
      lens — this plan already made several scope-reduction calls; confirm
      none of them left dead code or an unused abstraction behind, e.g. the
      `ThemeToggle` `variant` prop should have exactly two call sites using
      `'segmented'` and every other call site implicit-defaulting to `'icon'`,
      not a config value invented for a hypothetical third variant).
- [ ] Fold any findings, re-run Task 13's verification, then hand back to the
      user for the merge/PR/cleanup decision — nothing merges to `main`
      without explicit approval.
