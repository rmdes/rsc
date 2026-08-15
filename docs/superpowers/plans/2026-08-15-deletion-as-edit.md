# Deletion as an Edit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Removing a post replaces its content with a notice saying it was removed and why, so the removal reaches federated peers through the edit path they already run — and threads continue underneath it.

**Architecture:** `removeLocalPost` (already committed, `core/src/logical/local.ts`) does the write. These tasks wire the routes to it, fix the code paths that currently infer "removed" from a missing `posts` row, and update the web surfaces. **No federation code is written or changed.**

**Spec:** `docs/superpowers/specs/2026-08-13-delete-propagation-design.md` (rev 4)

## Global Constraints

- **No TypeScript parameter properties** in `core/src` — Node native type-stripping, no build step.
- **Hono house style** (`.claude/skills/hono/SKILL.md`): `return c.json({error}, status)` never `HTTPException`; hand-rolled validators never `zValidator`; `app.request()` in tests.
- **Tests: always the workspace script**, never a bare `vitest`/`npx vitest` (`docs/superpowers/documentation/TESTING.md` Gotcha 3 — a direct call resolves the wrong config and silently drops web's `$lib` aliases). Filtered: `npm test -w core -- test/foo.test.ts`.
- **Run on the HOST from the worktree root.** The compose stack bind-mounts the main checkout, not this worktree; a container run tests the wrong code.
- **Type-stripping means vitest passes on type errors** — finish with `npm run typecheck -w core`, and `npm run check -w web` for web tasks.
- **Never `git add -A`** — stage explicit paths.
- **Commit messages end with** a line reading exactly `developed with the help of AI tools`.
- **Account deletion is out of scope and must not change.** It stays destructive.

## Interfaces already in place

```ts
// core/src/logical/local.ts — committed, do not modify
export type RemovalActor =
  | { kind: 'author' }
  | { kind: 'administrator'; category: AuditCategory; note: string | null }

export function removalNotice(actor: RemovalActor): string
export function removeLocalPost(input: { tx: WriteTx; postId: string; actor: RemovalActor; now: string }): void
```

`removeLocalPost` replaces content, clears the title, bumps `edited_at`, keeps the row, writes the `logical_deleted_local_v2` marker, and journals an **upsert**. `terminallyDelete`/`deleteLocalPost` remain for account deletion only.

---

## Task 1: Route removals through removeLocalPost

**Files:**
- Modify: `core/src/logical/store.ts` — expose `removeLocalPost` on the store beside `deleteLocalPost`
- Modify: `core/src/domain/service.ts:147-155` — `deletePost`
- Modify: `core/src/api/app.ts` — `DELETE /posts/:id` (~`:304`), `DELETE /admin/posts/:id` (~`:638`)
- Modify: `core/src/api/logical-routes/personal.ts` (~`:136`), `core/src/api/logical-routes/admin.ts` (~`:232`)
- Test: whichever file already covers those routes (`grep -rln "admin/posts" core/test`)

**Requirements:**
- `service.deletePost` takes a `RemovalActor` and calls the store's `removeLocalPost`. Its 404 (unknown) and 409 (non-local) guards stay exactly as they are.
- It must emit **`bus.emitNewPost(entry)`**, the way `editLocalPost` does at `service.ts:53` — **not** a deletion event. This is an edit, and `emitNewPost` is what drives outbound WebSub/rssCloud publishing. There is no `emitPostDeleted`; it was reverted.
- `DELETE /admin/posts/:id` gains a JSON body: a **required** `category` and an **optional** `note`. `readModBody` (`core/src/api/logical-routes/write.ts:55-61`) already validates exactly this shape for the hide/restore routes — reuse it or follow it exactly. Invalid or missing category → 400.
- `DELETE /posts/:id` (the author's own) takes **no body** and passes `{ kind: 'author' }`.
- The key-authed twins mirror whichever applies: `/me/posts/:id` is the author, `/admin-api/posts/:id` is the administrator.

**Tests (write first):**
- An author's delete leaves the post row present with the author notice as its content.
- An admin delete with `category: 'spam'` leaves the moderator notice; the response is 200.
- An admin delete with no category → 400, and the post is unchanged.
- Deleting an unknown post → 404; a remote post → 409 (unchanged behaviour).
- Deleting a post emits one `new-post` bus event (the same channel an edit uses).

---

## Task 2: Make the removal gates explicit

**Files:**
- Modify: `core/src/logical/projector.ts` — `nodeVisible`/`itemOrdinaryVisible` (~`:464-473`), `projectHistory` (~`:906-928`)
- Test: `core/test/logical-projector.test.ts`, plus wherever reply-target refusal is covered

**Why:** these paths currently detect removal by the `posts` row being gone. It no longer is, so they silently start passing.

**Requirements:**
- **The reply-target gate must refuse a removed post.** `itemOrdinaryVisible` is exported specifically as that gate and is reached via `store.replyTargetVisible` and `service.resolveReplyTarget` (`service.ts:59-65`). A removed post must not be a valid reply target. `isDeletedMarker` (`core/src/logical/threading.ts:29-31`) already answers "is there a marker" — reuse it rather than writing a second query.
- **`projectHistory` must refuse publicly for a removed post.** It gates on `projectItem`, which now succeeds, so the route would serve revisions again. For a moderator removal those revisions are exactly the content that was removed. Public history → 404 for a removed post; the admin item view keeps its own access.
- **Do not change** `adminItemState` (`core/src/logical/store.ts:245`) — it already checks the marker. Verify it still reports `deleted_local` and add a test if none covers it.
- **Check, do not assume**, what `projectThread` now does for a removed post: it will stop emitting a placeholder because the item projects. That is intended — the notice replaces "Post unavailable". Confirm the childless-leaf 404 at `threading.ts:419` still behaves sanely and write a test pinning whichever behaviour is correct.

**Tests (write first):** a removed post is not a valid reply target; its public history 404s; a thread containing a removed post still returns its replies.

---

## Task 3: Web surfaces for a removed post

**Files:**
- Modify: `web/src/routes/post/[id]/+page.svelte` — the reply composer (~`:118-125`)
- Modify: `web/src/lib/EditedMarker.svelte` if needed
- Test: the matching `*.test.ts` beside them

**REQUIRED SKILL:** invoke `ui-ux-pro-max:ui-ux-pro-max` before editing any Svelte file, and follow `design-system/rsc/MASTER.md`. No new colours — every colour comes from a `--color-*` variable in `web/src/app.css`.

**Requirements:**
- A removed post now renders as an ordinary item carrying the notice. **The reply composer must not be offered on it** — Task 2 makes the server refuse, and the UI must not invite an action that will fail.
- `EditedMarker` links to `/post/:id/history`, which Task 2 makes 404 for a removed post. Make that degrade sensibly rather than offering a dead link.
- Nothing else changes. The item renders through the ordinary post path; do not add a special component.

**Tests (write first):** the composer is absent for a removed post and present for an ordinary one.

---

## Verification

```
npm test -w core && npm run typecheck -w core
npm test -w web  && npm run check -w web
```

End to end, the thing that actually proves the design — and the only part that cannot be proven by tests:

1. Post on rsc, reply from alice, reply from bob.
2. Remove the rsc post as a moderator with category `spam`.
3. On rsc: the item is still there showing the notice, the replies still hang below it, no reply box, history 404s.
4. **On alice and bob, with no code change on their side:** the same item now shows the notice, in place, replies intact.
5. Author-deletes a post: revisions gone, peers show the author notice.
6. Delete an account: unchanged, posts vanish, nothing federates.

Feed bytes change by design, so validate the firehose against valid.rss.chat — a passing unit suite is weak evidence for wire format in this repo.
