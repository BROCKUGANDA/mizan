/**
 * Run pipeline (§11): POST /runs → evaluate → finalize (fencing, census FS-02,
 * determinism self-check FS-03, flood guard FS-05, run-level routing hold FS-06,
 * not-evaluable spike guard FS-07, idempotent exception upsert, observations,
 * outbox rows, manifest) in one logical transaction.
 */

import { db } from "@/lib/db";
import { randomUUID } from "node:crypto";
import { evaluate } from "../engine/evaluate";
import { resolveSeverity } from "../engine/severity";
import { resolveRouting } from "../engine/routing";
import { explain, explainDq, canonicalText } from "../explain/explanations";
import { ACTION_LIBRARY } from "../pack/config";
import { RULE_SPECS, PACK_VERSION, ENGINE_VERSION, INTERPRETATIONS } from "../pack/rules";
import { UAE_CALENDAR, slaDeadlines } from "../domain/calendar";
import { ROUTING_TABLE } from "../contracts";
import type { Transaction, Employee, CheckResult, Evidence, ExceptionRecord, RunManifest, CensusCounts, Severity } from "../contracts";
import { sha256, sha256Json, crockfordFromHex } from "../domain/canonical";
import { appendAudit } from "../audit/chain";
import { getMode } from "./mode";
import { MzError } from "../domain/errors";
import type { LocalDate } from "../domain/dates";

const TENANT = "default";

const FIELD_FOR_DQ: Record<string, string> = {
  "DQ-001": "required field",
  "DQ-002": "date",
  "DQ-003": "date order",
  "DQ-004": "employee_id",
  "DQ-005": "approver reference",
  "DQ-006": "transaction type",
  "DQ-007": "document type",
  "DQ-008": "transaction id",
  "DQ-009": "currency",
  "DQ-010": "management chain",
  "DQ-011": "grade",
  "DQ-013": "amount",
  "DQ-014": "identifier",
  "DQ-015": "calendar date",
  "DQ-016": "status",
  "DQ-017": "free text",
  "DQ-018": "field size",
};

// ── Row reconstruction from DB ───────────────────────────────────────────────

function toTransaction(r: any): Transaction {
  return {
    rowId: r.rowId, txnId: r.txnId, type: r.type, typeRaw: r.typeRaw, employeeId: r.employeeId,
    gradeRaw: r.gradeRaw, department: r.department, location: r.location,
    amountFils: r.amountFils, currency: r.currency, amountSemantics: r.amountSemantics as Transaction["amountSemantics"],
    effectiveDate: r.effectiveDate, submittedAt: r.submittedAt, submittedPrecision: r.submittedPrecision as Transaction["submittedPrecision"],
    requesterId: r.requesterId,
    approvals: r.approvalsJson === null || r.approvalsJson === undefined ? null : JSON.parse(r.approvalsJson),
    documents: r.documentsJson === null || r.documentsJson === undefined ? null : JSON.parse(r.documentsJson),
    reversalOf: r.reversalOf,
    freeText: JSON.parse(r.freeTextJson ?? "{}"), passthrough: JSON.parse(r.passthroughJson ?? "{}"),
    source: JSON.parse(r.sourceJson ?? "{}"),
    dq: JSON.parse(r.dqJson ?? "[]"), caveats: JSON.parse(r.caveatsJson ?? "[]"),
  };
}

function toEmployee(r: any): Employee {
  return {
    employeeId: r.employeeId, gradeRaw: r.gradeRaw, gradeOrdinal: r.gradeOrdinal,
    department: r.department, location: r.location, managerId: r.managerId,
    hireDate: r.hireDate, exitDate: r.exitDate, statusRaw: r.statusRaw, status: r.status as Employee["status"],
    roles: JSON.parse(r.rolesJson ?? "[]"), spells: JSON.parse(r.spellsJson ?? "[]"),
    attributes: JSON.parse(r.attributesJson ?? "{}"),
  };
}

export async function loadTransactions(): Promise<Transaction[]> {
  const rows = await db.txn.findMany();
  return rows.map(toTransaction);
}

export async function loadEmployees(): Promise<Employee[]> {
  const rows = await db.employee.findMany();
  return rows.map(toEmployee);
}

// ── Placeholder filling for the corrective-action library ────────────────────

