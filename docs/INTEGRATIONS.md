# Integrations — stubs as seams (production swap guide)

MIZAN ships **stub adapters only**. Connecting to Emirates' live systems, ingesting
real employee data, and changing transactions automatically are **out of scope by
red line** (synthetic-data-only, human-only decisions). Each stub is a working
component with the exact interface the production adapter will implement, so the
swap is config + transport work, not a redesign.

## Adapter catalog

| id | Category | Production target | Env keys (flip to live) | Writes? |
|----|----------|-------------------|--------------------------|---------|
| `hrms` | HRMS | SAP SuccessFactors / Oracle HCM OData pull (grades, org, roles) | `MIZAN_HRMS_MODE=live`, `MIZAN_HRMS_URL`, vault secret | never |
| `finance` | ERP | SAP FI / Oracle Fusion transaction feed (watermark cursoring) | `MIZAN_ERP_MODE=live`, `MIZAN_ERP_URL`, vault secret | never |
| `writeback` | Write-back | Correction proposals applied by humans in the target system | `MIZAN_WRITEBACK=human_approved_api` (still human-gated) | proposals only |
| `identity` | IdP | Entra ID / Emirates IdP OIDC (Auth Code + PKCE), groups→roles | `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` (vault) | never |
| `notify` | Channels | SMTP / Microsoft Graph digests + GRC webhooks | `MIZAN_SMTP_URL`, `MIZAN_WEBHOOK_URL` | never |
| `storage` | Storage | S3 + Object Lock (WORM) for evidence packs | `MIZAN_S3_BUCKET` | never |
| `cache` | Cache | Valkey, TTL reads, never authoritative | `MIZAN_VALKEY_URL` | never |

## Invariants every adapter must keep

1. **Synthetic-only by default.** `*_MODE` env vars default to stub. Live mode is
   an explicit operator act, recorded as an audit event.
2. **Least data.** HRMS pulls only rule-relevant attributes — never nationality,
   bank details, or free-text HR notes. Redaction runs at the boundary.
3. **Integer fils.** Money crosses the seam as integers; floats never enter.
4. **No automatic mutation.** Even `writeback` in `human_approved_api` mode only
   enqueues proposals that the target system's own approval workflow must accept;
   proposer ≠ verifier is enforced in code.
5. **Source hashes in the run manifest.** Every feed contributes `sourceHash` so
   reruns reproduce the same output hash.
6. **Typed failures.** Adapters throw `MZ-DEP-*` errors with `retryable` flags;
   outbound calls use the shared retry helper + breaker, never hand-rolled loops.

## Swap runbook (per adapter)

1. Implement the adapter interface in `src/lib/integrations/<id>-adapter.ts`
   (see the `*LiveAdapter` classes already scaffolded).
2. Register it in `getIntegrationRegistry()` — the Integrations view and health
   probes pick it up automatically.
3. Add the vault-injected secret; never commit it. `configKeys` shows presence,
   masks values.
4. Extend the OpenAPI surface (`docs/API.md`) and add contract tests with the
   stub as the oracle.
5. Record the first live dry-run as an audit event before enabling ingestion.

## API surface

- `GET /api/v1/integrations` — catalog + health + config presence (secrets masked).
- `POST /api/v1/integrations/[id]/dry-run` — role-gated; exercises the stub and
  returns the payload shape + sample; audited as `integration.dry_run`.
