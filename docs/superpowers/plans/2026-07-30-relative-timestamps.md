# Relative Timestamps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bare static date (`2026-07-30`) shown on every post with a live, human relative timestamp ("2 min ago", ticking up while the page stays open), falling back to an absolute date past 7 days — frontend-only, no core/API changes.

**Architecture:** A pure, unit-testable formatting module (`web/src/lib/relative-time.ts`) backs a small Svelte component (`web/src/lib/RelativeTime.svelte`) that renders a `<time>` element, computing its label once at render time (correct with no JS, since `$effect` never runs during SSR) and then self-rescheduling a `setTimeout` client-side to keep it ticking at an age-appropriate cadence. All 7 existing call sites across 6 files swap their inline `<time datetime={x.publishedAt}>{x.publishedAt.slice(0, 10)}</time>` for `<RelativeTime datetime={x.publishedAt} />`.

**Tech Stack:** SvelteKit (Svelte 5 runes), native `Intl.RelativeTimeFormat`/`Intl.DateTimeFormat` (no new dependency), Vitest (`render` from `svelte/server` for SSR component tests).

## Global Constraints

- No-JS-safe: the label must be correct and readable with JavaScript disabled — this falls out naturally since `$effect` doesn't run during SSR (confirmed via the `svelte-runes` skill), so the initial `$state(...)` computation IS the no-JS render; no `if (browser)` guard needed.
- No new dependency — `Intl.RelativeTimeFormat`/`Intl.DateTimeFormat` are native (every supported browser + Node); do not add a date library.
- `$effect` is only for the client-side ticking timer (a legitimate "subscriptions/intervals" use case per the svelte-runes skill), with a returned cleanup function clearing the pending `setTimeout`. Do not use `$effect` to compute the label itself — that's a plain function call, not a derived/effect concern.
- Every file this touches uses Svelte 5 rune syntax (`$props()`, `$state()`, `$effect()`) — no `export let`, no `on:click`-style legacy directives.
- Match each touched file's existing import convention exactly: the 5 route files import via `$lib/RelativeTime.svelte`; `web/src/lib/ReplyTree.svelte` (already inside `$lib`) imports via the relative `./RelativeTime.svelte`.
- Spec: `docs/superpowers/specs/2026-07-30-relative-timestamps-design.md` (rev 1).

---

### Task 1: `relative-time.ts` formatting module + `RelativeTime.svelte` component

**Files:**
- Create: `web/src/lib/relative-time.ts`
- Test: `web/src/lib/relative-time.test.ts`
- Create: `web/src/lib/RelativeTime.svelte`
- Test: `web/src/lib/RelativeTime.render.test.ts`

**Interfaces:**
- Produces: `relativeLabel(iso: string, nowMs: number): string`, `absoluteLabel(iso: string): string`, `nextDelayMs(iso: string, nowMs: number): number | null` (all exported from `relative-time.ts`) — consumed only by `RelativeTime.svelte` in this task. `RelativeTime.svelte` takes one prop, `datetime: string` (an ISO 8601 string) — consumed by Task 2's 7 call sites.

- [ ] **Step 1: Write the failing unit tests for the formatting module**

Create `web/src/lib/relative-time.test.ts`:

