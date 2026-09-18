# Database migrations

How schema changes reach production without taking it down.

The deploy pipeline runs the one-off `migrate` ECS task and waits for exit code 0 before rolling the
`api` and `worker` services. So for the length of every deploy, **the new schema is live while the old
code is still serving**. Everything below follows from that one fact.

## Migration-time database settings

Migrations do not inherit the request path's timeouts. They are set on the migrate task only
(`DB_MIGRATION_MODE=true`, wired in `infra/terraform/ecs.tf`), and validated at start-up by
`apps.core.checks.check_migration_timeouts`.

| Setting | Request path | Migrations | Why |
|---|---|---|---|
| `statement_timeout` | 15 s | 10 min | A request that hangs for 15 s is a bug. An index build over a large table taking minutes is normal work, and killing it halfway through a deploy is the worst outcome available. |
| `lock_timeout` | 5 s | 10 s | Deliberately short. See below. |
| `idle_in_transaction_session_timeout` | 60 s | 10 min | A migration legitimately sits in one long transaction; the request-path guard would kill it. |

Both migration values are bounded and neither may be `0`. "No timeout" is not the safe option: an
unbounded `ALTER TABLE` that is waiting for a lock holds an `ACCESS EXCLUSIVE` lock *request*, and in
PostgreSQL a queued exclusive request blocks every later reader as well. One stuck migration becomes a
full outage of a table that was serving fine a second earlier.

### Why the lock wait is short, not long

During a rolling deploy there is always traffic. If the migration cannot get its lock within 10
seconds, the right answer is to fail immediately, having changed nothing:

- the old containers keep serving,
- nothing is queued behind an exclusive lock request,
- the deploy pipeline reports a clean, retryable failure.

Retrying a minute later usually succeeds, because whatever long transaction was in the way has ended.
Waiting instead trades a retry for an outage.

## Expand → migrate → contract

Any change that would break the currently running code is split across **three deploys**. The rule is
that each deploy must leave the database compatible with both the code that is running and the code
that is about to run.

```
  deploy 1: EXPAND      add the new thing, tolerated by old code
      |                 new column nullable / new table / new index
      |                 old code ignores it, keeps working
      v
  deploy 2: MIGRATE     backfill, then start writing and reading the new thing
      |                 both shapes are valid for the whole of this deploy
      v
  deploy 3: CONTRACT    remove the old thing, now that nothing reads it
                        drop column / drop table / drop constraint
```

**Expand.** Additive only. A new column must be `NULL`-able or have a database default; adding a `NOT
NULL` column with no default rewrites the table and breaks every running `INSERT` that does not
mention it. New tables and new indexes are always safe to add.

**Migrate.** Backfill in bounded batches (never one `UPDATE` over the whole table — it holds row locks
and bloats WAL), then deploy code that writes both shapes and reads the new one. Only once *this* code
is fully rolled out is it true that nothing depends on the old shape.

**Contract.** Drop the old column, table or constraint. Cheap and fast, because by now nothing reads it.

### Worked example: `messaging/0002_idempotent_sends.py`

Adding `idempotency_key` — unique per organization, one value per row — looks like a one-liner and is
not. `AddField(default=uuid.uuid4)` evaluates the callable **once**, stamps every existing row with the
same value, and the unique index then refuses to build. So that migration does all three phases in one
file, which is safe because the table had no production rows yet:

1. **expand** — add the column nullable, no constraint;
2. **backfill** — give each row its own key, 5,000 rows at a time;
3. **constrain** — `NOT NULL`, then build the unique index `CONCURRENTLY`.

`CREATE INDEX CONCURRENTLY` cannot run inside a transaction, hence `atomic = False` on that migration.
That is safe here only because each step is independently re-runnable: a failure part-way leaves either
un-backfilled rows (step 2 re-runs harmlessly) or an `INVALID` index (dropped and rebuilt by re-running
step 3). `SeparateDatabaseAndState` keeps Django's model state in step with the hand-written SQL.

Against a table with real traffic, these three phases belong in three deploys.

## Operations that need care

| Operation | Safe? | Do this instead |
|---|---|---|
| `CREATE INDEX` | ❌ blocks writes for the build | `CREATE INDEX CONCURRENTLY` (needs `atomic = False`) |
| `ADD COLUMN ... NOT NULL` without default | ❌ rewrites the table | add nullable → backfill → `SET NOT NULL` |
| `ADD COLUMN ... NOT NULL DEFAULT x` | ✅ on PostgreSQL 11+ | metadata-only, no rewrite |
| `DROP COLUMN` | ⚠️ breaks running old code | contract phase only, after the read is gone |
| `ALTER COLUMN TYPE` | ❌ rewrites the table | new column → backfill → swap reads → drop old |
| `ADD CONSTRAINT` (check/FK) | ⚠️ full-table scan under lock | `NOT VALID`, then `VALIDATE CONSTRAINT` separately |
| `RENAME COLUMN` | ❌ old code breaks instantly | add new → dual-write → swap reads → drop old |
| Backfill in one `UPDATE` | ❌ long transaction, lock and WAL pressure | batch it, as `_backfill()` in the example does |

## Row Level Security

Every tenant table carries an RLS policy (`apps/core/rls.py`). A migration that creates a tenant table
must enable RLS in the *same* migration — a table that exists without its policy is a table with no
tenant isolation, and `manage.py rls_check` (run in CI) fails the build if one appears.

## Checklist

- [ ] Additive changes only, unless this is a contract-phase deploy
- [ ] Backfills batched, not one statement
- [ ] Indexes built `CONCURRENTLY` (with `atomic = False`)
- [ ] New tenant tables enable RLS in the same migration
- [ ] `manage.py rls_check` passes
- [ ] Reversible, or the irreversibility is stated in the migration's docstring
- [ ] Rehearsed against a production-sized copy if the table is large
