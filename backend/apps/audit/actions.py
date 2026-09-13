"""Audit action identifiers. Keep them stable: they are queried by admins and monitoring."""

AUTH_LOGIN = "auth.login"
AUTH_LOGIN_FAILED = "auth.login_failed"
AUTH_LOGOUT = "auth.logout"
AUTH_PASSWORD_CHANGED = "auth.password_changed"  # noqa: S105  # nosec B105 - action name, not a secret
AUTH_PASSWORD_RESET = "auth.password_reset"  # noqa: S105  # nosec B105 - action name, not a secret
AUTH_EMAIL_VERIFIED = "auth.email_verified"
AUTH_MFA_ENABLED = "auth.mfa_enabled"
AUTH_MFA_DISABLED = "auth.mfa_disabled"
AUTH_SESSIONS_REVOKED = "auth.sessions_revoked"
AUTH_SUSPICIOUS_LOGIN = "auth.suspicious_login"
AUTH_REAUTHENTICATED = "auth.reauthenticated"

ORG_CREATED = "org.created"
ORG_UPDATED = "org.updated"
ORG_SWITCHED = "org.switched"

MEMBER_INVITED = "members.invited"
MEMBER_INVITATION_REVOKED = "members.invitation_revoked"
MEMBER_JOINED = "members.joined"
MEMBER_ROLE_CHANGED = "members.role_changed"
MEMBER_DISABLED = "members.disabled"
MEMBER_ENABLED = "members.enabled"

TEAM_CREATED = "teams.created"
TEAM_UPDATED = "teams.updated"
TEAM_DELETED = "teams.deleted"
TEAM_MEMBER_ADDED = "teams.member_added"
TEAM_MEMBER_REMOVED = "teams.member_removed"

TENANT_MISMATCH_ATTEMPT = "tenant.mismatch_attempt"
SYSTEM_ACCESS = "system.unscoped_access"
