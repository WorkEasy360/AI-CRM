"""Base exceptions shared across apps. API-facing errors map onto these in apps.core.api.exceptions."""


class KeelError(Exception):
    """Root of all application errors."""


class TenantContextMissing(KeelError):  # noqa: N818 - name reads better at call sites
    """A tenant-scoped query or write was attempted without a tenant context."""


class UnscopedAccessError(KeelError):
    """An unscoped manager was used outside an explicit, audited system context."""


class ImmutableTenantError(KeelError):
    """Attempt to move a record from one organization to another."""


class CrossTenantWriteError(KeelError):
    """Attempt to write a record whose organization differs from the current context."""


class DomainError(KeelError):
    """A business-rule violation that should surface to the client as 400/409."""

    code = "domain_error"
    status_code = 400

    def __init__(self, message: str, *, code: str | None = None, status_code: int | None = None):
        super().__init__(message)
        self.message = message
        if code:
            self.code = code
        if status_code:
            self.status_code = status_code


class ConflictError(DomainError):
    code = "conflict"
    status_code = 409


class ReauthenticationRequired(KeelError):  # noqa: N818
    """The action needs a recent authentication (password or MFA)."""
