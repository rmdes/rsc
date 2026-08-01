# Authed Write API (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship key-authed write access — create/edit/delete a post, follow/
unfollow a user, subscribe/unsubscribe a remote source, edit your profile —
plus extend the phase-2 settings page so a user can actually mint keys with
these new permissions. Phase 3 of
`docs/superpowers/specs/2026-08-01-external-api-and-firehose-design.md`
("Write endpoints (phase 3)"). Phases 1 (firehose) and 2 (read API + key
management) are already merged. Phase 4 (admin tier) is a separate plan.

**Architecture:** All eight new routes are key-authed twins of EXISTING
cookie-authed routes in `core/src/api/app.ts` — same underlying `service`/
source-plane calls, same validation, same error shapes, just gated by
`apiKeyAuth(auth, users, {resource:['write']})` instead of `authed`. They
extend `mountPersonalApiRoutes` (`core/src/api/logical-routes.ts`, built in
phase 2), which already lives at the right wiring point (`app.ts`'s
`createApp`, where `service`/`sources.service` are already in scope).
**Zero new web-proxy code is needed** — Task 4 of phase 2 deliberately
exported `POST`/`PATCH`/`DELETE` on the generic `/api/v1/[...path]` proxy
in anticipation of exactly this phase, and none of the new routes' core
paths start with `api/` (the one guard that proxy enforces), so every new
route is externally reachable the moment it exists on core. This plan is
core-only work except its last task (the settings-page permission
checkboxes).

**A real gap found during planning, already resolved with the user:** the
spec's "delete equivalent" for posts assumes a self-serve delete exists to
mirror — it doesn't. Today only `DELETE /admin/posts/:id` (admin-gated) can
hard-delete a post; a regular user can edit their own post but has no
self-serve delete anywhere in this app, web UI included. **Decision: build
it**, scoped to the caller's own posts (same ownership-check pattern
`PATCH /posts/:id` already uses), reusing the exact `service.deletePost`
the admin route already calls. API-only for now — not wired into the web
UI in this plan.

**Tech Stack:** Hono, the existing `apiKeyAuth`/`mountPersonalApiRoutes`
machinery from phase 2, SvelteKit (Task 4 only). No new dependencies.

## Global Constraints

- Every new route composes `apiKeyAuth(auth, users, {resource:['action']})`
  with the SAME permission-vocabulary discipline phase 2 established:
  `posts: ['read','write']` (read already exists; this plan adds `write`),
  `follows: ['write']`, `profile: ['write']` — no `follows:['read']` or
  `profile:['read']` (the spec defines no read routes for these resources;
  do not invent permissions with no route checking them).
  `configId:'admin'`/`admin.*` remain fully out of scope (phase 4).
- No existing cookie-authed route's behavior, validation, or error shape
  changes. Every new route is an ADDITIONAL entry point calling the same
  `service`/source-plane functions — never a modification to `app.ts`'s
  existing `POST /posts`, `PATCH /posts/:id`, `POST /me/follows`,
  `DELETE /me/follows/:target`, `POST /me/subscriptions`,
  `DELETE /me/subscriptions/:sourceId`, or `PATCH /me`.
- Each new route mirrors its cookie-authed sibling's EXACT current gating,
  including inconsistencies — e.g. `POST /me/subscriptions` uses
  `registeredOnly()`, `POST /me/follows` does not. Faithfully mirror this
  per-route, don't "fix" the asymmetry (it's moot in practice: a key can
  only be held by a registered user per phase 2's own enforcement, so
  adding `registeredOnly()` where the cookie sibling lacks it would be a
  check that can never fire — YAGNI).
- The new self-serve `DELETE /api/v1/posts/:id` is scoped to the caller's
  OWN posts only (`post.authorId === c.get('coreUser').id`), matching
  `PATCH /posts/:id`'s existing ownership check exactly. It must not be
  reachable for any other user's post, local or remote.
- Task 4's settings-page checkbox additions offer ONLY the permissions this
  plan's routes actually enforce (`posts:write`, `follows:write`,
  `profile:write`, alongside phase 2's existing `timeline:read`/
  `posts:read`) — no `admin.*` options, ever, from the user-tier panel.

---

