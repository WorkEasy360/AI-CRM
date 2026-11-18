# Dependency notes (ADR-0010)

One entry per runtime dependency added after Phase 1, in the form ADR-0010 requires.

## PyJWT (`pyjwt>=2.15`, locked 2.15.1) — added 2026-10-12

- **Purpose:** sign the RFC 7523 `private_key_jwt` client assertion and verify Workeasy360 ID tokens
  (JWS RS256/ES256, JWK parsing, `exp`/`nbf`/`aud`/`iss` validation) for Sign in with Workeasy360
  (originally `apps/accounts/workeasy360/oidc.py`, ADR-0013; since 2026-11-16 used through the
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

## workeasy360-sso (`workeasy360-sso==0.3.1`, git dependency on a private repository, pinned by commit) — added 2026-11-16, 0.3.1 on 2026-11-17

- **Purpose:** the shared Workeasy360 sign-in connector (an OpenID Connect relying party): authorization code
  flow with PKCE and `private_key_jwt`, offline ID-token and logout-token verification, entitlement re-checks,
  and the OpenID Connect Back-Channel Logout receiver. It replaces Keel's hand-written client
  (`apps/accounts/workeasy360/oidc.py`, removed); Keel's provisioning, session, MFA and enforcement rules stay
  in `apps/accounts/workeasy360/` (docs/workeasy360-sso.md).
- **Why not stdlib or an existing dependency:** it is Workeasy360's own implementation of its product
  contract, shared by every Workeasy360 product, so the protocol and its fixes live in one place. It uses only
  dependencies Keel already has.
- **Source and maintenance:** WorkEasy360 engineering, in the **private** repository
  `WorkEasy360/workeasy360-sso`. Nothing is published to an index, and this repository is public, so it no longer
  carries the package. Since 2026-11-18 `uv.lock` installs it from a git source over SSH,
  `ssh://git@github.com/WorkEasy360/workeasy360-sso.git`, pinned to the full commit SHA of tag `v0.3.1`
  (`a98552f8f37e1e4f1fab1de99cc5b915cb9ed5c1`). Installs therefore never resolve the name from PyPI (no
  dependency confusion), and a moved tag changes nothing. Installing needs read access to that repository:
  developers through their GitHub account, CI and the image build through a read-only deploy key (the Actions
  secret `WORKEASY360_SSO_DEPLOY_KEY`, forwarded to BuildKit's SSH mount). Details are in docs/workeasy360-sso.md,
  "Installing the connector". Upgrading means putting the new tag's commit in `[tool.uv.sources]` and re-locking.
- **Build:** a git dependency is built from source at install time, and the lock does not record build tools. So
  `build-constraint-dependencies` in `backend/pyproject.toml` pins the build backend (hatchling 1.33.0) and its
  dependencies exactly.
- **Audit:** a VCS requirement cannot carry a hash, and the package is not on PyPI. CI's
  `pip-audit --strict --require-hashes` therefore runs on `uv export --no-emit-package workeasy360-sso`, which is
  every other locked package, the connector's dependencies included. The commit pin in `uv.lock` stands in for
  the hash.
- **History:** until 2026-11-18 the wheel was vendored in `backend/vendor/`: 0.2.0 in `1d9f812`, 0.3.0 in
  `2f2a08d`, 0.3.1 in `ce3a07b`, all on `feat/workeasy360-sso-connector` (PR #19). Those commits remain in this
  public repository's history, and in GitHub's `refs/pull/19/head` and `refs/pull/19/merge`. They have not been
  rewritten.
- **License:** proprietary (Digisoft360 / Workeasy360 internal).
- **Transitive footprint:** none new: `Django`, `PyJWT[crypto]` and `httpx`, all already locked.
- **0.3.0 (2026-11-17):** adds only the `w360sso_move_issuer` command used by `move_workeasy360_issuer`;
  no change to sign-in, token verification or back-channel logout. Wheel sha256
  `2a6fe8e66c956e43ee37991349d54c5fa2d4f24f7c19c31d46ba7cae75b9cf1c` (tag `v0.3.0`).
- **0.3.1 (2026-11-17):** WorkEasy360 spelling in the connector's own pages, messages and checks; a
  state-only migration (`workeasy360_sso.0003`, no SQL). No behaviour change. Wheel sha256
  `cc4766ce62b9b1a27819ad2015c618586680bbd8a74367f49f4a33ff67719c94` (tag `v0.3.1`, private repository
  `WorkEasy360/workeasy360-sso`). This was the vendored wheel. The package built from commit `a98552f` has the
  same 42 files with the same contents (compared 2026-11-18).

## Accepted frontend advisories (`pnpm audit`)

`pnpm audit --audit-level=high` runs on every pull request. An advisory can be accepted only by ID, in
`frontend/package.json` (`pnpm.auditConfig.ignoreGhsas`), and only with a record in
`frontend/audit-exceptions.json` naming its owner and review date. CI (`node scripts/audit-exceptions.mjs`)
fails once that date passes, and the daily **Dependency watch** workflow fails as soon as an accepted
advisory names a fixed version.

### GHSA-fc5q-39xc-vjpf (picomatch `<= 4.0.7`, high) — accepted 2026-11-18, review by 2026-12-18

ReDoS through single-branch repeated extglobs. Accepted under the owner's conditional approval after each
condition was checked (2026-11-18, `pnpm-lock.yaml` at next 15.5.29):

- **Installed:** picomatch 2.3.2 (`eslint-config-next` → `@next/eslint-plugin-next` → `fast-glob` →
  `micromatch`) and 4.0.7 (`eslint-config-next` → `@typescript-eslint/…/typescript-estree` → `tinyglobby`).
  Lint only.
- **Not in production:** `pnpm why picomatch --prod` is empty and `pnpm audit --prod` finds no
  vulnerability. The image ships the Next.js standalone server (`.next/standalone`), which carries runtime
  files only. Next's own bundled copy (`next/dist/compiled/picomatch`) runs at request time only to match
  `images.localPatterns` / `images.remotePatterns`. `next.config.ts` sets neither (defaults: `undefined`
  and `[]`), so it is never called.
- **No untrusted input:** the slow regular expressions come from the glob pattern, and every pattern on
  these paths is developer-written lint configuration.
- **No fix:** 4.0.7 is the latest release and the advisory names no patched version.

Owner: platform owner. Remove the ID (and its record) once a fixed picomatch is available.
