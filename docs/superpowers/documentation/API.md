# RSC API

Programmatic access to an RSC instance. Everything here is served by the web
app under `/api/v1/` — core is never reachable directly (see CLAUDE.md's
perimeter invariant), so the base URL is just your instance:

```
https://rsc.example.org/api/v1
```

Several surfaces need no key at all: the **public firehose** below, every RSS /
JSON feed the instance already publishes, and anonymous read endpoints listed
in [Reading](#reading). Feeds remain the primary integration surface — this API
exists for the things a feed can't express (writing, and reading your own
personal timeline). If a feed reader can do the job, use a feed.

---

## Getting a key

**Settings → More → API keys**, or go straight to `/settings/api-keys`.

Keys are self-serve and available to registered accounts only — a guest
session can't mint one. When you create a key you tick the permissions it
carries; a key can only do what its permissions allow, and the permission set
is fixed at creation.

The key is shown **once**, at creation. It is stored hashed, so it cannot be
recovered afterwards — if you lose it, revoke it and create another.

Keys look like `rsc_…`. Send one as the `x-api-key` header:

```bash
curl -H "x-api-key: rsc_your_key_here" \
  https://rsc.example.org/api/v1/me/timeline
```

### Permissions

| Permission | Grants |
|---|---|
| `timeline:read` | Read your personal timeline |
| `posts:read` | Read your own posts |
| `posts:write` | Create, edit, **and delete** your posts |
| `follows:write` | Follow/unfollow accounts, subscribe/unsubscribe feeds |
| `profile:write` | Change your handle and display name |

Grant the narrowest set that does the job. Note that `posts:write` is not
separable — a key that can post can also delete your posts. If you're
building something that only publishes, that key can still destroy; treat it
accordingly.