### Task 1: `POST/PATCH/DELETE /api/v1/posts` (posts:write)

**Files:**
- Modify: `core/src/api/logical-routes.ts` — extend `PersonalApiDeps` +
  `mountPersonalApiRoutes` with the three post-write routes.
- Modify: `core/src/api/app.ts` — pass `service` into the
  `mountPersonalApiRoutes` call (currently only passes `store`/`auth`/`users`).
- Test: `core/test/personal-api-routes.test.ts` (extend the existing file).

**Interfaces:**
- Consumes: `service.createLocalPostAs(handle, displayName, content,
  replyTarget?)`, `service.editLocalPost(post, content, author)`,
  `service.getPost(id)`, `service.deletePost(id): Promise<{ok:true} |
  {error:'unknown'|'remote'}>`, `service.resolveReplyTarget(inReplyTo)` (all
  in `core/src/domain/service.ts`, already used by `app.ts`'s cookie-authed
  siblings — read those exact call sites, at `POST /posts`/`PATCH
  /posts/:id`/the admin `DELETE /admin/posts/:id`, fresh before writing
  this task, since this plan's line-number references may have drifted).
- Produces: three new core routes. **Naming (verified during planning,
  settled — not an open question for the implementer):** Hono matches on
  the (method, path) pair, not path alone — confirmed by running a live
  2-route Hono instance inside this project's own core container
  (`app.get('/x', ...)` + `app.post('/x', ...)` on one instance, both
  independently reachable). This means `POST /me/posts` and phase 2's
  existing `GET /me/posts` share a path but are fully independent routes —
  no collision, no fallback naming needed. What genuinely WOULD collide is
  registering a second handler for the exact same (method, path)
  `app.ts` already claims — e.g. a second `POST /posts` — so the three new
  routes use `/me/posts` instead of bare `/posts`, consistent with phase
  2's own `/me/timeline`/`/me/posts` (read) and `/me/api-keys` naming:
  - `POST /me/posts`
  - `PATCH /me/posts/:id`
  - `DELETE /me/posts/:id`

- [ ] **Step 1: Read the current file fresh**

Read `core/src/api/logical-routes.ts`'s current `PersonalApiDeps`/
`mountPersonalApiRoutes` (added in phase 2, may have shifted since) and
`core/src/api/app.ts`'s `POST /posts`/`PATCH /posts/:id`/the admin
`DELETE /admin/posts/:id` fresh, by content not by any line number cited
above.

- [ ] **Step 2: Write the failing tests**

Add to `core/test/personal-api-routes.test.ts` (read the existing file's
`setup()`/`freshApp()` helpers first — reuse them, don't reinvent):

```ts
test('POST /me/posts creates a post as the key owner (posts:write)', async () => {
  const { app, cookie } = await freshApp('poster@x.test')
  const auth = /* the auth instance freshApp already built — read the real return shape */
  // mint a posts:write key the same way existing tests mint timeline:read keys
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  const key = (await (auth.api as unknown as ApiKeyCreation).createApiKey({
    body: { configId: 'user', userId: session!.user.id, permissions: { posts: ['write'] } }
  })).key!
  const res = await app.request('/me/posts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ content: 'hello from the api' })
  })
  expect(res.status).toBe(201)
  const body = await res.json()
  expect(body.post.content).toBe('hello from the api')
})

test('POST /me/posts requires posts:write, not posts:read', async () => {
  // a timeline:read-only key (or posts:read-only) must NOT be able to create
})

test('PATCH /me/posts/:id edits only the key owner\'s own post', async () => {
  // create a post as owner A, attempt PATCH with owner B's posts:write key -> 403
  // attempt PATCH with owner A's key -> 200, content updated
})

test('DELETE /me/posts/:id deletes only the key owner\'s own post, never another user\'s', async () => {
  // create a post as owner A, attempt DELETE with owner B's posts:write key -> 403 (not editable / not found — match PATCH's existing 403 shape)
  // attempt DELETE with owner A's key -> 200, then GET /post/:id (existing route) confirms it's gone
})

test('DELETE /me/posts/:id 404s for an unknown post id', async () => {})
test('DELETE /me/posts/:id refuses a remote post (never deletable by any user)', async () => {})
```

Write the COMPLETE test bodies yourself, following the exact assertion
style and helper reuse (`freshApp`, `ApiKeyCreation` cast,
`service.createLocalPostAs`) already established in this file from phase
2 — the skeletons above show intent and coverage, not literal final code;
this brief cannot enumerate every assertion without re-deriving the file's
current exact helpers, which you must read fresh per Step 1.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `docker compose exec -T core npm test -w core -- personal-api-routes`
Expected: FAIL — the new routes don't exist.

- [ ] **Step 4: Implement the three routes**

Extend `PersonalApiDeps` to add `service: Service` (already imported
type-only in this file). Extend `mountPersonalApiRoutes`'s destructure to
include it. Add the three routes at the paths settled above
(`POST/PATCH/DELETE /me/posts`, `/me/posts/:id`), each `apiKeyAuth`-gated,
each calling the SAME service functions their cookie-authed siblings
call, with the SAME validation/error shapes — transcribe from `app.ts`'s
real current `POST /posts`/`PATCH /posts/:id` bodies (read fresh, don't
trust this brief's earlier paraphrase), and for DELETE, mirror `PATCH
/posts/:id`'s ownership-check pattern (`post.source !== 'local' ||
post.authorId !== me.id` → 403) before calling `service.deletePost(id)`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `docker compose exec -T core npm test -w core -- personal-api-routes`
Expected: all new tests pass.

- [ ] **Step 6: Full core suite + typecheck**

Run: `docker compose exec -T core npm test -w core` and
`docker compose exec -T core npm run typecheck -w core`
Expected: all passing (verify fresh baseline count first — don't trust a
number from an earlier point in this plan's own writing), 0 errors.

- [ ] **Step 7: Commit**

```bash
git add core/src/api/logical-routes.ts core/src/api/app.ts core/test/personal-api-routes.test.ts
git commit -m "$(cat <<'EOF'
feat(core): key-authed post create/edit/delete (posts:write)

Three routes, each a key-authed twin of an existing cookie-authed
route (or, for delete, a genuinely new self-serve capability that
didn't exist before — only admins could hard-delete a post until
now; this scopes it to the caller's own posts, reusing the exact
service.deletePost the admin route already calls, with the same
ownership check PATCH already uses).

developed with the help of AI tools
EOF
)"
```

---

### Task 2: `POST/DELETE /api/v1/follows` + `POST/DELETE /api/v1/subscriptions` (follows:write)

**Files:**
- Modify: `core/src/api/logical-routes.ts` — extend `PersonalApiDeps` +
  `mountPersonalApiRoutes` with four routes.
- Modify: `core/src/api/app.ts` — pass `sources: {service, repo}` (or
  whichever subset `v2`/the subscribe calls need) into the
  `mountPersonalApiRoutes` call.
- Test: `core/test/personal-api-routes.test.ts` (extend further).

**Interfaces:**
- Consumes: `service.addFollow(follower: User, target: User)`,
  `service.removeFollow(followerId: string, target: User)` (confirm exact
  signature fresh — Task 1's own grounding already confirmed
  `addFollow(follower, target)` takes full `User` objects; re-verify
  `removeFollow`'s exact parameters before use, do not assume it's
  identical in shape), `service.getUserByHandle(handle)` (for resolving a
  target handle, matching `app.ts`'s existing `resolveUser` helper — read
  it fresh), and the source-plane's `v2.subscribeByUrl(user, url,
  commandId)` / `v2.unsubscribe(userId, sourceId, commandId)` (read
  `core/src/domain/source-service.ts`'s real exported shape, and re-read
  `app.ts`'s `POST /me/subscriptions`/`DELETE /me/subscriptions/:sourceId`
  handlers fresh for the exact response-shape switch/error mapping to
  mirror — this is the most structurally complex pair in this plan, with a
  4-way result switch (`source`/`local`/`cap`/`conflict`) that must be
  reproduced exactly, not simplified).
- Produces: four new routes. **Naming — a genuinely different case from
  Task 1's, not the same pattern reused:** unlike `POST /me/posts` (no
  existing route at that exact method+path, so the bare name was free),
  `app.ts` already has `POST /me/follows` and `DELETE
  /me/follows/:target` at those EXACT method+path pairs — reusing them
  here would be a real collision (confirmed mechanism: Hono matches
  method+path, and identical pairs on one instance means the second
  registration is unreachable). These four routes need genuinely distinct
  paths: `POST /me/api-follows` / `DELETE /me/api-follows/:target` and
  `POST /me/api-subscriptions` / `DELETE /me/api-subscriptions/:sourceId`
  (the `api-` infix disambiguates from the cookie-authed siblings,
  consistent in spirit with `POST /me/api-keys` from phase 2 — also a
  path chosen specifically to avoid colliding with better-auth's own
  `/api/auth/api-key/*`).

- [ ] **Step 1: Read the current file and real source fresh**

Read `core/src/api/logical-routes.ts`'s state after Task 1 landed and
`core/src/domain/source-service.ts`'s real `subscribeByUrl`/`unsubscribe`
signatures and `core/src/api/app.ts`'s current `POST
/me/subscriptions`/`DELETE /me/subscriptions/:sourceId` handlers in full,
fresh.

- [ ] **Step 2: Write the failing tests**

Cover, at minimum: follow success (`posts` — no, `follows:write` key,
`POST` with a valid target handle → the same shape `app.ts`'s route
returns), follow with an unknown handle → 404 (matching), unfollow
success, unfollow unknown target → 404, subscribe success for a real feed
URL (reuse whatever mock-fetch harness `core/test/logical-moderation.test.ts`
or similar already established for a fake feed response, don't hand-roll
a new one), subscribe with an invalid URL → 400, subscribe idempotency
(same `commandId` replayed → the existing 409-conflict-or-200 semantics,
not a duplicate), unsubscribe success, unsubscribe with a bad `commandId`
→ 400, a `follows:write` key correctly REJECTED from the phase-2
`posts:read`-gated routes and vice versa (permission isolation, matching
the cross-permission-rejection tests phase 2 already established for
`timeline`/`posts`).

- [ ] **Step 3: Run the tests to verify they fail**

Run: `docker compose exec -T core npm test -w core -- personal-api-routes`

- [ ] **Step 4: Implement the four routes**

Mirror each cookie-authed sibling's exact body shape, error mapping, and
response shape — this is a transcription task once Step 1's fresh read is
done, not a redesign. Reuse `readJsonBody`/`isString` already defined at
module scope in this file (do not re-import from `app.ts`, they're
intentionally duplicated per-file in this codebase's house style — verify
this is still true by checking whether `logical-routes.ts` already has its
own copies, per what earlier grounding in this plan's own writing found).
For the subscribe route's `isBadSourceUrl` error-classification check
(used by `app.ts`'s handler): decide whether to export it from `app.ts`
and import here, or duplicate it locally — `isBadSourceUrl` is a real
behavioral classifier (not a trivial one-liner like `isString`), so
duplicating it risks the two copies drifting; exporting+importing is
likely the better call, but verify `app.ts` doesn't already export
something usable before deciding, and use your judgment per this
codebase's established "duplicate trivial validators, share real logic"
pattern.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `docker compose exec -T core npm test -w core -- personal-api-routes`

- [ ] **Step 6: Full core suite + typecheck**

Run: `docker compose exec -T core npm test -w core` and
`docker compose exec -T core npm run typecheck -w core`

- [ ] **Step 7: Commit**

```bash
git add core/src/api/logical-routes.ts core/src/api/app.ts core/test/personal-api-routes.test.ts
git commit -m "$(cat <<'EOF'
feat(core): key-authed follow/unfollow + subscribe/unsubscribe (follows:write)

Four routes, key-authed twins of the existing cookie-authed follow
and remote-source-subscription routes, same validation/response
shapes/idempotency semantics as their siblings.

developed with the help of AI tools
EOF
)"
```

---

### Task 3: `PATCH /api/v1/me` (profile:write)

**Files:**
- Modify: `core/src/api/logical-routes.ts` — extend `mountPersonalApiRoutes`.
- Test: `core/test/personal-api-routes.test.ts` (extend further).

**Interfaces:**
- Consumes: `service.updateUserProfile(userId, {handle?, displayName?})`
  (re-read `app.ts`'s `PATCH /me` fresh for the exact validation/
  `HandleTakenError` handling to mirror).
- Produces: one route. Naming: `app.ts`'s bare `PATCH /me` is already
  registered at that exact method+path — a real collision (same kind as
  Task 2's follows/subscriptions routes, not Task 1's posts routes). Use
  `PATCH /me/api-profile`, matching Task 2's `api-`-infix convention.

- [ ] **Step 1: Read the current state fresh**

Read `core/src/api/app.ts`'s `PATCH /me` handler and
`core/src/api/logical-routes.ts`'s state after Tasks 1-2, fresh.

- [ ] **Step 2: Write the failing tests**

Cover: successful handle-only update, successful displayName-only update,
both together, handle-taken conflict → 409 (matching `HandleTakenError`
handling), empty body (`nothing to update`) → 400, a `profile:write` key
correctly rejected from `posts`/`follows`-gated routes and vice versa.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `docker compose exec -T core npm test -w core -- personal-api-routes`

- [ ] **Step 4: Implement the route**

Mirror `app.ts`'s `PATCH /me` exactly — same validation, same
`HandleTakenError` → 409 mapping.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `docker compose exec -T core npm test -w core -- personal-api-routes`

- [ ] **Step 6: Full core suite + typecheck**

Run: `docker compose exec -T core npm test -w core` and
`docker compose exec -T core npm run typecheck -w core`

- [ ] **Step 7: Commit**

```bash
git add core/src/api/logical-routes.ts core/test/personal-api-routes.test.ts
git commit -m "$(cat <<'EOF'
feat(core): key-authed profile update (profile:write)

Key-authed twin of PATCH /me, same validation and HandleTakenError
handling. Handle changes through this path inherit whatever the
Handle History backlog idea eventually does about old-handle
survival — not solved here, a shared seam noted in the spec.

developed with the help of AI tools
EOF
)"
```

---

### Task 4: Extend the self-serve key permission whitelist + settings-page checkboxes

**Files:**
- Modify: `core/src/api/logical-routes.ts` — extend `ALLOWED_KEY_PERMISSIONS`
  (added phase 2, `POST /me/api-keys`'s whitelist).
- Modify: `web/src/routes/settings/api-keys/permissions.ts` and
  `web/src/routes/settings/api-keys/+page.svelte` — offer the new
  permission checkboxes.
- Test: `core/test/personal-api-routes.test.ts` + the relevant web test
  file for the settings page (read `web/src/routes/settings/api-keys/
  api-keys.server.test.ts` first for the existing pattern).

**Interfaces:**
- Consumes: nothing new — this task only widens an existing whitelist
  constant and an existing UI's option list.
- Produces: nothing later tasks depend on (this plan's last task).

**Before starting:** this task touches UI (new checkboxes on an existing
page). Per CLAUDE.md, invoke `ui-ux-pro-max` before editing
`+page.svelte`, though the change itself is small (extending an existing
checkbox list, not new layout) — read `design-system/rsc/MASTER.md` if
anything about the new checkboxes' presentation isn't already covered by
the existing pattern.

- [ ] **Step 1: Read the current state fresh**

Read `core/src/api/logical-routes.ts`'s `ALLOWED_KEY_PERMISSIONS`
constant (phase 2) and `web/src/routes/settings/api-keys/permissions.ts` +
`+page.svelte`'s current checkbox rendering, fresh, after Tasks 1-3 landed.

- [ ] **Step 2: Write the failing tests**

Core: a `POST /me/api-keys` call requesting `{posts:['write']}` (or
`follows:['write']`, or `profile:['write']`) currently 400s (still
whitelisted to only `timeline:read`/`posts:read` from phase 2) — write a
test proving it should now succeed (201), and that a still-disallowed
resource (e.g. `admin.moderation`) still 400s (regression coverage for
the phase-4 boundary staying closed).

Web: a test proving the settings page now offers checkboxes for the new
permissions (read the existing `api-keys.server.test.ts`/permissions
tests for the exact assertion style already established).

- [ ] **Step 3: Run the tests to verify they fail**

Run: `docker compose exec -T core npm test -w core -- personal-api-routes`
and `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run settings/api-keys`

- [ ] **Step 4: Extend `ALLOWED_KEY_PERMISSIONS`**

```ts
const ALLOWED_KEY_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  timeline: ['read'],
  posts: ['read', 'write'],
  follows: ['write'],
  profile: ['write'],
}
```

(Read the real current constant first — this is illustrative of the
INTENT, confirm the exact current shape/formatting before editing.)

- [ ] **Step 5: Extend the settings-page checkboxes**

Read `web/src/routes/settings/api-keys/permissions.ts`'s current
structure (phase 2 defined it for `timeline:read`/`posts:read` — likely a
small array/object of `{resource, action, label}` tuples the `+page.svelte`
maps over) and add entries for `posts:write`, `follows:write`,
`profile:write` with clear, user-facing labels (e.g. "Create, edit, and
delete my posts" / "Follow, unfollow, and manage my subscriptions" /
"Edit my profile"). Follow the existing file's exact pattern — this should
be a data-only addition, not a `+page.svelte` structural change, if
phase 2 built the checkbox list generically (verify this is true before
assuming it).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `docker compose exec -T core npm test -w core -- personal-api-routes`
and `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run settings/api-keys`

- [ ] **Step 7: Full suites + typecheck, both workspaces**

Run: `docker compose exec -T core npm test -w core`,
`docker compose exec -T core npm run typecheck -w core`,
`docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run`,
`docker compose exec -T web npm run -w web check`

- [ ] **Step 8: Manual browser check**

Per CLAUDE.md's UI testing requirement: create a key with one of the new
write permissions via the real settings page, confirm it works against
the corresponding new route (e.g. a `posts:write`-only key successfully
`POST`s to the new post-create route via `curl -H "x-api-key: ..."`), and
confirm a key WITHOUT that permission is refused. Report what you actually
ran, not just that tests passed.

- [ ] **Step 9: Commit**

```bash
git add core/src/api/logical-routes.ts web/src/routes/settings/api-keys/permissions.ts web/src/routes/settings/api-keys/+page.svelte core/test/personal-api-routes.test.ts
git commit -m "$(cat <<'EOF'
feat(settings): offer the new write permissions as self-serve key options

The three new resource:write permissions from this phase are now
mintable through the settings page's existing checkbox list, and the
POST /me/api-keys whitelist that enforces the boundary regardless of
what the UI offers is extended to match. admin.* stays closed.

developed with the help of AI tools
EOF
)"
```

---

## Self-Review

**Spec coverage:** "Write endpoints (phase 3)"'s three bullet groups map to
Tasks 1 (posts), 2 (follows + subscription-management, per the spec's own
"unfollow/subscription-management equivalents" phrasing bundling both
under one `follows:['write']` permission), 3 (profile). Task 4 covers the
part of "Key management UX" phase 2 explicitly deferred ("write/follows/
profile checkboxes land with phase 3's routes, not before"). Explicitly
out of scope: `configId:'admin'`/the admin tier (phase 4), CORS (non-goal,
every phase).

**Placeholder scan:** no open questions left for the implementer to guess
at. One real question came up while writing this plan — whether the new
write routes could reuse their cookie-authed siblings' bare paths — and
was resolved during planning itself, not deferred: ran a live 2-route Hono
instance inside this project's own core container to confirm Hono matches
on the (method, path) pair (same as every standard REST router), which
settled that `POST /me/posts` (no existing route at that exact pair) needs
no workaround while `POST /me/follows`/`PATCH /me` (both already claimed
by `app.ts`) genuinely do — hence Task 1's routes keep their natural
names and Tasks 2-3's use an `api-`-infixed alternative, each for a
concretely different, stated reason, not a guess.

**Type consistency:** `PersonalApiDeps` grows across Tasks 1-3 (adding
`service`, then subscription-related deps, no removal) — each task's
`app.ts` wiring change is additive to the same call site, not a competing
edit. `apiKeyAuth`'s call signature is unchanged from phase 2 throughout.

**A design gap resolved during planning, not deferred silently:** phase
3's spec text assumed a self-serve post-delete capability existed to
mirror. It didn't. Rather than either quietly skip delete (under-
delivering the spec) or invent scope unilaterally (over-delivering
without sign-off), this was surfaced to the user directly during planning
and resolved before any task text was written — the decision (build it,
ownership-scoped, API-only) is now Task 1's explicit framing, not an
assumption.
