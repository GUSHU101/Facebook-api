#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BACKUP_FILE="${1:-${BACKUP_FILE:-}}"
CONFIRM="${CONFIRM:-}"
MAINTENANCE_FILE="${MAINTENANCE_FILE:-${APP_DIR}/.maintenance}"
RESTORE_DRAIN_SECONDS="${RESTORE_DRAIN_SECONDS:-35}"
API_WAS_STOPPED=0
WORKER_WAS_STOPPED=0
PM2_USER="${PM2_USER:-$(stat -c '%U' "$APP_DIR" 2>/dev/null || id -un)}"
PM2_USER_HOME="${PM2_USER_HOME:-$(getent passwd "$PM2_USER" 2>/dev/null | cut -d: -f6)}"

# shellcheck source=./dotenv.sh
. "${APP_DIR}/scripts/dotenv.sh"

log() {
  printf '\033[1;36m[restore]\033[0m %s\n' "$*"
}

fail() {
  printf '\033[1;31m[restore:error]\033[0m %s\n' "$*" >&2
  exit 1
}

load_env() {
  load_dotenv_file "${APP_DIR}/.env"
  [ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL is missing. Set it or create ${APP_DIR}/.env"
}

as_runtime_user() {
  if [ "$(id -un)" = "$PM2_USER" ]; then
    env HOME="${PM2_USER_HOME:-$HOME}" "$@"
  elif [ "$(id -u)" -eq 0 ]; then
    runuser -u "$PM2_USER" -- env HOME="${PM2_USER_HOME:-/var/lib/capi-saas}" "$@"
  else
    return 1
  fi
}

pm2_as_runtime_user() {
  as_runtime_user pm2 "$@"
}

stop_runtime() {
  umask 077
  printf 'database restore in progress\n' > "$MAINTENANCE_FILE"
  local visible_runtime=0
  if command -v pm2 >/dev/null 2>&1; then
    local process_name
    for process_name in capi-api capi-worker; do
      if pm2_as_runtime_user describe "$process_name" >/dev/null 2>&1; then
        visible_runtime=1
        log "Stopping ${process_name} before destructive restore"
        pm2_as_runtime_user stop "$process_name" >/dev/null
        if [ "$process_name" = "capi-api" ]; then
          API_WAS_STOPPED=1
        else
          WORKER_WAS_STOPPED=1
        fi
      fi
    done
  fi
  if [ "$visible_runtime" = "1" ]; then
    log "All visible PM2 runtime processes are stopped"
  else
    log "PM2 runtime not visible; waiting ${RESTORE_DRAIN_SECONDS}s for maintenance mode to drain requests"
    sleep "$RESTORE_DRAIN_SECONDS"
  fi
}

restart_runtime() {
  if [ "$API_WAS_STOPPED" = "1" ]; then
    log "Restarting the previously running API"
    pm2_as_runtime_user restart capi-api --update-env >/dev/null
  fi
  if [ "$WORKER_WAS_STOPPED" = "1" ]; then
    log "Restarting the previously running Worker"
    pm2_as_runtime_user restart capi-worker --update-env >/dev/null
  fi
  rm -f -- "$MAINTENANCE_FILE"
}

handle_restore_exit() {
  local status="$?"
  if [ "$status" -ne 0 ]; then
    log "Restore, validation, or runtime restart failed; runtime remains stopped and maintenance mode stays enabled"
  fi
  return "$status"
}

main() {
  [ -n "$BACKUP_FILE" ] || fail "Usage: CONFIRM=RESTORE bash scripts/restore.sh /path/to/capi-db.dump"
  [ -f "$BACKUP_FILE" ] || fail "Backup file does not exist: ${BACKUP_FILE}"
  [ "$CONFIRM" = "RESTORE" ] || fail "Set CONFIRM=RESTORE to restore. This will overwrite database objects."

  load_env
  command -v pg_restore >/dev/null 2>&1 || fail "pg_restore is not installed"

  log "Validating backup archive before entering maintenance mode"
  pg_restore --list "$BACKUP_FILE" >/dev/null

  trap handle_restore_exit EXIT
  trap 'exit 130' INT TERM
  stop_runtime

  log "Restoring ${BACKUP_FILE}"
  pg_restore "$BACKUP_FILE" \
    --dbname="$DATABASE_URL" \
    --clean \
    --if-exists \
    --single-transaction \
    --no-owner \
    --no-privileges

  log "Running schema migration and recovery validation"
  (cd "$APP_DIR" && as_runtime_user npm run migrate && as_runtime_user npm run doctor)
  restart_runtime
  trap - INT TERM
  log "Restore complete and runtime validation passed"
}

main "$@"
