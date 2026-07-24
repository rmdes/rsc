import { test, expect, vi } from 'vitest'

// The v2-only admin acquisition console (spec §6.2-6.3): the source-detail page
// (refresh action + status panel) and the runs/jobs history page. Mirrors the V1
// admin-feeds capability carve exactly: getCapabilities OFF → the surface does not
// exist (404, hidden); ON → the v2 console. The capability reading is memoized per
// module instance, so every load case takes a FRESH +page.server.ts.

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

const sourceDetail = (governance = 'quarantined') => ({
	source: { id: 's1', canonicalUrl: 'https://feed.test/s1', attributionMode: 'single_publisher', operation: 'enabled', governance, provenance: 'admin_federation', adminRetained: false },
	federationStatus: 'approved',
	subscriptionCounts: { active: 1, pending: 0, pendingReview: 0 },
	latestAudit: null
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

// --- capability off: the v2 console does not exist (hidden, 404) ---------------

test('with the capability off the source-detail load is 404 (the console is v2-only) and never touches /admin/sources', async () => {
	const fetch = vi.fn(async (url: string | URL) =>
		isCap(url)
			? new Response(JSON.stringify({ sourceModelV2: false }), { status: 200 })
			: new Response('{}', { status: 200 })
	)
	await expect(loadDetail(fetch)).rejects.toMatchObject({ status: 404 })
	expect(urlsOf(fetch).some((u) => u.includes('/admin/sources/'))).toBe(false)
})

test('with the capability off the runs load is also 404', async () => {
	const fetch = vi.fn(async (url: string | URL) => (isCap(url) ? new Response(JSON.stringify({ sourceModelV2: false }), { status: 200 }) : new Response('{}', { status: 200 })))
	await expect(loadRuns(fetch)).rejects.toMatchObject({ status: 404 })
})

// --- capability on: the source-detail status panel ----------------------------

test('the v2 source-detail load reads governance + the latest run and mints a stable refresh command id', async () => {
	const fetch = vi.fn(async (url: string | URL) => {
		if (isCap(url)) return new Response(JSON.stringify({ sourceModelV2: true }), { status: 200 })
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
