# Configurable Tab Copy — Design

**Status:** Reviewed 2026-08-01 — clean-context review (0 Critical) folded in;
`/instance/config` kept as a deliberate tradeoff (I1); minors M2–M6 folded.
See `docs/superpowers/reviews/2026-08-01-configurable-tab-copy-review.md`.
Ready for planning.

**Goal:** Let each instance's admin rename the four timeline tab **labels**
and edit their **subtitles** from `/admin/settings`, with no rebuild. Unset
values fall back to the built-in defaults.

## Background

The four home tabs (`local`, `federated`, `personal`, `public`) render display
labels (`local` / `federated` / `following` / `explore`) and a per-tab
page-head subtitle. Both currently come from static maps in
`web/src/lib/tabs.ts` (`TAB_LABELS`, `TAB_SUBTITLES`). The routing key
(`?tab=…`) is already decoupled from the label. This feature makes the
**display copy** per-instance-configurable while leaving keys, routing, and
`resolveTab` untouched.

## Load-bearing invariants (do not break)

- **The `?tab=` keys never change.** `TABS`, `resolveTab`, all `?tab={key}`
  form actions and pagination links stay on `local/federated/personal/public`.
  Only the *display* copy is configurable.
- **Defaults live in exactly one place:** `web/src/lib/tabs.ts`
  (`TAB_LABELS`, `TAB_SUBTITLES`). Core stores only *overrides*; the web
  merges `override ?? default`. Core never hardcodes a default *string* —
  but core DOES hardcode the four tab **keys** (`local/federated/personal/
  public`): it's a separate npm workspace and cannot import web's `TABS`.
  The keys are the cross-workspace contract; the strings are not.
- **Copy is rendered as escaped text, never `{@html}`.** Admin-entered
  strings appear via normal Svelte interpolation (auto-escaped). This is the
  XSS boundary; no sanitizer is involved and none may be added here.
- Only admin can set the values (`/admin/settings` is `adminOrToken`-gated,
  as today).

## Storage (core)

Reuse the existing key-value settings store (`service.getSetting` /
`setSetting`, string-valued). **No schema change.** Eight keys, all optional:

```
tab_label_local        tab_subtitle_local
tab_label_federated    tab_subtitle_federated
tab_label_personal     tab_subtitle_personal
tab_label_public       tab_subtitle_public
```

Absent / empty string ⇒ "not overridden" ⇒ the web uses its default. Clearing
a field in the admin form deletes the override (or stores `''`, treated the
same on read).

## API (core)

### `GET /instance/config` — new public instance display-config endpoint

Today `web`'s root `+layout.server.ts` fetches `/health` solely to read
`mailEnabled` — i.e. `/health` (a liveness probe) is already moonlighting as a
display-config feed. This feature introduces the endpoint that role actually
wants, and **migrates `mailEnabled` onto it**:

```jsonc
// GET /instance/config
{
  "mailEnabled": true,
  "tabs": {
    "labels":    { "local": null, "federated": null, "personal": "My feed", "public": null },
    "subtitles": { "local": null, "federated": null, "personal": null, "public": "Everything here" }
  }
}
```

- `null` (or omitted) = no override for that tab. Values are the raw stored
  overrides; the web does the default merge.
- Internal web→core call (server-side `CORE_API_URL`), not publicly exposed
  via Caddy — same reach as `/health` has today.
- The layout swaps its single `/health` fetch for a single `/instance/config`
  fetch: **same round-trip count**, correct semantics.

### `GET /health` — revert to a pure probe

Drop `mailEnabled`; `/health` returns `{ ok: true }` again. Grep confirms the
only reader of `/health.mailEnabled` is the layout's `getMailEnabled`, which
moves to `/instance/config`. The `mailEnabled` `createApp` dep and its
appearance in `/admin/overview` are untouched.

### `GET /admin/settings` — include current overrides

Extend the existing response with `tabLabels` / `tabSubtitles` objects
(same shape as above: key → override-or-null). The admin form reads these to
populate input values; empty when unset.

### `PATCH /admin/settings` — accept + validate overrides

Extend the existing body with optional `tabLabels` / `tabSubtitles` partials.
**Partial semantics (M2):** unlike the existing numeric settings (which require
all fields), these are true partials — a key that is *omitted* is left
unchanged; a key present with an *empty string* clears that override (reset to
default). This must be stated because it diverges from the sibling numeric
validation directly above it in the handler.

For each *provided* entry:

- Trim whitespace, then **reject any string containing a newline or ASCII
  control character** (`\x00–\x1F`, `\x7F`) with `400` (M4 — no XSS since the
  render escapes, but a newline breaks the nav/`<h2>` layout).
