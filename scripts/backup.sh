#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BACKUP_DIR="${BACKUP_DIR:-${APP_DIR}/backups}"
INCLUDE_ENV="${INCLUDE_ENV:-1}"

log() {
  printf '\033[1;36m[backup]\033[0m %s\n' "$*"
}

fail() {
  printf '\033[1;31m[backup:error]\033[0m %s\n' "$*" >&2
  exit 1
}

load_env() {
  if [ -f "${APP_DIR}/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "${APP_DIR}/.env"
    set +a
  fi
  [ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL is missing. Set it or create ${APP_DIR}/.env"
}

main() {
  load_env
  command -v pg_dump >/dev/null 2>&1 || fail "pg_dump is not installed"
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"

  local stamp
  local db_file
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  db_file="${BACKUP_DIR}/capi-db-${stamp}.dump"

  log "Writing database backup to ${db_file}"
  pg_dump "$DATABASE_URL" --format=custom --no-owner --no-privileges --file="$db_file"
  chmod 600 "$db_file"

  if [ "$INCLUDE_ENV" = "1" ] && [ -f "${APP_DIR}/.env" ]; then
    local env_file="${BACKUP_DIR}/capi-env-${stamp}.env"
    log "Writing encrypted-token key backup to ${env_file}"
    cp "${APP_DIR}/.env" "$env_file"
    chmod 600 "$env_file"
  fi

  log "Backup complete"
}

main "$@"
