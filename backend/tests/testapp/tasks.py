from apps.core.tenancy.tasks import tenant_task
from tests.testapp.models import Widget


@tenant_task()
def count_widgets(*, organization_id, **kwargs) -> int:
    return Widget.objects.count()