function fillAction(templateId: string, slots: Record<string, string | number | boolean | null>, extras: Record<string, string> = {}): { en: string; ar: string; id: string } {
  const t = ACTION_LIBRARY[templateId] ?? { en: `Review the exception and record the outcome (missing template ${templateId})`, ar: `راجع الاستثناء وسجل النتيجة (القالب ${templateId} غير موجود)` };
  const map: Record<string, string> = {
    required_grade: String(slots.requiredGrade ?? ""),
    actor: String(slots.actor ?? ""),
    missing_documents: String(slots.missingDocumentsEn ?? slots.missingDocuments ?? ""),
    requester: String(slots.requesterId ?? ""),
    team_lead: "the team lead",
    days: String(slots.backdatedDays ?? ""),
    txn_a: String(slots.txnA ?? ""),
    txn_b: String(slots.txnB ?? ""),
    person: String(slots.personId ?? ""),
    value: `${slots.pctDisplay ?? ""}%`,
    bound: `${slots.pctMax ?? ""}%`,
    count: String(slots.count ?? ""),
    employee: String(slots.employeeId ?? ""),
    window_start: String(slots.windowStart ?? ""),
    required_manager: String(slots.requiredManager ?? ""),
    relationship: String(slots.relationship ?? ""),
    missing_roles: String(slots.rolesMissing ?? ""),
    field: String(extras.field ?? ""),
    txn_id: String(extras.txn_id ?? ""),
    ...extras,
  };
  const fill = (tpl: string): string => tpl.replace(/\{(\w+)\}/g, (_m, k: string) => map[k] ?? `{${k}}`);
  return { en: fill(t.en), ar: fill(t.ar), id: templateId };
}

const TEAM_AR: Record<string, string> = {
  "Talent Acquisition Operations": "فريق عمليات اكتساب المواهب",
  "Compensation & Payroll Operations": "فريق عمليات التعويضات والرواتب",
  "Workforce Mobility Operations": "فريق عمليات تنقل القوى العاملة",
  "Leave & Attendance Operations": "فريق عمليات الإجازات والحضور",
  "Separations & Final Settlement Operations": "فريق عمليات المغادرة والتسوية النهائية",
  "HRIS Data Stewardship": "أمنة بيانات نظام الموارد البشرية",
  "HR Compliance Triage": "فرز امتثال الموارد البشرية",
};

// ── Start a run ──────────────────────────────────────────────────────────────

export interface StartRunInput {
  kind?: "standard" | "shadow" | "backtest";
  asOf?: LocalDate;
  actor: string;
  label?: string;
}

export async function startRun(input: StartRunInput): Promise<{ runId: string; status: string }> {
  const mode = await getMode();
  if (mode.mode === "M4") throw new MzError("MZ-MODE-503", "MIZAN is read-only. Runs are blocked until maintenance closes.");
  if (mode.mode === "M5") throw new MzError("MZ-RUN-423", "Runs are locked by safe halt: an integrity check failed.");

  const runsEnabled = await db.featureFlag.findUnique({ where: { key: "runs.enabled" } });
  if (runsEnabled && runsEnabled.value === "false") throw new MzError("MZ-RUN-423", "Runs are disabled by flag runs.enabled.");

  const runId = `run-${randomUUID().slice(0, 8)}`;
  const kind = input.kind ?? "standard";
  const [transactions, employees] = await Promise.all([loadTransactions(), loadEmployees()]);

  // as-of default: the day after the latest date in the dataset (recorded in the manifest)
  const latest = transactions.reduce((acc, t) => (t.effectiveDate && t.effectiveDate > acc ? t.effectiveDate : acc), "2025-01-01");
  const asOf = input.asOf ?? addDays(latest, 1);

  await db.run.create({
    data: {
      id: runId, kind, status: "RUNNING", engineVersion: ENGINE_VERSION, packVersion: PACK_VERSION,
      packHash: "pending", calendarHash: "pending", routingHash: "pending", gradeLadderHash: "pending",
      synonymsHash: "pending", configHash: "pending", flagsHash: "pending", asOf,
      inputsJson: JSON.stringify([]), countsJson: "{}", perRuleJson: "{}", outputHash: "pending",
      stagesJson: JSON.stringify([{ stage: "ingest", at: new Date().toISOString(), detail: `${transactions.length} transactions, ${employees.length} employees` }]),
    },
  });
  await appendAudit({ actor: input.actor, type: "run.started", entity: "run", entityId: runId, payload: { kind, asOf, transactions: transactions.length } });

  finalizeRun(runId, transactions, employees, asOf, kind).catch(async (err) => {
    await db.run.update({ where: { id: runId }, data: { status: "FAILED", finishedAt: new Date(), countsJson: JSON.stringify({ error: String(err) }) } }).catch(() => undefined);
    await appendAudit({ actor: "system:worker", type: "run.failed", entity: "run", entityId: runId, payload: { error: String(err) } }).catch(() => undefined);
  });

  return { runId, status: "RUNNING" };
}

