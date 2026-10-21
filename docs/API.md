# API summary (/api/v1)

Conventions: JSON camelCase; money as integer fils; errors are RFC 9457
problem+json with MZ- codes and retryable flags; mutating routes accept
Idempotency-Key; state changes require If-Match (version).

| Route | Purpose |
| --- | --- |
| GET /system/state · GET/POST /system/mode | boot payload; operator mode switches (reason required) |
| POST /judge/reset | judge profile: restore seeded state |
| GET /overview | census banner, readiness, hotspots, trends, groups, precision |
| GET /exceptions · GET /exceptions/{key} | queue + detail (evidence, decisions, observations, events) |
| POST /exceptions/{key}/decisions | commands (triage/assign/start/record_fix/verify/dismiss/accept_risk/mark_duplicate/reopen/dispute) — If-Match + Idempotency-Key + CoI |
| POST /exceptions/{key}/countersign | second-analyst countersign |
| POST /exceptions/bulk | bulk with preview, typed confirmation, 10s undo |
| GET/POST /runs · GET /runs/{id} | start runs, manifests, coverage matrix |
| GET /runs/{id}/export | findings.csv (FS-20 validated, Digest header) + data_quality.csv + bundle |
| GET /rules · POST /rules/drafts · POST /rules/drafts/{id}/backtest · POST /rules/{id}/transition | studio: parse, backtest, two-person activation |
| GET/POST /patterns · POST /patterns/{id}/review | advisory pattern alerts |
| GET /audit/events · GET /audit/verify · POST /audit/tamper | trail, chain verification, tamper demo (admin) |
| GET/POST /flags | configuration flags with reasons |
| GET /notifications · GET /outbox | in-app notifications; outbox viewer (judge) |
| GET /evidence-pack | signed evidence bundle |
| GET /health/ready | liveness + dependency probes |
