# Admin source-management UX redesign — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign `/admin`'s source-management interaction model per
`docs/superpowers/specs/2026-07-30-admin-source-management-redesign.md`
(rev 3): inline reveal-to-confirm instead of native `confirm()` popups, a
retention-driven single-form reap flow instead of a failed-attempt round
trip, bulk governance/reap/tombstone/delete-user actions reusing existing
per-row commandIds, and an inline source-detail panel reachable from the
list without a route change.

**Architecture:** Nine tasks, in three groups. Tasks 1-3 replace
`confirmSubmit()` with `<details>` reveal-to-confirm across every admin
destructive-action form, and fold in the reap flow's retention-driven
simplification (Task 2 only, since it's the same forms). Tasks 4-8 add bulk
actions: a `bulkSource` action for ordinary governance rows (4) and its UI
(5), `bulkReap`/`bulkTombstone` actions (6) and their UI (7), and bulk
delete-user (8, server + UI together — small enough not to split). Task 9
extracts shared source-detail load logic and wires the `?detail=` inline
panel. Order: 1 → 2 → 3 can run in either order relative to each other (they
touch disjoint forms) but all three must land before 4-9 (bulk/detail tasks
build UI in the post-`<details>` shape). 4 before 5, 6 before 7. 8 and 9 are
independent of everything except 1-3.

**Tech Stack:** Node 22 native type-stripping (no build step —
`svelte-check` is the real gate), SvelteKit 5 (Svelte 5 runes), vitest.
Web-only; no `core/` changes anywhere in this plan.

## Global Constraints

- **Container-only test commands.** `docker compose exec -T web env -u CORE_API_URL npm test -w web -- <files>` to run specific web test files; `docker compose exec -T web npm run -w web check` for `svelte-check`. Never bare `vitest`/`npx vitest` — the container's default CWD drops web's `$lib` alias and produces a misleading "Cannot find module" error.
- **Baseline (verified 2026-07-30, re-verify before Task 1):** web suite 321/321 passing (39 files), `svelte-check` 0 errors/0 warnings.
- **Never `git add -A`** — shared checkout; a parallel session may commit to `main` concurrently. Stage explicit paths.
- **Every task ends with the web suite green and `svelte-check` clean.**
- **No raw hex colors, no rounded corners, no `box-shadow`** — every new element uses existing `--color-*`/`--space-*` tokens from `web/src/app.css`, matching the file's existing `<style>` blocks. `design-system/rsc/MASTER.md`'s "nothing floats" rule applies: the bulk toolbar is a ruled row in normal document flow, never `position: fixed`/`sticky`.
- **No-JS baseline for every bulk toolbar:** the toolbar (buttons + hidden inputs) renders unconditionally in server output — a checkbox-then-submit works with zero JS. `$state`-driven show/hide (swapping the group blurb for the toolbar only once something is checked, matching the maintainer's chosen mockup) is a JS-only enhancement layered on top via `$effect`/reactive class binding — never the only path to a working bulk submit.
- **`attribution-mode` is excluded from bulk actions.** It's the one governance action needing an extra required field (the new mode) with a per-row meaning that doesn't generalize to "apply the same value to N rows" without design the spec never scoped. Every other action in `ACTIONS` (pause/resume/quarantine/allow/approve/reject/revoke/block/unblock) is a plain toggle and is bulk-eligible.
- **Every new/changed test follows this codebase's existing fixture conventions** — see `web/src/routes/admin/feeds/source-actions.test.ts`'s `formEvent`/`loadAdminWith`/`urlsOf` helpers and `feeds.render.test.ts`'s `render(Page, { props: { data, form } })` SSR pattern (via `svelte/server`, `$app/forms`'s `enhance` stubbed to `() => ({})`). Reuse these helpers; don't invent new ones.

---

### Task 1: Reveal-to-confirm — `source` action's block/unblock + tombstone-unblock

**Files:**
- Modify: `web/src/routes/admin/feeds/+page.svelte`
- Test: `web/src/routes/admin/feeds/feeds.render.test.ts`

**Interfaces:**
- Consumes: nothing from another task.
- Produces: the `<details class="confirm-gate">` markup pattern this plan's later tasks (2, 3) reuse verbatim for reap/purge/deleteUser. No exported function — it's inline markup, matching how `.consequence`/`.source-action` styles are already duplicated per page in this codebase (no shared component today).

- [ ] **Step 1: Confirm the baseline**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run` and `docker compose exec -T web npm run -w web check`
Expected: `321 passed (321)`, `0 errors and 0 warnings`.

- [ ] **Step 2: Write the failing render test**

Add to `web/src/routes/admin/feeds/feeds.render.test.ts` (after the existing `baseRow`/`memberRow` helpers, near the top-level tests — exact insertion point: after the last `test(...)` that uses `baseRow`, before the `--- Task 4` section comment):

```typescript
test('a block form with a consequence renders a collapsed <details> disclosure, not an always-visible confirm button', () => {
	const row = baseRow({ actions: [{ action: 'block', commandId: 'block-cmd-1' }] })
	const data = {
		groups: [{ key: 'federation', title: 'Approved federation', blurb: '', rows: [row] }],
		expand: null,
		expandedMembers: [],
		tombstones: [],
		tombstoneConsequence: 'nothing restored',
		categories: ['spam'],
		cursor: null,
		nextCursor: null,
		...NO_ORPHANS,
		establishCommandId: 'establish-1'
	}
	const { body } = render(Page, { props: { data, form: null } } as never)
	// The consequence text and the actual submit button live INSIDE a
	// <details>, collapsed by default — not sitting next to an always-active
	// submit button (the old double-confirm shape).
	const detailsChunk = body.slice(body.indexOf('<details class="confirm-gate"'), body.indexOf('</details>') + '</details>'.length)
	expect(detailsChunk).toContain('Blocking stops all acquisition')
	expect(detailsChunk).toContain('Confirm block')
	// The <summary> (always visible, collapsed state) carries the plain action label.
	const summaryChunk = detailsChunk.slice(0, detailsChunk.indexOf('</summary>'))
	expect(summaryChunk).toContain('>Block<')
})

test('an action with no stated consequence (pause) has no confirm-gate at all — direct submit', () => {
	const row = baseRow({ actions: [{ action: 'pause', commandId: 'pause-cmd-1' }] })
	const data = {
		groups: [{ key: 'federation', title: 'Approved federation', blurb: '', rows: [row] }],
		expand: null,
		expandedMembers: [],
		tombstones: [],
		tombstoneConsequence: 'nothing restored',
		categories: ['spam'],
		cursor: null,
		nextCursor: null,
		...NO_ORPHANS,
		establishCommandId: 'establish-1'
	}
	const { body } = render(Page, { props: { data, form: null } } as never)
	expect(body).not.toContain('<details class="confirm-gate"')
	expect(body).toContain('>Pause acquisition<')
})

test('the tombstone-unblock form renders its own confirm-gate with the distinct tombstone consequence', () => {
	const data = {
		groups: [],
		expand: null,
		expandedMembers: [],
		tombstones: [{ id: 't1', canonicalUrl: 'https://gone.test/t1.xml', action: 'block', category: 'spam', note: '', createdAt: '2026-07-01T00:00:00Z', aliases: [], commandId: 'tomb-cmd-1' }],
		tombstoneConsequence: 'Unblocking this tombstone lifts the URL reservation so the URL can be created again. Nothing is restored.',
		categories: ['spam'],
		cursor: null,
		nextCursor: null,
		...NO_ORPHANS,
		establishCommandId: 'establish-1'
	}
	const { body } = render(Page, { props: { data, form: null } } as never)
	const detailsChunk = body.slice(body.indexOf('<details class="confirm-gate"'), body.indexOf('</details>') + '</details>'.length)
	expect(detailsChunk).toContain('lifts the URL reservation')
	expect(detailsChunk).toContain('Confirm unblock')
})
```

Check `NO_ORPHANS` already exists as a helper constant in this file (it's used by other tests around line 260-284); if it doesn't exist under that exact name, read the file to find whatever spreads `orphanRows: [], orphanCursor: null, orphanNextCursor: null` today and use that instead — don't invent a second helper for the same fields.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run feeds.render.test.ts`
Expected: FAIL — `<details class="confirm-gate"` not found in output (the markup doesn't exist yet).

- [ ] **Step 4: Replace the block/unblock form's confirm wiring in `web/src/routes/admin/feeds/+page.svelte`**

Read the file fresh first — this plan was written against the version at commit `5b614e2`; if `managePanel` (currently lines 237-277) has drifted, re-read before editing.

Replace the `managePanel` snippet's per-action form (currently lines 245-273):

```svelte
				<form
					method="POST"
					action="?/source{qs ? `&${qs}` : ''}"
					class="source-action"
					class:destructive={a.action === 'block'}
					use:enhance={consequence ? confirmSubmit(`${consequence} Continue?`) : undefined}
				>
					<input type="hidden" name="sourceId" value={row.id} />
					<input type="hidden" name="action" value={a.action} />
					<input type="hidden" name="commandId" value={retryCommandId ?? a.commandId} />
					<span class="action-name">{LABEL[a.action]}</span>
					{#if consequence}<p class="consequence">{consequence}</p>{/if}
					{#if a.action === 'attribution-mode'}
						<label class="visually-hidden" for="mode-{scope}{row.id}">Attribution mode</label>
						<select id="mode-{scope}{row.id}" name="attributionMode">
							<option value="single_publisher">single publisher</option>
							<option value="aggregate">aggregate</option>
						</select>
					{/if}
					{#if a.action !== 'pause' && a.action !== 'resume'}
						<label class="visually-hidden" for="cat-{scope}{row.id}-{a.action}">Moderation category</label>
						<select id="cat-{scope}{row.id}-{a.action}" name="category" required>
							{#each CATEGORIES as c (c)}<option value={c}>{c.replace('_', ' ')}</option>{/each}
						</select>
					{/if}
					<label class="visually-hidden" for="note-{scope}{row.id}-{a.action}">Note (optional)</label>
					<input id="note-{scope}{row.id}-{a.action}" name="note" placeholder="note (optional)" />
					<button aria-label="{LABEL[a.action]} — {row.url}">{LABEL[a.action]}</button>
				</form>
```

with:

```svelte
				<form
					method="POST"
					action="?/source{qs ? `&${qs}` : ''}"
					class="source-action"
					class:destructive={a.action === 'block'}
					use:enhance
				>
					<input type="hidden" name="sourceId" value={row.id} />
					<input type="hidden" name="action" value={a.action} />
					<input type="hidden" name="commandId" value={retryCommandId ?? a.commandId} />
					{#if a.action === 'attribution-mode'}
						<label class="visually-hidden" for="mode-{scope}{row.id}">Attribution mode</label>
						<select id="mode-{scope}{row.id}" name="attributionMode">
							<option value="single_publisher">single publisher</option>
							<option value="aggregate">aggregate</option>
						</select>
					{/if}
					{#if a.action !== 'pause' && a.action !== 'resume'}
						<label class="visually-hidden" for="cat-{scope}{row.id}-{a.action}">Moderation category</label>
						<select id="cat-{scope}{row.id}-{a.action}" name="category" required>
							{#each CATEGORIES as c (c)}<option value={c}>{c.replace('_', ' ')}</option>{/each}
						</select>
					{/if}
					<label class="visually-hidden" for="note-{scope}{row.id}-{a.action}">Note (optional)</label>
					<input id="note-{scope}{row.id}-{a.action}" name="note" placeholder="note (optional)" />
					{#if consequence}
						<details class="confirm-gate">
							<summary><span class="action-name">{LABEL[a.action]}</span></summary>
							<p class="consequence">{consequence}</p>
							<button aria-label="Confirm {LABEL[a.action]} — {row.url}">Confirm {LABEL[a.action].toLowerCase()}</button>
						</details>
					{:else}
						<span class="action-name">{LABEL[a.action]}</span>
						<button aria-label="{LABEL[a.action]} — {row.url}">{LABEL[a.action]}</button>
					{/if}
				</form>
```

Note the category/note fields move ABOVE the `<details>` — they're required inputs the operator fills in before confirming, not part of the confirmation itself; keeping them outside the disclosure means they're visible and fillable before the operator ever expands the confirm gate. `class="action-name"` inside `<summary>` keeps the existing bold-label styling for both branches (with and without a confirm gate).

- [ ] **Step 5: Replace the tombstone-unblock form's confirm wiring (currently lines 381-392)**

```svelte
					<form method="POST" action="?/tombstone{tombstoneQs ? `&${tombstoneQs}` : ''}" class="source-action" use:enhance={confirmSubmit(`${data.tombstoneConsequence} Continue?`)}>
						<input type="hidden" name="tombstoneId" value={t.id} />
						<input type="hidden" name="commandId" value={retryCommandId ?? t.commandId} />
						<p class="consequence">{data.tombstoneConsequence}</p>
						<label class="visually-hidden" for="tomb-cat-{t.id}">Moderation category</label>
						<select id="tomb-cat-{t.id}" name="category" required>
							{#each data.categories as c (c)}<option value={c}>{c.replace(/_/g, ' ')}</option>{/each}
						</select>
						<label class="visually-hidden" for="tomb-note-{t.id}">Note (optional)</label>
						<input id="tomb-note-{t.id}" name="note" placeholder="note (optional)" />
						<button aria-label="Unblock {t.canonicalUrl}">Unblock URL</button>
					</form>
```

becomes:

```svelte
					<form method="POST" action="?/tombstone{tombstoneQs ? `&${tombstoneQs}` : ''}" class="source-action" use:enhance>
						<input type="hidden" name="tombstoneId" value={t.id} />
						<input type="hidden" name="commandId" value={retryCommandId ?? t.commandId} />
						<label class="visually-hidden" for="tomb-cat-{t.id}">Moderation category</label>
						<select id="tomb-cat-{t.id}" name="category" required>
							{#each data.categories as c (c)}<option value={c}>{c.replace(/_/g, ' ')}</option>{/each}
						</select>
						<label class="visually-hidden" for="tomb-note-{t.id}">Note (optional)</label>
						<input id="tomb-note-{t.id}" name="note" placeholder="note (optional)" />
						<details class="confirm-gate">
							<summary><span class="action-name">Unblock URL</span></summary>
							<p class="consequence">{data.tombstoneConsequence}</p>
							<button aria-label="Confirm unblock — {t.canonicalUrl}">Confirm unblock</button>
						</details>
					</form>
```

- [ ] **Step 6: Drop the now-unused `confirmSubmit` import**

Remove `import { confirmSubmit } from '$lib/confirm'` from the top of the file (line 4) — the reap forms still use it until Task 2 lands, so check: if Task 2 hasn't run yet in your working tree, do NOT remove this import (the reap forms below still reference `confirmSubmit`). If Task 2 has already landed, remove it now.

- [ ] **Step 7: Add `.confirm-gate` styling to the file's `<style>` block**

Add near the existing `.consequence`/`.source-action` rules:

```css
	.confirm-gate summary {
		cursor: pointer;
		list-style: none;
	}
	.confirm-gate summary::-webkit-details-marker {
		display: none;
	}
	.confirm-gate[open] summary .action-name {
		color: var(--color-secondary);
	}
	.confirm-gate .consequence {
		margin: var(--space-sm) 0;
	}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run feeds.render.test.ts`
Expected: all pass, including the 3 new tests. If Task 2 hasn't landed yet, some pre-existing reap tests may still reference the old two-step shape — that's expected and gets fixed in Task 2, not here. Confirm no OTHER previously-passing test in this file broke.

- [ ] **Step 9: Full web suite + typecheck**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run` and `docker compose exec -T web npm run -w web check`
Expected: all passing, 0 errors/warnings.

- [ ] **Step 10: Commit**

```bash
git add web/src/routes/admin/feeds/+page.svelte web/src/routes/admin/feeds/feeds.render.test.ts
git commit -m "$(cat <<'EOF'
feat(admin): inline reveal-to-confirm for block/unblock and tombstone-unblock

Replaces the native window.confirm() popup with a <details> disclosure
that shows the same consequence text before a distinct Confirm button —
one prompt instead of two, works with zero JS.

developed with the help of AI tools
EOF
)"
```

---

### Task 2: Reap flow — reveal-to-confirm + retention-driven single form

**Files:**
- Modify: `web/src/routes/admin/feeds/+page.svelte`, `web/src/routes/admin/feeds/+page.server.ts`
- Test: `web/src/routes/admin/feeds/feeds.render.test.ts`, `web/src/routes/admin/feeds/source-actions.test.ts`

**Interfaces:**
- Consumes: the `.confirm-gate` `<details>` pattern from Task 1 (reused verbatim for the reap forms).
- Produces: `toOrphanRow` now returns `{id, url, retention, commandId}` — no `forceCommandId`. Later tasks (6, 7 — bulk reap) consume `row.retention` and `row.commandId` directly to build `{sourceId, commandId, force}` triples; they must NOT expect a `forceCommandId` field.

- [ ] **Step 1: Confirm the baseline**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run` and `docker compose exec -T web npm run -w web check`
Expected: passing (with Task 1's new tests included if it already landed).

- [ ] **Step 2: Write the failing tests — server side (`source-actions.test.ts`)**

Read the existing `orphanRow`/orphan test block first (`web/src/routes/admin/feeds/source-actions.test.ts:499-523`, the `'the orphan group is fetched with filter=orphan...'` test). Replace its `forceCommandId` assertions:

```typescript
		// Distinct, well-formed command ids per row, and commandId !== forceCommandId.
		for (const r of result.orphanRows ?? []) {
			expect(r.commandId).toMatch(/^[0-9a-f]{8}-/)
			expect(r.forceCommandId).toMatch(/^[0-9a-f]{8}-/)
			expect(r.commandId).not.toBe(r.forceCommandId)
		}
```

becomes:

```typescript
		// One command id per row now (not two) — the row renders exactly one
		// reap form, plain or force, decided by retention, never both.
		for (const r of result.orphanRows ?? []) {
			expect(r.commandId).toMatch(/^[0-9a-f]{8}-/)
			expect('forceCommandId' in r).toBe(false)
		}
```

- [ ] **Step 3: Write the failing tests — render side (`feeds.render.test.ts`)**

Read `web/src/routes/admin/feeds/feeds.render.test.ts:360-411` first (the reason-loop test and the `has_subscribers` test) — this plan was written against that exact range at commit `5b614e2`; re-read if it's drifted. Replace that entire block (from the `REASON_COPY_NEEDLE` const through the closing `})` of the `has_subscribers` test) with:

```typescript
const REASON_COPY_NEEDLE: Record<string, string> = {
	verified_origin_evidence: 'verified-origin evidence',
	admin_retained: 'marked retained by an admin',
	audit_history: 'audit history'
}
// Retention-driven: the button/consequence choice comes from row.retention
// ALONE, at first render — no `form` prop, no prior refusal. reapable gets
// the plain form; each force-liftable reason gets the force form directly.
test('a reapable orphan row renders exactly one plain Reap form, no force variant', () => {
	const { body } = render(Page, { props: { data: orphanData({ orphanRows: [orphanRow({ retention: 'reapable' })] }), form: null } } as never)
	expect(body).toContain('action="?/reap')
	expect(body).toContain('name="sourceId" value="orph1"')
	expect(body).toContain('name="commandId" value="orph-cmd-1"')
	expect(body).not.toContain('name="force"')
	const detailsChunk = body.slice(body.indexOf('<details class="confirm-gate"'), body.indexOf('</details>') + '</details>'.length)
	expect(detailsChunk).toContain('Confirm reap')
})

for (const reason of ['verified_origin_evidence', 'admin_retained', 'audit_history']) {
	test(`a retention=${reason} orphan row renders exactly one "Reap anyway" form with force:true and the reason-specific consequence, from first render`, () => {
		// orphanRow's `retention` param uses the display-oriented value
		// (verified_origin/admin_retained/audit_history/reapable); the
		// FORCE_REAP_CONSEQUENCE lookup in +page.svelte keys on that same
		// value, so pass it straight through here — no separate "refusal
		// reason" string is involved anywhere in this flow anymore.
		const retention = reason === 'verified_origin_evidence' ? 'verified_origin' : reason
		const { body } = render(Page, { props: { data: orphanData({ orphanRows: [orphanRow({ id: 'orph1', url: 'https://orph1.test/feed.xml', retention })] }), form: null } } as never)
		expect(body).toContain('name="force" value="true"')
		expect(body).toContain('name="commandId" value="orph-cmd-1"') // the row's ONE commandId, reused, not a second one
		const detailsChunk = body.slice(body.indexOf('<details class="confirm-gate"'), body.indexOf('</details>') + '</details>'.length)
		expect(detailsChunk).toContain(REASON_COPY_NEEDLE[reason])
		expect(detailsChunk).toContain('Confirm reap anyway')
		for (const [otherReason, needle] of Object.entries(REASON_COPY_NEEDLE)) {
			if (otherReason !== reason) expect(detailsChunk).not.toContain(needle)
		}
	})
}

test('a mixed batch of orphan rows renders each with its OWN correct variant, independent of the others', () => {
	const data = orphanData({
		orphanRows: [
			orphanRow({ id: 'orph1', url: 'https://orph1.test/feed.xml', retention: 'audit_history' }),
			orphanRow({ id: 'orph2', url: 'https://orph2.test/feed.xml', retention: 'reapable' })
		]
	})
	const { body } = render(Page, { props: { data, form: null } } as never)
	const orph1Chunk = body.slice(body.indexOf('https://orph1.test'), body.indexOf('https://orph2.test'))
	const orph2Chunk = body.slice(body.indexOf('https://orph2.test'))
	expect(orph1Chunk).toContain('name="force" value="true"')
	expect(orph2Chunk.slice(0, orph2Chunk.indexOf('More orphaned') === -1 ? orph2Chunk.length : orph2Chunk.indexOf('More orphaned'))).not.toContain('name="force" value="true"')
})
```

Also update `orphanRow`'s fixture helper (`feeds.render.test.ts:292-301`) to drop `forceCommandId`:

```typescript
function orphanRow(over: Record<string, unknown> = {}) {
	return {
		id: 'orph1',
		url: 'https://orph.test/feed.xml',
		retention: 'reapable',
		commandId: 'orph-cmd-1',
		...over
	}
}
```

And the earlier test at line ~322-331 (`'the orphan group is shown even when the ordinary groups are all empty...'`) already asserts `not.toContain('name="force"')` for a `reapable` row — leave it as-is, it still holds.

- [ ] **Step 4: Run the tests to verify they fail**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run feeds.render.test.ts source-actions.test.ts`
Expected: FAIL on the new/changed assertions (`forceCommandId` still present, retention-driven markup doesn't exist yet).

- [ ] **Step 5: Update `toOrphanRow` in `web/src/routes/admin/feeds/+page.server.ts`**

Replace (currently lines 164-170):

```typescript
const toOrphanRow = (s: SourceSummary) => ({
	id: s.source.id,
	url: s.source.canonicalUrl,
	retention: s.retention,
	commandId: crypto.randomUUID(),
	forceCommandId: crypto.randomUUID()
})
```

with:

```typescript
// One command id per row (not two): the row renders exactly one reap form —
// plain or force, decided by retention — never both, so one id is enough.
const toOrphanRow = (s: SourceSummary) => ({
	id: s.source.id,
	url: s.source.canonicalUrl,
	retention: s.retention,
	commandId: crypto.randomUUID()
})
```

Update the comment above it (currently describing "TWO command ids... distinct namespaces") to match — replace the paragraph at lines 154-163 with:

```typescript
// Orphan rows (Task 4): shown in their own always-visible, independently
// paginated group. They carry `retention` (the display-oriented ladder,
// verified_origin > admin_retained > audit_history > reapable — Task 1's
// retentionFor) instead of the ordinary transition-action list. One
// commandId per row: retention alone decides, at render time, whether the
// row shows a plain Reap form or a force Reap-anyway form — never both, so
// there's nothing left to disambiguate a second id for. An orphan by
// definition has zero subscriptions (the core WHERE clause enforces it), so
// addedBy is always empty here — no point rendering it.
```

- [ ] **Step 6: Rewrite the reap section of `web/src/routes/admin/feeds/+page.svelte`**

Read the file's `<script>` block fresh first. Delete these now-dead declarations (currently lines 72-99, from `// Design §10 posture, extended to reap` through the `GENERIC_FORCE_CONSEQUENCE` const):

```typescript
	// Design §10 posture, extended to reap: the plain (no-force) attempt's
	// consequence is stated up front; the SEPARATE force-confirm form (shown
	// only once core has actually refused with one of the three force-liftable
	// reasons — verified_origin_evidence, admin_retained, audit_history, per
	// core's reapSource guard chain) states the sharper, reason-specific
	// consequence of overriding THAT refusal — never the same sentence for all
	// three, since the stakes differ per reason.
	const REAP_CONSEQUENCE =
		'Reaping permanently deletes this source and its evidence — items, publisher claims and any history of its own are removed for good. Only offered for sources with no subscribers and no federation relationship.'
	// The three refusal reasons core's reapSource will actually lift when
	// force:true is sent (admin_retained/audit_history/verified_origin_evidence
	// — see reapSource's `!opts.force &&` guards); every other reason
	// (has_subscribers/not_allowed/federated/idempotency conflict) is always
	// enforced and gets no confirm form, just the plain error banner.
	const FORCE_LIFTABLE = new Set(['verified_origin_evidence', 'admin_retained', 'audit_history'])
	const FORCE_REAP_CONSEQUENCE: Record<string, string> = {
		verified_origin_evidence:
			'This source backs verified-origin evidence for a logical item. Reaping anyway removes that evidence permanently — the affected item loses its verified-origin claim. This cannot be undone.',
		admin_retained:
			'This source was marked retained by an admin. Reaping anyway overrides that retention permanently — the source and its evidence are removed for good.',
		audit_history:
			'This source has audit history (past moderation decisions). Reaping anyway removes the source AND that history permanently — nothing will be left to show what was decided or why.'
	}
	// Fallback only for the rare case where a force retry itself fails for a
	// reason that ISN'T one of the three above (e.g. a subscriber appeared in
	// between) — the confirm form stays open for the retry, just with generic
	// wording instead of a stale reason-specific sentence.
	const GENERIC_FORCE_CONSEQUENCE = 'Reaping anyway overrides the refusal above and permanently removes this source and its evidence. This cannot be undone.'
```

Replace with:

```typescript
	// Design §10, retention-driven (no round trip): retention is already
	// known at load time (Task 4's toOrphanRow), so which consequence text
	// and which button ("Reap" vs "Reap anyway") a row shows is decided
	// directly from `row.retention` — never from a prior refusal. The three
	// reasons below are exactly the ones core's reapSource lifts when
	// force:true is sent (see the `!opts.force &&` guards in
	// core/src/domain/source-repository.ts); every other reason
	// (has_subscribers/not_allowed/federated) can never appear here, since
	// the orphan list's own filter already excludes any source with those
	// properties.
	const REAP_CONSEQUENCE =
		'Reaping permanently deletes this source and its evidence — items, publisher claims and any history of its own are removed for good. Only offered for sources with no subscribers and no federation relationship.'
	const FORCE_REAP_CONSEQUENCE: Record<string, string> = {
		verified_origin: // orphanRow.retention's spelling (no _evidence suffix), unlike the reason string core's 409 used to return
			'This source backs verified-origin evidence for a logical item. Reaping anyway removes that evidence permanently — the affected item loses its verified-origin claim. This cannot be undone.',
		admin_retained:
			'This source was marked retained by an admin. Reaping anyway overrides that retention permanently — the source and its evidence are removed for good.',
		audit_history:
			'This source has audit history (past moderation decisions). Reaping anyway removes the source AND that history permanently — nothing will be left to show what was decided or why.'
	}
```

Note the `verified_origin_evidence` → `verified_origin` key rename: `SourceSummary.retention` (server-side type, `+page.server.ts:55`) uses `'verified_origin' | 'audit_history' | 'admin_retained' | 'reapable' | null` — the old code's `FORCE_REAP_CONSEQUENCE` was keyed on core's 409 *error string* (`verified_origin_evidence`, with the suffix), a DIFFERENT vocabulary that only existed because it came from a failed-attempt response body. Now that the lookup is driven by `retention` directly, it must use `retention`'s own spelling.

Now replace the orphan-row markup (currently lines 292-335, from `{#each data.orphanRows as row (row.id)}` through its closing `{/each}`):

```svelte
			<ul class="following-list source-list">
				{#each data.orphanRows as row (row.id)}
					{@const orphanQs = otherParams()}
					<!-- Task 2's guard-refusal ladder (subscribers > governance >
					     federation > admin_retained > audit_history >
					     verified_origin_evidence) is NOT the same ladder as the
					     `retention` label above (verified_origin first) — the two are
					     computed for independent purposes, so `reapFail`/`forceReason`
					     below are gated on core's ACTUAL 409 reason, never on the
					     displayed retention. -->
					{@const reapFail = retryFail && 'force' in retryFail && retryFail.sourceId === row.id ? retryFail : undefined}
					{@const forceReason = form?.error && FORCE_LIFTABLE.has(form.error) ? form.error : undefined}
					{@const showForceConfirm = !!reapFail && (forceReason !== undefined || reapFail.force === true)}
					<li>
						<div class="feed-info">
							<strong class="feed-url">{row.url}</strong>
							<span class="badge-kind">{RETENTION_LABEL[row.retention ?? 'reapable']}</span>
						</div>
						<form method="POST" action="?/reap{orphanQs ? `&${orphanQs}` : ''}" class="source-action" use:enhance={confirmSubmit(`${REAP_CONSEQUENCE} Continue?`)}>
							<input type="hidden" name="sourceId" value={row.id} />
							<input type="hidden" name="commandId" value={reapFail?.force === false ? reapFail.commandId : row.commandId} />
							<p class="consequence">{REAP_CONSEQUENCE}</p>
							<button aria-label="Reap {row.url}">Reap</button>
						</form>
						{#if showForceConfirm}
							{@const forceConsequence = FORCE_REAP_CONSEQUENCE[forceReason ?? ''] ?? GENERIC_FORCE_CONSEQUENCE}
							<!-- Distinct, freshly-minted commandId (row.forceCommandId), never
							     the refused plain attempt's id — replaying THAT id would just
							     replay its stored refusal from the ledger, not re-run the guard
							     chain with force:true. -->
							<form
								method="POST"
								action="?/reap{orphanQs ? `&${orphanQs}` : ''}"
								class="source-action destructive"
								use:enhance={confirmSubmit(`${forceConsequence} Continue?`)}
							>
								<input type="hidden" name="sourceId" value={row.id} />
								<input type="hidden" name="force" value="true" />
								<input type="hidden" name="commandId" value={reapFail?.force === true ? reapFail.commandId : row.forceCommandId} />
								<p class="consequence">{forceConsequence}</p>
								<button aria-label="Reap {row.url} anyway">Reap anyway</button>
							</form>
						{/if}
					</li>
				{/each}
			</ul>
```

with:

```svelte
			<ul class="following-list source-list">
				{#each data.orphanRows as row (row.id)}
					{@const orphanQs = otherParams()}
					{@const needsForce = row.retention !== null && row.retention !== 'reapable'}
					{@const retryCommandId = retryFail?.sourceId === row.id && 'force' in retryFail ? retryFail.commandId : undefined}
					<li>
						<div class="feed-info">
							<strong class="feed-url">{row.url}</strong>
							<span class="badge-kind">{RETENTION_LABEL[row.retention ?? 'reapable']}</span>
						</div>
						<form method="POST" action="?/reap{orphanQs ? `&${orphanQs}` : ''}" class="source-action" class:destructive={needsForce} use:enhance>
							<input type="hidden" name="sourceId" value={row.id} />
							<input type="hidden" name="commandId" value={retryCommandId ?? row.commandId} />
							{#if needsForce}<input type="hidden" name="force" value="true" />{/if}
							<details class="confirm-gate">
								<summary><span class="action-name">{needsForce ? 'Reap anyway' : 'Reap'}</span></summary>
								<p class="consequence">{needsForce ? FORCE_REAP_CONSEQUENCE[row.retention ?? ''] : REAP_CONSEQUENCE}</p>
								<button aria-label="Confirm reap {needsForce ? 'anyway ' : ''}— {row.url}">{needsForce ? 'Confirm reap anyway' : 'Confirm reap'}</button>
							</details>
						</form>
					</li>
				{/each}
			</ul>
```

`retryFail` (declared earlier in the file, the `RetryFail` union derived from `form`) still needs `'force' in retryFail` as a discriminator for a failed retry's echoed sourceId/commandId — that part of the retry-replay mechanism (a genuine network error or an enforced-always refusal like `has_subscribers`, which never reaches reap for an orphan row per this spec's own reasoning, but a network blip still can) is unrelated to the force-vs-plain UI branch and stays as-is.

- [ ] **Step 7: Drop the now-fully-unused `confirmSubmit` import**

If Task 1 already ran and left the import in place (because the reap forms still needed it), remove `import { confirmSubmit } from '$lib/confirm'` from the top of `+page.svelte` now — every admin `/feeds` form uses `<details class="confirm-gate">` at this point.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run feeds.render.test.ts source-actions.test.ts`
Expected: all pass.

- [ ] **Step 9: Full web suite + typecheck**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run` and `docker compose exec -T web npm run -w web check`
Expected: all passing, 0 errors/warnings.

- [ ] **Step 10: Commit**

```bash
git add web/src/routes/admin/feeds/+page.svelte web/src/routes/admin/feeds/+page.server.ts web/src/routes/admin/feeds/feeds.render.test.ts web/src/routes/admin/feeds/source-actions.test.ts
git commit -m "$(cat <<'EOF'
feat(admin): retention-driven reap, one form per orphan row

toOrphanRow's retention field already told us whether force would be
needed; the UI now branches on it directly instead of waiting for a
plain-attempt refusal, cutting the reap flow from two round trips to one.
Reap forms also move to the Task 1 reveal-to-confirm pattern.

developed with the help of AI tools
EOF
)"
```

---

### Task 3: Reveal-to-confirm — purge (source detail) + deleteUser (users)

**Files:**
- Modify: `web/src/routes/admin/sources/[sourceId]/+page.svelte`, `web/src/routes/admin/users/+page.svelte`
- Test: `web/src/routes/admin/sources/[sourceId]/source-detail.test.ts`, create `web/src/routes/admin/users/users.render.test.ts`

**Interfaces:**
- Consumes: the `.confirm-gate` pattern from Task 1.
- Produces: nothing later tasks depend on directly (Task 8's bulk-delete-user task touches the same `users/+page.svelte` file but adds new markup alongside this, not depending on its internals beyond "the file uses `.confirm-gate` for its single-row form now").

- [ ] **Step 1: Confirm the baseline**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run` and `docker compose exec -T web npm run -w web check`

- [ ] **Step 2: Read `source-detail.test.ts` fresh to find its render-test conventions**

This file exists but (per its current content) tests the server `load`/`actions`, not component rendering — confirm this by reading it. If it has NO `render(Page, ...)` calls anywhere, purge's markup has no render-test coverage today; add one rather than trying to extend a server-action test with markup assertions.

- [ ] **Step 3: Write the failing render test for purge**

If `source-detail.test.ts` has no render tests, add this new test to it (import `render` from `svelte/server` and the page component, matching `feeds.render.test.ts`'s pattern):

```typescript
import { render } from 'svelte/server'

// ... alongside existing imports

test('the purge form renders a collapsed confirm-gate with the purge consequence, not an always-visible button', async () => {
	vi.resetModules()
	vi.doMock('$app/forms', () => ({ enhance: () => ({}) }))
	const { default: Page } = await import('./+page.svelte')
	const data = {
		sourceId: 's1',
		source: { canonicalUrl: 'https://ex.test/feed.xml', governance: 'blocked', operation: 'paused', attributionMode: 'single_publisher' },
		push: null,
		latestRun: null,
		nonterminalCount: 0,
		conflictCount: 0,
		items: [],
		itemsNextCursor: null,
		purgeEligible: true,
		purgeConsequence: 'Purging permanently deletes all stored versions and evidence for this source — this cannot be undone.',
		categories: ['spam'],
		refreshCommandId: 'refresh-1',
		purgeCommandId: 'purge-1'
	}
	const { body } = render(Page, { props: { data, form: null } } as never)
	const detailsChunk = body.slice(body.indexOf('<details class="confirm-gate"'), body.indexOf('</details>') + '</details>'.length)
	expect(detailsChunk).toContain('Purging permanently deletes')
	expect(detailsChunk).toContain('Confirm purge')
})
```

Check whether `vi.mock`/`vi.doMock` for `$app/forms` is already set up elsewhere in this file (a top-level `vi.mock` can't coexist with a second one) — if the file already has a top-level `vi.mock('$app/forms', ...)`, drop the `vi.doMock`/`vi.resetModules`/dynamic `import` here and use whatever static import the rest of the file already uses.

- [ ] **Step 4: Create `web/src/routes/admin/users/users.render.test.ts`** (no test file exists for this route today)

```typescript
import { test, expect, vi } from 'vitest'
import { render } from 'svelte/server'

vi.mock('$app/forms', () => ({ enhance: () => ({}) }))

const { default: Page } = await import('./+page.svelte')

function baseData(over: Record<string, unknown> = {}) {
	return {
		users: [{ handle: 'alice', kind: 'local', displayName: 'Alice', emailVerified: true, createdAt: '2026-01-01T00:00:00Z', feedUrl: null }],
		cursor: null,
		nextCursor: null,
		...over
	}
}

test('a local user delete form renders a collapsed confirm-gate with the destructive consequence', () => {
	const { body } = render(Page, { props: { data: baseData(), form: null } } as never)
	const detailsChunk = body.slice(body.indexOf('<details class="confirm-gate"'), body.indexOf('</details>') + '</details>'.length)
	expect(detailsChunk).toContain("Delete @alice and all their posts")
	expect(detailsChunk).toContain('Confirm delete')
})

test('a remote user renders no delete affordance at all', () => {
	const { body } = render(Page, { props: { data: baseData({ users: [{ handle: 'bob', kind: 'remote', displayName: 'Bob', emailVerified: null, createdAt: '2026-01-01T00:00:00Z', feedUrl: 'https://bob.example/feed.xml' }] }), form: null } } as never)
	expect(body).not.toContain('confirm-gate')
	expect(body).toContain('—') // the em-dash placeholder for a non-local row's Action cell
})
```

- [ ] **Step 5: Run the new tests to verify they fail**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run source-detail.test.ts users.render.test.ts`
Expected: FAIL — `users.render.test.ts` fails outright (file/markup don't exist as expected), `source-detail.test.ts`'s new test fails on the missing `<details>`.

- [ ] **Step 6: Convert the purge form in `web/src/routes/admin/sources/[sourceId]/+page.svelte`**

Replace (currently lines 148-159):

```svelte
		<form method="POST" action="?/purge" class="source-action destructive" use:enhance={confirmSubmit(`${data.purgeConsequence} Continue?`)}>
			<input type="hidden" name="sourceId" value={data.sourceId} />
			<input type="hidden" name="commandId" value={purgeCommandId} />
			<p class="consequence">{data.purgeConsequence}</p>
			<label class="visually-hidden" for="purge-cat">Moderation category</label>
			<select id="purge-cat" name="category" required>
				{#each data.categories as c (c)}<option value={c}>{c.replace(/_/g, ' ')}</option>{/each}
			</select>
			<label class="visually-hidden" for="purge-note">Note (optional)</label>
			<input id="purge-note" name="note" placeholder="note (optional)" />
			<button aria-label="Purge evidence for {data.source.canonicalUrl}">Purge evidence</button>
		</form>
```

with:

```svelte
		<form method="POST" action="?/purge" class="source-action destructive" use:enhance>
			<input type="hidden" name="sourceId" value={data.sourceId} />
			<input type="hidden" name="commandId" value={purgeCommandId} />
			<label class="visually-hidden" for="purge-cat">Moderation category</label>
			<select id="purge-cat" name="category" required>
				{#each data.categories as c (c)}<option value={c}>{c.replace(/_/g, ' ')}</option>{/each}
			</select>
			<label class="visually-hidden" for="purge-note">Note (optional)</label>
			<input id="purge-note" name="note" placeholder="note (optional)" />
			<details class="confirm-gate">
				<summary><span class="action-name">Purge evidence</span></summary>
				<p class="consequence">{data.purgeConsequence}</p>
				<button aria-label="Confirm purge — {data.source.canonicalUrl}">Confirm purge</button>
			</details>
		</form>
```

Remove `import { confirmSubmit } from '$lib/confirm'` from the top of the file. Add the same `.confirm-gate` CSS block from Task 1 Step 7 to this file's `<style>` (it's a separate `<style>` block from `feeds/+page.svelte`'s — this codebase duplicates page-local styles rather than sharing a global stylesheet fragment, matching the existing `.consequence`/`.source-action` duplication already present in both files).

- [ ] **Step 7: Convert the deleteUser form in `web/src/routes/admin/users/+page.svelte`**

Replace (currently lines 44-52):

```svelte
							<form
								method="POST"
								action="?/deleteUser{data.cursor ? `&cursor=${encodeURIComponent(data.cursor)}` : ''}"
								class="unfollow-form"
								use:enhance={confirmSubmit(`Delete @${u.handle} and all their posts? This can't be undone.`)}
							>
								<input type="hidden" name="handle" value={u.handle} />
								<button type="submit">Delete account</button>
							</form>
```

with:

```svelte
							<form
								method="POST"
								action="?/deleteUser{data.cursor ? `&cursor=${encodeURIComponent(data.cursor)}` : ''}"
								class="unfollow-form"
								use:enhance
							>
								<input type="hidden" name="handle" value={u.handle} />
								<details class="confirm-gate">
									<summary><span class="action-name">Delete account</span></summary>
									<p class="consequence">Delete @{u.handle} and all their posts? This can't be undone.</p>
									<button type="submit" aria-label="Confirm delete — @{u.handle}">Confirm delete</button>
								</details>
							</form>
```

Remove `import { confirmSubmit } from '$lib/confirm'` from the top of the file. This file currently has no `<style>` block of its own (it relies entirely on global classes like `.unfollow-form`, `.table`) — add a minimal scoped `<style>` block with the same `.confirm-gate` rules from Task 1 Step 7, plus `.action-name { font-weight: 600; }` and `.consequence { margin: 0; color: var(--color-secondary); font-size: 0.8125rem; }` (copied from `feeds/+page.svelte`'s existing rules — these two classes don't exist globally, verify with `grep -rn '\.action-name\|\.consequence' web/src/app.css` before assuming otherwise).

- [ ] **Step 8: Run the tests to verify they pass**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run source-detail.test.ts users.render.test.ts`
Expected: all pass.

- [ ] **Step 9: Full web suite + typecheck**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run` and `docker compose exec -T web npm run -w web check`
Expected: all passing, 0 errors/warnings.

- [ ] **Step 10: Commit**

```bash
git add web/src/routes/admin/sources/\[sourceId\]/+page.svelte web/src/routes/admin/sources/\[sourceId\]/source-detail.test.ts web/src/routes/admin/users/+page.svelte web/src/routes/admin/users/users.render.test.ts
git commit -m "$(cat <<'EOF'
feat(admin): inline reveal-to-confirm for purge and delete-account

Same <details>-based pattern as block/unblock/tombstone/reap — one
confirmation, no native popup, works with zero JS. Adds render-test
coverage for /admin/users, which had none before.

developed with the help of AI tools
EOF
)"
```

---

### Task 4: `bulkSource` server action — bulk governance transitions

**Files:**
- Modify: `web/src/routes/admin/feeds/+page.server.ts`
- Test: `web/src/routes/admin/feeds/source-actions.test.ts`

**Interfaces:**
- Consumes: `ACTIONS`, `CATEGORY_OPTIONAL`, `coreError` (all already defined in this file).
- Produces: a new `actions.bulkSource` handler. Request shape: `FormData` with a single `action` field (must be in `ACTIONS` and not `'attribution-mode'`), repeated `sourceId` fields, repeated `commandId` fields (same length and index-alignment as `sourceId`), an optional `category` (required unless the action is pause/resume), an optional `note`. Response shape on success: `{ bulkResults: {sourceId: string, ok: boolean, error?: string}[], bulkAction: string }`. Task 5 (UI) consumes this exact shape to render per-row outcomes.

- [ ] **Step 1: Confirm the baseline**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run` and `docker compose exec -T web npm run -w web check`

- [ ] **Step 2: Write the failing tests**

Add to `web/src/routes/admin/feeds/source-actions.test.ts`, after the existing `source` action tests (after the `"core's two distinct conflicts reach the admin verbatim"` test, before the `establish` tests):

```typescript
test('bulkSource posts the same per-source endpoint once per row, using each row\'s OWN commandId, and returns per-row outcomes', async () => {
	const fetch = vi.fn(async (url: string | URL) => {
		const u = String(url)
		if (u.includes('/s1/quarantine')) return new Response(JSON.stringify({ source: {} }), { status: 200 })
		if (u.includes('/s2/quarantine')) return new Response(JSON.stringify({ error: 'invalid transition' }), { status: 409 })
		throw new Error(`unexpected fetch ${u}`)
	})
	const form = new URLSearchParams()
	form.append('action', 'quarantine')
	form.append('sourceId', 's1')
	form.append('commandId', 'cmd-s1')
	form.append('sourceId', 's2')
	form.append('commandId', 'cmd-s2')
	form.append('category', 'spam')
	const res = (await actions.bulkSource({
		request: new Request('http://x/admin/feeds?/bulkSource', { method: 'POST', body: form }),
		fetch,
		url: new URL('http://x/admin/feeds'),
		cookies
	} as never)) as { bulkResults: { sourceId: string; ok: boolean; error?: string }[]; bulkAction: string }
	expect(res.bulkAction).toBe('quarantine')
	expect(res.bulkResults).toEqual([
		{ sourceId: 's1', ok: true },
		{ sourceId: 's2', ok: false, error: 'invalid transition' }
	])
	expect(fetch).toHaveBeenCalledTimes(2)
	const [s1Url, s1Init] = fetch.mock.calls.find((c) => String(c[0]).includes('/s1/'))! as [string, RequestInit]
	expect(s1Url).toContain('/admin/sources/s1/quarantine')
	expect(JSON.parse(String(s1Init.body))).toEqual({ commandId: 'cmd-s1', category: 'spam' })
})

test('bulkSource refuses attribution-mode and unknown actions without calling core', async () => {
	const fetch = vi.fn()
	for (const action of ['attribution-mode', 'constructor', 'purge']) {
		const form = new URLSearchParams()
		form.append('action', action)
		form.append('sourceId', 's1')
		form.append('commandId', 'cmd-1')
		form.append('category', 'spam')
		const res = await actions.bulkSource({ request: new Request('http://x/admin/feeds?/bulkSource', { method: 'POST', body: form }), fetch, url: new URL('http://x/admin/feeds'), cookies } as never)
		expect(res).toMatchObject({ status: 400 })
	}
	expect(fetch).not.toHaveBeenCalled()
})

test('bulkSource with zero selected sourceIds is a no-op, not an error', async () => {
	const fetch = vi.fn()
	const form = new URLSearchParams()
	form.append('action', 'quarantine')
	const res = (await actions.bulkSource({ request: new Request('http://x/admin/feeds?/bulkSource', { method: 'POST', body: form }), fetch, url: new URL('http://x/admin/feeds'), cookies } as never)) as { bulkResults: unknown[] }
	expect(res.bulkResults).toEqual([])
	expect(fetch).not.toHaveBeenCalled()
})

test('bulkSource refuses a sourceId/commandId length mismatch without calling core', async () => {
	const fetch = vi.fn()
	const form = new URLSearchParams()
	form.append('action', 'quarantine')
	form.append('sourceId', 's1')
	form.append('sourceId', 's2')
	form.append('commandId', 'cmd-1')
	form.append('category', 'spam')
	const res = await actions.bulkSource({ request: new Request('http://x/admin/feeds?/bulkSource', { method: 'POST', body: form }), fetch, url: new URL('http://x/admin/feeds'), cookies } as never)
	expect(res).toMatchObject({ status: 400 })
	expect(fetch).not.toHaveBeenCalled()
})

test('bulkSource requires a category unless every action is pause/resume', async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
	const withoutCategory = new URLSearchParams()
	withoutCategory.append('action', 'quarantine')
	withoutCategory.append('sourceId', 's1')
	withoutCategory.append('commandId', 'cmd-1')
	expect(await actions.bulkSource({ request: new Request('http://x/admin/feeds?/bulkSource', { method: 'POST', body: withoutCategory }), fetch, url: new URL('http://x/admin/feeds'), cookies } as never)).toMatchObject({ status: 400 })

	const pauseForm = new URLSearchParams()
	pauseForm.append('action', 'pause')
	pauseForm.append('sourceId', 's1')
	pauseForm.append('commandId', 'cmd-1')
	const pauseRes = (await actions.bulkSource({ request: new Request('http://x/admin/feeds?/bulkSource', { method: 'POST', body: pauseForm }), fetch, url: new URL('http://x/admin/feeds'), cookies } as never)) as { bulkResults: { ok: boolean }[] }
	expect(pauseRes.bulkResults[0].ok).toBe(true)
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run source-actions.test.ts`
Expected: FAIL — `actions.bulkSource` doesn't exist.

- [ ] **Step 4: Add `bulkSource` to `actions` in `web/src/routes/admin/feeds/+page.server.ts`**

Add after the existing `reap` action (the last entry in the `actions` object, currently ending at line 393):

```typescript
	,
	// Bulk governance transitions across N rows in one submit. Reuses each
	// row's OWN already-minted commandId (from toRow's actions[], the exact
	// same id a lone submit of that row would use) — no new idempotency
	// scheme, no batch-wide id. attribution-mode is excluded: it's the one
	// action needing a per-row-meaningful extra field (the new mode) that
	// doesn't generalize to "the same value for every selected row" without
	// design this spec never scoped.
	bulkSource: async (event) => {
		const form = await event.request.formData()
		const action = String(form.get('action') ?? '')
		const sourceIds = form.getAll('sourceId').map(String)
		const commandIds = form.getAll('commandId').map(String)
		if (!ACTIONS.includes(action as SourceAction) || action === 'attribution-mode') return fail(400, { error: 'unknown or unsupported bulk action' })
		if (sourceIds.length === 0) return { bulkResults: [], bulkAction: action }
		if (sourceIds.length !== commandIds.length) return fail(400, { error: 'sourceId/commandId length mismatch' })
		const category = String(form.get('category') ?? '').trim()
		const note = String(form.get('note') ?? '').trim()
		if (!category && !CATEGORY_OPTIONAL.has(action)) return fail(400, { error: 'a moderation category is required' })
		const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
		const bulkResults = await Promise.all(
			sourceIds.map(async (sourceId, i) => {
				const commandId = commandIds[i]
				try {
					const res = await f(`${base()}/admin/sources/${encodeURIComponent(sourceId)}/${action}`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ commandId, ...(category ? { category } : {}), ...(note ? { note } : {}) })
					})
					if (!res.ok) return { sourceId, ok: false, error: await coreError(res, `${action} failed`) }
					return { sourceId, ok: true }
				} catch (err) {
					return { sourceId, ok: false, error: err instanceof Error ? err.message : `${action} failed` }
				}
			})
		)
		return { bulkResults, bulkAction: action }
	}
```

Note the leading `,` — this is inserted as a new property after `reap: async (event) => {...}` inside the `actions: Actions = {...}` object literal; make sure the `reap` entry's closing `}` is followed by this comma before `bulkSource`, and remove the trailing comma-less closing `}` pattern only if the object literal syntax requires it (read the exact surrounding braces before editing — don't guess at comma placement).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run source-actions.test.ts`
Expected: all pass.

- [ ] **Step 6: Full web suite + typecheck**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run` and `docker compose exec -T web npm run -w web check`
Expected: all passing, 0 errors/warnings.

- [ ] **Step 7: Commit**

```bash
git add web/src/routes/admin/feeds/+page.server.ts web/src/routes/admin/feeds/source-actions.test.ts
git commit -m "$(cat <<'EOF'
feat(admin): bulkSource action for batched governance transitions

Fans out to the same per-source core endpoint the single-item source
action already calls, one call per selected row using that row's own
already-minted commandId — no new idempotency scheme. Partial success is
expected: each row's outcome is reported independently.

developed with the help of AI tools
EOF
)"
```

---

### Task 5: Bulk UI — checkboxes + toolbar for ordinary governance groups

**Files:**
- Modify: `web/src/routes/admin/feeds/+page.svelte`
- Test: `web/src/routes/admin/feeds/feeds.render.test.ts`

**Interfaces:**
- Consumes: `actions.bulkSource` from Task 4 (posts to `?/bulkSource`), the `.confirm-gate` pattern from Task 1.
- Produces: nothing later tasks import — this is leaf UI. Establishes the per-group `$state` selection pattern that Task 7 (orphans/tombstones toolbars) copies.

- [ ] **Step 1: Confirm the baseline**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run` and `docker compose exec -T web npm run -w web check`

- [ ] **Step 2: Write the failing tests**

Add to `feeds.render.test.ts`:

```typescript
test('each row in an ordinary group has a checkbox, and the group renders one always-present bulk toolbar (no-JS baseline)', () => {
	const row = baseRow({ id: 'r1', group: 'user', federationStatus: 'none', memberCounts: undefined })
	const data = {
		groups: [{ key: 'user', title: 'Allowed user sources', blurb: 'blurb text', rows: [row] }],
		expand: null,
		expandedMembers: [],
		tombstones: [],
		tombstoneConsequence: 'nothing restored',
		categories: ['spam'],
		cursor: null,
		nextCursor: null,
		...NO_ORPHANS,
		establishCommandId: 'establish-1'
	}
	const { body } = render(Page, { props: { data, form: null } } as never)
	expect(body).toContain('name="sourceId" value="r1"')
	expect(body).toContain('type="checkbox"')
	// The bulk form posts to ?/bulkSource and is present even with nothing
	// checked — a no-JS submit with zero boxes checked is a defined no-op
	// (Task 4), not a missing affordance.
	expect(body).toContain('action="?/bulkSource')
})

test('the bulk toolbar offers a button per action present on EVERY checked row\'s availableActions (server renders the full set; the intersection narrowing is a client-JS enhancement, not required for no-JS baseline)', () => {
	const row = baseRow({ id: 'r1', group: 'user', federationStatus: 'none', memberCounts: undefined, actions: [{ action: 'quarantine', commandId: 'c1' }, { action: 'block', commandId: 'c2' }] })
	const data = {
		groups: [{ key: 'user', title: 'Allowed user sources', blurb: 'blurb text', rows: [row] }],
		expand: null,
		expandedMembers: [],
		tombstones: [],
		tombstoneConsequence: 'nothing restored',
		categories: ['spam'],
		cursor: null,
		nextCursor: null,
		...NO_ORPHANS,
		establishCommandId: 'establish-1'
	}
	const { body } = render(Page, { props: { data, form: null } } as never)
	const bulkFormChunk = body.slice(body.indexOf('action="?/bulkSource'))
	expect(bulkFormChunk).toContain('value="quarantine"')
})

test('bulk outcome reporting: form.bulkResults renders a per-row outcome line naming each failure', () => {
	const row = baseRow({ id: 'r1', group: 'user', federationStatus: 'none', memberCounts: undefined })
	const data = {
		groups: [{ key: 'user', title: 'Allowed user sources', blurb: 'blurb text', rows: [row] }],
		expand: null,
		expandedMembers: [],
		tombstones: [],
		tombstoneConsequence: 'nothing restored',
		categories: ['spam'],
		cursor: null,
		nextCursor: null,
		...NO_ORPHANS,
		establishCommandId: 'establish-1'
	}
	const form = { bulkResults: [{ sourceId: 'r1', ok: false, error: 'invalid transition' }, { sourceId: 'r2', ok: true }], bulkAction: 'quarantine' }
	const { body } = render(Page, { props: { data, form } } as never)
	expect(body).toContain('r1')
	expect(body).toContain('invalid transition')
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run feeds.render.test.ts`
Expected: FAIL — no checkbox/bulk form markup exists yet.

- [ ] **Step 4: Add per-group selection state and the bulk toolbar markup**

In `web/src/routes/admin/feeds/+page.svelte`'s `<script>` block, add near the top (after the existing `$derived`/`$state` declarations, e.g. after `retryFail`):

```typescript
	// One reactive Set of checked sourceIds per group — plain client-side
	// UI state, never posted directly; the bulk form below reads it only to
	// decide which hidden sourceId/commandId pairs to include. No-JS baseline:
	// the checkboxes are ordinary form inputs and submit correctly with zero
	// JS regardless of this state (browsers track :checked natively).
	let selected: Record<string, Set<string>> = $state({})
	function toggleSelected(groupKey: string, id: string) {
		const set = selected[groupKey] ?? new Set<string>()
		if (set.has(id)) set.delete(id)
		else set.add(id)
		selected = { ...selected, [groupKey]: set }
	}
```

In the `{#each data.groups as group (group.key)}` block, add a checkbox to each row (inside the existing row `<li>`, right after the opening `<div class="feed-info">`'s sibling content — place it as the first child of the `<li>` so it precedes the URL):

Find (inside the `{#each group.rows as row (row.id)}` block, currently starting `<li>` at line 167):

```svelte
						<li>
							<div class="feed-info">
```

Replace with:

```svelte
						<li>
							<label class="row-select visually-hidden">
								<input type="checkbox" name="sourceId" form="bulk-{group.key}" checked={selected[group.key]?.has(row.id) ?? false} onchange={() => toggleSelected(group.key, row.id)} />
								Select {row.url}
							</label>
							<div class="feed-info">
```

Note `form="bulk-{group.key}"` — this checkbox is visually inside the row `<li>`, but its `form` attribute associates it with a `<form id="bulk-{group.key}">` declared once per group (HTML natively supports inputs outside their form's DOM subtree via this attribute, which is what lets the checkbox live in the row while the actual bulk `<form>` lives in the group header, without nesting one `<form>` inside another — forms can't nest).

Replace the group's blurb line (currently `<p class="subnav">{group.blurb}</p>`, in the `{#each data.groups as group (group.key)}` block) with a toolbar that sits in the same position:

```svelte
		<h3>{group.title}</h3>
		<form id="bulk-{group.key}" method="POST" action="?/bulkSource{otherParams() ? `&${otherParams()}` : ''}" class="bulk-bar" use:enhance>
			{#each Array.from(selected[group.key] ?? []) as id (id)}
				{@const r = group.rows.find((gr) => gr.id === id)}
				{#if r}<input type="hidden" name="commandId" value={r.actions[0]?.commandId ?? ''} />{/if}
			{/each}
			<p class="subnav bulk-blurb" class:has-selection={(selected[group.key]?.size ?? 0) > 0}>
				{#if (selected[group.key]?.size ?? 0) > 0}
					{selected[group.key]?.size} selected ·
					{#each [...new Set(group.rows.flatMap((r) => r.actions.map((a) => a.action)))].filter((a) => a !== 'attribution-mode') as actionName (actionName)}
						<button name="action" value={actionName}>{LABEL[actionName]}</button>
					{/each}
					{#if group.rows.some((r) => r.actions.some((a) => a.action !== 'pause' && a.action !== 'resume'))}
						<label class="visually-hidden" for="bulk-cat-{group.key}">Moderation category</label>
						<select id="bulk-cat-{group.key}" name="category" required>
							{#each CATEGORIES as c (c)}<option value={c}>{c.replace('_', ' ')}</option>{/each}
						</select>
					{/if}
				{:else}
					{group.blurb}
				{/if}
			</p>
		</form>
```

Note this Step's `commandId` fields use `r.actions[0]?.commandId` — this is a **known simplification for this task only**: it picks the first action's commandId per selected row rather than the commandId matching the SPECIFIC action button clicked. Fix this in Step 5 below once the action-to-commandId lookup is wired correctly — do not skip that fix, this intermediate shape is wrong and Step 5 corrects it.

- [ ] **Step 5: Fix the commandId lookup to match the clicked action, not the first action**

Replace the hidden-input loop from Step 4:

```svelte
			{#each Array.from(selected[group.key] ?? []) as id (id)}
				{@const r = group.rows.find((gr) => gr.id === id)}
				{#if r}<input type="hidden" name="commandId" value={r.actions[0]?.commandId ?? ''} />{/if}
			{/each}
```

This can't actually know which action will be clicked until the submit happens (multiple `<button name="action" value="...">` share one form) — so it can't pre-pick one commandId per row at render time. Fix: keep a **map** of action → commandId per row as a `data-*` attribute the server reads back is wrong too (data-* isn't submitted). The correct fix is one hidden `sourceId`+`commandId` pair PER (row, action) combination that could be clicked, then have `bulkSource` on the server side only use the pairs whose row actually offers the clicked action — but that submits N×M hidden inputs for nothing.

Simplest correct fix, matching how the single-row forms already work (Task 1): each action already has its OWN commandId per row (`row.actions` is `{action, commandId}[]`). Since the bulk form's action buttons are already scoped to `[...new Set(group.rows.flatMap(r => r.actions.map(a => a.action)))]` (the actions actually available on at least one row), submit a **triple** per (selected row × offered action) as `sourceId`/`commandId`/`forAction` hidden inputs, and let the server filter to just the clicked `action`:

```svelte
			{#each Array.from(selected[group.key] ?? []) as id (id)}
				{@const r = group.rows.find((gr) => gr.id === id)}
				{#each r?.actions ?? [] as a (a.action)}
					<input type="hidden" name="candidate" value="{id}:{a.action}:{a.commandId}" />
				{/each}
			{/each}
```

And in `web/src/routes/admin/feeds/+page.server.ts`'s `bulkSource`, replace the `sourceIds`/`commandIds` parsing:

```typescript
		const sourceIds = form.getAll('sourceId').map(String)
		const commandIds = form.getAll('commandId').map(String)
```

with:

```typescript
		// Each candidate is "sourceId:action:commandId" — one per (selected row
		// × action that row actually offers). Filtering to the clicked `action`
		// here is what lets one <form> hold N different actions' worth of
		// candidates without needing N separate hidden-input passes per click.
		const candidates = form
			.getAll('candidate')
			.map(String)
			.map((c) => {
				const [sourceId, candidateAction, commandId] = c.split(':')
				return { sourceId, candidateAction, commandId }
			})
			.filter((c) => c.candidateAction === action)
		const sourceIds = candidates.map((c) => c.sourceId)
		const commandIds = candidates.map((c) => c.commandId)
```

Update Task 4's tests accordingly: replace every `form.append('sourceId', ...)` / `form.append('commandId', ...)` pair in `source-actions.test.ts`'s new `bulkSource` tests with a single `form.append('candidate', 'sourceId:action:commandId')` per row, e.g. `form.append('candidate', 's1:quarantine:cmd-s1')`. Re-run `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run source-actions.test.ts` after this change and confirm those tests still pass with the new format before continuing — this is a real API shape change from Task 4, caught here in Task 5 while wiring the UI, not a deferred fix.

Note `sourceId` values do still need to be visible to the reader/server for OTHER purposes (e.g., a future audit trail reading raw `sourceId` values) — but for `bulkSource` itself, `candidates` is authoritative; no separate `sourceId`/`commandId` field pair is needed alongside it.

- [ ] **Step 6: Render `form.bulkResults` as a per-row outcome list**

Add below each group's toolbar `<form>` (as a new element right after the closing `</form>` of the bulk toolbar, still inside the `<section>`):

```svelte
			{#if form && 'bulkResults' in form && form.bulkResults?.length}
				<ul class="bulk-outcomes">
					{#each form.bulkResults as r (r.sourceId)}
						<li class:error={!r.ok}>{r.sourceId}: {r.ok ? 'done' : r.error}</li>
					{/each}
				</ul>
			{/if}
```

Extend the `RetryFail`-style loose-shape type near the top of the `<script>` block (find `type RetryFail = {...}`) to include the bulk result shape so this compiles under `svelte-check`:

```typescript
type RetryFail = { sourceId?: string; action?: string; commandId?: string; tombstoneId?: string; force?: boolean; bulkResults?: { sourceId: string; ok: boolean; error?: string }[]; bulkAction?: string }
```

- [ ] **Step 7: Add `.bulk-bar`/`.bulk-outcomes` styling to the `<style>` block**

```css
	.bulk-bar {
		margin: 0 0 var(--space-sm);
	}
	.bulk-blurb.has-selection {
		border-bottom: 2px solid var(--color-border);
		padding-bottom: var(--space-sm);
	}
	.bulk-blurb button {
		background: transparent;
		color: var(--color-foreground);
		border: 1px solid var(--color-border);
		font-size: 0.8125rem;
		padding: 2px var(--space-sm);
	}
	.row-select {
		display: block;
	}
	.bulk-outcomes {
		list-style: none;
		margin: 0 0 var(--space-md);
		padding: 0;
		font-size: 0.8125rem;
	}
	.bulk-outcomes .error {
		color: var(--color-destructive);
	}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run feeds.render.test.ts source-actions.test.ts`
Expected: all pass.

- [ ] **Step 9: Full web suite + typecheck**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run` and `docker compose exec -T web npm run -w web check`
Expected: all passing, 0 errors/warnings.

- [ ] **Step 10: Commit**

```bash
git add web/src/routes/admin/feeds/+page.svelte web/src/routes/admin/feeds/+page.server.ts web/src/routes/admin/feeds/feeds.render.test.ts web/src/routes/admin/feeds/source-actions.test.ts
git commit -m "$(cat <<'EOF'
feat(admin): bulk-action checkboxes and toolbar for governance groups

Checkbox per row (form= attribute associates it with the group's bulk
form without nesting forms), a ruled toolbar in the group header (no
floating element), and per-row outcome reporting after a bulk submit.
Server-side, bulkSource now reads sourceId:action:commandId candidates
so one form can offer several actions without cross-contaminating
commandIds between them.

developed with the help of AI tools
EOF
)"
```

---

### Task 6: `bulkReap` and `bulkTombstone` server actions

**Files:**
- Modify: `web/src/routes/admin/feeds/+page.server.ts`
- Test: `web/src/routes/admin/feeds/source-actions.test.ts`

**Interfaces:**
- Consumes: `toOrphanRow`'s single `commandId`+`retention` shape from Task 2.
- Produces: `actions.bulkReap` — request: repeated `sourceId`/`commandId`/`force` triples (index-aligned three arrays, `force` values are the strings `'true'`/`'false'`). Response: `{ bulkReapResults: {sourceId, ok, error?}[] }`. `actions.bulkTombstone` — request: repeated `tombstoneId`/`commandId` pairs, one `category`, optional `note`. Response: `{ bulkTombstoneResults: {tombstoneId, ok, error?}[] }`. Task 7 (UI) consumes both shapes.

- [ ] **Step 1: Confirm the baseline**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run` and `docker compose exec -T web npm run -w web check`

- [ ] **Step 2: Write the failing tests**

Add to `source-actions.test.ts`, after the existing single-item `reap` tests:

```typescript
test('bulkReap posts per-row force values independently — a mixed batch sends force only for the rows that need it', async () => {
	const fetch = vi.fn(async (url: string | URL) => {
		const u = String(url)
		if (u.includes('/orph1/reap')) return new Response(JSON.stringify({ kind: 'reaped' }), { status: 200 })
		if (u.includes('/orph2/reap')) return new Response(JSON.stringify({ kind: 'reaped' }), { status: 200 })
		throw new Error(`unexpected fetch ${u}`)
	})
	const form = new URLSearchParams()
	form.append('candidate', 'orph1:cmd-orph1:false')
	form.append('candidate', 'orph2:cmd-orph2:true')
	const res = (await actions.bulkReap({ request: new Request('http://x/admin/feeds?/bulkReap', { method: 'POST', body: form }), fetch, url: new URL('http://x/admin/feeds'), cookies } as never)) as { bulkReapResults: { sourceId: string; ok: boolean }[] }
	expect(res.bulkReapResults).toEqual([
		{ sourceId: 'orph1', ok: true },
		{ sourceId: 'orph2', ok: true }
	])
	const [orph1Url, orph1Init] = fetch.mock.calls.find((c) => String(c[0]).includes('orph1'))! as [string, RequestInit]
	expect(JSON.parse(String(orph1Init.body))).toEqual({ commandId: 'cmd-orph1' })
	const [, orph2Init] = fetch.mock.calls.find((c) => String(c[0]).includes('orph2'))! as [string, RequestInit]
	expect(JSON.parse(String(orph2Init.body))).toEqual({ commandId: 'cmd-orph2', force: true })
})

test('bulkReap with zero candidates is a no-op', async () => {
	const fetch = vi.fn()
	const res = (await actions.bulkReap({ request: new Request('http://x/admin/feeds?/bulkReap', { method: 'POST', body: new URLSearchParams() }), fetch, url: new URL('http://x/admin/feeds'), cookies } as never)) as { bulkReapResults: unknown[] }
	expect(res.bulkReapResults).toEqual([])
	expect(fetch).not.toHaveBeenCalled()
})

test('bulkTombstone posts {commandId, category, note} per selected tombstone and reports per-row outcomes', async () => {
	const fetch = vi.fn(async (url: string | URL) => {
		const u = String(url)
		if (u.includes('/t1/unblock')) return new Response(JSON.stringify({ model: 'logical-v2', kind: 'unblocked' }), { status: 200 })
		if (u.includes('/t2/unblock')) return new Response(JSON.stringify({ model: 'logical-v2', error: 'source not blocked' }), { status: 409 })
		throw new Error(`unexpected fetch ${u}`)
	})
	const form = new URLSearchParams()
	form.append('candidate', 't1:cmd-t1')
	form.append('candidate', 't2:cmd-t2')
	form.append('category', 'remediated')
	form.append('note', 'appeal upheld')
	const res = (await actions.bulkTombstone({ request: new Request('http://x/admin/feeds?/bulkTombstone', { method: 'POST', body: form }), fetch, url: new URL('http://x/admin/feeds'), cookies } as never)) as { bulkTombstoneResults: { tombstoneId: string; ok: boolean; error?: string }[] }
	expect(res.bulkTombstoneResults).toEqual([
		{ tombstoneId: 't1', ok: true },
		{ tombstoneId: 't2', ok: false, error: 'source not blocked' }
	])
	const [, t1Init] = fetch.mock.calls.find((c) => String(c[0]).includes('t1'))! as [string, RequestInit]
	expect(JSON.parse(String(t1Init.body))).toEqual({ commandId: 'cmd-t1', category: 'remediated', note: 'appeal upheld' })
})

test('bulkTombstone refuses a missing category without calling core', async () => {
	const fetch = vi.fn()
	const form = new URLSearchParams()
	form.append('candidate', 't1:cmd-t1')
	const res = await actions.bulkTombstone({ request: new Request('http://x/admin/feeds?/bulkTombstone', { method: 'POST', body: form }), fetch, url: new URL('http://x/admin/feeds'), cookies } as never)
	expect(res).toMatchObject({ status: 400 })
	expect(fetch).not.toHaveBeenCalled()
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run source-actions.test.ts`
Expected: FAIL — `actions.bulkReap`/`actions.bulkTombstone` don't exist.

- [ ] **Step 4: Add `bulkReap` and `bulkTombstone` to `actions`**

Add after `bulkSource` (from Task 4/5):

```typescript
	,
	// Bulk reap: per-row force, never a batch-wide toggle — each candidate
	// already carries the force value §2's retention-driven UI decided for
	// that specific row (Task 7 renders it), so there is nothing to
	// re-derive here, only to apply.
	bulkReap: async (event) => {
		const form = await event.request.formData()
		const candidates = form
			.getAll('candidate')
			.map(String)
			.map((c) => {
				const [sourceId, commandId, force] = c.split(':')
				return { sourceId, commandId, force: force === 'true' }
			})
		if (candidates.length === 0) return { bulkReapResults: [] }
		const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
		const bulkReapResults = await Promise.all(
			candidates.map(async ({ sourceId, commandId, force }) => {
				try {
					const res = await f(`${base()}/admin/sources/${encodeURIComponent(sourceId)}/reap`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ commandId, ...(force ? { force: true } : {}) })
					})
					if (!res.ok) return { sourceId, ok: false, error: await coreError(res, 'reap failed') }
					return { sourceId, ok: true }
				} catch (err) {
					return { sourceId, ok: false, error: err instanceof Error ? err.message : 'reap failed' }
				}
			})
		)
		return { bulkReapResults }
	},
	// Bulk tombstone-unblock: same commandId-reuse posture as bulkSource —
	// each tombstone row already carries its own commandId from load.
	bulkTombstone: async (event) => {
		const form = await event.request.formData()
		const candidates = form
			.getAll('candidate')
			.map(String)
			.map((c) => {
				const [tombstoneId, commandId] = c.split(':')
				return { tombstoneId, commandId }
			})
		if (candidates.length === 0) return { bulkTombstoneResults: [] }
		const category = String(form.get('category') ?? '').trim()
		const note = String(form.get('note') ?? '').trim()
		if (!category) return fail(400, { error: 'a moderation category is required' })
		const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
		const bulkTombstoneResults = await Promise.all(
			candidates.map(async ({ tombstoneId, commandId }) => {
				let outcome
				try {
					outcome = await unblockTombstone(f, tombstoneId, { commandId, category, ...(note ? { note } : {}) })
				} catch (err) {
					return { tombstoneId, ok: false, error: err instanceof Error ? err.message : 'unblock failed' }
				}
				if (outcome.kind === 'unavailable') return { tombstoneId, ok: false, error: 'unavailable' }
				if (outcome.kind === 'conflict') return { tombstoneId, ok: false, error: outcome.error }
				return { tombstoneId, ok: true }
			})
		)
		return { bulkTombstoneResults }
	}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run source-actions.test.ts`
Expected: all pass.

- [ ] **Step 6: Full web suite + typecheck**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run` and `docker compose exec -T web npm run -w web check`
Expected: all passing, 0 errors/warnings.

- [ ] **Step 7: Commit**

```bash
git add web/src/routes/admin/feeds/+page.server.ts web/src/routes/admin/feeds/source-actions.test.ts
git commit -m "$(cat <<'EOF'
feat(admin): bulkReap and bulkTombstone server actions

bulkReap carries per-row force (from each row's own already-decided
retention state, per Task 2) instead of one batch-wide flag — a mixed
selection of reapable and force-needed orphans reaps correctly in one
submit. bulkTombstone reuses each tombstone row's own commandId, same
posture as bulkSource.

developed with the help of AI tools
EOF
)"
```

---

### Task 7: Bulk UI — orphans + tombstones toolbars

**Files:**
- Modify: `web/src/routes/admin/feeds/+page.svelte`
- Test: `web/src/routes/admin/feeds/feeds.render.test.ts`

**Interfaces:**
- Consumes: `actions.bulkReap`/`actions.bulkTombstone` from Task 6, the `selected`/`toggleSelected` pattern from Task 5 (extended with two more keys: `'orphans'` and `'tombstones'`), the `.confirm-gate` pattern from Task 1.

- [ ] **Step 1: Confirm the baseline**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run` and `docker compose exec -T web npm run -w web check`

- [ ] **Step 2: Write the failing tests**

```typescript
test('orphan rows each have a checkbox and the section renders an always-present bulk-reap form', () => {
	const { body } = render(Page, { props: { data: orphanData(), form: null } } as never)
	const orphanSection = body.slice(body.indexOf('Orphaned sources'))
	expect(orphanSection).toContain('type="checkbox"')
	expect(orphanSection).toContain('action="?/bulkReap')
})

test('bulk reap consequence text is pluralized and mixes plain/force wording when the selection mixes retentions', () => {
	const data = orphanData({
		orphanRows: [orphanRow({ id: 'orph1', retention: 'reapable' }), orphanRow({ id: 'orph2', retention: 'audit_history' })]
	})
	// Selection state is client-only ($state); render with both boxes
	// pre-checked isn't reachable through the data prop alone in an SSR
	// test — instead assert the STATIC per-row force encoding the bulk form
	// depends on is present for both rows regardless of selection, since
	// that's what the client-side toggle reads at click time.
	const { body } = render(Page, { props: { data, form: null } } as never)
	const orphanSection = body.slice(body.indexOf('Orphaned sources'))
	expect(orphanSection).toContain('orph1:orph-cmd-1:false')
	expect(orphanSection).toContain('orph2:orph-cmd-1:true')
})

test('tombstone rows each have a checkbox and the section renders an always-present bulk-unblock form', () => {
	const data = {
		groups: [],
		expand: null,
		expandedMembers: [],
		tombstones: [{ id: 't1', canonicalUrl: 'https://gone.test/t1.xml', action: 'block', category: 'spam', note: '', createdAt: '2026-07-01T00:00:00Z', aliases: [], commandId: 'tomb-cmd-1' }],
		tombstoneConsequence: 'nothing restored',
		categories: ['spam'],
		cursor: null,
		nextCursor: null,
		...NO_ORPHANS,
		establishCommandId: 'establish-1'
	}
	const { body } = render(Page, { props: { data, form: null } } as never)
	const tombstoneSection = body.slice(body.indexOf('Blocked and tombstoned URLs'))
	expect(tombstoneSection).toContain('type="checkbox"')
	expect(tombstoneSection).toContain('action="?/bulkTombstone')
})
```

Note the second test above expects `orph2:orph-cmd-1:true` — the `orphanRow` fixture always uses `commandId: 'orph-cmd-1'` regardless of `id` (check the fixture from Task 2 Step 3); adjust the exact expected string to match whatever id/commandId combination the fixture actually produces once you've re-read it, don't assume the literal string without checking.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run feeds.render.test.ts`
Expected: FAIL — no orphan/tombstone checkboxes or bulk forms exist yet.

- [ ] **Step 4: Add the orphan bulk-reap toolbar**

In the orphan section's `<ul class="following-list source-list">` (from Task 2's rewrite), add a checkbox to each `<li>` (same `form="bulk-orphans"` pattern as Task 5):

```svelte
					<li>
						<label class="row-select visually-hidden">
							<input type="checkbox" form="bulk-orphans" checked={selected.orphans?.has(row.id) ?? false} onchange={() => toggleSelected('orphans', row.id)} />
							Select {row.url}
						</label>
						<div class="feed-info">
```

(replacing the plain `<li>` opening — same edit shape as Task 5 Step 4, applied to this section's rows.)

Add the toolbar right after the orphan section's `<p class="subnav">` blurb (currently `'Allowed, unsubscribed, and not federated...'`):

```svelte
		<form id="bulk-orphans" method="POST" action="?/bulkReap{otherParams() ? `&${otherParams()}` : ''}" class="bulk-bar" use:enhance>
			{#each data.orphanRows as row (row.id)}
				{@const needsForce = row.retention !== null && row.retention !== 'reapable'}
				<input type="hidden" name="candidate" value="{row.id}:{row.commandId}:{needsForce}" />
			{/each}
			<p class="subnav bulk-blurb" class:has-selection={(selected.orphans?.size ?? 0) > 0}>
				{#if (selected.orphans?.size ?? 0) > 0}
					<details class="confirm-gate">
						<summary><span class="action-name">Reap {selected.orphans?.size} selected</span></summary>
						<p class="consequence">
							Reaping {selected.orphans?.size} source{selected.orphans?.size === 1 ? '' : 's'} permanently deletes each one and its evidence.
							{#if data.orphanRows.some((r) => selected.orphans?.has(r.id) && r.retention !== null && r.retention !== 'reapable')}
								Some of the selected sources override retained evidence — that evidence is removed permanently too. This cannot be undone.
							{:else}
								This cannot be undone.
							{/if}
						</p>
						<button>Confirm reap selected</button>
					</details>
				{/if}
			</p>
		</form>
```

Note: since every candidate is always present in the DOM (no-JS baseline — Global Constraints), the server-side `bulkReap` action receives ALL orphan rows' candidates on every submit of this form, not just the checked ones. **This is a bug if left as-is** — fix it now, not later: the checkboxes must actually control which candidates get submitted. Replace the unconditional `{#each data.orphanRows as row (row.id)}` hidden-input loop with real per-row hidden inputs bound to the SAME checkbox, using the checkbox's own `name`/`value` instead of an unconditional hidden input:

```svelte
					<li>
						<label class="row-select visually-hidden">
							<input type="checkbox" form="bulk-orphans" name="candidate" value="{row.id}:{row.commandId}:{row.retention !== null && row.retention !== 'reapable'}" checked={selected.orphans?.has(row.id) ?? false} onchange={() => toggleSelected('orphans', row.id)} />
							Select {row.url}
						</label>
						<div class="feed-info">
```

and delete the `{#each data.orphanRows as row (row.id)} <input type="hidden" name="candidate" .../> {/each}` loop from the toolbar `<form>` entirely — the checkbox itself now IS the `candidate` input (an unchecked checkbox submits nothing, which is exactly the semantics needed). Apply this same correction retroactively to Task 5's ordinary-group checkboxes: re-open `web/src/routes/admin/feeds/+page.svelte` and check whether Task 5 Step 4/5 left a separate unconditional hidden-input loop alongside the checkbox — if so, that has the identical bug (every row's candidates submit regardless of checked state). Fix Task 5's version the same way: the checkbox itself carries `name="candidate" value="{id}:{action}:{commandId}"` — but Task 5's rows offer MULTIPLE actions per row, so one checkbox can't carry N action-specific candidate values. Resolve this by keeping Task 5's checkbox as a plain selection toggle (`name="sourceId"`, as originally written) and instead making the CANDIDATE hidden inputs conditional on `$state`, not unconditional:

```svelte
			{#each Array.from(selected[group.key] ?? []) as id (id)}
				{@const r = group.rows.find((gr) => gr.id === id)}
				{#each r?.actions ?? [] as a (a.action)}
					<input type="hidden" name="candidate" value="{id}:{a.action}:{a.commandId}" />
				{/each}
			{/each}
```

This IS conditional — it iterates `selected[group.key]` (the reactive Set), not `group.rows` — so only checked rows' candidates render. Re-verify this is what Task 5 Step 5 actually produced (it should be, re-read it); if Task 5 was implemented with an unconditional `{#each group.rows ...}` instead, fix it to iterate `Array.from(selected[group.key] ?? [])` as shown here before continuing this task. The orphan section above is the one place this task introduces fresh markup, and unlike the multi-action ordinary groups, one orphan row maps to exactly one candidate value — so the checkbox-as-candidate-input shape (no separate hidden input) is correct and simpler there; use it for orphans specifically, and confirm Task 5's reactive-Set-iteration shape (not checkbox-as-candidate) for the ordinary groups, since those need the extra action dimension a bare checkbox can't carry.

- [ ] **Step 5: Add the tombstone bulk-unblock toolbar**

In the tombstone section's `<ul class="following-list source-list">`, add a checkbox to each `<li>`:

```svelte
				{#each data.tombstones as t (t.id)}
					{@const retryCommandId = retryFail?.tombstoneId === t.id ? retryFail.commandId : undefined}
					{@const tombstoneQs = otherParams()}
					<li>
						<label class="row-select visually-hidden">
							<input type="checkbox" form="bulk-tombstones" name="candidate" value="{t.id}:{t.commandId}" checked={selected.tombstones?.has(t.id) ?? false} onchange={() => toggleSelected('tombstones', t.id)} />
							Select {t.canonicalUrl}
						</label>
						<div class="feed-info">
```

Add the toolbar after the tombstone section's `<p class="subnav">` blurb:

```svelte
		<form id="bulk-tombstones" method="POST" action="?/bulkTombstone" class="bulk-bar" use:enhance>
			<p class="subnav bulk-blurb" class:has-selection={(selected.tombstones?.size ?? 0) > 0}>
				{#if (selected.tombstones?.size ?? 0) > 0}
					<label class="visually-hidden" for="bulk-tomb-cat">Moderation category</label>
					<select id="bulk-tomb-cat" name="category" required>
						{#each data.categories as c (c)}<option value={c}>{c.replace(/_/g, ' ')}</option>{/each}
					</select>
					<details class="confirm-gate">
						<summary><span class="action-name">Unblock {selected.tombstones?.size} selected</span></summary>
						<p class="consequence">{data.tombstoneConsequence}</p>
						<button>Confirm unblock selected</button>
					</details>
				{/if}
			</p>
		</form>
```

- [ ] **Step 6: Render `bulkReapResults`/`bulkTombstoneResults` outcome lists**

Same pattern as Task 5 Step 6, placed after each respective toolbar `<form>`:

```svelte
			{#if form && 'bulkReapResults' in form && form.bulkReapResults?.length}
				<ul class="bulk-outcomes">
					{#each form.bulkReapResults as r (r.sourceId)}<li class:error={!r.ok}>{r.sourceId}: {r.ok ? 'reaped' : r.error}</li>{/each}
				</ul>
			{/if}
```

```svelte
			{#if form && 'bulkTombstoneResults' in form && form.bulkTombstoneResults?.length}
				<ul class="bulk-outcomes">
					{#each form.bulkTombstoneResults as r (r.tombstoneId)}<li class:error={!r.ok}>{r.tombstoneId}: {r.ok ? 'unblocked' : r.error}</li>{/each}
				</ul>
			{/if}
```

Extend the `RetryFail`-style type again (from Task 5 Step 6) to include `bulkReapResults`/`bulkTombstoneResults`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run feeds.render.test.ts source-actions.test.ts`
Expected: all pass.

- [ ] **Step 8: Full web suite + typecheck**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run` and `docker compose exec -T web npm run -w web check`
Expected: all passing, 0 errors/warnings.

- [ ] **Step 9: Commit**

```bash
git add web/src/routes/admin/feeds/+page.svelte web/src/routes/admin/feeds/feeds.render.test.ts
git commit -m "$(cat <<'EOF'
feat(admin): bulk-reap and bulk-tombstone-unblock toolbars

Orphan and tombstone rows get the same checkbox+toolbar treatment as the
ordinary governance groups. Bulk reap's confirm text reflects a mixed
selection (some plain, some overriding retained evidence) rather than
one generic sentence for both.

developed with the help of AI tools
EOF
)"
```

---

### Task 8: Bulk delete-user

**Files:**
- Modify: `web/src/routes/admin/users/+page.svelte`, `web/src/routes/admin/users/+page.server.ts`
- Test: `web/src/routes/admin/users/users.render.test.ts`, create `web/src/routes/admin/users/users-actions.test.ts`

**Interfaces:**
- Consumes: the `.confirm-gate` pattern (Task 1/3), the checkbox+toolbar pattern (Task 5).
- Produces: `actions.bulkDelete` in `users/+page.server.ts` — request: repeated `handle` fields (no `commandId` — `deleteLocalAccount` has none today, matches the single-item posture exactly, per spec rev 3). Response: `{ bulkDeleteResults: {handle, ok, error?}[] }`.

- [ ] **Step 1: Confirm the baseline**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run` and `docker compose exec -T web npm run -w web check`

- [ ] **Step 2: Write the failing server-action test (new file)**

Create `web/src/routes/admin/users/users-actions.test.ts`:

```typescript
import { test, expect, vi } from 'vitest'
import { actions } from './+page.server.ts'

const cookies = { getAll: () => [{ name: 'rsc.session_token', value: 's1' }] }

function formEvent(fields: Record<string, string[] | string>, fetch: ReturnType<typeof vi.fn>) {
	const form = new URLSearchParams()
	for (const [k, v] of Object.entries(fields)) for (const val of Array.isArray(v) ? v : [v]) form.append(k, val)
	return {
		request: new Request('http://x/admin/users?/bulkDelete', { method: 'POST', body: form }),
		fetch,
		url: new URL('http://x/admin/users'),
		cookies
	}
}

test('bulkDelete deletes each selected handle independently and reports per-row outcomes', async () => {
	const fetch = vi.fn(async (url: string | URL) => {
		const u = String(url)
		if (u.includes('/users/alice')) return new Response(null, { status: 204 })
		if (u.includes('/users/bob')) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
		throw new Error(`unexpected fetch ${u}`)
	})
	const res = (await actions.bulkDelete(formEvent({ handle: ['alice', 'bob'] }, fetch) as never)) as { bulkDeleteResults: { handle: string; ok: boolean; error?: string }[] }
	expect(res.bulkDeleteResults).toEqual([
		{ handle: 'alice', ok: true },
		{ handle: 'bob', ok: false, error: 'not found' }
	])
})

test('bulkDelete with zero selected handles is a no-op', async () => {
	const fetch = vi.fn()
	const res = (await actions.bulkDelete(formEvent({}, fetch) as never)) as { bulkDeleteResults: unknown[] }
	expect(res.bulkDeleteResults).toEqual([])
	expect(fetch).not.toHaveBeenCalled()
})
```

Read `web/src/lib/api.ts:126-129`'s `deleteLocalAccount` first to confirm its exact error-surfacing shape (`errorMessage(res, 'deleteLocalAccount failed')`) before assuming the `{error: 'not found'}` body round-trips as `'not found'` verbatim — adjust the test's expected string to match whatever `errorMessage` actually extracts if it differs from a plain passthrough.

- [ ] **Step 3: Write the failing render test**

Add to `web/src/routes/admin/users/users.render.test.ts`:

```typescript
test('local user rows each have a checkbox and the page renders an always-present bulk-delete form', () => {
	const { body } = render(Page, { props: { data: baseData(), form: null } } as never)
	expect(body).toContain('action="?/bulkDelete')
	expect(body).toContain('type="checkbox"')
})
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run users-actions.test.ts users.render.test.ts`
Expected: FAIL — `actions.bulkDelete` doesn't exist, no bulk markup.

- [ ] **Step 5: Add `bulkDelete` to `web/src/routes/admin/users/+page.server.ts`**

Replace the `actions` export (currently lines 13-26):

```typescript
export const actions: Actions = {
	deleteUser: async (event) => {
		const form = await event.request.formData()
		const handle = String(form.get('handle') ?? '').trim()
		if (!handle) return fail(400, { error: 'handle required' })
		try {
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			await deleteLocalAccount(f, handle)
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'delete failed' })
		}
		return { deleted: true }
	},
}
```

with:

```typescript
export const actions: Actions = {
	deleteUser: async (event) => {
		const form = await event.request.formData()
		const handle = String(form.get('handle') ?? '').trim()
		if (!handle) return fail(400, { error: 'handle required' })
		try {
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			await deleteLocalAccount(f, handle)
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'delete failed' })
		}
		return { deleted: true }
	},
	// No commandId — deleteLocalAccount has none today (verified: it's a
	// plain DELETE with no idempotency body), so bulk matches that posture
	// exactly rather than inventing one.
	bulkDelete: async (event) => {
		const form = await event.request.formData()
		const handles = form.getAll('handle').map(String)
		if (handles.length === 0) return { bulkDeleteResults: [] }
		const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
		const bulkDeleteResults = await Promise.all(
			handles.map(async (handle) => {
				try {
					await deleteLocalAccount(f, handle)
					return { handle, ok: true }
				} catch (err) {
					return { handle, ok: false, error: err instanceof Error ? err.message : 'delete failed' }
				}
			})
		)
		return { bulkDeleteResults }
	}
}
```

- [ ] **Step 6: Add checkboxes and the bulk toolbar to `web/src/routes/admin/users/+page.svelte`**

Read the file fresh (it changed in Task 3). Add `<script>`-level selection state (same shape as Task 5 Step 4, but flat — this page has one table, no groups):

```typescript
	let selected: Set<string> = $state(new Set())
	function toggleSelected(handle: string) {
		const next = new Set(selected)
		if (next.has(handle)) next.delete(handle)
		else next.add(handle)
		selected = next
	}
```

Add a checkbox column. Find the table header row (`<tr><th>Handle</th>...`) and add a leading `<th>`:

```svelte
				<tr><th class="visually-hidden">Select</th><th>Handle</th><th>Kind</th><th>Name</th><th>Verified</th><th>Joined</th><th>Feed</th><th>Action</th></tr>
```

Find each row's opening (`<tr>` inside `{#each data.users as u (u.handle)}`) and add a leading `<td>`:

```svelte
					<tr>
						<td data-label="Select">
							{#if u.kind === 'local'}
								<input type="checkbox" form="bulk-delete-users" name="handle" value={u.handle} checked={selected.has(u.handle)} onchange={() => toggleSelected(u.handle)} />
							{/if}
						</td>
						<td data-label="Handle">@{u.handle}</td>
```

Add the bulk-delete toolbar right after the table's closing `</table>` (still inside the `{:else}` branch that renders when `data.users.length > 0`):

```svelte
	<form id="bulk-delete-users" method="POST" action="?/bulkDelete{data.cursor ? `&cursor=${encodeURIComponent(data.cursor)}` : ''}" class="bulk-bar" use:enhance>
		<p class="subnav bulk-blurb" class:has-selection={selected.size > 0}>
			{#if selected.size > 0}
				<details class="confirm-gate">
					<summary><span class="action-name">Delete {selected.size} selected</span></summary>
					<p class="consequence">Delete {selected.size} account{selected.size === 1 ? '' : 's'} and all their posts? This can't be undone.</p>
					<button>Confirm delete selected</button>
				</details>
			{/if}
		</p>
	</form>
	{#if form && 'bulkDeleteResults' in form && form.bulkDeleteResults?.length}
		<ul class="bulk-outcomes">
			{#each form.bulkDeleteResults as r (r.handle)}<li class:error={!r.ok}>@{r.handle}: {r.ok ? 'deleted' : r.error}</li>{/each}
		</ul>
	{/if}
```

Update the page's `ActionData`-adjacent typing (`let { data, form }: { data: PageData; form: ActionData } = $props()`) — since `bulkDeleteResults` is a new shape the generated `ActionData` union will already cover once `bulkDelete`'s return type is inferred from Step 5's server change, no manual type annotation is needed here (matches how `deleted`/`error` are already handled without a manual cast in this file today — confirm this by running `svelte-check` in Step 8; if it complains about `form.bulkDeleteResults`'s type, add a narrow local type alias the same way `feeds/+page.svelte`'s `RetryFail` does, don't skip the error).

Add `.bulk-bar`/`.bulk-outcomes`/`.confirm-gate` CSS to this file's `<style>` block (added in Task 3 Step 7) — reuse the exact rules from Task 5 Step 7.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run users-actions.test.ts users.render.test.ts`
Expected: all pass.

- [ ] **Step 8: Full web suite + typecheck**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run` and `docker compose exec -T web npm run -w web check`
Expected: all passing, 0 errors/warnings.

- [ ] **Step 9: Commit**

```bash
git add web/src/routes/admin/users/+page.svelte web/src/routes/admin/users/+page.server.ts web/src/routes/admin/users/users.render.test.ts web/src/routes/admin/users/users-actions.test.ts
git commit -m "$(cat <<'EOF'
feat(admin): bulk delete-account for local users

Matches deleteUser's existing no-commandId posture exactly rather than
inventing idempotency for a path that never had it. Adds server-action
test coverage for /admin/users, which had none before this plan.

developed with the help of AI tools
EOF
)"
```

---

### Task 9: Route consolidation — inline `?detail=` source panel

**Files:**
- Create: `web/src/lib/server/source-detail.ts`
- Modify: `web/src/routes/admin/sources/[sourceId]/+page.server.ts`, `web/src/routes/admin/feeds/+page.server.ts`, `web/src/routes/admin/feeds/+page.svelte`
- Test: `web/src/routes/admin/sources/[sourceId]/source-detail.test.ts`, `web/src/routes/admin/feeds/source-actions.test.ts`, `web/src/routes/admin/feeds/feeds.render.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1-8 beyond the already-landed `.confirm-gate` pattern (the inlined panel's refresh/purge forms use it).
- Produces: `loadSourceDetail(fetch, origin, cookies, sourceId, itemsBefore)` — exported from the new `web/src/lib/server/source-detail.ts`, returns `Promise<SourceDetail | null>` (the exact same shape `sources/[sourceId]/+page.server.ts`'s `load` returns today, minus `sourceId`/the two commandId fields, which the caller adds). Both `sources/[sourceId]/+page.server.ts` and `feeds/+page.server.ts` call it.

- [ ] **Step 1: Confirm the baseline**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run` and `docker compose exec -T web npm run -w web check`

- [ ] **Step 2: Write the failing test for the extracted module**

Create a focused unit test inline in `source-detail.test.ts` (add to the existing file — read it first to match its existing fixture conventions before adding):

```typescript
import { loadSourceDetail } from '$lib/server/source-detail'

test('loadSourceDetail returns null for an unknown source, same 404-as-null contract the route load used to have inline', async () => {
	const fetch = vi.fn(async () => new Response(null, { status: 404 }))
	const result = await loadSourceDetail(fetch, 'http://x', cookies, 'missing', null)
	expect(result).toBeNull()
})

test('loadSourceDetail returns the full detail shape for a known source', async () => {
	const fetch = vi.fn(async (url: string | URL) => {
		const u = String(url)
		if (u.includes('/admin/sources/s1/runs')) return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 })
		if (u.includes('/admin/sources/s1/items')) return new Response(JSON.stringify({ model: 'logical-v2', items: [], nextCursor: null, conflictCount: 0 }), { status: 200 })
		if (u.includes('/admin/sources/s1')) return new Response(JSON.stringify({ source: { id: 's1', canonicalUrl: 'https://ex.test/feed.xml', attributionMode: 'single_publisher', operation: 'enabled', governance: 'blocked' } }), { status: 200 })
		throw new Error(`unexpected fetch ${u}`)
	})
	const result = await loadSourceDetail(fetch, 'http://x', cookies, 's1', null)
	expect(result?.source.canonicalUrl).toBe('https://ex.test/feed.xml')
	expect(result?.purgeEligible).toBe(true) // blocked ⇒ purge-eligible
	expect(result?.refreshCommandId).toMatch(/^[0-9a-f]{8}-/)
	expect(result?.purgeCommandId).toMatch(/^[0-9a-f]{8}-/)
})
```

Check whether `cookies` is already defined at the top of `source-detail.test.ts` (it likely is, matching `source-actions.test.ts`'s convention) — reuse it, don't redeclare.

- [ ] **Step 3: Write the failing tests for the feeds-list `?detail=` wiring**

Add to `web/src/routes/admin/feeds/source-actions.test.ts`:

```typescript
test('?detail=<id> inlines that source\'s detail panel data into the feeds load result', async () => {
	const fetch = vi.fn(async (url: string | URL) => {
		const u = String(url)
		if (u.includes('filter=orphan') || u.includes('filter=governance')) return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 })
		if (u.includes('/admin/tombstones')) return new Response(JSON.stringify({ model: 'logical-v2', tombstones: [] }), { status: 200 })
		if (u.includes('/admin/sources/s1/runs')) return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 })
		if (u.includes('/admin/sources/s1/items')) return new Response(JSON.stringify({ model: 'logical-v2', items: [], nextCursor: null, conflictCount: 0 }), { status: 200 })
		if (u.includes('/admin/sources/s1')) return new Response(JSON.stringify({ source: { id: 's1', canonicalUrl: 'https://ex.test/feed.xml', attributionMode: 'single_publisher', operation: 'enabled', governance: 'allowed' } }), { status: 200 })
		return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 })
	})
	const result = (await loadAdminWith(fetch, '?detail=s1')) as LoadResult & { detail?: { sourceId: string; source: { canonicalUrl: string } } | null }
	expect(result.detail?.sourceId).toBe('s1')
	expect(result.detail?.source.canonicalUrl).toBe('https://ex.test/feed.xml')
})

