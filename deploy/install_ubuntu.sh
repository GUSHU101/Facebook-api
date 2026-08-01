#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="${APP_NAME:-capi-saas}"
APP_DIR="${APP_DIR:-/www/wwwroot/${APP_NAME}}"
APP_USER="${APP_USER:-capi-saas}"
APP_HOME="${APP_HOME:-/var/lib/${APP_NAME}}"
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
INGEST_TOKEN_SECRET="${INGEST_TOKEN_SECRET:-}"
FB_API_VERSION="${FB_API_VERSION:-v26.0}"
META_PARTNER_AGENT="${META_PARTNER_AGENT:-}"
META_QUALITY_AGENT_NAME="${META_QUALITY_AGENT_NAME:-}"
SKIP_APT="${SKIP_APT:-0}"
CERT_FULLCHAIN="${CERT_FULLCHAIN:-}"
CERT_KEY="${CERT_KEY:-}"
ENABLE_UFW="${ENABLE_UFW:-1}"
AUTO_ENABLE_NGINX="${AUTO_ENABLE_NGINX:-1}"
AUTO_SSL="${AUTO_SSL:-0}"
ACME_DNS_PROVIDER="${ACME_DNS_PROVIDER:-}"
ACME_EMAIL="${ACME_EMAIL:-}"
REDIRECT_HTTP="${REDIRECT_HTTP:-1}"
FORCE_ENV_REWRITE="${FORCE_ENV_REWRITE:-0}"
SHOPIFY_WEB_ORDER_SOURCES="${SHOPIFY_WEB_ORDER_SOURCES:-web}"
SHOPIFY_APP_SECRET="${SHOPIFY_APP_SECRET:-}"
CORS_ORIGIN="${CORS_ORIGIN:-*}"
DB_POOL_MAX="${DB_POOL_MAX:-20}"
API_INSTANCES="${API_INSTANCES:-1}"
WORKER_INSTANCES="${WORKER_INSTANCES:-1}"

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

run_as_app() {
  runuser -u "$APP_USER" -- env HOME="$APP_HOME" "$@"
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

validate_positive_integer() {
  local name="$1"
  local value="$2"
  if ! printf '%s' "$value" | grep -Eq '^[0-9]+$' || [ "$value" -lt 1 ]; then
    fail "${name} must be a positive integer"
  fi
}

validate_bool() {
  local name="$1"
  local value="$2"
  if [ "$value" != "0" ] && [ "$value" != "1" ]; then
    fail "${name} must be 0 or 1"
  fi
}

validate_dotenv_value() {
  local name="$1"
  local value="$2"
  if printf '%s' "$value" | grep -Eq "[[:space:]#'\"]"; then
    fail "${name} must not contain whitespace, #, or quote characters"
  fi
}

validate_slug() {
  local name="$1"
  local value="$2"
  if ! printf '%s' "$value" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]*$'; then
    fail "${name} contains unsafe characters: ${value}"
  fi
}

validate_linux_user() {
  if ! printf '%s' "$APP_USER" | grep -Eq '^[a-z_][a-z0-9_-]{0,31}$'; then
    fail "APP_USER must be a valid lowercase Linux system user name"
  fi
}

