import { test, expect, vi } from 'vitest'

// The admin acquisition console (spec §6.2-6.3): the source-detail page (refresh
// action + status panel) and the runs/jobs history page. Every load case takes
// a FRESH +page.server.ts import so module-level memoization never bleeds
// between cases.

const isCap = (u: unknown) => String(u).includes('/capabilities')
const cookies = { getAll: () => [{ name: 'rsc.session_token', value: 's1' }] }

const loadEvent = (fetch: ReturnType<typeof vi.fn>, sourceId = 's1', search = '') => ({
	fetch,
	params: { sourceId },
	url: new URL(`http://x/admin/sources/${sourceId}${search}`),
	cookies
})

function refreshEvent(fields: Record<string, string>, fetch: ReturnType<typeof vi.fn>, sourceId = 's1') {
	return {
		request: new Request(`http://x/admin/sources/${sourceId}?/refresh`, { method: 'POST', body: new URLSearchParams(fields) }),
		fetch,
		url: new URL(`http://x/admin/sources/${sourceId}`),
		cookies
	}
}

const urlsOf = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.map((c) => String(c[0]))

const runProjection = (runId: string, status: 'terminal' | 'processing', outcome = 'parsed') => ({
	model: 'logical-v2',
	runId,
	sourceId: 's1',
	status,
	statusLocation: `/admin/acquisition-runs/${runId}`,
	fetch: { outcome, effectiveUrl: 'https://feed.test/s1', httpStatus: null, failureCategory: null, diagnostic: null },
	acquisition: { candidates: 3, seen: 3, observed: 1, unchanged: 2, skipped: 0, omitted: 0, itemsTruncated: false, bodyLimitExceeded: false, notModified: false },
	reconciliation: { reconciled: 1, conflicted: 0, pending: 0, processing: 0, retrying: 0, failed: 0, failedByCategory: { operationalExhausted: 0, invariantOrDataFailure: 0 } }
})

const NO_PUSH = { mode: null, state: null, endpointFingerprint: null }

const sourceDetail = (governance = 'quarantined', push: Record<string, unknown> = NO_PUSH, pushExpiresAt: string | null = null) => ({
	source: { id: 's1', canonicalUrl: 'https://feed.test/s1', attributionMode: 'single_publisher', operation: 'enabled', governance, provenance: 'admin_federation', adminRetained: false },
	federationStatus: 'approved',
	subscriptionCounts: { active: 1, pending: 0, pendingReview: 0 },
	latestAudit: null,
	push,
	pushExpiresAt
})

// GET /admin/sources/:id/items — conflictCount is a TOP-LEVEL source-wide count on
// THIS envelope (AdminSourceAcquisitionSummary was never shipped). The rows give the
// /admin/items/:id navigation targets.
const itemsEnvelope = (conflictCount = 0, items: unknown[] = [{ logicalItemId: 'li1', state: 'hidden', timelineSortAt: '2026-07-20T00:00:00Z', hiddenAt: '2026-07-20T00:00:00Z' }], nextCursor: string | null = null) => ({
	model: 'logical-v2',
	items,
	nextCursor,
	conflictCount
})

type LoadResult = Record<string, unknown>

async function loadDetail(fetch: ReturnType<typeof vi.fn>, sourceId = 's1', search = ''): Promise<LoadResult> {
	vi.resetModules()
	const { load } = await import('./+page.server.ts')
	return (await load(loadEvent(fetch, sourceId, search) as never)) as LoadResult
}

async function loadRuns(fetch: ReturnType<typeof vi.fn>, sourceId = 's1', search = ''): Promise<LoadResult> {
	vi.resetModules()
	const { load } = await import('./runs/+page.server.ts')
	return (await load(loadEvent(fetch, sourceId, search) as never)) as LoadResult
}

// --- the source-detail status panel --------------------------------------------

