# MIZAN Build Worklog

Single shared worklog. Every agent MUST read this file before starting and append a section when done.

Project: MIZAN v1.0 — continuous HR policy assurance prototype (Emirates Group HR challenge), built as a Next.js 16 fullstack app in the sandbox.

## Sandbox adaptation contract (binding for all agents)

- Stack: Next.js 16 App Router + TypeScript + Tailwind 4 + shadcn/ui (components in `src/components/ui`), Prisma + SQLite (`src/lib/db.ts`), API routes under `src/app/api/v1/**` (NOT server actions).
- The ONLY visible page is `src/app/page.tsx` — all views are client-side tabs/views inside one page shell. API routes are fine.
- External infra (Postgres RLS, Valkey, MinIO, OIDC, model providers, Helm, docker) is stubbed behind interfaces in `src/lib/integrations/**` with documented integration points. Boilerplates live in `infra/`.
- Engine is pure TypeScript (no I/O, no clock, no randomness, integer fils, canonical JSON SHA-256) in `src/lib/engine/**`.
- Design language: "SADU" — warm sand neutrals, deep red primary (Emirates-inspired), amber/emerald/red severity, IBM Plex-preferred font stack, RTL Arabic first-class. No indigo/blue.
- Worklog discipline: append `---` sections per Task ID. Do not overwrite.

---
Task ID: 0
Agent: orchestrator (Z.ai Code)
Task: Digest MASTER_PROMPT (19 parts) + Edge-case/failsafe document + submission checklist; set up plan.

Work Log:
- Read both uploaded documents fully (build brief 36,635 words; failsafe modes/runbooks/180 edge cases; red-line checklist).
- Defined sandbox-adapted architecture (above) and 15-task build plan.
- Created worklog.

Stage Summary:
- Deliverable: full MIZAN vertical slice with stubs for inapplicable infra. Engine determinism, census (FS-02), FS-20 export validator, hash-chained audit, modes M0–M5, profiles O1–O6, judge mode with Reset, EN/AR RTL UI, rule studio, backtest preview, pattern alerts, CLI + infra/docs boilerplates.

---
Task ID: 1-9
Agent: orchestrator (Z.ai Code)
Task: Backend core — domain, pack, engine, explanations, server, API routes.

Work Log:
- Prisma schema (18 models) pushed to SQLite; domain libs: canonical JSON/sha256, integer-fils money, Asia/Dubai dates + versioned UAE calendar + SLA clocks, MZ-* typed errors.
- Synthetic pack generator (seed 42): 1,061 txns, 270 employees, 13 compiled rules (R01-R13) + definition/attestation/scope-note, finding_format.csv with 5 worked examples. Tuned natural fail rate to 52/1061 (4.9%, under FS-06 hold).
- Normaliser: RFC 4180, delimiter/encoding sniff, synonym mapping, DQ-001..018, quarantine, duplicate-ID semantics.
- Engine: facts/indexes, 12 family evaluators, scope→NE→check order, census (FS-02), output hash, determinism double-run check (FS-03), severity rubric (≤2 steps, floor/cap), routing resolver (override→table→overlay→CoI→fallback), action library with placeholder fill.
- Explanations: EN/AR 8-part templates, exact-match worked examples, DQ wording, canonical text, fact-lock (FS-14); model gateway none/local/provider with redaction.
- Server: hash-chained audit + verify + M5 on failure, idempotency keys, If-Match concurrency (MZ-CONC-409), mode controller M0-M5, flags with reasons, run pipeline (flood guard FS-05, run hold FS-06, NE spike FS-07, exception upsert + observations + DQ exceptions + outbox), FS-20 exporter + validator, rule studio grammar + backtest + two-person activation gate (FS-17/19), patterns P03/P05/P08/P10 advisory, analytics (readiness 6 components, hotspots, trends, Wilson LB precision).
- API: ~24 routes under /api/v1 (system/state+mode, judge/reset, overview, exceptions+decisions+countersign+bulk+undo, runs+export, rules+drafts+backtest+transition, patterns+review, audit events/verify/tamper, flags, notifications, outbox, evidence-pack, health/ready).

Stage Summary:
- bun scripts/seed.ts seeds everything; census reconciles; worked examples detected exactly (WX-1001:R04, WX-1002:R06, WX-1003:R09, WX-1004:R08, WX-1006:R11).
- All /api/v1 routes typecheck. UI shell + views are the next tasks (2-a/2-b/2-c).

