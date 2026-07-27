#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
TEMPLATE_PATH="${TEMPLATE_PATH:-${SCRIPT_DIR}/baota-nginx-non443.conf.template}"

DOMAIN="${DOMAIN:-}"
BT_SITE_NAME="${BT_SITE_NAME:-}"
PROJECT_DIR="${PROJECT_DIR:-}"
PUBLIC_PORT="${PUBLIC_PORT:-8443}"
INTERNAL_PORT="${INTERNAL_PORT:-3000}"
INSTALL_WATCHER="${INSTALL_WATCHER:-0}"
VHOST_FILE="${VHOST_FILE:-/www/server/panel/vhost/nginx/${BT_SITE_NAME}.conf}"
BACKUP_DIR="${BACKUP_DIR:-/www/backup/capi-nginx-vhosts}"

log() {
  printf '[baota-nginx] %s\n' "$*"
}

fail() {
  printf '[baota-nginx:error] %s\n' "$*" >&2
  exit 1
}

validate_port() {
  local name="$1"
  local value="$2"
  if ! [[ "$value" =~ ^[0-9]+$ ]] || [ "$value" -lt 1 ] || [ "$value" -gt 65535 ]; then
    fail "${name} must be an integer between 1 and 65535"
  fi
}

if [ "$(id -u)" -ne 0 ]; then
  fail "run as root (sudo env ... bash deploy/configure_baota_nginx.sh)"
fi

[[ "$DOMAIN" =~ ^([A-Za-z0-9-]+\.)+[A-Za-z]{2,}$ ]] || fail "DOMAIN is invalid"
[[ "$BT_SITE_NAME" =~ ^[A-Za-z0-9_-]+$ ]] || fail "BT_SITE_NAME is invalid"
[[ "$PROJECT_DIR" =~ ^/www/wwwroot/[A-Za-z0-9._/-]+$ ]] \
  || fail "PROJECT_DIR must be a safe absolute directory below /www/wwwroot"
if printf '%s' "$PROJECT_DIR" | grep -Eq '(^|/)\.\.(/|$)'; then
  fail "PROJECT_DIR must not contain parent-directory traversal"
fi
validate_port PUBLIC_PORT "$PUBLIC_PORT"
validate_port INTERNAL_PORT "$INTERNAL_PORT"
[ "$PUBLIC_PORT" != "$INTERNAL_PORT" ] || fail "PUBLIC_PORT and INTERNAL_PORT must differ"
[ "$INSTALL_WATCHER" = "0" ] || [ "$INSTALL_WATCHER" = "1" ] || fail "INSTALL_WATCHER must be 0 or 1"
[ -f "$TEMPLATE_PATH" ] || fail "template not found: ${TEMPLATE_PATH}"

expected_vhost_file="/www/server/panel/vhost/nginx/${BT_SITE_NAME}.conf"
[ "$VHOST_FILE" = "$expected_vhost_file" ] \
  || fail "VHOST_FILE must be ${expected_vhost_file}"
[[ "$BACKUP_DIR" =~ ^/www/backup/[A-Za-z0-9._/-]+$ ]] \
  || fail "BACKUP_DIR must be a safe directory below /www/backup"
if printf '%s' "$BACKUP_DIR" | grep -Eq '(^|/)\.\.(/|$)'; then
  fail "BACKUP_DIR must not contain parent-directory traversal"
fi

certificate_dir="/www/server/panel/vhost/cert/${BT_SITE_NAME}"
[ -s "${certificate_dir}/fullchain.pem" ] || fail "SSL certificate not found: ${certificate_dir}/fullchain.pem"
[ -s "${certificate_dir}/privkey.pem" ] || fail "SSL private key not found: ${certificate_dir}/privkey.pem"

# This is deliberately pinned to Baota's Nginx. Using `nginx` from PATH or a
# generic systemd Nginx service can target Ubuntu's separate installation and
# make two masters compete for ports 80/443.
NGINX_BIN="${NGINX_BIN:-/www/server/nginx/sbin/nginx}"
NGINX_PID_FILE="${NGINX_PID_FILE:-/www/server/nginx/logs/nginx.pid}"
[ -x "$NGINX_BIN" ] || fail "Baota nginx executable was not found: ${NGINX_BIN}"
[ -s "$NGINX_PID_FILE" ] || fail "Baota nginx is not running (missing PID file: ${NGINX_PID_FILE}); start Nginx in Baota first"

nginx_master_pid="$(tr -d '[:space:]' < "$NGINX_PID_FILE")"
[[ "$nginx_master_pid" =~ ^[0-9]+$ ]] || fail "invalid Baota nginx PID in ${NGINX_PID_FILE}"
kill -0 "$nginx_master_pid" 2>/dev/null \
  || fail "Baota nginx master PID ${nginx_master_pid} is not running; start Nginx in Baota first"

nginx_master_exe="$(readlink -f "/proc/${nginx_master_pid}/exe" 2>/dev/null || true)"
expected_nginx_exe="$(readlink -f "$NGINX_BIN")"
[ "$nginx_master_exe" = "$expected_nginx_exe" ] \
  || fail "PID ${nginx_master_pid} is not Baota nginx (${nginx_master_exe:-unknown}); resolve duplicate Nginx installations before continuing"