test('no ?detail= on the request omits the detail fetches and echoes detail: null', async () => {
	const fetch = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 }))
	const result = (await loadAdminWith(fetch)) as LoadResult & { detail?: unknown }
	expect(result.detail).toBeNull()
	expect(urlsOf(fetch).some((u) => u.includes('/runs') || u.includes('/items'))).toBe(false)
})
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run source-detail.test.ts source-actions.test.ts`
Expected: FAIL — `$lib/server/source-detail` doesn't exist, `?detail=` isn't wired.

- [ ] **Step 5: Extract `loadSourceDetail` into `web/src/lib/server/source-detail.ts`**

Read `web/src/routes/admin/sources/[sourceId]/+page.server.ts` fresh (its current content: `PURGE_CONSEQUENCE`, `SourceGovernance`, `SourcePush`, `sourceGovernance`, and the `load` function, currently lines 1-91). Create the new file with everything except the route-specific `params.sourceId`/`error(404,...)` wrapping:

```typescript
import { authedFetch, base, cookieHeader } from './session'
import { listSourceRuns, listSourceItems } from '$lib/logical-api'
import { AUDIT_CATEGORIES } from '$lib/logical-types'
import type { Cookies } from '@sveltejs/kit'
import type { AdminRunProjection } from '$lib/logical-api'

