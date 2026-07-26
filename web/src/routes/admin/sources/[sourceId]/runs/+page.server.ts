import { authedFetch, cookieHeader } from '$lib/server/session'
import { listSourceRuns, listRunJobs } from '$lib/logical-api'
import type { PageServerLoad } from './$types'

// The run history + job-summary page (spec §6.3): source runs ordered
// (startedAt DESC, runId DESC), and — when a run is selected via ?run= — that run's
// reconciliation-job summaries ordered (createdAt ASC, jobId ASC). Both paginate
// through the shared opaque cursor (runs via ?before=, jobs via ?jobsBefore=). No
// evidence-review navigation; job rows are bounded status/attempts/diagnostic
// summaries only.

export const load: PageServerLoad = async ({ fetch, params, url, cookies }) => {
	const f = authedFetch(fetch, url.origin, cookieHeader(cookies))
	const before = url.searchParams.get('before')
	const runsPage = await listSourceRuns(f, params.sourceId, before)

	// A selected run loads its jobs (paginated independently). Absent → no jobs panel.
	const selectedRun = url.searchParams.get('run')
	const jobsBefore = url.searchParams.get('jobsBefore')
	const jobsPage = selectedRun ? await listRunJobs(f, selectedRun, jobsBefore) : null

	return {
		sourceId: params.sourceId,
		runs: runsPage.items,
		nextCursor: runsPage.nextCursor,
		before,
		selectedRun,
		jobs: jobsPage?.items ?? null,
		jobsNextCursor: jobsPage?.nextCursor ?? null,
		jobsBefore
	}
}
