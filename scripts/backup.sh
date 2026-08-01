#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BACKUP_DIR="${BACKUP_DIR:-${APP_DIR}/backups}"
INCLUDE_ENV="${INCLUDE_ENV:-1}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
DB_TMP=""
ENV_TMP=""

# shellcheck source=./dotenv.sh
. "${APP_DIR}/scripts/dotenv.sh"

log() {
  printf '\033[1;36m[backup]\033[0m %s\n' "$*"
}

fail() {
  printf '\033[1;31m[backup:error]\033[0m %s\n' "$*" >&2
  exit 1
}

cleanup_partial_files() {
  local partial_file
  for partial_file in "$DB_TMP" "$ENV_TMP"; do
    if [ -n "$partial_file" ]; then
      rm -f -- "$partial_file" || true
    fi
  done
}

load_env() {
  load_dotenv_file "${APP_DIR}/.env"
  [ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL is missing. Set it or create ${APP_DIR}/.env"
}

prune_old_backups() {
  [[ "$BACKUP_RETENTION_DAYS" =~ ^[0-9]+$ ]] || fail "BACKUP_RETENTION_DAYS must be a non-negative integer"
  [ "$BACKUP_RETENTION_DAYS" -gt 0 ] || return 0
  [ -n "$BACKUP_DIR" ] && [ "$BACKUP_DIR" != "/" ] || fail "Refusing unsafe BACKUP_DIR: ${BACKUP_DIR}"
  find "$BACKUP_DIR" -maxdepth 1 -type f \
    \( -name 'capi-db-*.dump' -o -name 'capi-env-*.env' \) \
    -mtime "+$BACKUP_RETENTION_DAYS" -delete
}

main() {
  load_env
  command -v pg_dump >/dev/null 2>&1 || fail "pg_dump is not installed"
  command -v pg_restore >/dev/null 2>&1 || fail "pg_restore is not installed"
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"

  local stamp
  local backup_id
  local db_file
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_id="${stamp}-${BASHPID}"
  db_file="${BACKUP_DIR}/capi-db-${backup_id}.dump"
  DB_TMP="${db_file}.tmp.$$"

  log "Writing database backup to ${db_file}"
  pg_dump "$DATABASE_URL" --format=custom --no-owner --no-privileges --file="$DB_TMP"
  # Never publish a partial dump under the normal backup filename. Listing the
  # archive also catches a truncated or structurally invalid custom-format dump
  # before an operator relies on it for rollback.
  pg_restore --list "$DB_TMP" >/dev/null
  chmod 600 "$DB_TMP"
  mv -f -- "$DB_TMP" "$db_file"
  DB_TMP=""

  if [ "$INCLUDE_ENV" = "1" ] && [ -f "${APP_DIR}/.env" ]; then
    local env_file="${BACKUP_DIR}/capi-env-${backup_id}.env"
    ENV_TMP="${env_file}.tmp.$$"
    log "Writing encrypted-token key backup to ${env_file}"
    cp "${APP_DIR}/.env" "$ENV_TMP"
    chmod 600 "$ENV_TMP"
    mv -f -- "$ENV_TMP" "$env_file"
    ENV_TMP=""
  fi

  prune_old_backups

  log "Backup complete"
}

trap cleanup_partial_files EXIT
main "$@"
