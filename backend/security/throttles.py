from rest_framework.throttling import AnonRateThrottle, ScopedRateThrottle, UserRateThrottle


class AnonThrottle(AnonRateThrottle):
    scope = "anon"


class UserThrottle(UserRateThrottle):
    scope = "user"


class ScopedThrottle(ScopedRateThrottle):
    """Views set ``throttle_scope`` ('auth', 'admin', 'sensitive', ...) for stricter buckets."""