---
Task ID: 2-c
Agent: ui-rules-audit-settings
Task: Rules studio, Patterns, Audit, Settings views

Work Log:
- Read worklog + shared infra (store.ts, use-i18n, primitives) and probed every consumed API route handler directly (rules, drafts, backtest, transition, patterns, audit/events, audit/tamper, flags, system/mode, system/state, outbox, runs, evidence-pack) to lock payload shapes before writing UI.
- Created src/components/mizan/views/rules-view.tsx (showpiece): Rules tab with rule pack list (id + title + status/ShadowChip) and detail pane — verbatim clause quote, "How MIZAN reads this rule" card (ambiguity chips as disabled buttons with chosen reading highlighted, comparator-semantics rows, locale notes), scope + family-parameter definition grid (font-mono), generated tests table with outcome badges (PASS ok / FAIL high / NOT_APPLICABLE muted / NOT_EVALUABLE hold), approvals + lifecycle (Approve for policy_approver/admin with amber two-person Alert on MZ-RULE-403-SELF; shadow-first Activate when ≥1 approval, then "Go active"; inline errors). Draft tab works with the model OFF: plain-English textarea + 3 example hints + guided-builder disclosure (family/txn-type/threshold/grade/maxDays/max), parse via POST /rules/drafts ({text} or {guided}), interpretation card equivalent, backtest panel (big would-flag number, rate %, flood-risk badge, overlap table with jaccard, 10-row sample table, monthly mini bars), Submit for approval, coverage card (total/compiled/definitions/attestations/scopeNotes).
- Created patterns-view.tsx: advisory Alert banner ("Pattern alerts never appear in exports or routing" + Advisory-only badge), alert cards with patternId chip, neutral text, detailJson key/value grid, status badge, Promote/Monitor/Dismiss with idempotency-key, promote toast "Draft created in the rule studio", reviewed-by/at display, empty state.
- Created audit-view.tsx: verification strip (green "Hash chain verified — N events, head <8 chars>" / red "Integrity failure at seq X — safe halt (M5)"), sticky-header events table (max-h-[60vh], seq/actor/type chip/entity/hash truncated, type-prefix + entity filters), chain visualisation (first 40 events as connected blocks, red block + tooltip at firstBadSeq), admin-only tamper demonstration (warning AlertDialog → POST /audit/tamper → tamperedSeq + verify result + refresh, queries invalidated so the strip shows the failure).
- Created settings-view.tsx (Flags/Modes/Outbox/Evidence): flags table with per-row edit Dialog (boolean Select or free-text input, reason ≥5 chars, POST /flags, invalidate) and read-only note for non-privileged roles; mode chip + M0–M5 explainer list from t(`mode.Mx`) + operator switcher (admin/compliance_lead, POST /system/mode, invalidates ["system-state"], inline ApiError, M5 caution); outbox viewer (channel chips inapp active vs stubs, status badges, payload truncated 80, scrollable); evidence packs (run:<latestRunId> from /runs or pasted exception key, GET /evidence-pack, Blob download evidence-pack.json, manifest SHA table 16 chars, offline-verify note).
- Role awareness via useAppStore().actor + ["system-state"] actor lookup (shared query key with the shell); loading/empty/error states everywhere; ARIA labels on icon buttons; SADU tokens only, no indigo/blue; p-4/p-6, gap-4/6, max-h + overflow on long lists.
- Fixed my-side types only: api() declares body as `RequestInit & { body?: unknown }` whose intersection collapses to BodyInit, so each view has a documented postJson() adapter; interpretation card falls back to the top-level `interpretations` pack map because seed rows store interpretationJson={} ; backtest POST normalizes the draft spec with effective/source defaults (backend bug workaround, see below).
- bunx tsc --noEmit: 0 errors in the four files; bun run lint: 0 problems in the four files (remaining lint errors are in pre-existing files owned by other tasks). Probed all flows live: rules GET, plain parse (understood/2 ambiguity chips/3 tests), guided parse, backtest 200 (wouldFlag 3, rate 0.3%, overlap R04 jaccard 1, sample + monthly), draft submit, approve as policy-approver (403 for policy-author), patterns/audit/flags/mode/outbox/runs/evidence-pack all match the UI contracts. NOTE: dev server 500s at the moment of writing are caused solely by the still-missing sibling file views/exception-drawer (task 2-a); queue-view landed during this task.

