#!/usr/bin/env bash
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
FAKE_BIN="${TEST_ROOT}/bin"
COMMAND_LOG="${TEST_ROOT}/commands.log"

cleanup() {
  rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT

fail() {
  printf '[deployment-safety:error] %s\n' "$*" >&2
  exit 1
}

assert_log_contains() {
  grep -Fqx -- "$1" "$COMMAND_LOG" || fail "missing command log entry: $1"
}

assert_log_excludes() {
  if grep -Fqx -- "$1" "$COMMAND_LOG"; then
    fail "unexpected command log entry: $1"
  fi
}

mkdir -p "$FAKE_BIN" "${TEST_ROOT}/home"

cat > "${FAKE_BIN}/pg_dump" <<'STUB'
#!/usr/bin/env bash
set -Eeuo pipefail
target=""
for argument in "$@"; do
  case "$argument" in
    --file=*) target="${argument#--file=}" ;;
  esac
done
[ -n "$target" ] || exit 64
printf 'mock custom archive\n' > "$target"
[ "${MOCK_PG_DUMP_FAIL:-0}" != "1" ] || exit 70
STUB

cat > "${FAKE_BIN}/pg_restore" <<'STUB'
#!/usr/bin/env bash
set -Eeuo pipefail
if [ "${1:-}" = "--list" ]; then
  [ "${MOCK_ARCHIVE_INVALID:-0}" != "1" ] || exit 71
  [ -s "${2:-}" ] || exit 72
  exit 0
fi
[ "${MOCK_RESTORE_FAIL:-0}" != "1" ] || exit 73
printf 'pg_restore apply\n' >> "$MOCK_COMMAND_LOG"
STUB

cat > "${FAKE_BIN}/pm2" <<'STUB'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'pm2 %s\n' "$*" >> "$MOCK_COMMAND_LOG"
case "${1:-}:${2:-}" in
  describe:capi-api) [ "${MOCK_API_PRESENT:-0}" = "1" ] ;;
  describe:capi-worker) [ "${MOCK_WORKER_PRESENT:-0}" = "1" ] ;;
  *) exit 0 ;;
esac
STUB

cat > "${FAKE_BIN}/npm" <<'STUB'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'npm %s\n' "$*" >> "$MOCK_COMMAND_LOG"
STUB
chmod +x "${FAKE_BIN}/pg_dump" "${FAKE_BIN}/pg_restore" "${FAKE_BIN}/pm2" "${FAKE_BIN}/npm"

run_backup() {
  local backup_dir="$1"
  shift
  mkdir -p "$backup_dir"
  env \
    PATH="${FAKE_BIN}:${PATH}" \
    APP_DIR="$REPO_ROOT" \
    BACKUP_DIR="$backup_dir" \
    INCLUDE_ENV=0 \
    DATABASE_URL=postgres://mock/mock \
    "$@" \
    bash "${REPO_ROOT}/scripts/backup.sh"
}

successful_backup="${TEST_ROOT}/backup-success"
run_backup "$successful_backup"
[ "$(find "$successful_backup" -maxdepth 1 -type f -name 'capi-db-*.dump' | wc -l)" -eq 1 ] \
  || fail "a validated backup was not atomically published"
[ -z "$(find "$successful_backup" -maxdepth 1 -type f -name '*.tmp.*' -print -quit)" ] \
  || fail "successful backup left a temporary file"

failed_backup="${TEST_ROOT}/backup-failed"
if run_backup "$failed_backup" MOCK_PG_DUMP_FAIL=1; then
  fail "backup unexpectedly succeeded after pg_dump failure"
fi
[ -z "$(find "$failed_backup" -maxdepth 1 -type f -print -quit)" ] \
  || fail "failed pg_dump published or retained a partial backup"

invalid_backup="${TEST_ROOT}/backup-invalid"
if run_backup "$invalid_backup" MOCK_ARCHIVE_INVALID=1; then
  fail "backup unexpectedly published an invalid archive"
fi
[ -z "$(find "$invalid_backup" -maxdepth 1 -type f -print -quit)" ] \
  || fail "invalid archive was published or retained"

archive="${TEST_ROOT}/restore.dump"
printf 'mock custom archive\n' > "$archive"
runtime_user="$(id -un)"

rm -f -- "$COMMAND_LOG"
invalid_maintenance="${TEST_ROOT}/invalid.maintenance"
if env \
  PATH="${FAKE_BIN}:${PATH}" \
  APP_DIR="$REPO_ROOT" \
  MAINTENANCE_FILE="$invalid_maintenance" \
  PM2_USER="$runtime_user" \
  PM2_USER_HOME="${TEST_ROOT}/home" \
  DATABASE_URL=postgres://mock/mock \
  CONFIRM=RESTORE \
  MOCK_ARCHIVE_INVALID=1 \
  MOCK_COMMAND_LOG="$COMMAND_LOG" \
  bash "${REPO_ROOT}/scripts/restore.sh" "$archive"; then
  fail "restore unexpectedly accepted an invalid archive"
fi
[ ! -e "$invalid_maintenance" ] || fail "invalid archive entered maintenance mode"
[ ! -s "$COMMAND_LOG" ] || fail "invalid archive touched runtime processes"

rm -f -- "$COMMAND_LOG"
worker_maintenance="${TEST_ROOT}/worker.maintenance"
env \
  PATH="${FAKE_BIN}:${PATH}" \
  APP_DIR="$REPO_ROOT" \
  MAINTENANCE_FILE="$worker_maintenance" \
  RESTORE_DRAIN_SECONDS=0 \
  PM2_USER="$runtime_user" \
  PM2_USER_HOME="${TEST_ROOT}/home" \
  DATABASE_URL=postgres://mock/mock \
  CONFIRM=RESTORE \
  MOCK_WORKER_PRESENT=1 \
  MOCK_COMMAND_LOG="$COMMAND_LOG" \
  bash "${REPO_ROOT}/scripts/restore.sh" "$archive"
assert_log_contains 'pm2 stop capi-worker'
assert_log_contains 'pm2 restart capi-worker --update-env'
assert_log_excludes 'pm2 stop capi-api'
assert_log_excludes 'pm2 restart capi-api --update-env'
assert_log_contains 'npm run migrate'
assert_log_contains 'npm run doctor'
[ ! -e "$worker_maintenance" ] || fail "successful restore retained maintenance mode"

rm -f -- "$COMMAND_LOG"
failed_maintenance="${TEST_ROOT}/failed.maintenance"
if env \
  PATH="${FAKE_BIN}:${PATH}" \
  APP_DIR="$REPO_ROOT" \
  MAINTENANCE_FILE="$failed_maintenance" \
  RESTORE_DRAIN_SECONDS=0 \
  PM2_USER="$runtime_user" \
  PM2_USER_HOME="${TEST_ROOT}/home" \
  DATABASE_URL=postgres://mock/mock \
  CONFIRM=RESTORE \
  MOCK_WORKER_PRESENT=1 \
  MOCK_RESTORE_FAIL=1 \
  MOCK_COMMAND_LOG="$COMMAND_LOG" \
  bash "${REPO_ROOT}/scripts/restore.sh" "$archive"; then
  fail "restore unexpectedly succeeded after database failure"
fi
assert_log_contains 'pm2 stop capi-worker'
assert_log_excludes 'pm2 restart capi-worker --update-env'
[ -e "$failed_maintenance" ] || fail "failed restore removed maintenance mode"

printf '[deployment-safety] all fault-injection checks passed\n'