// Purge's consequence is DISTINCT from unblock's: it permanently deletes the
// source's stored evidence, but the URL STAYS blocked by its tombstone (purge does
// NOT lift the block). Kept here (testable) beside the load, not only in the
// .svelte, so a rewrite to a generic "Are you sure?" fails a test.
const PURGE_CONSEQUENCE =
	'Purging permanently deletes all stored versions and evidence for this source — this cannot be undone. The URL stays blocked by its tombstone; purge does not restore anything or lift the block.'

interface SourceGovernance {
	id: string
	canonicalUrl: string
	attributionMode: string
	operation: 'enabled' | 'paused'
	governance: 'allowed' | 'quarantined' | 'blocked'
}

interface SourcePush {
	mode: 'websub' | 'rsscloud'
	state: 'pending' | 'active'
	expiresAt: string | null
}

async function sourceGovernance(f: typeof fetch, id: string): Promise<{ source: SourceGovernance; push: SourcePush | null } | null> {
	const res = await f(`${base()}/admin/sources/${encodeURIComponent(id)}`)
	if (res.status === 404) return null
	if (!res.ok) throw new Error(`source ${res.status}`)
	const body = (await res.json()) as { source: SourceGovernance; push?: Partial<SourcePush>; pushExpiresAt?: string | null }
	const s = body.source
	const p = body.push
	return {
		source: { id: s.id, canonicalUrl: s.canonicalUrl, attributionMode: s.attributionMode, operation: s.operation, governance: s.governance },
		push: p && p.mode && p.state ? { mode: p.mode, state: p.state, expiresAt: body.pushExpiresAt ?? null } : null
	}
}

