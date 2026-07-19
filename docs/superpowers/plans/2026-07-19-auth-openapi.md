# Dev-only better-auth OpenAPI Reference — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dev-only better-auth OpenAPI reference, gated by a config flag that defaults off in prod AND hard-blocked at the web proxy, so it is never publicly reachable.

**Architecture:** A new `TEXTCASTER_AUTH_OPENAPI` on/off config flag conditionally registers better-auth's `openAPI()` plugin in core. The plugin's routes ride the existing `/api/auth/*` mount. The web proxy independently 404s `/api/auth/reference` + `/api/auth/open-api/*` in every environment (defense-in-depth). Dev enables the flag via `compose.yaml`; prod/Cloudron leave it unset.

**Tech Stack:** Hono (`core/`), better-auth `1.6.23` (`openAPI` from `better-auth/plugins`), SvelteKit (`web/`), vitest.

## Global Constraints

- **No new dependency.** `openAPI` ships inside the already-installed `better-auth`. Do not add packages.
- **Node 22 native type-stripping** in `core/src`: no TS parameter properties; constructors/factories assign fields plainly.
- **Type-stripping hides type errors from vitest** — every task that changes types MUST also run `npm run typecheck -w core` (core) and `npm run check -w web` (web). Green tests alone are not sufficient.
- **Web tests run inside the web container** with `CORE_API_URL` unset: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- <filter>`.
- **Git:** shared checkout — **never `git add -A`**; stage explicit paths. End every commit message with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Do not push (no remote agreed).
- **Boundary invariant (must hold after this plan):** `/api/auth/reference` and `/api/auth/open-api/*` are dev-only and never public — core flag defaults off in prod AND the web proxy hard-404s them. Both guards are load-bearing.

---

### Task 1: Config flag `authOpenApi`

**Files:**
- Modify: `core/src/config.ts` (add to `Config` interface + `loadConfig`)
- Test: `core/test/config.test.ts` (append)

**Interfaces:**
- Produces: `Config.authOpenApi: boolean` (default `false`), parsed from `TEXTCASTER_AUTH_OPENAPI` (`'on'`/`'off'`).

- [ ] **Step 1: Write the failing test**

Append to `core/test/config.test.ts`:
```ts
test('authOpenApi defaults off, accepts on, rejects garbage', () => {
  const base = { TEXTCASTER_TOKEN: 't', TEXTCASTER_AUTH_SECRET: 's' }
  expect(loadConfig(base).authOpenApi).toBe(false)
  expect(loadConfig({ ...base, TEXTCASTER_AUTH_OPENAPI: 'on' }).authOpenApi).toBe(true)
  expect(loadConfig({ ...base, TEXTCASTER_AUTH_OPENAPI: 'off' }).authOpenApi).toBe(false)
  expect(() => loadConfig({ ...base, TEXTCASTER_AUTH_OPENAPI: 'maybe' })).toThrow('TEXTCASTER_AUTH_OPENAPI')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w core -- config.test.ts`
Expected: FAIL — `authOpenApi` is `undefined` (property does not exist yet).

- [ ] **Step 3: Write minimal implementation**

In `core/src/config.ts`, add the field to the `Config` interface (after `pushIn: boolean`):
```ts
  authOpenApi: boolean
```
In `loadConfig`, after the `pushIn` block (mirrors `rssCloud`), add:
```ts
  const rawAuthOpenApi = env.TEXTCASTER_AUTH_OPENAPI ?? 'off'
  if (rawAuthOpenApi !== 'on' && rawAuthOpenApi !== 'off') throw new Error(`TEXTCASTER_AUTH_OPENAPI must be "on" or "off", got "${rawAuthOpenApi}"`)
  const authOpenApi = rawAuthOpenApi === 'on'
```
Add to the returned object (after `pushIn,`):
```ts
    authOpenApi,
```

- [ ] **Step 4: Run test + typecheck to verify pass**

Run: `npm test -w core -- config.test.ts && npm run typecheck -w core`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add core/src/config.ts core/test/config.test.ts
git commit -m "$(printf 'core(config): add TEXTCASTER_AUTH_OPENAPI on/off flag (default off)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 2: Conditionally register `openAPI()` in core

**Files:**
- Modify: `core/src/auth.ts` (add `authOpenApi` to `AuthDeps`, conditional plugin)
- Modify: `core/src/server.ts` (pass `config.authOpenApi` into `createAuth`)
- Modify: `core/test/auth-helper.ts` (`makeAuth` accepts the flag)
- Test: `core/test/auth-openapi.test.ts` (create)

**Interfaces:**
- Consumes: `Config.authOpenApi` (Task 1).
- Produces: `AuthDeps.authOpenApi: boolean` (required); `makeAuth(repo, mailer?, authOpenApi?)` — third param defaults `false`. When on, `auth.api.generateOpenAPISchema` is a function; when off, it is `undefined`.

- [ ] **Step 1: Write the failing test**

Create `core/test/auth-openapi.test.ts`:
```ts
import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { makeAuth } from './auth-helper.ts'

// The reviewer-approved assertion: prove the flag toggles OUR conditional,
// not better-auth's schema output (which is better-auth's to test).
test('generateOpenAPISchema is present only when the flag is on', async () => {
  const repo = await createSqliteRepository(':memory:')
  const off = makeAuth(repo)              // flag defaults off
  const on = makeAuth(repo, null, true)   // flag on
  expect(typeof (off.api as Record<string, unknown>).generateOpenAPISchema).toBe('undefined')
  expect(typeof (on.api as Record<string, unknown>).generateOpenAPISchema).toBe('function')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w core -- auth-openapi.test.ts`
Expected: FAIL — `makeAuth` has no third parameter yet and `openAPI()` is never registered, so the `on` case has no `generateOpenAPISchema`.

- [ ] **Step 3: Write minimal implementation**

In `core/src/auth.ts`:

Change the plugins import (line 2) to add `openAPI`:
```ts
import { anonymous, magicLink, openAPI } from 'better-auth/plugins'
```
Add to the `AuthDeps` interface (after `mailer: Mailer | null`):
```ts
  authOpenApi: boolean
```
Replace the inline `plugins: [ … ]` array in the `betterAuth({...})` call with a built array. Just before `return betterAuth({`, keep the config; change the `plugins:` property to `plugins,` and build it above the `return`:
```ts
  const plugins = [
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        if (!deps.mailer) throw new Error('email is not configured on this instance')
        await deps.mailer.send(email, 'Your Textcaster login link', `Log in: ${url}`)
      },
    }),
    anonymous({
      async onLinkAccount({ anonymousUser, newUser }) {
        const guest = await deps.users.getUserByAuthUserId(anonymousUser.user.id)
        if (!guest) return
        const existing = await deps.users.getUserByAuthUserId(newUser.user.id)
        if (existing) return
        await deps.users.setAuthUserId(guest.id, newUser.user.id)
      },
    }),
  ]
  // Dev-only OpenAPI reference (spec 2026-07-19). Routes ride the /api/auth/*
  // mount; the web proxy independently 404s them so this never goes public.
  if (deps.authOpenApi) plugins.push(openAPI())

  return betterAuth({
    // …existing config unchanged…
    plugins,
  })
```
(Preserve every existing option — `database`, `secret`, `baseURL`, `emailAndPassword`, `emailVerification`, `session`, `rateLimit`, `advanced`. Only `plugins` moves out to the local `const`.)

In `core/src/server.ts`, update the `createAuth({...})` call to pass the flag:
```ts
const auth = createAuth({ sqlite: repo.raw, users: repo, secret: config.authSecret, webOrigin: config.webOrigin, anonTtlDays: config.anonTtlDays, mailer, authOpenApi: config.authOpenApi })
```

In `core/test/auth-helper.ts`, update `makeAuth`:
```ts
export function makeAuth(repo: SqliteRepository, mailer: Mailer | null = fakeMailer().mailer, authOpenApi = false) {
  return createAuth({ sqlite: repo.raw, users: repo, secret: 'test-secret', webOrigin: 'http://web.test', anonTtlDays: 7, mailer, authOpenApi })
}
```

- [ ] **Step 3b: Confirm no other `createAuth` caller broke**

Run: `grep -rn "createAuth(" core/src core/test`
Expected: only `core/src/server.ts` and `core/test/auth-helper.ts` call it (both updated). If any other caller exists, add `authOpenApi` there too.

- [ ] **Step 4: Run test + full suite + typecheck**

Run: `npm test -w core -- auth-openapi.test.ts`
Expected: PASS.
Run: `npm test -w core && npm run typecheck -w core`
Expected: whole core suite green (the new required `AuthDeps.authOpenApi` is satisfied everywhere); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add core/src/auth.ts core/src/server.ts core/test/auth-helper.ts core/test/auth-openapi.test.ts
git commit -m "$(printf 'core(auth): register openAPI() plugin when TEXTCASTER_AUTH_OPENAPI=on\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 3: Web proxy denylist (the security guarantee)

**Files:**
- Modify: `web/src/routes/api/auth/[...path]/+server.ts` (guard at top of `proxy`)
- Test: `web/src/routes/api/auth/proxy.test.ts` (create)

**Interfaces:**
- Independent of Tasks 1–2. Produces: proxy returns 404 for `params.path === 'reference'` or `params.path.startsWith('open-api')`, without calling upstream `fetch`.

- [ ] **Step 1: Write the failing test**

Create `web/src/routes/api/auth/proxy.test.ts`:
```ts
import { test, expect, vi, afterEach } from 'vitest'
import { GET } from './[...path]/+server.ts'

function event(path: string) {
  return {
    request: new Request(`http://x/api/auth/${path}`),
    params: { path },
    url: new URL(`http://x/api/auth/${path}`),
    cookies: { getAll: () => [], set: vi.fn(), delete: vi.fn() },
    getClientAddress: () => '203.0.113.1',
  }
}

afterEach(() => vi.unstubAllGlobals())

test('proxy hard-404s the openAPI reference + schema without reaching core', async () => {
  const upstream = vi.fn(async () => new Response('should not be called', { status: 200 }))
  vi.stubGlobal('fetch', upstream)
  for (const p of ['reference', 'open-api/generate-schema']) {
    const res = await GET(event(p) as never)
    expect(res.status).toBe(404)
  }
  expect(upstream).not.toHaveBeenCalled()
})

test('proxy still forwards a normal auth path to core', async () => {
  const upstream = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', upstream)
  const res = await GET(event('sign-in/email') as never)
  expect(upstream).toHaveBeenCalledOnce()
  expect(res.status).toBe(200)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- proxy`
Expected: FAIL — `reference` is proxied (tries to `fetch` core / returns non-404), and `upstream` IS called.
(If the stack isn't up: `docker compose up -d` first.)

- [ ] **Step 3: Write minimal implementation**

In `web/src/routes/api/auth/[...path]/+server.ts`, add the guard as the FIRST statement inside `proxy`, immediately after the arrow-function opening brace:
```ts
	// Dev-only openAPI reference (spec 2026-07-19-auth-openapi): better-auth's
	// openAPI() plugin serves /api/auth/reference + /api/auth/open-api/* under
	// the auth base path, which this proxy would otherwise publish. Hard-404 them
	// in EVERY environment — the second, independent guard beside the core flag
	// defaulting off. 404 (not 403) so we don't even confirm the route exists.
	if (params.path === 'reference' || params.path.startsWith('open-api')) {
		return new Response(null, { status: 404 })
	}
```

- [ ] **Step 4: Run test + svelte-check**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- proxy`
Expected: PASS (both denied paths 404, upstream not called; normal path forwards).
Run: `docker compose exec -T web npm run check -w web`
Expected: svelte-check clean.

- [ ] **Step 5: Commit**

```bash
git add "web/src/routes/api/auth/[...path]/+server.ts" web/src/routes/api/auth/proxy.test.ts
git commit -m "$(printf 'web(auth-proxy): hard-404 openAPI reference + schema (never public)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 4: Wire dev compose + document the boundary

**Files:**
- Modify: `compose.yaml` (core service env)
- Modify: `README.md` (dev affordance note)
- Modify: `CLAUDE.md` (record the boundary invariant)
- Verify unchanged (deliberately absent): `compose.prod.yaml`, Cloudron manifest.

**Interfaces:** Consumes the `TEXTCASTER_AUTH_OPENAPI` flag name (Task 1). No unit test — infra + docs; verified by rendering the compose config.

- [ ] **Step 1: Enable the flag in dev only**

In `compose.yaml`, under `services.core.environment`, add (after `TEXTCASTER_WEB_ORIGIN`):
```yaml
      # Dev-only: serves the better-auth OpenAPI reference at
      # http://localhost:8787/api/auth/reference. Off (unset) in prod/Cloudron;
      # the web proxy also 404s it, so it is never publicly reachable.
      TEXTCASTER_AUTH_OPENAPI: "on"
```

- [ ] **Step 2: Verify dev renders it on, prod does not**

Run: `docker compose -f compose.yaml config | grep -A1 -i AUTH_OPENAPI`
Expected: shows `TEXTCASTER_AUTH_OPENAPI: "on"` under core.
Run: `grep -c AUTH_OPENAPI compose.prod.yaml`
Expected: `0` (flag absent in prod → defaults off).

- [ ] **Step 3: Document the dev affordance in README**

In `README.md`, in the local/dev section (near where the Mailpit UI URL is mentioned), add a bullet:
```markdown
- **Auth API reference (dev only):** with the dev stack up, browse
  <http://localhost:8787/api/auth/reference> for the better-auth OpenAPI/Scalar
  reference. Enabled by `TEXTCASTER_AUTH_OPENAPI=on` (set in `compose.yaml`);
  unset in prod, and the web proxy 404s it, so it is never public.
```

- [ ] **Step 4: Record the boundary invariant in CLAUDE.md**

In `CLAUDE.md`, in the "Core building blocks — Hono + better-auth" section, append to the better-auth bullet (after the plugins-in-use sentence):
```markdown
  Dev-only: `TEXTCASTER_AUTH_OPENAPI=on` mounts the better-auth OpenAPI
  reference at `/api/auth/reference`; it is **never public** — the flag
  defaults off in prod AND the web proxy hard-404s `/api/auth/reference` +
  `/api/auth/open-api/*` (both guards load-bearing; keep both).
```

- [ ] **Step 5: Commit**

```bash
git add compose.yaml README.md CLAUDE.md
git commit -m "$(printf 'chore(auth-openapi): enable reference in dev compose + document boundary\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

## Self-Review

**Spec coverage:**
- §1 flag → Task 1. ✓
- §2 plugin registration → Task 2. ✓
- §3 web denylist → Task 3. ✓
- §4 compose wiring → Task 4 (Steps 1–2). ✓
- New boundary invariant (record in CLAUDE.md) → Task 4 Step 4. ✓
- Testing/core (rev 1: assert toggle, not schema output) → Task 2 Step 1. ✓
- Testing/web (security-critical 404) → Task 3 Step 1. ✓
- README dev note → Task 4 Step 3. ✓
- Out-of-scope items (prod serving, non-auth API docs, passkey/multi-session) → not planned. ✓

**Placeholder scan:** none — every code/test step shows full code; every run step shows the command + expected result.

**Type consistency:** `authOpenApi` is the field name across `Config` (Task 1), `AuthDeps` + `makeAuth` + `server.ts` (Task 2); env var `TEXTCASTER_AUTH_OPENAPI` consistent across config parse (Task 1) and compose (Task 4). Denylist predicate (`params.path === 'reference' || params.path.startsWith('open-api')`) matches the test's paths (`reference`, `open-api/generate-schema`) in Task 3. `generateOpenAPISchema` name matches the better-auth API.

## Execution Handoff

Two execution options:
1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between tasks.
2. **Inline Execution** — batch execution in this session with checkpoints.
