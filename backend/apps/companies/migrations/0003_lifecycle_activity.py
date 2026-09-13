from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("companies", "0002_rls_search"), ("lifecycle", "0001_initial")]

    operations = [
        migrations.AddField(
            model_name="company",
            name="last_activity_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="company",
            name="next_activity_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="company",
            name="lifecycle_stage",
            field=models.CharField(
                choices=[
                    ("lead", "Lead"),
                    ("prospect", "Prospect"),
                    ("qualified", "Qualified"),
                    ("customer", "Customer"),
                    ("inactive", "Inactive"),
                ],
                default="lead",
                max_length=16,
            ),
        ),
        migrations.AddField(
            model_name="company",
            name="lifecycle_changed_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddIndex(
            model_name="company",
            index=models.Index(fields=["organization", "lifecycle_stage"], name="company_org_lifecycle_idx"),
        ),
    ]
