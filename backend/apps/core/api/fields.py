"""Serializer fields that resolve tenant-scoped querysets lazily, inside the request context."""

from __future__ import annotations

from collections.abc import Callable

from django.db.models import Model, QuerySet
from rest_framework import serializers


class _LazyMarker:
    """Non-None placeholder satisfying DRF's 'queryset or read_only' assertion.

    Exposes ``model`` so schema generation (drf-spectacular) can describe the field without touching
    the tenant-scoped manager.
    """

    def __init__(self, model: type[Model]) -> None:
        self.model = model

    def all(self):  # pragma: no cover - never called; get_queryset is overridden
        raise RuntimeError("Lazy queryset marker should not be evaluated.")


class TenantPrimaryKeyRelatedField(serializers.PrimaryKeyRelatedField):
    """``queryset_fn`` is called per request, so the tenant-scoped manager is never touched at import time.

    Because the manager is tenant-scoped, an id from another organization simply does not validate.
    """

    def __init__(self, *, model: type[Model], queryset_fn: Callable[[], QuerySet], **kwargs):
        self._queryset_fn = queryset_fn
        kwargs.setdefault("queryset", _LazyMarker(model))
        super().__init__(**kwargs)

    def get_queryset(self) -> QuerySet:
        return self._queryset_fn()
