#!/bin/bash
# First-boot database layout for the single-host deployment (runs once, on an empty data directory).
# Mirrors infra/postgres/prod-roles.sql:
#   crm_migrator  owns the schema and runs migrations; never used by the running app.
#   crm_app       runtime role: no DDL, no RLS bypass, append-only on audit tables (grant_app_role).
# Passwords are read inside psql from the files compose mounts, so they never appear in process
# arguments or the environment.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username postgres --dbname postgres <<'SQL'
\set migrator_pw `cat /run/keel-secrets/crm_migrator_password`
\set app_pw `cat /run/keel-secrets/crm_app_password`
CREATE ROLE crm_migrator LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB PASSWORD :'migrator_pw';
CREATE ROLE crm_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB PASSWORD :'app_pw';
CREATE DATABASE keel OWNER crm_migrator;
SQL

psql -v ON_ERROR_STOP=1 --username postgres --dbname keel <<'SQL'
ALTER SCHEMA public OWNER TO crm_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO crm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE crm_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE crm_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO crm_app;
-- pgvector is not a trusted extension: install it here as the superuser so the migration's
-- CREATE EXTENSION IF NOT EXISTS vector (run as crm_migrator) is a no-op.
CREATE EXTENSION IF NOT EXISTS vector;
SQL