export interface SourceDetail {
	sourceId: string
	source: SourceGovernance
	push: SourcePush | null
	latestRun: AdminRunProjection | null
	nonterminalCount: number
	conflictCount: number
	items: Awaited<ReturnType<typeof listSourceItems>>['items']
	itemsNextCursor: string | null
	purgeEligible: boolean
	purgeConsequence: string
	categories: readonly string[]
	refreshCommandId: string
	purgeCommandId: string
}

// Shared by the standalone /admin/sources/[sourceId] route AND the inline
// ?detail= panel on /admin/feeds — same reads, same shape, never a
// re-derivation (Task 9, admin redesign spec Component 4).
export async function loadSourceDetail(fetch: typeof globalThis.fetch, origin: string, cookies: Cookies, sourceId: string, itemsBefore: string | null): Promise<SourceDetail | null> {
	const f = authedFetch(fetch, origin, cookieHeader(cookies))
	const detail = await sourceGovernance(f, sourceId)
	if (!detail) return null
	const source = detail.source
	const runs = await listSourceRuns(f, sourceId)
	const itemsPage = await listSourceItems(f, sourceId, itemsBefore)
	return {
		sourceId,
		source,
		push: detail.push,
		latestRun: runs.items[0] ?? null,
		nonterminalCount: runs.items.filter((r) => r.status === 'processing').length,
		conflictCount: itemsPage.conflictCount,
		items: itemsPage.items,
		itemsNextCursor: itemsPage.nextCursor,
		purgeEligible: source.governance === 'blocked',
		purgeConsequence: PURGE_CONSEQUENCE,
		categories: AUDIT_CATEGORIES,
		refreshCommandId: crypto.randomUUID(),
		purgeCommandId: crypto.randomUUID()
	}
}
```

Check `AdminRunProjection` is exported from `$lib/logical-api` (it's already imported by name in `sources/[sourceId]/+page.svelte:5` today, so it exists) before using it as a type here.

- [ ] **Step 6: Rewrite `sources/[sourceId]/+page.server.ts`'s `load` to call the shared function**

Replace the file's `load` export (and delete the now-duplicated `PURGE_CONSEQUENCE`/`SourceGovernance`/`SourcePush`/`sourceGovernance` — everything Step 5 moved out) — keep `refresh`/`purge` actions unchanged, they don't move:

```typescript
import { error } from '@sveltejs/kit'
import { loadSourceDetail } from '$lib/server/source-detail'
import { refreshSource, purgeSource } from '$lib/logical-api'
import type { Actions, PageServerLoad } from './$types'
import { authedFetch, base, cookieHeader } from '$lib/server/session'
import { fail } from '@sveltejs/kit'

