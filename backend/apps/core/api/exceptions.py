"""RFC 9457 problem-details responses for every API error. Never leaks internals."""

from __future__ import annotations

from typing import Any

import structlog
from django.core.exceptions import PermissionDenied as DjangoPermissionDenied
from django.core.exceptions import ValidationError as DjangoValidationError
from django.http import Http404
from rest_framework import exceptions, status
from rest_framework.response import Response
from rest_framework.views import exception_handler as drf_exception_handler

from apps.core.exceptions import DomainError, ReauthenticationRequired, TenantContextMissing

log = structlog.get_logger(__name__)


def _flatten_errors(detail: Any, prefix: str = "") -> list[dict[str, str]]:
    errors: list[dict[str, str]] = []
    if isinstance(detail, dict):
        for key, value in detail.items():
            field = f"{prefix}.{key}" if prefix else str(key)
            errors.extend(_flatten_errors(value, field))
    elif isinstance(detail, list):
        for item in detail:
            errors.extend(_flatten_errors(item, prefix))
    else:
        errors.append(
            {
                "field": prefix or "non_field_errors",
                "code": getattr(detail, "code", "invalid") or "invalid",
                "message": str(detail),
            }
        )
    return errors


def problem_details_exception_handler(exc: Exception, context: dict[str, Any]) -> Response | None:
    if isinstance(exc, DjangoValidationError):
        exc = exceptions.ValidationError(detail=exc.message_dict if hasattr(exc, "message_dict") else exc.messages)
    elif isinstance(exc, ReauthenticationRequired):
        exc = exceptions.PermissionDenied(detail="Recent authentication required.", code="reauth_required")
    elif isinstance(exc, DomainError):
        api_exc = exceptions.APIException(detail=exc.message, code=exc.code)
        api_exc.status_code = exc.status_code
        exc = api_exc
    elif isinstance(exc, TenantContextMissing):
        # A tenant-scoped resource was requested without an organization bound (e.g. no active org).
        exc = exceptions.PermissionDenied(detail="No active organization.", code="no_active_organization")

    response = drf_exception_handler(exc, context)
    if response is None:
        return None

    request = context.get("request")
    request_id = getattr(request, "request_id", None) if request is not None else None

    code = "error"
    if isinstance(exc, exceptions.APIException):
        raw_code = exc.get_codes()
        code = raw_code if isinstance(raw_code, str) else exc.default_code
    elif isinstance(exc, Http404):
        code = "not_found"
    elif isinstance(exc, DjangoPermissionDenied):
        code = "permission_denied"

    body: dict[str, Any] = {
        "type": code,
        "title": _title_for(response.status_code),
        "status": response.status_code,
        "request_id": request_id,
    }
    if isinstance(exc, exceptions.ValidationError):
        body["detail"] = "Validation failed."
        body["errors"] = _flatten_errors(exc.detail)
    elif isinstance(exc, exceptions.APIException):
        detail = exc.detail
        body["detail"] = str(detail) if not isinstance(detail, dict | list) else "Request failed."
    else:
        body["detail"] = _title_for(response.status_code)

    response.data = body
    return response


def _title_for(status_code: int) -> str:
    return {
        status.HTTP_400_BAD_REQUEST: "Bad request",
        status.HTTP_401_UNAUTHORIZED: "Authentication required",
        status.HTTP_403_FORBIDDEN: "Forbidden",
        status.HTTP_404_NOT_FOUND: "Not found",
        status.HTTP_405_METHOD_NOT_ALLOWED: "Method not allowed",
        status.HTTP_406_NOT_ACCEPTABLE: "Not acceptable",
        status.HTTP_409_CONFLICT: "Conflict",
        status.HTTP_413_REQUEST_ENTITY_TOO_LARGE: "Payload too large",
        status.HTTP_415_UNSUPPORTED_MEDIA_TYPE: "Unsupported media type",
        status.HTTP_429_TOO_MANY_REQUESTS: "Too many requests",
    }.get(status_code, "Error")
