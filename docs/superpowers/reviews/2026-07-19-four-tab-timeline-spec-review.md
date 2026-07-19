# SP2 four-tab timeline spec — clean-context review findings

**Spec:** `docs/superpowers/specs/2026-07-19-four-tab-timeline-design.md` (rev 0, `1e32c3c`)
**Reviewers:** parallel clean-context correctness reviewer + ponytail-review, 2026-07-19.
**Disposition:** all findings folded as **rev 1** unless noted.

## Correctness review

Verified correct (no action): the five joined select sites + shared-mapper fix
covers all client-facing entries including SSE replay; every live emit site
(local create/edit, ingest, push-in) already carries `author.feedType`;
`listFollowing` returns all follows with `feed_type`; `await parent()` works
from `+page.server.ts`; edit-SSE-through-lens is safe (an edit matches the same
lens its post did; wedge subtrees never receive edit overlays today); proposed
test files exist; MASTER.md tokens/patterns as specced.

1. **Important — Personal river excludes the viewer's own posts, and compose
   lands there.** No auto self-follow exists; `followed_by` filters strictly by
   follow edges, and `?/compose` redirects to `/` → Personal default for
   registered users → your own new post is invisible. **Folded:** core
   `followedBy` branch becomes self-inclusive (`author_id = follower OR …`);
   client `followIds` includes own id. Semantic side-effect (accepted):
   `/u/:handle/following` now also shows the owner's own posts.
2. **Important — form actions drop `?tab`.** Named-action URLs (`?/compose`)
   replace the query string, and success redirects go to bare `/` — every
   action from a non-default tab lands the user back on their default.
   **Folded:** actions preserve the active tab (form action URL
   `?tab=<tab>&/name`, redirects `/?tab=<tab>…`).
3. **Minor — `?feed` flash copy false on Personal.** `addRemote` follows
   nothing, so "its posts appear in your timeline" is wrong on the Personal
   tab. **Folded:** `addRemote` success redirects to `/?tab=public&feed=…`
   (copy true there); full form repoint stays SP3.
4. **Minor — fail-soft `me` + core-down under-specified.** **Folded:** the
   load's catch branch returns the resolved tab + empty `followIds` so the tab
   bar renders with correct active state; the guest-CTA concern dissolved with
   ponytail finding 1.
5. **Minor — `JoinedRow` new field should be `FeedType | null`** (no cast
   needed; `UsersTable.feed_type` is already typed). **Folded.**
6. **Minor — line-ref nit** (`listFollowing` is :196-206). **Folded.**

## Ponytail review

Confirmed lean (keep): uniform 5-site core change, one-line lens kinds,
always-explicit-tab pagination.

1. **Guest-on-personal special path → delete.** Skip-fetch branch, flag,
   login-CTA empty state, dedicated test — replaced by the existing
   invalid-tab rule: guest + `personal` resolves to `public`. **Folded.**
2. **`getFollowing` on every personal load → first page only.** `followIds`
   only feeds the live lens; `LiveTimeline` mounts only on `isFirstPage`.
   **Folded.**
3. **Tab-bar styling respecced from scratch → copy `.admin-nav`**
   (`web/src/routes/admin/+layout.svelte:35-59`, same aria-current + accent
   underline pattern); keep only MASTER.md deltas (focus ring, fixed height).
   **Folded.**
4. **Six spy-based load tests → one pure tab-resolution helper** tested
   directly; drop the older-link test (template interpolation). **Folded.**
5. **Guest-skip-fetch test** — falls away with 1. **Folded.**

## Parallel-session review of rev 1 (7420bb0)

Independent pass focused on the rev-1 fixes themselves and cross-caller
fallout; the rev-0 grounding was already source-verified above.

**Verified clean (with source proof):**
- The `?tab=<tab>&/compose` form-action URL form is valid: SvelteKit's action
  resolver scans ALL query params and takes the first whose name starts with
  `/` (`kit/src/runtime/server/page/actions.js:236-243`) — order-independent,
  so `?tab=local&/compose` resolves to `compose` with `tab` preserved. Rev-1
  fix 2 holds.
- Self-inclusion fallout across callers: `service.test.ts:72-80` (follower
  authors no posts), `api-follows.test.ts:64` (asserts only the 400), and
  `following.actions.test.ts` (action calls only, no timeline contents) are
  all unaffected.
- Anon + explicit `?tab=personal` resolves to Personal (only *guest*+personal
  falls back) — consistent with "anons are real sessions with follow graphs";
  read as deliberate.

**1. Important — `timeline-tabs.test.ts:45-47` asserts the pre-rev-1
exclusive semantics and WILL break under self-inclusion.** The Personal-river
test's `expect(tl.map(e => e.id)).toEqual([webfeedPostId])` runs with
`followedBy: alice` — and `localPostId` is authored by **alice**
(setup line 25). With the self-inclusive OR clause the result becomes
`[webfeedPostId, localPostId]` (published_at desc). The spec's §7 adds a NEW
self-inclusion test but never says this existing assertion changes — an SDD
implementer hits an unexplained red mid-task and the tempting "fix" is
weakening the OR clause back to the rev-0 bug. **Fold (one line in §7):**
"update `timeline-tabs.test.ts`'s Personal-river assertion to
`[webfeedPostId, localPostId]` — the owner's own post now belongs there."
