"""Performance guards for the endpoints a page switch triggers.

Navigating the CRM is the most frequent thing anyone does, and every hop fans out into a small set of
list/summary endpoints. What makes those endpoints stay fast is not a wall-clock number (too noisy to
assert) but two structural properties, which is what is checked here:

* the query count does not grow with the number of rows — the N+1 guard;
* the response size is capped server-side, whatever page size the client asks for.

Both are asserted as ceilings with headroom, so an honest refactor that adds a query does not fail the
suite while an accidental per-row query does.
"""

from __future__ import annotations

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext

pytestmark = pytest.mark.django_db

# Every endpoint the six primary destinations request on arrival.
NAVIGATION_ENDPOINTS = [
    "/api/v1/session/",
    "/api/v1/dashboard/?period=30d",
    "/api/v1/deals/board/",
    "/api/v1/pipelines/",
    "/api/v1/contacts/?sort=-created_at",
    "/api/v1/companies/?sort=-created_at",
    "/api/v1/products/?sort=name",
    "/api/v1/activities/summary/?owner=me",
    "/api/v1/custom-fields/?entity_type=contact&limit=200",
]


def _queries_for(client, path: str) -> int:
    with CaptureQueriesContext(connection) as ctx:
        response = client.get(path)
    assert response.status_code == 200, f"{path} -> {response.status_code}"
    return len(ctx.captured_queries)


def _populate(crm, org, *, contacts: int, companies: int, deals: int) -> None:
    for _ in range(companies):
        company = crm.make_company(org)
        for _ in range(max(1, contacts // max(1, companies))):
            crm.make_contact(org, company=company)
    for _ in range(deals):
        crm.make_deal(org)


def test_navigation_endpoints_do_not_query_per_row(org_a, owner_client, crm):
    """The N+1 guard: growing the data must not grow the query count."""
    _populate(crm, org_a, contacts=4, companies=2, deals=3)
    for path in NAVIGATION_ENDPOINTS:  # warm-up: a session's first request does one-time bookkeeping
        _queries_for(owner_client, path)
    small = {path: _queries_for(owner_client, path) for path in NAVIGATION_ENDPOINTS}

    _populate(crm, org_a, contacts=30, companies=10, deals=25)
    large = {path: _queries_for(owner_client, path) for path in NAVIGATION_ENDPOINTS}

    grew = {path: (small[path], large[path]) for path in NAVIGATION_ENDPOINTS if large[path] > small[path]}
    assert not grew, f"query count grew with row count (N+1): {grew}"


def test_navigation_endpoints_stay_within_a_query_budget(org_a, owner_client, crm):
    """A ceiling with headroom, so a page switch cannot quietly become a dozen round trips."""
    budget = 20
    _populate(crm, org_a, contacts=20, companies=6, deals=15)
    for path in NAVIGATION_ENDPOINTS:
        _queries_for(owner_client, path)
    over = {path: count for path in NAVIGATION_ENDPOINTS if (count := _queries_for(owner_client, path)) > budget}
    assert not over, f"endpoints exceeding the {budget}-query navigation budget: {over}"


@pytest.mark.parametrize("path", ["/api/v1/contacts/", "/api/v1/companies/", "/api/v1/products/"])
def test_list_responses_stay_bounded_however_large_a_page_the_client_asks_for(org_a, owner_client, crm, path):
    """An unbounded page is both a performance and an exfiltration problem; the cap is server-side."""
    from apps.core.api.pagination import DefaultCursorPagination

    cap = DefaultCursorPagination.max_page_size
    # Enough rows that an uncapped page would visibly exceed the limit.
    make = {"contacts": crm.make_contact, "companies": crm.make_company, "products": crm.make_product}[
        path.strip("/").split("/")[-1]
    ]
    for _ in range(cap + 5):
        make(org_a)

    response = owner_client.get(f"{path}?limit=100000")
    assert response.status_code == 200
    assert len(response.json()["results"]) <= cap, f"{path} returned an unbounded page"
