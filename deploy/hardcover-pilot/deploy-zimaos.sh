#!/bin/bash

set -Eeuo pipefail
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 077

ARCHIVE=""
EXPECTED_SHA256=""
RELEASE_ID=""
APP_DIR=""
HEALTH_TIMEOUT_SECONDS=""
KEEP_UPLOAD=0
SKIP_LIVE_SEARCH=0

STAGING_DIR=""
SOURCE_DIR=""
LOCK_DIRECTORY=""
LOCK_KIND=""
DEPLOYMENT_SUCCEEDED=0
ACTIVE_TAG_CHANGED=0
ROLLBACK_ATTEMPTED=0
HAD_EXISTING_STACK=0
PREVIOUS_IMAGE_ID=""
COMPOSE_BACKUP=""

METADATA_REPOSITORY="kindling/rreading-glasses-hardcover"
ACTIVE_IMAGE="$METADATA_REPOSITORY:local"
BOOKSHELF_IMAGE="ghcr.io/pennydreadful/bookshelf:hardcover-v0.4.20.129@sha256:388eecc94362580eae31ee0a454be6af516f8a311f8432a521c202fb475f4359"
POSTGRES_IMAGE="postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0"
EXPECTED_UPSTREAM_COMMIT="a2939b625d91389d3f0a3e58cbc3bfa7ebb8390a"

log() {
  printf '\n[hardcover-pilot] %s\n' "$*"
}

warn() {
  printf '[hardcover-pilot] WARNING: %s\n' "$*" >&2
}

die() {
  printf '[hardcover-pilot] ERROR: %s\n' "$*" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --archive) ARCHIVE=${2:-}; shift 2 ;;
    --sha256) EXPECTED_SHA256=${2:-}; shift 2 ;;
    --release) RELEASE_ID=${2:-}; shift 2 ;;
    --app-dir) APP_DIR=${2:-}; shift 2 ;;
    --health-timeout) HEALTH_TIMEOUT_SECONDS=${2:-}; shift 2 ;;
    --keep-upload) KEEP_UPLOAD=1; shift ;;
    --skip-live-search) SKIP_LIVE_SEARCH=1; shift ;;
    *) die "Unknown or incomplete argument: $1" ;;
  esac
done

