# Dependency notes (ADR-0010)

One entry per runtime dependency added after Phase 1, in the form ADR-0010 requires.

## PyJWT (`pyjwt>=2.15`, locked 2.15.1) — added 2026-10-12

- **Purpose:** sign the RFC 7523 `private_key_jwt` client assertion and verify Workeasy360 ID tokens
  (JWS RS256/ES256, JWK parsing, `exp`/`nbf`/`aud`/`iss` validation) for Sign in with Workeasy360
  (originally `apps/accounts/workeasy360/oidc.py`, ADR-0013; since 2026-11-16 used through the vendored
  workeasy360-sso connector, which depends on `PyJWT[crypto]`).
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

## workeasy360-sso (`workeasy360-sso==0.3.0`, vendored wheel) — added 2026-11-16, 0.3.0 on 2026-11-17

- **Purpose:** the shared Workeasy360 sign-in connector (an OpenID Connect relying party): authorization code
  flow with PKCE and `private_key_jwt`, offline ID-token and logout-token verification, entitlement re-checks,
  and the OpenID Connect Back-Channel Logout receiver. It replaces Keel's hand-written client
  (`apps/accounts/workeasy360/oidc.py`, removed); Keel's provisioning, session, MFA and enforcement rules stay
  in `apps/accounts/workeasy360/` (docs/workeasy360-sso.md).
- **Why not stdlib or an existing dependency:** it is Workeasy360's own implementation of its product
  contract, shared by every Workeasy360 product, so the protocol and its fixes live in one place. It uses only
  dependencies Keel already has.
- **Source and maintenance:** Workeasy360 engineering (repository `workeasy360-sso`). Not published to an
  index: the wheel is committed in `backend/vendor/` and pinned by hash in `uv.lock` (a `path` source), so
  installs never resolve the name from PyPI (no dependency confusion). Upgrading means replacing the wheel and
  re-locking. `pip-audit` cannot look it up on PyPI; CI audits every other locked package (its dependencies
  included) with `--strict --require-hashes`.
- **License:** proprietary (Digisoft360 / Workeasy360 internal).
- **Transitive footprint:** none new: `Django`, `PyJWT[crypto]` and `httpx`, all already locked.
- **0.3.0 (2026-11-17):** adds only the `w360sso_move_issuer` command used by `move_workeasy360_issuer`;
  no change to sign-in, token verification or back-channel logout. Wheel sha256
  `2a6fe8e66c956e43ee37991349d54c5fa2d4f24f7c19c31d46ba7cae75b9cf1c` (tag `v0.3.0`).
