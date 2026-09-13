# ADR-0010 — Dependency introduction and supply-chain policy

**Status:** Accepted (2026-09-12); implemented in Phase 1

## Decision
- All dependencies pinned; `uv.lock` and `pnpm-lock.yaml` committed; CI installs from lock files only.
- A new package requires a note in the PR: purpose, why not stdlib/existing dependency, maintainer activity (last release, open security issues), download/adoption, license (permissive only: MIT/BSD/Apache-2.0/ISC/PSF; LGPL only for unmodified dynamic use), transitive footprint.
- Automated: pip-audit and pnpm audit on every PR (fail on high/critical with a fix), Dependabot weekly grouped updates, Trivy on images, CodeQL, gitleaks, GitHub Actions pinned by commit SHA, SBOM (CycloneDX) per release.
- Security releases of Django, DRF, allauth, Next.js and React are applied within 7 days (24 h for actively exploited issues).
- Trivial functionality is written in-house rather than imported.

## Consequences
Slower to add packages, faster to trust them; reproducible builds; a documented trail for every dependency.
