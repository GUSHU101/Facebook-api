#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="${APP_NAME:-capi-saas}"
APP_DIR="${APP_DIR:-/www/wwwroot/${APP_NAME}}"
REPO_URL="${REPO_URL:-}"
BRANCH="${BRANCH:-main}"
INTERNAL_PORT="${INTERNAL_PORT:-3000}"
PUBLIC_PORT="${PUBLIC_PORT:-8443}"
DOMAIN="${DOMAIN:-}"
DB_NAME="${DB_NAME:-capi_saas}"
DB_USER="${DB_USER:-capi_user}"
DB_PASSWORD="${DB_PASSWORD:-}"
REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
AES_SECRET_KEY="${AES_SECRET_KEY:-}"
FB_API_VERSION="${FB_API_VERSION:-v24.0}"
SKIP_APT="${SKIP_APT:-0}"
CERT_FULLCHAIN="${CERT_FULLCHAIN:-}"
CERT_KEY="${CERT_KEY:-}"
ENABLE_UFW="${ENABLE_UFW:-1}"
AUTO_ENABLE_NGINX="${AUTO_ENABLE_NGINX:-1}"
AUTO_SSL="${AUTO_SSL:-0}"
ACME_DNS_PROVIDER="${ACME_DNS_PROVIDER:-}"
ACME_EMAIL="${ACME_EMAIL:-}"
REDIRECT_HTTP="${REDIRECT_HTTP:-1}"

log() {
  printf '\033[1;36m[deploy]\033[0m %s\n' "$*"
}

fail() {
  printf '\033[1;31m[deploy:error]\033[0m %s\n' "$*" >&2
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    fail "Please run as root: sudo bash deploy/install_ubuntu.sh"
  fi
}

validate_identifier() {
  local name="$1"
  local value="$2"
  if ! printf '%s' "$value" | grep -Eq '^[A-Za-z_][A-Za-z0-9_]*$'; then
    fail "${name} must contain only letters, numbers and underscores, and cannot start with a number"
  fi
}

validate_port() {
  local name="$1"
  local value="$2"
  if ! printf '%s' "$value" | grep -Eq '^[0-9]+$' || [ "$value" -lt 1 ] || [ "$value" -gt 65535 ]; then
    fail "${name} must be an integer between 1 and 65535"
  fi
}

validate_domain() {
  if [ -z "$DOMAIN" ]; then
    return
  fi
  if ! printf '%s' "$DOMAIN" | grep -Eq '^([A-Za-z0-9-]+\.)+[A-Za-z]{2,}$'; then
    fail "DOMAIN must be a valid hostname, got: ${DOMAIN}"
  fi
}

detect_ubuntu() {
  if [ ! -r /etc/os-release ]; then
    fail "Cannot detect OS. This installer supports Ubuntu only."
  fi
  . /etc/os-release
  if [ "${ID:-}" != "ubuntu" ]; then
    fail "This installer supports Ubuntu only. Detected: ${PRETTY_NAME:-unknown}"
  fi
  log "Detected ${PRETTY_NAME}"
}

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    date +%s%N | sha256sum | awk '{print $1}'
  fi
}

sql_literal() {
  printf "%s" "$1" | sed "s/'/''/g"
}

apt_install_missing() {
  local missing=()
  local pkg
  for pkg in "$@"; do
    if ! dpkg -s "$pkg" >/dev/null 2>&1; then
      missing+=("$pkg")
    fi
  done

  if [ "${#missing[@]}" -gt 0 ]; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}"
  fi
}

ensure_service_started() {
  local service="$1"
  if systemctl list-unit-files "${service}.service" >/dev/null 2>&1; then
    systemctl enable --now "$service" || true
  fi
}

install_apt_deps() {
  if [ "$SKIP_APT" = "1" ]; then
    log "Skipping apt dependency installation because SKIP_APT=1"
    return
  fi

  log "Installing Ubuntu dependencies when missing"
  apt-get update
  apt_install_missing ca-certificates curl git build-essential openssl socat postgresql postgresql-contrib redis-server nginx

  if ! command_exists node || [ "$(node -p 'Number(process.versions.node.split(`.`)[0])' 2>/dev/null || echo 0)" -lt 20 ]; then
    log "Installing Node.js 20"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  fi

  if ! command_exists pm2; then
    log "Installing PM2"
    npm install -g pm2
  fi

  ensure_service_started postgresql
  ensure_service_started redis-server
  ensure_service_started redis
  ensure_service_started nginx
}

