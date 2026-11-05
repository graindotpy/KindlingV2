#!/bin/bash

set -Eeuo pipefail
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 077

ARCHIVE=""
EXPECTED_SHA256=""
RELEASE_ID=""
APP_DIR=""
SERVICE=""
IMAGE_REPOSITORY=""
HEALTH_TIMEOUT_SECONDS=""
ALLOW_UNHEALTHY_CURRENT=0
KEEP_UPLOAD=0

STAGING_DIR=""
SOURCE_DIR=""
LOCK_DIRECTORY=""
LOCK_KIND=""
ACTIVE_TAG_CHANGED=0
DEPLOYMENT_SUCCEEDED=0
ROLLBACK_ATTEMPTED=0
CURRENT_IMAGE_ID=""
CANDIDATE_IMAGE_ID=""
ROLLBACK_IMAGE=""
CANDIDATE_IMAGE=""
ACTIVE_IMAGE=""
DATABASE_BACKUP_CONTAINER=""
DATABASE_BACKUP_HOST=""
DATA_SOURCE=""
MIGRATIONS_CHANGED=0

log() {
  printf '\n[kindling] %s\n' "$*"
}

warn() {
  printf '[kindling] WARNING: %s\n' "$*" >&2
}

die() {
  printf '[kindling] ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: deploy-zimaos.sh --archive PATH --sha256 HASH --release ID \
  --app-dir PATH --service NAME --image-repository NAME \
  --health-timeout SECONDS [--allow-unhealthy-current] [--keep-upload]
EOF
}

