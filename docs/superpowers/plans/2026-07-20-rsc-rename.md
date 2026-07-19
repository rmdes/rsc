# RSC Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-07-20-rsc-rename-design.md` (rev 2 + allowlist amendment)

**Goal:** Rename the app Textcaster → **RSC — Really Simple Conversations** across code, config, Cloudron package, docs, and the GitHub repo, without touching live data.

**Architecture:** Pure rename, no feature work. Seven tasks, each leaving the repo working and its suites green. Mechanical renames go through exact `sed` commands; prose surfaces (sidebar, About, README) get exact copy from this plan.

**Tech Stack:** GNU sed, npm workspaces, vitest, tsc/svelte-check, `gh` CLI.

## Global Constraints

- **`CloudronManifest.json` `"id": "net.textcaster.app"` NEVER changes** — changing it orphans the three live instances.
- **Stored-state values keep their exact paths:** `start.sh` DB value stays `/app/data/textcaster.db`; secret files stay `/app/data/config/{auth_secret,ops_token,admin_email}`. Var *names* change, these *values* do not.
- **"Textcasting" (the interop convention) is NOT renamed** — internal identifiers/comments (`listTextcastingPeers`, `source:markdown` marker notes) and the credit lines keep it. Only "Textcaster"/"textcaster" (the app) renames. Case-sensitive `sed s/Textcaster/RSC/g` cannot hit "Textcasting" (no "er" substring) — but NEVER run a case-insensitive app-name sed.
- **Historical docs under `docs/superpowers/` are not rewritten**; links to their *filenames* keep the old filename.
- **Sanitizer twins untouched:** `core/src/domain/markdown.ts`, `web/src/lib/server/render.ts` must have no diff at the end.
- **Never `git add -A`** (shared checkout) — stage explicit paths.
- Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- No new dependencies.
- **Web tests:** if host `npm test -w web` misbehaves, use the in-container form with `CORE_API_URL` unset (known gotcha): `docker compose exec web env -u CORE_API_URL npm test -w web`.

---