export const load: PageServerLoad = async ({ fetch, params, url, cookies }) => {
	const detail = await loadSourceDetail(fetch, url.origin, cookies, params.sourceId, url.searchParams.get('before'))
	if (!detail) throw error(404, 'Not found')
	return detail
}

export const actions: Actions = {
	// unchanged from the current file — refresh/purge stay exactly as they are
}
```

Keep the existing `refresh`/`purge` action bodies verbatim (don't retype them — copy them from the current file before deleting anything, paste unchanged into the new file's `actions` object). Re-check the import list once done: `authedFetch`/`base`/`cookieHeader`/`fail` are still needed by the actions; `AUDIT_CATEGORIES` is NOT needed anymore in this file (it moved into `source-detail.ts` and is re-exported via `detail.categories`) — remove that import if it's now unused, confirm with `svelte-check`/`tsc` rather than guessing.

- [ ] **Step 7: Wire `?detail=` into `feeds/+page.server.ts`'s `load`**

Add near the existing `expand`/`expandedMembers` block (after it, before the `return`):

```typescript
	// Task 9: inline source detail, reached via ?detail= (deliberately a
	// DIFFERENT param than ?expand=, which already means "show this
	// instance's member list" — a federation row needs both to mean
	// different things at once, per the redesign spec's Component 4).
	const detailId = url.searchParams.get('detail')
	const detail = detailId ? await loadSourceDetail(fetch, url.origin, cookies, detailId, url.searchParams.get('detailBefore')) : null