[[ $(id -u) == 0 ]] || die "Run this helper through sudo."
[[ $0 =~ ^/tmp/hardcover-pilot-[A-Za-z0-9._-]+\.sh$ && -f $0 && ! -L $0 ]] || die "The helper must be a regular pilot file directly below /tmp."
[[ $ARCHIVE =~ ^/tmp/hardcover-pilot-[A-Za-z0-9._-]+\.tar\.gz$ && -f $ARCHIVE && ! -L $ARCHIVE ]] || die "The archive must be a regular pilot file directly below /tmp."
[[ $EXPECTED_SHA256 =~ ^[0-9a-fA-F]{64}$ ]] || die "Expected SHA-256 is invalid."
[[ $RELEASE_ID =~ ^[A-Za-z0-9][A-Za-z0-9._-]{5,80}$ ]] || die "Release identifier is invalid."
[[ $ARCHIVE == "/tmp/hardcover-pilot-$RELEASE_ID.tar.gz" && $0 == "/tmp/hardcover-pilot-$RELEASE_ID.sh" ]] || die "Uploaded filenames do not match the release identifier."
[[ $APP_DIR =~ ^/DATA/AppData/[A-Za-z0-9._/-]+$ && $APP_DIR != *//* && ! $APP_DIR =~ (^|/)\.\.?(/|$) ]] || die "App directory must be a safe path below /DATA/AppData."
[[ $HEALTH_TIMEOUT_SECONDS =~ ^[0-9]+$ ]] || die "Health timeout must be an integer."
((HEALTH_TIMEOUT_SECONDS >= 60 && HEALTH_TIMEOUT_SECONDS <= 600)) || die "Health timeout must be between 60 and 600 seconds."

for required_command in docker tar gzip sha256sum mktemp readlink grep awk date cp chmod rm sleep curl stat install; do
  command -v "$required_command" >/dev/null 2>&1 || die "Required command '$required_command' is not installed."
done
docker info >/dev/null 2>&1 || die "Docker is unavailable to the root deployment process."

cleanup() {
  local exit_status=$?
  trap - EXIT INT TERM

  if ((exit_status != 0 && DEPLOYMENT_SUCCEEDED == 0 && ROLLBACK_ATTEMPTED == 0)) && declare -F rollback_deployment >/dev/null; then
    warn "Pilot deployment did not complete; attempting a safe rollback."
    rollback_deployment || warn "Automatic pilot rollback failed; inspect the pilot containers and backups."
  fi

  if [[ -n $STAGING_DIR ]]; then
    case "$STAGING_DIR" in
      /tmp/hardcover-pilot.*)
        [[ $STAGING_DIR != /tmp/hardcover-pilot. ]] && rm -rf -- "$STAGING_DIR"
        ;;
      *) warn "Refusing to remove unexpected staging path '$STAGING_DIR'." ;;
    esac
  fi

  if ((KEEP_UPLOAD == 0)); then
    rm -f -- "$ARCHIVE"
    case "$0" in
      /tmp/hardcover-pilot-*.sh) rm -f -- "$0" ;;
      *) warn "Refusing to remove unexpected helper path '$0'." ;;
    esac
  fi

  if [[ $LOCK_KIND == directory && -n $LOCK_DIRECTORY ]]; then
    case "$LOCK_DIRECTORY" in
      /tmp/hardcover-pilot.lock.*) rmdir -- "$LOCK_DIRECTORY" 2>/dev/null || true ;;
    esac
  fi

  exit "$exit_status"
}

trap cleanup EXIT
trap 'exit 130' INT TERM

if command -v flock >/dev/null 2>&1; then
  exec 9>/tmp/hardcover-pilot.lock
  flock -n 9 || die "Another Hardcover pilot deployment is already running."
  LOCK_KIND=flock
else
  LOCK_DIRECTORY=/tmp/hardcover-pilot.lock.d
  mkdir "$LOCK_DIRECTORY" 2>/dev/null || die "Another Hardcover pilot deployment is already running."
  LOCK_KIND=directory
fi

STAGING_DIR=$(mktemp -d /tmp/hardcover-pilot.XXXXXX)
[[ $STAGING_DIR == /tmp/hardcover-pilot.* && $STAGING_DIR != /tmp/hardcover-pilot. ]] || die "Could not create a safe staging directory."
SOURCE_DIR=$STAGING_DIR/source
mkdir -m 700 "$SOURCE_DIR" "$STAGING_DIR/docker-config"
export DOCKER_CONFIG="$STAGING_DIR/docker-config"

log "Verifying release $RELEASE_ID"
ACTUAL_SHA256=$(sha256sum -- "$ARCHIVE" | awk '{print tolower($1)}')
[[ $ACTUAL_SHA256 == "${EXPECTED_SHA256,,}" ]] || die "Archive SHA-256 does not match the local package."
gzip -t -- "$ARCHIVE" || die "Archive compression check failed."