```ts
import { test, expect } from 'vitest'
import { relativeLabel, absoluteLabel, nextDelayMs } from './relative-time.ts'

const NOW = Date.parse('2026-07-30T12:00:00.000Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

test('relativeLabel: under 5 seconds reads "now"', () => {
	expect(relativeLabel(iso(2_000), NOW)).toBe('now')
})

test('relativeLabel: seconds bucket', () => {
	expect(relativeLabel(iso(30_000), NOW)).toBe('30 seconds ago')
})

test('relativeLabel: minutes bucket', () => {
	expect(relativeLabel(iso(2 * 60_000), NOW)).toBe('2 minutes ago')
	expect(relativeLabel(iso(59 * 60_000), NOW)).toBe('59 minutes ago')
})

test('relativeLabel: hours bucket', () => {
	expect(relativeLabel(iso(3 * 3_600_000), NOW)).toBe('3 hours ago')
	expect(relativeLabel(iso(23 * 3_600_000), NOW)).toBe('23 hours ago')
})

test('relativeLabel: days bucket, "yesterday" for exactly 1 day', () => {
	expect(relativeLabel(iso(24 * 3_600_000), NOW)).toBe('yesterday')
	expect(relativeLabel(iso(6 * 24 * 3_600_000), NOW)).toBe('6 days ago')
})

test('relativeLabel: 7 days or more falls back to an absolute date', () => {
	const sevenDaysAgo = iso(7 * 24 * 3_600_000)
	expect(relativeLabel(sevenDaysAgo, NOW)).toBe(absoluteLabel(sevenDaysAgo))
	expect(relativeLabel(sevenDaysAgo, NOW)).not.toContain('ago')
})

test('absoluteLabel: full date + time', () => {
	expect(absoluteLabel('2026-07-30T12:00:00.000Z')).toBe(absoluteLabel('2026-07-30T12:00:00.000Z'))
	expect(absoluteLabel('2026-07-30T12:00:00.000Z')).toMatch(/2026/)
})

test('nextDelayMs: 15s cadence under 2 minutes old', () => {
	expect(nextDelayMs(iso(30_000), NOW)).toBe(15_000)
})

test('nextDelayMs: 60s cadence under 1 hour old', () => {
	expect(nextDelayMs(iso(10 * 60_000), NOW)).toBe(60_000)
})

test('nextDelayMs: 5 minute cadence under 1 day old', () => {
	expect(nextDelayMs(iso(5 * 3_600_000), NOW)).toBe(5 * 60_000)
})

test('nextDelayMs: null (stop ticking) at 7 days or more', () => {
	expect(nextDelayMs(iso(7 * 24 * 3_600_000), NOW)).toBeNull()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/lib/relative-time.test.ts`