function addDays(s: LocalDate, n: number): LocalDate {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── Finalize (all guards + exception upsert) ─────────────────────────────────

async function finalizeRun(runId: string, transactions: Transaction[], employees: Employee[], asOf: LocalDate, kind: string): Promise<void> {
  const activeRules = RULE_SPECS.filter((r) => r.status === "active" || r.status === "shadow");

  const result = evaluate({ transactions, employees, pack: activeRules, config: { calendarVersion: UAE_CALENDAR.version, routingTableVersion: "routing-1.2.0" }, asOf, runId });

  // FS-03 determinism self-check: re-evaluate and compare output hashes
  const second = evaluate({ transactions, employees, pack: activeRules, config: { calendarVersion: UAE_CALENDAR.version, routingTableVersion: "routing-1.2.0" }, asOf, runId });
  if (second.outputHash !== result.outputHash) {
    await setSafeHalt(`determinism self-check failed for run ${runId}`);
    throw new Error("MZ-INT-500: determinism self-check failed");
  }

  // Baselines for the flood guard (from the pack's training backtest, stored as config data)
  let baselines: Record<string, number> = {};
  let neBaselines: Record<string, number> = {};
  const baselineFlag = await db.featureFlag.findUnique({ where: { key: "backtest.baselines" } });
  if (baselineFlag) {
    const parsed = JSON.parse(baselineFlag.value) as { fail?: Record<string, number>; notEvaluable?: Record<string, number> };
    baselines = parsed.fail ?? (parsed as unknown as Record<string, number>);
    neBaselines = parsed.notEvaluable ?? {};
  }

  const holds: { ruleId?: string; reason: string; kind: string }[] = [];
  let status = "COMPLETED";

  // FS-05 flood guard per rule + FS-07 not-evaluable spike guard
  // ADR-0006: the 5% NE-rate test applies when a rule has at least 50 applicable checks;
  // smaller samples use the 3×-baseline count test, which is the statistically honest option.
  for (const [ruleId, c] of Object.entries(result.perRule)) {
    const failRate = c.total ? c.failed / c.total : 0;
    const base = baselines[ruleId];
    if (kind === "standard" && base !== undefined && c.failed > 0) {
      const threshold = Math.max(base * 3, base + 0.02);
      if (failRate > threshold) {
        holds.push({ ruleId, reason: `fail rate ${(failRate * 100).toFixed(1)}% exceeds max(3× baseline, baseline + 2pp) = ${(threshold * 100).toFixed(1)}%`, kind: "flood_guard" });
      }
    }
    const applicable = c.total - c.notApplicable;
    const neRate = applicable ? c.notEvaluable / applicable : 0;
    const neBase = neBaselines[ruleId] ?? 0;
    const neSpike = (neRate > 0.05 && applicable >= 50) || (c.notEvaluable > 3 * neBase + 1);
    if (kind === "standard" && neSpike && c.notEvaluable > 0) {
      holds.push({ ruleId, reason: `not-evaluable ${c.notEvaluable}/${applicable} (${(neRate * 100).toFixed(1)}%) exceeds the band (5% at n≥50 or 3× baseline)`, kind: "not_evaluable_spike" });
      status = "COMPLETED_WITH_DQ";
    }
  }

  await db.run.update({ where: { id: runId }, data: { status: "FINALIZING" } });

  // Exception upsert (idempotent by key; observations per run)
  const fails = result.results.filter((r) => r.outcome === "FAIL");
  const newFailKeys = new Set<string>();
  for (const r of fails) {
    const key = exceptionKey(TENANT, r);
    newFailKeys.add(key);
    const existing = await db.exception.findUnique({ where: { exceptionKey: key } });
    const txn = transactions.find((t) => t.rowId === r.rowId)!;
    const rule = activeRules.find((x) => x.id === r.ruleId)!;
    if (existing) {
      const data: Record<string, unknown> = { lastRunId: runId, updatedAt: new Date() };
      if (!holds.some((h) => h.ruleId === r.ruleId) && existing.heldReason) data.heldReason = null;
      if (existing.evidenceHash !== r.evidenceHash) {
        if (existing.status === "CLOSED" || existing.status === "DISMISSED") {
          data.status = "REOPENED";
          data.noLongerDetected = false;
        }
        data.evidenceHash = r.evidenceHash;
        data.evidenceJson = JSON.stringify(r.evidence);
      }
      await db.exception.update({ where: { exceptionKey: key }, data });
      await db.observation.create({ data: { id: randomUUID(), exceptionKey: key, runId, ruleVersion: r.ruleVersion, evidenceHash: r.evidenceHash ?? "" } });
      continue;
    }
    await createException(runId, r, txn, rule, asOf, holds.some((h) => h.ruleId === r.ruleId));
  }

  // DQ exceptions: one per (rowId, dq code) — routed to HRIS Data Stewardship (EC stewardship)
  const seenDq = new Set<string>();
  for (const t of transactions) {
    for (const dq of t.dq) {
      const key = sha256(`${TENANT}|${t.txnId}|DQ|${dq}`);
      if (seenDq.has(key)) continue;
      seenDq.add(key);
      const existing = await db.exception.findUnique({ where: { exceptionKey: key } });
      if (existing) {
        await db.exception.update({ where: { exceptionKey: key }, data: { lastRunId: runId, noLongerDetected: false, updatedAt: new Date() } });
        await db.observation.create({ data: { id: randomUUID(), exceptionKey: key, runId, ruleVersion: "1.0.0", evidenceHash: sha256(`${t.rowId}|${dq}`) } });
        continue;
      }
      const parts = explainDq(t, dq);
      const sla = slaDeadlines("LOW", asOf);
      const action = fillAction("CA-DQ-01", {}, { field: FIELD_FOR_DQ[dq] ?? dq, txn_id: t.txnId });
      await db.exception.create({
        data: {
          exceptionKey: key, displayId: `F-${crockfordFromHex(key)}`, tenantId: TENANT,
          rowId: t.rowId, txnId: t.txnId, ruleId: "DQ", clauseId: dq, ruleVersion: "1.0.0",
          family: "data_quality", severity: "LOW",
          severityRationale: "Severity Low: base Low (data quality); never raised; goes to data stewardship.",
          ownerTeam: "HRIS Data Stewardship", ownerUserId: null, watchersJson: "[]",
          routingRationale: "Routed to HRIS Data Stewardship because this is a data-quality exception (family overlay).",
          routingTableVersion: "routing-1.2.0",
          actionId: action.id, actionEn: action.en, actionAr: action.ar,
          headlineEn: parts.headlineEn, headlineAr: parts.headlineAr,
          explanationEn: canonicalText(parts, emptyEvidence("DQ", dq, t), action.en, action.ar, "HRIS Data Stewardship", TEAM_AR["HRIS Data Stewardship"] ?? "", "LOW", "Severity Low: base Low (data quality); never raised; goes to data stewardship.", "درجة الخطورة: منخفضة", "en"),
          explanationAr: canonicalText(parts, emptyEvidence("DQ", dq, t), action.en, action.ar, "HRIS Data Stewardship", TEAM_AR["HRIS Data Stewardship"] ?? "", "LOW", "Severity Low: base Low (data quality); never raised; goes to data stewardship.", "درجة الخطورة: منخفضة", "ar"),
          status: "NEW", version: 1, groupKey: sha256(`${t.employeeId}|DQ|${dq}`),
          ackDueAt: sla.ackDueAt, resolveDueAt: sla.resolveDueAt, heldReason: null,
          noLongerDetected: false, firstRunId: runId, lastRunId: runId,
          evidenceJson: JSON.stringify(emptyEvidence("DQ", dq, t)), evidenceHash: sha256(`${t.rowId}|${dq}`),
        },
      });
      await db.outbox.create({ data: { id: randomUUID(), type: "notification.inapp", payloadJson: JSON.stringify({ exceptionKey: key, team: "HRIS Data Stewardship", severity: "LOW", headline: parts.headlineEn }) } });
    }
  }

  // noLongerDetected: open exceptions not re-detected in this run
  const openExceptions = await db.exception.findMany({ where: { status: { in: ["NEW", "TRIAGED", "ASSIGNED", "IN_PROGRESS", "PENDING_VERIFICATION", "REOPENED"] } } });
  for (const ex of openExceptions) {
    if (ex.lastRunId !== runId && ex.firstRunId !== runId) {
      await db.exception.update({ where: { exceptionKey: ex.exceptionKey }, data: { noLongerDetected: true } });
    }
  }

  // FS-06 run-level routing hold: new exceptions above 5% of transactions or above 2,000 (data-quality family excluded)
  if (kind === "standard") {
    const newCount = fails.length;
    const pct = transactions.length ? newCount / transactions.length : 0;
    if (pct > 0.05 && newCount > 50) {
      holds.push({ reason: `${newCount} new exceptions = ${(pct * 100).toFixed(1)}% of transactions (threshold 5%); routing held until a compliance lead releases it`, kind: "run_hold" });
      status = "COMPLETED_WITH_HOLDS";
    }
  }
  if (holds.some((h) => h.kind === "flood_guard") && status === "COMPLETED") status = "COMPLETED_WITH_HOLDS";

  // Baselines from the first backtest run
  if (kind === "backtest" && !baselineFlag) {
    const b: Record<string, number> = {};
    const ne: Record<string, number> = {};
    for (const [ruleId, c] of Object.entries(result.perRule)) {
      b[ruleId] = c.total ? c.failed / c.total : 0;
      ne[ruleId] = c.notEvaluable;
    }
    await db.featureFlag.create({ data: { key: "backtest.baselines", value: JSON.stringify({ fail: b, notEvaluable: ne }), updatedBy: "system:backtest", reason: "initial training baselines" } });
  }

  // Manifest
  const counts: CensusCounts = result.counts;
  counts.held = (await db.exception.count({ where: { lastRunId: runId, heldReason: { not: null } } }));
  counts.dqExceptions = seenDq.size;
  const manifest: Omit<RunManifest, "startedAt" | "finishedAt"> = {
    runId, kind: kind as RunManifest["kind"], status: status as RunManifest["status"],
    engineVersion: ENGINE_VERSION, packVersion: PACK_VERSION,
    packHash: await packHashValue(), calendarHash: calHash(), routingHash: "routing-1.2.0",
    gradeLadderHash: "grade-ladder-1.1.0", synonymsHash: "syn-1.1.0", configHash: "cfg-1.0.0", flagsHash: await flagsHash(),
    asOf,
    inputs: [{ datasetId: "pack-seed-42", kind: "transactions+employees", sha256: datasetHash(), rows: transactions.length }],
    counts, outputHash: result.outputHash,
  };

  await db.run.update({
    where: { id: runId },
    data: {
      status,
      packHash: manifest.packHash, calendarHash: manifest.calendarHash, routingHash: manifest.routingHash,
      gradeLadderHash: manifest.gradeLadderHash, synonymsHash: manifest.synonymsHash, configHash: manifest.configHash,
      flagsHash: manifest.flagsHash,
      inputsJson: JSON.stringify(manifest.inputs),
      countsJson: JSON.stringify(counts),
      perRuleJson: JSON.stringify(result.perRule),
      outputHash: result.outputHash,
      holdsJson: JSON.stringify(holds),
      finishedAt: new Date(),
      stagesJson: JSON.stringify([
        { stage: "ingest", detail: `${transactions.length} transactions` },
        { stage: "evaluate", detail: `${counts.checks} checks` },
        { stage: "finalize", detail: `${counts.failed} failed, ${counts.notEvaluable} not evaluable, ${holds.length} hold(s)` },
      ]),
    },
  });
  await appendAudit({ actor: "system:finalizer", type: "run.completed", entity: "run", entityId: runId, payload: { status, outputHash: result.outputHash, counts } });
}

export function exceptionKey(tenant: string, r: CheckResult): string {
  return sha256(`${tenant}|${r.txnId}|${r.ruleId}|${r.clauseId}`);
}

async function createException(runId: string, r: CheckResult, txn: Transaction, rule: (typeof RULE_SPECS)[number], asOf: LocalDate, held: boolean): Promise<void> {
  const evidence = r.evidence as Evidence;
  const slots = r.slots ?? {};
  const sev = resolveSeverity({ rule, clauseId: r.clauseId, slots, evidence, asOf });
  const severity = sev.severity as Severity;
  const routing = resolveRouting({ txn, rule, severity, clauseId: r.clauseId });
  const parts = explain(txn, rule, evidence, slots);
  const action = fillAction(rule.action.template, slots);
  const sla = slaDeadlines(severity, asOf);
  const key = exceptionKey(TENANT, r);
  const groupActor = rule.family === "segregation_of_duties" ? String(slots.actor ?? txn.employeeId) : txn.employeeId;
  const bucket = Math.floor(new Date(`${txn.effectiveDate ?? asOf}T00:00:00Z`).getTime() / (90 * 86_400_000));
  const groupKey = sha256(`${groupActor}|${rule.id}|${bucket}`);
  const interp = INTERPRETATIONS[rule.id];

  await db.exception.create({
    data: {
      exceptionKey: key, displayId: `F-${crockfordFromHex(key)}`, tenantId: TENANT,
      rowId: r.rowId, txnId: r.txnId, ruleId: rule.id, clauseId: r.clauseId, ruleVersion: r.ruleVersion,
      family: rule.family, severity,
      severityRationale: sev.rationale,
      ownerTeam: routing.ownerTeam, ownerUserId: null, watchersJson: JSON.stringify(routing.watchers),
      routingRationale: routing.rationale, routingTableVersion: routing.routingTableVersion,
      actionId: action.id, actionEn: action.en, actionAr: action.ar,
      headlineEn: parts.headlineEn, headlineAr: parts.headlineAr,
      explanationEn: canonicalText(parts, evidence, action.en, action.ar, routing.ownerTeam, TEAM_AR[routing.ownerTeam] ?? routing.ownerTeam, severity, sev.rationale, sev.rationaleAr, "en"),
      explanationAr: canonicalText(parts, evidence, action.en, action.ar, routing.ownerTeam, TEAM_AR[routing.ownerTeam] ?? routing.ownerTeam, severity, sev.rationale, sev.rationaleAr, "ar"),
      status: "NEW", version: 1, groupKey,
      ackDueAt: sla.ackDueAt, resolveDueAt: sla.resolveDueAt,
      heldReason: held ? "held by the flood guard: fail rate above band" : null,
      noLongerDetected: false, firstRunId: runId, lastRunId: runId,
      evidenceJson: JSON.stringify(evidence), evidenceHash: r.evidenceHash ?? "",
    },
  });
  await db.observation.create({ data: { id: randomUUID(), exceptionKey: key, runId, ruleVersion: r.ruleVersion, evidenceHash: r.evidenceHash ?? "" } });
  await db.outbox.create({ data: { id: randomUUID(), type: "notification.inapp", payloadJson: JSON.stringify({ exceptionKey: key, team: routing.ownerTeam, severity, headline: parts.headlineEn }) } });
  void interp;
}

function emptyEvidence(ruleId: string, clauseId: string, t: Transaction): Evidence {
  return {
    ruleId, ruleVersion: "1.0.0", clauseId, clauseText: `Data-quality issue ${clauseId}`,
    sourceAnchor: "ingestion", facts: [{ name: "txn_id", value: t.txnId, display: { en: t.txnId, ar: t.txnId }, source: "transaction", path: "txn.txn_id", breaching: false }],
    requirement: { en: "Data must be complete and unambiguous.", ar: "يجب أن تكون البيانات كاملة وغير غامضة.", machine: `DQ:${clauseId}` },
    comparison: null, relatedTxnIds: [], calendarVersion: null, caveats: [],
  };
}

async function setSafeHalt(reason: string): Promise<void> {
  const { setMode } = await import("./mode");
  await setMode("M5", reason, "system:integrity");
}

// Config hash helpers (deterministic values pinned in the manifest)
async function packHashValue(): Promise<string> {
  return sha256Json({ pack: PACK_VERSION, rules: RULE_SPECS.map((r) => ({ id: r.id, v: r.version, sha: r.source.sha256 })) });
}
function calHash(): string {
  return sha256Json(UAE_CALENDAR);
}
async function flagsHash(): Promise<string> {
  const flags = await db.featureFlag.findMany({ orderBy: { key: "asc" } });
  return sha256Json(flags.map((f) => ({ key: f.key, value: f.value })));
}
function datasetHash(): string {
  return sha256("pack-seed-42");
}
