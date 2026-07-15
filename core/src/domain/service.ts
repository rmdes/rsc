import { randomUUID } from 'node:crypto'
import type { Repository } from './repository.ts'
import type { EventBus } from './bus.ts'
import { DomainError } from './types.ts'
import type { NewRemoteUser, TimelineEntry, User, Post } from './types.ts'

const HANDLE_RE = /^[a-z0-9-]{1,64}$/

function normalizeHandle(handle: string): string {
  const normalized = handle.toLowerCase()
  if (!HANDLE_RE.test(normalized)) throw new DomainError('invalid handle')
  return normalized
}

export function createService(repo: Repository, bus: EventBus) {
  async function ensureLocalUser(handle: string, displayName: string): Promise<User> {
    const normalized = normalizeHandle(handle)
    const existing = await repo.getUserByHandle(normalized)
    if (existing) {
      if (existing.kind !== 'local') throw new DomainError('handle belongs to a remote user')
      return existing
    }
    return repo.createLocalUser({ handle: normalized, displayName })
  }

  return {
    async addRemoteUser(input: NewRemoteUser) {
      return repo.createRemoteUser({ ...input, handle: normalizeHandle(input.handle) })
    },
    async createLocalPostAs(handle: string, displayName: string, content: string): Promise<TimelineEntry> {
      const author = await ensureLocalUser(handle, displayName)
      const now = new Date().toISOString()
      const post: Post = { id: randomUUID(), authorId: author.id, source: 'local', guid: randomUUID(), title: null, content, url: null, publishedAt: now, createdAt: now }
      await repo.insertPost(post)
      const entry: TimelineEntry = { ...post, author }
      bus.emitNewPost(entry)
      return entry
    },
    getTimeline(limit = 100) {
      return repo.getTimeline(limit)
    },
  }
}

export type Service = ReturnType<typeof createService>