test('the v2 source-detail load reads governance + the latest run and mints a stable refresh command id', async () => {
	const fetch = vi.fn(async (url: string | URL) => {
		if (isCap(url)) return new Response(JSON.stringify({ sourceModelV2: true }), { status: 200 })
		if (String(url).includes('/items')) return new Response(JSON.stringify(itemsEnvelope()), { status: 200 })
		if (String(url).includes('/runs')) return new Response(JSON.stringify({ model: 'logical-v2', items: [runProjection('r2', 'processing'), runProjection('r1', 'terminal')], nextCursor: null }), { status: 200 })
		return new Response(JSON.stringify(sourceDetail('quarantined')), { status: 200 })
	})
	const result = await loadDetail(fetch)
	expect(urlsOf(fetch).some((u) => u.includes('/admin/sources/s1/runs'))).toBe(true)
	// quarantined labeling passes through from the V1 source detail
	expect((result.source as { governance: string }).governance).toBe('quarantined')
	// latest run is the first (runs order by startedAt DESC); nonterminal count is derived
	expect((result.latestRun as { runId: string }).runId).toBe('r2')
	expect(result.nonterminalCount).toBe(1)
	expect(result.refreshCommandId).toMatch(/^[0-9a-f]{8}-/)
	// no evidence-review surface leaks: no delivery/finding/preview/raw-evidence
	// collections (the reconciliation `conflicted` COUNTER is a bounded count, not
	// an evidence link, so it is allowed — evidence review itself is Vertical 3).
	expect(JSON.stringify(result)).not.toMatch(/deliver|finding|preview|rawEvidence|evidenceReview/i)
})

test('a 404 source-detail (unknown source) is hidden as 404', async () => {
	const fetch = vi.fn(async (url: string | URL) => {
		if (isCap(url)) return new Response(JSON.stringify({ sourceModelV2: true }), { status: 200 })
		return new Response(JSON.stringify({ error: 'unknown source' }), { status: 404 })
	})
	await expect(loadDetail(fetch)).rejects.toMatchObject({ status: 404 })
})

// --- V4: the inbound-push panel beside the acquisition health block -----------
// The page renders the block from `data.push` alone, so "no lease ⇒ no block" is a
// loader contract: no lease loads `push: null` and the template's {#if data.push}
// renders nothing. The token/secret never leave core, so nothing to redact here.

const withPush = (push: Record<string, unknown>, expiresAt: string | null) =>
	vi.fn(async (url: string | URL) => {
		if (isCap(url)) return new Response(JSON.stringify({ sourceModelV2: true }), { status: 200 })
		if (String(url).includes('/items')) return new Response(JSON.stringify(itemsEnvelope(0)), { status: 200 })
		if (String(url).includes('/runs')) return new Response(JSON.stringify({ model: 'logical-v2', items: [], nextCursor: null }), { status: 200 })
		return new Response(JSON.stringify(sourceDetail('quarantined', push, expiresAt)), { status: 200 })
	})

test('a live lease reaches the page as {mode, state, expiresAt} — mechanism and health, no endpoint', async () => {
	const result = await loadDetail(withPush({ mode: 'websub', state: 'active', endpointFingerprint: 'ab12cd34ef567890' }, '2027-01-01T00:00:00.000Z'))
	expect(result.push).toEqual({ mode: 'websub', state: 'active', expiresAt: '2027-01-01T00:00:00.000Z' })
	// the fingerprint is core-side plumbing; the panel shows mechanism/health only
	expect(JSON.stringify(result.push)).not.toContain('ab12cd34ef567890')
})

test('no lease ⇒ push is null, so the panel renders no push block at all', async () => {
	expect((await loadDetail(withPush(NO_PUSH, null))).push).toBeNull()
	// a mode-less row (never expected, but the DTO allows it) is treated as no lease
	expect((await loadDetail(withPush({ mode: null, state: 'pending', endpointFingerprint: null }, '2027-01-01T00:00:00.000Z'))).push).toBeNull()
})

// --- V3: conflictCount + items navigation + the purge form (blocked only) -----

test('the v2 source-detail load reads conflictCount + the item navigation rows and mints a stable purge command id', async () => {
	const fetch = vi.fn(async (url: string | URL) => {
		if (isCap(url)) return new Response(JSON.stringify({ sourceModelV2: true }), { status: 200 })
		if (String(url).includes('/items')) return new Response(JSON.stringify(itemsEnvelope(4, [{ logicalItemId: 'li9', state: 'hidden', timelineSortAt: '2026-07-20T00:00:00Z', hiddenAt: '2026-07-20T00:00:00Z' }], 'iNext')), { status: 200 })
		if (String(url).includes('/runs')) return new Response(JSON.stringify({ model: 'logical-v2', items: [runProjection('r1', 'terminal')], nextCursor: null }), { status: 200 })
		return new Response(JSON.stringify(sourceDetail('quarantined')), { status: 200 })
	})
	const result = await loadDetail(fetch)
	expect(urlsOf(fetch).some((u) => u.includes('/admin/sources/s1/items'))).toBe(true)
	expect(result.conflictCount).toBe(4)
	expect((result.items as { logicalItemId: string }[]).map((i) => i.logicalItemId)).toEqual(['li9'])
	expect(result.itemsNextCursor).toBe('iNext')
	expect(result.purgeCommandId).toMatch(/^[0-9a-f]{8}-/)
	// a quarantined (non-blocked) source is NOT purge-eligible
	expect(result.purgeEligible).toBe(false)
	// no raw evidence collections leak — only bounded state rows + a count reach the page
	expect(JSON.stringify(result.items)).not.toMatch(/deliver|rawEvidence|finding|preview/i)
})

