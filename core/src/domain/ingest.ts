import { randomUUID } from 'node:crypto'
import Parser from 'rss-parser'
import type { Repository } from './repository.ts'
import type { EventBus } from './bus.ts'
import type { User, Post } from './types.ts'

export interface ParsedItem { guid: string; content: string; url: string | null; publishedAt: string }

const rss = new Parser()

const FETCH_TIMEOUT_MS = 10_000
const MAX_FEED_BYTES = 5 * 1024 * 1024

export async function parseFeed(body: string, contentType: string): Promise<ParsedItem[]> {
  const now = new Date().toISOString()
  if (contentType.includes('json')) {
    const feed = JSON.parse(body) as { items?: Array<Record<string, unknown>> }
    return (feed.items ?? []).map((it) => {
      const title = typeof it.title === 'string' ? it.title : ''
      const text = typeof it.content_text === 'string' ? it.content_text : typeof it.content_html === 'string' ? it.content_html : ''
      const url = typeof it.url === 'string' ? it.url : null
      const guid = typeof it.id === 'string' ? it.id : url ?? randomUUID()
      const date = typeof it.date_published === 'string' ? new Date(it.date_published).toISOString() : now
      return { guid, content: [title, text].filter(Boolean).join(' — '), url, publishedAt: date }
    })
  }
  const feed = await rss.parseString(body)
  return (feed.items ?? []).map((it) => {
    const url = it.link ?? null
    const guid = it.guid ?? url ?? randomUUID()
    const text = it.contentSnippet ?? it.content ?? ''
    const date = it.isoDate ? new Date(it.isoDate).toISOString() : now
    return { guid, content: [it.title, text].filter(Boolean).join(' — '), url, publishedAt: date }
  })
}

export async function ingestRemoteUser(repo: Repository, bus: EventBus, user: User, fetchFn: typeof fetch = fetch): Promise<number> {
  if (!user.feedUrl) return 0
  const res = await fetchFn(user.feedUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  const contentLength = Number(res.headers.get('content-length') ?? '0')
  if (contentLength > MAX_FEED_BYTES) throw new Error(`feed exceeds size cap: ${contentLength} bytes`)
  const body = await res.text()
  if (body.length > MAX_FEED_BYTES) throw new Error(`feed exceeds size cap: ${body.length} bytes`)
  const contentType = res.headers.get('content-type') ?? ''
  const items = await parseFeed(body, contentType)
  let inserted = 0
  for (const item of items) {
    if (await repo.hasPostGuid(item.guid)) continue
    const now = new Date().toISOString()
    const post: Post = { id: randomUUID(), authorId: user.id, source: 'remote', guid: item.guid, content: item.content, url: item.url, publishedAt: item.publishedAt, createdAt: now }
    await repo.insertPost(post)
    bus.emitNewPost({ ...post, author: user })
    inserted++
  }
  return inserted
}

export async function pollAll(repo: Repository, bus: EventBus, fetchFn: typeof fetch = fetch): Promise<void> {
  for (const user of await repo.listRemoteUsers()) {
    try { await ingestRemoteUser(repo, bus, user, fetchFn) }
    catch (err) { console.error(`ingest failed for ${user.handle}:`, err instanceof Error ? err.message : err) }
  }
}
