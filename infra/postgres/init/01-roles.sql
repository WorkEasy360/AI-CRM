-- Development / CI database roles.
--
-- crm_app is the runtime role: NOT a superuser and NOT allowed to bypass RLS.
-- In dev/test it also owns the schema so migrations can run; FORCE ROW LEVEL
-- SECURITY makes policies apply to the owner as well, so RLS is exercised in tests.
-- Production uses a separate crm_migrator owner role (see infra/postgres/prod-roles.sql).

CREATE ROLE crm_app LOGIN PASSWORD 'crm_app_dev_password' NOSUPERUSER NOBYPASSRLS CREATEDB NOCREATEROLE;
CREATE DATABASE keel OWNER crm_app;
