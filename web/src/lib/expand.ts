// Click-to-expand long posts, with rss.chat's two hard-won rules baked in
// (client worknotes 7/7 + 7/14/26):
// 1. decide whether the post is clipped AT CLICK TIME (images/layout may have
//    changed heights since render — a render-time decision goes stale);
// 2. a drag-select ends with a click — that click must not toggle.
// The DOM is the state here: no reactive bookkeeping for a purely visual fold.
// Svelte action: marks bodies actually taller than their clamp so CSS can
// show the "Show more" affordance. Heights go stale (rule 1 above), so it
// re-checks when images inside finish loading (capture — load doesn't
// bubble) and on viewport resize (rewrapping changes heights).
export function markClipped(el: HTMLElement) {
	const check = () => el.classList.toggle('clipped', el.scrollHeight > el.clientHeight)
	check()
	el.addEventListener('load', check, true)
	window.addEventListener('resize', check)
	return {
		destroy() {
			el.removeEventListener('load', check, true)
			window.removeEventListener('resize', check)
		}
	}
}

export function toggleClamp(e: MouseEvent) {
	if ((e.target as HTMLElement).closest('a')) return // link clicks navigate, never toggle
	if (window.getSelection()?.toString()) return
	const el = e.currentTarget as HTMLElement
	if (el.classList.contains('expanded')) el.classList.remove('expanded')
	else if (el.scrollHeight > el.clientHeight) el.classList.add('expanded')
}
