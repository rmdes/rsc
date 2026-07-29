<script lang="ts">
	import type { PageData, ActionData } from './$types'
	import { enhance } from '$app/forms'
	import { confirmSubmit } from '$lib/confirm'

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
	type RetryFail = { sourceId?: string; action?: string; commandId?: string; tombstoneId?: string; force?: boolean }
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
			['expand', data.expand]
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

	// Shared by every row's Manage panel, ordinary or nested member (C1 fix):
	// a member row's `actions` is computed by the SAME toRow() as an ordinary
	// row, so the panel — and the forms it renders — are identical, not a
	// re-derivation.
	type Row = PageData['expandedMembers'][number]
</script>

<svelte:head><title>Admin — Sources — RSC</title></svelte:head>

<h2>Sources</h2>

{#if form?.error}<p class="error" role="alert">{REAP_REFUSAL_LABEL[form.error] ?? form.error}</p>{/if}
{#if form && 'done' in form && form.done}<p class="notice confirm" role="status">{LABEL[form.done] ?? form.done} applied.</p>{/if}
{#if form && 'established' in form && form.established}<p class="notice confirm" role="status">Federation established — the source is now approved.</p>{/if}
{#if form && 'unblocked' in form && form.unblocked}<p class="notice confirm" role="status">Tombstone unblocked — the URL can be created again. Nothing was restored.</p>{/if}
{#if form && 'reaped' in form && form.reaped}<p class="notice confirm" role="status">Source reaped — the source and its evidence are gone.</p>{/if}

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
	<section>
		<h3>{group.title}</h3>
		<p class="subnav">{group.blurb}</p>
		{#if group.rows.length === 0}
			<p class="subnav">None.</p>
		{:else}
			<ul class="following-list source-list">
				{#each group.rows as row (row.id)}
					{@const expanded = data.expand === row.id}
					<li>
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
							<p class="subnav"><a href="/admin/sources/{encodeURIComponent(row.id)}">Details (run history, items, purge)</a></p>
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
							{/if}
						{/if}
						{@render managePanel(row)}
					</li>
				{/each}
			</ul>
		{/if}
	</section>
{/each}

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
			{/each}
		</div>
	</details>
{/snippet}

{#if data.nextCursor}
	{@const qs = [`cursor=${encodeURIComponent(data.nextCursor)}`, otherParams(new Set(['cursor']))].filter(Boolean).join('&')}
	<a class="older" href="/admin/feeds?{qs}">More sources</a>
{/if}

<section>
	<h3>Orphaned sources</h3>
	<p class="subnav">
		Allowed, unsubscribed, and not federated — kept only by whatever's still retaining them. Paginates independently of the list above.
	</p>
	{#if data.orphanRows.length === 0}
		<p class="subnav">None.</p>
	{:else}
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
	{#if data.tombstones.length === 0}
		<p class="subnav">None.</p>
	{:else}
		<ul class="following-list source-list">
			{#each data.tombstones as t (t.id)}
				{@const retryCommandId = retryFail?.tombstoneId === t.id ? retryFail.commandId : undefined}
				{@const tombstoneQs = otherParams()}
				<li>
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

	/* A source row is a card, not a two-column row: its manage panel is a
	   stack of moderation forms, so the shared .following-list li (flex row,
	   space-between) is turned upright here only. */
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

	.source-actions {
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
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

	/* Outline, not the accent fill: half a dozen moderation verbs stacked in
	   one panel are all equally weighted, none of them a page CTA. Block reads
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
</style>
