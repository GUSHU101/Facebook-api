#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BACKUP_FILE="${1:-${BACKUP_FILE:-}}"
CONFIRM="${CONFIRM:-}"

log() {
  printf '\033[1;36m[restore]\033[0m %s\n' "$*"
}

fail() {
  printf '\033[1;31m[restore:error]\033[0m %s\n' "$*" >&2
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
  [ -n "$BACKUP_FILE" ] || fail "Usage: CONFIRM=RESTORE bash scripts/restore.sh /path/to/capi-db.dump"
  [ -f "$BACKUP_FILE" ] || fail "Backup file does not exist: ${BACKUP_FILE}"
  [ "$CONFIRM" = "RESTORE" ] || fail "Set CONFIRM=RESTORE to restore. This will overwrite database objects."

  load_env
  command -v pg_restore >/dev/null 2>&1 || fail "pg_restore is not installed"

  log "Restoring ${BACKUP_FILE}"
  pg_restore "$BACKUP_FILE" \
    --dbname="$DATABASE_URL" \
    --clean \
    --if-exists \
    --no-owner \
    --no-privileges

  log "Restore complete. Run npm run migrate and npm run doctor next."
}

main "$@"