- **Label:** empty ⇒ clear override; otherwise 1–24 chars. Reject > 24.
- **Subtitle:** empty ⇒ clear override; otherwise ≤ 120 chars. Reject > 120.
- Length is measured in **UTF-16 code units** (`String.length`), matching the
  existing validators (M5 — documented ceiling, not a bug; a few astral emoji
  count double, which is acceptable for a display cap).
- Unknown tab keys ⇒ `400`. Core enumerates the four valid keys locally (see
  the keys-are-the-contract invariant). Hand-rolled validator returning
  `c.json({ error }, 400)` (house style — see the `hono` skill), consistent
  with the existing numeric-setting validation right above it.

Persist via `setSetting('tab_label_<key>', value)` (store `''` to clear).

## Web

### Data flow

- `web/src/lib/api.ts` — replace `getMailEnabled` (which reads `/health`) with
  a `getInstanceConfig(fetch)` that reads `/instance/config` and returns
  `{ mailEnabled, tabLabels, tabSubtitles }` (raw overrides). Fail-soft to
  `{ mailEnabled: false, tabLabels: {}, tabSubtitles: {} }` on any error, so a
  core hiccup falls back to defaults rather than crashing the layout.
- `web/src/lib/tabs.ts` — add a pure merge helper:

  ```ts
  export function mergeTabCopy(
    overrides: { labels?: Partial<Record<Tab, string | null>>; subtitles?: Partial<Record<Tab, string | null>> } | null
  ): { labels: Record<Tab, string>; subtitles: Record<Tab, string> }
  ```

  Returns `override || DEFAULT` per tab (empty string counts as no override).
  `TAB_LABELS` / `TAB_SUBTITLES` stay as the default source.
- `web/src/routes/+layout.server.ts` — calls `getInstanceConfig` (replacing
  the `getMailEnabled`/`/health` call), runs `mergeTabCopy` on the overrides,
  and returns `mailEnabled` + `tabLabels` / `tabSubtitles` in `data`
  (fail-soft to defaults on any core hiccup, same pattern as today).

### Render sites (swap static import → `data`)

- `+layout.svelte` nav: `{data.tabLabels[t]}` (was `{TAB_LABELS[t]}`).
- `+page.svelte` kicker: `{data.tabLabels[data.tab]} river`.
- `+page.svelte` `<h2>`: `{data.tabSubtitles[data.tab]}`.
- `+page.svelte` empty-state: keep static "following river is empty" copy, or
  reference `data.tabLabels.personal` — minor; keep static for now (YAGNI).

### Admin UI (`/admin/settings/+page.svelte` + `+page.server.ts`)

Add a "Timeline tabs" section: for each of the four tabs, a label input and a
subtitle input. Placeholder = the built-in default (so the operator sees what
they're overriding); value = current override (empty when unset). Submitting
empty resets that field to default. Follow `MASTER.md` form treatment and the
`ui-ux-pro-max` skill. The form action extends the existing settings PATCH
via `patchAdminSettings`.

## Testing

- **core** (`core/test/`): `PATCH /admin/settings` accepts valid label/subtitle
  overrides and persists them; rejects a 25-char label and a 121-char subtitle
  with `400`; empty string clears an override; unknown tab key ⇒ `400`;
  `GET /instance/config` and `GET /admin/settings` echo stored overrides as
  key→value/null; `GET /instance/config` returns `mailEnabled`; `GET /health`
  returns `{ ok: true }` (no `mailEnabled`). Use `app.request` (house style).
- **web** (`web/src/lib`): `mergeTabCopy` returns defaults when overrides are
  null/empty, and the override otherwise; keys always fully populated.
- **web** (`layout.load.test.ts`): the layout fetches `/instance/config` (not
  `/health`) and still surfaces `mailEnabled`. Note (M6): all four existing
  tests use exact `toEqual` on the returned data and assert the `/health`
  fetch — every one needs updating (endpoint URL + `data` now also carries
  `tabLabels`/`tabSubtitles`), not a single assertion.
- **web**: `resolveTab` / `TABS` unchanged (existing tab tests stay green —
  proves keys didn't drift).

## Out of scope (YAGNI)

- Per-user tab copy (this is instance-wide).
- Rich text / i18n / multiple languages.
- Configurable tab *set* (adding/removing/reordering tabs) — labels only.
- A dedicated public config endpoint — `/health` already carries it internally.

## Execution

Multi-file (core API + validation + web data-flow + admin form + tests):
plan (`superpowers:writing-plans`) → parallel spec review
(`docs/superpowers/reviews/`) → `superpowers:subagent-driven-development`.
