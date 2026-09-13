-- Production role layout (run once by a DBA; passwords come from the secrets manager).
--
-- crm_migrator: owns the schema, runs migrations and retention purges. Never used by the app at runtime.
-- crm_app:      runtime role; no DDL, no RLS bypass; append-only on audit tables.

CREATE ROLE crm_migrator LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
CREATE ROLE crm_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;

CREATE DATABASE keel OWNER crm_migrator;
\connect keel

ALTER SCHEMA public OWNER TO crm_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO crm_app;

-- After every migration run (executed by `manage.py grant_app_role`):
--   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO crm_app;
--   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO crm_app;
--   REVOKE UPDATE, DELETE ON audit_auditevent FROM crm_app;
--   REVOKE UPDATE, DELETE ON deals_dealstagehistory FROM crm_app;   -- from Phase 2
ALTER DEFAULT PRIVILEGES FOR ROLE crm_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE crm_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO crm_app;
