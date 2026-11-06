"""RLS for deal connections, and the tax split of existing product lines.

Before Milestone 2 a line's ``line_total`` was the discounted net without tax. It becomes ``subtotal``;
tax is computed from the line's own rate and ``line_total`` becomes subtotal + tax. Deal amounts are not
touched: existing deals keep their manual amount until one of their lines changes (DECISIONS M2.6).
Runs as a system statement because the table is under forced RLS.
"""

from django.db import migrations

from apps.core.rls import enable_rls

SPLIT_TAX = """
SELECT set_config('app.system', 'on', true);
UPDATE deals_dealproduct
SET subtotal = line_total,
    tax_amount = ROUND(line_total * tax_rate / 100, 2),
    line_total = line_total + ROUND(line_total * tax_rate / 100, 2);
SELECT set_config('app.system', '', true);
"""

UNSPLIT_TAX = """
SELECT set_config('app.system', 'on', true);
UPDATE deals_dealproduct SET line_total = subtotal;
SELECT set_config('app.system', '', true);
"""


class Migration(migrations.Migration):
    dependencies = [("deals", "0008_deal_price_book_dealproduct_subtotal_and_more")]

    operations = [
        enable_rls("deals_dealconnection"),
        migrations.RunSQL(SPLIT_TAX, reverse_sql=UNSPLIT_TAX),
    ]
