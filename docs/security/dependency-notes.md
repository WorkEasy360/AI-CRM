# Dependency notes (ADR-0010)

One entry per runtime dependency added after Phase 1, in the form ADR-0010 requires.

## PyJWT (`pyjwt>=2.15`, locked 2.15.1) — added 2026-10-12

- **Purpose:** sign the RFC 7523 `private_key_jwt` client assertion and verify Workeasy360 ID tokens
  (JWS RS256/ES256, JWK parsing, `exp`/`nbf`/`aud`/`iss` validation) for Sign in with Workeasy360
  (`apps/accounts/workeasy360/oidc.py`, ADR-0013).
- **Why not stdlib or an existing dependency:** the standard library has no JOSE support. `cryptography`
  (already a dependency) provides the primitives but not JWS/JWK handling, and hand-rolling token
  verification is exactly the kind of security code ADR-0010 says not to write in-house. allauth's
  optional socialaccount extra would pull PyJWT in anyway, plus far more.
- **Maintenance:** maintained by the jpadilla/pyjwt project; regular releases (2.15.1 on 2026-09-28).
  2.13.0 (previously in the lock transitively through dev tooling) has published advisories fixed in
  2.14.0/2.15.0, so the floor is 2.15. `pip-audit` reports no advisory for 2.15.1.
- **Adoption:** one of the most widely used Python JWT libraries; already present in our lock as a
  transitive dependency of `semgrep`/`mcp` (dev).
- **License:** MIT.
- **Transitive footprint:** none new. Its `crypto` extra is `cryptography`, already a runtime
  dependency. Raising the floor moved the dev-only `semgrep` from 1.177.0 to 1.180.0 in the lock (the
  older release's dependency constraints did not admit PyJWT 2.15).
