# MIZAN — Submission checklist status

This is the audit of the current repository against the attached checklist.
Status: ✅ implemented and exercised here · 🟡 implemented but not verified in this
environment · ⛔ out of scope / not built. Nothing is marked ✅ without a command
or test in this repository.

## Red lines

| Line | Status | Evidence / honest limitation |
| --- | --- | --- |
| Census adds up | ✅ | `bun run mizan verify`: 1,061 × 15 clauses = 15,915; applicable + N/A = checks; evaluated + NE = applicable; `assertCensus` in finalize. The banner shows the same arithmetic. |
| Worked examples exact | ✅ | `mizan verify` reproduces 5/5 scored columns from `finding_format.csv`. |
| Findings file valid | ✅ | FS-20 structural validation, enums, IDs, dates, checksum; run snapshots are immutable. Golden rows are required only when the run contains the worked-example transactions; a hidden file is validated structurally. |
| Mutation recall and near-misses | ✅ | `tests/backtest.test.ts` / `mizan bench mutate`: 100% positive recall, 0 near-miss false positives across all 13 rules. |
| Measured precision | 🟡 | Wilson lower bound 0.927 on 49/49 labels confirmed by the independent SQL oracle plus boundary spot-checks (`fixtures/precision/labels.jsonl`). This is **not** the two-human-reviewer protocol; the provenance is labelled in the UI. |
| Determinism | 🟡 | 2/2 identical output hash on this machine and in CI; two-machine comparison was not performed. |
| Every exception cites | ✅ | Rule ID, version, verbatim clause and evidence facts on 100% of findings; fact-lock rejects untraceable text. |
| Every exception is routed | ✅ | Owner, severity rationale and corrective action; CoI routing tested; fallback rationale. |
| Humans decide | ✅ | Engine only creates/reopens/returns expired risk; decisions require a person; High/Critical dismissals need a countersign. |
| The model never decides | ✅ | Engine modules import no gateway/network/clock/random code (`tests/separation.test.ts`); `ai.mode=none` is the default. |
| Synthetic data only | ✅ | Seeded pack, PII scanner on uploads, synthetic confirmation required. |
| One-command start | 🟡 | `bun run seed && bun run dev` works; `docker compose up` was not executed (no Docker daemon here). |
| Deliverables within limits | 🟡 | Video and solution note exist as drafts; runtime/length were not measured here. |

## Section status

