# Supply chain (§26)

- Dependencies are pinned via `bun.lock`; `bun install --frozen-lockfile` in CI.
- Dependency and container scans are part of the release checklist (no criticals).
- Each release image ships an SBOM (CycloneDX) generated at build time:
  `syft packages dir:. -o cyclonedx-json > mizan-sbom.json` (target environment;
  the sandbox cannot run container builds).
- Signed images: `cosign sign` / `cosign verify` in the Helm chart (`image.signature.verify`).
- Third-party notices: see `docs/THIRD_PARTY_NOTICES.md`.
- Zero-retention contract for any model provider (§27); the model gateway defaults
  to `none`, and names are redacted before any model call.
