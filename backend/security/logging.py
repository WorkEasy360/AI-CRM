"""structlog configuration with a redaction processor. JSON in production, console in development."""

from __future__ import annotations

import logging
from collections.abc import MutableMapping
from typing import Any

import structlog
from structlog.typing import Processor

REDACT_KEYS = frozenset(
    {
        "password",
        "password1",
        "password2",
        "token",
        "secret",
        "authorization",
        "cookie",
        "key",
        "recovery_code",
        "access_token",
        "refresh_token",
        "api_key",
        "session_key",
        "csrf",
    }
)


def redact_processor(_logger: Any, _method: str, event_dict: MutableMapping[str, Any]) -> MutableMapping[str, Any]:
    for key in list(event_dict.keys()):
        if key.lower() in REDACT_KEYS:
            event_dict[key] = "[redacted]"
    return event_dict


def configure_logging(json_output: bool, level: str = "INFO") -> dict[str, Any]:
    shared_processors: list[Processor] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        redact_processor,
    ]
    renderer = structlog.processors.JSONRenderer() if json_output else structlog.dev.ConsoleRenderer()
    structlog.configure(
        processors=[*shared_processors, structlog.stdlib.ProcessorFormatter.wrap_for_formatter],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )
    return {
        "version": 1,
        "disable_existing_loggers": False,
        "formatters": {
            "structlog": {
                "()": structlog.stdlib.ProcessorFormatter,
                "processors": [structlog.stdlib.ProcessorFormatter.remove_processors_meta, renderer],
                "foreign_pre_chain": shared_processors,
            }
        },
        "handlers": {"console": {"class": "logging.StreamHandler", "formatter": "structlog"}},
        "root": {"handlers": ["console"], "level": level},
        "loggers": {
            "django.security": {"level": "INFO"},
            "django.request": {"level": "WARNING"},
            "audit": {"level": "INFO"},
        },
    }


logging.getLogger("django.security.DisallowedHost").setLevel(logging.WARNING)
