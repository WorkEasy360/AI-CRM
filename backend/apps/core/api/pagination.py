from rest_framework.pagination import CursorPagination


class DefaultCursorPagination(CursorPagination):
    """Keyset pagination with a hard cap. Views may override ``ordering`` but not remove the cap.

    A view that resolved an allowlisted sort exposes it as ``resolved_ordering``; the cursor then
    follows that ordering (with a stable ``id`` tiebreak appended by ``FilterSet.resolve_sort``).
    """

    page_size = 50
    max_page_size = 200
    page_size_query_param = "limit"
    ordering = "-created_at"

    def get_ordering(self, request, queryset, view):
        resolved = getattr(view, "resolved_ordering", None)
        if resolved:
            return tuple(resolved)
        return super().get_ordering(request, queryset, view)
