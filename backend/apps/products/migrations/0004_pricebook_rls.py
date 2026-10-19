from django.db import migrations

from apps.core.rls import enable_rls


class Migration(migrations.Migration):
    dependencies = [("products", "0003_product_in_stock_pricebook_pricebookentry_and_more")]

    operations = [enable_rls("products_pricebook"), enable_rls("products_pricebookentry")]
