from rest_framework.pagination import CursorPagination


class DefaultCursorPagination(CursorPagination):
    """Keyset pagination with a hard cap. Views may override ``ordering`` but not remove the cap."""

    page_size = 50
    max_page_size = 200
    page_size_query_param = "limit"
    ordering = "-created_at"