MANIFEST=$STAGING_DIR/archive-members.txt
tar -tzf "$ARCHIVE" >"$MANIFEST"
while IFS= read -r raw_entry; do
  entry=${raw_entry#./}
  [[ -n $entry ]] || continue
  [[ $entry != /* && ! $entry =~ ^[A-Za-z]: && $entry != *\\* && ! $entry =~ (^|/)\.\.(/|$) ]] || die "Archive contains an unsafe path: $entry"
  [[ ! $entry =~ [[:cntrl:]] ]] || die "Archive contains a control character in a path."
  top_level=${entry%%/*}
  case "$top_level" in
    SOURCE_MANIFEST.txt|compose.yaml|pilot.env.example|deploy-zimaos.sh|rreading-glasses) ;;
    *) die "Archive contains unexpected top-level entry: $top_level" ;;
  esac
  lower_entry=${entry,,}
  [[ ! $lower_entry =~ (^|/)\.git(/|$) ]] || die "Archive contains Git internals."
  [[ ! $lower_entry =~ (^|/)\.env($|\.) ]] || die "Archive contains a private environment file."
  [[ ! $lower_entry =~ (^|/)secrets?(/|$) ]] || die "Archive contains a secrets directory."
done <"$MANIFEST"

for required_member in SOURCE_MANIFEST.txt compose.yaml pilot.env.example deploy-zimaos.sh rreading-glasses/Dockerfile rreading-glasses/cmd/rghc/main.go; do
  grep -Fxq "$required_member" "$MANIFEST" || die "Archive is missing '$required_member'."
done

tar --extract --gzip --file "$ARCHIVE" --directory "$SOURCE_DIR" --no-same-owner --no-same-permissions
EXECUTED_HELPER_SHA256=$(sha256sum -- "$0" | awk '{print tolower($1)}')
ARCHIVED_HELPER_SHA256=$(sha256sum -- "$SOURCE_DIR/deploy-zimaos.sh" | awk '{print tolower($1)}')
[[ $EXECUTED_HELPER_SHA256 == "$ARCHIVED_HELPER_SHA256" ]] || die "Uploaded helper does not match the verified source archive."
grep -Fxq "upstream_commit=$EXPECTED_UPSTREAM_COMMIT" "$SOURCE_DIR/SOURCE_MANIFEST.txt" || die "Source manifest does not contain the approved upstream commit."
grep -q 'HARDCOVER_BATCH_SIZE' "$SOURCE_DIR/rreading-glasses/cmd/rghc/main.go" || die "Patched metadata source is missing the batch-size control."
grep -Eq 'HardcoverBatchSize[[:space:]]*>[[:space:]]*5' "$SOURCE_DIR/rreading-glasses/cmd/rghc/main.go" || die "Patched metadata source does not enforce the Hardcover ceiling."

if [[ -e $APP_DIR ]]; then
  [[ -d $APP_DIR && ! -L $APP_DIR ]] || die "Existing app path is not a regular directory."
else
  install -d -m 700 "$APP_DIR"
fi
APP_DIR=$(readlink -f -- "$APP_DIR")
[[ $APP_DIR == /DATA/AppData/* && $APP_DIR != /DATA/AppData/ ]] || die "Resolved app directory is outside /DATA/AppData."

ENV_FILE=$APP_DIR/.env
SECRETS_DIR=$APP_DIR/secrets
HARDCOVER_SECRET=$SECRETS_DIR/hardcover_auth
POSTGRES_SECRET=$SECRETS_DIR/postgres_password

[[ -f $ENV_FILE && ! -L $ENV_FILE ]] || die "Create $ENV_FILE from pilot.env.example before deploying."
[[ -f $HARDCOVER_SECRET && ! -L $HARDCOVER_SECRET ]] || die "Create the root-owned Hardcover token file $HARDCOVER_SECRET before deploying."
[[ -f $POSTGRES_SECRET && ! -L $POSTGRES_SECRET ]] || die "Create the root-owned PostgreSQL password file $POSTGRES_SECRET before deploying."
[[ $(stat -c '%u' "$HARDCOVER_SECRET") == 0 && $(stat -c '%a' "$HARDCOVER_SECRET") == 600 ]] || die "Hardcover token file must be owned by root with mode 600."
[[ $(stat -c '%u' "$POSTGRES_SECRET") == 0 && $(stat -c '%a' "$POSTGRES_SECRET") == 600 ]] || die "PostgreSQL password file must be owned by root with mode 600."
grep -Eq '^Bearer[[:space:]][^[:space:]]+$' "$HARDCOVER_SECRET" || die "Hardcover token file must contain exactly one 'Bearer ...' value."
grep -Eq '^[A-Za-z0-9_-]{24,128}$' "$POSTGRES_SECRET" || die "PostgreSQL password must contain 24-128 letters, digits, underscores or hyphens."
if grep -Eq '^(HARDCOVER_AUTH|POSTGRES_PASSWORD)=' "$ENV_FILE"; then
  die "Secrets must not be stored in the pilot .env file."
fi

install -d -m 755 \
  "$APP_DIR/data/config/ebook" \
  "$APP_DIR/data/config/audiobook" \
  "$APP_DIR/data/library/ebooks" \
  "$APP_DIR/data/library/audiobooks" \
  "$APP_DIR/data/postgres" \
  "$APP_DIR/deploy-backups"

env_value() {
  local key=$1
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
}

PILOT_UID=$(env_value PILOT_PUID)
PILOT_GID=$(env_value PILOT_PGID)
PILOT_UID=${PILOT_UID:-1000}
PILOT_GID=${PILOT_GID:-1000}
[[ $PILOT_UID =~ ^[0-9]+$ && $PILOT_GID =~ ^[0-9]+$ ]] || die "PILOT_PUID and PILOT_PGID must be numeric."
((PILOT_UID > 0 && PILOT_GID > 0)) || die "PILOT_PUID and PILOT_PGID must be greater than zero."
chown -R "$PILOT_UID:$PILOT_GID" "$APP_DIR/data/config" "$APP_DIR/data/library"

COMPOSE_CANDIDATE=$SOURCE_DIR/compose.yaml
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_CANDIDATE" config >/dev/null || die "Pilot Compose configuration is invalid."

CANDIDATE_IMAGE="$METADATA_REPOSITORY:release-$RELEASE_ID"
ROLLBACK_IMAGE="$METADATA_REPOSITORY:rollback-$RELEASE_ID"

log "Building locally patched metadata image $CANDIDATE_IMAGE"
docker build \
  --build-arg RGPATH=./cmd/rghc \
  --label "co.grainserver.kindling.component=rreading-glasses-hardcover" \
  --label "co.grainserver.kindling.release=$RELEASE_ID" \
  --label "co.grainserver.kindling.upstream=$EXPECTED_UPSTREAM_COMMIT" \
  --tag "$CANDIDATE_IMAGE" \
  "$SOURCE_DIR/rreading-glasses"
CANDIDATE_IMAGE_ID=$(docker image inspect --format '{{.Id}}' "$CANDIDATE_IMAGE")
[[ $CANDIDATE_IMAGE_ID =~ ^sha256:[0-9a-f]{64}$ ]] || die "Could not resolve the candidate metadata image."

log "Pulling immutable Bookshelf and PostgreSQL images"
docker pull "$BOOKSHELF_IMAGE" >/dev/null
docker pull "$POSTGRES_IMAGE" >/dev/null

if docker image inspect "$ACTIVE_IMAGE" >/dev/null 2>&1; then
  PREVIOUS_IMAGE_ID=$(docker image inspect --format '{{.Id}}' "$ACTIVE_IMAGE")
  docker image tag "$PREVIOUS_IMAGE_ID" "$ROLLBACK_IMAGE"
  docker image tag "$PREVIOUS_IMAGE_ID" "$METADATA_REPOSITORY:previous"
fi

if [[ -f $APP_DIR/compose.yaml && ! -L $APP_DIR/compose.yaml ]]; then
  HAD_EXISTING_STACK=1
  COMPOSE_BACKUP=$APP_DIR/deploy-backups/compose-before-$RELEASE_ID.yaml
  cp -p -- "$APP_DIR/compose.yaml" "$COMPOSE_BACKUP"
fi
cp -p -- "$COMPOSE_CANDIDATE" "$APP_DIR/compose.yaml"
chmod 600 "$APP_DIR/compose.yaml" "$ENV_FILE"

compose() {
  docker compose --env-file "$ENV_FILE" -f "$APP_DIR/compose.yaml" "$@"
}

rollback_deployment() {
  local rollback_status=0
  ROLLBACK_ATTEMPTED=1
  set +e

  if [[ -f $APP_DIR/compose.yaml ]]; then
    compose logs --tail=100 >&2
    compose down --remove-orphans
  fi

  if ((HAD_EXISTING_STACK == 1)) && [[ -n $COMPOSE_BACKUP && -f $COMPOSE_BACKUP ]]; then
    cp -p -- "$COMPOSE_BACKUP" "$APP_DIR/compose.yaml" || rollback_status=1
  fi
  if ((ACTIVE_TAG_CHANGED == 1)) && [[ -n $PREVIOUS_IMAGE_ID ]]; then
    docker image tag "$PREVIOUS_IMAGE_ID" "$ACTIVE_IMAGE" || rollback_status=1
  fi
  if ((HAD_EXISTING_STACK == 1 && rollback_status == 0)); then
    compose up -d --no-build || rollback_status=1
  fi

  set -e
  return "$rollback_status"
}

docker image tag "$CANDIDATE_IMAGE_ID" "$ACTIVE_IMAGE"
ACTIVE_TAG_CHANGED=1

log "Starting the isolated Hardcover pilot"
compose up -d --no-build --remove-orphans

get_endpoint() {
  local service=$1
  local port=$2
  local endpoint
  endpoint=$(compose port "$service" "$port" 2>/dev/null | tail -n 1)
  [[ $endpoint =~ ^(127\.0\.0\.1|[0-9]{1,3}(\.[0-9]{1,3}){3}):[0-9]+$ ]] || return 1
  printf '%s' "$endpoint"
}

wait_for_http() {
  local url=$1
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECONDS ))
  while (( $(date +%s) < deadline )); do
    if curl -fsS --connect-timeout 3 --max-time 10 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 3
  done
  return 1
}

METADATA_ENDPOINT=$(get_endpoint metadata 8788) || die "Could not resolve the metadata diagnostic port."
EBOOK_ENDPOINT=$(get_endpoint ebook 8787) || die "Could not resolve the ebook pilot port."
AUDIOBOOK_ENDPOINT=$(get_endpoint audiobook 8787) || die "Could not resolve the audiobook pilot port."

wait_for_http "http://$METADATA_ENDPOINT/debug/metrics" || die "The local Hardcover metadata service did not become ready."
wait_for_http "http://$EBOOK_ENDPOINT/ping" || die "The ebook pilot did not become ready."
wait_for_http "http://$AUDIOBOOK_ENDPOINT/ping" || die "The audiobook pilot did not become ready."

if ((SKIP_LIVE_SEARCH == 0)); then
  SEARCH_RESULT=$STAGING_DIR/gardens-search.json
  curl -fsS --get \
    --connect-timeout 5 \
    --max-time 120 \
    --data-urlencode 'q=Gardens of the Moon' \
    "http://$METADATA_ENDPOINT/search" >"$SEARCH_RESULT" || die "The locally hosted Hardcover search failed."
  grep -Eqi 'Gardens[[:space:]]+of[[:space:]]+the[[:space:]]+Moon' "$SEARCH_RESULT" || die "Hardcover search responded but did not contain Gardens of the Moon."
fi

for service in ebook audiobook metadata postgres; do
  [[ $(compose ps --status running --services | grep -Fxc "$service") == 1 ]] || die "Pilot service '$service' is not running."
done

DEPLOYMENT_SUCCEEDED=1
log "Pilot release $RELEASE_ID is healthy"
printf '[hardcover-pilot] Ebook UI: http://%s\n' "$EBOOK_ENDPOINT"
printf '[hardcover-pilot] Audiobook UI: http://%s\n' "$AUDIOBOOK_ENDPOINT"
printf '[hardcover-pilot] Metadata diagnostics: http://%s/debug/metrics\n' "$METADATA_ENDPOINT"
printf '[hardcover-pilot] Metadata image: %s (%s)\n' "$CANDIDATE_IMAGE" "$CANDIDATE_IMAGE_ID"
printf '[hardcover-pilot] Live Readarr and Kindling were not modified.\n'
