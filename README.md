# MIZAN — Continuous HR policy assurance

MIZAN (ميزان, "the balance") checks **every** HR transaction against **every**
written rule on every run with a deterministic engine whose output is
reproducible to the byte. Exceptions explain themselves in plain English or
Arabic, cite the rule and the exact data that broke it, carry a severity, an
owner and a corrective action — and wait for a person to decide. Language
models never decide anything.

## Quick start

```bash
bun install
bun run seed      # synthetic pack (seed 42) + seeded SQLite database
bun run dev       # http://localhost:3000
```

Judge mode is on: role switcher, scenario reset, mode simulator, synthetic data
only.

## Verify the red lines (offline, no server)

```bash
bun run mizan verify        # census + determinism + golden 5/5 + mutation recall
                            # + near-miss twins + F-1…F-9 + MR-1…MR-7
                            # + independent SQL oracle + fact-lock + performance
bun run test                # 70+ unit and integration tests
bun run typecheck && bun run lint
bun run mizan audit-verify  # audit hash-chain verification
bun run mizan scan-pii data/pack/transactions.csv
```

The current training output hash is
`ecefa394f4d1237fe2ff513324d563d703dac5346e0a1cfd61cd50ab3dcd0a26`
(1,061 transactions × 15 rule clauses = 15,915 checks, 49 findings, 22
not-evaluable). Run `bun run mizan verify` twice, on two machines, to reproduce
it.

## Running on the hidden test file

1. Put the file anywhere, then run
   `bun run mizan hidden-test <file> [--employees data/pack/employees.csv]`.
   This hashes the input, writes a distribution-shift report, runs the frozen
   pack, validates the findings structurally and records a run manifest with
   the findings checksum under `output/hidden-<sha>/`.
2. Or use Runs → Upload in the UI. Uploads are limited to 50 MB, 1 MB per line
   and 2M rows; they are PII-scanned, content-hashed (dedup), mapped through
   header synonyms and quarantined by DQ code.
3. Export is validated (FS-20). On the training pack the five worked examples
   must reproduce exactly before the file downloads.
4. Follow runbook RB-05 for the T−72h protocol: freeze the pack, fix only
   normalisation/adapters, add a regression case for each change, never
   hand-edit outputs.

## Tests and gates

- `src/lib/engine/*.test.ts` — family semantics and evidence.
- `src/lib/normalize/*.test.ts` — parsing, Arabic digits/dates, decimals, DQ.
- `tests/pipeline.test.ts` — census, shadow/backtest isolation, holds, identity.
- `tests/api.test.ts` — decisions, countersign, CoI, idempotency, audit tamper,
  deadlines, evidence packs, measured precision.
- `tests/api-surface.test.ts` — upload, `/check`, coverage, diff, readiness.
- `tests/rule-studio.test.ts` — draft → backtest → submission → approval →
  shadow run → active, with the exact-hash gates.
- `tests/backtest.test.ts` — golden, mutations, format mutations, metamorphic
  relations and the independent SQL oracle (sql.js).
- `tests/patterns.test.ts` — all ten detectors and the protected-attribute check.

The release gate commands are `typecheck`, `lint`, `test`, `mizan verify` and
`build`; run them locally (or in any CI you attach). This repository ships no
GitHub Actions workflow.

## Architecture (one screen)

```
transactions.csv ┐
employees.csv    ├─► normalise (sniff, RFC4180, synonyms, DQ-001..018, quarantine)
policy_rules.md  │        │
finding_format.csv ┘      ▼
              ┌──────────────────────────────┐
              │ deterministic engine         │  pure: no I/O, no clock, no RNG
              │ scope → NE → check → evidence│  integer fils · canonical JSON · SHA-256
              └──────────┬───────────────────┘
                 census (FS-02) · flood guard (FS-05) · run hold (FS-06) · NE spike (FS-07)
                         ▼
   per-run finding snapshots (immutable) ── exceptions (EN/AR · severity · routing · SLA)
                         ▼
   human decisions (If-Match + idempotency + CoI) ── outbox/inbox ── DLQ replay
                         ▼
   audit hash chain (hourly verify → M5) · evidence packs (hash-anchored) · exports (FS-20)
```

- **Engine decides, model explains.** The engine package imports no model code.
  `ai.mode` defaults to `none` (forces M1, template explanations). `local` and
  `provider` are real OpenAI-compatible adapters requiring explicit endpoints;
  provider output is fact-locked.
- **Modes M0–M5** with precedence and banners; safe halt clears only through M4
  after a passing chain verification and a second administrator's countersign.
- **Profiles O1–O6** (judge ribbon, shadow, simulation/backtest, air-gapped,
  release freeze, recovery drill).
- **Configuration as data**: routing table, UAE calendar, grade ladder,
  synonyms, severity rubric, action library, SLA policy, flags.
- **No stubs for core paths**: SQLite is the local system of record, the local
  object store is content-addressed and immutable, the cache is a real
  single-flight TTL cache, and notifications use a transactional outbox with a
  real DLQ. Live HR system connectors and production OIDC/Postgres/Valkey/S3
  are explicitly out of scope (see `docs/DEVIATIONS.md`).

## Layout map

| Path | Contents |
| --- | --- |
| `src/lib/domain` | canonical JSON/SHA-256, integer fils, Asia/Dubai dates + UAE calendar, MZ-* errors |
| `src/lib/pack` | rule pack (13 rules + definition/attestation), finding format, seeded generator, config-as-data, precision labels |
| `src/lib/normalize` | ingestion pipeline, synonym mapping, DQ codes, quarantine |
| `src/lib/engine` | facts, 12 family evaluators, evaluate + census + output hash, severity, routing |
| `src/lib/explain` | EN/AR templates (8 parts), fact-lock |
| `src/lib/testkit` | mutation operators, format mutations, metamorphic relations, SQL oracle, harness |
| `src/lib/server` | run pipeline, audit chain, modes, idempotency/retry, export validator, analytics, patterns, deadlines, evidence packs, outbox |
| `src/lib/integrations` | *removed*: live connectors are out of scope; there is no write path |
| `src/app/api/v1` | runs, exceptions+decisions+assignments+comments, datasets, rules+drafts+packs, audit, flags, modes, exports, evidence packs, check, analytics |
| `src/components/mizan` | SADU design system + views (overview, queue, drawer, runs, rules, patterns, audit, settings) |
| `scripts/mizan.ts` | offline CLI: verify, bench, hidden-test, gen-pack, audit, dlq, scan-pii |
| `infra/` | docker-compose, Dockerfile, Helm values, k6 profile (not exercised in this environment) |
| `docs/` | checklist status, deviations, ADRs, runbooks, RAI statement, solution note, pilot plan, demo script |

## Documents

- `docs/SUBMISSION_CHECKLIST.md` — every checklist line → implementation status.
- `docs/DEVIATIONS.md` — honest record of what is local, out of scope or unverified.
- `docs/adr/` — comparator semantics, duplicate flag, no-payroll-calendar, spike-guard floor, exception identity.
- `docs/runbooks/RB-01..08` — detect/contain/recover/verify/communicate.
- `docs/RAI_STATEMENT.md`, `docs/SOLUTION_NOTE.md`, `docs/PILOT_PLAN.md`, `docs/DEMO_SCRIPT.md`, `docs/QA_CARDS.md`.
- `worklog.md` — build log.