open_firewall_port() {
  if [ "$ENABLE_UFW" != "1" ]; then
    log "Skipping UFW configuration because ENABLE_UFW=${ENABLE_UFW}"
    return
  fi

  if command_exists ufw; then
    local status
    status="$(ufw status | head -n 1 || true)"
    if printf '%s' "$status" | grep -qi active; then
      log "Opening UFW port ${PUBLIC_PORT}/tcp"
      ufw allow "${PUBLIC_PORT}/tcp" || true
      if [ "$REDIRECT_HTTP" = "1" ]; then
        log "Opening UFW port 80/tcp for HTTP to HTTPS redirect"
        ufw allow "80/tcp" || true
      fi
    else
      log "UFW is installed but inactive; skipping firewall rule"
    fi
  fi
}

issue_ssl_certificate() {
  if [ "$AUTO_SSL" != "1" ]; then
    return
  fi

  [ -n "$DOMAIN" ] || fail "DOMAIN is required when AUTO_SSL=1"
  [ -n "$ACME_DNS_PROVIDER" ] || fail "ACME_DNS_PROVIDER is required when AUTO_SSL=1 because this installer avoids port 443 and uses DNS-01 validation"

  CERT_FULLCHAIN="${CERT_FULLCHAIN:-/etc/ssl/${APP_NAME}/${DOMAIN}.fullchain.pem}"
  CERT_KEY="${CERT_KEY:-/etc/ssl/${APP_NAME}/${DOMAIN}.key.pem}"
  ACME_EMAIL="${ACME_EMAIL:-admin@${DOMAIN}}"

  if [ -f "$CERT_FULLCHAIN" ] && [ -f "$CERT_KEY" ]; then
    log "SSL certificate already exists"
    return
  fi

  log "Installing acme.sh when missing"
  if [ ! -x "$HOME/.acme.sh/acme.sh" ]; then
    curl -fsSL https://get.acme.sh | sh -s email="$ACME_EMAIL"
  fi

  mkdir -p "$(dirname "$CERT_FULLCHAIN")"

  log "Issuing SSL certificate for ${DOMAIN} with DNS provider ${ACME_DNS_PROVIDER}"
  "$HOME/.acme.sh/acme.sh" --set-default-ca --server letsencrypt
  "$HOME/.acme.sh/acme.sh" --issue --dns "$ACME_DNS_PROVIDER" -d "$DOMAIN" --keylength ec-256
  "$HOME/.acme.sh/acme.sh" --install-cert -d "$DOMAIN" --ecc \
    --fullchain-file "$CERT_FULLCHAIN" \
    --key-file "$CERT_KEY" \
    --reloadcmd "systemctl reload nginx"
}

clone_or_update_repo() {
  [ -n "$REPO_URL" ] || fail "REPO_URL is required, for example REPO_URL=https://github.com/yourname/Facebook-api.git"

  if [ -d "$APP_DIR/.git" ]; then
    log "Updating existing repository in $APP_DIR"
    git -C "$APP_DIR" fetch origin "$BRANCH"
    git -C "$APP_DIR" checkout "$BRANCH"
    git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
  else
    log "Cloning repository to $APP_DIR"
    mkdir -p "$(dirname "$APP_DIR")"
    rm -rf "$APP_DIR"
    git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  fi
}

setup_database() {
  DB_PASSWORD="${DB_PASSWORD:-$(random_secret)}"
  validate_identifier DB_NAME "$DB_NAME"
  validate_identifier DB_USER "$DB_USER"
  if ! printf '%s' "$DB_PASSWORD" | grep -Eq '^[A-Za-z0-9._~-]+$'; then
    fail "DB_PASSWORD contains URL-special characters. Use letters, numbers, dot, underscore, tilde or hyphen."
  fi
  local escaped_db_password
  escaped_db_password="$(sql_literal "$DB_PASSWORD")"

  log "Creating PostgreSQL database/user when missing"
  runuser -u postgres -- psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE USER ${DB_USER} WITH PASSWORD '${escaped_db_password}';
  ELSE
    ALTER USER ${DB_USER} WITH PASSWORD '${escaped_db_password}';
  END IF;
END
\$\$;

SELECT 'CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${DB_NAME}')\\gexec
GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};
SQL
}

write_env() {
  ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(random_secret)}"
  AES_SECRET_KEY="${AES_SECRET_KEY:-$(random_secret)}"

  log "Writing .env"
  cat > "$APP_DIR/.env" <<ENV
PORT=${INTERNAL_PORT}
DATABASE_URL=postgres://${DB_USER}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}
REDIS_URL=${REDIS_URL}

FB_API_VERSION=${FB_API_VERSION}
AES_SECRET_KEY=${AES_SECRET_KEY}

ADMIN_USERNAME=${ADMIN_USERNAME}
ADMIN_PASSWORD=${ADMIN_PASSWORD}

