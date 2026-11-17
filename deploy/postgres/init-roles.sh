#!/bin/sh
# Runs once, as the Postgres superuser, when the database volume is first created.
# Creates the two roles the app needs and a database owned by the migrator:
#   hlcrm_migrator  owns the schema; used only to run migrations
#   hlcrm_app       used by the API and workers; not an owner, no BYPASSRLS, so row-level security applies
# Set HLCRM_CREATE_TEST_DB=true (development and CI only) to also create the hlcrm_test database.
set -eu
: "${HLCRM_MIGRATOR_PASSWORD:?}" "${HLCRM_APP_PASSWORD:?}"

# Refuse empty or obvious placeholder passwords (lowercased for the comparison).
check_pw() {
  lc=$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')
  case "$lc" in
    ""|*change-me*|*changeme*|*change_me*|password|passw0rd|postgres|secret|example|placeholder|test|admin|hlcrm|todo|your-*|your_*|"<"*">")
      echo "init-roles: $1 is empty or a placeholder; set a strong random password (run: sh scripts/init-env.sh)" >&2
      exit 1 ;;
  esac
}
check_pw HLCRM_MIGRATOR_PASSWORD "$HLCRM_MIGRATOR_PASSWORD"
check_pw HLCRM_APP_PASSWORD "$HLCRM_APP_PASSWORD"

databases="hlcrm"
[ "${HLCRM_CREATE_TEST_DB:-}" = "true" ] && databases="hlcrm hlcrm_test"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v migrator_pw="$HLCRM_MIGRATOR_PASSWORD" -v app_pw="$HLCRM_APP_PASSWORD" <<'SQL'
CREATE ROLE hlcrm_migrator LOGIN PASSWORD :'migrator_pw' NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
CREATE ROLE hlcrm_app LOGIN PASSWORD :'app_pw' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
CREATE DATABASE hlcrm OWNER hlcrm_migrator;
SQL
for db in $databases; do
  [ "$db" = hlcrm ] || psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -c "CREATE DATABASE $db OWNER hlcrm_migrator"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<'SQL'
DO $$ BEGIN EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database()); EXECUTE format('GRANT CONNECT ON DATABASE %I TO hlcrm_app', current_database()); END $$;
SQL
done