Expected: FAIL — `Cannot find module './relative-time.ts'` (the module doesn't exist yet)

- [ ] **Step 3: Implement `relative-time.ts`**

Create `web/src/lib/relative-time.ts`:

```ts
const RTF = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
const ABSOLUTE = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' })
const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS

// The full absolute date/time — always available (the <time> element's
// title attribute), regardless of which relative bucket is shown.
export function absoluteLabel(iso: string): string {
	return ABSOLUTE.format(new Date(Date.parse(iso)))
}

// Bucketed relative text: "now" under 5s, then seconds/minutes/hours/days
// via Intl.RelativeTimeFormat (locale-correct pluralization, "yesterday"
// for exactly 1 day via numeric:'auto'), falling back to an absolute date
// at 7 days or more — "3 months ago" reads worse than a date for anything
// that old, and this threshold matches the common GitHub/Twitter convention.
export function relativeLabel(iso: string, nowMs: number): string {
	const diffMs = nowMs - Date.parse(iso)
	if (diffMs >= WEEK_MS) return absoluteLabel(iso)
	const sec = Math.round(diffMs / 1000)
	if (sec < 5) return 'now'
	if (sec < 60) return RTF.format(-sec, 'second')
	const min = Math.round(diffMs / MINUTE_MS)
	if (min < 60) return RTF.format(-min, 'minute')
	const hr = Math.round(diffMs / HOUR_MS)
	if (hr < 24) return RTF.format(-hr, 'hour')
	const day = Math.round(diffMs / DAY_MS)
	return RTF.format(-day, 'day')
}

// How long until this label next needs recomputing, in ms — null once it's
// showing an absolute date (7+ days old), since that label never changes.
// Cadence adapts to age so a stale tab left open for hours doesn't
// recompute every few seconds pointlessly.
export function nextDelayMs(iso: string, nowMs: number): number | null {
	const diffMs = nowMs - Date.parse(iso)
	if (diffMs >= WEEK_MS) return null
	if (diffMs < 2 * MINUTE_MS) return 15_000
	if (diffMs < HOUR_MS) return 60_000
	return 5 * MINUTE_MS
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/lib/relative-time.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing render test for the component**

Create `web/src/lib/RelativeTime.render.test.ts`:

```ts
import { test, expect } from 'vitest'
import { render } from 'svelte/server'
import RelativeTime from './RelativeTime.svelte'

test('renders a <time> element with the datetime attribute and a relative label', () => {
	const iso = new Date(Date.now() - 2 * 60_000).toISOString() // 2 minutes ago
	const { body } = render(RelativeTime, { props: { datetime: iso } } as never)

	expect(body).toContain(`datetime="${iso}"`)
	expect(body).toContain('minute')
})

test('an item older than 7 days renders an absolute date, not "ago"', () => {
	const iso = new Date(Date.now() - 8 * 24 * 3_600_000).toISOString()
	const { body } = render(RelativeTime, { props: { datetime: iso } } as never)

	expect(body).not.toContain('ago')
	expect(body).toMatch(/\d{4}/) // a year, from the absolute date
})

test('the title attribute always carries the full absolute date/time', () => {
	const iso = new Date(Date.now() - 30_000).toISOString()
	const { body } = render(RelativeTime, { props: { datetime: iso } } as never)

	expect(body).toContain('title="')
	expect(body).toMatch(/title="[^"]*\d{4}[^"]*"/) // title contains a year
})
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd web && npx vitest run src/lib/RelativeTime.render.test.ts`
Expected: FAIL — `Cannot find module './RelativeTime.svelte'`

- [ ] **Step 7: Implement `RelativeTime.svelte`**

Create `web/src/lib/RelativeTime.svelte`:

```svelte
<script lang="ts">
	import { relativeLabel, absoluteLabel, nextDelayMs } from './relative-time.ts'

	let { datetime }: { datetime: string } = $props()

	let label = $state(relativeLabel(datetime, Date.now()))

	// Client-side ticking only — $effect never runs during SSR, so the
	// $state initializer above is the entire no-JS render; this effect is
	// pure progressive enhancement. Self-rescheduling setTimeout (not a
	// fixed setInterval) because the ideal cadence changes as the item
	// ages (see nextDelayMs) — a fixed interval can't adapt its own period.
	$effect(() => {
		const iso = datetime
		let timeoutId: ReturnType<typeof setTimeout> | undefined

		function tick(): void {
			label = relativeLabel(iso, Date.now())
			const delay = nextDelayMs(iso, Date.now())
			if (delay !== null) timeoutId = setTimeout(tick, delay)
		}

		const firstDelay = nextDelayMs(iso, Date.now())
		if (firstDelay !== null) timeoutId = setTimeout(tick, firstDelay)

		return () => {
			if (timeoutId !== undefined) clearTimeout(timeoutId)
		}
	})
</script>

<time {datetime} title={absoluteLabel(datetime)}>{label}</time>
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd web && npx vitest run src/lib/relative-time.test.ts src/lib/RelativeTime.render.test.ts`
Expected: PASS

- [ ] **Step 9: Run svelte-check and the full web suite**

Run (per this project's docker-dev convention — the host checkout's `web/node_modules` is root-owned from the running container, so run inside it): `docker exec rsc-web sh -c "cd /app/web && env -u CORE_API_URL npx vitest run"`
Expected: PASS, no regressions.

Run: `docker exec rsc-web sh -c "cd /app/web && npx svelte-kit sync && npx svelte-check --tsconfig ./tsconfig.json"`
Expected: 0 errors, 0 warnings.

- [ ] **Step 10: Commit**

```bash
git add web/src/lib/relative-time.ts web/src/lib/relative-time.test.ts web/src/lib/RelativeTime.svelte web/src/lib/RelativeTime.render.test.ts
git commit -m "$(cat <<'EOF'
web: add RelativeTime component (live relative post timestamps)

Pure formatting module (relativeLabel/absoluteLabel/nextDelayMs, unit
tested independent of rendering) backing a small component that shows
"2 min ago"-style text, ticking live via a self-rescheduling
setTimeout, falling back to an absolute date past 7 days. No JS
needed for a correct initial render -- $effect never runs during SSR,
so the $state initializer IS the no-JS render. Not wired into any
page yet; that's the next task.

developed with the help of AI tools
EOF
)"
```

---

### Task 2: Swap all 7 call sites to `<RelativeTime>`

**Files:**
- Modify: `web/src/routes/+page.svelte`
- Modify: `web/src/routes/p/[publisherId]/+page.svelte`
- Modify: `web/src/routes/post/[id]/+page.svelte`
- Modify: `web/src/routes/u/[handle]/+page.svelte` (two call sites)
- Modify: `web/src/routes/u/[handle]/following/+page.svelte`
- Modify: `web/src/lib/ReplyTree.svelte`

**Interfaces:**
- Consumes: `RelativeTime.svelte`'s `datetime: string` prop (Task 1).

This task is purely mechanical substitution — no new logic, no new tests (Task 1 already covers the component's behavior; these 7 edits only change which component renders the timestamp). Verify via each file's own existing test suite (where one exists) plus the full suite at the end.

- [ ] **Step 1: `web/src/routes/+page.svelte`**

Add the import (after the existing `import FeedIcon from '$lib/FeedIcon.svelte'` line, matching this file's existing `$lib/X.svelte` import style):

```ts
	import RelativeTime from '$lib/RelativeTime.svelte'
