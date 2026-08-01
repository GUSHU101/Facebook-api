#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
WORKER_NAME="${WORKER_NAME:-capi-worker}"
MAINTENANCE_FILE="${MAINTENANCE_FILE:-${APP_DIR}/.maintenance}"

log() {
  printf '[baota-update] %s\n' "$*"
}

fail() {
  printf '[baota-update:error] %s\n' "$*" >&2
  exit 1
}

if [ "$(id -u)" -ne 0 ]; then
  fail "run as root: sudo bash deploy/update_baota.sh"
fi

case "$APP_DIR" in
  /www/wwwroot/*) ;;
  *) fail "APP_DIR must be below /www/wwwroot" ;;
esac
[ -f "${APP_DIR}/package.json" ] || fail "package.json not found in ${APP_DIR}"
[ -f "${APP_DIR}/package-lock.json" ] || fail "package-lock.json not found in ${APP_DIR}"
[ -f "${APP_DIR}/.env" ] || fail ".env not found in ${APP_DIR}"

APP_USER="$(stat -c '%U' "$APP_DIR")"
[ -n "$APP_USER" ] || fail "could not determine the project owner"
APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"
[ -n "$APP_HOME" ] || APP_HOME="$APP_DIR"

if ! command -v node >/dev/null 2>&1; then
  baota_node_bin="$(find /www/server/nodejs -mindepth 3 -maxdepth 3 -type f -path '*/bin/node' -printf '%h\n' 2>/dev/null \
    | sort -V \
    | tail -n 1)"
  if [ -n "$baota_node_bin" ] && [ -x "${baota_node_bin}/node" ]; then
    export PATH="${baota_node_bin}:${PATH}"
  fi
fi
if ! command -v pg_dump >/dev/null 2>&1; then
  pg_bin="$(find /www/server/pgsql /usr/lib/postgresql -type f -name pg_dump -printf '%h\n' 2>/dev/null \
    | sort -V \
    | tail -n 1)"
  if [ -n "$pg_bin" ]; then export PATH="${pg_bin}:${PATH}"; fi
fi

command -v node >/dev/null 2>&1 || fail "Node.js was not found; install/select Node.js 20+ in Baota"
command -v npm >/dev/null 2>&1 || fail "npm was not found beside the selected Baota Node.js runtime"
command -v pg_dump >/dev/null 2>&1 || fail "pg_dump was not found; install/select PostgreSQL before updating"
command -v pm2 >/dev/null 2>&1 || fail "PM2 was not found; install PM2 before updating"
node_major="$(node -p 'Number(process.versions.node.split(`.`)[0])')"
[ "$node_major" -ge 20 ] || fail "Node.js 20 or newer is required"

run_as_app() {
  if [ "$APP_USER" = "root" ]; then
    env HOME="$APP_HOME" PATH="$PATH" NODE_ENV=production "$@"
  else
    runuser -u "$APP_USER" -- env HOME="$APP_HOME" PATH="$PATH" NODE_ENV=production "$@"
  fi
}

owner_worker_was_present=0
legacy_root_worker_was_present=0

on_error() {
  local status="$?"
  trap - ERR
  printf '[baota-update:error] update failed at line %s; maintenance mode remains enabled\n' "${BASH_LINENO[0]:-unknown}" >&2
  if [ "$owner_worker_was_present" = "1" ]; then
    run_as_app pm2 restart "$WORKER_NAME" --update-env >/dev/null 2>&1 \
      || printf '[baota-update:error] could not restore %s for user %s\n' "$WORKER_NAME" "$APP_USER" >&2
  elif [ "$legacy_root_worker_was_present" = "1" ]; then
    pm2 restart "$WORKER_NAME" --update-env >/dev/null 2>&1 \
      || printf '[baota-update:error] could not restore legacy root %s\n' "$WORKER_NAME" >&2
  fi
  printf '[baota-update:error] fix the first error, rerun this script, and do not remove %s manually\n' "$MAINTENANCE_FILE" >&2
  exit "$status"
}
trap on_error ERR

cd "$APP_DIR"
log "using Node.js $(node --version), npm $(npm --version), project owner ${APP_USER}"

log "creating a pre-update database and environment snapshot"
run_as_app bash scripts/backup.sh

install -m 600 /dev/null "$MAINTENANCE_FILE"
chown "$APP_USER":"$(stat -c '%G' "$APP_DIR")" "$MAINTENANCE_FILE"
log "maintenance mode enabled"

if run_as_app pm2 describe "$WORKER_NAME" >/dev/null 2>&1; then
  owner_worker_was_present=1
  log "stopping ${WORKER_NAME} for project owner ${APP_USER}"
  run_as_app pm2 stop "$WORKER_NAME" >/dev/null
fi
if [ "$APP_USER" != "root" ] && pm2 describe "$WORKER_NAME" >/dev/null 2>&1; then
  legacy_root_worker_was_present=1
  log "stopping legacy root-owned ${WORKER_NAME} to prevent duplicate delivery"
  pm2 stop "$WORKER_NAME" >/dev/null
fi

log "installing locked production dependencies as ${APP_USER}"
run_as_app npm ci --omit=dev

log "checking JavaScript syntax"
run_as_app npm run check

log "repairing PostgreSQL ownership idempotently"
bash scripts/repair-db-ownership.sh

log "applying database migrations"
run_as_app npm run migrate

log "running production diagnostics"
run_as_app npm run doctor

if [ "$owner_worker_was_present" = "1" ]; then
  log "restarting existing ${WORKER_NAME}"
  run_as_app pm2 restart "$WORKER_NAME" --update-env
else
  log "creating ${WORKER_NAME} for ${APP_USER}"
  run_as_app pm2 start "${APP_DIR}/src/worker.js" --name "$WORKER_NAME" --cwd "$APP_DIR"
fi
run_as_app pm2 describe "$WORKER_NAME" >/dev/null
run_as_app pm2 save

if [ "$legacy_root_worker_was_present" = "1" ]; then
  pm2 delete "$WORKER_NAME" >/dev/null || true
  pm2 save >/dev/null || true
fi

if command -v systemctl >/dev/null 2>&1 && [ ! -e "/etc/systemd/system/pm2-${APP_USER}.service" ]; then
  log "installing PM2 startup service for ${APP_USER}"
  pm2 startup systemd -u "$APP_USER" --hp "$APP_HOME" >/dev/null \
    || log "warning: PM2 startup service was not installed; run pm2 startup manually"
  run_as_app pm2 save
fi

rm -f -- "$MAINTENANCE_FILE"
trap - ERR
log "update completed successfully"
log "restart the Baota-managed API once, then verify /healthz and /readyz"
