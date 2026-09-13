from django.db import migrations

from apps.core.rls import enable_rls
from apps.core.search import search_vector_trigger


class Migration(migrations.Migration):
    dependencies = [("products", "0001_initial")]

    operations = [
        enable_rls("products_product"),
        search_vector_trigger("products_product", {"A": ["name"], "B": ["sku"], "C": ["description"]}),
    ]
