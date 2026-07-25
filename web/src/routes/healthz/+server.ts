import type { RequestHandler } from './$types'

// Liveness only — Cloudron's healthCheckPath probes this every 10s with a short
// abort timeout. It must NEVER touch core or do SSR work: probing the full home
// page made transient stalls (deploy boot, migrations, background acquisition
// bursts) look like death and invited restart storms (2026-07-25 incident).
// Hard process death is covered separately: start.sh `wait -n` exits the
// container when any process dies, which is what actually warrants a restart.
export const GET: RequestHandler = () => new Response('ok', { headers: { 'cache-control': 'no-store' } })