while (($# > 0)); do
  case "$1" in
    --archive)
      (($# >= 2)) || die "--archive requires a value."
      ARCHIVE=$2
      shift 2
      ;;
    --sha256)
      (($# >= 2)) || die "--sha256 requires a value."
      EXPECTED_SHA256=$2
      shift 2
      ;;
    --release)
      (($# >= 2)) || die "--release requires a value."
      RELEASE_ID=$2
      shift 2
      ;;
    --app-dir)
      (($# >= 2)) || die "--app-dir requires a value."
      APP_DIR=$2
      shift 2
      ;;
    --service)
      (($# >= 2)) || die "--service requires a value."
      SERVICE=$2
      shift 2
      ;;
    --image-repository)
      (($# >= 2)) || die "--image-repository requires a value."
      IMAGE_REPOSITORY=$2
      shift 2
      ;;
    --health-timeout)
      (($# >= 2)) || die "--health-timeout requires a value."
      HEALTH_TIMEOUT_SECONDS=$2
      shift 2
      ;;
    --allow-unhealthy-current)
      ALLOW_UNHEALTHY_CURRENT=1
      shift
      ;;
    --keep-upload)
      KEEP_UPLOAD=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

[[ $(id -u) == 0 ]] || die "Run this helper through sudo."
[[ $0 =~ ^/tmp/kindling-deploy-[A-Za-z0-9._-]+\.sh$ && -f $0 && ! -L $0 ]] || die "Deployment helper must be a regular Kindling file directly below /tmp."
[[ $ARCHIVE =~ ^/tmp/kindling-deploy-[A-Za-z0-9._-]+\.tar\.gz$ ]] || die "Archive must be a Kindling deployment file directly below /tmp."
[[ -f $ARCHIVE && ! -L $ARCHIVE ]] || die "Deployment archive is missing or is not a regular file."
[[ $EXPECTED_SHA256 =~ ^[0-9a-fA-F]{64}$ ]] || die "Expected SHA-256 is invalid."
[[ $RELEASE_ID =~ ^[A-Za-z0-9][A-Za-z0-9._-]{5,80}$ ]] || die "Release identifier is invalid."
[[ $ARCHIVE == "/tmp/kindling-deploy-$RELEASE_ID.tar.gz" && $0 == "/tmp/kindling-deploy-$RELEASE_ID.sh" ]] || die "Uploaded filenames do not match the release identifier."
[[ $APP_DIR =~ ^/DATA/AppData/[A-Za-z0-9._/-]+$ ]] || die "App directory must be below /DATA/AppData."
[[ $APP_DIR != *//* && ! $APP_DIR =~ (^|/)\.\.?(/|$) ]] || die "App directory contains an unsafe path segment."
[[ $SERVICE =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die "Service name is invalid."
[[ $IMAGE_REPOSITORY =~ ^[a-z0-9][a-z0-9._/-]*$ ]] || die "Image repository is invalid."
[[ $IMAGE_REPOSITORY != *//* && ! $IMAGE_REPOSITORY =~ (^|/)\.\.?(/|$) ]] || die "Image repository contains an unsafe path segment."
[[ $HEALTH_TIMEOUT_SECONDS =~ ^[0-9]+$ ]] || die "Health timeout must be an integer."
((HEALTH_TIMEOUT_SECONDS >= 30 && HEALTH_TIMEOUT_SECONDS <= 600)) || die "Health timeout must be between 30 and 600 seconds."

for required_command in docker tar gzip sha256sum mktemp readlink grep awk date cp chmod rm sleep; do
  command -v "$required_command" >/dev/null 2>&1 || die "Required command '$required_command' is not installed."
done
[[ -x /bin/bash ]] || die "/bin/bash is required."

[[ ! -L $APP_DIR ]] || die "App directory must not be a symbolic link."
APP_DIR=$(readlink -f -- "$APP_DIR")
[[ $APP_DIR == /DATA/AppData/* && $APP_DIR != /DATA/AppData/ ]] || die "Resolved app directory is outside the permitted location."
[[ -d $APP_DIR && ! -L $APP_DIR ]] || die "App directory is missing or is a symbolic link."
[[ -f $APP_DIR/docker-compose.yml && ! -L $APP_DIR/docker-compose.yml ]] || die "Expected docker-compose.yml was not found."
[[ -f $APP_DIR/.env && ! -L $APP_DIR/.env ]] || die "Expected private .env file was not found."

cleanup() {
  local exit_status=$?
  trap - EXIT INT TERM

  if ((exit_status != 0 && ACTIVE_TAG_CHANGED == 1 && DEPLOYMENT_SUCCEEDED == 0 && ROLLBACK_ATTEMPTED == 0)); then
    warn "Deployment did not complete; starting automatic rollback."
    rollback_deployment || warn "Automatic rollback failed. Manual recovery is required."
  fi

  if [[ -n $STAGING_DIR ]]; then
    case "$STAGING_DIR" in
      /tmp/kindling-deploy.*)
        if [[ $STAGING_DIR != /tmp/kindling-deploy. && -d $STAGING_DIR ]]; then
          rm -rf -- "$STAGING_DIR"
        fi
        ;;
      *)
        warn "Refusing to remove unexpected staging path '$STAGING_DIR'."
        ;;
    esac
  fi

  if ((KEEP_UPLOAD == 0)); then
    rm -f -- "$ARCHIVE"
    case "$0" in
      /tmp/kindling-deploy-*.sh) rm -f -- "$0" ;;
      *) warn "Refusing to remove unexpected helper path '$0'." ;;
    esac
  fi

  if [[ $LOCK_KIND == directory && -n $LOCK_DIRECTORY ]]; then
    case "$LOCK_DIRECTORY" in
      /tmp/kindling-deploy.lock.*) rmdir -- "$LOCK_DIRECTORY" 2>/dev/null || true ;;
    esac
  fi

  exit "$exit_status"
}

trap cleanup EXIT
trap 'exit 130' INT TERM

if command -v flock >/dev/null 2>&1; then
  exec 9>/tmp/kindling-deploy.lock
  flock -n 9 || die "Another Kindling deployment is already running."
  LOCK_KIND=flock
else
  LOCK_DIRECTORY=/tmp/kindling-deploy.lock.d
  mkdir "$LOCK_DIRECTORY" 2>/dev/null || die "Another Kindling deployment is already running."
  LOCK_KIND=directory
fi

STAGING_DIR=$(mktemp -d /tmp/kindling-deploy.XXXXXX)
[[ $STAGING_DIR == /tmp/kindling-deploy.* && $STAGING_DIR != /tmp/kindling-deploy. ]] || die "Could not create a safe staging directory."
SOURCE_DIR=$STAGING_DIR/source
mkdir -m 700 "$SOURCE_DIR"
mkdir -m 700 "$STAGING_DIR/docker-config"
export DOCKER_CONFIG="$STAGING_DIR/docker-config"

log "Verifying release $RELEASE_ID"
ACTUAL_SHA256=$(sha256sum -- "$ARCHIVE" | awk '{print tolower($1)}')
[[ $ACTUAL_SHA256 == "${EXPECTED_SHA256,,}" ]] || die "Archive SHA-256 does not match the local package."
gzip -t -- "$ARCHIVE" || die "Archive compression check failed."

MANIFEST=$STAGING_DIR/archive-members.txt
VERBOSE_MANIFEST=$STAGING_DIR/archive-members-verbose.txt
tar -tzf "$ARCHIVE" >"$MANIFEST"
tar -tvzf "$ARCHIVE" >"$VERBOSE_MANIFEST"

while IFS= read -r raw_entry; do
  entry=${raw_entry#./}
  [[ -n $entry ]] || continue
  [[ $entry != /* && ! $entry =~ ^[A-Za-z]: ]] || die "Archive contains an absolute path: $entry"
  [[ $entry != *\\* && ! $entry =~ (^|/)\.\.(/|$) ]] || die "Archive contains an unsafe path: $entry"
  [[ ! $entry =~ [[:cntrl:]] ]] || die "Archive contains a control character in a path."

  top_level=${entry%%/*}
  case "$top_level" in
    .dockerignore|.env.example|.gitignore|Dockerfile|README.md|app|components|deploy|docs|lib|public|scripts|tests|docker-compose.yml|eslint.config.mjs|next.config.ts|package.json|package-lock.json|playwright.config.ts|tsconfig.json|vitest.config.ts)
      ;;
    *)
      die "Archive contains unexpected top-level entry: $top_level"
      ;;
  esac

  lower_entry=${entry,,}
  if [[ $lower_entry =~ (^|/)\.env($|\.) && $entry != .env.example ]]; then
    die "Archive contains a private environment file: $entry"
  fi
  if [[ $lower_entry =~ (^|/)(\.git|node_modules|\.next|dist|data|test-results|playwright-report)(/|$) ]]; then
    die "Archive contains local or generated data: $entry"
  fi
  if [[ $lower_entry =~ (\.db(-(wal|shm))?|\.sqlite(-(wal|shm))?|\.(pem|key|crt|cer|p12|pfx|jks|keystore))$ ]]; then
    die "Archive contains private data or a key file: $entry"
  fi
  if [[ $lower_entry =~ \.(tar|tar\.gz|tgz|zip)$ ]]; then
    die "Archive contains a nested archive: $entry"
  fi
done <"$MANIFEST"

while IFS= read -r verbose_entry; do
  case "${verbose_entry:0:1}" in
    -|d) ;;
    *) die "Archive contains a link or special file." ;;
  esac
done <"$VERBOSE_MANIFEST"

for required_member in Dockerfile package.json package-lock.json app/api/health/live/route.ts lib/readarr/service.ts scripts/healthcheck.mjs deploy/deploy-zimaos.sh; do
  grep -Fxq "$required_member" "$MANIFEST" || die "Archive is missing required member '$required_member'."
done

tar --extract --gzip --file "$ARCHIVE" --directory "$SOURCE_DIR" --no-same-owner --no-same-permissions
for required_file in Dockerfile package.json package-lock.json app/api/health/live/route.ts lib/readarr/service.ts scripts/healthcheck.mjs; do
  [[ -f $SOURCE_DIR/$required_file && ! -L $SOURCE_DIR/$required_file ]] || die "Extracted release is missing '$required_file'."
done
EXECUTED_HELPER_SHA256=$(sha256sum -- "$0" | awk '{print tolower($1)}')
ARCHIVED_HELPER_SHA256=$(sha256sum -- "$SOURCE_DIR/deploy/deploy-zimaos.sh" | awk '{print tolower($1)}')
[[ $EXECUTED_HELPER_SHA256 == "$ARCHIVED_HELPER_SHA256" ]] || die "Uploaded deployment helper does not match the verified source archive."

docker info >/dev/null 2>&1 || die "Docker is unavailable to the root deployment process."
mapfile -t compose_services < <(cd "$APP_DIR" && docker compose config --services)
printf '%s\n' "${compose_services[@]}" | grep -Fxq "$SERVICE" || die "Compose does not define service '$SERVICE'."
mapfile -t compose_images < <(cd "$APP_DIR" && docker compose config --images)
ACTIVE_IMAGE="$IMAGE_REPOSITORY:local"
[[ ${#compose_images[@]} == 1 && ${compose_images[0]} == "$ACTIVE_IMAGE" ]] || die "Compose must use exactly '$ACTIVE_IMAGE'."

docker inspect "$SERVICE" >/dev/null 2>&1 || die "Current Kindling container '$SERVICE' does not exist."
CURRENT_IMAGE_ID=$(docker inspect --format '{{.Image}}' "$SERVICE")
[[ $CURRENT_IMAGE_ID =~ ^sha256:[0-9a-f]{64}$ ]] || die "Could not resolve the running image ID."
CURRENT_RUNNING=$(docker inspect --format '{{.State.Running}}' "$SERVICE")
CURRENT_HEALTH=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$SERVICE")
if [[ $CURRENT_RUNNING != true || $CURRENT_HEALTH != healthy ]]; then
  if ((ALLOW_UNHEALTHY_CURRENT == 0)); then
    die "Current container is not healthy (state: $CURRENT_HEALTH). Use -AllowUnhealthyCurrent only for a deliberate recovery deployment."
  fi
  warn "Continuing from current container state '$CURRENT_HEALTH' because recovery mode was requested."
fi

DATA_SOURCE=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Source}}{{end}}{{end}}' "$SERVICE")
[[ -n $DATA_SOURCE ]] || die "Could not resolve the persistent /app/data mount."
DATA_SOURCE=$(readlink -f -- "$DATA_SOURCE")
[[ $DATA_SOURCE == /DATA/* && $DATA_SOURCE != /DATA/ && -d $DATA_SOURCE ]] || die "Resolved data source is outside /DATA."

CANDIDATE_IMAGE="$IMAGE_REPOSITORY:release-$RELEASE_ID"
ROLLBACK_IMAGE="$IMAGE_REPOSITORY:rollback-$RELEASE_ID"

log "Building candidate image $CANDIDATE_IMAGE"
docker build \
  --label "co.grainserver.kindling.release=$RELEASE_ID" \
  --label "co.grainserver.kindling.source-sha256=${EXPECTED_SHA256,,}" \
  --tag "$CANDIDATE_IMAGE" \
  "$SOURCE_DIR"
CANDIDATE_IMAGE_ID=$(docker image inspect --format '{{.Id}}' "$CANDIDATE_IMAGE")
[[ $CANDIDATE_IMAGE_ID =~ ^sha256:[0-9a-f]{64}$ ]] || die "Could not resolve the candidate image ID."

migration_fingerprint() {
  docker run --rm --entrypoint /bin/sh "$1" -c \
    'find /app/lib/db/migrations -maxdepth 1 -type f -print0 2>/dev/null | sort -z | xargs -0 -r sha256sum' \
    | sha256sum | awk '{print $1}'
}

CURRENT_MIGRATIONS=$(migration_fingerprint "$CURRENT_IMAGE_ID")
CANDIDATE_MIGRATIONS=$(migration_fingerprint "$CANDIDATE_IMAGE_ID")
if [[ $CURRENT_MIGRATIONS != "$CANDIDATE_MIGRATIONS" ]]; then
  MIGRATIONS_CHANGED=1
  warn "This release changes database migrations; rollback will restore the pre-deployment database backup."
fi

log "Backing up the live database and private environment"
DATABASE_BACKUP_CONTAINER="/app/data/backups/pre-deploy-$RELEASE_ID.db"
DATABASE_BACKUP_HOST="$DATA_SOURCE/backups/pre-deploy-$RELEASE_ID.db"
docker exec "$SERVICE" node dist/backup.cjs "$DATABASE_BACKUP_CONTAINER"
[[ -s $DATABASE_BACKUP_HOST ]] || die "Database backup was not created at the expected persistent location."
docker exec "$SERVICE" node -e \
  "const Database=require('better-sqlite3');const db=new Database(process.argv[1],{readonly:true,fileMustExist:true});const result=db.pragma('integrity_check',{simple:true});db.close();if(result!=='ok')throw new Error('Backup integrity check failed: '+result);" \
  "$DATABASE_BACKUP_CONTAINER"

ENV_BACKUP_DIRECTORY=$APP_DIR/deploy-backups
ENV_BACKUP_PATH=$ENV_BACKUP_DIRECTORY/env-pre-deploy-$RELEASE_ID
mkdir -p -- "$ENV_BACKUP_DIRECTORY"
chmod 700 -- "$ENV_BACKUP_DIRECTORY"
[[ ! -e $ENV_BACKUP_PATH ]] || die "Environment backup already exists for this release."
cp -p -- "$APP_DIR/.env" "$ENV_BACKUP_PATH"
chmod 600 -- "$ENV_BACKUP_PATH"

docker image tag "$CURRENT_IMAGE_ID" "$ROLLBACK_IMAGE"
docker image tag "$CURRENT_IMAGE_ID" "$IMAGE_REPOSITORY:previous"

wait_for_health() {
  local expected_image_id=$1
  local timeout_seconds=$2
  local deadline=$(( $(date +%s) + timeout_seconds ))
  local actual_image_id=""
  local running=""
  local health=""

  while (( $(date +%s) < deadline )); do
    if docker inspect "$SERVICE" >/dev/null 2>&1; then
      actual_image_id=$(docker inspect --format '{{.Image}}' "$SERVICE" 2>/dev/null || true)
      running=$(docker inspect --format '{{.State.Running}}' "$SERVICE" 2>/dev/null || true)
      health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$SERVICE" 2>/dev/null || true)
      if [[ $actual_image_id == "$expected_image_id" && $running == true && $health == healthy ]]; then
        if docker exec "$SERVICE" node scripts/healthcheck.mjs >/dev/null 2>&1; then
          return 0
        fi
      fi
    fi
    sleep 2
  done

  warn "Health deadline expired (running=${running:-missing}, health=${health:-missing}, image=${actual_image_id:-missing})."
  return 1
}

restore_database_backup() {
  local failure_directory=$DATA_SOURCE/deploy-failures/$RELEASE_ID
  local restore_temporary=$DATA_SOURCE/.kindling.db.restore-$RELEASE_ID

  log "Restoring the pre-deployment database for rollback"
  docker stop --time 45 "$SERVICE" >/dev/null 2>&1 || true
  mkdir -p -- "$failure_directory" || return 1
  chmod 700 -- "$failure_directory" || return 1
  for database_file in kindling.db kindling.db-wal kindling.db-shm; do
    if [[ -e $DATA_SOURCE/$database_file ]]; then
      cp -p -- "$DATA_SOURCE/$database_file" "$failure_directory/$database_file" || return 1
    fi
  done
  cp -p -- "$DATABASE_BACKUP_HOST" "$restore_temporary" || return 1
  mv -f -- "$restore_temporary" "$DATA_SOURCE/kindling.db" || return 1
  rm -f -- "$DATA_SOURCE/kindling.db-wal" "$DATA_SOURCE/kindling.db-shm" || return 1
}

rollback_deployment() {
  local rollback_status=0
  ROLLBACK_ATTEMPTED=1
  set +e

  docker logs --tail=120 "$SERVICE" >&2
  if ! docker image tag "$CURRENT_IMAGE_ID" "$ACTIVE_IMAGE"; then
    warn "Could not restore the active image tag."
    rollback_status=1
  fi

  if ((rollback_status == 0 && MIGRATIONS_CHANGED == 1)); then
    if ! restore_database_backup; then
      warn "Could not restore the pre-deployment database."
      rollback_status=1
    fi
  fi

  if ((rollback_status == 0)); then
    if ! (cd "$APP_DIR" && docker compose up -d --no-build --force-recreate "$SERVICE"); then
      warn "Compose could not recreate the previous image."
      rollback_status=1
    fi
  fi
  if ((rollback_status == 0)) && ! wait_for_health "$CURRENT_IMAGE_ID" "$HEALTH_TIMEOUT_SECONDS"; then
    if ((MIGRATIONS_CHANGED == 0)); then
      warn "Image rollback was not healthy; retrying after restoring the database backup."
      if restore_database_backup && \
          (cd "$APP_DIR" && docker compose up -d --no-build --force-recreate "$SERVICE") && \
          wait_for_health "$CURRENT_IMAGE_ID" "$HEALTH_TIMEOUT_SECONDS"; then
        rollback_status=0
      else
        rollback_status=1
      fi
    else
      rollback_status=1
    fi
  fi

  if ((rollback_status == 0)); then
    warn "Previous image restored successfully. Failed-release database files, if any, are under $DATA_SOURCE/deploy-failures/$RELEASE_ID."
  else
    warn "Previous image did not recover. Database backup: $DATABASE_BACKUP_HOST"
  fi
  set -e
  return "$rollback_status"
}

log "Activating candidate image"
ACTIVE_TAG_CHANGED=1
docker image tag "$CANDIDATE_IMAGE_ID" "$ACTIVE_IMAGE"
(cd "$APP_DIR" && docker compose up -d --no-build --force-recreate "$SERVICE")
wait_for_health "$CANDIDATE_IMAGE_ID" "$HEALTH_TIMEOUT_SECONDS" || die "Candidate did not become healthy before the deadline."

DEPLOYMENT_SUCCEEDED=1
log "Release $RELEASE_ID is healthy"
printf '[kindling] Active image: %s (%s)\n' "$CANDIDATE_IMAGE" "$CANDIDATE_IMAGE_ID"
printf '[kindling] Rollback image: %s (%s)\n' "$ROLLBACK_IMAGE" "$CURRENT_IMAGE_ID"
printf '[kindling] Database backup: %s\n' "$DATABASE_BACKUP_HOST"
printf '[kindling] Environment backup: %s\n' "$ENV_BACKUP_PATH"
