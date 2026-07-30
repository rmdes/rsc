# Admin /admin/feeds action-surface redesign — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse `/admin/feeds`'s two duplicate action surfaces (the
always-visible bulk toolbar and every row's own "Manage" disclosure) into
one — checkbox-driven, for one row or many — collapsed by default behind a
native disclosure, per `docs/superpowers/specs/2026-07-30-admin-feeds-action-surface-redesign.md`
(rev 2).

**Architecture:** Four tasks. Task 1 fixes an unrelated, already-diagnosed
global CSS bug (every checkbox in the app inherits text-input sizing) —
small, independent, done first to get it out of the way. Task 2 is the core
of the redesign: deletes the per-row `managePanel` snippet, relocates its one
non-bulk-eligible verb (`attribution-mode`) to its two new homes, wires
federation-member rows into the shared selection, and fixes the real
correctness gap ponytail-review found (`bulkActions()` not seeing member
rows). Task 3 collapses the shared panel behind a native `<details>` — the
actual fix for "busy/noisy," done after Task 2 so it collapses the panel in
its final (post-Manage-panel-deletion) shape, not twice. Task 4 is the cheap
in-passing dedup of three duplicated outcome-list blocks. Order: 1
independent of the rest; 2 before 3 (3 restructures markup 2 introduces); 4
independent, can run anytime after 2 (touches the blocks 2 leaves alone).

**Tech Stack:** SvelteKit 5 (Svelte 5 runes), vitest, `svelte/server` SSR
render tests. Web-only; no `core/` or other-route changes.

## Global Constraints

- **Container-only test commands.** `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run <files>` for specific web test files; `docker compose exec -T web npm run -w web check` for `svelte-check`. Never bare `vitest`/`npx vitest`.
- **Baseline (verified 2026-07-30, re-verify before Task 1):** web suite 372/372 passing (41 files), `svelte-check` 0 errors/0 warnings.
- **Never `git add -A`** — shared checkout; a parallel session may commit to `main` concurrently. Stage explicit paths.
- **Every task ends with the web suite green and `svelte-check` clean.**
- **No raw hex colors, no rounded corners, no `box-shadow`** — every changed/new rule uses existing `--color-*`/`--space-*` tokens, matching the file's existing `<style>` blocks.
- **No server-action changes anywhere in this plan.** Every field this redesign uses (`attribution-mode`'s `attributionMode`/`category`/`note`/`commandId` via the existing `source` action; the bulk actions' existing candidate formats) already exists and is already read server-side. This is markup-only across `web/src/routes/admin/feeds/+page.svelte`, `feeds.render.test.ts`, and (Task 1 only) `web/src/app.css`.
- **`.confirm-gate` is only for verbs with a stated consequence** (`CONSEQUENCE[action]` — currently `block`/`unblock`). `attribution-mode` has none — its new forms are plain submits, no reveal-to-confirm.
- **No-JS invariant, unchanged from the prior redesign:** every button/checkbox/form this plan touches must stay reachable and functional with JavaScript off. Task 3's `<details>` wrap is native — no JS-gated visibility anywhere.
- **The spec's rev-2 corrections are settled, not open questions:** no shared note field (cut as scope creep), no dedup of `bulkSource`/`bulkReap`/`bulkTombstone`'s server-side shape, no merging the three bulk-bar blurb blocks beyond Task 4's outcome-list snippet. Don't reopen these.

---

### Task 1: Fix the global checkbox-sizing bug

**Files:**
- Modify: `web/src/app.css:771-799`

**Interfaces:**
- Consumes: nothing from another task.
- Produces: nothing later tasks depend on — this is an independent, unrelated bug fix bundled into this plan per the spec's Non-goals ("fixed alongside this work, not as part of the design").

- [ ] **Step 1: Confirm the baseline**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run` and `docker compose exec -T web npm run -w web check`
Expected: `372 passed (372)`, `0 errors and 0 warnings`.

- [ ] **Step 2: Read the current rule fresh**

Read `web/src/app.css` at lines 771-799. This plan was written against:

```css
input,
textarea,
select {
	background: var(--color-surface);
	color: var(--color-foreground);
	padding: 6px 10px;
	min-height: 36px;
	border: 1px solid var(--color-divider);
	border-radius: var(--radius);
	font: inherit;
	font-size: 0.875rem;
	width: 100%;
	caret-color: var(--color-accent);
	transition: border-color 200ms ease;
}

input:hover,
textarea:hover,
select:hover {
	border-color: color-mix(in srgb, var(--color-foreground) 45%, transparent);
}

