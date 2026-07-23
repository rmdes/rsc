// Accessible name for the reply-count control. The visible glyph+count is
// aria-hidden, so this string is the only thing a screen reader announces —
// it names the action, not just the number.
export function replyToggleLabel(count: number, expanded: boolean, busy: boolean): string {
  const replies = `${count} ${count === 1 ? 'reply' : 'replies'}`
  if (busy) return `Loading ${replies}`
  return `${expanded ? 'Hide' : 'Show'} ${replies}`
}
