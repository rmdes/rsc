# RSC on Cloudron

Packages RSC (core + web + nginx) as a single Cloudron app. SQLite on
the `localstorage` addon; email via the `sendmail` addon. See the design at
`docs/superpowers/specs/2026-07-18-textcaster-cloudron-design.md`.

## Build & install

    # from the repo root — every step, no symlink dance
    cloudron build -f cloudron/Dockerfile
    cloudron install --image <registry>/rsc:<tag> --location <domain>
    cloudron update --app <id/location> --image <registry>/rsc:<tag>

`cloudron build` needs a build service configured once per checkout —
`cloudron build --build-service-url <url> --build-service-token <token>`
for the Cloudron Build Service, or nothing at all if local Docker is already
set up (`cloudron build info` shows the cached config; verified working here
with `Build service type: local`). No `--set-build-service` flag exists on
this CLI version — don't reach for it.

`cloudron build`/`install`/`update` all read `CloudronManifest.json` from the
current working directory — there's no flag to point them elsewhere — so it
(and `logo.png`, which the manifest's `icon: file://logo.png` resolves
relative to) live at the **repo root**, not in `cloudron/`. Always run every
`cloudron` command from the repo root, always with `-f cloudron/Dockerfile`
(the Dockerfile's own `COPY` paths assume the whole workspace as build
context, so it stays put alongside `nginx.conf`/`proxy_params`/`start.sh`).

## What it wires automatically

- `CLOUDRON_APP_ORIGIN` → `RSC_PUBLIC_URL` / `RSC_WEB_ORIGIN` / web `ORIGIN`
- SQLite at `/app/data/textcaster.db` (WAL mode)
- `RSC_AUTH_SECRET` + `RSC_TOKEN` generated once into `/app/data/config/` (stable across restarts)
- `sendmail` addon → `RSC_SMTP_URL` (verify / magic-link / reset emails deliver for real)
- Federation on: WebSub (`self` hub at `/hub`) + rssCloud + push-in

## Data & backups

All state lives in `/app/data` (the SQLite DB + its `-wal`/`-shm`, and the
generated secrets), which Cloudron backs up. The DB runs in WAL mode; the
`-wal`/`-shm` files are backed up alongside `textcaster.db`, so a restore
replays cleanly. For a manual belt-and-suspenders checkpoint before an ad-hoc
backup: `cloudron exec -- sh -c 'sqlite3 /app/data/textcaster.db "PRAGMA wal_checkpoint(TRUNCATE);"'`.
