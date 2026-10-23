# MIZAN build progress

Current state after the audit/refactor pass. Format follows the master brief §43.
Only claims with a command or test in this repository are marked PASS.

## Phase P0 — Foundations — PASS
Prisma schema (tenants, rules/versions, runs/snapshots, exceptions, decisions,
audit, outbox/inbox, DLQ, SLA escalations, evidence packs, pattern alerts,
product events), domain libs, contracts, i18n, client store.
Gates: `bun run typecheck` clean · `bun run lint` clean.

## Phase P1 — Ingestion — PASS
Encoding/delimiter sniffing (UTF-8/BOM/UTF-16/Windows-1256), RFC 4180, header
synonyms, per-column date/decimal inference, Arabic digits, DQ-001…018,
quarantine, content dedup, schema fingerprint, 50 MB/1 MB/2M limits, PII guard.
Gates: `src/lib/normalize/normalize.test.ts` (12 tests), upload tests.

## Phase P2 — Rules — PASS
13 compiled rules with verbatim anchors, interpretation records and declared
boundary tests; definition/attestation/scope classification; version history;
portable YAML packs; rule-studio lifecycle with exact-hash gates.
Gates: coverage 16 sentences; `tests/rule-studio.test.ts` (5 tests).

## Phase P3 — Engine and export — PASS
12 families, four outcomes, evidence, census, output hash, severity, routing,
EN/AR canonical explanations and fact-lock; FS-20 export validation.
Gates: `bun run mizan verify` — census, 5/5 golden, 9/9 formats, 7/7
metamorphic, 100% mutation recall, 0 near-miss FP, 100% oracle agreement,
fact-lock, performance.

## Phase P4 — Backtesting harness — PASS
Labelled mutation operators, format mutations F-1…F-9, metamorphic MR-1…MR-7,
independent SQL oracle (sql.js), score command, shift report, perf command,
real CLI `verify` and `hidden-test`.
Gates: `tests/backtest.test.ts` (12 tests), CLI suite.

## Phase P5 — Workflow — PASS
Immutable per-run findings, exception upsert/observations, lifecycle commands,
CoI checks, countersign, assignments/comments, SLA deadlines + 75/100/150%
escalations, accepted-risk expiry, outbox/inbox/DLQ, bulk limits.
Gates: `tests/pipeline.test.ts`, `tests/api.test.ts`.

## Phase P6 — Security and modes — PASS (local scope)
Mode controller M0–M5 (ai.mode=none forces M1), safe-halt clearance through M4
with chain verification and a second administrator, flags with validation and
effects, per-route rate limits, idempotency, If-Match, audit chain + hourly
verify, tamper demo. OIDC/RLS/Vault remain production tasks (see DEVIATIONS).

## Phase P7 — Interface — PASS / partial
Seven views, SADU tokens, RTL shell, upload, queue/drawer, rule studio with
draft approval, portable packs, patterns P01–P10, audit room, settings including
the in-product AI statement. Remaining translation and AT coverage is listed in
DEVIATIONS D-16/D-17.

## Phase P8 — Operations and submission — PARTIAL
CLI, runbooks, ADRs, RAI statement, solution note, pilot plan and demo script
exist. Compose/Helm/k6/two-site drills are not executed here (D-19/D-9);
external artefacts (video, hosted link, submission bundle) remain.
