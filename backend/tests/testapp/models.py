"""A minimal owned tenant resource used to exercise tenancy and authorization scopes end to end."""

from django.db import models

from apps.core.models import TenantModel


class Widget(TenantModel):
    OWNER_FIELD = "owner"

    name = models.CharField(max_length=80)
    owner = models.ForeignKey("accounts.Membership", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")

    class Meta:
        app_label = "testapp"
