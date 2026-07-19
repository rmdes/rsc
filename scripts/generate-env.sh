#!/usr/bin/env bash
# Generate .env for RSC. Prod (default) fills domain + strong secrets +
# the Mailpit bcrypt hash; --dev writes a localhost dev .env (weak, push off).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${1:-}" = "--dev" ]; then
	umask 077 # .env holds secrets — owner-only
	cat > .env <<EOF
# Dev .env (generated). Not for production.
RSC_DOMAIN=localhost
RSC_AUTH_SECRET=$(openssl rand -hex 32)
RSC_TOKEN=dev-token
MAILPIT_USER=mail
MAILPIT_PASSWORD_HASH=
EOF
	echo "Wrote dev .env (use with: docker compose up)."
	exit 0
fi

read -rp "Domain (e.g. rsc.example.com): " DOMAIN
read -rsp "Mailpit /mail password: " MP_PW; echo
# Pipe the password via stdin, NOT --plaintext as an argv: a CLI arg is visible
# in `ps`/audit logs to any local user, defeating the silent read above.
HASH="$(printf '%s\n' "$MP_PW" | docker run --rm -i caddy:2-alpine caddy hash-password)"
umask 077 # .env holds AUTH_SECRET/TOKEN/hash — owner-only
cat > .env <<EOF
RSC_DOMAIN=$DOMAIN
RSC_AUTH_SECRET=$(openssl rand -hex 32)
RSC_TOKEN=$(openssl rand -hex 32)
MAILPIT_USER=mail
MAILPIT_PASSWORD_HASH=$HASH
EOF
echo "Wrote .env (chmod 600). Review it, then: docker compose -f compose.prod.yaml up -d --build"
