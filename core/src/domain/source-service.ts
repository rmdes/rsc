import type { User } from './types.ts'
import type { Repository } from './repository.ts'
import type { SourceRepository, SubscribeResult } from './source-repository.ts'
import { fingerprintRequest } from './source-repository.ts'
import { localHandleForUrl } from './opml.ts'
import { normalizeSourceUrl } from './source-url.ts'
import { checkCallbackUrl } from './push-guard.ts'
import type { LookupFn } from './push-guard.ts'

const OPERATION = 'subscribe'

export interface SourceService {
  subscribeByUrl(owner: User, url: string, commandId: string): Promise<SubscribeResult>
}

// SourceService.subscribeByUrl owns the raw-URL dispatch (Task 3, design §4
// "Transactional find-or-resolve"): canonical local-account feed URLs resolve
// first and route to followLocalAccount; everything else normalizes,
// SSRF-checks, and routes to resolveAndSubscribeSource. Both targets are
// single ledger-backed transactions on the repository — this layer never
// touches the database directly.
export function createSourceService(repo: Repository & SourceRepository, publicUrl: string | null, lookupFn?: LookupFn): SourceService {
  return {
    async subscribeByUrl(owner: User, url: string, commandId: string): Promise<SubscribeResult> {
      const now = new Date().toISOString()
      const localHandle = localHandleForUrl(url, publicUrl)
      if (localHandle) {
        const target = await repo.getUserByHandle(localHandle)
        if (target && target.kind === 'local') {
          const command = { actorScope: 'owner' as const, actorId: owner.id, commandId, requestFingerprint: fingerprintRequest([OPERATION, url]) }
          return repo.followLocalAccount({ command, ownerId: owner.id, targetId: target.id, now })
        }
      }
      // Not a local feed (or the local handle vanished): normalize + SSRF-check
      // as a remote source. Local feeds never reach checkCallbackUrl (bypass
      // per design §4/plan Global Constraints).
      const canonicalUrl = normalizeSourceUrl(url)
      const guard = await checkCallbackUrl(canonicalUrl, lookupFn)
      if (!guard.ok) return { kind: 'unavailable' }
      const cap = Number((await repo.getSetting('max_subs_per_user')) ?? '500')
      const command = { actorScope: 'owner' as const, actorId: owner.id, commandId, requestFingerprint: fingerprintRequest([OPERATION, canonicalUrl]) }
      return repo.resolveAndSubscribeSource({ command, ownerId: owner.id, canonicalUrl, cap, now })
    },
  }
}
