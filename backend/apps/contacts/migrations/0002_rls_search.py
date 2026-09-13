from django.db import migrations

from apps.core.rls import enable_rls
from apps.core.search import search_vector_trigger


class Migration(migrations.Migration):
    dependencies = [("contacts", "0001_initial")]

    operations = [
        enable_rls("contacts_contact"),
        search_vector_trigger(
            "contacts_contact", {"A": ["first_name", "last_name"], "B": ["email", "phone"], "C": ["job_title", "description"]}
        ),
    ]
