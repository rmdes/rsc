import { parseOpml } from 'feedsmith'
import type { User, OwnerFollowingView, PublicFollowingEntry } from './types.ts'
import type { Repository } from './repository.ts'
import type { SourceRepository, SubscribeResult, ImportSourcesResult, UnsubscribeResult } from './source-repository.ts'
import { fingerprintRequest } from './source-repository.ts'
import { localHandleForUrl } from './opml.ts'
import { normalizeSourceUrl } from './source-url.ts'
import { checkCallbackUrl } from './push-guard.ts'
import type { LookupFn } from './push-guard.ts'

const OPERATION = 'subscribe'
const IMPORT_OPERATION = 'import-opml'
const UNSUBSCRIBE_OPERATION = 'unsubscribe'
const MAX_IMPORT_OUTLINES = 1000 // mirrors opml.ts's MAX_OUTLINES (H5)
// Mirrors the existing POST /me/follows/opml body-size limit (api/app.ts) —
// this service is callable directly (not only via that HTTP route), so it
// bounds itself rather than trusting a caller to have enforced it already.
const MAX_IMPORT_BYTES = 1024 * 1024

interface ImportOutline { text?: string; title?: string; xmlUrl?: string; outlines?: ImportOutline[] }

function flattenOutlines(outlines: ImportOutline[] | undefined, out: ImportOutline[]): void {
  for (const o of outlines ?? []) {
    if (typeof o.xmlUrl === 'string') out.push(o)
    if (o.outlines) flattenOutlines(o.outlines, out) // folders are structure, not feeds
  }
}

// The XML that gets parsed AND fingerprinted — never the caller's raw input
// beyond this cap (Task 4 brief: "the XML that is fingerprinted is the
// bounded XML").
function boundXml(xml: string): string {
  const buf = Buffer.from(xml, 'utf8')
  return buf.length > MAX_IMPORT_BYTES ? buf.subarray(0, MAX_IMPORT_BYTES).toString('utf8') : xml
}

export interface SourceService {
  subscribeByUrl(owner: User, url: string, commandId: string): Promise<SubscribeResult>
  importOpml(owner: User, xml: string, commandId: string): Promise<ImportSourcesResult | { kind: 'conflict' }>
  ownerFollowing(ownerId: string): Promise<OwnerFollowingView>
  publicFollowing(ownerId: string): Promise<PublicFollowingEntry[]>
  unsubscribe(ownerId: string, sourceId: string, commandId: string): Promise<UnsubscribeResult>
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

    // The batch analogue of subscribeByUrl (Task 4): partitions BEFORE the
    // write — resolve canonical local feeds first (they bypass the SSRF
    // guard, same precedence as subscribeByUrl), then normalize +
    // checkCallbackUrl every remaining URL — and hands the approved
    // localTargetIds/canonicalUrls plus the pre-write unavailableCount to the
    // one importSourceSubscriptions command. No network I/O happens inside
    // that transaction.
    async importOpml(owner: User, xml: string, commandId: string): Promise<ImportSourcesResult | { kind: 'conflict' }> {
      const now = new Date().toISOString()
      const bounded = boundXml(xml)
      const parsed = parseOpml(bounded)
      const flat: ImportOutline[] = []
      flattenOutlines(parsed.body?.outlines as ImportOutline[] | undefined, flat)
      const capped = flat.slice(0, MAX_IMPORT_OUTLINES)

      const localTargetIds = new Set<string>()
      const canonicalUrls = new Set<string>()
      let unavailableCount = 0

      for (const o of capped) {
        const xmlUrl = o.xmlUrl as string
        const localHandle = localHandleForUrl(xmlUrl, publicUrl)
        if (localHandle) {
          const target = await repo.getUserByHandle(localHandle)
          if (target && target.kind === 'local') {
            localTargetIds.add(target.id)
            continue
          }
        }
        let canonicalUrl: string
        try {
          canonicalUrl = normalizeSourceUrl(xmlUrl)
        } catch {
          unavailableCount++ // invalid URL: generic unavailable, same as SSRF-blocked (design §4)
          continue
        }
        const guard = await checkCallbackUrl(canonicalUrl, lookupFn)
        if (!guard.ok) { unavailableCount++; continue }
        canonicalUrls.add(canonicalUrl)
      }

      const cap = Number((await repo.getSetting('max_subs_per_user')) ?? '500')
      const command = { actorScope: 'owner' as const, actorId: owner.id, commandId, requestFingerprint: fingerprintRequest([IMPORT_OPERATION, bounded]) }
      return repo.importSourceSubscriptions({
        command,
        ownerId: owner.id,
        localTargetIds: [...localTargetIds],
        canonicalUrls: [...canonicalUrls],
        unavailableCount,
        cap,
        now,
      })
    },

    // Plain reads (Task 5) — no command envelope, nothing to ledger.
    ownerFollowing(ownerId: string): Promise<OwnerFollowingView> {
      return repo.ownerFollowing(ownerId)
    },
    publicFollowing(ownerId: string): Promise<PublicFollowingEntry[]> {
      return repo.publicFollowing(ownerId)
    },

    // Stable-ID unsubscribe with last-subscription cleanup (Task 5). Fingerprint
    // is exactly ["unsubscribe", sourceId, actorId] (rev 5, review Finding 4) —
    // reusing a commandId against a different sourceId conflicts.
    async unsubscribe(ownerId: string, sourceId: string, commandId: string): Promise<UnsubscribeResult> {
      const now = new Date().toISOString()
      const command = { actorScope: 'owner' as const, actorId: ownerId, commandId, requestFingerprint: fingerprintRequest([UNSUBSCRIBE_OPERATION, sourceId, ownerId]) }
      return repo.unsubscribe({ command, ownerId, sourceId, now })
    },
  }
}
