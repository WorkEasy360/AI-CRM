"""Human messages for integration error codes. Provider responses and stack traces never reach users;
they stay in structured logs keyed by the same code."""

from __future__ import annotations

_MESSAGES: dict[str, str] = {
    "auth_expired": "Your {name} connection has expired. Reconnect your account.",
    "auth_failed": "{name} rejected the credentials. Check them and reconnect.",
    "not_configured": "{name} is not fully configured yet. Finish the connection settings.",
    "rate_limited": "{name} is limiting requests right now. Keel will retry automatically.",
    "unavailable": "{name} is temporarily unavailable. Keel will retry automatically.",
    "timeout": "{name} did not respond in time. Keel will retry automatically.",
    "connection_failed": "Keel could not reach {name}. Keel will retry automatically.",
    "dns_failure": "The address for {name} could not be found. Check the base URL.",
    "invalid_response": "{name} returned a response Keel could not read. Check the connection settings.",
    "response_too_large": "{name} returned more data than allowed in one response.",
    "rejected": "{name} rejected a record. Check the field mapping.",
    "record_not_found": "A linked record no longer exists in {name}; it will be recreated.",
    "invalid_resource": "A resource path for {name} is not valid.",
    "invalid_payload": "An incoming webhook from {name} had an unexpected format.",
    "private_destination": "This address points to a private network and is not allowed.",
    "scheme_not_allowed": "Only https:// addresses are allowed.",
    "port_not_allowed": "This port is not allowed.",
    "credentials_in_url": "Do not put credentials in the URL.",
    "invalid_url": "Enter a valid URL.",
    "redirect_not_followed": "{name} answered with a redirect, which Keel does not follow. Use the final URL.",
    "member_lost_access": "The member who connected {name} no longer has access. Reconnect the integration.",
    "decrypt_failed": "Stored credentials for {name} could not be read. Reconnect the integration.",
    "validation_failed": "A record from {name} did not pass validation and was skipped.",
    "conflict": "A record changed in both Keel and {name}. Review the conflict.",
    "permission_denied": "The integration is not allowed to change this record.",
    "unknown_provider": "This integration type is not available.",
}


def message_for(code: str, name: str = "The integration") -> str:
    if not code:
        return ""
    if code.startswith("not_supported:"):
        return f"{name} does not support this action."
    template = _MESSAGES.get(code, "{name} reported a problem. Try again or reconnect.")
    return template.format(name=name)
