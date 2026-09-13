"""Customer lifecycle stages shared by contacts and companies.

One status model instead of separate "prospect" and "customer" databases: a record moves Lead ->
Prospect -> Qualified -> Customer (or Inactive) and every transition is historised. The list is code
defined for now; per-organization configuration is a later, additive change.
"""

from __future__ import annotations

from django.db import models


class LifecycleStage(models.TextChoices):
    LEAD = "lead", "Lead"
    PROSPECT = "prospect", "Prospect"
    QUALIFIED = "qualified", "Qualified"
    CUSTOMER = "customer", "Customer"
    INACTIVE = "inactive", "Inactive"


LIFECYCLE_STAGES: tuple[str, ...] = tuple(LifecycleStage.values)
DEFAULT_STAGE = LifecycleStage.LEAD
# Order used for "progressed" semantics (a deal won never demotes a customer).
STAGE_RANK = {
    LifecycleStage.LEAD: 0,
    LifecycleStage.PROSPECT: 1,
    LifecycleStage.QUALIFIED: 2,
    LifecycleStage.CUSTOMER: 3,
    LifecycleStage.INACTIVE: 0,
}
