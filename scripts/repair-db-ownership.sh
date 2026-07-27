#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

if [ "$(id -u)" -ne 0 ]; then
  fail "run this script as root (for example: sudo bash scripts/repair-db-ownership.sh)"
fi

command -v node >/dev/null 2>&1 || fail "node is required"
command -v runuser >/dev/null 2>&1 || fail "runuser is required"
id postgres >/dev/null 2>&1 || fail "the postgres operating-system user does not exist"
[ -f "${APP_DIR}/.env" ] || fail "${APP_DIR}/.env does not exist"

mapfile -t connection_parts < <(
  cd "$APP_DIR"
  node <<'NODE'
require('dotenv').config();

const raw = process.env.DATABASE_URL;
if (!raw) throw new Error('DATABASE_URL is missing from .env');
const parsed = new URL(raw);
if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('DATABASE_URL must use postgres:// or postgresql://');
}
const user = decodeURIComponent(parsed.username);
const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
if (!user || !database) throw new Error('DATABASE_URL must include a user and database name');
process.stdout.write(`${user}\n${database}\n`);
NODE
)

DB_USER="${DB_USER:-${connection_parts[0]:-}}"
DB_NAME="${DB_NAME:-${connection_parts[1]:-}}"

identifier_pattern='^[A-Za-z_][A-Za-z0-9_]*$'
[[ "$DB_USER" =~ $identifier_pattern ]] || fail "unsafe PostgreSQL user name: ${DB_USER}"
[[ "$DB_NAME" =~ $identifier_pattern ]] || fail "unsafe PostgreSQL database name: ${DB_NAME}"

role_exists="$(runuser -u postgres -- psql -XAtqc "SELECT 1 FROM pg_roles WHERE rolname = '${DB_USER}'" postgres)"
[ "$role_exists" = "1" ] || fail "PostgreSQL role ${DB_USER} does not exist"

database_exists="$(runuser -u postgres -- psql -XAtqc "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" postgres)"
[ "$database_exists" = "1" ] || fail "PostgreSQL database ${DB_NAME} does not exist"

echo "Repairing PostgreSQL ownership for database ${DB_NAME} and role ${DB_USER}"
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 postgres <<SQL
ALTER DATABASE ${DB_NAME} OWNER TO ${DB_USER};
GRANT CONNECT, TEMPORARY ON DATABASE ${DB_NAME} TO ${DB_USER};
\connect ${DB_NAME}

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

remaining_wrong_owners="$(runuser -u postgres -- psql -XAtqc "
  SELECT
    (SELECT COUNT(*) FROM pg_tables WHERE schemaname = 'public' AND tableowner <> '${DB_USER}')
    +
    (SELECT COUNT(*) FROM pg_sequences WHERE schemaname = 'public' AND sequenceowner <> '${DB_USER}');
" "$DB_NAME")"

[ "$remaining_wrong_owners" = "0" ] || fail "${remaining_wrong_owners} public tables or sequences still have the wrong owner"

echo "PostgreSQL ownership is correct. Run npm run migrate and npm run doctor as the application user."
