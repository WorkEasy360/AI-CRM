"""Stage-transition validation hook.

Every stage change (the Kanban drag, the stage dialog, a Sheet-view edit, an import, an automation)
goes through ``deals.services.move_stage``, which calls ``validate()`` before writing anything. M2
ships one pass-through validator; the Milestone 5 rule engine registers its own validator here and
needs no change to the stage-change path.

A validator raises ``TransitionRefused`` to block the move. It must not write: it runs inside the
move's transaction with the deal row locked, before the move is applied.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from apps.core.exceptions import DomainError


@dataclass(frozen=True)
class StageTransition:
    actor: Any
    deal: Any
    from_stage: Any
    to_stage: Any
    source: str
    lost_reason: str | None = None


class TransitionRefused(DomainError):  # noqa: N818 - reads better at call sites
    def __init__(self, message: str, *, rule: str = "", fields: tuple[str, ...] = ()):
        super().__init__(message, code="stage_transition_refused", status_code=409)
        self.extra = {"rule": rule, "fields": list(fields)}


Validator = Callable[[StageTransition], None]
_validators: list[Validator] = []


def register_validator(fn: Validator) -> Validator:
    if fn not in _validators:
        _validators.append(fn)
    return fn


def unregister_validator(fn: Validator) -> None:
    if fn in _validators:
        _validators.remove(fn)


def validate(transition: StageTransition) -> None:
    for fn in list(_validators):
        fn(transition)


@register_validator
def allow_all(transition: StageTransition) -> None:
    """M2 stub: every transition inside the deal's pipeline is allowed. M5 supplies the rules."""
    return None
