# Security & privacy summary

- **Identity:** judge role switcher via `X-Mizan-Actor` in this environment.
  This is **not** an authentication boundary. Production must replace
  `resolveActor` with OIDC/Entra ID session validation and add CSRF tokens
  (DEVIATIONS D-5). The role matrix, CoI guard and two-person rules are enforced
  in the API regardless of identity source.
- **Authorisation:** per-command role matrix, row-scoped exception access,
  conflict-of-interest refusals audited, two-person rule for rules and M5
  clearance, second administrator required.
- **Tenancy:** every table carries `tenant_id`; keys are tenant-scoped. The demo
  is single-tenant; RLS is a production Postgres task (D-2).
- **Audit:** append-only hash chain; hourly verification; failure → M5; tamper
  demonstration in the audit room. Decisions write state, audit and outbox in
  one transaction.
- **Logs:** redaction on audit payloads (names/emails/comments) and a generic
  wire error detail with a server-side correlation id.
- **Uploads:** 50 MB / 1 MB per line / 2M rows; magic-byte sniffing; PII scanner
  (Emirates ID, passport, IBAN, phone, email); synthetic confirmation required.
- **Exports:** formula-injection escaping (`=`, `+`, `-`, `@`); real SHA-256
  digest header; immutable per-run snapshots; evidence packs with hash-anchored
  manifests and offline verification.
- **Headers:** CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`,
  `Permissions-Policy`, `frame-ancestors 'none'` in production (embedding is
  allowed only in the preview/dev environment).
- **Rate limits:** per-route token buckets (reads, decisions, uploads, runs,
  exports, `/check`) returning `MZ-RATE-429` with `Retry-After`.
- **Secrets:** none in the repository; environment/vault only. TLS termination,
  object-lock, SBOM and image signing are deployment tasks documented in
  `infra/`.
- **Model gateway:** names redacted before any call; zero-retention provider or
  local endpoint; `ai.mode=none` kill switch enters M1; outputs fact-locked.
