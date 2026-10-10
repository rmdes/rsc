#!/usr/bin/env bash
# Drive the RSC dev stack (docker compose: core + web + mailpit) like a user.
# Run from the repo root:  .claude/skills/run-rsc/driver.sh <command> [args]
# Commands: up | login | smoke | flow [feedUrl] | shot <path> [name] | db "<SQL>" | test | logout
set -euo pipefail

WEB=http://localhost:5173
CORE=http://localhost:8787
MAIL=http://localhost:8025
STATE=/tmp/rsc-driver          # cookie jar lives here; contains a live session token
JAR=$STATE/jar.txt
SHOTS=/tmp/rsc-shots
mkdir -p "$STATE" "$SHOTS"

say()  { printf '%s\n' "$*"; }
ok()   { printf '  PASS  %s\n' "$*"; }
die()  { printf '  FAIL  %s\n' "$*" >&2; exit 1; }
uuid() { cat /proc/sys/kernel/random/uuid; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$@"; }

# Read-only SQL against the LIVE dev DB. It lives in the core-data docker volume,
# NOT at ./core/data/dev.db on the host (that file is a stale copy).
db() {
  docker compose exec -T core node -e "
    const D = require('/app/core/node_modules/better-sqlite3')
    const db = new D('/app/core/data/dev.db', { readonly: true })
    console.log(JSON.stringify(db.prepare(process.argv[1]).all()))" "$1"
}
dbval() { db "$1" | python3 -c 'import json,sys; r=json.load(sys.stdin); print(list(r[0].values())[0] if r else "")'; }

# SvelteKit form action, exactly as a no-JS browser submits it. CSRF requires the
# Origin header; the action answers 200 (not 303) to curl, so callers assert on
# the EFFECT (DB / page content), never on the status alone.
action() { local path=$1; shift; curl -s -o "$STATE/last.html" -w '%{http_code}' --max-time 60 \
  -b "$JAR" -c "$JAR" -X POST "$WEB$path" -H "Origin: $WEB" "$@"; }

cmd_up() {
  docker compose up -d >/dev/null 2>&1
  for _ in $(seq 1 90); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' rsc-core 2>/dev/null)" = healthy ] && break; sleep 5
  done
  [ "$(docker inspect -f '{{.State.Health.Status}}' rsc-core)" = healthy ] || die "core not healthy (docker compose logs core)"
  ok "core healthy ($(code $CORE/health) on /health)"
  local c; c=$(curl -s -o "$STATE/web.html" -w '%{http_code}' --max-time 30 $WEB/ || true)
  if [ "$c" = 500 ] && grep -q "new version of the pre-bundle" "$STATE/web.html"; then
    say "  web 500: stale Vite dependency pre-bundle -> restarting web"
    docker compose restart web >/dev/null 2>&1
  fi
  for _ in $(seq 1 40); do [ "$(code $WEB/)" = 200 ] && break; sleep 3; done
  [ "$(code $WEB/)" = 200 ] || die "web / not 200 (docker compose logs web)"
  ok "web serving $WEB/"
}

cmd_login() {
  local email; email=$(grep '^RSC_ADMIN_EMAIL=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | cut -d, -f1)
  [ -n "$email" ] || die "no RSC_ADMIN_EMAIL in ./.env (admin = that verified address)"
  rm -f "$JAR"
  local before; before=$(curl -s $MAIL/api/v1/messages | python3 -c 'import json,sys;print(json.load(sys.stdin).get("total",0))')
  local c; c=$(curl -s -o "$STATE/ml.json" -w '%{http_code}' -c "$JAR" -b "$JAR" -X POST $WEB/api/auth/sign-in/magic-link \
    -H 'Content-Type: application/json' -H "Origin: $WEB" --data "{\"email\":\"$email\",\"callbackURL\":\"/\"}")
  [ "$c" = 200 ] || die "magic-link request -> $c: $(head -c 200 "$STATE/ml.json")"
  local n=$before
  for _ in $(seq 1 20); do
    n=$(curl -s $MAIL/api/v1/messages | python3 -c 'import json,sys;print(json.load(sys.stdin).get("total",0))')
    [ "$n" -gt "$before" ] && break; sleep 1
  done
  [ "$n" -gt "$before" ] || die "no magic-link mail arrived in Mailpit"
  local id link
  id=$(curl -s $MAIL/api/v1/messages | python3 -c 'import json,sys;print(json.load(sys.stdin)["messages"][0]["ID"])')
  link=$(curl -s "$MAIL/api/v1/message/$id" | python3 -c '
import json,sys,re
m=json.load(sys.stdin); t=(m.get("Text") or "")+" "+(m.get("HTML") or "")
u=re.findall(r"https?://[^\s\"<>]+magic-link/verify[^\s\"<>]*", t); print(u[0].replace("&amp;","&") if u else "")')
  [ -n "$link" ] || die "magic-link URL not found in the mail"
  curl -s -o /dev/null -c "$JAR" -b "$JAR" "$link"
  curl -s -b "$JAR" $WEB/api/auth/get-session -H "Origin: $WEB" | python3 -c '
import json,sys; u=((json.load(sys.stdin) or {}).get("user") or {})
sys.exit(0 if u and u.get("emailVerified") and not u.get("isAnonymous") else 1)' || die "no verified session after opening the link"
  ok "signed in as admin (cookie jar: $JAR)"
}

need_session() { [ -s "$JAR" ] || die "no session — run: $0 login"; }

cmd_smoke() {
  [ "$(code $CORE/health)" = 200 ] && ok "core /health 200" || die "core /health"
  [ "$(code $WEB/)" = 200 ] && ok "web / 200" || die "web /"
  [ "$(code $WEB/api/auth/get-session)" = 200 ] && ok "web /api/auth/get-session 200" || die "get-session"
  need_session
  local c; c=$(curl -s -o "$STATE/admin.html" -w '%{http_code}' -b "$JAR" $WEB/admin/feeds)
  [ "$c" = 200 ] && ! grep -q "Internal Error" "$STATE/admin.html" && ok "web /admin/feeds 200 as admin" || die "/admin/feeds -> $c"
}

# Exercises the whole source plane through the UI's own form actions, then
# removes everything it created. Refuses to touch a feed that already exists.
cmd_flow() {
  need_session
  local feed=${1:-https://www.404media.co/rss/} host
  host=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.urlparse(sys.argv[1]).hostname)' "$feed")
  [ -z "$(dbval "select id from remote_sources_v2 where canonical_url = '$feed'")" ] \
    || die "$feed is already a source in the dev DB — refusing (this flow force-reaps what it creates)"

  action '/?/subscribe' --data-urlencode "url=$feed" --data-urlencode "commandId=$(uuid)" >/dev/null
  local id; id=$(dbval "select id from remote_sources_v2 where canonical_url = '$feed'")
  [ -n "$id" ] && [ "$(dbval "select state from source_subscriptions_v2 where source_id = '$id'")" = active ] \
    && ok "subscribe -> source $id, subscription active" || die "subscribe created no active subscription"

  curl -s -b "$JAR" -o "$STATE/feeds.html" $WEB/admin/feeds
  grep -q "/admin/sources/$id" "$STATE/feeds.html" && ok "admin list shows it" || die "admin list missing source"
  local c; c=$(curl -s -o "$STATE/detail.html" -w '%{http_code}' -b "$JAR" "$WEB/admin/sources/$id")
  [ "$c" = 200 ] && grep -q "$host" "$STATE/detail.html" && ok "admin detail page 200" || die "detail -> $c"

  for a in pause resume; do
    action '/admin/feeds?/source' --data-urlencode "action=$a" --data-urlencode "sourceId=$id" --data-urlencode "commandId=$(uuid)" >/dev/null
  done
  [ "$(dbval "select operation from remote_sources_v2 where id = '$id'")" = enabled ] \
    && [ "$(dbval "select count(*) from source_audit_v2 where source_id = '$id'")" = 2 ] \
    && ok "pause -> resume: back to enabled, 2 audit rows" || die "transition state/audit wrong"

  local handle; handle=$(dbval "select u.handle from source_subscriptions_v2 s join users u on u.id = s.owner_id where s.source_id = '$id'")
  curl -s -b "$JAR" "$WEB/u/$handle/following" | grep -q "$host" && ok "following page lists it" || die "following page"
  curl -s "$CORE/users/$handle/following.opml" | grep -q "$host" && ok "public following.opml lists it" || die "opml"

  action "/u/$handle/following?/unsubscribe" --data-urlencode "sourceId=$id" --data-urlencode "commandId=$(uuid)" >/dev/null
  [ "$(dbval "select count(*) from source_subscriptions_v2 where source_id = '$id'")" = 0 ] \
    && ok "unsubscribe -> 0 subscriptions" || die "unsubscribe"

  # Audited sources are retained (retentionFor -> audit_history): a plain reap is
  # refused, by design. Force is the admin override and the cleanup path.
  action '/admin/feeds?/reap' --data-urlencode "sourceId=$id" --data-urlencode "commandId=$(uuid)" >/dev/null
  grep -q audit_history "$STATE/last.html" && [ -n "$(dbval "select id from remote_sources_v2 where id = '$id'")" ] \
    && ok "plain reap refused: audit_history" || die "plain reap was not refused"
  action '/admin/feeds?/reap' --data-urlencode "sourceId=$id" --data-urlencode "commandId=$(uuid)" --data-urlencode "force=true" >/dev/null
  [ -z "$(dbval "select id from remote_sources_v2 where id = '$id'")" ] \
    && ok "force reap -> source removed, dev DB left as found" || die "force reap"
}

cmd_shot() {
  local path=${1:?usage: shot <path> [name]} name=${2:-shot}
  timeout 60 google-chrome --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
    --window-size=1280,1600 --screenshot="$SHOTS/$name.png" "$WEB$path" >/dev/null 2>&1
  [ -s "$SHOTS/$name.png" ] && ok "screenshot -> $SHOTS/$name.png" || die "no screenshot written"
}

cmd_test() {
  docker compose exec -T core npm run typecheck -w core >/dev/null 2>&1 && ok "core typecheck" || die "core typecheck"
  docker compose exec -T core npm test -w core 2>&1 | grep -E "Tests " | tail -1
  docker compose exec -T web env -u CORE_API_URL npm test -w web 2>&1 | grep -E "Tests " | tail -1
  docker compose exec -T web npm run check -w web 2>&1 | tail -1
}

case "${1:-}" in
  up) cmd_up ;;
  login) cmd_login ;;
  smoke) cmd_smoke ;;
  flow) shift; cmd_flow "$@" ;;
  shot) shift; cmd_shot "$@" ;;
  db) shift; db "${1:?usage: db \"<SQL>\"}" ;;
  test) cmd_test ;;
  logout) rm -f "$JAR"; ok "cookie jar removed" ;;
  *) sed -n '2,4p' "$0"; exit 2 ;;
esac
