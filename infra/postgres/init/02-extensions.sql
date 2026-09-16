-- Extensions the application needs, installed by the superuser at container init.
--
-- `vector` (pgvector) backs the RAG knowledge index. It is not a trusted extension, so the
-- non-superuser runtime role (crm_app) cannot install it; it is created here and in template1 so
-- every database created later -- including Django's test_keel -- inherits it and migrations only
-- have to run `CREATE EXTENSION IF NOT EXISTS vector` as a no-op.
--
-- Production: a DBA (or rds_superuser on RDS) runs the same statement once per database.

\connect template1
CREATE EXTENSION IF NOT EXISTS vector;

\connect keel
CREATE EXTENSION IF NOT EXISTS vector;
