import type { Repository } from './repository.ts'
import type { EventBus } from './bus.ts'
import { DomainError, HandleTakenError } from './types.ts'
import type { NewLocalUser, TimelineEntry, User, Post } from './types.ts'
import type { LogicalStore } from '../logical/store.ts'

const HANDLE_RE = /^[a-z0-9-]{1,64}$/

function normalizeHandle(handle: string): string {
  const normalized = handle.toLowerCase()
  if (!HANDLE_RE.test(normalized)) throw new DomainError('invalid handle')
  return normalized
}

export function createService(repo: Repository, bus: EventBus, publicUrl: string | null, logical: LogicalStore) {
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
    async createLocalPostAs(handle: string, displayName: string, content: string, replyTo?: Post): Promise<TimelineEntry> {
      const author = await ensureLocalUser(handle, displayName)
      // v2-on: the command atomically commits the post + logical metadata +
      // journal upsert in one write. Read the stored post back as a TimelineEntry
      // (posts stays the content authority), then emit only the after-commit
      // local-feed push hint. Logical threading owns adoption (Task 7), so the v1
      // adoptOrphans sweep is not run here.
      const dto = logical.createLocalPost({ author, content, replyToId: replyTo?.id ?? null, now: new Date().toISOString(), publicUrl: publicUrl ?? null })
      const stored = await repo.getPost(dto.id)
      const entry: TimelineEntry = { ...(stored as Post), author }
      bus.emitNewPost(entry)
      return entry
    },
    async editLocalPost(post: Post, content: string, author: User): Promise<TimelineEntry> {
      const now = new Date().toISOString()
      logical.editLocalPost({ postId: post.id, authorId: author.id, content, now })
      const entry: TimelineEntry = { ...post, content, editedAt: now, author }
      bus.emitNewPost(entry)
      return entry
    },
    // The reply-target resolver: a reply may target a remote item that exists
    // ONLY in logical_items_v2 (posts holds local content only), so the posts
    // lookup alone would 404 every reply to an RSS/instance item. The returned
    // minimal {id} is safe: createLocalPostAs reads ONLY replyTo.id.
    async resolveReplyTarget(id: string): Promise<Post | null> {
      const post = await repo.getPost(id)
      if (post) return post
      if (logical.replyTargetVisible(id)) return { id } as Post
      return null
    },
    getPost(id: string) {
      return repo.getPost(id)
    },
    countRepliesByPostIds(ids: string[]) {
      return repo.countRepliesByPostIds(ids)
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
      const normalized = {
        ...patch,
        ...(patch.handle !== undefined ? { handle: normalizeHandle(patch.handle) } : {}),
        ...(patch.displayName !== undefined ? { displayName: (() => {
          const trimmed = patch.displayName.trim()
          if (!trimmed) throw new DomainError('displayName must not be blank')
          return trimmed
        })() } : {}),
      }
      // v2-on: the update and its one Personal reset commit in one atomic write.
      return logical.updateUserProfile(userId, normalized)
    },
    createLocalUser(u: NewLocalUser) {
      return repo.createLocalUser(u)
    },
    getPostsByAuthor(authorId: string, limit: number) {
      return repo.getPostsByAuthor(authorId, limit)
    },
    countFollowers(userId: string) {
      return repo.countFollowers(userId)
    },
    countPostsByAuthor(authorId: string) {
      return repo.countPostsByAuthor(authorId)
    },
    getRecentLocalPosts(limit: number) {
      return repo.getRecentLocalPosts(limit)
    },
    async addFollow(follower: User, target: User): Promise<boolean> {
      if (follower.kind !== 'local') throw new DomainError('follower must be a local user')
      // Instance targets are global (Decision B) and self-follows are meaningless —
      // mint nothing for either.
      if (target.feedType === 'instance' || target.id === follower.id) return false
      // v2-on: a real new edge commits with one Personal reset.
      logical.addLocalFollow({ followerId: follower.id, followedId: target.id, now: new Date().toISOString() })
      return true
    },
    async removeFollow(followerId: string, target: User): Promise<void> {
      logical.removeLocalFollow({ followerId, followedId: target.id, now: new Date().toISOString() })
      if (target.kind === 'remote' && (target.feedType === 'person' || target.feedType === 'webfeed')
          && (await repo.countFollowers(target.id)) === 0) {
        repo.deleteUserCascade(target.id) // orphaned self-serve feed → stop polling. Instances never auto-cleaned.
      }
    },
    listFollowing(userId: string) {
      return repo.listFollowing(userId)
    },
    instanceStats(v2: boolean) { return repo.instanceStats(v2) },
    listUsers() { return repo.listUsers() },
    async removeRemoteFeed(handle: string): Promise<{ ok: true } | { error: 'unknown' | 'local' }> {
      const user = await repo.getUserByHandle(normalizeHandle(handle))
      if (!user) return { error: 'unknown' }
      if (user.kind !== 'remote') return { error: 'local' }
      repo.deleteUserCascade(user.id)
      return { ok: true }
    },
    async deleteLocalAccount(handle: string): Promise<{ ok: true } | { error: 'unknown' | 'remote' }> {
      const user = await repo.getUserByHandle(normalizeHandle(handle))
      if (!user) return { error: 'unknown' }
      if (user.kind !== 'local') return { error: 'remote' }
      // v2-on: terminal deletion of every post under ONE reset barrier, plus the
      // account rows, in one atomic write (spec §2.6). Auth rows stay a separate step.
      logical.deleteLocalAccount({ accountId: user.id, actorId: user.id, now: new Date().toISOString() })
      if (user.authUserId) repo.deleteAuthRows(user.authUserId)
      return { ok: true }
    },
    async deletePost(id: string): Promise<{ ok: true } | { error: 'unknown' | 'remote' }> {
      const post = await repo.getPost(id)
      if (!post) return { error: 'unknown' }
      if (post.source !== 'local') return { error: 'remote' }
      logical.deleteLocalPost({ postId: id, actorId: post.authorId, now: new Date().toISOString() })
      return { ok: true }
    },
    getSetting(key: string) { return repo.getSetting(key) },
    setSetting(key: string, value: string) { return repo.setSetting(key, value) },
  }
}

export type Service = ReturnType<typeof createService>
