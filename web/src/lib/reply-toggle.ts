// Accessible name for the reply-count control. The visible glyph+count is
// aria-hidden, so this string is the only thing a screen reader announces —
// it names the action, not just the number.
export function replyToggleLabel(count: number, expanded: boolean, busy: boolean): string {
  const replies = `${count} ${count === 1 ? 'reply' : 'replies'}`
  if (busy) return `Loading ${replies}`
  return `${expanded ? 'Hide' : 'Show'} ${replies}`
}

// Click routing for the control. It is a LINK first: a modified click
// (cmd/ctrl/shift — new tab, new window) belongs to the browser, so the
// conversation opens like any other permalink. Otherwise the click expands
// inline instead of navigating — unless a fetch is already in flight, in which
// case it is swallowed rather than starting a second one.
export function replyToggleClick(
  event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; preventDefault: () => void },
  busy: boolean,
  onactivate: () => void
): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey) return
  event.preventDefault()
  if (!busy) onactivate()
}
