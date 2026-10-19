"""Tenant isolation for the billing tables, and a subscription for every organization that predates editions.

Existing organizations are grandfathered onto the top edition: they keep every capability and have no
seat limit, so introducing editions changes nothing for them. The backfill runs as a system statement
(``app.system`` set for this transaction only) because ``accounts_organization`` is under forced RLS.
The deferred FK checks the insert queues are flushed before the ALTER TABLEs, which Postgres refuses
while trigger events are pending.
"""

from django.db import migrations

from apps.core.rls import enable_rls

BACKFILL = """
SELECT set_config('app.system', 'on', true);
INSERT INTO billing_subscription
    (id, organization_id, edition, status, billing_cycle, seats, cancel_at_period_end, grandfathered,
     created_at, updated_at)
SELECT gen_random_uuid(), o.id, 'edition_360', 'active', 'annual', 0, false, true, now(), now()
FROM accounts_organization o
WHERE NOT EXISTS (SELECT 1 FROM billing_subscription s WHERE s.organization_id = o.id);
SET CONSTRAINTS ALL IMMEDIATE;
SELECT set_config('app.system', '', true);
"""


class Migration(migrations.Migration):
    dependencies = [("billing", "0001_initial"), ("accounts", "0003_rls")]

    operations = [
        migrations.RunSQL(BACKFILL, reverse_sql=migrations.RunSQL.noop),
        enable_rls("billing_subscription"),
        enable_rls("billing_addonpurchase"),
        enable_rls("billing_usagecounter"),
    ]
