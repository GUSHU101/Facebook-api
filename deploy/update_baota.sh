#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
WORKER_NAME="${WORKER_NAME:-capi-worker}"

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

if ! command -v node >/dev/null 2>&1; then
  baota_node_bin="$(find /www/server/nodejs -mindepth 3 -maxdepth 3 -type f -path '*/bin/node' -printf '%h\n' 2>/dev/null \
    | sort -V \
    | tail -n 1)"
  if [ -n "$baota_node_bin" ] && [ -x "${baota_node_bin}/node" ]; then
    export PATH="${baota_node_bin}:${PATH}"
  fi
fi

command -v node >/dev/null 2>&1 || fail "Node.js was not found; install/select Node.js 20+ in Baota"
command -v npm >/dev/null 2>&1 || fail "npm was not found beside the selected Baota Node.js runtime"
node_major="$(node -p 'Number(process.versions.node.split(`.`)[0])')"
[ "$node_major" -ge 20 ] || fail "Node.js 20 or newer is required"

log "using Node.js $(node --version) from $(command -v node)"
log "using npm $(npm --version) from $(command -v npm)"

worker_was_present=0
if command -v pm2 >/dev/null 2>&1 && pm2 describe "$WORKER_NAME" >/dev/null 2>&1; then
  worker_was_present=1
  log "stopping ${WORKER_NAME} during dependency replacement and migration"
  pm2 stop "$WORKER_NAME" >/dev/null
fi

cd "$APP_DIR"
export NODE_ENV=production

log "installing locked production dependencies"
npm ci --omit=dev

log "checking JavaScript syntax"
npm run check

log "repairing PostgreSQL ownership idempotently"
bash scripts/repair-db-ownership.sh

log "applying database migrations"
npm run migrate

log "running production diagnostics"
npm run doctor

command -v pm2 >/dev/null 2>&1 || fail "PM2 was not found; install PM2 in Baota before starting the worker"
if [ "$worker_was_present" = "1" ]; then
  log "restarting existing ${WORKER_NAME}"
  pm2 restart "$WORKER_NAME" --update-env
else
  log "creating ${WORKER_NAME}"
  pm2 start "${APP_DIR}/src/worker.js" --name "$WORKER_NAME" --cwd "$APP_DIR"
fi
if command -v systemctl >/dev/null 2>&1 && [ ! -e /etc/systemd/system/pm2-root.service ]; then
  log "installing PM2 root startup service for the worker"
  pm2 startup systemd -u root --hp /root >/dev/null \
    || log "warning: PM2 startup service was not installed; run pm2 startup manually"
fi
pm2 save

log "update completed successfully"
log "restart the API project once in Baota, then check http://127.0.0.1:3000/readyz"