| Section | Status | Notes |
| --- | --- | --- |
| 1 Detection | ✅ | 13 compiled rules + definition/attestation/scope note; 12 family evaluators; three declared tests per rule; comparator semantics in ADRs; integer fils; Asia/Dubai; per-column day-month; DQ codes; flood/run/NE guards; clauses; grouping; oracle. |
| 2 Explanations | ✅ / 🟡 | Eight parts, EN/AR templates, fact-lock, neutral terms, caveats, canonical text shared by UI/export/pack. Readability at grade 9 is not measured; the golden examples are longer. Native Arabic review is not recorded. |
| 3 Severity, routing, actions | ✅ | Base + ≤2 modifiers, floor/cap, rationale stored; routing order and table version; SLA business-day deadlines with 75/100/150% escalations; action placeholders checked to zero; digest at >10/15 min; configuration as data; stewardship route; visible fallback. |
| 4 Human in the loop | ✅ | Conservative engine; dismissal reasons + countersign; accepted-risk expiry job; closure with source reference + verification; CoI enforced in API; bulk cap 200, exclusions, typed confirmation, undo; no optimistic decisions; If-Match concurrency. Two-administrator M5 clearance is implemented. |
| 5 Audit and evidence | ✅ | Hash-chained events; hourly verify job; M5 on failure; run manifests with real hashes; per-run immutable finding snapshots; per-exception/run evidence packs with verified signatures stored content-addressed; audit room; export events. Immutable object storage is local (WORM is the production swap). |
| 6 Responsible AI | ✅ | Engine separation test; model-off default; DQ-017 injection tagging; patterns advisory and detector allow-list test; fairness endpoint with <5 suppression; in-product AI statement. Model-off equivalence is structural, not a separate CI run. |
| 7 Security and privacy | 🟡 | Role matrix, CoI, rate limits, security headers, upload limits, formula escaping, secret-free repo, PII scan. OIDC, CSRF, RLS, TLS, vault and SBOM/signing are production tasks (see DEVIATIONS D-2, D-5). |
| 8 Data handling and ingestion | ✅ / 🟡 | Upload, sniffing, header mapping, schema drift, quarantine, dedup, DQ-001…018, synthetic guard, local purge on seed/reset. Arbitrary policy compilation and finding-format import are not built (D-13/D-14). |
| 9 Reliability | 🟡 | One retry helper with full jitter/deadline/budget, timeouts, typed errors, idempotency, outbox/inbox, notification DLQ replay. Runs are synchronous in this deployment; pg-boss, shards, leases/fencing and SIGTERM drain are production tasks (D-6). |
| 10 Caching and paths | 🟡 | Non-authoritative single-flight cache, optional; conditional GET helpers; cold work is CLI/queued. Hot-path p95 under a 50-analyst k6 load was not measured. |
| 11 Active-active and DR | ⛔ | Design and runbooks only; no second site. |
| 12 Performance | 🟡 | 15,915 checks in ~0.3 s; 10k-scale command exists. 1M × 20 across 16 shards, soak and front-end INP were not measured. |
| 13 UI and UX | ✅ / 🟡 | SADU tokens, states, drawers, keyboard shortcuts, command palette, virtualised-ish queue, mode chips, error boundary. Full axe/AT and all screen states are not recorded. |
| 14 Motion | ✅ | Motion tokens, reduced-motion handling, transform/opacity, one-shot census count. |
| 15 Accessibility, Arabic, RTL | 🟡 | Logical properties, RTL shell, bilingual explanations, dual-coded severity. Full Arabic UI coverage and axe/NVDA/VoiceOver are not complete (D-16/D-17). |
| 16 Rule studio | ✅ | Plain English → spec → tests → backtest → submit → second-person approval → shadow run → active; exact-spec hash gates; versions; YAML export/import. |
| 17 Backtesting | ✅ / 🟡 | Golden, mutation, near-miss, format, metamorphic, determinism, oracle and performance gates run in `mizan verify`/CI. Hand-labelling by two people and the T−72h rehearsal are not recorded. |
| 18 Observability | 🟡 | Correlation IDs, structured audit payloads, run/mode/outbox views, health endpoints. Full OpenTelemetry, Prometheus/Grafana and burn-rate alerts are production tasks. |
| 19 Deployment and reuse | 🟡 | Compose/Helm/Docker/API docs exist; not executed. Configuration is data; portable packs work; OpenAPI is documented rather than generated. |
| 20 Submission | 🟡 | README, RAI statement, solution note, pilot plan, demo script and QA cards exist. Hosted link, video, final bundle and checksums are external steps. |
| 21 Demo day | 🟡 | Script and reset exist; the 5-run rehearsal and two drivers are external. |
| 22 Pilot readiness | 🟡 | 12-week plan and metrics exist; shadow pilot, training delivery and DPIA are external. |

## What this audit found and fixed

- Shadow runs no longer route/notify or strip live SLA clocks; backtests write no live exceptions.
- Exception identity uses the internal row ID, so duplicate transaction IDs cannot collide.
- The engine now uses the activated DB pack, not a constant, and the manifest pins real
  pack/calendar/config/flag/input hashes.
- Census arithmetic is asserted in finalize (FS-02); the run-hold condition is the
  specified OR, not a stricter AND.
- Held findings no longer create notifications.
- Exports use immutable per-run snapshots, real SHA-256 bytes, per-(txn,rule,clause)
  golden matching and formula-injection escaping.
- The audit chain is written in the same transaction as decisions; countersign checks
  CoI and If-Match; idempotency is actor/route-scoped with in-progress conflicts.
- Business-day weekends were wrong before 2022 (the 1900 definition overrode 2022);
  fixed and covered by tests.
- Value-bound percentages no longer use a previous delta as the base salary.
- The rule-studio grammar no longer reads "grade 13 or above" as an inclusive amount
  comparator; a regression test covers it.
- Pattern detectors P01–P10 are implemented and tested, including a protected-attribute
  invariance test.
- Fake integration adapters and dry-run samples were removed; there is no write path.
- The CLI `verify` now runs every gate it claims instead of printing PASS without
  executing the validator.
