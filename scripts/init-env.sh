#!/usr/bin/env bash
# Generate .env with strong random secrets. Never overwrites an existing .env.
#
#   ./scripts/init-env.sh                                  # local (http://localhost:8088)
#   PUBLIC_URL=https://tems.techzaz.lk ./scripts/init-env.sh   # server
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  echo ".env already exists — leaving it untouched."
  exit 0
fi

rand() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c "${1:-32}"; }
# Satisfies the realm password policy (length, upper, lower, digit).
pass() { printf '%sAa7' "$(rand 20)"; }

PUBLIC_URL="${PUBLIC_URL:-http://localhost:8088}"
MAIL_DOMAIN="${MAIL_DOMAIN:-tems.techzaz.lk}"
SUPERADMIN_PASSWORD="$(pass)"

umask 077
cat > .env <<EOF
# --- Techzaz EMS environment (generated $(date -u +%Y-%m-%dT%H:%M:%SZ)) ---
PUBLIC_URL=${PUBLIC_URL}
TEMS_BIND=${TEMS_BIND:-127.0.0.1}
TEMS_PORT=${TEMS_PORT:-8088}

POSTGRES_PASSWORD=$(rand 32)
KC_DB_PASSWORD=$(rand 32)
TEMS_DB_PASSWORD=$(rand 32)
KC_BOOTSTRAP_ADMIN_PASSWORD=$(pass)
TEMS_API_CLIENT_SECRET=$(rand 40)

# First super admin (change the email to a real inbox you own)
TEMS_SUPERADMIN_USERNAME=superadmin
TEMS_SUPERADMIN_EMAIL=${TEMS_SUPERADMIN_EMAIL:-admin@${MAIL_DOMAIN}}
TEMS_SUPERADMIN_PASSWORD=${SUPERADMIN_PASSWORD}

# Outbound mail (Postfix + DKIM, sends directly to recipients' MX)
MAIL_DOMAIN=${MAIL_DOMAIN}
MAIL_HOSTNAME=mail.${MAIL_DOMAIN}
MAIL_FROM=no-reply@${MAIL_DOMAIN}
MAIL_FROM_NAME="Techzaz EMS"
EOF

echo "Wrote .env (mode 600)."
echo "Super admin:  superadmin  /  ${SUPERADMIN_PASSWORD}"
echo "Sign in at:   ${PUBLIC_URL}"
