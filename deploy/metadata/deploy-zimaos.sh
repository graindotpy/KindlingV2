#!/usr/bin/env bash
# Installs or updates the self-hosted metadata provider on ZimaOS.
# Run on the Zima from the folder holding compose.yaml:  sudo bash deploy-zimaos.sh
# Optional: METADATA_PORT (default 8788), APP_DIR (default /DATA/AppData/kindling-metadata).
set -euo pipefail
die() { echo "[metadata] $*" >&2; exit 1; }
[[ $(id -u) == 0 ]] || die "Run this helper through sudo."
SRC_DIR=$(cd "$(dirname "$0")" && pwd)
APP_DIR=${APP_DIR:-/DATA/AppData/kindling-metadata}
METADATA_PORT=${METADATA_PORT:-8788}
[[ $METADATA_PORT =~ ^[0-9]+$ ]] || die "METADATA_PORT must be a number."

mkdir -p "$APP_DIR/secrets" "$APP_DIR/data/postgres"
install -m 0644 "$SRC_DIR/compose.yaml" "$APP_DIR/compose.yaml"
# Regenerate a missing or malformed password only while Postgres is uninitialised;
# afterwards the stored password must stay as it is.
if ! grep -Eqx '[0-9a-f]{48}' "$APP_DIR/secrets/postgres_password" 2>/dev/null; then
  [[ -z $(ls -A "$APP_DIR/data/postgres") ]] || die "Postgres is initialised but its password file is missing or malformed."
  # od reads exactly 24 bytes, so no pipe stage is cut short (tr|head would SIGPIPE under pipefail).
  od -An -tx1 -N24 /dev/urandom | tr -d ' \n' >"$APP_DIR/secrets/postgres_password"
fi
# Containers run as non-root users and must read the file, so it stays 0644;
# the root-only 0700 folder keeps other Zima users out.
chmod 0644 "$APP_DIR/secrets/postgres_password"
chmod 0700 "$APP_DIR/secrets"
printf 'METADATA_PORT=%s\n' "$METADATA_PORT" >"$APP_DIR/.env"

# Capture output before grepping: grep -q exiting early would SIGPIPE the producer under pipefail.
running=$(docker ps --format '{{.Names}}')
if ! grep -qx kindling-metadata <<<"$running"; then
  listeners=$(ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null || true)
  if grep -qE "[:.]$METADATA_PORT\s" <<<"$listeners"; then
    die "Port $METADATA_PORT is already in use. Rerun with METADATA_PORT=<free port>."
  fi
fi

cd "$APP_DIR"
docker compose --env-file .env -f compose.yaml config >/dev/null || die "Compose configuration is invalid."
docker compose --env-file .env -f compose.yaml up -d

echo "[metadata] Waiting for the provider on port $METADATA_PORT..."
for _ in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$METADATA_PORT/author/31232" || true)
  if [[ $code =~ ^(200|404)$ ]]; then
    echo "[metadata] Provider is answering (HTTP $code). Point Readarr at http://<zima-lan-ip>:$METADATA_PORT"
    exit 0
  fi
  sleep 5
done
docker compose --env-file .env -f compose.yaml logs --tail=50 metadata || true
die "Provider did not answer within 5 minutes."