```

Replace:

```svelte
					<a class="permalink" href="/post/{post.id}"><time datetime={post.publishedAt}>{post.publishedAt.slice(0, 10)}</time></a>
```

with:

```svelte
					<a class="permalink" href="/post/{post.id}"><RelativeTime datetime={post.publishedAt} /></a>
```

- [ ] **Step 2: `web/src/routes/p/[publisherId]/+page.svelte`**

Add the import (after `import PostBody from '$lib/PostBody.svelte'`):

```ts
	import RelativeTime from '$lib/RelativeTime.svelte'
```

Replace:

```svelte
				<a class="permalink" id="by-{post.id}" href="/post/{post.id}"><time datetime={post.publishedAt}>{post.publishedAt.slice(0, 10)}</time></a>
```

with:

```svelte
				<a class="permalink" id="by-{post.id}" href="/post/{post.id}"><RelativeTime datetime={post.publishedAt} /></a>
```

- [ ] **Step 3: `web/src/routes/post/[id]/+page.svelte`**

Add the import (after `import PostBody from '$lib/PostBody.svelte'`):

```ts
	import RelativeTime from '$lib/RelativeTime.svelte'
```

Replace:

```svelte
					<a class="permalink" href="/post/{root.id}"><time datetime={root.publishedAt}>{root.publishedAt.slice(0, 10)}</time></a>
```

with:

```svelte
					<a class="permalink" href="/post/{root.id}"><RelativeTime datetime={root.publishedAt} /></a>
```

- [ ] **Step 4: `web/src/routes/u/[handle]/+page.svelte` — both call sites**

Add the import (after `import PostBody from '$lib/PostBody.svelte'`):

```ts
	import RelativeTime from '$lib/RelativeTime.svelte'
```

Replace the main-list call site:

```svelte
					<a class="permalink" id="by-{post.id}" href="/post/{post.id}"><time datetime={post.publishedAt}>{post.publishedAt.slice(0, 10)}</time></a>
```

with:

```svelte
					<a class="permalink" id="by-{post.id}" href="/post/{post.id}"><RelativeTime datetime={post.publishedAt} /></a>
```

Replace the second, compact-format call site (this one drops its `.slice(5, 10)` MM-DD special case entirely — `<RelativeTime>` is already compact, so there's no longer a reason for a separate abbreviated variant):

```svelte
							<li>
								<span class="k"><time datetime={p.publishedAt}>{p.publishedAt.slice(5, 10)}</time></span>
								<div>
