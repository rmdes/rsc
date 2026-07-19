import { randomUUID } from 'node:crypto'
import type { Repository } from './repository.ts'
import type { EventBus } from './bus.ts'
import { DomainError, HandleTakenError } from './types.ts'
import type { NewRemoteUser, NewLocalUser, TimelineEntry, TimelineCursor, User, Post } from './types.ts'
import { slugBase, mintRemoteUser } from './subscribe.ts'

const HANDLE_RE = /^[a-z0-9-]{1,64}$/

function normalizeHandle(handle: string): string {
  const normalized = handle.toLowerCase()
  if (!HANDLE_RE.test(normalized)) throw new DomainError('invalid handle')
  return normalized
}

export function createService(repo: Repository, bus: EventBus, publicUrl?: string | null) {
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
      const id = randomUUID()
      const post: Post = {
        // Permalink minted at creation (spec: Dave-style permalink refs for
        // future replies via the existing `replyTo.url ?? replyTo.guid`).
        // guid stays an opaque UUID — never a URL (guid stability contract).
        id, authorId: author.id, source: 'local', guid: randomUUID(), title: null, content,
        url: publicUrl ? `${publicUrl}/post/${id}` : null,
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
    async editLocalPost(post: Post, content: string, author: User): Promise<TimelineEntry> {
      const now = new Date().toISOString()
      await repo.recordEdit(post.id, { title: post.title, content, contentMarkdown: post.contentMarkdown ?? null, editedAt: now })
      const entry: TimelineEntry = { ...post, content, editedAt: now, author }
      bus.emitNewPost(entry) // existing channel → SSE swap + push.onLocalPost fires (edit propagates)
      return entry
    },
    getTimeline(limit = 100, before?: TimelineCursor, filter?: { followedBy?: string; authorId?: string; source?: 'local'; feedType?: 'instance' }) {
      return repo.getTimeline(limit, before, filter)
    },
    getPost(id: string) {
      return repo.getPost(id)
    },
    getRevisions(id: string) {
      return repo.getRevisions(id)
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
      return repo.updateUserProfile(userId, {
        ...patch,
        ...(patch.handle !== undefined ? { handle: normalizeHandle(patch.handle) } : {}),
        ...(patch.displayName !== undefined ? { displayName: (() => {
          const trimmed = patch.displayName.trim()
          if (!trimmed) throw new DomainError('displayName must not be blank')
          return trimmed
        })() } : {}),
      })
    },
    createLocalUser(u: NewLocalUser) {
      return repo.createLocalUser(u)
    },
    getPostsByAuthor(authorId: string, limit: number) {
      return repo.getPostsByAuthor(authorId, limit)
    },
    getRecentLocalPosts(limit: number) {
      return repo.getRecentLocalPosts(limit)
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
    listTextcastingPeers() {
      return repo.listTextcastingPeers()
    },
    listRemoteUsers() {
      return repo.listRemoteUsers()
    },
    instanceStats() { return repo.instanceStats() },
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
      repo.deleteUserCascade(user.id)
      if (user.authUserId) repo.deleteAuthRows(user.authUserId)
      return { ok: true }
    },
    async deletePost(id: string): Promise<{ ok: true } | { error: 'unknown' | 'remote' }> {
      const post = await repo.getPost(id)
      if (!post) return { error: 'unknown' }
      if (post.source !== 'local') return { error: 'remote' }
      await repo.deletePost(id)
      return { ok: true }
    },
    async subscribeByUrl(user: User, url: string, type: 'person' | 'webfeed'): Promise<{ user: User; followed: true } | { error: 'cap' }> {
      const existing = await repo.getRemoteUserByFeedUrl(url)
      // caller is a registered LOCAL user → addFollow's local-follower guard is satisfied by construction; call repo directly (service methods close over `repo`, not `this`).
      if (existing) { await repo.addFollow(user.id, existing.id); return { user: existing, followed: true } }
      const cap = Number(await repo.getSetting('max_subs_per_user') ?? '500')
      if (await repo.countRemoteSubscriptions(user.id) >= cap) return { error: 'cap' }
      const base = slugBase(new URL(url).host)
      const target = await mintRemoteUser((i) => repo.createRemoteUser(i), base, url, url, type)
      if (!target) throw new DomainError('could not allocate a handle')
      await repo.addFollow(user.id, target.id)
      return { user: target, followed: true }
    },
    getSetting(key: string) { return repo.getSetting(key) },
    setSetting(key: string, value: string) { return repo.setSetting(key, value) },
  }
}

export type Service = ReturnType<typeof createService>