/* The ring is :focus-visible now — no soft 3px glow. */
input:focus,
textarea:focus,
select:focus {
	border-color: var(--color-accent);
	outline: none;
	box-shadow: none;
```

If it's drifted, re-read further context before editing — the edit below assumes this exact text (the rule may continue past line 799; only these three selector groups change).

- [ ] **Step 3: Exclude `[type="checkbox"]` from the text-input rule and give it its own minimal rule**

Replace:

```css
input,
textarea,
select {
```

with:

```css
input:not([type='checkbox']),
textarea,
select {
```

Replace:

```css
input:hover,
textarea:hover,
select:hover {
```

with:

```css
input:not([type='checkbox']):hover,
textarea:hover,
select:hover {
```

Replace:

```css
input:focus,
textarea:focus,
select:focus {
```

with:

```css
input:not([type='checkbox']):focus,
textarea:focus,
select:focus {
```

Add a new rule immediately after the `input:focus, textarea:focus, select:focus { ... }` block closes (find its closing `}` — read the lines after 799 to locate it, don't guess):

```css

/* Excluded from the text-input rule above (that width:100%/min-height:36px
   was stretching every checkbox in the app into a giant rectangle inside
   any wide container — most visible in /admin/users' table). A checkbox is
   a fixed-size control, not a growable field. */
input[type='checkbox'] {
	width: 16px;
	height: 16px;
	min-height: 0;
	padding: 0;
	margin: 0;
	accent-color: var(--color-accent);
	cursor: pointer;
}
```

- [ ] **Step 4: Run the full suite + typecheck**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run` and `docker compose exec -T web npm run -w web check`
Expected: unchanged — `372 passed (372)`, `0 errors and 0 warnings` (no test asserts on checkbox pixel size; this is a pure visual fix with no test coverage to update).

- [ ] **Step 5: Commit**

```bash
git add web/src/app.css
git commit -m "$(cat <<'EOF'
fix(web): exclude checkboxes from the global text-input sizing rule

The shared `input, textarea, select` rule (width:100%, min-height:36px,
padding, border) had no type="checkbox" exclusion, so every checkbox in
the app inherited text-field sizing — most visible in /admin/users'
table, where the wide <td> stretched it into a giant rectangle.

developed with the help of AI tools
EOF
)"
```

---

### Task 2: Remove the per-row Manage panel; relocate attribution-mode; fix member-row parity

**Files:**
- Modify: `web/src/routes/admin/feeds/+page.svelte`
- Modify: `web/src/routes/admin/feeds/feeds.render.test.ts`

**Interfaces:**
- Consumes: nothing from another task (Task 1 is independent).
- Produces: `bulkActions(group)` now takes `data.expandedMembers` into account for `group.key === 'federation'` — Task 3 (which restructures the toolbar markup `bulkActions` feeds into) must call the same function unchanged, just wrapped in new markup.

- [ ] **Step 1: Confirm the baseline**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run` and `docker compose exec -T web npm run -w web check`
Expected: `372 passed (372)`, `0 errors and 0 warnings` (Task 1's fix, if already landed, doesn't change this count).

- [ ] **Step 2: Read the current file fresh**

Read `web/src/routes/admin/feeds/+page.svelte` in full — this plan was written against the version at commit `c17a3a6`. If it's drifted (another task landed first, or a parallel session touched it), re-read before editing; several exact line ranges are cited below.

- [ ] **Step 3: Write the failing tests — delete the three now-invalid Manage-panel tests, replace with member-checkbox/shared-panel tests**

In `feeds.render.test.ts`, delete these three tests in full (currently lines 64-188 — re-locate by test name if line numbers have shifted, don't guess at boundaries):

- `'a member row nested under ?expand= renders a Manage panel whose quarantine form posts to ?/source with the MEMBER\'s own id'`
- `'acting on a member (?/source) carries the expand param forward so its instance stays expanded after the mutation'`
- `'a blocked member renders twice (flat + nested) with distinct DOM ids to avoid duplicate ids (N1 fix)'`

The third test's premise (duplicate DOM ids between a flat and nested render of the same blocked member) no longer applies: checkboxes carry no `id` attribute (association is via wrapping `<label>`, not `for`), and the new per-member attribution-mode form's ids are scoped by `m.id` (`attr-mode-{m.id}` etc.) — structurally unique regardless of how many times a member renders. No replacement test for the collision itself; the design change removes the class of bug, not just this one instance of it.

Replace with these three tests (insert at the same location, after the `memberRow`/`baseRow` fixture helpers and the `NO_ORPHANS` const):

```typescript
test('a member row nested under ?expand= carries a checkbox wired to the federation group\'s shared panel form, with its own action:commandId pair', () => {
	const data = {
		groups: [{ key: 'federation', title: 'Approved federation', blurb: '', rows: [baseRow()] }],
		expand: 'inst1',
		expandedMembers: [memberRow()],
		tombstones: [],
		tombstoneConsequence: 'nothing restored',
		categories: ['spam'],
		cursor: null,
		nextCursor: null,
		...NO_ORPHANS,
		establishCommandId: 'establish-1'
	}
	const { body } = render(Page, { props: { data, form: null } } as never)
	const memberChunk = body.slice(body.indexOf(memberRow().url))
	expect(memberChunk).toContain('form="bulk-federation"')
	expect(memberChunk).toContain('name="candidate"')
	expect(memberChunk).toContain('value="mem1|quarantine:mem-cmd-1"')
	// No more per-row Manage summary anywhere for this member.
	expect(body).not.toContain(`Manage ${memberRow().url}`)
})

test('a member\'s attribution-mode form carries the expand param forward, so its instance stays expanded after the mutation', () => {
	const data = {
		groups: [{ key: 'federation', title: 'Approved federation', blurb: '', rows: [baseRow()] }],
		expand: 'inst1',
		expandedMembers: [memberRow()],
		tombstones: [],
		tombstoneConsequence: 'nothing restored',
		categories: ['spam'],
		cursor: null,
		nextCursor: null,
		...NO_ORPHANS,
		establishCommandId: 'establish-1'
	}
	const { body } = render(Page, { props: { data, form: null } } as never)
	const memberChunk = body.slice(body.indexOf(memberRow().url))
	// SSR HTML-escapes the attribute's literal `&` to `&amp;`.
	expect(memberChunk).toContain('action="?/source&amp;expand=inst1"')
	expect(memberChunk).toContain('name="sourceId" value="mem1"')
	expect(memberChunk).toContain('name="action" value="attribution-mode"')
})

test('bulkActions narrows correctly when only a checked federation-member row is selected — not to nothing, not to the group\'s full union', () => {
	// memberRow()'s only action is `quarantine`; baseRow()'s is also `quarantine`
	// by default, which wouldn't distinguish "member-aware narrowing" from
	// "ordinary narrowing" — give the ordinary row an action the member
	// DOESN'T have, so a union/narrowing bug (member's actions ignored, or
	// members folded in for every group) is actually observable.
	const ordinary = baseRow({ actions: [{ action: 'revoke', commandId: 'inst-cmd-1' }] })
	const member = memberRow({ actions: [{ action: 'quarantine', commandId: 'mem-cmd-1' }] })
	const data = {
		groups: [{ key: 'federation', title: 'Approved federation', blurb: '', rows: [ordinary] }],
		expand: 'inst1',
		expandedMembers: [member],
		tombstones: [],
		tombstoneConsequence: 'nothing restored',
		categories: ['spam'],
		cursor: null,
		nextCursor: null,
		...NO_ORPHANS,
		establishCommandId: 'establish-1'
	}
	// Nothing checked: the union baseline must include the member's own verb
	// too (a no-JS admin who expands the instance needs to see it without
	// checking anything first) — 'quarantine' from the member AND 'revoke'
	// from the ordinary row.
	const { body: nothingChecked } = render(Page, { props: { data, form: null } } as never)
	const toolbarChunk = nothingChecked.slice(nothingChecked.indexOf('action="?/bulkSource'), nothingChecked.indexOf('</form>'))
	expect(toolbarChunk).toContain('value="quarantine"')
	expect(toolbarChunk).toContain('value="revoke"')
})
```

Read `memberRow()`'s current fixture (near the top of the file, alongside `baseRow()`) before writing these — confirm `id: 'mem1'`, `url`, and its default `actions: [{ action: 'quarantine', commandId: 'mem-cmd-1' }]` match what's used above; adjust the literal strings if the fixture has drifted.

Also delete this test (currently lines 218-246, redundant once written — the bulk-toolbar's own confirm-gate tests, `'the bulk toolbar gates block behind a confirm-gate...'` and `'...gates unblock...'` near line 684, already cover this once the per-row gate is gone):

- `'a block form with a consequence renders a collapsed <details> disclosure, not an always-visible confirm button'`

Keep the adjacent test `'an action with no stated consequence (pause) has no confirm-gate at all — direct submit'` (currently lines 248-265) as-is — its assertion (`not.toContain('class="confirm-gate')`) still holds once Manage panel is gone, just for a different structural reason (the shared panel doesn't render a gate for a group whose only offered action is `pause`, which has no `CONSEQUENCE` entry). Update its leading comment to say so instead of referencing "direct submit" from the deleted Manage panel.

- [ ] **Step 4: Run the tests to verify they fail**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run feeds.render.test.ts`
Expected: FAIL — `form="bulk-federation"` isn't on the member's checkbox yet (there is no member checkbox yet), the attribution-mode form doesn't exist for members, and `bulkActions`'s union doesn't include the member's verb.

- [ ] **Step 5: Delete `managePanel` and its now-dead supporting code**

In `+page.svelte`'s `<script>` block, delete this comment + type alias (currently lines 169-173):

```typescript
	// Shared by every row's Manage panel, ordinary or nested member (C1 fix):
	// a member row's `actions` is computed by the SAME toRow() as an ordinary
	// row, so the panel — and the forms it renders — are identical, not a
	// re-derivation.
	type Row = PageData['expandedMembers'][number]
```

In the template, delete the whole snippet definition (currently lines 434-488, including the C1/N1 comment above it):

```svelte
<!-- C1 fix: the Manage panel is shared verbatim between an ordinary row and
     a nested member row — both carry the same `actions` shape from toRow(),
     so a member is moderated through the exact same forms, not a separate
     read-only view. `expand` is carried forward alongside `cursor` so acting
     on a member doesn't collapse its instance's expansion.
     N1 fix: a blocked member renders twice (flat + nested in expanded instance),
     so we add a scope discriminator to prevent duplicate DOM ids. -->
{#snippet managePanel(row: Row, scope = '')}
	{@const qs = otherParams()}
	<details class="panel">
		<summary aria-label="Manage {row.url}">Manage</summary>
		<div class="source-actions">
			{#each row.actions as a (a.action)}
				{@const consequence = CONSEQUENCE[a.action]}
				{@const retryCommandId = retryFail?.sourceId === row.id && retryFail?.action === a.action ? retryFail.commandId : undefined}
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
			{/each}
		</div>
	</details>
{/snippet}
```

Delete the ordinary-row call site (currently line 386, right after the `{#if row.group === 'federation' && row.memberCounts}` block and before the `{#if detail === row.id && data.detail}` block):

```svelte
						{@render managePanel(row)}
```

Delete `.source-actions` (plural) from the `<style>` block (currently lines 819-823) — its only consumer was `managePanel`'s wrapper `<div>`:

```css
	.source-actions {
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
	}

```

Keep `.source-action` (singular, currently lines 825-847 before this deletion) untouched — it's shared by the orphan-reap and tombstone-unblock forms, out of scope for this redesign.

- [ ] **Step 6: Add `attribution-mode`'s new home on ordinary rows — the `?detail=` inline panel**

Find the detail panel's purge form (currently inside the `{#if detail === row.id && data.detail}` block, the `{#if data.detail.purgeEligible}` conditional). Add a new form right **before** it (attribution-mode isn't destructive; purge is — least-risky-first ordering):

```svelte
								{@const attrRetry = retryFail?.sourceId === row.id && retryFail?.action === 'attribution-mode' ? retryFail.commandId : undefined}
								<form method="POST" action="?/source{otherParams() ? `&${otherParams()}` : ''}" class="source-action" use:enhance>
									<input type="hidden" name="sourceId" value={row.id} />
									<input type="hidden" name="action" value="attribution-mode" />
									<input type="hidden" name="commandId" value={attrRetry ?? row.actions.find((a) => a.action === 'attribution-mode')?.commandId} />
									<label class="visually-hidden" for="detail-attr-mode">Attribution mode</label>
									<select id="detail-attr-mode" name="attributionMode">
										<option value="single_publisher">single publisher</option>
										<option value="aggregate">aggregate</option>
									</select>
									<label class="visually-hidden" for="detail-attr-cat">Moderation category</label>
									<select id="detail-attr-cat" name="category" required>
										{#each CATEGORIES as c (c)}<option value={c}>{c.replace('_', ' ')}</option>{/each}
									</select>
									<label class="visually-hidden" for="detail-attr-note">Note (optional)</label>
									<input id="detail-attr-note" name="note" placeholder="note (optional)" />
									<button>Change attribution mode</button>
								</form>
```

`row.actions.find((a) => a.action === 'attribution-mode')` always finds a match — `availableActions()` (`+page.server.ts`) unconditionally appends `'attribution-mode'` for every row, so this is safe without a fallback. `attrRetry`'s shape matches the exact pattern `managePanel` used per-action (`retryFail?.sourceId === row.id && retryFail?.action === a.action`), scoped to this one action since it's the only one left posting to `?/source` from this row.

- [ ] **Step 7: Give federation-member rows a checkbox and their own attribution-mode form**

Replace the nested member loop's body (currently inside `{#if expanded}` → `<ul class="following-list source-list member-list">` → `{#each data.expandedMembers as m (m.id)}`):

```svelte
									<ul class="following-list source-list member-list">
										{#each data.expandedMembers as m (m.id)}
											<li>
												<div class="feed-info">
													<strong class="feed-url">{m.url}</strong>
													<span>
														<span class="badge-kind">{m.governance}</span>
														<span class="badge-kind">{m.operation}</span>
														{#if m.overridden}<span class="badge-kind on">overridden</span>{/if}
													</span>
													{#if m.viaVerification}<p class="subnav hint">via verification</p>{/if}
													{#if m.addedBy.length}
														{@const extra = Math.max(0, m.subscriberTotal - m.addedBy.length)}
														<p class="subnav hint">Added by {m.addedBy.map((a) => `@${a.handle}`).join(', ')}{extra > 0 ? ` (+${extra})` : ''}</p>
													{/if}
													<p class="subnav"><a href="/admin/sources/{encodeURIComponent(m.id)}">Details (run history, items, purge)</a></p>
												</div>
												{@render managePanel(m, 'm-')}
											</li>
										{/each}
									</ul>
```

with:

```svelte
									<ul class="following-list source-list member-list">
										{#each data.expandedMembers as m (m.id)}
											{@const memberAttrRetry = retryFail?.sourceId === m.id && retryFail?.action === 'attribution-mode' ? retryFail.commandId : undefined}
											<li>
												<div class="row-head">
													<label class="row-select">
														<input
															type="checkbox"
															name="candidate"
															value="{m.id}|{m.actions.map((a) => `${a.action}:${a.commandId}`).join('|')}"
															form="bulk-{group.key}"
															checked={selected[group.key]?.has(m.id) ?? false}
															onchange={() => toggleSelected(group.key, m.id)}
														/>
														<span class="visually-hidden">Select {m.url}</span>
													</label>
													<div class="feed-info">
														<strong class="feed-url">{m.url}</strong>
														<span>
															<span class="badge-kind">{m.governance}</span>
															<span class="badge-kind">{m.operation}</span>
															{#if m.overridden}<span class="badge-kind on">overridden</span>{/if}
														</span>
														{#if m.viaVerification}<p class="subnav hint">via verification</p>{/if}
														{#if m.addedBy.length}
															{@const extra = Math.max(0, m.subscriberTotal - m.addedBy.length)}
															<p class="subnav hint">Added by {m.addedBy.map((a) => `@${a.handle}`).join(', ')}{extra > 0 ? ` (+${extra})` : ''}</p>
														{/if}
														<p class="subnav"><a href="/admin/sources/{encodeURIComponent(m.id)}">Details (run history, items, purge)</a></p>
													</div>
												</div>
												<form method="POST" action="?/source{otherParams() ? `&${otherParams()}` : ''}" class="source-action" use:enhance>
													<input type="hidden" name="sourceId" value={m.id} />
													<input type="hidden" name="action" value="attribution-mode" />
													<input type="hidden" name="commandId" value={memberAttrRetry ?? m.actions.find((a) => a.action === 'attribution-mode')?.commandId} />
													<label class="visually-hidden" for="attr-mode-{m.id}">Attribution mode</label>
													<select id="attr-mode-{m.id}" name="attributionMode">
														<option value="single_publisher">single publisher</option>
														<option value="aggregate">aggregate</option>
													</select>
													<label class="visually-hidden" for="attr-cat-{m.id}">Moderation category</label>
													<select id="attr-cat-{m.id}" name="category" required>
														{#each CATEGORIES as c (c)}<option value={c}>{c.replace('_', ' ')}</option>{/each}
													</select>
													<label class="visually-hidden" for="attr-note-{m.id}">Note (optional)</label>
													<input id="attr-note-{m.id}" name="note" placeholder="note (optional)" />
													<button aria-label="Change attribution mode — {m.url}">Change attribution mode</button>
												</form>
											</li>
										{/each}
									</ul>
```

`group` (the outer `{#each data.groups as group}` loop variable) is in scope here — the member list renders inside the federation group's own row iteration, so `form="bulk-{group.key}"` resolves to `"bulk-federation"` correctly (this nested block only ever renders when `group.key === 'federation'`, since only federation rows have `memberCounts`/an `expand` toggle).

- [ ] **Step 8: Fix `bulkActions` to fold in `data.expandedMembers` for the federation group**

Replace (currently lines 163-167):

```typescript
	function bulkActions(group: PageData['groups'][number]): string[] {
		const chosen = group.rows.filter((r) => selected[group.key]?.has(r.id))
		const union = [...new Set(group.rows.flatMap((r) => r.actions.map((a) => a.action)))].filter((a) => a !== 'attribution-mode')
		return chosen.length ? union.filter((a) => chosen.every((r) => r.actions.some((x) => x.action === a))) : union
	}
```

with:

```typescript
	function bulkActions(group: PageData['groups'][number]): string[] {
		// Nested federation-member rows (data.expandedMembers) render inside
		// the federation group's section (whichever instance is ?expand=ed)
		// and share ITS toolbar/form via form="bulk-federation" — they're the
		// only rows outside group.rows a bulk panel ever needs to see, and
		// only for group 'federation' (no other group ever nests members).
		const candidateRows = group.key === 'federation' ? [...group.rows, ...data.expandedMembers] : group.rows
		const chosen = candidateRows.filter((r) => selected[group.key]?.has(r.id))
		const union = [...new Set(candidateRows.flatMap((r) => r.actions.map((a) => a.action)))].filter((a) => a !== 'attribution-mode')
		return chosen.length ? union.filter((a) => chosen.every((r) => r.actions.some((x) => x.action === a))) : union
	}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run feeds.render.test.ts`
Expected: all pass.

- [ ] **Step 10: Full web suite + typecheck**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run` and `docker compose exec -T web npm run -w web check`
Expected: all passing, 0 errors/warnings.

- [ ] **Step 11: Commit**

```bash
git add web/src/routes/admin/feeds/+page.svelte web/src/routes/admin/feeds/feeds.render.test.ts
git commit -m "$(cat <<'EOF'
feat(admin): remove per-row Manage panel, one action surface per verb

Every governance verb was reachable from two places at once: the bulk
toolbar and each row's own Manage disclosure. Deletes Manage entirely;
attribution-mode (the one verb that can't be bulk) moves to the row's
existing ?detail= panel for ordinary rows, and a small dedicated form for
nested federation-member rows, which have no detail panel of their own.
Members also gain a checkbox into their group's shared bulk selection,
and bulkActions() now folds in data.expandedMembers when narrowing verbs
for a checked member — a real correctness gap found in review, not just
a markup change.

developed with the help of AI tools
EOF
)"
```

---

### Task 3: Collapse the shared panel behind a native disclosure

**Files:**
- Modify: `web/src/routes/admin/feeds/+page.svelte`
- Modify: `web/src/routes/admin/feeds/feeds.render.test.ts`

**Interfaces:**
- Consumes: `bulkActions(group)` from Task 2 (unchanged signature, called the same way).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Confirm the baseline**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run` and `docker compose exec -T web npm run -w web check`
Expected: passing (count will be higher than 372 once Tasks 1-2 have landed — verify fresh, don't assume the exact number).

- [ ] **Step 2: Read the current file fresh**

Read `web/src/routes/admin/feeds/+page.svelte` — Task 2 changed line numbers throughout. Locate the ordinary-groups toolbar `<form id="bulk-{group.key}" ...>` block by content, not by the line numbers below.

- [ ] **Step 3: Write the failing tests**

Add to `feeds.render.test.ts`, near the existing bulk-toolbar tests (search for `'the bulk toolbar offers a button per action...'`):

```typescript
test('the shared action panel is collapsed by default (no `open` attribute) and its buttons still render inside it', () => {
	const row = baseRow({ actions: [{ action: 'quarantine', commandId: 'inst-cmd-1' }] })
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
	const panelStart = body.indexOf('class="panel"', body.indexOf('action="?/bulkSource'))
	const panelChunk = body.slice(panelStart, body.indexOf('</details>', panelStart) + '</details>'.length)
	expect(panelChunk).not.toContain('open')
	expect(panelChunk).toContain('>Actions<')
	expect(panelChunk).toContain('value="quarantine"')
})

test('the group blurb stays visible outside the collapsed panel, with the selected count appended to it (not inside the panel)', () => {
	const row = baseRow({ actions: [{ action: 'quarantine', commandId: 'inst-cmd-1' }] })
	const data = {
		groups: [{ key: 'federation', title: 'Approved federation', blurb: 'Federated with this instance.', rows: [row] }],
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
	const formStart = body.indexOf('action="?/bulkSource')
	const panelStart = body.indexOf('class="panel"', formStart)
	const blurbChunk = body.slice(formStart, panelStart)
	expect(blurbChunk).toContain('Federated with this instance.')
})
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run feeds.render.test.ts`
Expected: FAIL — no `class="panel"` exists inside the bulk-bar form yet.

- [ ] **Step 5: Wrap the toolbar's tools/confirm-gates in a collapsed `<details class="panel">`**

Replace (the ordinary-groups toolbar form's body — find by content, matching Task 2's final state):

```svelte
			<p class="subnav bulk-blurb" class:has-selection={(selected[group.key]?.size ?? 0) > 0}>
				<span class="bulk-blurb-text">
					{group.blurb}
					{#if (selected[group.key]?.size ?? 0) > 0}<span class="selected-count"> · {selected[group.key]?.size} selected</span>{/if}
				</span>
				<span class="bulk-tools">
					{#each bulkVerbs.filter((a) => !CONSEQUENCE[a]) as actionName (actionName)}
						<button name="action" value={actionName}>{LABEL[actionName]}</button>
					{/each}
					{#if bulkVerbs.some((a) => a !== 'pause' && a !== 'resume')}
						<label class="visually-hidden" for="bulk-cat-{group.key}">Moderation category</label>
						<select id="bulk-cat-{group.key}" name="category" required>
							{#each CATEGORIES as c (c)}<option value={c}>{c.replace('_', ' ')}</option>{/each}
						</select>
					{/if}
				</span>
			</p>
			<!-- The two verbs with a STATED consequence (block/unblock) are gated
			     exactly as the per-row managePanel gates them — same CONSEQUENCE
			     key, same reveal-to-confirm — so blocking N sources in one click
			     can't be the one destructive path that skips the confirmation a
			     single-row block requires (design §10). A sibling of the <p>, not
			     inside it: <details> is not phrasing content, and this is the
			     shape the orphan/tombstone/users bulk bars already use. -->
			{#each bulkVerbs.filter((a) => CONSEQUENCE[a]) as actionName (actionName)}
				<details class="confirm-gate">
					<summary><span class="action-name">{LABEL[actionName]} selected</span></summary>
					<p class="consequence">{CONSEQUENCE[actionName]}</p>
					<button name="action" value={actionName}>Confirm {LABEL[actionName].toLowerCase()} selected</button>
				</details>
			{/each}
```

with:

```svelte
			<p class="subnav bulk-blurb" class:has-selection={(selected[group.key]?.size ?? 0) > 0}>
				<span class="bulk-blurb-text">
					{group.blurb}
					{#if (selected[group.key]?.size ?? 0) > 0}<span class="selected-count"> · {selected[group.key]?.size} selected</span>{/if}
				</span>
			</p>
			<!-- Collapsed by default: this is the actual fix for a busy resting
			     page, not just removing the duplicate Manage panel. Native
			     <details> — same primitive as .confirm-gate and the mobile nav —
			     so expanding needs no JavaScript; the no-JS invariant is
			     unaffected, this only changes the default visual state. -->
			<details class="panel">
				<summary>Actions</summary>
				<div class="bulk-tools">
					{#each bulkVerbs.filter((a) => !CONSEQUENCE[a]) as actionName (actionName)}
						<button name="action" value={actionName}>{LABEL[actionName]}</button>
					{/each}
					{#if bulkVerbs.some((a) => a !== 'pause' && a !== 'resume')}
						<label class="visually-hidden" for="bulk-cat-{group.key}">Moderation category</label>
						<select id="bulk-cat-{group.key}" name="category" required>
							{#each CATEGORIES as c (c)}<option value={c}>{c.replace('_', ' ')}</option>{/each}
						</select>
					{/if}
				</div>
				<!-- The two verbs with a STATED consequence (block/unblock) are
				     gated the same way the deleted per-row Manage panel gated
				     them — same CONSEQUENCE key, same reveal-to-confirm — so
				     blocking N sources in one click can't be the one destructive
				     path that skips the confirmation a single-row block requires
				     (design §10). -->
				{#each bulkVerbs.filter((a) => CONSEQUENCE[a]) as actionName (actionName)}
					<details class="confirm-gate">
						<summary><span class="action-name">{LABEL[actionName]} selected</span></summary>
						<p class="consequence">{CONSEQUENCE[actionName]}</p>
						<button name="action" value={actionName}>Confirm {LABEL[actionName].toLowerCase()} selected</button>
					</details>
				{/each}
			</details>
```

`.panel` is an existing global class (`web/src/app.css:704-728`) already used for the "Establish federation with a source" disclosure lower on this same page — a ruled border-top, uppercase small-caps summary text on hover-accent, `list-style-position: inside` (keeps the browser's **native** disclosure marker, positioned inside the summary's box — unlike `.confirm-gate`, which strips the native marker and draws its own `::before` chevron). Verified: `web/src/routes/admin/feeds/+page.svelte`'s existing `<details class="panel"><summary>Establish federation with a source</summary>` has no manual chevron text of its own. Match that exactly — plain `Actions` text, no `▸` prefix; adding one would double up with the native marker `.panel` already provides.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run feeds.render.test.ts`
Expected: all pass.

- [ ] **Step 7: Full web suite + typecheck**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run` and `docker compose exec -T web npm run -w web check`
Expected: all passing, 0 errors/warnings.

- [ ] **Step 8: Commit**

```bash
git add web/src/routes/admin/feeds/+page.svelte web/src/routes/admin/feeds/feeds.render.test.ts
git commit -m "$(cat <<'EOF'
feat(admin): collapse the shared action panel by default

The resting page now shows rows and a one-line "Actions" disclosure
per group, not a permanent button wall — the actual fix for the busy/
noisy feel, on top of Task 2's de-duplication. Native <details>, so
expanding needs no JavaScript and the no-JS invariant is unaffected.

developed with the help of AI tools
EOF
)"
```

---

### Task 4: One shared `bulkOutcomes` snippet instead of three copies

**Files:**
- Modify: `web/src/routes/admin/feeds/+page.svelte`

**Interfaces:**
- Consumes: nothing from Task 2 or 3 (touches the orphans/tombstones outcome blocks, which neither task changes) beyond being in the same file.
- Produces: nothing later tasks depend on. Pure refactor — no new test assertions, existing outcome-rendering tests must keep passing unchanged.

- [ ] **Step 1: Confirm the baseline**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run` and `docker compose exec -T web npm run -w web check`
Expected: passing (verify fresh count).

- [ ] **Step 2: Read the current file fresh**

Read `web/src/routes/admin/feeds/+page.svelte` — locate the three outcome blocks by content (`bulkResults`, `bulkReapResults`, `bulkTombstoneResults`), not by line number.

- [ ] **Step 3: Confirm existing test coverage is a pure behavior-preservation check**

This is a refactor with no behavior change, so no new tests are added. Instead, before editing, run the existing outcome-related tests and note their names so you can re-run exactly them after the change:

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run feeds.render.test.ts -t "outcome"`

Expected: the existing outcome tests pass (e.g. `'bulk outcome reporting: form.bulkResults renders a per-row outcome line naming each failure'`, `'an empty bulkResults array (nothing effectively selected) reports "Nothing selected." instead of rendering nothing'`, `'an empty bulkReapResults / bulkTombstoneResults array reports it too'`, `'bulkReapResults/bulkTombstoneResults each render a per-row outcome line naming failures'`). These must still pass unchanged after Step 4 — that's the whole test for this task.

- [ ] **Step 4: Add the shared snippet and replace all three call sites**

Add a new snippet definition near the bottom of the template, after the `managePanel`-deletion leaves a gap (Task 2 already removed it) — place it right before the closing `{#if data.nextCursor}` pagination block, or any clearly-scoped top-level location in the template:

```svelte
{#snippet bulkOutcomes(results: { ok: boolean; error?: string }[] | undefined, idKey: 'sourceId' | 'tombstoneId', verb: string)}
	{#if results?.length}
		<ul class="bulk-outcomes">
			{#each results as r (r[idKey])}
				<li class:error={!r.ok}>{r[idKey]}: {r.ok ? verb : r.error}</li>
			{/each}
		</ul>
	{:else if results}
		<p class="notice" role="status">Nothing selected.</p>
	{/if}
{/snippet}
```

Replace the governance-groups outcome block (currently near the top of the template, right after the action notices):

```svelte
{#if retryFail?.bulkResults?.length}
	<ul class="bulk-outcomes">
		{#each retryFail.bulkResults as r (r.sourceId)}
			<li class:error={!r.ok}>{r.sourceId}: {r.ok ? 'done' : r.error}</li>
		{/each}
	</ul>
{:else if retryFail?.bulkResults}
	<!-- An EMPTY results array is a real outcome: nothing was checked, or no
	     checked row offered the clicked verb. Rendering nothing for it left a
	     no-JS submit (where there's no live "N selected" count either) looking
	     like an identical, silent page. -->
	<p class="notice" role="status">Nothing selected.</p>
{/if}
```

with:

```svelte
{@render bulkOutcomes(retryFail?.bulkResults, 'sourceId', 'done')}
```

Replace the orphans outcome block:

```svelte
{#if retryFail?.bulkReapResults?.length}
	<ul class="bulk-outcomes">
		{#each retryFail.bulkReapResults as r (r.sourceId)}<li class:error={!r.ok}>{r.sourceId}: {r.ok ? 'reaped' : r.error}</li>{/each}
	</ul>
{:else if retryFail?.bulkReapResults}
	<p class="notice" role="status">Nothing selected.</p>
{/if}
```

with:

```svelte
{@render bulkOutcomes(retryFail?.bulkReapResults, 'sourceId', 'reaped')}
```

Replace the tombstones outcome block:

```svelte
{#if retryFail?.bulkTombstoneResults?.length}
	<ul class="bulk-outcomes">
		{#each retryFail.bulkTombstoneResults as r (r.tombstoneId)}<li class:error={!r.ok}>{r.tombstoneId}: {r.ok ? 'unblocked' : r.error}</li>{/each}
	</ul>
{:else if retryFail?.bulkTombstoneResults}
	<p class="notice" role="status">Nothing selected.</p>
{/if}
```

with:

```svelte
{@render bulkOutcomes(retryFail?.bulkTombstoneResults, 'tombstoneId', 'unblocked')}
```

Note the snippet's parameter type `{ ok: boolean; error?: string }[]` intentionally doesn't include `sourceId`/`tombstoneId` in its element type (since the two callers use different key names) — `r[idKey]` reads whichever key the caller names. If `svelte-check` complains about this indexed access against `RetryFail`'s actual field types (`bulkResults`/`bulkReapResults` are `{ sourceId: string; ok: boolean; error?: string }[]`, `bulkTombstoneResults` is `{ tombstoneId: string; ... }[]`), widen the snippet's parameter type to `(Record<'sourceId' | 'tombstoneId', string> & { ok: boolean; error?: string })[]` instead — check the actual error before picking which fix, don't guess blind.

- [ ] **Step 5: Run the tests to verify they still pass unchanged**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run feeds.render.test.ts -t "outcome"`
Expected: same tests from Step 3, still passing, same count.

- [ ] **Step 6: Full web suite + typecheck**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run` and `docker compose exec -T web npm run -w web check`
Expected: all passing, 0 errors/warnings.

- [ ] **Step 7: Commit**

```bash
git add web/src/routes/admin/feeds/+page.svelte
git commit -m "$(cat <<'EOF'
refactor(admin): one shared bulkOutcomes snippet, not three copies

governance/orphan/tombstone bulk actions each rendered the identical
outcome-list-or-"Nothing selected." shape, differing only in the id
field name and the done-word. Pure refactor, no behavior change.

developed with the help of AI tools
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- Component 1 (remove Manage panel) → Task 2.
- Component 2 (shared panel, single surface, collapsed by default) → Task 2 (single surface) + Task 3 (collapsed by default) — split across two tasks since the toolbar restructure in Task 3 depends on Task 2's final row/panel shape, not the reverse.
- Component 3 (attribution-mode → detail panel) → Task 2 Step 6 (ordinary rows) + Step 7 (members' own equivalent, since they have no detail panel — a resolution this plan had to make explicit since the spec named the ordinary-row home but not a member-specific one, and Goal 4 requires members keep parity).
- Component 4 (bulkOutcomes snippet) → Task 4.
- Goal 4 (member parity) → Task 2 Steps 7-8 (checkbox + bulkActions fix) — the spec's own rev-2 correction, verified against the actual code before writing task steps.
- Non-goals honored: no server-action changes anywhere, orphans/tombstones untouched beyond nothing (Task 4 only touches their outcome-list rendering, not their forms/logic), `/admin/users` untouched, checkbox-sizing bug fixed as its own task (Task 1) per the spec's explicit instruction to fix it "alongside this work, not as part of the design."

**Placeholder scan:** every step carries real code read from or verified against the actual current file contents during planning (not written from memory) — no TBD/TODO. Task 4 Step 4's type-widening fallback is the only spot that asks the implementer to verify one small thing against the real file rather than assume — flagged as "check before assuming," not left vague about what to do once checked. (Task 3's chevron question was resolved during planning itself, not left for the implementer — verified against the actual "Establish federation" `<summary>` before writing the step.)

**Type/name consistency:** `bulkActions(group)` (Task 2) is called unchanged by Task 3's restructured markup. `attrRetry`/`memberAttrRetry` (Task 2) are local `{@const}`s, not exported — no cross-task naming to keep consistent. `bulkOutcomes(results, idKey, verb)` (Task 4) is introduced and used in the same task, all three call sites shown.

**A design gap the spec left implicit, resolved here rather than deferred:** the spec named `attribution-mode`'s new home for ordinary rows (the `?detail=` panel) but didn't address federation-member rows, which have no detail panel — silently leaving this unresolved would have broken Goal 4 (member parity) the moment Task 2 deleted Manage. Task 2 Step 7 gives members their own minimal attribution-mode form instead, reusing the same `?/source` action and the same per-row `commandId` already computed by `toRow()` — no new data plumbing, no server change.
