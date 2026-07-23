// One shared opaque codec for every v2 pagination cursor — the source-plane
// listings (RunCursor/JobCursor/TimelineCursorV2 and V1's source/subscription/
// audit cursor) and the logical vertical both encode their immutable ordering
// tuple through this. Neutral home (core/src/domain) so neither vertical depends
// on the other: the V1 source repository and the V2 logical modules both import
// it (rev 4, VP7; Task 2 correction A rider 1, 2026-07-23).
//
// Wire format: base64url of JSON [version, ...tuple]. Opaque and ephemeral —
// clients never parse it. decodeCursor returns null on any malformed input;
// callers that need a throw (V1's app.ts 400 path) wrap it — see
// source-repository.ts's decodeCursor adapter.

export function encodeCursor(version: 1, tuple: readonly string[]): string {
  return Buffer.from(JSON.stringify([version, ...tuple])).toString('base64url')
}

export function decodeCursor(cursor: string): { version: 1; tuple: readonly string[] } | null {
  try {
    const arr: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (!Array.isArray(arr) || arr[0] !== 1) return null
    const tuple = arr.slice(1)
    if (!tuple.every((x) => typeof x === 'string')) return null
    return { version: 1, tuple }
  } catch {
    return null
  }
}