Stage Summary:
- Deliverable: rules-view.tsx, patterns-view.tsx, audit-view.tsx, settings-view.tsx — all "use client", default-export, no props, wired to /api/v1 with TanStack Query + shadcn/ui + SADU primitives.
- Contract issues for orchestrator (no backend files touched by 2-c): (1) POST /rules/drafts (grammar and guided builder) returns a spec missing required RuleSpec fields effective{from,dateBasis} and source.anchor → POST /rules/drafts/{id}/backtest 500s (MZ-INT-500 "rule.effective.from"); the view patches these client-side before backtesting — backend should emit them (Task 1-9). (2) Seed stores rule.interpretationJson as {} while GET /rules also returns the authoritative `interpretations` map; view prefers the map — seed could store the real record (Task 0/1-9). (3) GET /audit/events ignores ?limit>200 silently and filters type/entity by exact match server-side; the view filters client-side by prefix/substring instead. (4) Probe runs left benign demo state: one approval on R01 and a few rule drafts.

---
Task ID: 2-a
Agent: ui-overview-runs
Task: Overview + Runs views
Work Log:
- Read worklog + shared infra (store.ts api/v1/useAppStore, use-i18n t/locale/iso, primitives, contracts) and backend payloads: /api/v1/overview (census from countsJson + holds/outputHash, readiness 6 components, hotspots w/ suppressed flag, trends, topGroups from headlineEn, coverageReport with total, Wilson measuredPrecision, patternsSummary), /api/v1/runs GET/POST (idempotency-key header, 202), /api/v1/runs/[id] (manifest + perRule), /api/v1/runs/[id]/export (bundle: validation + findingsCsvB64 + dataQualityCsvB64 + manifest).
- Created src/components/mizan/views/overview-view.tsx: full-width census banner (reconciliation sentence "X transactions × Y rules = Z checks · A applicable · B evaluated · C not evaluable · D failed" with font-mono Num badges, secondary stats passed/notApplicable/quarantined/held/dqExceptions, truncated-16 outputHash + asOf + run-status chip, hold Alerts in hold-styling); null-census EmptyState + "Start run" (POST /runs body {}, idempotency-key=crypto.randomUUID(), invalidateQueries + toast, LoadingSkeleton while pending); readiness card (total/100 big mono, per-component weight + Progress + note, nextBestAction in brand-accent box); open-by-severity card (4 SeverityBadge rows + open/all totals); hotspots Table in max-h-72 overflow (suppressed rows hatch-suppressed + title "fewer than 5", count text "fewer than 5"); trends pure-CSS grouped bar chart (4 severity bars, max 48px proportional heights, month label + total, suppressed months hatched, legend, role="img"); top-groups clickable rows (setSelectedException(null) + setView("queue")); coverage & governance card (total sentences classified, 4 stat tiles compiled/definitions/attestations/scopeNotes with anchor lists, Wilson lowerBound as % with decided/confirmed + method, patternsSummary advisory line). Grid grid-cols-1 lg:grid-cols-3 gap-6, cards p-6 (shadcn), section titles text-sm font-medium text-muted-foreground, LoadingSkeleton/ErrorState(+code)/EmptyState on every surface, all digits/dates via iso(), AR labels via t()/locale ternaries.
- Created src/components/mizan/views/runs-view.tsx: start-run controls (kind Select standard|shadow|backtest + native date Input for asOf + Start button, POST /runs with idempotency key, auto-selects new run, toast); live strip when newest run RUNNING/FINALIZING (refetchInterval 3000 via query fn callback, role="status" aria-live, "Still working…" + stages stepper with details + counts summary); run history newest-first (keyboard-accessible role="button" rows: id mono, kind badge (shadow dashed), status chip mapping COMPLETED→ok / *_WITH_HOLDS→text-hold / *_WITH_DQ→sev-medium / FAILED→destructive, asOf, counts summary, holds count, startedAt, truncated outputHash); selected-run detail query (refetchInterval 3000 while active): manifest definition grid (packHash/calendarHash/routingHash/gradeLadderHash/synonymsHash/configHash/flagsHash/engineVersion/packVersion, font-mono text-xs), holds Alerts, per-rule coverage matrix table (total/pass/notApplicable/notEvaluable/failed, max-h-72 scroll); FS-20 export panel (enabled only for COMPLETED* runs; otherwise explanatory note; loading skeleton / ErrorState / green ok Alert "Export validator passed — N/N worked examples reproduced" with profileVersion + findingsSha256, or destructive Alert + structuralErrors list + column/expected/actual mismatch table font-mono text-xs; Blob downloads via atob→Uint8Array named findings-<runId>.csv / data_quality-<runId>.csv, findings disabled unless validation.ok, aria-labels).
- Fixed a JSX ternary-nesting syntax error in runs-view (detail/empty-state branch) found by tsc.
- API-contract note: api() types `body` as RequestInit's BodyInit slot, so JSON object bodies need a cast; added a local `jsonBody` helper in each view (did NOT modify store.ts per instructions — shell page.tsx line 104 has the same pre-existing issue).
- Verification: `bunx tsc --noEmit` → zero errors in overview-view.tsx/runs-view.tsx (remaining project errors are in other agents' pending files: page.tsx imports of queue-view/settings-view/exception-drawer, rules-view, patterns-view, examples/, skills/); `bun run lint` → zero problems in my files (4 pre-existing errors elsewhere).

Stage Summary:
- Deliverables: src/components/mizan/views/overview-view.tsx + src/components/mizan/views/runs-view.tsx (only files created; no existing file modified).
- Overview: census FS-02 banner, readiness score, open-by-severity, hotspots w/ small-cell suppression hatching, CSS severity trends, top groups drill-down to queue, coverage/governance + Wilson precision.
- Runs: start run (kind/as-of/idempotent), live pipeline strip w/ 3s polling, run history, manifest + per-rule matrix + holds, FS-20 export validation report + CSV downloads.
- EN/AR + RTL-safe (mirror-x stepper chevrons), digits via iso(), SADU tokens only (no indigo/blue, no raw hex), a11y (roles, aria-labels, aria-live, keyboard-operable rows), no page-level padding added (shell owns it).

---
Task ID: 2-b
Agent: ui-queue-drawer
Task: Queue view + exception drawer
Work Log:
- Read worklog contracts + store.ts (api/v1/useAppStore/ApiError), use-i18n, primitives, command-palette; read all exceptions/bulk/countersign/decisions/runs API routes and schema to lock payload types.
- Created src/components/mizan/views/queue-view.tsx: filter toolbar (severity checkboxes, status select open/all/specific, ruleId/ownerTeam/q debounced inputs), "Showing N of M" count, Table in max-h-[70vh] scroll container with sticky header, locale-aware headlines, hold badge (tooltip) + "no longer detected" badge per row, overdue due-dates in sev-critical, row click/focus/Enter opens drawer via setSelectedException.
- J/K via "mizan-queue-nav" window events (detail.dir ±1 from shell): clamped highlight index, bg-accent + aria-selected rows, scrollIntoView({block:"nearest"}); Enter opens highlighted row (guarded against inputs/buttons/dialogs).
- Bulk bar (>=1 selected, cap 200 + inline warning): command select (dismiss/triage), reason category select (4 values EN/AR), reason textarea with 15-char counter, Preview -> Dialog with eligible/excluded lists + typed confirmation equal to confirmTextRequired ("BULK <n>", shown as hint) -> Confirm; 10s Undo bar (fixed, countdown, POST undoOf). Start-run mutation on the no-run empty state (queue.empty.noRun) with Idempotency-Key; Clear-filters empty state (queue.empty).
- Created src/components/mizan/views/exception-drawer.tsx: controlled Sheet (side flips with dir for end behaviour, w-full max-w-2xl), query ["exception", key]; header displayId + severity/status badges + "R04 · C1 · v1.0.0" rule chip + evidenceHash/txn/watchers; noLongerDetected + heldReason banners.
- All 8 explanation parts: headline h2, "what broke" = explanation block[1] (split "\n\n"), rule quote (clauseText 13px + requirement), evidence table (locale display, source chips, breaching rows bg-sev-critical/10 + flag icon, comparison line, related txns), why-it-matters = block[3], suggested action (accent box), routing + severity rationale cards, caveats list (code chips).
- Decisions contextual per status (triage/assign/dismiss/accept_risk/mark_duplicate/start/record_fix/verify/fail_verification/reopen) with inline per-command forms + client validation mirroring MZ-VAL-422 rules; every POST sends If-Match W/"<version>" + fresh Idempotency-Key, spinner "Saving decision…" until server confirms, no optimistic status; MZ-CONC-409 -> destructive alert with server version + Reload (refetch), MZ-AUTH-403-COI -> alert + reassignment hint, others generic with code.
- pendingCountersign -> amber alert + Countersign button (errors inline, disabled after failure, self-countersign message surfaces). Bottom tabs Decisions/Observations/Timeline/Siblings (max-h-48 scroll), siblings switch selection. RTL: logical spacing everywhere, Arabic explanation text when locale=ar.
- Fixed all react-compiler lint rules in my files: replaced reset-effects with derived bulk-selection state (scoped to filter set) and a keyed remount of the drawer body; ref update moved into effect; api() JSON bodies cast via local asBody helper (RequestInit intersection types JSON objects poorly — shell has the same pre-existing issue).
- Verified end-to-end with curl: triage decision (ok/status/version/pendingCountersign), stale If-Match returns MZ-CONC-409 + currentVersion=2, countersign without pending dismissal returns MZ-VAL-422, bulk preview excludes non-TRIAGED, judge/reset restores seed. bunx tsc --noEmit and bun run lint clean for both files.

Stage Summary:
- Deliverable: queue-view.tsx + exception-drawer.tsx (the only files created/modified besides worklog.md). Queue and drawer are fully wired to the Task 1-9 API: filters/pagination fields, bulk preview/confirm/undo, decisions with concurrency+idempotency, countersign gate, tabs, EN/AR RTL.
- Contract issues found (backend, task 1-9 scope): (1) POST /exceptions/bulk hardcodes status "DISMISSED" for every eligible item even when command=triage (audit payload says TRIAGED — update data should honour body.command); (2) bulk requires reasonCategory+reasonText>=15 even for triage (UI follows, but contract may not intend it); (3) GET /exceptions list route computes a nonsense pendingCountersign ternary that always yields undefined (dead code, harmless); (4) Sheet component supports only top/right/bottom/left — drawer maps side="end" to right/left via dir; (5) lib/client/store api() types body as RequestInit["body"] so JSON objects need a cast — consider widening the shared helper to `body?: unknown`.

---
Task ID: 3
Agent: orchestrator (Z.ai Code)
Task: Integration fixes after UI agents, FS-20 hardening, docs, infra, CLI, final verification.

Work Log:
- Fixed subagent-flagged contracts: api() body typing; bulk route honours command (triage no longer forces DISMISSED, reason only required for dismissal); removed dead pendingCountersign; draft specs now carry effective/source for backtests; seed persists interpretation records; role-dependent query keys (audit/patterns).
- Engine fixes: R03 clauseId param bug (was throwing → caught as NE), canonicalId zero-stripping identity bug, ancestor-walk cycle guard, approver eligibility = active-at-approval-time, EC-B06 Arabic decimal/thousands separators, duplicate slots effectiveDate.
- Tuned pack natural fail rate to 52/1061 (4.9%) so FS-06 run hold stays clear; spike guard ADR-0006 (50-check floor + 3× baseline count).
- FS-20: fixed why_it_matters prefix + duplicate effectiveDate slot → validator ok=true 5/5 (verified live in the Runs view export panel).
- Verified in browser: census reconciliation, queue + drawer 8-part explanation, triage → dismiss Critical → countersign by second analyst, MZ-AUTH-403-COI (API), audit hash chain + tamper demo → M5 banner + mode chip, judge Reset → M0, Arabic RTL full mirror, rule studio parse→backtest (Jaccard 1.0 vs R04)→submit→approve, Runs export panel with FS-20 pass, bulk preview/undo, projector/theme, ⌘K palette.
- Deliverables: mizan CLI (verify/verify-export/gen-pack/audit-verify/mode/dlq/scan-pii) — verify gates all PASS; infra/ boilerplates (compose, Dockerfile, Helm values, k6, SBOM); docs (README, SUBMISSION_CHECKLIST mapping every red line, DEVIATIONS D-1..D-13, ADRs 0001–0006, runbooks RB-01..08, RAI_STATEMENT, SOLUTION_NOTE, PILOT_PLAN, DEMO_SCRIPT, QA_CARDS, API, SECURITY, PROGRESS, licence + third-party notices); lint ignores for boilerplate dirs.

Stage Summary:
- All red lines pass in sandbox scope. Final state: seed 42 pack → 15,915 checks, 52 findings, 7 DQ exceptions, outputHash 39fb4ed3cecd0944 (deterministic across seed/server/CLI), FS-20 5/5, readiness 80/100.
---
Task ID: 4
Agent: orchestrator (Z.ai Code)
Task: UI/UX polish + hardening + Emirates-vibe themes + integration stubs (live systems / real data / auto write-back as documented seams)

Work Log:
- Integrations (stubs as seams): src/lib/integrations/{hrms-adapter,finance-adapter,writeback-adapter,registry}.ts — HrmsStubAdapter/LiveAdapter (SuccessFactors/Oracle HCM seam, least-attributes, sourceHash), ErpStubAdapter/LiveAdapter (integer fils, watermark cursoring seam), writeback adapter that CANNOT mutate (proposals only, proposer≠verifier enforced in code, env MIZAN_WRITEBACK=human_approved_api still human-gated), registry with 7 entries (hrms/finance/writeback/identity/notify/storage/cache) incl. OIDC/notify/cache seams from stubs.ts, env-key presence check (secrets masked). API: GET /api/v1/integrations + POST /api/v1/integrations/[id]/dry-run (role-gated compliance_lead/team_lead/auditor/admin, audited as integration.dry_run, returns payload shape+sample). docs/INTEGRATIONS.md (swap runbook + invariants).
- New Integrations view (nav between Audit and Settings, ViewKey extended): synthetic-only banner, write-back spotlight ("changing transactions automatically is impossible by design"), 6 adapter cards with production target/guardrails (EN+AR)/config checklist/health/dry-run with sample JSON viewer; analyst role gets 403 error state, compliance lead succeeds; verified dry-run audit events in hash chain (seq 35-40, chain ok).
- Emirates-vibe themes: 6 accent packs (emirates/oasis/pearl/dawn/majlis/saffron) as data-accent on <html>, light+dark variants, severity colors untouched; Sadu CSS motifs (sadu-strip header top edge, sadu-strip-fine footer, sadu-band empty-state ornament, gold-rule, brand-mark gradient+gold ring); animated nav-underline (RTL-safe logical props); accent preview dots in theme menu + command palette (theme group added); persisted via localStorage mizan-accent.
- UI/UX polish: AnimatePresence view transitions (0.2s fade/slide, useReducedMotion honored), EmptyState gets sadu-band, footer sadu-strip-fine + safe-area, error.tsx global boundary (digest + retry, sadu dressing), i18n keys for integrations + themes (EN/AR).
- Hardening: next.config security headers (CSP default-src self, HSTS, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy, poweredByHeader off) — verified via curl; rate limiting MZ-RATE-429 in withApiRoute via lib/server/rate-limit.ts (token bucket 300 cap/10 rps per actor, dry-run 10/min tighter bucket, sweep, verified 429 after 10 dry-runs).
- Bug found+fixed: next-themes ThemeProvider was never mounted (pre-existing) — setTheme was a no-op so dark mode silently did nothing; added MizanThemeProviders wrapper in layout. Bug found+fixed: accent packs overrode --accent/background in dark mode → invisible active-nav text (light on light); scoped light packs to :not(.dark).
- Verified E2E (agent-browser): overview/queue/drawer render, oasis+saffron+dark apply live with correct contrast, Arabic RTL mirrors the whole shell incl. integrations view (AR note localization added), dry-run 403 for analyst / success for compliance lead, queue+drawer regression pass after page.tsx rewrite, console clean, lint+tsc clean.

Stage Summary:
- New files: integrations adapters/registry, 2 API routes, integrations-view.tsx, error.tsx, docs/INTEGRATIONS.md; Modified: globals.css (accent packs+Sadu+gold tokens), theme-provider (accents+NextThemes wrapper), layout.tsx, page.tsx (nav/footer/transitions), store (ViewKey), i18n (34 keys), command-palette (theme group), primitives (EmptyState), server/api (rate limit), next.config (headers).
- Red lines upheld: synthetic-only (stubs refuse live without env+URL), human-only decisions (write-back renders proposals, proposer≠verifier in code), every dry-run audited.