```

with:

```svelte
							<li>
								<span class="k"><RelativeTime datetime={p.publishedAt} /></span>
								<div>
```

- [ ] **Step 5: `web/src/routes/u/[handle]/following/+page.svelte`**

Add the import (after `import Avatar from '$lib/Avatar.svelte'`):

```ts
	import RelativeTime from '$lib/RelativeTime.svelte'
```

Replace:

```svelte
						<a class="permalink" href="/post/{post.id}"><time datetime={post.publishedAt}>{post.publishedAt.slice(0, 10)}</time></a>
```

with:

```svelte
						<a class="permalink" href="/post/{post.id}"><RelativeTime datetime={post.publishedAt} /></a>
```

- [ ] **Step 6: `web/src/lib/ReplyTree.svelte`**

Add the import (after `import EditedMarker from './EditedMarker.svelte'` — this file is already inside `$lib`, so use the relative path, matching its own existing imports):

```ts
	import RelativeTime from './RelativeTime.svelte'
```

Replace:

```svelte
				<a class="permalink" href="/post/{reply.id}"><time datetime={reply.publishedAt}>{reply.publishedAt.slice(0, 10)}</time></a>
```

with:

```svelte
				<a class="permalink" href="/post/{reply.id}"><RelativeTime datetime={reply.publishedAt} /></a>
```

- [ ] **Step 7: Check for any test asserting the old bare-date text**

Run: `grep -rn "publishedAt.slice\|toContain.*'202" web/src --include="*.test.ts"` — confirm no remaining test depends on the removed `.slice(0, 10)`/`.slice(5, 10)` truncation or asserts a literal `YYYY-MM-DD` string sourced from `publishedAt`. (Verified during planning: `web/src/lib/ReplyTree.test.ts` and `web/src/routes/post/[id]/thread.render.test.ts` both set `publishedAt` as fixture data but don't assert on its rendered text — expected to need no changes, but re-confirm since files may have shifted since this plan was written.)

If any test DOES assert the old format, update it to assert on `RelativeTime`'s actual output instead (e.g. `toContain('ago')` for a fixture timestamp in the recent past, matching Task 1's render-test style) — do not delete a real assertion to make it pass.

- [ ] **Step 8: Run the full web test suite and svelte-check**

Run: `docker exec rsc-web sh -c "cd /app/web && env -u CORE_API_URL npx vitest run"`
Expected: PASS, no regressions across any of the 6 touched files' existing tests.

Run: `docker exec rsc-web sh -c "cd /app/web && npx svelte-kit sync && npx svelte-check --tsconfig ./tsconfig.json"`
Expected: 0 errors, 0 warnings.

- [ ] **Step 9: Commit**

```bash
git add web/src/routes/+page.svelte "web/src/routes/p/[publisherId]/+page.svelte" "web/src/routes/post/[id]/+page.svelte" "web/src/routes/u/[handle]/+page.svelte" "web/src/routes/u/[handle]/following/+page.svelte" web/src/lib/ReplyTree.svelte
git commit -m "$(cat <<'EOF'
web: show live relative timestamps on every post

Swaps the bare static date (2026-07-30) for a live "2 min ago"-style
label at all 7 places a post timestamp renders. Frontend-only --
publishedAt was already a full-precision ISO datetime end to end, the
truncation was purely a template artifact. The full absolute
date/time stays available on hover via the <time> title attribute.

developed with the help of AI tools
EOF
)"
```

---

## Post-plan verification

After both tasks:

```bash
docker exec rsc-web sh -c "cd /app/web && env -u CORE_API_URL npx vitest run && npx svelte-kit sync && npx svelte-check --tsconfig ./tsconfig.json"
```

Expected: full web suite green, svelte-check clean.

Manual check (this plan's behavior can't be fully verified by automated tests — `$effect`'s live-ticking doesn't run under SSR-only render tests): open a page with a recent post in a real browser and confirm the label visibly advances after the first `nextDelayMs` interval elapses, and that hovering shows the full absolute date/time.
