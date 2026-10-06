#!/bin/sh
set -eu
# psql variable quoting avoids interpolating passwords into SQL or shell code.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv app_password VOICEAI_DB_APP_PASSWORD
CREATE ROLE voiceai_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'app_password';
\i /schema.sql
SQL