```

Add `detail` to the returned object literal (alongside `expand`/`expandedMembers`):

```typescript
		detail,
```

Add the import at the top of the file:

```typescript
import { loadSourceDetail } from '$lib/server/source-detail'
```

- [ ] **Step 8: Add `refresh`/`purge` actions to `feeds/+page.server.ts`**

The inlined panel's own refresh/purge buttons need to post somewhere — this codebase has no precedent for one route's form posting to another route's action (verified: no `action="/admin/..."` cross-route form anywhere in `web/src/routes` today), so add thin wrapper actions here rather than introducing that pattern. Add to `feeds/+page.server.ts`'s `actions` object, after `bulkTombstone` (from Task 6):

```typescript
	,
	// Thin wrappers so the inlined ?detail= panel's forms can post without a
	// cross-route action reference (no precedent for that in this codebase).
	// Bodies are identical to sources/[sourceId]/+page.server.ts's own
	// refresh/purge — kept in sync by hand since SvelteKit actions can't be
	// re-exported/imported across routes.
	refresh: async (event) => {
		const form = await event.request.formData()
		const sourceId = String(form.get('sourceId') ?? '').trim()
		const commandId = String(form.get('commandId') ?? '').trim()
		if (!sourceId) return fail(400, { error: 'sourceId is required' })
		if (!commandId) return fail(400, { error: 'commandId is required', sourceId })
		let outcome
		try {
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			outcome = await refreshSource(f, sourceId, commandId)
		} catch (err) {
			return fail(502, { error: err instanceof Error ? err.message : 'refresh failed', sourceId, commandId })
		}
		if (outcome.kind === 'refused') return { sourceId, commandId, refused: true }
		if (outcome.kind === 'conflict') return fail(409, { error: 'idempotency conflict', sourceId, commandId })
		return { sourceId, commandId, run: outcome.run, polling: outcome.kind === 'polling' }
	},
	purge: async (event) => {
		const form = await event.request.formData()
		const sourceId = String(form.get('sourceId') ?? '').trim()
		const commandId = String(form.get('commandId') ?? '').trim()
		const category = String(form.get('category') ?? '').trim()
		const note = String(form.get('note') ?? '').trim()
		if (!sourceId) return fail(400, { error: 'sourceId is required' })
		if (!commandId) return fail(400, { error: 'commandId is required' })
		if (!category) return fail(400, { error: 'a moderation category is required', commandId })
		let outcome
		try {
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			outcome = await purgeSource(f, sourceId, { commandId, category, ...(note ? { note } : {}) })
		} catch (err) {
			return fail(502, { error: err instanceof Error ? err.message : 'purge failed', commandId, purge: true })
		}
		if (outcome.kind === 'unavailable') return fail(404, { error: 'This source is unavailable.', commandId, purge: true })
		if (outcome.kind === 'conflict') return fail(409, { error: outcome.error, commandId, purge: true })
		return { purged: true, commandId }
	}
