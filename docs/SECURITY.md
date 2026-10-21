# Security & privacy summary

- Identity: judge role switcher in the sandbox; OIDC/Entra ID integration point
  (`src/lib/integrations/stubs.ts`) with directory-group → role mapping.
- Authorisation: role matrix enforced per command in the API (never only UI);
  conflict-of-interest refusals audited; two-person rule for approvals and admin grants.
- Tenancy: every table carries tenant_id; cross-tenant access returns 404
  semantics. RLS is a production Postgres feature (DEVIATIONS D-2).
- Audit: append-only hash chain; verification failure → safe halt; tamper demo in the audit room.
- Logs: structured JSON; redaction middleware on audit payloads (names/emails/comments).
- Uploads: 50 MB file / 1 MB line / 2M rows limits; MIME sniffing; PII scanner
  (Emirates ID, passport, IBAN, phone, email) blocks real identifiers.
- Exports: formula-injection escaping (=, +, -, @); Digest header with sha-256;
  evidence packs carry signed manifests.
- Headers/TLS/secrets/vault/SBOM/cosign: configured in `infra/helm/mizan/values.yaml`
  (production path; sandbox uses defaults).
- Model gateway: names redacted before any call; zero-retention contract; kill
  switch (ai.mode) enters M1 within seconds; per-tenant cost cap is a documented
  gateway parameter.
