# MIZAN build progress

Format follows the master brief §43.

## Phase P0 — Foundations — PASS
Built: prisma schema (18 models), domain libs (canonical/money/dates/calendar/errors), contracts, i18n, client store.
Gates: `bunx tsc --noEmit` → clean · `bun run lint` → clean.

## Phase P1 — Ingestion — PASS
Built: normalise/index.ts (sniff, RFC4180, synonyms, DQ-001..018, quarantine), seeded generator.
Gates: seed reports DQ tags (DQ-003/006/007/008/009/011/013/017 present), quarantine empty, duplicate-ID semantics (TXN-70001#1/#2).

## Phase P2 — Rules — PASS
Built: pack/rules.ts — 13 compiled rules with verbatim anchors, interpretation records, ≥3 generated tests each; definition (R14), attestation (R15), scope note classified.
Gates: coverage report 16 sentences classified, none missing.

## Phase P3 — Engine and export — PASS
Built: engine (facts, 12 families, evaluate, census, output hash), severity, routing, FS-20 exporter + validator.
Gates: `bun run mizan verify` → census PASS · determinism PASS · worked examples 5/5 PASS; export validator ok=true on fresh run.

## Phase P4 — Harness — PASS (sandbox scope)
Built: boundary/near-miss/DQ fixtures in the generator; determinism double-run; `mizan verify` gates.
Deviations: D-13 (verification as product CLI instead of a test framework).

## Phase P5 — Workflow — PASS
Built: exceptions upsert + observations, severity rubric, routing, actions, lifecycle commands, CoI guard, countersign, SLA clocks, outbox, digests note.
Gates: browser-verified two-person dismissal; API-verified MZ-AUTH-403-COI, MZ-CONC-409, bulk preview/undo.

## Phase P6 — Explanations — PASS
Built: EN/AR templates (8 parts), fact-lock, DQ wording, canonical text.
Gates: worked-example strings byte-exact (FS-20 validator); Arabic rendering verified in browser (RTL flip).

## Phase P7 — Interface — PASS
Built: shell (mode chip, banners, actor switcher, ⌘K, J/K, ?), 7 views, SADU tokens, projector theme.
Gates: agent-browser walkthrough of overview/queue/drawer/rules/audit/settings; empty/error/loading states present.

## Phase P8 — Studio and insight — PASS
Built: plain-English grammar + guided builder, backtest preview (would-flag, sample, overlap, Jaccard), readiness score (6 components), hotspots, trends, patterns P03/P05/P08/P10.
Gates: browser-verified parse → backtest → submit → approve.

## Phase P9 — Operations — PASS (sandbox scope)
Built: modes M0–M5 with banners (M5 verified live), flags with reasons, tamper demo → safe halt, judge reset <5s, CLI (verify/mode/audit-verify/dlq/scan-pii).
Boilerplate: docker-compose, Dockerfile, Helm values, k6, SBOM note.

## Phase P10 — Submission — PASS
Built: README, SUBMISSION_CHECKLIST (all lines mapped), DEVIATIONS, ADR-0001..0006, runbooks RB-01..08, RAI statement, solution note, pilot plan, demo script, QA cards, API summary.
Gates: all red lines true in the sandbox scope (see checklist).