Admin operations are a separate key tier with its own prefix and issuance
route — not self-serve here. See [Admin](#admin) below.

### Rate limit

**300 requests per hour per key**, sliding window. Exceeding it returns an
error with a `tryAgainIn` value in milliseconds. The limit is per key, so
separate integrations should use separate keys — they then fail independently
instead of starving each other.

---

## Errors

Every error is JSON: `{"error": "..."}` with a meaningful status.

| Status | Meaning |
|---|---|
| `400` | Malformed body, or a field failed validation |
| `401` | Missing key, invalid key, or the key lacks the required permission |
| `403` | Authenticated, but not yours to touch (someone else's post, a remote post) |
| `404` | No such post, user, or subscription |
| `409` | Idempotency conflict, or the target isn't a local post |
| `429` | Subscription cap reached, api key limit reached, the public firehose at instance-wide or per-IP concurrent-connection capacity, the public firehose's per-IP connection-*attempt* rate limit, or an api-key rate limit — see `code` in the body for the rate-limit case (`RATE_LIMITED`, carries `tryAgainIn`, retry after that many ms). The firehose connection-attempt limit is also transient — back off ~60s and retry. Every other cause here is durable: don't retry (an api key limit needs a revoke first) |

`401` deliberately does not distinguish "no key" from "wrong permission" —
don't parse the message to tell them apart.

---

## Public firehose (no key)

```
GET /api/v1/firehose/stream
```

Server-Sent Events. Every publicly visible item on the instance as it appears —
anonymous, so it shows exactly what a logged-out visitor would see. Hidden,
tombstoned and quarantined items are excluded, and re-evaluated on replay:
something removed after you saw it arrives again as a removal frame.

```bash
curl -N https://rsc.example.org/api/v1/firehose/stream
```

A `: hb` heartbeat comment is sent periodically to keep the connection alive —
**expect roughly 15 seconds of silence before the first byte** if the instance
is quiet. That is not a hang.

Reconnecting: the browser `EventSource` sends `Last-Event-ID` automatically.
With a raw client, pass the last `id:` you saw as `?last=`. If the cursor is
too old or the journal has reset, the stream answers with a `reset` event —
resubscribe from scratch rather than assuming continuity.

Connections are capped instance-wide and per IP; over either cap the endpoint
returns `429` (durable — don't retry until a connection frees up). New
connection *attempts* from one IP are separately rate-limited over a rolling
~60s window; over that limit the endpoint also returns `429`, but this one is
transient — back off and retry.

---

## Reading

### Reads that need no key

Alongside the firehose and the feeds, three read endpoints are reachable
anonymously. They return exactly what a logged-out visitor sees — nothing
personal, nothing from a source under review:

```
GET /api/v1/timeline           # the public timeline
GET /api/v1/post/:id           # a single item
GET /api/v1/post/:id/thread    # an item with its ancestors and replies
```

`/post/:id/thread` covers `/post/:id`: for a visible item it carries the same
record, and for an item hidden from you it either answers `404` identically or
returns a neutral placeholder connecting replies you *can* see. Prefer the
thread endpoint unless you specifically want the single-item shape.

These are a **stated contract**, not an accident of the proxy — build against
them.

### Your timeline

```
GET /api/v1/me/timeline        # timeline:read
GET /api/v1/me/posts           # posts:read
```

`/me/timeline` is your personal lens — local posts plus everything you follow
or subscribe to. `/me/posts` is only what you wrote.

| Query | Default | Notes |
|---|---|---|
| `limit` | `50` | Clamped to 1–100. A non-integer is ignored, not rejected |
| `before` | — | Opaque pagination cursor; an invalid one returns `400` |

Page by passing the cursor from the previous response back as `before`. Cursors
are opaque — don't construct or decode them.

---

## Writing

### Posts

```
POST   /api/v1/me/posts              # posts:write
PATCH  /api/v1/me/posts/:id          # posts:write
DELETE /api/v1/me/posts/:id          # posts:write
```

**Create** — `content` is Markdown, 1–100,000 characters. `inReplyTo` is
optional and takes a post id; an unknown id returns `404`.

```bash
curl -X POST https://rsc.example.org/api/v1/me/posts \
  -H "x-api-key: $RSC_KEY" -H "content-type: application/json" \
  -d '{"content":"Hello from the API."}'
```

Returns `201` with the created post.

**Edit** — send the new `content`. Editing to the identical text is a no-op
that returns `200` without creating a revision. Editing is only possible on
your own local posts; anything else returns `403`.

**Delete** — hard removal, `200` on success. This is not recoverable.

Content goes through the same rendering and sanitising path as a post written
in the web UI, so HTML is sanitised server-side regardless of entry point.

### Follows and subscriptions

```
POST   /api/v1/me/api-follows                  # follows:write
DELETE /api/v1/me/api-follows/:target          # follows:write
POST   /api/v1/me/api-subscriptions            # follows:write
DELETE /api/v1/me/api-subscriptions/:sourceId  # follows:write
```

> The `api-` prefix is not cosmetic. The cookie-authenticated web UI already
> owns `/me/follows` and `/me/subscriptions`; these are the key-authenticated
> equivalents on distinct paths.

**Follow** an account on this instance by `handle`. **Subscribe** to a remote
feed by `url`.

Subscribe and unsubscribe both require a `commandId` — a string you generate
(a UUID is fine) that makes the operation idempotent. Retrying with the same
`commandId` will not double-apply; reusing one for a *different* operation
returns `409`.

```bash
curl -X POST https://rsc.example.org/api/v1/me/api-subscriptions \
  -H "x-api-key: $RSC_KEY" -H "content-type: application/json" \
  -d '{"url":"https://example.com/feed.xml","commandId":"'$(uuidgen)'"}'
```

**Note on cascade delete:** these two cases behave differently, and the split
is by *endpoint*, not by target type — a webfeed target removed via
`/me/api-follows` gets the unconditional path below, even though feeds are
also what `/me/api-subscriptions` handles with the guarded path.

`DELETE /me/api-follows/:target` goes through `removeFollow`, which
unconditionally removes a remote target you're the last follower of —
`person` or `webfeed` alike — from the instance (mirrors existing
cookie-authenticated UI behavior) — a scripted client churning follow/unfollow
at high frequency may remove accounts/feeds faster than a human would
interactively.

`DELETE /me/api-subscriptions/:sourceId`, by contrast, goes through
`sourceService.unsubscribe` → `reapSourceIfOrphaned`, which only removes the
underlying source if it's fully orphaned: no other subscribers, governance
`allowed`, not federated, not `admin_retained`, no `source_audit_v2` history,
and not backing `verified_origin` evidence for any logical item. Any one of
those holds it in place. See "Unsubscribe takes a `commandId`" below.

Responses:

- `201` / `200` — subscribed (created / already existed)
- `{"subscription":"pending"}` — accepted, but the source is awaiting admin
  review and will not deliver items yet. This is normal on instances that
  moderate new sources, not an error
- `429` — you've hit the subscription cap
- `409` — either an idempotency conflict, or the source is unavailable

A source you can't subscribe to answers the same way whether it was blocked,
never existed, or was removed. That's deliberate: the API doesn't disclose an
instance's moderation state.

Unsubscribe takes a `commandId` in the body too, and always reports plain
success — whether the underlying source row survived depends on governance and
retention, which is not yours to see.

### Profile

```
PATCH /api/v1/me/api-profile    # profile:write
```

`handle` and/or `displayName`, both optional, each 1–64 characters. A handle
already taken returns `409`.

Changing your handle **changes your feed URLs and post permalinks.** Existing
subscribers follow the old address until they re-resolve. Don't automate this
on a schedule.

---

## Admin

A separate key tier for scripted governance/moderation — the concrete driver
is an admin running the same action across several independent instances
without logging into each one's `/admin` UI. Not self-serve: keys are minted
by an existing admin at **`/admin/api-keys`**, a web panel distinct from the
self-serve `/settings/api-keys` page above. There is no route that lets a
regular account request one.

Admin keys look like `rsc_admin_…` — a distinct prefix from a personal key's
`rsc_…`, so the two are visually distinguishable at a glance. Send one the
same way, as `x-api-key`.

**Every admin-tier request re-derives admin status from the current config,
not from a flag stored on the key.** A key minted while its owner was an
admin stops working the instant they're removed from `RSC_ADMIN_EMAIL` —
without the key itself needing to be revoked.

### Permissions

| Permission | Grants |
|---|---|
| `admin.read:read` | List sources, users, instance overview, settings |
| `admin.sources:write` | Governance actions on sources (below) |
| `admin.moderation:write` | Hard-remove a user or a post |

Governance actions are restricted to exactly six verbs: `pause`, `resume`,
`quarantine`, `allow`, `block`, `unblock`, plus establishing a new federation.
This is a subset of what the cookie-authed admin UI can do — `approve`,
`reject`, `revoke`, and changing a source's attribution mode stay
cookie-authed only, not reachable via API key.

### Reading

```
GET /admin-api/sources     # admin.read:read
GET /admin-api/users       # admin.read:read
GET /admin-api/overview    # admin.read:read
GET /admin-api/settings    # admin.read:read
```

Same shapes as the cookie-authed `/admin/*` pages these mirror.

### Governance

```
POST /admin-api/sources/:id/:action   # admin.sources:write
POST /admin-api/sources               # admin.sources:write
```

**Transition** — `:action` is one of the six verbs above; anything else
returns `400`. Body takes `commandId` (required, idempotency key), and
`category`/`note`/`attributionMode` as the action requires.

**Establish federation** — body takes `url`, `attributionMode`, `category`,
optional `note`, and `commandId`. Returns `201` with `{"source": ..., 
"federation": ...}` on success.

### Moderation

```
DELETE /admin-api/users/:handle   # admin.moderation:write
DELETE /admin-api/posts/:id       # admin.moderation:write
```

Hard removal, same as the cookie-authed admin panel's Remove actions. Not
recoverable.

---

## Notes for building against this

- **Feeds first.** Reading a timeline over this API is convenient, but the
  instance's RSS and JSON feeds are the native surface and cost the server far
  less. Poll a feed; use the API for what feeds can't do.
- **The firehose is a stream, not a query.** There is no historical search — it
  starts where you connect (or where your cursor resumes) and moves forward.
- **Cursors and keys are opaque.** Both are implementation detail and both may
  change shape.
- **One key per integration.** Rate limits and revocation are per key, so a
  misbehaving script can be cut off without touching anything else.

## There is already a client

If what you want is to read and write RSC from an AI assistant rather than
from your own code, the repo ships an **MCP server** built on exactly the
routes above — `mcp/` in the repository, documented in the README.

It is a thin client over this API and nothing more: three tools (read your
timeline, read a conversation, post or reply), no privileged access, no
private endpoints. It authenticates with an ordinary key you mint at
`/settings/api-keys`, the same one you would use from `curl`.

Two things in it are worth copying if you write your own client:

- **Post creation is not idempotent.** `POST /me/posts` takes no `commandId`,
  unlike the subscription routes which require one. Do not retry a failed
  write — a duplicate post federates to every subscriber, and there is no
  undo. Retry reads if you like; never writes.
- **A key is scoped to one instance.** Keys from two instances are not
  interchangeable, so bind the instance URL to the credential in your
  config rather than storing it alongside. Getting this backwards is easy
  and only shows up when you add the second instance.

### Hosted transport: `POST /mcp`

Every RSC instance also serves the same three tools directly over HTTP —
`https://<instance>/mcp` — for any MCP client that speaks Streamable HTTP,
not just `claude mcp add` against the stdio server above. This is the
`web/` SvelteKit app itself, not a separate process.

```bash
curl -X POST https://rsc.example.org/mcp \
  -H "authorization: Bearer $RSC_KEY" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

- **Auth** is `Authorization: Bearer <key>` — the same key from
  `/settings/api-keys` as everywhere else in this document, not a separate
  credential. Missing or malformed → `401` before any upstream call.
- **Both headers on the request are mandatory.** `content-type:
  application/json` or the request is `415`. `accept` must list *both*
  `application/json` and `text/event-stream` or the request is `406` — the
  SDK requires both even though every response here is SSE.
- **Responses are `text/event-stream`**, one frame per response:
  `event: message\ndata: {…}\n\n`.
- **`GET` and `DELETE` are not supported** — `405`. This route is a single
  stateless POST endpoint; there is no session to open or close.
- **The instance-wide limits above still apply** — 300 requests/hour per
  key, and per-tool permission checks: a `timeline:read`-only key calling
  `rsc_post` gets the tool's own `401`-shaped error text back as a normal
  (non-error-HTTP) tool result, the same as any other permission failure
  from this API.
- **`as` is not used here.** The stdio client's `as` argument exists to pick
  between multiple configured identities; the hosted route has exactly one —
  whichever key the caller presented — so `as` is accepted but has nothing
  to select between.
- **`subscriptions/listen` is refused** (`"Subscription limit reached"`).
  This server only registers the three tools and never calls a notifier, so
  there is nothing for a subscription to ever emit; refusing it up front
  also closes off an unauthenticated caller pinning an idle SSE connection
  against the same process that serves the rest of the web UI.

**Known, accepted limitation — error messages leak internal detail.** Tool
errors on this route reuse the exact strings `mcp/src/tools.ts`'s `rscFetch`
already produces for the stdio client, and two of them assume a stdio
caller: a rejected key comes back as `"...check RSC_IDENTITIES and the
key's permissions"` (an env var a hosted caller has never set and cannot
act on), and a network-level failure can name the internal upstream address
(`http://core:8787` in production, not the public instance URL). This was a
spec-accepted tradeoff — `rscFetch` is shared code outside this milestone's
scope, and rewriting its error strings for two audiences was judged not
worth a second code path. Treat it as a documented rough edge, not a bug to
file.

**Not yet verified — pre-deploy checklist item.** The tests for this route
call its `POST` handler directly (`web/src/routes/mcp/server.test.ts`), so
three things are proven only by inspection, not by an end-to-end request:
SvelteKit's own routing (the `405` on `GET` is asserted by checking the
module has no `GET` export, not by hitting a running server), the
`adapter-node` production build, and the Caddy / cloudron-nginx hop in
front of it. SSE survives those proxies elsewhere in this codebase (the
public firehose already streams through the same path), which makes it
likely `/mcp` does too — but that has not been demonstrated for this route.
Confirm a real SSE response reaches a client through the production reverse
proxy before relying on this in the field.
