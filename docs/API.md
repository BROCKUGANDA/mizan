# API summary (/api/v1)

Conventions: JSON camelCase; money as integer fils; errors are RFC 9457
`application/problem+json` with `MZ-` codes and a `retryable` flag; mutating
routes accept `Idempotency-Key`; state changes require `If-Match` (version).
Rate limits are per actor and route class (`MZ-RATE-429` + `Retry-After`).

| Route | Purpose |
| --- | --- |
| GET /system/state · GET/POST /system/mode | boot payload; mode switches (reason; M5 clearance needs chain verification + a second administrator) |
| POST /judge/reset | judge profile: restore seeded state |
| GET /health/live · GET /health/ready | liveness; database/object-store/cache/outbox probes |
| GET /overview | census banner, readiness, hotspots, trends, groups, measured precision |
| GET/POST /datasets · GET /datasets/{id} · GET /datasets/{id}/issues | upload (multipart, kind/source/synthetic), metadata, DQ/quarantine/drift |
| GET /exceptions · GET /exceptions/{key} | queue + detail (evidence, decisions, observations, events) |
| POST /exceptions/{key}/decisions | triage/assign/start/record_fix/verify/dismiss/accept_risk/mark_duplicate/reopen/dispute — If-Match + Idempotency-Key + CoI |
| POST /exceptions/{key}/countersign | second-analyst countersign (If-Match, CoI, different analyst) |
| POST /exceptions/{key}/assignments · /comments | owner assignment; comment/context |
| GET /exceptions/{key}/events | exception audit trail |
| POST /exceptions/bulk | bulk with preview, typed confirmation, 10 s undo |
| GET/POST /runs · GET /runs/{id} | start/read runs, manifests, per-rule census |
| GET /runs/{id}/events | SSE progress (heartbeat; Last-Event-ID resume) |
| GET /runs/{id}/coverage · GET /runs/{id}/diff/{b} | coverage matrix; added/removed/changed findings |
| POST /runs/{id}/cancel | cancel a queued/running run |
| GET /runs/{id}/export | findings.csv (FS-20, Digest) + data_quality.csv + bundle |
| GET /rules · GET /rules/{id}/versions | rules, immutable version history |
| POST /rules/drafts · POST /rules/drafts/{id}/backtest · POST /rules/drafts/{id}/transition | studio: parse, backtest on the exact hash, submit/approve/reject |
| POST /rules/{id}/transition | approve/activate (shadow first)/retire with FS-19 gates |
| GET /rule-packs/export · POST /rule-packs/import | portable YAML with tests + hash; import as drafts |
| GET/POST /patterns · POST /patterns/{id}/review | advisory P01–P10 alerts |
| GET /audit/events · GET /audit/verify · POST /audit/tamper | trail, chain verification, tamper demo (admin) |
| GET/POST /flags | configuration flags with reasons and validation |
| GET /notifications · GET /outbox | notifications with 10/15-min digests; outbox viewer |
| POST /evidence-packs · GET /evidence-packs/{id} | build/download signed packs (per exception/run) |
| GET /analytics/{hotspots|trends|readiness|deadlines|fairness} | projections (small cells suppressed) |
| POST /check | read-only single-transaction pre-flight; no exception written |
| POST /deadlines/tick | run the accepted-risk/SLA tick now (admin/compliance) |
