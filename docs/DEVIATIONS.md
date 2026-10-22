# Deviations — sandbox adaptation record

Every deviation lists the reason and the closest compliant alternative or the
documented integration point. The architecture and safety invariants are unchanged.

| # | Deviation | Reason | Integration point / alternative |
| --- | --- | --- | --- |
| D-1 | Single Next.js app (App Router + API routes) instead of the Turborepo monorepo with Fastify api + workers | The sandbox hosts one Next.js 16 service on one port; the preview surface is a single page route | The API layer mirrors the Fastify contract (`/api/v1`, RFC 9457 errors, idempotency, If-Match). Splitting into apps/web + apps/api + workers is mechanical: all logic lives in `src/lib/**` packages with no Next imports |
| D-2 | SQLite (Prisma) instead of PostgreSQL 16 with RLS/partitioning | Sandbox database | Every table carries `tenant_id` and access goes through the repository layer; cross-tenant lookups return the 404-semantics `MZ-AUTH-403`. Swap = change the Prisma datasource + add RLS policies + partitioning; `SKIP LOCKED` queues move to pg-boss |
| D-3 | In-memory cache adapter instead of Valkey | Sandbox | `integrations/stubs.ts` CacheClient interface; `CACHE_DISABLED=true` chaos mode keeps the app correct (caches are never authoritative) |
| D-4 | Local filesystem object store instead of S3/MinIO with WORM | Sandbox | `ObjectStore` interface with `immutability: "worm"` flag; MinIO service is in docker-compose with object lock enabled |
| D-5 | Role switcher (judge accounts) instead of OIDC/Entra ID | Judge profile requires live two-person demos | `integrations/stubs.ts` OIDC_STUB + group→role mapping; the API enforces roles and the CoI guard regardless of identity source |
| D-6 | In-process run pipeline instead of pg-boss queue workers | Sandbox scale (1,061 × 13 checks in seconds) | Job keys, attempts, DLQ table and `mizan dlq` tooling exist; the queue interface is isolated in `run-pipeline.ts` |
| D-7 | Judge Reset truncates the audit chain (production has no reset) | Judge profile O3 needs a <5 s seeded restore between judges | Documented in the route; production deployments expose no reset endpoint |
| D-8 | IBM Plex via font stack preference, not self-hosted files | No network font download in the sandbox | `--font-stack-sans` prefers "IBM Plex Sans"/"IBM Plex Sans Arabic" when installed; self-hosted woff2 + `font-display: swap` is the production path |
| D-9 | Not-evaluable spike guard uses a 50-applicable-check floor for the 5% rate test | A 2-transaction denominator would fire the guard permanently on the demo pack (statistical honesty) | ADR-0006; the 3× baseline count test still applies to small samples |
| D-10 | k6/drills/two-site topology are boilerplate only | Cannot run in the sandbox | `infra/k6/load.js`, Helm values, runbooks RB-03/04/05 |
| D-11 | Determinism self-check re-evaluates the full pack instead of a 1% sample | 15,915 checks evaluate in <2 s; a full pass is strictly stronger | Same gate semantics (FS-03) |
| D-12 | Severity duplicate modifier (both-effective → Critical) requires a payroll calendar; none is provided, so the modifier is skipped with the rationale saying so | EC-F10 principle generalised; inventing a closed-period would be a guess | Add `config/payroll-calendar.yaml` and the modifier activates |
| D-13 | No automated test suite in the repo | Sandbox instruction: no test code | Product verification lives in `mizan verify` / `verify-export` (offline gates) and the FS-20 validator; fixtures are under `fixtures/` |
