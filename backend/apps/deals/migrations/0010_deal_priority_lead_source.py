from django.db import migrations, models


class Migration(migrations.Migration):
    """Additive: deal priority (cards) and lead source (Deals by Source). Existing deals: medium, not set."""

    dependencies = [("deals", "0009_connections_rls_line_tax")]

    operations = [
        migrations.AddField(
            model_name="deal",
            name="priority",
            field=models.CharField(
                choices=[("low", "Low"), ("medium", "Medium"), ("high", "High")], default="medium", max_length=8
            ),
        ),
        migrations.AddField(
            model_name="deal",
            name="lead_source",
            field=models.CharField(
                blank=True,
                choices=[
                    ("", "Not set"),
                    ("whatsapp", "WhatsApp"),
                    ("facebook_ads", "Facebook Ads"),
                    ("website", "Website"),
                    ("referral", "Referral"),
                    ("other", "Other"),
                ],
                default="",
                max_length=16,
            ),
        ),
    ]