test('a blocked source is purge-eligible and the loader carries purge’s DISTINCT consequence copy', async () => {
	const fetch = vi.fn(async (url: string | URL) => {
		if (isCap(url)) return new Response(JSON.stringify({ sourceModelV2: true }), { status: 200 })
		if (String(url).includes('/items')) return new Response(JSON.stringify(itemsEnvelope(0)), { status: 200 })
		if (String(url).includes('/runs')) return new Response(JSON.stringify({ model: 'logical-v2', items: [], nextCursor: null }), { status: 200 })
		return new Response(JSON.stringify(sourceDetail('blocked')), { status: 200 })
	})
	const result = await loadDetail(fetch)
	expect(result.purgeEligible).toBe(true)
	// purge's consequence is DISTINCT from unblock's: evidence is permanently
	// deleted, but the URL STAYS blocked by the tombstone. Pinned so a rewrite to a
	// generic "Are you sure?" (or copy that implies the block is lifted) fails here.
	const copy = String(result.purgeConsequence)
	expect(copy).toContain('permanently')
	expect(copy).toMatch(/stays blocked|remains blocked/i)
})

async function purgeAction(fetch: ReturnType<typeof vi.fn>, fields: Record<string, string>) {
	vi.resetModules()
	const { actions } = await import('./+page.server.ts')
	return actions.purge(refreshEvent(fields, fetch) as never)
}

test('the purge action posts {commandId, category, note} to /admin/sources/:id/purge', async () => {
	const fetch = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify({ model: 'logical-v2', kind: 'purged' }), { status: 200 }))
	const res = (await purgeAction(fetch, { sourceId: 's1', category: 'illegal_content', note: 'court order', commandId: 'cmd-p' })) as { purged: boolean; commandId: string }
	expect(res.purged).toBe(true)
	expect(res.commandId).toBe('cmd-p')
	const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
	expect(url).toContain('/admin/sources/s1/purge')
	expect(init.method).toBe('POST')
	expect(JSON.parse(String(init.body))).toEqual({ commandId: 'cmd-p', category: 'illegal_content', note: 'court order' })
})

test('the purge action refuses a missing commandId or category without calling core', async () => {
	const fetch = vi.fn()
	expect(await purgeAction(fetch, { sourceId: 's1', category: 'spam' })).toMatchObject({ status: 400 })
	expect(await purgeAction(fetch, { sourceId: 's1', category: '', commandId: 'c' })).toMatchObject({ status: 400 })
	expect(fetch).not.toHaveBeenCalled()
})

test("a purge that core answers 409 'source not blocked' reaches the admin, with the commandId echoed", async () => {
	const fetch = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify({ model: 'logical-v2', error: 'source not blocked' }), { status: 409 }))
	const res = (await purgeAction(fetch, { sourceId: 's1', category: 'spam', commandId: 'dup' })) as { status: number; data: { error: string; commandId: string } }
	expect(res.status).toBe(409)
	expect(res.data.error).toBe('source not blocked')
	expect(res.data.commandId).toBe('dup')
})

// --- refresh action: 200 terminal / 202 polling / 404 neutral / 409 conflict ---

async function refreshAction(fetch: ReturnType<typeof vi.fn>, fields: Record<string, string>) {
	vi.resetModules()
	const { actions } = await import('./+page.server.ts')
	return actions.refresh(refreshEvent(fields, fetch) as never)
}

test('a refresh that reached terminal in the window returns the run and posts only the commandId to /refresh', async () => {
	const fetch = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify({ ...runProjection('r1', 'terminal'), disposition: 'created' }), { status: 200 }))
	const res = (await refreshAction(fetch, { sourceId: 's1', commandId: 'cmd-1' })) as { commandId: string; polling: boolean; run: { runId: string } }
	expect(res.polling).toBe(false)
	expect(res.run.runId).toBe('r1')
	expect(res.commandId).toBe('cmd-1')
	const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
	expect(url).toContain('/admin/sources/s1/refresh')
	expect(init.method).toBe('POST')
	expect(JSON.parse(String(init.body))).toEqual({ commandId: 'cmd-1' })
})

