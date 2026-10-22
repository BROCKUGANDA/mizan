# MIZAN — Continuous HR policy assurance

MIZAN (ميزان, "the balance") checks **every** HR transaction against **every**
written rule on every run with a deterministic engine whose output is
reproducible to the byte. Exceptions explain themselves in plain English or
Arabic, cite the rule and the exact data that broke it, carry a severity, an
owner and a corrective action — and wait for a person to decide. Language
models never decide anything.

## Quick start (3 commands)

```bash
bun install          # install dependencies
bun run seed         # generate the synthetic pack (seed 42) + seed the database
bun run dev          # start the app on :3000
```

Open the app from the **Preview Panel** (or "Open in New Tab"). Judge mode is on:
role switcher, scenario reset, mode simulator, synthetic data only.

## Verify the red lines (offline, no server)

```bash
bun run mizan verify        # census reconciliation + determinism + worked examples 5/5
bun run mizan audit-verify  # hash-chain verification
bun run mizan scan-pii data/pack/transactions.csv   # PII scan (FS-24)
```

## Running on the hidden test file

1. Place the file next to the pack (`data/pack/transactions.csv` is the training stand-in).
2. The mapping profile learns headers through synonym tables; unknown columns go
   to review, missing required columns fail with `MZ-DS-422` before evaluation (FS-09).
3. Run through the UI (Runs → Start run) or start the server and `POST /api/v1/runs`.
4. Export is validated against `finding_format.csv` (FS-20) — the 5 worked examples
   must reproduce exactly on every scored column before the file downloads.
5. Follow runbook RB-05 for the T−72h protocol: freeze the pack, fix only
   normalisation defects, add a regression case for each change, never hand-edit outputs.

## Reproducing the output hash

The engine is pure: no wall clock (the as-of date is an explicit input), no
randomness, integer fils, canonical JSON + SHA-256. The same inputs give the same
`outputHash` — currently `39fb4ed3cecd0944…` for the seeded pack:

```bash
bun run mizan verify   # prints the hash; run it twice, on two machines
```

The run manifest pins packHash, calendarHash, routingHash, gradeLadderHash,
synonymsHash, configHash, flagsHash and input hashes (Runs → detail).

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
   exceptions (EN/AR explanations · severity rubric · routing · SLA) ── human decisions
                         ▼
   audit hash chain (M5 on tamper) · outbox/inbox · exports (FS-20 validator) · analytics
```

- **Engine decides, model explains.** The engine package imports no model code.
  The gateway (`src/lib/gateway`) is off by default (`ai.mode=none` → M1 banners).
- **Modes M0–M5** with precedence and banners; **profiles O1–O6** (judge ribbon,
  shadow, simulation, air-gapped, release freeze, recovery drill).
- **Everything configurable as data**: routing table, UAE calendar, grade ladder,
  synonyms, severity rubric, action library, SLA policy.

## Layout map

| Path | Contents |
| --- | --- |
| `src/lib/domain` | canonical JSON/sha256, integer fils, Asia/Dubai dates + UAE calendar, MZ-* errors |
| `src/lib/pack` | rule pack (13 rules + definition/attestation), finding format, seeded generator, config-as-data |
| `src/lib/normalize` | ingestion pipeline, synonym mapping, DQ codes, quarantine |
| `src/lib/engine` | facts, 12 family evaluators, evaluate + census + output hash, severity, routing |
| `src/lib/explain` | EN/AR templates (8 parts), fact-lock |
| `src/lib/server` | run pipeline (FS-02/03/05/06/07), audit chain, modes, idempotency, export validator, analytics, patterns |
| `src/app/api/v1` | ~24 routes (runs, exceptions+decisions+bulk, rules+drafts+backtest, audit, flags, modes, export, evidence packs) |
| `src/components/mizan` | SADU design system + views (overview, queue, drawer, runs, rules, patterns, audit, settings) |
| `scripts/mizan.ts` | offline CLI: verify, verify-export, gen-pack, audit-verify, mode, dlq, scan-pii |
| `infra/` | docker-compose, Dockerfile, Helm values, k6 profile, SBOM note (boilerplates) |
| `docs/` | submission checklist, deviations, ADRs, runbooks, RAI statement, solution note, pilot plan, demo script |

## Documents

- `docs/SUBMISSION_CHECKLIST.md` — every checklist line → implementation status
- `docs/DEVIATIONS.md` — sandbox adaptations with reasons and integration points
- `docs/adr/` — comparator semantics, duplicate flag, no-payroll-calendar, spike-guard floor
- `docs/runbooks/RB-01..08` — detect/contain/recover/verify/communicate
- `docs/RAI_STATEMENT.md`, `docs/SOLUTION_NOTE.md`, `docs/PILOT_PLAN.md`, `docs/DEMO_SCRIPT.md`, `docs/QA_CARDS.md`
- `worklog.md` — build log
