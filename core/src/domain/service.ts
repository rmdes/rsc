import { randomUUID } from 'node:crypto'
import type { Repository } from './repository.ts'
import type { EventBus } from './bus.ts'
import { DomainError, HandleTakenError } from './types.ts'
import type { NewRemoteUser, NewLocalUser, TimelineEntry, TimelineCursor, User, Post } from './types.ts'

const HANDLE_RE = /^[a-z0-9-]{1,64}$/

function normalizeHandle(handle: string): string {
  const normalized = handle.toLowerCase()
  if (!HANDLE_RE.test(normalized)) throw new DomainError('invalid handle')
  return normalized
}

export function createService(repo: Repository, bus: EventBus) {
  async function ensureLocalUser(handle: string, displayName: string): Promise<User> {
    const normalized = normalizeHandle(handle)
    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await repo.getUserByHandle(normalized)
      if (existing) {
        if (existing.kind !== 'local') throw new DomainError('handle belongs to a remote user')
        return existing
      }
      try {
        return await repo.createLocalUser({ handle: normalized, displayName })
      } catch (err) {
        if (err instanceof HandleTakenError && attempt === 0) continue // lost the race; re-read
        throw err
      }
    }
    throw new DomainError('handle lookup raced') // unreachable in practice
  }

  return {
    async addRemoteUser(input: NewRemoteUser) {
      return repo.createRemoteUser({ ...input, handle: normalizeHandle(input.handle) })
    },
    async createLocalPostAs(handle: string, displayName: string, content: string, replyTo?: Post): Promise<TimelineEntry> {
      const author = await ensureLocalUser(handle, displayName)
      const now = new Date().toISOString()
      const post: Post = {
        id: randomUUID(), authorId: author.id, source: 'local', guid: randomUUID(), title: null, content, url: null,
        publishedAt: now, createdAt: now,
        inReplyTo: replyTo ? replyTo.url ?? replyTo.guid : null,
        inReplyToPostId: replyTo?.id ?? null, // local replies are resolved by construction
        threadRootId: replyTo ? replyTo.threadRootId ?? replyTo.id : null,
      }
      await repo.insertPost(post)
      await repo.adoptOrphans(post)
      const entry: TimelineEntry = { ...post, author }
      bus.emitNewPost(entry)
      return entry
    },
    getTimeline(limit = 100, before?: TimelineCursor, filter?: { followedBy?: string; authorId?: string }) {
      return repo.getTimeline(limit, before, filter)
    },
    getPost(id: string) {
      return repo.getPost(id)
    },
    getThread(rootId: string) {
      return repo.getThread(rootId)
    },
    countRepliesByPostIds(ids: string[]) {
      return repo.countRepliesByPostIds(ids)
    },
    listRepliesByPostId(id: string) {
      return repo.listRepliesByPostId(id)
    },
    getTimelineAfter(sinceCreatedAt: string, limit: number) {
      return repo.getTimelineAfter(sinceCreatedAt, limit)
    },
    getUserByHandle(handle: string) {
      return repo.getUserByHandle(handle)
    },
    getUserByAuthUserId(authUserId: string) {
      return repo.getUserByAuthUserId(authUserId)
    },
    setAuthUserId(userId: string, authUserId: string) {
      return repo.setAuthUserId(userId, authUserId)
    },
    updateUserProfile(userId: string, patch: { handle?: string; displayName?: string }) {
      return repo.updateUserProfile(userId, patch)
    },
    createLocalUser(u: NewLocalUser) {
      return repo.createLocalUser(u)
    },
    getPostsByAuthor(authorId: string, limit: number) {
      return repo.getPostsByAuthor(authorId, limit)
    },
    async addFollow(follower: User, target: User): Promise<void> {
      if (follower.kind !== 'local') throw new DomainError('follower must be a local user')
      await repo.addFollow(follower.id, target.id)
    },
    removeFollow(followerId: string, targetId: string) {
      return repo.removeFollow(followerId, targetId)
    },
    listFollowing(userId: string) {
      return repo.listFollowing(userId)
    },
    listRemoteUsers() {
      return repo.listRemoteUsers()
    },
  }
}

export type Service = ReturnType<typeof createService>
