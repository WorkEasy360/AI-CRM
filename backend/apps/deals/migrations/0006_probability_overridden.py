from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("deals", "0005_deal_board_index")]

    operations = [
        migrations.AddField(
            model_name="deal",
            name="probability_overridden",
            field=models.BooleanField(default=False),
        ),
    ]
