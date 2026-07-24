import Database from 'better-sqlite3'
import { loadConfig } from '../config.ts'
import { loadManifest, runPreflight } from './preflight.ts'

// Operator entry point: `npm run preflight -w core` (via `cloudron exec` on a
// live instance). Read-only by construction — the database is opened
// {readonly:true}, so even a bug cannot write. Exits non-zero on any finding or
// manifest diagnostic; nothing here holds logic (that is preflight.ts).
const config = loadConfig()
let findings
try {
  findings = runPreflight(new Database(config.dbPath, { readonly: true }), loadManifest(config.migrationManifestPath))
} catch (err) {
  console.error(`preflight aborted: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
for (const f of findings) console.error(`preflight ${f.kind}: ${f.detail}`)
console.error(findings.length === 0 ? 'preflight: clean' : `preflight: ${findings.length} finding(s) — correct the legacy rows and rerun`)
process.exit(findings.length === 0 ? 0 : 1)
