from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("contacts", "0002_rls_search"), ("lifecycle", "0001_initial")]

    operations = [
        migrations.AddField(
            model_name="contact",
            name="next_activity_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="contact",
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
            model_name="contact",
            name="lifecycle_changed_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="contact",
            name="whatsapp_opt_in",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="contact",
            name="whatsapp_opt_in_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddIndex(
            model_name="contact",
            index=models.Index(fields=["organization", "lifecycle_stage"], name="contact_org_lifecycle_idx"),
        ),
        migrations.AddIndex(
            model_name="contact",
            index=models.Index(fields=["organization", "next_activity_at"], name="contact_org_next_act_idx"),
        ),
    ]