**Rev 1** (ponytail review of the plan, 2026-07-20): Task 1 sed + gate now
exclude `docs/superpowers/{plans,specs,reviews}` (blanket form rewrote 30+
historical docs and this plan's own commands mid-run); Task 1 stages the
live docs it touches (README/CLAUDE.md/RUNNING.md/ideas.md) and gains a
gitignored-`.env` sed step (compose interpolates `${RSC_ADMIN_EMAIL:-}`;
prod `:?` guards would hard-fail); Task 2 names `feed.test.ts`/`auth.test.ts`
explicitly; Task 3 duplicate app.css sed cut; Task 5 covers lowercase
values (mail-from defaults, `.env.example`s, `/run/textcaster-nginx*`)
while `/data/textcaster.db` in compose.prod is allowlisted stored state;
Task 6 fixes README's `cd textcaster`; Task 7 allowlist extended
(federation-demo live hosts, compose.prod DB value). Reviewer verified: all
other seds match real lines, no empty-`$()` xargs risk, task ordering
leaves every commit green, sanitizer twins unreachable by any sed, OPML
per-test timeouts present.

---

### Task 1: Env-var clean break — `TEXTCASTER_*` → `RSC_*` everywhere, atomically

**Files (modify — the complete `git grep -l 'TEXTCASTER_'` set):**
`core/src/config.ts`, `core/src/auth.ts`, `core/src/server.ts`, `core/test/*.ts` (env keys), `compose.yaml`, `compose.prod.yaml`, `.env.example`, `core/.env.example`, `Caddyfile`, `Makefile` (if hit), `scripts/generate-env.sh`, `scripts/federation-demo.mjs`, `cloudron/start.sh`, `cloudron/README.md`, `web/` (any hits)

**Interfaces:** Produces the `RSC_*` env names every later task and deploy relies on: `RSC_ADMIN_EMAIL, RSC_ANON_TTL_DAYS, RSC_AUTH_OPENAPI, RSC_AUTH_SECRET, RSC_DB, RSC_DOMAIN, RSC_MAIL_FROM, RSC_POLL_SECONDS, RSC_PORT, RSC_PUBLIC_URL, RSC_PUSH_IN, RSC_RSSCLOUD, RSC_SMTP_URL, RSC_TOKEN, RSC_WEBSUB, RSC_WEB_ORIGIN`.

- [ ] **Step 1: Rename in every tracked file EXCEPT historical docs and this plan/spec**

```bash
cd /home/rmdes/textcaster
git grep -l 'TEXTCASTER_' -- ':!docs/superpowers/plans' ':!docs/superpowers/specs' ':!docs/superpowers/reviews' \
  | xargs sed -i 's/TEXTCASTER_/RSC_/g'
```
(The exclusions are load-bearing: historical records keep `TEXTCASTER_`, and this plan's own commands must not be rewritten mid-execution. `docs/superpowers/documentation/RUNNING.md` and `ideas.md` ARE live docs — they get sed'd and staged here.)

- [ ] **Step 2: Verify the two stored-state values survived with old paths**

```bash
grep -n 'RSC_DB' cloudron/start.sh
```
Expected: `export RSC_DB="/app/data/textcaster.db"` — var renamed, **value unchanged**. Also confirm `tc_ensure_secret /app/data/config/auth_secret` paths are untouched.

- [ ] **Step 3: Verify zero stragglers (same exclusions as Step 1)**

```bash
git grep -n 'TEXTCASTER_' -- ':!docs/superpowers/plans' ':!docs/superpowers/specs' ':!docs/superpowers/reviews' ; echo "exit=$?"
```
Expected: no output, `exit=1`. (Without the pathspec the gate always fails on historical docs.)

- [ ] **Step 4: Run core suite + typechecks**

Run: `npm test -w core` then `make check`
Expected: core suite green (403+ tests; the two OPML tests have their own 15s timeouts), `tsc` and `svelte-check` clean.

- [ ] **Step 5: Rename vars in the gitignored env files (sed, not regen — keeps secrets)**

```bash
for f in .env core/.env web/.env; do [ -f "$f" ] && sed -i 's/TEXTCASTER_/RSC_/g' "$f"; done; true
```
(compose.yaml interpolates `${TEXTCASTER_ADMIN_EMAIL:-}` from root `.env` — without this, dev admin silently unsets; on a prod VPS the `:?` guards would hard-fail.)

- [ ] **Step 6: Restart dev stack to prove boot with new vars**

Run: `docker compose up -d --force-recreate core web && sleep 8 && curl -sf http://localhost:5173/ >/dev/null && echo WEB-OK`
Expected: `WEB-OK`. (Dev compose passes the renamed vars; a boot failure here means a missed reader.)

- [ ] **Step 7: Commit (stage every file Step 1 touched — including live docs; historical docs must show NO diff)**

```bash
git status --porcelain   # confirm nothing under docs/superpowers/{plans,specs,reviews} is modified
git add core/src core/test compose.yaml compose.prod.yaml .env.example core/.env.example Caddyfile scripts cloudron/start.sh cloudron/README.md Makefile web README.md CLAUDE.md docs/superpowers/documentation docs/superpowers/ideas.md
git commit -m "rename: TEXTCASTER_* env vars -> RSC_* (clean break, values preserved)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Core strings — cookie prefix, emails, UA, fallback host, defaults, log (+ core tests)

**Files:**
- Modify: `core/src/auth.ts:26,63,70,87`, `core/src/config.ts:81,86`, `core/src/domain/ingest.ts:35`, `core/src/domain/feed.ts:53,124,138,205`, `core/src/server.ts:84`, `core/test/auth.test.ts:42`, `core/test/ingest.test.ts:29`, `core/test/auth-helper.ts:30`, plus any `core/test` hits on `textcaster.invalid` / `Textcaster`

**Interfaces:** Produces cookie prefix `rsc` (cookies now `rsc.session_token`) — Task 3's web-test sed depends on it. Live deploys log everyone out once (spec invariant 3, accepted).

- [ ] **Step 1: Apply exact string renames**

```bash
cd /home/rmdes/textcaster
# app-name strings + fallback host, core src and tests (case-sensitive; cannot touch "Textcasting")
sed -i "s/cookiePrefix: 'textcaster'/cookiePrefix: 'rsc'/" core/src/auth.ts
sed -i 's/Your Textcaster login link/Your RSC login link/; s/Reset your Textcaster password/Reset your RSC password/; s/Verify your Textcaster email/Verify your RSC email/' core/src/auth.ts
sed -i 's|Textcaster/0.1 (+https://github.com/rmdes/textcaster)|RSC/0.1 (+https://github.com/rmdes/rsc)|' core/src/domain/ingest.ts
sed -i 's/textcaster\.invalid/rsc.invalid/g' core/src/domain/feed.ts $(git grep -l 'textcaster\.invalid' -- core/test)
sed -i 's/textcaster core listening/rsc core listening/' core/src/server.ts
sed -i "s|'./data/textcaster.db'|'./data/rsc.db'|; s/textcaster@\${mailHost}/rsc@\${mailHost}/" core/src/config.ts
sed -i 's/textcaster\.session_token/rsc.session_token/g' $(git grep -l 'textcaster\.session_token' -- core/test)
sed -i 's/Textcaster/RSC/g; s/textcaster/rsc/g' core/test/ingest.test.ts core/test/auth-helper.ts
sed -i 's/Textcaster/RSC/g' core/test/feed.test.ts core/test/auth.test.ts
```
(`feed.test.ts:322` test name and `auth.test.ts:266` comment carry capital "Textcaster" — named explicitly so the hand-check isn't the only net.)
Then hand-check `git grep -ni textcaster -- core/src core/test` — remaining hits must be only "Textcasting" (convention term) or none; fix any strays by hand with the same app-name→RSC mapping.

- [ ] **Step 2: Run core suite + typecheck**

Run: `npm test -w core && npm run typecheck -w core`
Expected: green. The cookie-name and user-agent assertions now assert `rsc.session_token` / `RSC/0.1`.

- [ ] **Step 3: Commit**

```bash
git add core/src core/test
git commit -m "rename: core strings — cookie prefix rsc, emails, UA, rsc.invalid, defaults

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Web rename — titles, mastheads, sidebar blurb + credit line, draft prefix, web tests

**Files:**
- Modify: every `web/src` file with `Textcaster` titles/mastheads (see `git grep -l Textcaster -- web/src`), `web/src/routes/+page.svelte:185-195` (sidebar), `web/src/routes/+layout.svelte:43`, `web/src/lib/draft.ts:5`, `web/src/lib/draft.test.ts`, all web tests with `textcaster.session_token`, `web/src/app.css:1,873`

**Interfaces:** Consumes cookie prefix `rsc` from Task 2. Produces localStorage prefix `rsc:draft:` (in-flight drafts silently discarded — accepted in spec).

- [ ] **Step 1: Mechanical renames**

```bash
cd /home/rmdes/textcaster
# Titles "X — Textcaster", masthead <a href="/">Textcaster</a>, meta strings
sed -i 's/Textcaster/RSC/g' $(git grep -l 'Textcaster' -- web/src ':!web/src/routes/about' ':!web/src/routes/+page.svelte')
sed -i 's/textcaster\.session_token/rsc.session_token/g' $(git grep -l 'textcaster\.session_token' -- web/src)
sed -i "s/'textcaster:draft:'/'rsc:draft:'/" web/src/lib/draft.ts
sed -i 's/textcaster:draft:/rsc:draft:/g' web/src/lib/draft.test.ts
sed -i 's|github.com/rmdes/textcaster|github.com/rmdes/rsc|g' web/src/routes/+layout.svelte
sed -i 's|design-system/textcaster/MASTER.md|design-system/rsc/MASTER.md|' web/src/app.css
```
(No separate app-name sed for app.css — it's already in the blanket-sed file list above.)

- [ ] **Step 2: Sidebar blurb + credit line in `web/src/routes/+page.svelte` (hand edit, exact copy)**

Replace lines 185–195's `<summary>About</summary>` panel content (keep surrounding markup) with:

```html
<summary>About</summary>
<p>
	RSC — Really Simple Conversations — is a feeds-native social timeline: people who post here
	and people who post on their own site are equal citizens. Everything travels as RSS — posts,
	replies, whole conversations — so following, threading, and federation work with nothing but
	open feeds.
</p>
<p>
	Inspired by Dave Winer's
	<a href="https://textcasting.org" rel="noreferrer">Textcasting</a> and
	<a href="https://github.com/scripting/rss.chat" rel="noreferrer">rss.chat</a>.
</p>
<p><a href="https://github.com/rmdes/rsc" rel="noreferrer">Source &amp; docs</a></p>
```

Also in this file: `<title>Textcaster</title>` → `<title>RSC</title>` (line 64), masthead `<a href="/">Textcaster</a>` → `<a href="/">RSC</a>` (line 73), and reword the line-43 comment to `// Group Textcasting peers by instance host: "which Textcasting authors is this instance hosting..."` (keeps the convention term, drops the app-name plural).

- [ ] **Step 3: Run web suite + svelte-check**

Run: `npm test -w web && npm run check -w web`
Expected: 154/154 green (cookie/draft literals updated in the same task), svelte-check 0 errors 0 warnings.

- [ ] **Step 4: Verify remaining web hits are only allowlisted**

```bash
git grep -ni textcaster -- web/src
```
Expected: only `web/src/routes/about/` (Task 4) and "Textcasting" convention/credit references.

- [ ] **Step 5: Commit**

```bash
git add web/src
git commit -m "rename: web — RSC titles/mastheads, sidebar blurb + credit line, rsc:draft:, tests

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: About page rewrite — credit kept, lineage-framing dropped

**Files:**
- Modify: `web/src/routes/about/+page.svelte` (copy only; structure, styles, credits list layout untouched)

**Interfaces:** none downstream. Copy decisions come from the spec's Attribution section.

- [ ] **Step 1: Apply exact copy changes**

All in `web/src/routes/about/+page.svelte`:

1. Line 12 title → `<title>About — RSC</title>`; line 15 meta content → `content="RSC — Really Simple Conversations — is a feeds-native social timeline: people who post through the instance and people who post from their own site are equal citizens in one live timeline, and whole conversations travel as plain RSS."`
2. Line 21 masthead → `<a href="/">RSC</a>`
3. Replace the lede (lines 27–34) with:

```html
<p class="lede">
	RSC — Really Simple Conversations — is a social timeline built natively on
	open feeds. People who post <em>through</em> the instance and people who
	post from <em>their own website's feed</em> are equal citizens of the same
	live timeline, and following, replies, and whole conversations travel as
	plain RSS instead of a proprietary API.
</p>
```

4. Line 47 → `RSC's bet is that a conversation can travel over nothing but RSS.`
5. Interop bullet (lines 87–91) →

```html
<li>
	<strong>Interop with rss.chat.</strong> RSC round-trips rss.chat: a
	conversation can federate A→B→A over plain RSS, and our feeds are
	walkable by its thread walker unchanged.
</li>
```

6. Line 115 → `without anyone adopting an RSC-specific protocol.`
7. Lines 126–130 →

```html
<p>
	RSC is built by <a href="https://github.com/rmdes">Ricardo (rmdes)</a>.
	It stands on ideas and standards it did not invent:
</p>
```

8. Winer credit bullet (lines 132–136) →

```html
<li>
	<strong><a href="https://textcasting.org">Dave Winer &amp; textcasting.org</a></strong>
	— the Textcasting manifesto, RSS, OPML, rssCloud, and
	<a href="https://github.com/scripting/rss.chat">rss.chat</a>, whose
	conversations RSC interops with.
</li>
```

9. Lines 143–145: repo links → `https://github.com/rmdes/rsc`, `https://github.com/rmdes/rsc/blob/main/README.md`, `https://github.com/rmdes/rsc/blob/main/docs/superpowers/specs/2026-07-15-textcaster-design.md` (historical filename kept).
10. Head comment (lines 1–6): keep the founding-design path as-is (historical filename); no other change needed.

- [ ] **Step 2: Run checks**

Run: `npm run check -w web && npm test -w web`
Expected: clean / 154 green (page has no tests; this guards accidental syntax breakage).

- [ ] **Step 3: Verify no framing leftovers**

```bash
grep -n "unifies\|purity\|itself an attribution\|reimagines" web/src/routes/about/+page.svelte
```
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add web/src/routes/about/+page.svelte
git commit -m "rename: About page — RSC copy, credit kept, lineage framing dropped

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Packages, compose, Makefile, LICENSE, Cloudron manifest/nginx

**Files:**
- Modify: `package.json`, `core/package.json`, `web/package.json`, `package-lock.json` (regenerated), `compose.yaml`, `compose.prod.yaml`, `Makefile:1`, `LICENSE:3`, `cloudron/CloudronManifest.json`, `cloudron/nginx.conf:4`, `cloudron/README.md`, `scripts/generate-env.sh:2,21`, `scripts/federation-demo.mjs` (leftover app-name strings)

**Interfaces:** Produces package names `rsc`, `@rsc/core`, `@rsc/web`; docker image name for future builds is `rmdes/rsc:<TAG>`.

- [ ] **Step 1: Package names + lockfile**

```bash
cd /home/rmdes/textcaster
sed -i 's/"name": "textcaster"/"name": "rsc"/' package.json
sed -i 's/"name": "@textcaster\/core"/"name": "@rsc\/core"/' core/package.json
sed -i 's/"name": "@textcaster\/web"/"name": "@rsc\/web"/' web/package.json
npm install
git grep -n textcaster -- package-lock.json ; echo "exit=$?"
```
Expected final grep: no output, `exit=1`.

- [ ] **Step 2: Compose, Makefile, LICENSE, scripts**

```bash
sed -i 's/container_name: textcaster-/container_name: rsc-/g; s/^# Textcaster/# RSC/' compose.yaml compose.prod.yaml
sed -i 's/textcaster@localhost/rsc@localhost/' compose.yaml
sed -i 's/textcaster@/rsc@/' compose.prod.yaml            # mail-from default; the /data/textcaster.db value on line ~62 MUST STAY (VPS stored state)
sed -i 's/^# Textcaster/# RSC/' Makefile
sed -i 's/Textcaster contributors/RSC contributors/' LICENSE
sed -i 's/Generate .env for Textcaster/Generate .env for RSC/; s/textcaster\.example\.com/rsc.example.com/' scripts/generate-env.sh
sed -i 's/textcaster\.example\.com/rsc.example.com/; s/textcaster@your-domain/rsc@your-domain/' .env.example
sed -i 's|./data/textcaster.db|./data/rsc.db|' core/.env.example   # matches Task 2's new dev default
sed -i 's|/run/textcaster-nginx|/run/rsc-nginx|g' cloudron/start.sh  # tmpfs runtime paths (conf + pid refs), safe
sed -i 's/Textcaster/RSC/g; s/github\.com\/rmdes\/textcaster/github.com\/rmdes\/rsc/g' scripts/federation-demo.mjs cloudron/README.md
```
Verify after: `git grep -n 'textcaster' -- compose.prod.yaml` shows ONLY the `/data/textcaster.db` volume value and any `textcaster.app` domain defaults; `git grep -n textcaster -- scripts/federation-demo.mjs` shows only `textcaster.app` instance domains (live hosts — stay).

- [ ] **Step 3: Cloudron manifest (hand edit — `id` LOCKED) + nginx pid**

In `cloudron/CloudronManifest.json`: `"id": "net.textcaster.app"` **unchanged**; `"title": "RSC"`; `"description": "RSC — Really Simple Conversations. A feeds-native social timeline — posts, replies, and conversations travel as RSS."`; `"tagline": "Really Simple Conversations"`; `"website": "https://github.com/rmdes/rsc"`; tags → `["rss", "indieweb", "social", "feeds"]` (the `"textcasting"` tag is deleted).

```bash
sed -i 's|pid /run/textcaster-nginx.pid|pid /run/rsc-nginx.pid|' cloudron/nginx.conf
grep -n '"id"' cloudron/CloudronManifest.json
```
Expected: `"id": "net.textcaster.app"` still present.

- [ ] **Step 4: Dev stack still boots + suites**

Run: `docker compose up -d --force-recreate && sleep 8 && curl -sf http://localhost:5173/ >/dev/null && echo WEB-OK && make test && make check`
Expected: `WEB-OK`, all green.

- [ ] **Step 5: Commit**

```bash
git add package.json core/package.json web/package.json package-lock.json compose.yaml compose.prod.yaml Makefile LICENSE cloudron/CloudronManifest.json cloudron/nginx.conf cloudron/start.sh cloudron/README.md scripts/generate-env.sh scripts/federation-demo.mjs .env.example core/.env.example
git commit -m "rename: packages @rsc/*, compose rsc-*, Cloudron manifest (id preserved), LICENSE

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Docs + design system — README, CLAUDE.md, RUNNING.md, ideas.md, `design-system/rsc/`

**Files:**
- Rename: `design-system/textcaster/` → `design-system/rsc/` (`git mv`)
- Modify: `README.md`, `CLAUDE.md`, `docs/superpowers/documentation/RUNNING.md`, `docs/superpowers/ideas.md` (live references only), `design-system/rsc/MASTER.md` header/prose, `design-system/rsc/pages/*.md` if they name the app

**Interfaces:** README keeps the credit line verbatim from Task 3's sidebar: "Inspired by Dave Winer's [Textcasting](https://textcasting.org) and [rss.chat](https://github.com/scripting/rss.chat)."

- [ ] **Step 1: Move the design system dir and fix references**

```bash
cd /home/rmdes/textcaster
git mv design-system/textcaster design-system/rsc
git grep -ln 'design-system/textcaster' -- ':!docs/superpowers' | xargs -r sed -i 's|design-system/textcaster|design-system/rsc|g'
```

- [ ] **Step 2: Rename app-name references in live docs**

```bash
sed -i 's/Textcaster/RSC/g; s/github\.com\/rmdes\/textcaster/github.com\/rmdes\/rsc/g' README.md CLAUDE.md docs/superpowers/documentation/RUNNING.md design-system/rsc/MASTER.md
sed -i 's/Textcaster/RSC/g' design-system/rsc/pages/*.md 2>/dev/null || true
```
Then hand-fix in `README.md`: the intro must open with the full name once — `# RSC — Really Simple Conversations` — the credit line above must appear where the old attribution paragraph was ("Built on Textcasting…" → the "Inspired by…" line), and the clone snippet (line ~108) becomes `git clone https://github.com/rmdes/rsc.git && cd rsc` (the sed fixes the URL, not the `cd`). Hand-check `CLAUDE.md` still reads correctly (its first line describes the project; "textcasting" as a convention term stays where it names the protocol). In both files leave historical `docs/superpowers/specs/2026-07-15-textcaster-design.md` paths untouched (sed above doesn't match filenames — verify).
`docs/superpowers/ideas.md`: only rewrite forward-looking references to the app name; leave shipped/historical entries as records.

- [ ] **Step 3: Run checks (docs can't break code, but the mv can break test imports)**

Run: `make test && make check`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md docs/superpowers/documentation/RUNNING.md docs/superpowers/ideas.md design-system
git commit -m "rename: docs + design-system/rsc — README/CLAUDE.md/RUNNING.md, credit line kept

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Verification sweep + GitHub repo rename

**Files:** none new — this is the gate.

**Interfaces:** Consumes everything. Produces the renamed remote `github.com/rmdes/rsc`.

- [ ] **Step 1: Full-suite gate**

Run: `make test && make check`
Expected: core green, web 154/154, tsc 0, svelte-check 0/0.

- [ ] **Step 2: Grep-clean gate (tracked files, post-`npm install`)**

```bash
cd /home/rmdes/textcaster
git grep -il textcaster | sort
```
Expected output is ONLY files matching the allowlist:
- `docs/superpowers/**` (historical records + the rename spec + this plan)
- files whose only hits are `textcaster.app` domain values (`compose.prod.yaml` defaults, `Caddyfile` if any, `scripts/federation-demo.mjs` live-instance hosts), stored-state values (`cloudron/start.sh` `/app/data/textcaster.db`, `compose.prod.yaml` `/data/textcaster.db`), `cloudron/CloudronManifest.json` (`id`)
- files whose only hits are the historical founding-design *filename* (`web/src/routes/about/+page.svelte`)
- files whose only hits are "Textcasting" the convention (core/web internals, credit lines)

For each listed file outside `docs/superpowers/`, run `git grep -in textcaster -- <file>` and confirm every hit is allowlisted. Any other hit = fix it now with the mappings from Tasks 2–6, amend into a `rename: stragglers` commit.

- [ ] **Step 3: Sanitizer-twin gate**

```bash
git diff main~7..HEAD --stat -- core/src/domain/markdown.ts web/src/lib/server/render.ts
```
Expected: no output (adjust `~7` to the actual number of rename commits; the point: zero diff on the twins).

- [ ] **Step 4: Rename the GitHub repo + re-point origin**

```bash
gh repo rename rsc --repo rmdes/textcaster --yes
git remote set-url origin git@github.com:rmdes/rsc.git
git remote -v && git fetch origin && git status -sb
```
Expected: origin points at `rmdes/rsc`, fetch succeeds, branch tracks normally. (GitHub redirects the old URL; the parallel session's checkout keeps working via redirect but should re-point too.)

- [ ] **Step 5: Push (ask the user first — house rule)**

Confirm with the user, then: `git push origin main`

---

## Rollout (after plan execution, with the user)

Per spec: build `rmdes/rsc:<TAG>` (CloudronManifest + logo symlink dance at repo root), staged deploy **bob → alice → textcaster.app** via `cloudron update --app <id>` using the app ids from memory; verify per instance: data survived, feeds serve, `/admin/overview` 401 anon, login works (fresh session expected — cookie prefix changed). Not part of the seven tasks; production actions get explicit user go-ahead.
