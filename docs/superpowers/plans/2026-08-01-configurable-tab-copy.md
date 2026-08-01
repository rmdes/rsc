# Configurable Tab Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an instance admin edit the four timeline tab labels and subtitles from `/admin/settings`, with no rebuild; unset values fall back to the built-in defaults.

**Architecture:** Core persists only *overrides* in its existing key-value settings store and serves them (plus `mailEnabled`) from a new public `GET /instance/config`; `/health` reverts to a pure probe. The web root layout fetches `/instance/config`, merges each override with the `web/src/lib/tabs.ts` default (`override ?? default`), and passes `tabLabels`/`tabSubtitles` to the nav and page-head. The `?tab=` routing keys and `resolveTab` never change.

**Tech Stack:** core = Hono + Kysely + better-sqlite3 (Node 22 native type-stripping, no build); web = SvelteKit (Svelte 5 runes, adapter-node). Dev in Docker.

**Spec:** `docs/superpowers/specs/2026-08-01-configurable-tab-copy-design.md`
**Spec review folded:** `docs/superpowers/reviews/2026-08-01-configurable-tab-copy-review.md`
**Plan review folded (rev 2):** `docs/superpowers/reviews/2026-08-01-configurable-tab-copy-plan-review.md` — C1 (numeric fields must accompany tab PATCH bodies), I2 (escaped `CONTROL_CHARS` literal), I3 (real `makeApp`/`registeredSession` harness; extend existing `admin-settings.test.ts`), plus a folder-found regression (the 4 existing GET `toEqual` assertions must gain `tabLabels`/`tabSubtitles`).

## Global Constraints

