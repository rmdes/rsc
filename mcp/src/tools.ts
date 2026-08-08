// The RSC MCP server: config, one fetch helper, rendering, and the three
// tool registrations. Imports NO transport — src/stdio.ts is the only file
// that knows how bytes move, and phase 2's HTTP entry will sit beside it.

export interface Config {
  apiUrl: string
  identities: Map<string, string>
}

// Two variables, no defaults. RSC_DEFAULT_IDENTITY and an RSC_API_KEY
// shorthand were both deliberately cut (spec rev 2): a default identity is
// inert with one key and silently picks a voice with several, which is
// exactly the case the design requires to be explicit.
export function loadConfig(env: Record<string, string | undefined>): Config {
  const apiUrl = env.RSC_API_URL?.trim()
  if (!apiUrl) throw new Error('RSC_API_URL is required (e.g. https://rsc.example.org)')
  const identities = new Map<string, string>()
  for (const pair of (env.RSC_IDENTITIES ?? '').split(',')) {
    const entry = pair.trim()
    if (!entry) continue
    const sep = entry.indexOf(':')
    if (sep <= 0 || sep === entry.length - 1) {
      throw new Error('RSC_IDENTITIES must be a comma-separated list of name:key pairs')
    }
    identities.set(entry.slice(0, sep).trim(), entry.slice(sep + 1).trim())
  }
  return { apiUrl: apiUrl.replace(/\/+$/, ''), identities }
}

export function resolveKey(cfg: Config, as: string | undefined): { key: string } | { error: string } {
  const names = [...cfg.identities.keys()]
  if (names.length === 0) return { error: 'No identity configured. Set RSC_IDENTITIES=name:key to post.' }
  if (as === undefined) {
    if (names.length === 1) return { key: cfg.identities.get(names[0])! }
    return { error: `Several identities are configured (${names.join(', ')}); pass "as" to choose one.` }
  }
  const key = cfg.identities.get(as)
  if (!key) return { error: `Unknown identity "${as}". Configured: ${names.join(', ')}.` }
  return { key }
}

// Hand-declared narrow view of core's LogicalItemDto — only the fields this
// server renders. Never imported from core/src: web/src/lib/types.ts sets the
// precedent (it hand-declares TimelineEntry and imports nothing from core).
export interface RscItem {
  id: string
  origin: 'local' | 'remote'
  selectedAuthor: { handle?: string | null; displayName?: string | null } | null
  content: string | null
  contentMarkdown: string | null
  permalink: string | null
  publishedAt: string
  directReplyCount: number
}

export interface TimelineEnvelope {
  timeline: RscItem[]
  nextCursor: string | null
}

export type ThreadNode =
  | { kind: 'item'; item: RscItem }
  | { kind: 'placeholder'; logicalItemId: string; parentLogicalItemId: string | null; timelineSortAt: string; placeholderKind: string }

export interface ThreadEnvelope {
  requestedLogicalItemId: string
  rootId: string | null
  nodes: ThreadNode[]
  truncated: { depth: boolean; nodes: boolean; cycle: boolean }
}

export function renderItem(item: RscItem): string {
  const who = item.selectedAuthor?.handle ? `@${item.selectedAuthor.handle}` : '(unattributed)'
  const head = `[${item.origin}] ${who} · ${item.publishedAt} · id=${item.id}`
  const body = item.contentMarkdown ?? item.content ?? '(no content)'
  const tail: string[] = []
  if (item.directReplyCount > 0) tail.push(`${item.directReplyCount} replies`)
  if (item.permalink) tail.push(item.permalink)
  return tail.length ? `${head}\n${body}\n↳ ${tail.join(' · ')}` : `${head}\n${body}`
}

export function renderTimeline(env: TimelineEnvelope): string {
  if (env.timeline.length === 0) return 'No entries.'
  const items = env.timeline.map(renderItem).join('\n\n')
  return env.nextCursor ? `${items}\n\nMore: pass before=${env.nextCursor}` : items
}

export function renderThread(env: ThreadEnvelope): string {
  const nodes = env.nodes.map((n) =>
    n.kind === 'item' ? renderItem(n.item) : `[${n.placeholderKind}] id=${n.logicalItemId} · ${n.timelineSortAt}`
  )
  const warn = env.truncated.depth || env.truncated.nodes || env.truncated.cycle
    ? '\n\n(thread truncated — not every reply is shown)'
    : ''
  return `Thread of ${env.requestedLogicalItemId} (root ${env.rootId ?? 'unknown'}):\n\n${nodes.join('\n\n')}${warn}`
}
