# Review — Configurable Tab Copy Implementation Plan (2026-08-01)

Reviewer: clean-context plan review. Scope: correctness, feasibility vs. real
code, placeholder/type bugs, TDD red/green validity, over-engineering. No
implementation, no edits to plan or source.

## Verdict

**Not executable as-is — one Critical will make Task 2's core tests fail (or
pass for the wrong reason), and two Important issues leave the test-harness and
a load-bearing regex under-specified.** The architecture is sound and matches
the reviewed spec: store overrides in the existing kv settings store, expose via
a new unauthenticated `GET /instance/config`, revert `/health` to `{ ok: true }`,
merge `override ?? default` in web, keys/`resolveTab` untouched. Every render
site, default string, in-scope symbol (`mailEnabled`, `service`, `readJsonBody`,
`jsonWrite`), and SvelteKit data-flow claim I checked holds. Fix the three items
below before executing; the rest are Minor/Nit.

## Findings

### Critical

**C1 — Task 2 PATCH test bodies omit the three required numeric fields; the
existing numeric validation 400s before tab handling is ever reached.**
`PATCH /admin/settings` validates `maxSubsPerUser`/`maxRemoteItemsPerSource`/
`maxRemoteItemAgeDays` up front, and each check is `typeof x === 'number'` —
which fails for `undefined` (`core/src/api/app.ts:490-502`). The plan adds tab
validation *after* those checks (Task 2, Step 3: "AFTER the three numeric
validations"). But the Task 2 test bodies send tab-only payloads, e.g.
`patch({ tabLabels: { personal: 'My feed' } })` (plan lines 146, 158, 164, 170,
176, 182) with no numeric fields. Consequences:
- The "PATCH accepts…" (line 145) and "empty string clears" (line 155) tests
  expect `200`, but the handler returns `400 maxSubsPerUser invalid` → **these
  fail**.
- The four negative tests (25-char, 121-char, newline, unknown-key) expect `400`
  and get `400` — but for the **wrong reason** (missing numerics, not the tab
  defect). False green: they would pass even if tab validation were never
  written. This defeats the TDD red/green intent (risk #4).
- Evidence the real UI is unaffected: the web form always submits all three
  numeric inputs plus the eight tab inputs (`+page.svelte:18,23,28`;
  Task 6 `collect`), so a real PATCH never omits numerics.
- **Fix (must-fix before executing):** every `patch()` in Task 2 that carries
  tab fields must also include the three numeric fields. Simplest: make the
  `patch(body)` helper default-inject
  `{ maxSubsPerUser: 500, maxRemoteItemsPerSource: 0, maxRemoteItemAgeDays: 0, ...body }`.
  Do NOT instead move tab-validation before the numeric block — the numeric
  fields being all-required is the established contract (spec M2 keeps it), and
  the form always sends them.

### Important

**I2 — `CONTROL_CHARS` is written as raw invisible control bytes; correct
semantics, but fragile and unreadable — must be the escaped form.**
The plan file literally contains `/[\x00-\x1F\x7F]/` encoded as raw control
characters (verified with `cat -A`: `/[^@-^_^?]/`, i.e. NUL `^@`, 0x1F `^_`,
0x7F `^?`). So the byte content is semantically correct, and `'My feed'` (space
= 0x20) passes while `'a\nb'` (0x0A) is rejected. **But** the plan *displays* as
`const CONTROL_CHARS = /[ -]/` (plan line 209). Two hazards:
- An implementer copy-pasting through any tool that strips control chars, or
  who retypes what they see as `/[ -]/`, gets a class matching **space and
  hyphen** — which would 400 every legitimate label (`'My feed'`, `'de-DE'`)
  and break the green tests in C1's fix.
- Raw control bytes in `core/src/` are unreviewable and easily mangled by
  editors/formatters.
- **Fix (must-fix before executing):** the implementer MUST write the escaped
  literal `const CONTROL_CHARS = /[\x00-\x1F\x7F]/` and never copy the rendered
  `/[ -]/`. Call this out explicitly in the task.

**I3 — No shared `makeTestApp`; the real factory returns `{ app, repo }` (not
`{ app, service }`), and admin auth is a cookie session, not a bearer token.**
The plan hedges ("if none, inline `createApp` like admin-overview.test.ts";
`adminApp()` "admin session/bearer token"). The concrete answer:
- There is no `makeTestApp` helper. The pattern to copy is the inline
  `makeApp(adminEmails = ['boss@x.test'])` in
  `core/test/admin-overview.test.ts:12-27`, which builds all deps and returns
  `{ app, repo }` with `service` created *internally* and not returned.
- Task 1's snippet calls `service.setSetting(...)` and expects
  `{ app, service }`. Either return `service` from the inlined factory, or use
  `repo.setSetting(...)` — `repo` already exposes `getSetting`/`setSetting`
  (service just delegates: `core/src/domain/service.ts:154-155`). Prefer
  `repo.setSetting` to match the returned shape with the least churn.
- Task 2's `adminApp()` must build the admin cookie exactly as
  `admin-overview.test.ts:67-83` does:
  `const cookie = await registeredSession(app, 'boss@x.test', repo)` (that email
  is in `adminEmails`), then every `get()`/`patch()` passes
  `{ headers: { cookie } }` (plus `content-type: application/json` on PATCH).
  `/admin/settings` is gated by `app.use('/admin/*', authed, requireAdmin())`
  (`app.ts:197`) — a **session**, not a bearer token. Drop the "bearer token"
  wording; the ops-token route is a separate surface. (The spec's
  "adminOrToken-gated" description of `/admin/settings` is inaccurate but does
  not affect the plan.)
- **Fix (must-fix before executing):** replace the hedge with the named pattern
  above so Task 1/2 are copy-paste deterministic.

### Minor

**M4 — Two different JSON shapes for the same eight keys in `app.ts`; skip the
suggested `readTabOverrides` reuse in `/instance/config`.**
`GET /instance/config` returns `{ tabs: { labels, subtitles } }` (Task 1) while
`GET /admin/settings` returns `{ tabLabels, tabSubtitles }` (Task 2 via
`readTabOverrides`). Each matches its own web consumer (`getInstanceConfig`
reads `body.tabs.labels`; `getAdminSettings` reads `tabLabels`), so it is
acceptable — but Task 2 Step 3's "refactor `/instance/config` to reuse
`readTabOverrides` if convenient" is a trap: the shapes differ, so reuse needs a
re-map (`tabLabels`→`labels`). Ponytail: don't do that refactor; leave Task 1's
inline `nn` loop as-is. The null/empty coercion is already identical in both
(`v && v !== '' ? v : null`), so there's no drift to fix. Nice-to-have.

**M5 — Task 4's rewrite snippet keeps the now-unused `base` import.**
Plan line 438 imports `{ authedFetch, base, cookieHeader, hasSession }`, but
after the rewrite `base()` is only used inside `getInstanceConfig` (api.ts), not
in `+layout.server.ts`. Leaving it triggers an unused-import svelte-check
warning (Task 4 expects "0/0"). The plan's prose note (line 459) says to drop it
— but the code block still lists it. Implementer must drop `base` from that
import. Nice-to-have (svelte-check will catch it).

### Nit

**N6 — Task 5's runtime `curl | grep` check (plan line 516) is brittle** (guest
can't reach `personal`, regex is fiddly). It's belt-and-suspenders; the real
guards are svelte-check plus the Task 4 data tests. Keep or drop — no change
needed.

## Correct as written — don't churn

- **Default strings match the codebase exactly.** Task 3/4 hardcode
  `TAB_LABELS` (`local`/`federated`/`following`/`explore`) and all four
  `TAB_SUBTITLES` verbatim from `web/src/lib/tabs.ts:9-23` — every subtitle
  ("Posts written here, on this instance", etc.) checked, all match.
- **Type adaptation at the merge seam is present and correct.**
  `getInstanceConfig` returns `{ tabLabels, tabSubtitles }`; Task 4 calls
  `mergeTabCopy({ labels: cfg.tabLabels, subtitles: cfg.tabSubtitles })`
  (plan line 443). `mergeTabCopy`'s input type
  `{ labels?: Partial<Record<Tab,…>>; subtitles?: … } | null` accepts the
  `Record<string, string|null>` values structurally.
- **`/instance/config` placement is genuinely unauthenticated.** Inserted after
  `/health` (`app.ts:131`), well before the `/admin/*` gate (`app.ts:197`); no
  global middleware precedes it. `service` and `mailEnabled` are both in scope
  (`app.ts:115,117`). `readJsonBody` returns a parsed object so `body.tabLabels`
  works (`app.ts:24-30`); `jsonWrite` exists (`app.ts:103`).
- **`/health` revert is safe.** Container healthchecks only assert status 200
  (per the folded spec review I1); Cloudron probes `/healthz`, a separate web
  route — untouched. The `healthz` test (plan leaves it alone) stays green.
- **Parent-layout data reaches `+page.svelte`.** It already reads `data.tab`,
  `data.me`, etc.; `data.tabLabels`/`data.tabSubtitles` returned from
  `+layout.server.ts` are merged into `PageData` by SvelteKit. Render-site line
  targets are accurate: `+layout.svelte:8,49`; `+page.svelte:4,165,166`.
- **Keys/`resolveTab` untouched;** existing `tabs.test.ts` stays green. `TABS`
  hardcoded in core as the cross-workspace contract is correct and necessary.
- **`validateTabCopy` and `mergeTabCopy` are justified,** not over-engineered:
  the former is trust-boundary validation reused for two maxes; the latter earns
  its place as the unit-test seam (spec N7). Task ordering (core 1–2 → web
  3→4→5, 6 independent) is sound; only C1 blocks Task 2's independent testability.