CORS_ORIGIN=*
TRUST_PROXY_HOPS=1
JSON_LIMIT=1mb
BATCH_SIZE=1000
QUEUE_ATTEMPTS=5
QUEUE_BACKOFF_MS=5000
PIXEL_RATE_LIMIT_PER_MINUTE=200
ADMIN_RATE_LIMIT_PER_WINDOW=100
FB_REQUEST_TIMEOUT_MS=15000
WORKER_CONCURRENCY=20
WORKER_RATE_LIMIT_MAX=100
WORKER_RATE_LIMIT_DURATION_MS=1000
PURCHASE_SETTLE_MS=8000
ENV

  chmod 600 "$APP_DIR/.env"
}

install_app() {
  log "Installing Node dependencies"
  cd "$APP_DIR"
  npm install --omit=dev
  npm run check

  log "Initializing/migrating database"
  npm run migrate
  npm run doctor
}

setup_pm2() {
  log "Starting PM2 processes"
  cd "$APP_DIR"
  pm2 startOrReload ecosystem.config.js --update-env
  pm2 save
  pm2 startup systemd -u root --hp /root >/tmp/${APP_NAME}-pm2-startup.log 2>&1 || true
}

write_nginx_hint() {
  local server_name="_"
  if [ -n "$DOMAIN" ]; then
    server_name="$DOMAIN"
  fi

  local conf_path="/etc/nginx/conf.d/${APP_NAME}-${PUBLIC_PORT}.conf.example"
  local active_conf_path="/etc/nginx/conf.d/${APP_NAME}.conf"
  local target_conf_path="$conf_path"
  local cert_fullchain="/path/to/fullchain.pem"
  local cert_key="/path/to/privkey.pem"

  if [ -n "$CERT_FULLCHAIN" ] && [ -n "$CERT_KEY" ]; then
    if [ ! -f "$CERT_FULLCHAIN" ]; then
      fail "CERT_FULLCHAIN does not exist: $CERT_FULLCHAIN"
    fi
    if [ ! -f "$CERT_KEY" ]; then
      fail "CERT_KEY does not exist: $CERT_KEY"
    fi
    cert_fullchain="$CERT_FULLCHAIN"
    cert_key="$CERT_KEY"
    if [ "$AUTO_ENABLE_NGINX" = "1" ]; then
      target_conf_path="$active_conf_path"
      log "Writing active non-443 Nginx config to $target_conf_path"
    fi
  else
    log "Writing non-443 Nginx config example to $conf_path"
  fi

  cat > "$conf_path" <<NGINX
# Copy this file to /etc/nginx/conf.d/${APP_NAME}.conf after adding real SSL certificate paths.
# This project intentionally avoids public 443 and uses ${PUBLIC_PORT}.
server {
    listen ${PUBLIC_PORT} ssl http2;
    server_name ${server_name};

    ssl_certificate     ${cert_fullchain};
    ssl_certificate_key ${cert_key};

    location / {
        proxy_pass http://127.0.0.1:${INTERNAL_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX

  if [ "$REDIRECT_HTTP" = "1" ] && [ "$server_name" != "_" ]; then
    cat >> "$conf_path" <<NGINX

server {
    listen 80;
    server_name ${server_name};
    return 301 https://\$host:${PUBLIC_PORT}\$request_uri;
}
NGINX
  fi

  if [ "$target_conf_path" != "$conf_path" ]; then
    cp "$conf_path" "$target_conf_path"
    nginx -t
    systemctl reload nginx || true
  fi
}

print_summary() {
  local admin_url="http://127.0.0.1:${INTERNAL_PORT}/admin"
  if [ -n "$DOMAIN" ]; then
    admin_url="https://${DOMAIN}:${PUBLIC_PORT}/admin"
  fi

  cat <<SUMMARY

Deployment complete.

App directory: ${APP_DIR}
Internal API:  http://127.0.0.1:${INTERNAL_PORT}
Admin URL:     ${admin_url}
Username:      ${ADMIN_USERNAME}
Password:      ${ADMIN_PASSWORD}

Next steps:
1. Open firewall/security-group port ${PUBLIC_PORT}.
2. Add a real SSL certificate with DNS validation.
3. Copy /etc/nginx/conf.d/${APP_NAME}-${PUBLIC_PORT}.conf.example to an active Nginx conf and set certificate paths.
4. Paste the generated Shopify custom pixel code from the admin panel.
5. Configure Shopify orders/paid webhook to https://YOUR_DOMAIN:${PUBLIC_PORT}/api/webhook/orders/paid.

Useful commands:
pm2 status
pm2 logs capi-api
pm2 logs capi-worker
cd ${APP_DIR} && npm run doctor

SUMMARY
}

main() {
  need_root
  detect_ubuntu
  validate_port INTERNAL_PORT "$INTERNAL_PORT"
  validate_port PUBLIC_PORT "$PUBLIC_PORT"
  validate_domain
  install_apt_deps
  open_firewall_port
  clone_or_update_repo
  setup_database
  write_env
  install_app
  setup_pm2
  issue_ssl_certificate
  write_nginx_hint
  print_summary
}

main "$@"