validate_branch() {
  if ! printf '%s' "$BRANCH" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._/-]*$' \
    || printf '%s' "$BRANCH" | grep -Eq '(\.\.|//|(^|/)\.|/$)'; then
    fail "BRANCH contains unsafe Git ref characters: ${BRANCH}"
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

validate_app_dir() {
  case "$APP_DIR" in
    /*) ;;
    *) fail "APP_DIR must be an absolute path" ;;
  esac
  case "$APP_DIR" in
    /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var|/www|/www/wwwroot)
      fail "Refusing unsafe APP_DIR target: ${APP_DIR}"
      ;;
  esac
  if printf '%s' "$APP_DIR" | grep -Eq '(^|/)\.\.(/|$)'; then
    fail "APP_DIR must not contain parent-directory traversal"
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

  # BullMQ metadata must never be evicted under memory pressure. PostgreSQL is
  # still the durable event source, but noeviction avoids avoidable queue churn.
  if command_exists redis-cli && redis-cli ping >/dev/null 2>&1; then
    redis-cli CONFIG SET maxmemory-policy noeviction >/dev/null
    redis-cli CONFIG REWRITE >/dev/null || true
  fi
}

ensure_app_user() {
  if ! id "$APP_USER" >/dev/null 2>&1; then
    log "Creating restricted application user ${APP_USER}"
    useradd --system --home-dir "$APP_HOME" --create-home --shell /usr/sbin/nologin "$APP_USER"
  fi
  install -d -o "$APP_USER" -g "$APP_USER" -m 0750 "$APP_HOME"
  install -d -o "$APP_USER" -g "$APP_USER" -m 0750 "$APP_DIR"
  # Existing Baota/manual installations may be root-owned. The validated
  # application path is transferred before the non-root backup/git workflow.
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
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
    if [ -f "$APP_DIR/.env" ] && [ -f "$APP_DIR/scripts/backup.sh" ]; then
      log "Creating a pre-upgrade database and environment backup"
      (cd "$APP_DIR" && run_as_app bash scripts/backup.sh)
    fi
    run_as_app git -C "$APP_DIR" fetch origin "$BRANCH"
    run_as_app git -C "$APP_DIR" checkout "$BRANCH"
    run_as_app git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
  else
    log "Cloning repository to $APP_DIR"
    mkdir -p "$(dirname "$APP_DIR")"
    if [ -e "$APP_DIR" ] && [ -n "$(find "$APP_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
      fail "APP_DIR exists and is not an empty Git repository: ${APP_DIR}"
    fi
    run_as_app git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  fi
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
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
ALTER DATABASE ${DB_NAME} OWNER TO ${DB_USER};
GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};
\\connect ${DB_NAME}

ALTER SCHEMA public OWNER TO ${DB_USER};
GRANT USAGE, CREATE ON SCHEMA public TO ${DB_USER};

DO \$ownership\$
DECLARE
  object_record record;
BEGIN
  FOR object_record IN
    SELECT schemaname, tablename
    FROM pg_tables
    WHERE schemaname = 'public'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I OWNER TO %I',
      object_record.schemaname,
      object_record.tablename,
      '${DB_USER}'
    );
  END LOOP;

  FOR object_record IN
    SELECT schemaname, sequencename
    FROM pg_sequences
    WHERE schemaname = 'public'
  LOOP
    EXECUTE format(
      'ALTER SEQUENCE %I.%I OWNER TO %I',
      object_record.schemaname,
      object_record.sequencename,
      '${DB_USER}'
    );
  END LOOP;
END
\$ownership\$;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${DB_USER};
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${DB_USER};

ALTER DEFAULT PRIVILEGES FOR ROLE ${DB_USER} IN SCHEMA public
  GRANT ALL PRIVILEGES ON TABLES TO ${DB_USER};
ALTER DEFAULT PRIVILEGES FOR ROLE ${DB_USER} IN SCHEMA public
  GRANT ALL PRIVILEGES ON SEQUENCES TO ${DB_USER};
SQL
}

write_env() {
  ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(random_secret)}"
  AES_SECRET_KEY="${AES_SECRET_KEY:-$(random_secret)}"
  INGEST_TOKEN_SECRET="${INGEST_TOKEN_SECRET:-$(random_secret)}"

  log "Writing new .env"
  cat > "$APP_DIR/.env" <<ENV
PORT=${INTERNAL_PORT}
PUBLIC_BASE_URL=https://${DOMAIN}:${PUBLIC_PORT}
DATABASE_URL=postgres://${DB_USER}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}
REDIS_URL=${REDIS_URL}

FB_API_VERSION=${FB_API_VERSION}
META_PARTNER_AGENT=${META_PARTNER_AGENT}
META_QUALITY_AGENT_NAME=${META_QUALITY_AGENT_NAME}
AES_SECRET_KEY=${AES_SECRET_KEY}
INGEST_TOKEN_SECRET=${INGEST_TOKEN_SECRET}

ADMIN_USERNAME=${ADMIN_USERNAME}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
REQUIRE_INGEST_TOKEN=true
ALLOW_SHARED_FACEBOOK_DATASET_ROUTES=true
REQUIRE_WORKER_HEARTBEAT=true
WORKER_HEARTBEAT_TTL_SECONDS=45
SHOPIFY_WEB_ORDER_SOURCES=${SHOPIFY_WEB_ORDER_SOURCES}
SHOPIFY_APP_SECRET=${SHOPIFY_APP_SECRET}
SHOPIFY_API_VERSION=2026-07
SHOPIFY_RECONCILE_CRON="23 */15 * * * *"
SHOPIFY_RECONCILE_LOOKBACK_HOURS=144
SHOPIFY_RECONCILE_MAX_ORDERS=1000
TEST_EVENT_CODE_TTL_MINUTES=30

CORS_ORIGIN=${CORS_ORIGIN}
TRUST_PROXY_HOPS=1
JSON_LIMIT=1mb
COMMERCE_ITEM_LIMIT=1000
HTTP_REQUEST_TIMEOUT_MS=30000
HTTP_HEADERS_TIMEOUT_MS=15000
HTTP_KEEP_ALIVE_TIMEOUT_MS=5000
SHUTDOWN_TIMEOUT_MS=120000
DB_POOL_MAX=${DB_POOL_MAX}
DB_IDLE_TIMEOUT_MS=30000
DB_CONNECTION_TIMEOUT_MS=10000
DB_STATEMENT_TIMEOUT_MS=30000
DB_POOL_MAX_USES=7500
BATCH_SIZE=1000
LEGACY_REDIS_DRAIN_ENABLED=false
WORKER_EVENT_BATCH_SIZE=100
QUEUE_ATTEMPTS=5
QUEUE_BACKOFF_MS=5000
# Generous per-shop/per-IP abuse ceiling; use 0 only behind a distributed WAF.
PIXEL_RATE_LIMIT_PER_MINUTE=600
ADMIN_RATE_LIMIT_PER_WINDOW=100
SHOPIFY_WEBHOOK_INBOX_CRON="*/5 * * * * *"
SHOPIFY_WEBHOOK_INBOX_BATCH_SIZE=200
SHOPIFY_WEBHOOK_INBOX_MAX_ATTEMPTS=20
SHOPIFY_WEBHOOK_INBOX_LEASE_SECONDS=60
SHOPIFY_WEBHOOK_PROCESS_TIMEOUT_MS=45000
SHOPIFY_PRIVACY_CRON="11 */1 * * * *"
SHOPIFY_PRIVACY_BATCH_SIZE=50
SHOPIFY_PRIVACY_MAX_ATTEMPTS=20
SHOPIFY_PRIVACY_LEASE_SECONDS=120
SHOPIFY_PRIVACY_RETENTION_DAYS=30
FB_REQUEST_TIMEOUT_MS=15000
FACEBOOK_BATCH_SIZE=100
FACEBOOK_ISOLATION_MAX_REQUESTS=16
TIKTOK_MAX_EVENT_AGE_SECONDS=604800
WORKER_CONCURRENCY=20
WORKER_RATE_LIMIT_MAX=100
WORKER_RATE_LIMIT_DURATION_MS=1000
PLATFORM_REQUESTS_PER_SECOND_PER_CREDENTIAL=20
DELIVERY_RETRY_BASE_SECONDS=5
DELIVERY_RETRY_MAX_SECONDS=900
DELIVERY_RETRY_AFTER_MAX_SECONDS=86400
# Retry transient failures until event-age validation expires them.
DELIVERY_MAX_ATTEMPTS=0
CREDENTIAL_LEASE_MS=60000
CREDENTIAL_BUSY_DELAY_SECONDS=2
SHOP_CONTINUATION_DELAY_MS=500
DELIVERY_RESCUE_MINUTES=1
DELIVERY_RESCUE_SHOP_LIMIT=500
AGGREGATE_RECONCILE_BATCH_SIZE=5000
PURCHASE_SETTLE_MS=8000
CLEANUP_CRON="17 * * * *"
CLEANUP_BATCH_SIZE=10000
CLEANUP_MAX_BATCHES=2
EVENT_RETENTION_DAYS=90
DEAD_LETTER_RETENTION_DAYS=90
ALIAS_RETENTION_DAYS=120
QUALITY_RETENTION_DAYS=30
BACKUP_RETENTION_DAYS=30
API_INSTANCES=${API_INSTANCES}
WORKER_INSTANCES=${WORKER_INSTANCES}
ENV

  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
}

configure_database_and_env() {
  if [ -f "$APP_DIR/.env" ] && [ "$FORCE_ENV_REWRITE" != "1" ]; then
    log "Preserving existing .env and database credentials"
    return
  fi

  if [ -f "$APP_DIR/.env" ] && [ "$FORCE_ENV_REWRITE" = "1" ]; then
    [ -n "$DB_PASSWORD" ] || fail "DB_PASSWORD is required when FORCE_ENV_REWRITE=1"
    [ -n "$ADMIN_PASSWORD" ] || fail "ADMIN_PASSWORD is required when FORCE_ENV_REWRITE=1"
    [ -n "$AES_SECRET_KEY" ] || fail "AES_SECRET_KEY is required when FORCE_ENV_REWRITE=1"
    [ -n "$INGEST_TOKEN_SECRET" ] || fail "INGEST_TOKEN_SECRET is required when FORCE_ENV_REWRITE=1"
  fi

  [ -z "$AES_SECRET_KEY" ] || [ "${#AES_SECRET_KEY}" -ge 32 ] || fail "AES_SECRET_KEY must contain at least 32 characters"
  [ -z "$INGEST_TOKEN_SECRET" ] || [ "${#INGEST_TOKEN_SECRET}" -ge 32 ] || fail "INGEST_TOKEN_SECRET must contain at least 32 characters"
  validate_dotenv_value ADMIN_USERNAME "$ADMIN_USERNAME"
  validate_dotenv_value ADMIN_PASSWORD "$ADMIN_PASSWORD"
  validate_dotenv_value AES_SECRET_KEY "$AES_SECRET_KEY"
  validate_dotenv_value INGEST_TOKEN_SECRET "$INGEST_TOKEN_SECRET"
  validate_dotenv_value REDIS_URL "$REDIS_URL"
  validate_dotenv_value CORS_ORIGIN "$CORS_ORIGIN"
  validate_dotenv_value SHOPIFY_WEB_ORDER_SOURCES "$SHOPIFY_WEB_ORDER_SOURCES"
  validate_dotenv_value SHOPIFY_APP_SECRET "$SHOPIFY_APP_SECRET"
  if ! printf '%s' "$SHOPIFY_WEB_ORDER_SOURCES" | grep -Eq '^[A-Za-z0-9._-]+(,[A-Za-z0-9._-]+)*$'; then
    fail "SHOPIFY_WEB_ORDER_SOURCES must be a comma-separated source_name allowlist"
  fi

  setup_database
  write_env
}

install_app() {
  log "Installing Node dependencies"
  cd "$APP_DIR"
  run_as_app npm ci --omit=dev
  run_as_app npm run check

  log "Initializing/migrating database"
  run_as_app npm run migrate
  run_as_app npm run doctor
}

setup_pm2() {
  log "Starting PM2 processes"
  cd "$APP_DIR"
  run_as_app pm2 startOrReload ecosystem.config.js --update-env
  run_as_app pm2 save
  pm2 startup systemd -u "$APP_USER" --hp "$APP_HOME" >/tmp/${APP_NAME}-pm2-startup.log 2>&1 || true
}

verify_runtime() {
  log "Waiting for API health checks"
  local attempt
  for attempt in $(seq 1 30); do
    if curl -fsS --max-time 5 "http://127.0.0.1:${INTERNAL_PORT}/healthz" >/dev/null \
      && curl -fsS --max-time 5 "http://127.0.0.1:${INTERNAL_PORT}/readyz" >/dev/null; then
      log "API health and readiness checks passed"
      return
    fi
    sleep 2
  done
  run_as_app pm2 status || true
  run_as_app pm2 logs capi-api --lines 50 --nostream || true
  fail "API did not become ready on 127.0.0.1:${INTERNAL_PORT}"
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
    server_tokens off;

    ssl_certificate     ${cert_fullchain};
    ssl_certificate_key ${cert_key};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    client_max_body_size 2m;

    location ~* /(\.git|\.svn|\.hg|\.github|node_modules|backups|\.npm|\.cache)/ {
        return 404;
    }

    location ~* (\.env.*|package(-lock)?\.json|.*\.sql(\.gz)?|.*\.log|.*\.bak|.*\.old|.*\.tmp)$ {
        return 404;
    }

    location / {
        proxy_pass http://127.0.0.1:${INTERNAL_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host \$http_host;
        proxy_set_header X-Forwarded-Port ${PUBLIC_PORT};
        proxy_set_header Connection "";
        proxy_connect_timeout 10s;
        proxy_send_timeout 35s;
        proxy_read_timeout 35s;
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
Runtime user:  ${APP_USER}
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
   This is required: browser Purchase candidates remain AWAITING_PAYMENT until the verified webhook confirms payment.

Useful commands:
sudo -u ${APP_USER} env HOME=${APP_HOME} pm2 status
sudo -u ${APP_USER} env HOME=${APP_HOME} pm2 logs capi-api
sudo -u ${APP_USER} env HOME=${APP_HOME} pm2 logs capi-worker
sudo -u ${APP_USER} env HOME=${APP_HOME} npm --prefix ${APP_DIR} run doctor

SUMMARY
}

main() {
  need_root
  detect_ubuntu
  validate_slug APP_NAME "$APP_NAME"
  validate_linux_user
  validate_branch
  validate_app_dir
  validate_port INTERNAL_PORT "$INTERNAL_PORT"
  validate_port PUBLIC_PORT "$PUBLIC_PORT"
  [ "$INTERNAL_PORT" != "$PUBLIC_PORT" ] || fail "INTERNAL_PORT and PUBLIC_PORT must be different"
  validate_positive_integer DB_POOL_MAX "$DB_POOL_MAX"
  validate_positive_integer API_INSTANCES "$API_INSTANCES"
  validate_positive_integer WORKER_INSTANCES "$WORKER_INSTANCES"
  [ "$DB_POOL_MAX" -le 200 ] || fail "DB_POOL_MAX must not exceed the application limit of 200"
  validate_bool SKIP_APT "$SKIP_APT"
  validate_bool ENABLE_UFW "$ENABLE_UFW"
  validate_bool AUTO_ENABLE_NGINX "$AUTO_ENABLE_NGINX"
  validate_bool AUTO_SSL "$AUTO_SSL"
  validate_bool REDIRECT_HTTP "$REDIRECT_HTTP"
  validate_bool FORCE_ENV_REWRITE "$FORCE_ENV_REWRITE"
  validate_domain
  install_apt_deps
  ensure_app_user
  open_firewall_port
  clone_or_update_repo
  configure_database_and_env
  install_app
  setup_pm2
  verify_runtime
  issue_ssl_certificate
  write_nginx_hint
  print_summary
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