- **The `?tab=` keys never change.** `TABS`, `resolveTab`, all `?tab={key}` form actions and pagination links stay `local/federated/personal/public`. Only display copy is configurable. Existing `web/src/lib/tabs.test.ts` (resolveTab/keys) MUST stay green.
- **Defaults live in exactly one place:** `web/src/lib/tabs.ts` (`TAB_LABELS`, `TAB_SUBTITLES`). Core stores only overrides and never hardcodes a default *string*. Core DOES hardcode the four tab *keys* (`local/federated/personal/public`) — it is a separate npm workspace and cannot import web's `TABS`. Keys are the contract; strings are not.
- **Copy renders as escaped text, never `{@html}`.** Admin strings appear via normal Svelte interpolation. This is the XSS boundary; no sanitizer is involved and none may be added.
- **House style (core):** hand-rolled validators returning `c.json({ error }, 400)`, `app.request` tests. Invoke the project `hono` skill before touching core HTTP. See `CLAUDE.md`.
- **Storage semantics:** override absent OR empty string ⇒ "not overridden" ⇒ web uses default. Clearing a field stores `''` (read treats `''` and `undefined` identically).
- **PATCH partial semantics:** `tabLabels`/`tabSubtitles` are true partials — an omitted key is left unchanged; a key present with `''` clears that override. (This differs from the sibling numeric settings, which require all fields.)
- **Test commands (in-container, per testing-gotchas):**
  - core: `docker compose exec -T core npm test -w core -- <name>`
  - core tsc: `docker compose exec -T core npx tsc --noEmit -p core/tsconfig.json`
  - web: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- <name>`
  - svelte-check: `docker compose exec -T web npm run check -w web`

---

### Task 1: Core — `GET /instance/config` + revert `/health`

**Files:**
- Modify: `core/src/api/app.ts` (the `/health` route ~line 131; add the new route right after it, outside the `/admin/*` gate at line 197)
- Test: `core/test/instance-config.test.ts` (create)

**Interfaces:**
- Consumes: `service.getSetting(key: string): Promise<string | undefined>`, `mailEnabled` (in-scope `const` in `createApp`).
- Produces: `GET /instance/config` → `{ mailEnabled: boolean, tabs: { labels: Record<key,string|null>, subtitles: Record<key,string|null> } }`; `GET /health` → `{ ok: true }`.

- [ ] **Step 1: Write the failing test**

Create `core/test/instance-config.test.ts`. **There is no shared `makeTestApp`
helper** — copy the inline `makeApp()` factory from
`core/test/admin-overview.test.ts:12-27` VERBATIM (it returns `{ app, repo }`,
constructs `createApp` with `mailEnabled: true`, and imports from `auth-helper.ts`).
`/instance/config` is unauthenticated, so no session is needed. Seed overrides
with **`repo.setSetting`** (the app reads them via `service.getSetting`, which
delegates to the same repo).

```ts
import { test, expect } from 'vitest'
// ...copy the exact imports + makeApp() from admin-overview.test.ts:1-27...

// TAB KEYS are the cross-workspace contract — hardcoded here on purpose.
const KEYS = ['local', 'federated', 'personal', 'public'] as const

test('GET /instance/config returns mailEnabled and null tab overrides by default', async () => {
  const { app } = await makeApp()
  const res = await app.request('/instance/config')
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.mailEnabled).toBe(true)
  for (const k of KEYS) {
    expect(body.tabs.labels[k]).toBeNull()
    expect(body.tabs.subtitles[k]).toBeNull()
  }
})

test('GET /instance/config echoes a stored override', async () => {
  const { app, repo } = await makeApp()
  await repo.setSetting('tab_label_personal', 'My feed')
  const res = await app.request('/instance/config')
  const body = await res.json()
  expect(body.tabs.labels.personal).toBe('My feed')
  expect(body.tabs.labels.local).toBeNull()
})

test('GET /health is a bare probe with no mailEnabled', async () => {
  const { app } = await makeApp()
  const res = await app.request('/health')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec -T core npm test -w core -- instance-config`
Expected: FAIL — `/instance/config` 404s; `/health` still returns `mailEnabled`.

- [ ] **Step 3: Write minimal implementation**

In `core/src/api/app.ts`, replace the `/health` line:

```ts
app.get('/health', (c) => c.json({ ok: true }))

// Public instance display-config (internal web→core; NOT exposed via Caddy's
// @core matcher). Sits outside the /admin/* gate so guests' layout can read it.
// Tab KEYS are hardcoded — core is a separate workspace and cannot import web's
// TABS; the keys are the contract, the default STRINGS live only in web.
const TAB_KEYS = ['local', 'federated', 'personal', 'public'] as const
app.get('/instance/config', async (c) => {
  const nn = (v: string | undefined) => (v && v !== '' ? v : null)
  const labels: Record<string, string | null> = {}
  const subtitles: Record<string, string | null> = {}
  for (const k of TAB_KEYS) {
    labels[k] = nn(await service.getSetting(`tab_label_${k}`))
    subtitles[k] = nn(await service.getSetting(`tab_subtitle_${k}`))
  }
  return c.json({ mailEnabled, tabs: { labels, subtitles } })
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec -T core npm test -w core -- instance-config`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add core/src/api/app.ts core/test/instance-config.test.ts
git commit -m "feat(core): public GET /instance/config; revert /health to a bare probe

developed with the help of AI tools"
```

---

### Task 2: Core — extend `/admin/settings` GET + PATCH with tab overrides

**Files:**
- Modify: `core/src/api/app.ts` (the `GET /admin/settings` ~line 479 and `PATCH /admin/settings` ~line 487)
- Test: **extend the existing `core/test/admin-settings.test.ts`** (do NOT create a new file). It already has the admin-authed harness (`makeApp()` → `{ app, repo }`, `registeredSession(app, 'boss@x.test', repo)` returns a cookie string used as `headers: { cookie }`).

**Interfaces:**
- Consumes: `service.getSetting`, `service.setSetting`, existing `readJsonBody`, `jsonWrite`.
- Produces: `GET /admin/settings` gains `tabLabels`/`tabSubtitles` (key → override|null). `PATCH /admin/settings` accepts optional `tabLabels`/`tabSubtitles` partials, validates, persists.

- [ ] **Step 1: Write the failing test**

**CRITICAL (plan-review C1): the numeric validation runs FIRST and 400s on a
missing numeric field.** So every PATCH body that carries tab fields MUST also
carry the three numeric fields, or it 400s for the wrong reason. Add a local
helper to `admin-settings.test.ts` that injects the numeric defaults:

```ts
// All PATCH bodies must include the numeric trio (validated before tab fields).
const NUM = { maxSubsPerUser: 500, maxRemoteItemsPerSource: 0, maxRemoteItemAgeDays: 0 }
type App = Awaited<ReturnType<typeof makeApp>>['app'] // avoids importing the Hono type
const patchTabs = (app: App, cookie: string, extra: Record<string, unknown>) =>
  app.request('/admin/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ ...NUM, ...extra }),
  })
```

**ALSO (plan-review, newly found): the four existing GET `toEqual` assertions
in this file (currently lines ~37, ~52, ~84, ~96) assert the EXACT settings
object. Extending GET with `tabLabels`/`tabSubtitles` breaks them.** Update each
to include the two new keys. The default (nothing overridden) is all-null:

```ts
const NULL_TABS = {
  tabLabels: { local: null, federated: null, personal: null, public: null },
  tabSubtitles: { local: null, federated: null, personal: null, public: null },
}
// each existing `.toEqual({ maxSubsPerUser: X, maxRemoteItemsPerSource: Y, maxRemoteItemAgeDays: Z })`
// becomes `.toEqual({ maxSubsPerUser: X, maxRemoteItemsPerSource: Y, maxRemoteItemAgeDays: Z, ...NULL_TABS })`
```

New tests to add:

```ts
test('PATCH accepts and GET echoes a label + subtitle override', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  const r = await patchTabs(app, cookie, { tabLabels: { personal: 'My feed' }, tabSubtitles: { public: 'All of it' } })
  expect(r.status).toBe(200)
  const g = await (await app.request('/admin/settings', { headers: { cookie } })).json()
  expect(g.tabLabels.personal).toBe('My feed')
  expect(g.tabSubtitles.public).toBe('All of it')
  expect(g.tabLabels.local).toBeNull()
})

test('PATCH: empty string clears a tab override', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  await patchTabs(app, cookie, { tabLabels: { personal: 'My feed' } })
  await patchTabs(app, cookie, { tabLabels: { personal: '' } })
  const g = await (await app.request('/admin/settings', { headers: { cookie } })).json()
  expect(g.tabLabels.personal).toBeNull()
})

test('PATCH: rejects an over-long label (25), over-long subtitle (121), newline, and unknown key', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  expect((await patchTabs(app, cookie, { tabLabels: { personal: 'x'.repeat(25) } })).status).toBe(400)
  expect((await patchTabs(app, cookie, { tabSubtitles: { local: 'x'.repeat(121) } })).status).toBe(400)
  expect((await patchTabs(app, cookie, { tabLabels: { local: 'a\nb' } })).status).toBe(400)
  expect((await patchTabs(app, cookie, { tabLabels: { bogus: 'x' } })).status).toBe(400)
})
```

> The updated existing tests are the regression guard that the all-numeric PATCH still round-trips.

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec -T core npm test -w core -- admin-settings`
Expected: FAIL — tab keys ignored; GET has no `tabLabels`.

- [ ] **Step 3: Write minimal implementation**

Add a shared helper near the settings routes in `core/src/api/app.ts`:

```ts
const TAB_KEYS = ['local', 'federated', 'personal', 'public'] as const
type TabKey = (typeof TAB_KEYS)[number]
const isTabKey = (k: string): k is TabKey => (TAB_KEYS as readonly string[]).includes(k)
const CONTROL_CHARS = /[\x00-\x1F\x7F]/ // reject newlines + control chars (break nav/h2 layout). WRITE THIS ESCAPED FORM VERBATIM \x00-\x1F\x7F — never a rendered copy.

// Returns { ok: pairs } to persist, or { error } to 400. `''` is a valid clear.
function validateTabCopy(
  input: unknown,
  prefix: 'tab_label_' | 'tab_subtitle_',
  max: number
): { ok: [string, string][] } | { error: string } {
  if (input == null) return { ok: [] }
  if (typeof input !== 'object') return { error: `${prefix} invalid` }
  const pairs: [string, string][] = []
  for (const [k, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!isTabKey(k)) return { error: `unknown tab key ${k}` }
    if (typeof raw !== 'string') return { error: `${prefix}${k} invalid` }
    const v = raw.trim()
    if (v !== '' && CONTROL_CHARS.test(v)) return { error: `${prefix}${k} has invalid characters` }
    if (v.length > max) return { error: `${prefix}${k} too long` }
    pairs.push([`${prefix}${k}`, v])
  }
  return { ok: pairs }
}

async function readTabOverrides(getSetting: (k: string) => Promise<string | undefined>) {
  const labels: Record<string, string | null> = {}
  const subtitles: Record<string, string | null> = {}
  for (const k of TAB_KEYS) {
    const l = await getSetting(`tab_label_${k}`)
    const s = await getSetting(`tab_subtitle_${k}`)
    labels[k] = l && l !== '' ? l : null
    subtitles[k] = s && s !== '' ? s : null
  }
  return { tabLabels: labels, tabSubtitles: subtitles }
}
```

Extend `GET /admin/settings` to spread the overrides in:

```ts
app.get('/admin/settings', async (c) =>
  c.json({
    maxSubsPerUser: Number(await service.getSetting('max_subs_per_user') ?? '500'),
    maxRemoteItemsPerSource: Number(await service.getSetting('max_remote_items_per_source') ?? '0'),
    maxRemoteItemAgeDays: Number(await service.getSetting('max_remote_item_age_days') ?? '0'),
    ...(await readTabOverrides((k) => service.getSetting(k))),
  }))
```

In `PATCH /admin/settings`, AFTER the three numeric validations and BEFORE the `setSetting` calls, add:

```ts
const labelResult = validateTabCopy(body.tabLabels, 'tab_label_', 24)
if ('error' in labelResult) return c.json({ error: labelResult.error }, 400)
const subtitleResult = validateTabCopy(body.tabSubtitles, 'tab_subtitle_', 120)
if ('error' in subtitleResult) return c.json({ error: subtitleResult.error }, 400)
```

And AFTER the three numeric `setSetting` calls:

```ts
for (const [k, v] of [...labelResult.ok, ...subtitleResult.ok]) await service.setSetting(k, v)
```

Keep Task 1's `/instance/config` loop (nested `tabs.labels`/`tabs.subtitles` shape) SEPARATE from `readTabOverrides` (flat `tabLabels`/`tabSubtitles` shape) — they serve different consumers; do NOT merge them (plan-review minor).

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec -T core npm test -w core -- admin-settings`
Expected: PASS. Then `docker compose exec -T core npx tsc --noEmit -p core/tsconfig.json` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add core/src/api/app.ts core/test/admin-settings.test.ts
git commit -m "feat(core): admin/settings reads+writes tab label/subtitle overrides

developed with the help of AI tools"
```

---

### Task 3: Web — `getInstanceConfig` (api.ts) + `mergeTabCopy` (tabs.ts)

**Files:**
- Modify: `web/src/lib/api.ts` (add `getInstanceConfig`)
- Modify: `web/src/lib/tabs.ts` (add `mergeTabCopy`)
- Test: `web/src/lib/tabs.test.ts` (extend)

**Interfaces:**
- Produces: `getInstanceConfig(f): Promise<{ mailEnabled: boolean; tabLabels: Partial<Record<Tab,string|null>>; tabSubtitles: Partial<Record<Tab,string|null>> }>`; `mergeTabCopy(overrides): { labels: Record<Tab,string>; subtitles: Record<Tab,string> }`.
- Consumes: `TABS`, `TAB_LABELS`, `TAB_SUBTITLES`, `Tab` from `tabs.ts`.

- [ ] **Step 1: Write the failing test** (`web/src/lib/tabs.test.ts`, append)

```ts
import { mergeTabCopy } from './tabs'

test('mergeTabCopy uses defaults for null/empty/missing overrides, override otherwise', () => {
  const merged = mergeTabCopy({ labels: { personal: 'My feed', local: '', federated: null }, subtitles: { public: 'All of it' } })
  expect(merged.labels.personal).toBe('My feed')
  expect(merged.labels.local).toBe('local')        // '' → default
  expect(merged.labels.federated).toBe('federated') // null → default
  expect(merged.labels.public).toBe('explore')      // missing → default
  expect(merged.subtitles.public).toBe('All of it')
  expect(merged.subtitles.local).toBe('Posts written here, on this instance')
})

test('mergeTabCopy tolerates null overrides and always fully populates every key', () => {
  const merged = mergeTabCopy(null)
  expect(Object.keys(merged.labels).sort()).toEqual([...TABS].sort())
  expect(merged.labels.personal).toBe('following')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- tabs`
Expected: FAIL — `mergeTabCopy` not exported.

- [ ] **Step 3: Write minimal implementation**

In `web/src/lib/tabs.ts`:

```ts
type TabOverrides = { labels?: Partial<Record<Tab, string | null>>; subtitles?: Partial<Record<Tab, string | null>> } | null

export function mergeTabCopy(overrides: TabOverrides): { labels: Record<Tab, string>; subtitles: Record<Tab, string> } {
  const pick = (o: Partial<Record<Tab, string | null>> | undefined, k: Tab, def: string) => {
    const v = o?.[k]
    return v && v !== '' ? v : def
  }
  const labels = {} as Record<Tab, string>
  const subtitles = {} as Record<Tab, string>
  for (const t of TABS) {
    labels[t] = pick(overrides?.labels, t, TAB_LABELS[t])
    subtitles[t] = pick(overrides?.subtitles, t, TAB_SUBTITLES[t])
  }
  return { labels, subtitles }
}
```

In `web/src/lib/api.ts` (follow the file's existing `errorMessage`/fetch style):

```ts
export async function getInstanceConfig(f: typeof fetch): Promise<{
  mailEnabled: boolean
  tabLabels: Record<string, string | null>
  tabSubtitles: Record<string, string | null>
}> {
  try {
    const res = await f(`${base()}/instance/config`)
    if (!res.ok) throw new Error(`instance/config ${res.status}`)
    const body = (await res.json()) as { mailEnabled?: boolean; tabs?: { labels?: Record<string, string | null>; subtitles?: Record<string, string | null> } }
    return { mailEnabled: body.mailEnabled === true, tabLabels: body.tabs?.labels ?? {}, tabSubtitles: body.tabs?.subtitles ?? {} }
  } catch {
    // Fail-soft: a core hiccup falls back to defaults (empty overrides), never crashes the layout.
    return { mailEnabled: false, tabLabels: {}, tabSubtitles: {} }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- tabs`
Expected: PASS. Then `docker compose exec -T web npm run check -w web` → 0/0.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/api.ts web/src/lib/tabs.ts web/src/lib/tabs.test.ts
git commit -m "feat(web): getInstanceConfig + mergeTabCopy (override ?? default)

developed with the help of AI tools"
```

---

### Task 4: Web — layout load consumes `/instance/config`; update `layout.load.test.ts`

**Files:**
- Modify: `web/src/routes/+layout.server.ts` (replace the inline `getMailEnabled`/`/health` fetch)
- Test: `web/src/routes/layout.load.test.ts` (update the 4 `/health` tests; leave the `healthz` test untouched)

**Interfaces:**
- Consumes: `getInstanceConfig` (Task 3), `mergeTabCopy` (Task 3).
- Produces: layout `data` gains `tabLabels: Record<Tab,string>` and `tabSubtitles: Record<Tab,string>` alongside the existing `me`, `mailEnabled`, `tab`, `subscribeCommandId`.

- [ ] **Step 1: Update the failing test**

In `layout.load.test.ts`, replace the `healthResponse` helper and the four tests that assert `/health` + exact `toEqual`. New helper + representative updates:

```ts
function configResponse(mailEnabled: boolean) {
  return new Response(JSON.stringify({ ok: true, mailEnabled, tabs: { labels: {}, subtitles: {} } }), { status: 200 })
}
const DEFAULT_LABELS = { local: 'local', federated: 'federated', personal: 'following', public: 'explore' }
const DEFAULT_SUBTITLES = {
  local: 'Posts written here, on this instance',
  federated: 'Posts from the instances this one federates with',
  personal: 'Everything from you and the people you follow',
  public: 'Every post and feed across this instance'
}
```

Update each of the four tests: swap `healthResponse`→`configResponse`, `/health`→`/instance/config`, and extend each `toEqual` to include `tabLabels: DEFAULT_LABELS, tabSubtitles: DEFAULT_SUBTITLES`. Example (test 1):

```ts
test('load returns me: null and the mail flag, without calling /me, when there is no session cookie', async () => {
  const fetch = vi.fn(async (..._args: unknown[]) => configResponse(true))
  const result = await load({ fetch, cookies: { getAll: () => [] }, url: new URL('http://x/') } as never)
  expect(result).toEqual({ me: null, mailEnabled: true, tab: 'public', tabLabels: DEFAULT_LABELS, tabSubtitles: DEFAULT_SUBTITLES })
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(String(fetch.mock.calls[0][0])).toContain('/instance/config')
})
```

Apply the same edits to tests 2, 3, and the `subscribeCommandId` test (the core-unreachable test's `getInstanceConfig` fail-soft returns `mailEnabled: false` + empty overrides → still `DEFAULT_LABELS/SUBTITLES` after merge). Leave the `healthz` test exactly as-is.

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- layout.load`
Expected: FAIL — layout still fetches `/health`, `data` lacks `tabLabels`.

- [ ] **Step 3: Write minimal implementation** (`+layout.server.ts`)

Replace the `getMailEnabled` function and its call. New load:

```ts
import type { LayoutServerLoad } from './$types'
import { getMe, getInstanceConfig } from '$lib/api'
import { authedFetch, base, cookieHeader, hasSession } from '$lib/server/session'
import { resolveTab, mergeTabCopy } from '$lib/tabs'

export const load: LayoutServerLoad = async ({ fetch, cookies, url }) => {
  const cfg = await getInstanceConfig(fetch)
  const { labels: tabLabels, subtitles: tabSubtitles } = mergeTabCopy({ labels: cfg.tabLabels, subtitles: cfg.tabSubtitles })
  const mailEnabled = cfg.mailEnabled
  const tab = (me: Parameters<typeof resolveTab>[1]) => resolveTab(url.searchParams.get('tab'), me)
  const subscribeCommandId = (me: { isAnonymous: boolean } | null) =>
    url.pathname === '/' && me && !me.isAnonymous ? crypto.randomUUID() : undefined
  const commonExtras = { mailEnabled, tabLabels, tabSubtitles }
  if (!hasSession(cookies)) return { me: null, ...commonExtras, tab: tab(null), subscribeCommandId: subscribeCommandId(null) }
  try {
    const me = await getMe(authedFetch(fetch, url.origin, cookieHeader(cookies)))
    return { me, ...commonExtras, tab: tab(me), subscribeCommandId: subscribeCommandId(me) }
  } catch {
    return { me: null, ...commonExtras, tab: tab(null), subscribeCommandId: subscribeCommandId(null) }
  }
}
```

> `base` import is retained only if still used elsewhere in the file; if the inline `/health` fetch was its only use, drop it to keep svelte-check clean.

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- layout.load`
Expected: PASS (5/5 incl. untouched `healthz`). Then svelte-check 0/0.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/+layout.server.ts web/src/routes/layout.load.test.ts
git commit -m "feat(web): layout reads /instance/config and serves merged tab copy

developed with the help of AI tools"
```

---

### Task 5: Web — render sites read `data.tabLabels`/`data.tabSubtitles`

**Files:**
- Modify: `web/src/routes/+layout.svelte` (nav)
- Modify: `web/src/routes/+page.svelte` (kicker + `<h2>`)

**Interfaces:**
- Consumes: `data.tabLabels`, `data.tabSubtitles` (Task 4). In `+page.svelte` these arrive via merged parent-layout data.

- [ ] **Step 1: Write the failing check**

No unit harness renders these; the check is svelte-check + runtime. First confirm the current state compiles, then make the change and verify both. (This task is template substitution guarded by svelte-check and the Task 4 data tests.)

- [ ] **Step 2: Make the change**

`+layout.svelte`: change the tab link and drop the now-unused static import.

```svelte
<!-- was: import { TABS, TAB_LABELS } from '$lib/tabs' -->
import { TABS } from '$lib/tabs'
...
<a href="/?tab={t}" aria-current={page.url.pathname === '/' && data.tab === t ? 'page' : undefined}>{data.tabLabels[t]}</a>
```

`+page.svelte`: kicker + `<h2>`, and drop the static `TAB_LABELS`/`TAB_SUBTITLES` import (keep the tab logic which uses keys, not labels).

```svelte
<!-- remove: import { TAB_LABELS, TAB_SUBTITLES } from '$lib/tabs' -->
...
<span class="kicker">{data.tabLabels[data.tab]} river</span>
...
<h2>{data.tabSubtitles[data.tab]}</h2>
```

Leave the empty-state "Your following river is empty" copy static (YAGNI — not worth wiring; it only shows on the `personal` tab).

- [ ] **Step 3: Verify**

Run: `docker compose exec -T web npm run check -w web` → 0 errors/0 warnings.
Runtime: `url=$(docker compose port web 5173); for t in local federated public; do curl -s "http://$url/?tab=$t" | grep -oE '<h2>[^<]+</h2>|/\?tab='"$t"'"[^>]*>[a-z]+'; done`
Expected: nav labels and `<h2>` reflect defaults (guest can't reach `personal` → falls to `public`).

- [ ] **Step 4: Full web suite (no regression)**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web`
Expected: all pass (existing `+page`/render tests unaffected — they don't assert nav copy).

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/+layout.svelte web/src/routes/+page.svelte
git commit -m "feat(web): nav + page-head read per-instance tab copy from data

developed with the help of AI tools"
```

---

### Task 6: Web — admin `/admin/settings` UI for tab copy

**Files:**
- Modify: `web/src/lib/api.ts` (`getAdminSettings` return type + `patchAdminSettings` body type)
- Modify: `web/src/routes/admin/settings/+page.server.ts` (load already returns settings; extend the `save` action)
- Modify: `web/src/routes/admin/settings/+page.svelte` (add a "Timeline tabs" section)
- Test: `web/src/routes/admin/settings/settings-action.test.ts` (create) OR extend an existing settings test if present — check first.

**Interfaces:**
- Consumes: `TABS`, `TAB_LABELS`, `TAB_SUBTITLES` (for placeholders), `patchAdminSettings`.
- Produces: the `save` action forwards `tabLabels`/`tabSubtitles` partials to core; empty field ⇒ `''` ⇒ clears.

- [ ] **Step 1: Extend the api types**

In `web/src/lib/api.ts`, widen both signatures (additive; keeps numeric callers working):

```ts
export async function getAdminSettings(f: typeof fetch): Promise<{
  maxSubsPerUser: number; maxRemoteItemsPerSource: number; maxRemoteItemAgeDays: number
  tabLabels: Record<string, string | null>; tabSubtitles: Record<string, string | null>
}> { /* body unchanged — core now returns the extra keys */ }