test('a still-processing refresh returns polling:true with the submitted commandId retained for replay', async () => {
	const fetch = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify({ ...runProjection('r1', 'processing'), disposition: 'created' }), { status: 202 }))
	const res = (await refreshAction(fetch, { sourceId: 's1', commandId: 'poll-me' })) as { commandId: string; polling: boolean; run: { status: string } }
	expect(res.polling).toBe(true)
	expect(res.run.status).toBe('processing')
	expect(res.commandId).toBe('poll-me') // retained so a resubmit replays the same run
})

test('a refused refresh (paused/blocked/unknown source) renders neutrally: no run, no evidence, commandId retained', async () => {
	const fetch = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify({ model: 'logical-v2', error: 'source unavailable' }), { status: 404 }))
	const res = (await refreshAction(fetch, { sourceId: 's1', commandId: 'refuse-me' })) as { refused: boolean; commandId: string; run?: unknown }
	expect(res.refused).toBe(true)
	expect(res.run).toBeUndefined() // neutral — the source's state never leaks
	expect(res.commandId).toBe('refuse-me')
	// the neutral 404 body is never surfaced (no "source unavailable" evidence)
	expect(JSON.stringify(res)).not.toContain('unavailable')
})

test('an idempotency conflict (reused commandId, different fingerprint) fails 409 with the commandId echoed', async () => {
	const fetch = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify({ model: 'logical-v2', error: 'idempotency conflict' }), { status: 409 }))
	const res = (await refreshAction(fetch, { sourceId: 's1', commandId: 'dup' })) as { status: number; data: { error: string; commandId: string } }
	expect(res.status).toBe(409)
	expect(res.data.commandId).toBe('dup')
})

test('a missing commandId is refused without calling core and never minted in its place', async () => {
	const fetch = vi.fn()
	expect(await refreshAction(fetch, { sourceId: 's1', commandId: '' })).toMatchObject({ status: 400 })
	expect(await refreshAction(fetch, { sourceId: 's1' })).toMatchObject({ status: 400 })
	expect(fetch).not.toHaveBeenCalled()
})

// --- runs + jobs pagination via the shared cursor -----------------------------

test('the runs load paginates with ?before= and does not load jobs without a selected run', async () => {
	const fetch = vi.fn(async (url: string | URL) => {
		if (isCap(url)) return new Response(JSON.stringify({ sourceModelV2: true }), { status: 200 })
		return new Response(JSON.stringify({ model: 'logical-v2', items: [runProjection('r5', 'terminal')], nextCursor: 'cNext' }), { status: 200 })
	})
	const result = await loadRuns(fetch, 's1', '?before=cPrev')
	expect(urlsOf(fetch).some((u) => u.includes('/admin/sources/s1/runs?before=cPrev'))).toBe(true)
	expect(urlsOf(fetch).some((u) => u.includes('/jobs'))).toBe(false) // no run selected
	expect(result.nextCursor).toBe('cNext')
	expect((result.runs as unknown[]).length).toBe(1)
	expect(result.jobs).toBeNull()
})

test('the runs load fetches a selected run’s jobs and paginates them with the shared cursor', async () => {
	const fetch = vi.fn(async (url: string | URL) => {
		if (isCap(url)) return new Response(JSON.stringify({ sourceModelV2: true }), { status: 200 })
		if (String(url).includes('/jobs')) return new Response(JSON.stringify({ model: 'logical-v2', items: [{ jobId: 'j1', createdAt: 't', status: 'reconciled', attempts: 1, nextAttemptAt: null, failureCategory: null, diagnostic: null }], nextCursor: 'jNext' }), { status: 200 })
		return new Response(JSON.stringify({ model: 'logical-v2', items: [runProjection('r5', 'terminal')], nextCursor: null }), { status: 200 })
	})
	const result = await loadRuns(fetch, 's1', '?run=r5&jobsBefore=jPrev')
	expect(urlsOf(fetch).some((u) => u.includes('/admin/acquisition-runs/r5/jobs?before=jPrev'))).toBe(true)
	expect(result.selectedRun).toBe('r5')
	expect((result.jobs as unknown[]).length).toBe(1)
	expect(result.jobsNextCursor).toBe('jNext')
	// job summaries carry status/attempts only — no delivery/evidence collections
	expect(JSON.stringify(result.jobs)).not.toMatch(/deliver|evidence|material|rawEvidence/i)
})
