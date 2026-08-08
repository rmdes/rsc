// The stdio entry — the ONLY file that knows how bytes move. Phase 2's HTTP
// transport (createMcpHandler, in a SvelteKit route) will sit beside this
// against the same buildServer, not replace it.
//
// stdout belongs to the JSON-RPC stream: never console.log here, and never
// anywhere it imports. Diagnostics go to stderr.
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { loadConfig, buildServer } from './tools.ts'

let cfg
try {
  cfg = loadConfig(process.env)
} catch (err) {
  console.error(`[rsc-mcp] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

serveStdio(() => buildServer(cfg))
