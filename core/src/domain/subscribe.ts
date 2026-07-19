import { HandleTakenError } from './types.ts'
import type { User, NewRemoteUser } from './types.ts'

const MAX_HANDLE_ATTEMPTS = 50

export function slugBase(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 61) // 64 − room for "-50" (H3)
  return s || 'feed'
}

// Mint a remote user with a collision-suffixed handle. No network fetch — handle from the given base.
export async function mintRemoteUser(
  addRemoteUser: (i: NewRemoteUser) => Promise<User>,
  base: string, displayName: string, feedUrl: string, feedType: NewRemoteUser['feedType'],
): Promise<User | undefined> {
  for (let n = 1; n <= MAX_HANDLE_ATTEMPTS; n++) {
    const handle = n === 1 ? base : `${base}-${n}`
    try { return await addRemoteUser({ handle, displayName, feedUrl, feedType }) }
    catch (err) { if (err instanceof HandleTakenError) continue; throw err }
  }
  return undefined
}