```

Add `refreshSource`, `purgeSource` to this file's existing `$lib/logical-api` import line.

- [ ] **Step 9: Render the inline detail panel in `feeds/+page.svelte`**

Add a "Details" link per row that sets `?detail=` (find each row's existing details link — currently `<p class="subnav"><a href="/admin/sources/{encodeURIComponent(row.id)}">Details (run history, items, purge)</a></p>`) and replace it:

```svelte
								<p class="subnav">
									<a href="/admin/feeds?{[detail === row.id ? '' : `detail=${encodeURIComponent(row.id)}`, otherParams(new Set(['detail']))].filter(Boolean).join('&')}">
										{detail === row.id ? 'Hide details' : 'Details (run history, items, purge)'}
									</a>
									<a href="/admin/sources/{encodeURIComponent(row.id)}/runs">Run history</a>
								</p>
```

Add a `detail` derived value near the top of `<script>` (alongside `expand`):

```typescript
	const detail = data.detail?.sourceId ?? null
```

Render the panel inline, right after the row's `{@render managePanel(row)}` call:

```svelte
							{#if detail === row.id && data.detail}
								<section class="detail-panel">
									<h4>Source acquisition</h4>
									<form method="POST" action="?/refresh{otherParams() ? `&${otherParams()}` : ''}" use:enhance>
										<input type="hidden" name="sourceId" value={data.detail.sourceId} />
										<input type="hidden" name="commandId" value={data.detail.refreshCommandId} />
										<button>Refresh now</button>
									</form>
									{#if data.detail.latestRun}
										<dl class="status">
											<div><dt>Run status</dt><dd>{data.detail.latestRun.status}</dd></div>
											<div><dt>Nonterminal runs</dt><dd>{data.detail.nonterminalCount}</dd></div>
										</dl>
									{:else}
										<p class="subnav">No acquisition runs yet.</p>
									{/if}
									{#if data.detail.items.length > 0}
										<ul class="item-list">
											{#each data.detail.items as item (item.logicalItemId)}
												<li><a class="mono" href="/admin/items/{encodeURIComponent(item.logicalItemId)}">{item.logicalItemId}</a></li>
											{/each}
										</ul>
									{/if}
									{#if data.detail.purgeEligible}
										<form method="POST" action="?/purge{otherParams() ? `&${otherParams()}` : ''}" class="source-action destructive" use:enhance>
											<input type="hidden" name="sourceId" value={data.detail.sourceId} />
											<input type="hidden" name="commandId" value={data.detail.purgeCommandId} />
											<label class="visually-hidden" for="detail-purge-cat">Moderation category</label>
											<select id="detail-purge-cat" name="category" required>
												{#each data.detail.categories as c (c)}<option value={c}>{c.replace(/_/g, ' ')}</option>{/each}
											</select>
											<details class="confirm-gate">
												<summary><span class="action-name">Purge evidence</span></summary>
												<p class="consequence">{data.detail.purgeConsequence}</p>
												<button aria-label="Confirm purge — {data.detail.source.canonicalUrl}">Confirm purge</button>
											</details>
										</form>
									{/if}
								</section>
							{/if}
```

This is a reduced-fidelity inline panel (status + items list + purge) compared to the standalone `/admin/sources/[sourceId]` page's full rendering (which also shows push-lease details and paginated older items) — matching the spec's own framing ("inlines the detail panel... by reusing... existing load logic", not "renders byte-identical markup"). The standalone route stays the full-fidelity view; this inline one is the quick-glance version. If this feels too thin once seen rendered, that's a legitimate follow-up for `docs/superpowers/ideas.md`, not a blocker for this task — the core redesign goal (no route hop to see refresh/purge) is met either way.

Add minimal `.detail-panel` styling to the `<style>` block:

```css
	.detail-panel {
		margin-top: var(--space-sm);
		padding-top: var(--space-sm);
		border-top: 1px solid var(--color-border);
	}
	.detail-panel h4 {
		margin: 0 0 var(--space-sm);
	}
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run source-detail.test.ts source-actions.test.ts feeds.render.test.ts`
Expected: all pass.

- [ ] **Step 11: Full web suite + typecheck**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run` and `docker compose exec -T web npm run -w web check`
Expected: all passing, 0 errors/warnings.

- [ ] **Step 12: Commit**

```bash
git add web/src/lib/server/source-detail.ts web/src/routes/admin/sources/\[sourceId\]/+page.server.ts web/src/routes/admin/feeds/+page.server.ts web/src/routes/admin/feeds/+page.svelte web/src/routes/admin/sources/\[sourceId\]/source-detail.test.ts web/src/routes/admin/feeds/source-actions.test.ts web/src/routes/admin/feeds/feeds.render.test.ts
git commit -m "$(cat <<'EOF'
feat(admin): inline source detail via ?detail=, extracted shared load

loadSourceDetail() is now shared between the standalone
/admin/sources/[sourceId] route and a new ?detail= inline panel on
/admin/feeds — same reads, not a re-derivation. ?detail= is deliberately
a separate param from ?expand= (federation-member-list), since a
federated row needs both to mean different things at once. Run history
stays its own route; the inline panel is a reduced-fidelity quick view.

developed with the help of AI tools
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- Component 1 (reveal-to-confirm) → Tasks 1, 2, 3 (every listed form: block/unblock, tombstone-unblock, reap plain+force, purge, deleteUser).
- Component 2 (retention-driven reap) → Task 2.
- Component 3 (bulk actions) → Tasks 4-8 (bulkSource, its UI, bulkReap/bulkTombstone, their UI, bulk delete-user).
- Component 4 (route consolidation) → Task 9.
- Non-goals honored throughout: no `core/` changes in any task, no `establish`/`attribution-mode` bulk variant, `confirm.ts` untouched (only its admin importers change).

**Placeholder scan:** every step carries real, current-tree-accurate code (verified against the actual file contents read during planning, not written from memory) — no TBD/TODO, no "add appropriate handling" left unresolved. Two spots deliberately flag a known reduced-fidelity tradeoff (Task 9's inline panel) rather than hiding it as if it were full parity — that's an honest scope note, not a placeholder.

**Type/name consistency:** `bulkResults`/`bulkAction` (Task 4/5), `bulkReapResults` (Task 6/7), `bulkTombstoneResults` (Task 6/7), `bulkDeleteResults` (Task 8), `loadSourceDetail`/`SourceDetail` (Task 9) — each name is introduced once and reused verbatim by its consuming task; checked against every later reference while writing.

**Self-caught issues, fixed inline during drafting (not deferred):** Task 5 Step 4's first draft picked `r.actions[0]?.commandId` (wrong — doesn't match the clicked action); Step 5 replaces it with a `candidate` triple format before the task ends, and updates Task 4's tests to match. Task 7 Step 4's first draft submitted every orphan row's candidate unconditionally (a no-JS-baseline requirement turned into an always-submit-everything bug); the same step corrects it to use the checkbox itself as the candidate input, and cross-checks Task 5 didn't make the identical mistake. Both are called out explicitly in-place so an implementer sees the correction, not just the final shape — the wrong intermediate is intentionally shown because it's a mistake worth not repeating.
