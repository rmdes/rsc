import { randomUUID, createHash } from 'node:crypto'
import Parser from 'rss-parser'
import type { Repository } from './repository.ts'
import type { EventBus } from './bus.ts'
import type { User, Post } from './types.ts'

export interface ParsedItem { guid: string; title: string | null; content: string; url: string | null; publishedAt: string }

const rss = new Parser()

function fallbackGuid(title: string | null, content: string, publishedAt: string): string {
  return createHash('sha256').update((title ?? '') + content + publishedAt).digest('hex')
}

const FETCH_TIMEOUT_MS = 10_000
const MAX_FEED_BYTES = 5 * 1024 * 1024

function looksLikeJson(body: string): boolean {
  return body.trimStart().startsWith('{')
}

export async function parseFeed(body: string, contentType: string): Promise<ParsedItem[]> {
  const now = new Date().toISOString()
  if (contentType.includes('json') || looksLikeJson(body)) {
    const feed = JSON.parse(body) as { items?: Array<Record<string, unknown>> }
    return (feed.items ?? []).map((it) => {
      const title = typeof it.title === 'string' ? it.title : null
      const text = typeof it.content_text === 'string' ? it.content_text : typeof it.content_html === 'string' ? it.content_html : ''
      const url = typeof it.url === 'string' ? it.url : null
      const date = typeof it.date_published === 'string' ? new Date(it.date_published).toISOString() : now
      const guid = typeof it.id === 'string' ? it.id : url ?? fallbackGuid(title, text, date)
      return { guid, title, content: text, url, publishedAt: date }
    })
  }
  const feed = await rss.parseString(body)
  return (feed.items ?? []).map((it) => {
    const url = it.link ?? null
    const title = it.title ?? null
    const text = it.contentSnippet ?? it.content ?? ''
    const date = it.isoDate ? new Date(it.isoDate).toISOString() : now
    // RSS <guid> maps to it.guid; Atom's <id> has no RSS equivalent and
    // shows up only as it.id, so it must be checked before falling back to the link.
    const guid = it.guid ?? (it as { id?: string }).id ?? url ?? fallbackGuid(title, text, date)
    return { guid, title, content: text, url, publishedAt: date }
  })
}

export async function ingestRemoteUser(repo: Repository, bus: EventBus, user: User, fetchFn: typeof fetch = fetch): Promise<number> {
  if (!user.feedUrl) return 0
  const res = await fetchFn(user.feedUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  const contentLength = Number(res.headers.get('content-length') ?? '0')
  if (contentLength > MAX_FEED_BYTES) throw new Error(`feed exceeds size cap: ${contentLength} bytes`)
  const body = await res.text()
  if (Buffer.byteLength(body) > MAX_FEED_BYTES) throw new Error(`feed exceeds size cap: ${Buffer.byteLength(body)} bytes`)
  const contentType = res.headers.get('content-type') ?? ''
  const items = await parseFeed(body, contentType)
  const backfill = !(await repo.hasPostsByAuthor(user.id))
  let inserted = 0
  for (const item of items) {
    const now = new Date()
    const publishedAt = new Date(item.publishedAt).getTime() > now.getTime() ? now.toISOString() : item.publishedAt
    const post: Post = { id: randomUUID(), authorId: user.id, source: 'remote', guid: item.guid, title: item.title, content: item.content, url: item.url, publishedAt, createdAt: now.toISOString() }
    if (await repo.insertPost(post)) {
      if (!backfill) bus.emitNewPost({ ...post, author: user })
      inserted++
    }
  }
  return inserted
}

export async function pollAll(repo: Repository, bus: EventBus, fetchFn: typeof fetch = fetch): Promise<void> {
  for (const user of await repo.listRemoteUsers()) {
    try { await ingestRemoteUser(repo, bus, user, fetchFn) }
    catch (err) { console.error(`ingest failed for ${user.handle}:`, err instanceof Error ? err.message : err) }
  }
}
