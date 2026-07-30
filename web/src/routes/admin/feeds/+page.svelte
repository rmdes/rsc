<script lang="ts">
	import type { PageData, ActionData } from './$types'
	import { enhance } from '$app/forms'

	let { data, form }: { data: PageData; form: ActionData } = $props()

	// SvelteKit's generated ActionData is a union across all three actions on
	// this page; chaining `in` checks over it doesn't narrow cleanly once the
	// shapes differ this much. The `source`/`establish` fail() branches always
	// echo these fields as plain strings when present — read them through one
	// loose shape instead of fighting the union.
	// ponytail: `as`-cast past the generated union rather than fighting it with
	// per-branch narrowing. Ceiling: a 4th action with a same-named, differently
	// typed field could paper over a real mismatch here. Upgrade path: revisit
	// if this page's action count grows past three.
	// Task 4 adds `reap`'s `force` field: it never collides with `source`'s
	// `action` or `tombstone`'s `tombstoneId`, since `reap`'s fail() sets
	// neither — `'force' in retryFail` is what distinguishes a reap failure
	// from the other three actions' shapes below.
	// Task 5 adds bulkSource's SUCCESS shape here too (bulkResults/bulkAction):
	// same reason as the fail fields — one loose read beats narrowing a union
	// that now spans five actions.
	// Task 7 adds bulkReap's/bulkTombstone's own per-row outcome arrays —
	// same reasoning, now seven actions deep.
	// Task 9's inlined refresh/purge add `purge`/`purged` — the same two markers
	// the standalone /admin/sources/[sourceId] page reads to tell WHICH of its
	// two forms a returned commandId belongs to.
	type RetryFail = {
		sourceId?: string
		action?: string
		commandId?: string
		tombstoneId?: string
		force?: boolean
		purge?: boolean
		purged?: boolean
		bulkResults?: { sourceId: string; ok: boolean; error?: string }[]
		bulkAction?: string
		bulkReapResults?: { sourceId: string; ok: boolean; error?: string }[]
		bulkTombstoneResults?: { tombstoneId: string; ok: boolean; error?: string }[]
	}
	const retryFail = $derived(form as RetryFail | null)
	// Retry id for the establish form specifically (no sourceId/tombstoneId of its
	// own): was a template {@const}, which requires an enclosing block — hoisted
	// here once the page's only {#if} (the dead v1 arm) was deleted.
	const establishRetryCommandId = $derived(retryFail?.commandId && !retryFail.sourceId ? retryFail.commandId : undefined)
	// establish's form isn't inside a block, so it can't use a template
	// {@const} (same reason establishRetryCommandId above was hoisted) —
	// otherParams() itself only reads reactive `data` fields, so this stays
	// live across re-renders same as a {@const} would.
	const establishQs = $derived(otherParams())

	// Every mutating form/pagination link on this page now composes from FOUR
	// independent view params (ordinary-list cursor, search, the orphan
	// group's OWN cursor, and the lazy member-expand id) — carrying forward
	// every one it doesn't itself change, same convention the pre-existing
	// cursor+expand inline @consts already followed before Task 4 added the
	// other two axes.
	function otherParams(exclude: ReadonlySet<string> = new Set()): string {
		return ([
			['cursor', data.cursor],
			['q', data.q],
			['orphanCursor', data.orphanCursor],
			['expand', data.expand],
			['detail', data.detail?.sourceId ?? null]
		] as const)
			.filter(([k, v]) => v && !exclude.has(k))
			.map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
			.join('&')
	}

	// Refusal reasons from core's reapSource guard chain read as raw machine
	// identifiers (e.g. 'has_subscribers') — every other action's error on this
	// page is already a human-phrased string from core, so this lookup only
	// rewrites these six known reap reasons and falls through to the raw
	// string for anything else (a network error, an unrecognized action, etc.).
	const REAP_REFUSAL_LABEL: Record<string, string> = {
		has_subscribers: 'This source still has active subscribers.',
		not_allowed: 'This source is not in allowed governance — quarantine or block it via the moderation actions instead.',
		federated: 'This source has an active federation relationship.',
		admin_retained: 'This source is marked admin-retained.',
		audit_history: 'This source has audit history.',
		verified_origin_evidence: 'This source backs verified-origin evidence for a logical item.'
	}

	const RETENTION_LABEL: Record<string, string> = {
		verified_origin: 'Verified-origin evidence — retained',
		admin_retained: 'Admin-retained — retained',
		audit_history: 'Has audit history — retained',
		reapable: 'No retaining reason — reapable'
	}

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

	const LABEL: Record<string, string> = {
		pause: 'Pause acquisition',
		resume: 'Resume acquisition',
		quarantine: 'Quarantine',
		allow: 'Allow',
		approve: 'Approve federation',
		reject: 'Reject federation',
		revoke: 'Revoke federation',
		block: 'Block',
		unblock: 'Unblock',
		'attribution-mode': 'Change attribution mode'
	}

	// Design §10: block and unblock confirmations state their DISTINCT
	// consequences. The same sentence is rendered in the form (no-JS never sees
	// a confirm dialog) and used as the confirm() text when JS is on.
	const CONSEQUENCE: Record<string, string> = {
		block:
			'Blocking stops all acquisition from this source — no polling, no push — and makes every delivery from it ineligible, so its items leave ordinary timelines. Items, subscriptions, federation provenance and audit history stay inspectable. Only an explicit unblock reverses it.',
		unblock:
			'Unblocking returns this source to quarantine, never straight to visibility: acquisition resumes, but its deliveries stay out of ordinary timelines until you allow it in a separate step.'
	}

	// core's V1 AuditCategory enum. core is the gate (it 400s an invalid one);
	// this select is the enum at the UI.
	const CATEGORIES = ['spam', 'abuse', 'illegal_content', 'compromised_source', 'operator_policy', 'other']

	// One Set of checked source ids per group. COSMETIC ONLY: it drives the
	// live "N selected" count and the blurb↔toolbar swap class, nothing else.
	// What a bulk submit actually carries comes from the checkboxes themselves
	// (each one's `value` names its row and every action:commandId pair it
	// offers), so the batch is exactly the checked boxes — browser-enforced,
	// with or without JS. Reassigned rather than mutated on every toggle: a Set
	// inside $state isn't deeply reactive, the new object reference is what
	// re-renders.
	let selected: Record<string, Set<string>> = $state({})
	function toggleSelected(groupKey: string, id: string) {
		const set = selected[groupKey] ?? new Set<string>()
		if (set.has(id)) set.delete(id)
		else set.add(id)
		selected = { ...selected, [groupKey]: set }
	}

	// Which verbs a group's bulk bar offers. Nothing checked (the server
	// baseline) → every bulk-eligible action any row in the group offers, so
	// the bar ships in the SSR output instead of appearing only once JS ran.
	// Rows checked → narrowed to the actions EVERY checked row offers, so the
	// bar can't offer a verb part of the selection would only 409 on.
	// attribution-mode is never bulk-eligible: it carries a per-row-meaningful
	// extra field that doesn't generalize to N rows.
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

	// Task 9: which row's inline ?detail= panel is open, if any. Deliberately
	// separate from `expand` (federation member-list) — a federation row can
	// legitimately want both open at once.
	const detail = $derived(data.detail?.sourceId ?? null)

	// Command-id retention for the inline panel's two forms (design §11), the
	// same pinning /admin/sources/[sourceId]/+page.svelte does with its own
	// `commandId`/`purgeCommandId` $deriveds: loadSourceDetail mints a fresh
	// uuid on EVERY load, so a re-render after a 202/refusal/blip has to reuse
	// the id that was submitted — otherwise a retry mints a new command instead
	// of replaying the original (a duplicate acquisition run, or a second
	// audited purge). Unlike the standalone route, this page's `form` union
	// spans seven actions, so refresh is identified POSITIVELY: it echoes
	// sourceId+commandId for the open panel and carries none of the other
	// actions' discriminators (source's `action`, reap's `force`, tombstone's
	// `tombstoneId`, purge's `purge`/`purged`) — a failed block on the same row
	// must not poison the refresh form's id.
	const detailRefreshRetry = $derived(
		retryFail?.commandId &&
			retryFail.sourceId === detail &&
			!retryFail.action &&
			retryFail.force === undefined &&
			!retryFail.tombstoneId &&
			!retryFail.purge &&
			!retryFail.purged
			? retryFail.commandId
			: undefined
	)
	const detailPurgeRetry = $derived((retryFail?.purge || retryFail?.purged) && retryFail.commandId ? retryFail.commandId : undefined)
