# RSC API

Programmatic access to an RSC instance. Everything here is served by the web
app under `/api/v1/` — core is never reachable directly (see CLAUDE.md's
perimeter invariant), so the base URL is just your instance:

```
https://rsc.example.org/api/v1
```

Two things need no key at all: the **public firehose** below, and every RSS /
JSON feed the instance already publishes. Feeds remain the primary integration
surface — this API exists for the things a feed can't express (writing, and
reading your own personal timeline). If a feed reader can do the job, use a
feed.

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
| `429` | Subscription cap reached |

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

Connections are capped instance-wide; over the cap the endpoint returns `429`.

---

## Reading

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
DELETE /api/v1/me/api-follows/:handle          # follows:write
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
