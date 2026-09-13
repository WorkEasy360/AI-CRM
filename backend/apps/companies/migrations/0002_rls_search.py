from django.db import migrations

from apps.core.rls import enable_rls
from apps.core.search import search_vector_trigger


class Migration(migrations.Migration):
    dependencies = [("companies", "0001_initial")]

    operations = [
        enable_rls("companies_company"),
        search_vector_trigger("companies_company", {"A": ["name"], "B": ["website", "phone"], "C": ["industry", "description"]}),
    ]
