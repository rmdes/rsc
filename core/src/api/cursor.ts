import type { TimelineCursor } from '../domain/types.ts'

// Wire format: <publishedAt>~<id>. '~' never appears in ISO-8601 dates or UUIDs.
export function formatCursor(c: TimelineCursor): string {
  return `${c.publishedAt}~${c.id}`
}

export function parseCursor(s: string): TimelineCursor | null {
  const i = s.indexOf('~')
  if (i <= 0 || i === s.length - 1) return null
  return { publishedAt: s.slice(0, i), id: s.slice(i + 1) }
}