export async function patchAdminSettings(f: typeof fetch, body: {
  maxSubsPerUser: number; maxRemoteItemsPerSource: number; maxRemoteItemAgeDays: number
  tabLabels?: Record<string, string>; tabSubtitles?: Record<string, string>
}): Promise<void> { /* body unchanged */ }
```

- [ ] **Step 2: Write the failing test** (`settings-action.test.ts`)

Test the `save` action maps the 8 tab form fields into the `patchAdminSettings` call. Mock `patchAdminSettings` (via `vi.mock('$lib/api', ...)`) and assert the forwarded body. Follow any existing action-test pattern in the repo.

```ts
import { test, expect, vi } from 'vitest'
vi.mock('$lib/api', () => ({
  patchAdminSettings: vi.fn(async () => {}),
  getAdminSettings: vi.fn(async () => ({ maxSubsPerUser: 500, maxRemoteItemsPerSource: 0, maxRemoteItemAgeDays: 0, tabLabels: {}, tabSubtitles: {} }))
}))
import { patchAdminSettings } from '$lib/api'
import { actions } from './+page.server.ts'

function formEvent(entries: Record<string, string>) {
  const fd = new FormData(); for (const [k, v] of Object.entries(entries)) fd.set(k, v)
  return { request: { formData: async () => fd }, fetch: vi.fn(), url: new URL('http://x/admin/settings'), cookies: { getAll: () => [] } } as never
}

