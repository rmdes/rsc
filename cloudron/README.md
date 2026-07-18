# Textcaster on Cloudron

Packages Textcaster (core + web + nginx) as a single Cloudron app. SQLite on
the `localstorage` addon; email via the `sendmail` addon. See the design at
`docs/superpowers/specs/2026-07-18-textcaster-cloudron-design.md`.

## Build & install

    # from the repo root
    cloudron build --set-build-service <your-build-service>   # or: docker build -f cloudron/Dockerfile -t <registry>/textcaster:dev .
    cloudron install --image <registry>/textcaster:dev

`cloudron build` reads `cloudron/CloudronManifest.json`; run it from the repo
root so the whole workspace is the build context, pointing at `cloudron/Dockerfile`.

## What it wires automatically

- `CLOUDRON_APP_ORIGIN` → `TEXTCASTER_PUBLIC_URL` / `TEXTCASTER_WEB_ORIGIN` / web `ORIGIN`
- SQLite at `/app/data/textcaster.db` (WAL mode)
- `TEXTCASTER_AUTH_SECRET` + `TEXTCASTER_TOKEN` generated once into `/app/data/config/` (stable across restarts)
- `sendmail` addon → `TEXTCASTER_SMTP_URL` (verify / magic-link / reset emails deliver for real)
- Federation on: WebSub (`self` hub at `/hub`) + rssCloud + push-in

## Data & backups

All state lives in `/app/data` (the SQLite DB + its `-wal`/`-shm`, and the
generated secrets), which Cloudron backs up. The DB runs in WAL mode; the
`-wal`/`-shm` files are backed up alongside `textcaster.db`, so a restore
replays cleanly. For a manual belt-and-suspenders checkpoint before an ad-hoc
backup: `cloudron exec -- sh -c 'sqlite3 /app/data/textcaster.db "PRAGMA wal_checkpoint(TRUNCATE);"'`.