unit_slug="$(printf '%s' "$BT_SITE_NAME" | tr '[:upper:]_' '[:lower:]-')"
service_name="capi-baota-nginx-${unit_slug}.service"
path_name="capi-baota-nginx-${unit_slug}.path"
failure_state="/run/capi-baota-nginx-${unit_slug}.failed.sha256"
watch_mode="${WATCH_MODE:-0}"

if [ "$watch_mode" = "1" ] && [ -f "$failure_state" ]; then
  current_state="missing"
  if [ -f "$VHOST_FILE" ]; then
    current_state="$(sha256sum "$VHOST_FILE" | awk '{print $1}')"
  fi
  if [ "$current_state" = "$(cat "$failure_state")" ]; then
    log "leaving the last known-good configuration in place after a failed validation; waiting for the next Baota change"
    exit 0
  fi
  rm -f -- "$failure_state"
fi

install -d -m 0755 "$(dirname "$VHOST_FILE")"
install -d -m 0755 "/www/server/panel/vhost/nginx/extension/${BT_SITE_NAME}"
install -d -m 0755 "/www/server/panel/vhost/nginx/well-known"
if [ ! -e "/www/server/panel/vhost/nginx/well-known/${BT_SITE_NAME}.conf" ]; then
  install -m 0644 /dev/null "/www/server/panel/vhost/nginx/well-known/${BT_SITE_NAME}.conf"
fi

rendered_file="$(mktemp "${VHOST_FILE}.candidate.XXXXXX")"
cleanup() {
  rm -f -- "$rendered_file"
}
trap cleanup EXIT

sed \
  -e "s|__DOMAIN__|${DOMAIN}|g" \
  -e "s|__PROJECT_DIR__|${PROJECT_DIR}|g" \
  -e "s|__BT_SITE_NAME__|${BT_SITE_NAME}|g" \
  -e "s|__PUBLIC_PORT__|${PUBLIC_PORT}|g" \
  -e "s|__INTERNAL_PORT__|${INTERNAL_PORT}|g" \
  "$TEMPLATE_PATH" > "$rendered_file"

changed=0
backup_file=""
if ! [ -f "$VHOST_FILE" ] || ! cmp -s "$rendered_file" "$VHOST_FILE"; then
  install -d -m 0700 "$BACKUP_DIR"
  if [ -f "$VHOST_FILE" ]; then
    backup_file="${BACKUP_DIR}/${BT_SITE_NAME}.$(date -u +%Y%m%dT%H%M%SZ).${BASHPID}.conf"
    cp -a -- "$VHOST_FILE" "$backup_file"
    log "backed up the previous vhost to ${backup_file}"
  fi

  install -m 0644 "$rendered_file" "$VHOST_FILE"
  if ! "$NGINX_BIN" -t; then
    if [ -n "$backup_file" ]; then
      install -m 0644 "$backup_file" "$VHOST_FILE"
    else
      rm -f -- "$VHOST_FILE"
    fi
    if [ "$watch_mode" = "1" ]; then
      restored_state="missing"
      if [ -f "$VHOST_FILE" ]; then
        restored_state="$(sha256sum "$VHOST_FILE" | awk '{print $1}')"
      fi
      printf '%s\n' "$restored_state" > "$failure_state"
    fi
    fail "nginx validation failed; restored the previous vhost configuration"
  fi

  rm -f -- "$failure_state"
  # Signal the already-running Baota master directly. Never ask systemd to
  # locate an ambiguous service named `nginx` on a Baota host.
  kill -HUP "$nginx_master_pid"
  changed=1
fi

if [ "$INSTALL_WATCHER" = "1" ]; then
  command -v systemctl >/dev/null 2>&1 || fail "systemctl is required to install the automatic watcher"

  cat > "/etc/systemd/system/${service_name}" <<UNIT
[Unit]
Description=Restore ${DOMAIN}:${PUBLIC_PORT} Baota Nginx configuration
After=network.target

[Service]
Type=oneshot
Environment=DOMAIN=${DOMAIN}
Environment=BT_SITE_NAME=${BT_SITE_NAME}
Environment=PROJECT_DIR=${PROJECT_DIR}
Environment=PUBLIC_PORT=${PUBLIC_PORT}
Environment=INTERNAL_PORT=${INTERNAL_PORT}
Environment=VHOST_FILE=${VHOST_FILE}
Environment=WATCH_MODE=1
ExecStart=/bin/bash ${SCRIPT_PATH}
UNIT

  cat > "/etc/systemd/system/${path_name}" <<UNIT
[Unit]
Description=Watch Baota vhost changes for ${DOMAIN}

[Path]
PathChanged=${VHOST_FILE}
Unit=${service_name}

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable --now "$path_name"
  log "installed automatic watcher ${path_name}"
fi

if [ "$changed" = "1" ]; then
  log "active HTTPS endpoint: https://${DOMAIN}:${PUBLIC_PORT} -> http://127.0.0.1:${INTERNAL_PORT}"
else
  log "vhost already matches the required ${PUBLIC_PORT} configuration"
fi