test('save forwards tab label/subtitle fields as partials', async () => {
  await actions.save(formEvent({
    maxSubsPerUser: '500', maxRemoteItemsPerSource: '0', maxRemoteItemAgeDays: '0',
    tab_label_personal: 'My feed', tab_subtitle_public: 'All of it'
  }))
  const body = (patchAdminSettings as unknown as vi.Mock).mock.calls[0][1]
  expect(body.tabLabels.personal).toBe('My feed')
  expect(body.tabSubtitles.public).toBe('All of it')
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- settings-action`
Expected: FAIL — action ignores tab fields.

- [ ] **Step 4: Implement the action + form**

`+page.server.ts` `save`: after the numeric parsing, collect tab fields and pass them through:

```ts
const TAB_KEYS = ['local', 'federated', 'personal', 'public'] as const
const collect = (prefix: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const k of TAB_KEYS) { const v = form.get(`${prefix}${k}`); if (v !== null) out[k] = String(v) }
  return out
}
// ...
await patchAdminSettings(f, {
  maxSubsPerUser, maxRemoteItemsPerSource, maxRemoteItemAgeDays,
  tabLabels: collect('tab_label_'), tabSubtitles: collect('tab_subtitle_')
})
```

`+page.svelte`: add a "Timeline tabs" section inside the existing settings form. For each tab, a label input (`name="tab_label_<key>"`, `maxlength="24"`) and a subtitle input (`name="tab_subtitle_<key>"`, `maxlength="120"`), value = `data.settings.tabLabels[key] ?? ''`, placeholder = the default (import `TAB_LABELS`/`TAB_SUBTITLES` for placeholders only). Follow MASTER.md form treatment (invoke the `ui-ux-pro-max` skill + read `design-system/rsc/pages/` for any settings-page override before styling). Empty submit ⇒ `''` ⇒ core clears.

- [ ] **Step 5: Run test + checks**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- settings-action` → PASS.
Then svelte-check 0/0, and full web suite green.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/api.ts web/src/routes/admin/settings/+page.server.ts web/src/routes/admin/settings/+page.svelte web/src/routes/admin/settings/settings-action.test.ts
git commit -m "feat(web): admin settings UI to edit per-tab labels and subtitles

developed with the help of AI tools"
```

---

## Self-Review

- **Spec coverage:** storage (Task 1–2), `/instance/config` + `/health` revert (Task 1), admin GET/PATCH + validation incl. control-char + length + unknown-key + partial semantics (Task 2), `mergeTabCopy` + `getInstanceConfig` (Task 3), layout data-flow (Task 4), render sites (Task 5), admin UI (Task 6), all testing bullets covered. ✓
- **Keys never move:** no task touches `TABS`/`resolveTab`; existing `tabs.test.ts` stays green (asserted in Task 3/5 runs). ✓
- **Type consistency:** `mergeTabCopy` input shape `{ labels?, subtitles? }` matches `getInstanceConfig` output (`tabLabels`/`tabSubtitles`) — Task 4 adapts field names when calling merge (`{ labels: cfg.tabLabels, subtitles: cfg.tabSubtitles }`). ✓
- **XSS:** Task 5 uses escaped `{...}` interpolation only; no `{@html}`. ✓
- **Open verification note for the executor:** confirm the exact admin-auth test harness and any shared `makeTestApp`/`readJsonBody` helpers by reading a neighboring core test before Task 1/2 (the test snippets assume a factory that may need inlining).

## Execution Handoff

Plan saved. Recommended: **superpowers:subagent-driven-development** — fresh implementer per task, task review after each, whole-branch review on the most capable model at the end. Tasks are ordered so core (1–2) lands before web (3–6); within web, 3→4→5 are a dependency chain and 6 is largely independent.
