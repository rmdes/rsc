#!/bin/bash
set -eu

# ── Helper functions (also sourced by the test with TC_SOURCE_ONLY=1) ──
tc_ensure_secret() { # $1 = file; prints the secret, generating once.
  local f="$1"
  [ -f "$f" ] || ( umask 077; openssl rand -hex 32 > "$f" )
  cat "$f"
}

tc_urlenc() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"; }

tc_smtp_url() { # server port user pass
  printf 'smtp://%s:%s@%s:%s' "$(tc_urlenc "$3")" "$(tc_urlenc "$4")" "$1" "$2"
}

[ "${TC_SOURCE_ONLY:-0}" = "1" ] && return 0

# ── Runtime ──
echo "==> Textcaster: preparing /app/data"
mkdir -p /app/data/config

# Secrets: generate once, persist, NEVER regenerate (would drop all sessions).
RSC_AUTH_SECRET=$(tc_ensure_secret /app/data/config/auth_secret)
export RSC_AUTH_SECRET
RSC_TOKEN=$(tc_ensure_secret /app/data/config/ops_token)
export RSC_TOKEN

# Instance admin allowlist (optional, comma-separated emails). Persisted like the
# secrets so it survives restarts and is changeable via `cloudron exec` without a
# rebuild: cloudron exec --app <id> -- sh -c 'echo you@example.com > /app/data/config/admin_email'
[ -f /app/data/config/admin_email ] && export RSC_ADMIN_EMAIL="$(cat /app/data/config/admin_email)"

# Map Cloudron env → Textcaster/core.
export RSC_DB="/app/data/textcaster.db"
export RSC_PUBLIC_URL="${CLOUDRON_APP_ORIGIN}"
export RSC_WEB_ORIGIN="${CLOUDRON_APP_ORIGIN}"
export RSC_WEBSUB="self"
export RSC_RSSCLOUD="on"
export RSC_PUSH_IN="on"
export RSC_PORT="8787"
if [ -n "${CLOUDRON_MAIL_SMTP_SERVER:-}" ]; then
  RSC_SMTP_URL=$(tc_smtp_url "$CLOUDRON_MAIL_SMTP_SERVER" "$CLOUDRON_MAIL_SMTP_PORT" "$CLOUDRON_MAIL_SMTP_USERNAME" "$CLOUDRON_MAIL_SMTP_PASSWORD")
  export RSC_SMTP_URL
  export RSC_MAIL_FROM="${CLOUDRON_MAIL_FROM}"
fi

# web (adapter-node) env. XFF_DEPTH=2 for the Cloudron-proxy → nginx chain
# (verify in the install smoke; see Task 6).
export CORE_API_URL="http://127.0.0.1:8787"
export PORT="3000"
export ORIGIN="${CLOUDRON_APP_ORIGIN}"
export ADDRESS_HEADER="X-Forwarded-For"
export XFF_DEPTH="2"

chown -R cloudron:cloudron /app/data

# nginx first, so the health check answers during boot.
cp /app/pkg/nginx.conf /run/textcaster-nginx.conf
mkdir -p /run/nginx-body /run/nginx-proxy /run/nginx-fastcgi /run/nginx-uwsgi /run/nginx-scgi
echo "==> Starting nginx on :8000"
nginx -c /run/textcaster-nginx.conf &

# core (migrations run automatically at boot) — write diagnostics under /tmp.
echo "==> Starting core on :8787"
cd /tmp
gosu cloudron:cloudron env NODE_OPTIONS="" node /app/code/core/src/server.ts &
CORE_PID=$!

# web immediately — it degrades gracefully if core is briefly unready.
echo "==> Starting web on :3000"
gosu cloudron:cloudron node /app/code/web/build/index.js &
WEB_PID=$!

# No hand-rolled watchdog: if any process dies, exit → Cloudron restarts us.
echo "==> Up (core=$CORE_PID web=$WEB_PID). Waiting…"
wait -n
echo "==> A process exited; stopping so Cloudron restarts the container."
exit 1