</script>

<svelte:head><title>Admin — Sources — RSC</title></svelte:head>

<h2>Sources</h2>

{#if form?.error}<p class="error" role="alert">{REAP_REFUSAL_LABEL[form.error] ?? form.error}</p>{/if}
{#if form && 'done' in form && form.done}<p class="notice confirm" role="status">{LABEL[form.done] ?? form.done} applied.</p>{/if}
{#if form && 'established' in form && form.established}<p class="notice confirm" role="status">Federation established — the source is now approved.</p>{/if}
{#if form && 'unblocked' in form && form.unblocked}<p class="notice confirm" role="status">Tombstone unblocked — the URL can be created again. Nothing was restored.</p>{/if}
{#if form && 'reaped' in form && form.reaped}<p class="notice confirm" role="status">Source reaped — the source and its evidence are gone.</p>{/if}
<!-- A bulk submit's per-row outcomes. Page-level, beside the other action
     notices, not per group: bulkResults isn't group-scoped (and a quarantined
     row has moved group by the time this renders), so repeating the list under
     every group would print the same outcomes four times. -->
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

<!-- No-JS search: a plain GET submit replaces the whole querystring with
     just this form's own field, so a fresh search always starts back at
     page one — filters only the ordinary paginated list below, same
     posture as `cursor` itself (the federation/review union is deliberately
     independent of both). -->
<form method="GET" class="admin-search" role="search">
	<label class="visually-hidden" for="source-search">Search sources by URL</label>
	<input id="source-search" name="q" type="search" placeholder="Search by URL…" value={data.q ?? ''} />
	<button>Search</button>
	{#if data.q}<a href="/admin/feeds">Clear</a>{/if}
</form>

{#each data.groups as group (group.key)}
	{@const bulkVerbs = bulkActions(group)}
	<section>
		<h3>{group.title}</h3>
		<!-- The bulk bar takes the blurb's place: a ruled row in normal flow
		     (MASTER.md — nothing floats). Its buttons are always visible, so a
		     no-JS admin can check boxes and submit; only the blurb text gives
		     way to the "N selected" count once JS tracks a selection. The rows'
		     checkboxes reach this form by id (`form=`), since a form can't nest
		     inside the per-row moderation forms. -->
		<form
			id="bulk-{group.key}"
			method="POST"
			action="?/bulkSource{otherParams() ? `&${otherParams()}` : ''}"
			class="bulk-bar"
			use:enhance={() => {
				// enhance's invalidateAll() re-runs load() without remounting, so a
				// selection left in place would keep ids of rows that just moved
				// group (a quarantined row leaves "Allowed user sources") — a stale
				// "N selected" count over rows the next click can't act on. The
				// FormData is captured before this runs, so clearing here is safe.
				// Returning nothing keeps enhance's default update().
				selected = { ...selected, [group.key]: new Set() }
			}}
		>
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
		</form>
		{#if group.rows.length === 0}
			<p class="subnav">None.</p>
		{:else}
			<ul class="following-list source-list">
				{#each group.rows as row (row.id)}
					{@const expanded = data.expand === row.id}
					<li>
						<div class="row-head">
							<label class="row-select">
								<!-- Self-describing value: the row's id plus every action:commandId
								     pair it offers. A checked box alone carries everything
								     bulkSource needs, so a checkbox-then-submit works with zero JS
								     — and only CHECKED boxes are in the submitted FormData, which
								     is what keeps an unselected row out of the batch. -->
								<input
									type="checkbox"
									name="candidate"
									value="{row.id}|{row.actions.map((a) => `${a.action}:${a.commandId}`).join('|')}"
									form="bulk-{group.key}"
									checked={selected[group.key]?.has(row.id) ?? false}
									onchange={() => toggleSelected(group.key, row.id)}
								/>
								<span class="visually-hidden">Select {row.url}</span>
							</label>
							<div class="feed-info">
								<strong class="feed-url">{row.url}</strong>
								<span>
									<span class="badge-kind">{row.governance}</span>
									<span class="badge-kind">{row.operation}</span>
									{#if row.federationStatus !== 'none'}<span class="badge-kind on">federation {row.federationStatus}</span>{/if}
									<span class="badge-kind">{row.attributionMode.replace('_', ' ')}</span>
									{#if row.overridden}<span class="badge-kind on">overridden</span>{/if}
								</span>
								<!-- A moderated member no longer tracks its instance's governance
								     (the overridden bit, Task 1); this hint marks WHERE a flatly-shown
								     row came from — verification, not subscribe/OPML/admin — a nested
								     member never reaches here at all (Task 6 exclusion). -->
								{#if row.viaVerification}<p class="subnav hint">via verification</p>{/if}
								{#if row.addedBy.length}
									{@const extra = Math.max(0, row.subscriberTotal - row.addedBy.length)}
									<p class="subnav hint">Added by {row.addedBy.map((a) => `@${a.handle}`).join(', ')}{extra > 0 ? ` (+${extra})` : ''}</p>
								{/if}
								<p class="subnav">
									<a href="/admin/feeds?{[detail === row.id ? '' : `detail=${encodeURIComponent(row.id)}`, otherParams(new Set(['detail']))].filter(Boolean).join('&')}">
										{detail === row.id ? 'Hide details' : 'Details (run history, items, purge)'}
									</a>
									<a href="/admin/sources/{encodeURIComponent(row.id)}/runs">Run history</a>
								</p>
							</div>
						</div>
						{#if row.group === 'federation' && row.memberCounts}
							{@const qs = [expanded ? '' : `expand=${row.id}`, otherParams(new Set(['expand']))].filter(Boolean).join('&')}
							<p class="subnav member-rollup">
								{row.memberCounts.members} member{row.memberCounts.members === 1 ? '' : 's'} ·
								{row.memberCounts.overridden} overridden ·
								{row.memberCounts.instanceGoverned} instance-governed
								{#if row.memberCounts.members > 0}
									<a href="/admin/feeds{qs ? `?${qs}` : ''}">{expanded ? 'Hide members' : 'Show members'}</a>
								{/if}
							</p>
							{#if expanded}
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
							{/if}
						{/if}
						{#if detail === row.id && data.detail}
							{@const attrRetry = retryFail?.sourceId === row.id && retryFail?.action === 'attribution-mode' ? retryFail.commandId : undefined}
							<section class="detail-panel">
								<h4>Source acquisition</h4>
								<form method="POST" action="?/refresh{otherParams() ? `&${otherParams()}` : ''}" use:enhance>
									<input type="hidden" name="sourceId" value={data.detail.sourceId} />
									<input type="hidden" name="commandId" value={detailRefreshRetry ?? data.detail.refreshCommandId} />
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
								{#if data.detail.purgeEligible}
									<form method="POST" action="?/purge{otherParams() ? `&${otherParams()}` : ''}" class="source-action destructive" use:enhance>
										<input type="hidden" name="sourceId" value={data.detail.sourceId} />
										<input type="hidden" name="commandId" value={detailPurgeRetry ?? data.detail.purgeCommandId} />
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
					</li>
				{/each}
			</ul>
		{/if}
	</section>
{/each}

{#if data.nextCursor}
	{@const qs = [`cursor=${encodeURIComponent(data.nextCursor)}`, otherParams(new Set(['cursor']))].filter(Boolean).join('&')}
	<a class="older" href="/admin/feeds?{qs}">More sources</a>
{/if}

<section>
	<h3>Orphaned sources</h3>
	<p class="subnav">
		Allowed, unsubscribed, and not federated — kept only by whatever's still retaining them. Paginates independently of the list above.
	</p>
	<!-- Same posture as the ordinary groups' bulk bar (Task 5, corrected):
	     the confirm-gate/button ship visible in server output by default —
	     never gated behind `{#if selected.orphans?.size}`, since `selected`
	     only ever populates via onchange and stays empty forever with no JS.
	     "N selected" is the only JS-cosmetic bit. -->
	<form
		id="bulk-orphans"
		method="POST"
		action="?/bulkReap{otherParams() ? `&${otherParams()}` : ''}"
		class="bulk-bar"
		use:enhance={() => {
			selected = { ...selected, orphans: new Set() }
		}}
	>
		{#if data.orphanRows.length > 0}
			<p class="subnav bulk-blurb" class:has-selection={(selected.orphans?.size ?? 0) > 0}>
				<span class="bulk-tools">
					{#if (selected.orphans?.size ?? 0) > 0}<span>{selected.orphans?.size} selected ·</span>{/if}
				</span>
			</p>
			<details class="confirm-gate">
				<summary><span class="action-name">Reap selected</span></summary>
				<p class="consequence">
					Reaping the selected sources permanently deletes each one and its evidence.
					<!-- Keyed on the SELECTION when one exists, and on the whole page
					     when it doesn't: `selected.orphans` only ever populates via
					     onchange, so with JS off this warning would never appear and a
					     no-JS bulk reap of force-needed orphans would be silently
					     under-warned about permanent evidence deletion. Irreversible
					     action: over-warn rather than under-warn. -->
					{#if data.orphanRows.some((r) => (selected.orphans?.size ? selected.orphans.has(r.id) : true) && r.retention !== null && r.retention !== 'reapable')}
						Some of the selected sources override retained evidence — that evidence is removed permanently too.
					{/if}
					This cannot be undone.
				</p>
				<button>Confirm reap selected</button>
			</details>
		{/if}
	</form>
	{#if retryFail?.bulkReapResults?.length}
		<ul class="bulk-outcomes">
			{#each retryFail.bulkReapResults as r (r.sourceId)}<li class:error={!r.ok}>{r.sourceId}: {r.ok ? 'reaped' : r.error}</li>{/each}
		</ul>
	{:else if retryFail?.bulkReapResults}
		<p class="notice" role="status">Nothing selected.</p>
	{/if}
	{#if data.orphanRows.length === 0}
		<p class="subnav">None.</p>
	{:else}
		<ul class="following-list source-list">
			{#each data.orphanRows as row (row.id)}
				{@const orphanQs = otherParams()}
				{@const needsForce = row.retention !== null && row.retention !== 'reapable'}
				{@const retryCommandId = retryFail?.sourceId === row.id && 'force' in retryFail ? retryFail.commandId : undefined}
				<li>
					<div class="row-head">
						<label class="row-select">
							<input
								type="checkbox"
								name="candidate"
								value="{row.id}:{row.commandId}:{needsForce}"
								form="bulk-orphans"
								checked={selected.orphans?.has(row.id) ?? false}
								onchange={() => toggleSelected('orphans', row.id)}
							/>
							<span class="visually-hidden">Select {row.url}</span>
						</label>
						<div class="feed-info">
							<strong class="feed-url">{row.url}</strong>
							<span class="badge-kind">{RETENTION_LABEL[row.retention ?? 'reapable']}</span>
						</div>
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
	{/if}
	{#if data.orphanNextCursor}
		{@const qs = [`orphanCursor=${encodeURIComponent(data.orphanNextCursor)}`, otherParams(new Set(['orphanCursor']))].filter(Boolean).join('&')}
		<a class="older" href="/admin/feeds?{qs}">More orphaned sources</a>
	{/if}
</section>

<details class="panel">
	<summary>Establish federation with a source</summary>
	<form method="POST" action="?/establish{establishQs ? `&${establishQs}` : ''}" class="add-remote" use:enhance>
		<label class="visually-hidden" for="fed-url">Source URL</label>
		<input id="fed-url" name="url" type="url" placeholder="https://their-instance.example/feed.xml" required />
		<label class="visually-hidden" for="fed-note">Note (optional)</label>
		<input id="fed-note" name="note" placeholder="note (optional)" />
		<input type="hidden" name="commandId" value={establishRetryCommandId ?? data.establishCommandId} />
		<button>Establish federation</button>
	</form>
</details>

<section>
	<h3>Blocked and tombstoned URLs</h3>
	<p class="subnav">
		Reserved URLs: a block or purge leaves a tombstone so the URL can't be re-created. Unblocking a tombstone lifts the reservation so the
		URL becomes creatable again — it restores nothing.
	</p>
	<!-- Same visible-by-default posture as the orphan bulk bar above. -->
	<form
		id="bulk-tombstones"
		method="POST"
		action="?/bulkTombstone{otherParams() ? `&${otherParams()}` : ''}"
		class="bulk-bar"
		use:enhance={() => {
			selected = { ...selected, tombstones: new Set() }
		}}
	>
		{#if data.tombstones.length > 0}
			<p class="subnav bulk-blurb" class:has-selection={(selected.tombstones?.size ?? 0) > 0}>
				<span class="bulk-tools">
					{#if (selected.tombstones?.size ?? 0) > 0}<span>{selected.tombstones?.size} selected ·</span>{/if}
					<label class="visually-hidden" for="bulk-tomb-cat">Moderation category</label>
					<select id="bulk-tomb-cat" name="category" required>
						{#each data.categories as c (c)}<option value={c}>{c.replace(/_/g, ' ')}</option>{/each}
					</select>
				</span>
			</p>
			<details class="confirm-gate">
				<summary><span class="action-name">Unblock selected</span></summary>
				<p class="consequence">{data.tombstoneConsequence}</p>
				<button>Confirm unblock selected</button>
			</details>
		{/if}
	</form>
	{#if retryFail?.bulkTombstoneResults?.length}
		<ul class="bulk-outcomes">
			{#each retryFail.bulkTombstoneResults as r (r.tombstoneId)}<li class:error={!r.ok}>{r.tombstoneId}: {r.ok ? 'unblocked' : r.error}</li>{/each}
		</ul>
	{:else if retryFail?.bulkTombstoneResults}
		<p class="notice" role="status">Nothing selected.</p>
	{/if}
	{#if data.tombstones.length === 0}
		<p class="subnav">None.</p>
	{:else}
		<ul class="following-list source-list">
			{#each data.tombstones as t (t.id)}
				{@const retryCommandId = retryFail?.tombstoneId === t.id ? retryFail.commandId : undefined}
				{@const tombstoneQs = otherParams()}
				<li>
					<div class="row-head">
						<label class="row-select">
							<input
								type="checkbox"
								name="candidate"
								value="{t.id}:{t.commandId}"
								form="bulk-tombstones"
								checked={selected.tombstones?.has(t.id) ?? false}
								onchange={() => toggleSelected('tombstones', t.id)}
							/>
							<span class="visually-hidden">Select {t.canonicalUrl}</span>
						</label>
						<div class="feed-info">
							<strong class="feed-url">{t.canonicalUrl}</strong>
							<span>
								<span class="badge-kind">{t.action}</span>
								<span class="badge-kind">{t.category.replace(/_/g, ' ')}</span>
								<span class="subnav">{t.createdAt}</span>
							</span>
							{#if t.aliases.length}<span class="subnav feed-url">aliases: {t.aliases.join(', ')}</span>{/if}
							{#if t.note}<span class="subnav">{t.note}</span>{/if}
						</div>
					</div>
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
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	/* Feed URLs can run long; the shared .following-list row has no wrap
	   handling since its usual content (a handle + kind badge) never needs
	   it — stack + wrap here rather than adding an admin-only case upstream. */
	.feed-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.feed-url {
		overflow-wrap: anywhere;
	}

	/* A source row is a card, not a two-column row: its own form(s) below the
	   row-head — the inline ?detail= panel, a member's attribution-mode form,
	   or an orphan/tombstone row's reap/unblock form — stack vertically, so
	   the shared .following-list li (flex row, space-between) is turned
	   upright here only. */
	.source-list li {
		flex-direction: column;
		align-items: stretch;
	}

	/* The hint carries no new meaning of its own (it's a provenance footnote,
	   not a warning or a call to action) — same secondary/small treatment as
	   .consequence rather than a new color. */
	.hint {
		margin: 0;
		color: var(--color-secondary);
		font-size: 0.8125rem;
	}

	.member-rollup {
		margin: 0;
	}

	/* Nested members read as a sub-list of their instance: indented and
	   rail-marked with the existing border token, not a new component. */
	.member-list {
		margin: var(--space-sm) 0 0 var(--space-lg);
		border-left: 2px solid var(--color-border);
		padding-left: var(--space-sm);
	}

	/* Checkbox + title/badges sit in one inline row (a .source-list li is
	   otherwise a column — the row's own action form(s) stack below this: an
	   ordinary row's inline ?detail= panel, a nested federation member's
	   standalone attribution-mode form, or an orphan/tombstone row's single
	   reap/unblock form); without this wrapper the checkbox becomes its own
	   full-width flex item, stacked above the row it selects with nothing
	   visibly tying the two together. */
	.row-head {
		display: flex;
		align-items: flex-start;
		gap: var(--space-sm);
	}

	/* Its label text is hidden because the URL right beside it already names
	   the row; the padding-top nudges the box to the cap-height of that text
	   rather than the flex row's own top edge. */
	.row-select {
		padding: 2px 0 0;
		cursor: pointer;
	}

	.bulk-bar {
		margin: 0 0 var(--space-sm);
	}

	.bulk-blurb {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-sm);
	}

	/* A ruled edge under the bar only while it holds actions — the selected
	   state reads as a section of its own, same rules-divide idea as the rest
	   of the page. */
	.bulk-blurb.has-selection {
		border-bottom: 2px solid var(--color-border);
		padding-bottom: var(--space-sm);
	}

	/* The action buttons are always visible — never display:none behind
	   $state, which would hide the only submit path with scripts off. The
	   blurb stays too (see .selected-count) — only a "N selected" note is
	   appended once rows are checked (JS-driven, cosmetic). */
	.bulk-tools {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-sm);
	}

	/* Appended to the blurb, never replacing it: swapping the whole sentence
	   for a "N selected" count changes this element's height, which shifts
	   everything below it — reserving the sentence's space and only adding a
	   few words keeps the bar from visibly jumping when a row is checked. */
	.selected-count {
		color: var(--color-accent-text);
		font-weight: 600;
	}

	/* Same outline treatment as .source-action button: a bulk verb is no more
	   a page CTA than a single-row one. Scoped to the whole bar, not just the
	   blurb row, so a verb behind a confirm-gate (block/unblock, and the
	   orphan/tombstone bars' own gated verbs) matches its ungated siblings. */
	.bulk-bar button {
		background: transparent;
		color: var(--color-foreground);
		border: 1px solid var(--color-border);
		font-size: 0.8125rem;
		padding: 2px var(--space-sm);
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

	.source-action {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-sm);
		padding-top: var(--space-sm);
		border-top: 1px solid var(--color-border);
	}

	.source-action:first-child {
		border-top: none;
	}

	/* Outline, not the accent fill: .source-action now styles one single-verb
	   form per row/section — an attribution-mode change, a purge, a reap, or a
	   tombstone unblock — none of them a page CTA. Purge and a forced reap read
	   destructive on top of that, the same outline-destructive idea as
	   .unfollow-form elsewhere (admin/users' delete-account button, the
	   following-page's Unfollow/Unsubscribe). */
	.source-action button {
		background: transparent;
		color: var(--color-foreground);
		border: 1px solid var(--color-border);
	}

	.source-action.destructive button {
		color: var(--color-destructive);
	}

	.action-name {
		font-weight: 600;
	}

	.consequence {
		margin: 0;
		color: var(--color-secondary);
		font-size: 0.8125rem;
	}

	.confirm-gate summary {
		cursor: pointer;
		list-style: none;
	}

	.confirm-gate summary::-webkit-details-marker {
		display: none;
	}

	/* The native marker is removed just above, so the summary needs an
	   affordance of its own — without one every destructive action in /admin
	   reads as static bold text with no hint that it expands. A CSS-only glyph
	   that turns when open; no icon font, no asset. Duplicated verbatim in the
	   three admin pages that own .confirm-gate, same as .consequence /
	   .action-name already are. */
	.confirm-gate summary::before {
		content: '▸';
		display: inline-block;
		margin-right: var(--space-xs);
		color: var(--color-secondary);
		transition: transform 0.15s ease;
	}

	.confirm-gate[open] summary::before {
		transform: rotate(90deg);
	}

	.confirm-gate[open] summary .action-name {
		color: var(--color-secondary);
	}

	.confirm-gate .consequence {
		margin: var(--space-sm) 0;
	}

	/* A one-line search bar, not the stacked .add-remote layout: input grows,
	   button and clear link stay their natural width. Reuses the global
	   input/button tokens (border, radius, focus ring) — nothing new here but
	   the row arrangement. */
	.admin-search {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		max-width: 28rem;
		margin-bottom: var(--space-lg);
	}

	.admin-search input {
		flex: 1;
		min-width: 0;
	}

	.admin-search button {
		flex-shrink: 0;
	}

	.admin-search a {
		flex-shrink: 0;
		color: var(--color-secondary);
		font-size: 0.875rem;
	}

	.detail-panel {
		margin-top: var(--space-sm);
		padding-top: var(--space-sm);
		border-top: 1px solid var(--color-border);
	}
	.detail-panel h4 {
		margin: 0 0 var(--space-sm);
	}
</style>
