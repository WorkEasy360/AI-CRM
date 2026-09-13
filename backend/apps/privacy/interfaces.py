"""Contracts every data-holding app implements so export, deletion and retention stay complete.

Phase 1 defines the interfaces and the registry; Phase 2+ apps register exporters/erasers as they
add tenant data. Phase 6 wires the jobs and the tenant-deletion workflow. Designed for India DPDP
(data principal rights: access, correction, erasure) and GDPR-style portability from the start.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class PersonalDataExporter(Protocol):
    """Yields JSON-serialisable records for one user or one organization."""

    name: str

    def export_for_user(self, user_id: uuid.UUID) -> Iterator[dict[str, Any]]: ...

    def export_for_organization(self, organization_id: uuid.UUID) -> Iterator[dict[str, Any]]: ...


@runtime_checkable
class PersonalDataEraser(Protocol):
    """Erases or anonymises data for a user or purges an organization."""

    name: str

    def erase_user(self, user_id: uuid.UUID) -> int: ...

    def purge_organization(self, organization_id: uuid.UUID) -> int: ...


_EXPORTERS: dict[str, PersonalDataExporter] = {}
_ERASERS: dict[str, PersonalDataEraser] = {}


def register_exporter(exporter: PersonalDataExporter) -> None:
    _EXPORTERS[exporter.name] = exporter


def register_eraser(eraser: PersonalDataEraser) -> None:
    _ERASERS[eraser.name] = eraser


def exporters() -> list[PersonalDataExporter]:
    return list(_EXPORTERS.values())


def erasers() -> list[PersonalDataEraser]:
    return list(_ERASERS.values())
