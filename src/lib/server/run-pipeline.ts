/**
 * Run pipeline (§11): POST /runs → evaluate → finalize (fencing, census FS-02,
 * determinism self-check FS-03, flood guard FS-05, run-level routing hold FS-06,
 * not-evaluable spike guard FS-07, idempotent exception upsert, observations,
 * outbox rows, manifest) in one logical transaction.
 */

import { db } from "@/lib/db";
import { randomUUID } from "node:crypto";
import { evaluate, assertCensus } from "../engine/evaluate";
import { resolveSeverity } from "../engine/severity";
import { resolveRouting } from "../engine/routing";
import { explain, explainDq, canonicalText } from "../explain/explanations";
import { factLock } from "../explain/factlock";
import { configHashes } from "../pack/config";
import { fillAction } from "../pack/actions";
import { RULE_SPECS, PACK_VERSION, ENGINE_VERSION } from "../pack/rules";
import { UAE_CALENDAR, slaDeadlines } from "../domain/calendar";
import type { Transaction, Employee, CheckResult, Evidence, ExceptionRecord, RunManifest, CensusCounts, Severity, RuleSpec } from "../contracts";
import { sha256, sha256Json, crockfordFromHex } from "../domain/canonical";
import { appendAudit } from "../audit/chain";
import { getMode } from "./mode";
import { MzError } from "../domain/errors";
import { cmpStr, type LocalDate } from "../domain/dates";

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

const TEAM_AR: Record<string, string> = {
  "Talent Acquisition Operations": "فريق عمليات اكتساب المواهب",
  "Compensation & Payroll Operations": "فريق عمليات التعويضات والرواتب",
  "Workforce Mobility Operations": "فريق عمليات تنقل القوى العاملة",
  "Leave & Attendance Operations": "فريق عمليات الإجازات والحضور",
  "Separations & Final Settlement Operations": "فريق عمليات المغادرة والتسوية النهائية",
  "HRIS Data Stewardship": "أمنة بيانات نظام الموارد البشرية",
  "HR Compliance Triage": "فرز امتثال الموارد البشرية",
};

/**
 * The engine must evaluate the rules the studio actually activated, not the
 * compiled constant. The DB is the source of truth; the constant is the seed
 * fallback for a fresh database.
 */
export async function loadActivePack(): Promise<RuleSpec[]> {
  const rows = await db.rule.findMany({ where: { status: { in: ["active", "shadow"] } }, orderBy: { id: "asc" } });
  if (!rows.length) return RULE_SPECS.filter((r) => r.status === "active" || r.status === "shadow");
  return rows.map((r) => {
    const spec = JSON.parse(r.specJson) as RuleSpec;
    return { ...spec, status: r.status as RuleSpec["status"], version: r.version };
  });
}

async function loadFlagFlags(): Promise<Record<string, string>> {
  const rows = await db.featureFlag.findMany();
  return Object.fromEntries(rows.map((f) => [f.key, f.value]));
}

function numberOfFlag(flags: Record<string, string>, key: string, fallback: number, min: number, max: number): number {
  const n = Number(flags[key]);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

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

  const flags = await loadFlagFlags();
  if (flags["runs.enabled"] === "false") throw new MzError("MZ-RUN-423", "Runs are disabled by flag runs.enabled.");

  const runId = `run-${randomUUID().slice(0, 8)}`;
  const kind = input.kind ?? "standard";
  const [transactions, employees, activePack] = await Promise.all([loadTransactions(), loadEmployees(), loadActivePack()]);
  if (!transactions.length) throw new MzError("MZ-VAL-422", "No transactions are loaded. Upload a dataset before starting a run.");

  // as-of default: the day after the latest date in the dataset (recorded in the manifest)
  const latest = transactions.reduce((acc, t) => (t.effectiveDate && t.effectiveDate > acc ? t.effectiveDate : acc), "2025-01-01");
  const asOf = input.asOf ?? addDays(latest, 1);

  const datasets = await db.dataset.findMany({ where: { kind: { in: ["transactions", "employees", "policy", "finding_format"] } }, orderBy: { kind: "asc" } });
  const inputs = datasets.length
    ? datasets.map((d) => ({ datasetId: d.id, kind: d.kind, sha256: d.sha256, rows: d.rows }))
    : [{ datasetId: "unknown", kind: "transactions+employees", sha256: datasetHash(transactions, employees), rows: transactions.length }];

  const configH = await configHashes();
  const manifestPins = {
    packHash: await packHashes(activePack),
    calendarHash: sha256Json(UAE_CALENDAR),
    routingHash: configH.routingHash,
    gradeLadderHash: configH.gradeLadderHash,
    synonymsHash: configH.synonymsHash,
    configHash: configH.configHash,
    flagsHash: sha256Json(Object.entries(flags).sort(([a], [b]) => cmpStr(a, b))),
  };

  await db.run.create({
    data: {
      id: runId, kind, status: "QUEUED", engineVersion: ENGINE_VERSION, packVersion: PACK_VERSION,
      packHash: manifestPins.packHash, calendarHash: manifestPins.calendarHash, routingHash: manifestPins.routingHash,
      gradeLadderHash: manifestPins.gradeLadderHash, synonymsHash: manifestPins.synonymsHash,
      configHash: manifestPins.configHash, flagsHash: manifestPins.flagsHash, asOf,
      inputsJson: JSON.stringify(inputs), countsJson: "{}", perRuleJson: "{}", outputHash: "pending",
      stagesJson: JSON.stringify([{ stage: "queued", at: new Date().toISOString(), detail: `${transactions.length} transactions, ${employees.length} employees` }]),
    },
  });
  await appendAudit({ actor: input.actor, type: "run.started", entity: "run", entityId: runId, payload: { kind, asOf, transactions: transactions.length } });

  await db.run.update({ where: { id: runId }, data: { status: "RUNNING" } });
  // The dev runtime cancels un-awaited work when a route response ends, so the
  // finalizer is awaited. In production this is the worker consuming the queued
  // job; the API still acknowledges with 202 and the client polls the run.
  let finalStatus = "RUNNING";
  try {
    await finalizeRun(runId, transactions, employees, asOf, kind, activePack, inputs, flags, manifestPins, input.actor);
    finalStatus = (await db.run.findUnique({ where: { id: runId } }))?.status ?? "COMPLETED";
  } catch (err) {
    const message = err instanceof MzError ? `${err.code}: ${err.detail}` : err instanceof Error ? err.message : String(err);
    await db.run.update({ where: { id: runId }, data: { status: "FAILED", finishedAt: new Date(), countsJson: JSON.stringify({ error: message }) } });
    await appendAudit({ actor: "system:worker", type: "run.failed", entity: "run", entityId: runId, payload: { error: message } });
    finalStatus = "FAILED";
  }

  return { runId, status: finalStatus };
}

function addDays(s: LocalDate, n: number): LocalDate {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── Finalize (all guards + exception upsert) ─────────────────────────────────

async function finalizeRun(
  runId: string,
  transactions: Transaction[],
  employees: Employee[],
  asOf: LocalDate,
  kind: string,
  activeRules: RuleSpec[],
  inputs: RunManifest["inputs"],
  flags: Record<string, string>,
  pins: { packHash: string; calendarHash: string; routingHash: string; gradeLadderHash: string; synonymsHash: string; configHash: string; flagsHash: string },
  actor: string,
): Promise<void> {
  const config = { calendarVersion: UAE_CALENDAR.version, routingTableVersion: "routing-1.2.0" };
  const result = evaluate({ transactions, employees, pack: activeRules, config, asOf, runId });

  // FS-02: the census must reconcile before anything is published.
  const censusErrors = assertCensus(result.counts);
  if (censusErrors.length) {
    await setSafeHalt(`census completeness failed for run ${runId}: ${censusErrors.join("; ")}`);
    throw new Error(`MZ-INT-500: census completeness failed: ${censusErrors.join("; ")}`);
  }

  // FS-03 determinism self-check: re-evaluate and compare output hashes.
  const second = evaluate({ transactions, employees, pack: activeRules, config, asOf, runId });
  if (second.outputHash !== result.outputHash) {
    await setSafeHalt(`determinism self-check failed for run ${runId}`);
    throw new Error("MZ-INT-500: determinism self-check failed");
  }

  const baselineFlag = await db.featureFlag.findUnique({ where: { key: "backtest.baselines" } });
  let baselines: Record<string, number> = {};
  let neBaselines: Record<string, number> = {};
  if (baselineFlag) {
    const parsed = JSON.parse(baselineFlag.value) as { fail?: Record<string, number>; notEvaluable?: Record<string, number> };
    baselines = parsed.fail ?? (parsed as unknown as Record<string, number>);
    neBaselines = parsed.notEvaluable ?? {};
  }

  const holds: { ruleId?: string; reason: string; kind: string }[] = [];
  let status = "COMPLETED";
  let dqStatus = false;
  const isBacktest = kind === "backtest";
  const isShadow = kind === "shadow";
  const routingDisabled = flags["routing.enabled"] === "false";
  const floodMultiplier = numberOfFlag(flags, "flood_guard.multiplier", 3, 2, 5);
  const floodMinPp = numberOfFlag(flags, "flood_guard.min_pp", 2, 1, 5) / 100;
  const heldRuleIds = new Set<string>();

  for (const [ruleId, c] of Object.entries(result.perRule)) {
    const applicable = c.total - c.notApplicable;
    const failRate = applicable ? c.failed / applicable : 0;
    const base = baselines[ruleId];
    const ruleHold = flags[`rule.${ruleId}.hold`] === "true";
    if (ruleHold) {
      heldRuleIds.add(ruleId);
      holds.push({ ruleId, reason: "routing is held for this rule by rule.<id>.hold", kind: "rule_hold" });
    }
    if (!isBacktest && base !== undefined && c.failed > 0) {
      const threshold = Math.max(base * floodMultiplier, base + floodMinPp);
      if (failRate > threshold) {
        heldRuleIds.add(ruleId);
        holds.push({ ruleId, reason: `fail rate ${(failRate * 100).toFixed(1)}% exceeds max(${floodMultiplier}× baseline, baseline + ${(floodMinPp * 100).toFixed(0)}pp) = ${(threshold * 100).toFixed(1)}%`, kind: "flood_guard" });
      }
    }
    const neRate = applicable ? c.notEvaluable / applicable : 0;
    const neBase = neBaselines[ruleId];
    // The 3× test only makes sense when a training baseline exists; without one
    // the absolute 5% test still applies (and small samples stay calm).
    const neSpike = (neRate > 0.05 && applicable >= 50) || (neBase !== undefined && c.notEvaluable > 3 * neBase + 1);
    if (!isBacktest && neSpike && c.notEvaluable > 0) {
      holds.push({ ruleId, reason: `not-evaluable ${c.notEvaluable}/${applicable} (${(neRate * 100).toFixed(1)}%) exceeds the band (5% at n≥50 or 3× baseline)`, kind: "not_evaluable_spike" });
      dqStatus = true;
    }
  }

  // FS-06 run-level routing hold: above 5% of transactions OR above 2,000 new exceptions.
  const newCount = result.results.filter((r) => r.outcome === "FAIL").length;
  if (!isBacktest) {
    const pct = transactions.length ? newCount / transactions.length : 0;
    if (pct > 0.05 || newCount > 2_000) {
      holds.push({ reason: `${newCount} new exceptions = ${(pct * 100).toFixed(1)}% of transactions (threshold 5% or 2,000); routing held until a compliance lead releases it`, kind: "run_hold" });
    }
  }
  if (routingDisabled) holds.push({ reason: "routing.enabled=false: findings are recorded, nothing is routed", kind: "routing_hold" });
  if (holds.some((h) => h.kind !== "not_evaluable_spike")) status = "COMPLETED_WITH_HOLDS";
  if (dqStatus && status === "COMPLETED") status = "COMPLETED_WITH_DQ";

  await db.run.update({ where: { id: runId }, data: { status: "FINALIZING" } });
  await db.runFinding.deleteMany({ where: { runId } });

  const fails = result.results.filter((r) => r.outcome === "FAIL");
  const snapshots: { snap: FindingSnapshot; rowId: string; evidenceHash: string }[] = [];
  const dqCodesByRow = new Map<string, Set<string>>();
  for (const t of transactions) {
    if (!t.dq.length) continue;
    dqCodesByRow.set(t.rowId, new Set(t.dq));
  }
  for (const r of result.results) {
    if (!r.dq.length) continue;
    const set = dqCodesByRow.get(r.rowId) ?? new Set<string>();
    for (const dq of r.dq) set.add(dq);
    dqCodesByRow.set(r.rowId, set);
  }

  for (const r of fails) {
    const txn = transactions.find((t) => t.rowId === r.rowId)!;
    const rule = activeRules.find((x) => x.id === r.ruleId)!;
    if (isBacktest) {
      const evidence = r.evidence as Evidence;
      const slots = r.slots ?? {};
      const sev = resolveSeverity({ rule, clauseId: r.clauseId, slots, evidence, asOf });
      const routing = resolveRouting({ txn, rule, severity: sev.severity as Severity, clauseId: r.clauseId });
      const parts = explain(txn, rule, evidence, slots);
      const action = fillAction(rule.action.template, slots);
      snapshots.push({ snap: snapshotOf(r, txn, rule, sev.severity as Severity, parts, action.en, routing.ownerTeam, evidence, runId, asOf), rowId: r.rowId, evidenceHash: r.evidenceHash ?? "" });
      continue;
    }
    // Only the flood guard and an explicit rule hold stop routing. An NE spike
    // changes the run status and opens stewardship, but does not silence findings.
    const ruleHeld = heldRuleIds.has(r.ruleId);
    const noRoute = isShadow || routingDisabled || ruleHeld || holds.some((h) => !h.ruleId && (h.kind === "run_hold" || h.kind === "routing_hold"));
    const heldReason = isShadow
      ? "shadow: findings are stored; nothing routes and no SLA clock runs"
      : routingDisabled
        ? "routing disabled by flag routing.enabled"
        : ruleHeld
          ? (holds.find((h) => h.ruleId === r.ruleId && (h.kind === "flood_guard" || h.kind === "rule_hold"))?.reason ?? "routing held")
          : holds.some((h) => !h.ruleId && (h.kind === "run_hold" || h.kind === "routing_hold"))
            ? (holds.find((h) => !h.ruleId && (h.kind === "run_hold" || h.kind === "routing_hold"))?.reason ?? "run routing hold")
            : null;
    const snapshot = await upsertException(runId, r, txn, rule, asOf, { noRoute: !!noRoute, heldReason, shadow: isShadow || rule.status === "shadow" });
    snapshots.push({ snap: snapshot, rowId: r.rowId, evidenceHash: r.evidenceHash ?? "" });
  }
  if (snapshots.length) {
    await db.runFinding.createMany({
      data: snapshots.map(({ snap, rowId, evidenceHash }) => ({
        id: `${runId}|${rowId}|${snap.ruleId}|${snap.clauseId}`,
        runId, rowId, txnId: snap.txnId, ruleId: snap.ruleId, clauseId: snap.clauseId,
        ruleVersion: snap.ruleVersion, severity: snap.severity,
        payloadJson: JSON.stringify(snap), evidenceHash,
      })),
    });
  }
  if (!isBacktest) {
    await upsertDqExceptions(runId, transactions, dqCodesByRow, asOf, { noRoute: isShadow || routingDisabled, heldReason: isShadow ? "shadow: data-quality findings are stored; nothing routes" : routingDisabled ? "routing disabled by flag routing.enabled" : null, shadow: isShadow });

    // noLongerDetected: open exceptions not re-detected in this run
    const openExceptions = await db.exception.findMany({ where: { status: { in: ["NEW", "TRIAGED", "ASSIGNED", "IN_PROGRESS", "PENDING_VERIFICATION", "REOPENED"] } } });
    for (const ex of openExceptions) {
      if (ex.lastRunId !== runId && ex.firstRunId !== runId) {
        await db.exception.update({ where: { exceptionKey: ex.exceptionKey }, data: { noLongerDetected: true } });
      }
    }
  }

  // A successful shadow run is the gate to active (FS-19).
  if (isShadow) {
    const shadowRules = await db.rule.findMany({ where: { status: "shadow" } });
    for (const r of shadowRules) await db.rule.update({ where: { id: r.id }, data: { shadowRunId: runId } });
  }

  // Baselines from the first backtest run (fail rate over applicable checks).
  if (isBacktest && !baselineFlag) {
    const b: Record<string, number> = {};
    const ne: Record<string, number> = {};
    for (const [ruleId, c] of Object.entries(result.perRule)) {
      const applicable = c.total - c.notApplicable;
      b[ruleId] = applicable ? c.failed / applicable : 0;
      ne[ruleId] = c.notEvaluable;
    }
    await db.featureFlag.create({ data: { key: "backtest.baselines", value: JSON.stringify({ fail: b, notEvaluable: ne }), updatedBy: "system:backtest", reason: "initial training baselines" } });
  }

  const counts: CensusCounts = result.counts;
  counts.held = isBacktest ? 0 : await db.exception.count({ where: { lastRunId: runId, heldReason: { not: null } } });
  counts.dqExceptions = isBacktest ? 0 : dqCodesByRow.size;
  const manifest: Omit<RunManifest, "startedAt" | "finishedAt"> = {
    runId, kind: kind as RunManifest["kind"], status: status as RunManifest["status"],
    engineVersion: ENGINE_VERSION, packVersion: PACK_VERSION,
    ...pins,
    asOf, inputs, counts, outputHash: result.outputHash,
  };

  await db.run.update({
    where: { id: runId },
    data: {
      status,
      ...pins,
      inputsJson: JSON.stringify(manifest.inputs),
      countsJson: JSON.stringify(counts),
      perRuleJson: JSON.stringify(result.perRule),
      outputHash: result.outputHash,
      holdsJson: JSON.stringify(holds),
      finishedAt: new Date(),
      stagesJson: JSON.stringify([
        { stage: "ingest", detail: `${transactions.length} transactions, ${employees.length} employees` },
        { stage: "evaluate", detail: `${counts.transactions} × ${counts.clauses} clauses = ${counts.checks} checks` },
        { stage: "finalize", detail: `${counts.failed} failed, ${counts.notEvaluable} not evaluable, ${holds.length} hold(s)` },
      ]),
    },
  });
  await appendAudit({ actor, type: "run.completed", entity: "run", entityId: runId, payload: { status, outputHash: result.outputHash, counts, holds } });
}

/** Exception identity uses the internal row ID, so duplicate transaction IDs never collide (EC-H02). */
export function exceptionKey(tenant: string, r: CheckResult): string {
  return sha256(`${tenant}|${r.rowId}|${r.ruleId}|${r.clauseId}`);
}

interface FindingSnapshot {
  finding_id: string;
  txnId: string;
  ruleId: string;
  ruleVersion: string;
  clauseId: string;
  severity: string;
  headlineEn: string;
  whatBrokeEn: string;
  whyItMattersEn: string;
  actionEn: string;
  ownerTeam: string;
  evidenceJson: string;
  runDate: string;
}

function snapshotOf(r: CheckResult, txn: Transaction, rule: RuleSpec, sev: Severity, parts: { headlineEn: string; whatBrokeEn: string; whyEn: string }, actionEn: string, ownerTeam: string, evidence: Evidence, runId: string, asOf: LocalDate): FindingSnapshot {
  const facts: Record<string, unknown> = {};
  for (const f of evidence.facts) facts[f.name] = f.value;
  return {
    finding_id: `F-${crockfordFromHex(exceptionKey(TENANT, r))}`,
    txnId: txn.txnId,
    ruleId: rule.id,
    ruleVersion: r.ruleVersion,
    clauseId: r.clauseId,
    severity: sev,
    headlineEn: parts.headlineEn,
    whatBrokeEn: parts.whatBrokeEn,
    whyItMattersEn: parts.whyEn,
    actionEn,
    ownerTeam,
    evidenceJson: JSON.stringify(facts),
    runDate: asOf,
  };
}

async function upsertException(
  runId: string,
  r: CheckResult,
  txn: Transaction,
  rule: RuleSpec,
  asOf: LocalDate,
  opts: { noRoute: boolean; heldReason: string | null; shadow: boolean },
): Promise<FindingSnapshot> {
  const evidence = r.evidence as Evidence;
  const slots = r.slots ?? {};
  const sev = resolveSeverity({ rule, clauseId: r.clauseId, slots, evidence, asOf });
  const severity = sev.severity as Severity;
  const routing = resolveRouting({ txn, rule, severity, clauseId: r.clauseId });
  const parts = explain(txn, rule, evidence, slots);
  const action = fillAction(rule.action.template, slots);
  const snapshot = snapshotOf(r, txn, rule, severity, parts, action.en, routing.ownerTeam, evidence, runId, asOf);
  const sla = opts.noRoute ? { ackDueAt: null, resolveDueAt: null } : slaDeadlines(severity, asOf);
  const key = exceptionKey(TENANT, r);
  const groupActor = rule.family === "segregation_of_duties" ? String(slots.actor ?? txn.employeeId) : txn.employeeId;
  const bucket = Math.floor(new Date(`${txn.effectiveDate ?? asOf}T00:00:00Z`).getTime() / (90 * 86_400_000));
  const groupKey = sha256(`${groupActor}|${rule.id}|${bucket}`);
  const shadow = opts.shadow;
  const routingRationale = shadow
    ? `Shadow: would route to ${routing.ownerTeam}. ${routing.rationale}`
    : routing.rationale;
  const explanationEn = canonicalText(parts, evidence, action.en, action.ar, shadow ? `(would route to ${routing.ownerTeam})` : routing.ownerTeam, TEAM_AR[routing.ownerTeam] ?? routing.ownerTeam, severity, sev.rationale, sev.rationaleAr, "en");
  const explanationAr = canonicalText(parts, evidence, action.en, action.ar, shadow ? `(سيُحال إلى ${TEAM_AR[routing.ownerTeam] ?? routing.ownerTeam})` : routing.ownerTeam, TEAM_AR[routing.ownerTeam] ?? routing.ownerTeam, severity, sev.rationale, sev.rationaleAr, "ar");
  const lockEn = factLock(explanationEn, evidence, { requiredAction: action.en, locale: "en", canonicalLength: explanationEn.length });
  const lockAr = factLock(explanationAr, evidence, { requiredAction: action.ar, locale: "ar", canonicalLength: explanationAr.length });
  if (!lockEn.ok || !lockAr.ok) {
    throw new MzError("MZ-INT-500", `Fact-lock rejected the canonical explanation for ${rule.id}/${r.clauseId}: ${lockEn.rejection ?? lockAr.rejection} (${lockEn.detail ?? lockAr.detail}; en ${explanationEn.length} chars, ar ${explanationAr.length} chars)`);
  }

  const existing = await db.exception.findUnique({ where: { exceptionKey: key } });
  if (existing) {
    const data: Record<string, unknown> = opts.shadow
      ? { lastRunId: runId, noLongerDetected: false, updatedAt: new Date() }
      : {
          lastRunId: runId,
          updatedAt: new Date(),
          heldReason: opts.heldReason,
          noLongerDetected: false,
          ownerTeam: routing.ownerTeam,
          routingRationale,
          severity,
          severityRationale: sev.rationale,
          actionId: action.id,
          actionEn: action.en,
          actionAr: action.ar,
          headlineEn: parts.headlineEn,
          headlineAr: parts.headlineAr,
          explanationEn,
          explanationAr,
          ackDueAt: sla.ackDueAt,
          resolveDueAt: sla.resolveDueAt,
        };
    if (existing.evidenceHash !== r.evidenceHash) {
      if (!opts.shadow && ["CLOSED", "DISMISSED", "ACCEPTED_RISK", "DUPLICATE"].includes(existing.status)) {
        data.status = "REOPENED";
      }
      data.version = existing.version + 1;
      data.evidenceHash = r.evidenceHash ?? "";
      data.evidenceJson = JSON.stringify(evidence);
      if (!opts.shadow) {
        data.headlineEn = parts.headlineEn;
        data.headlineAr = parts.headlineAr;
        data.explanationEn = explanationEn;
        data.explanationAr = explanationAr;
      }
    }
    await db.exception.update({ where: { exceptionKey: key }, data });
    const obs = await db.observation.findFirst({ where: { exceptionKey: key, runId } });
    if (!obs) await db.observation.create({ data: { id: randomUUID(), exceptionKey: key, runId, ruleVersion: r.ruleVersion, evidenceHash: r.evidenceHash ?? "" } });
    if (!opts.shadow && !opts.noRoute && existing.heldReason) {
      await db.outbox.create({ data: { id: randomUUID(), type: "notification.inapp", payloadJson: JSON.stringify({ exceptionKey: key, team: routing.ownerTeam, severity, headline: parts.headlineEn }) } });
    }
    return snapshot;
  }

  await db.exception.create({
    data: {
      exceptionKey: key, displayId: `F-${crockfordFromHex(key)}`, tenantId: TENANT,
      rowId: r.rowId, txnId: r.txnId, ruleId: rule.id, clauseId: r.clauseId, ruleVersion: r.ruleVersion,
      family: rule.family, severity,
      severityRationale: sev.rationale,
      ownerTeam: routing.ownerTeam, ownerUserId: null, watchersJson: JSON.stringify(routing.watchers),
      routingRationale, routingTableVersion: routing.routingTableVersion,
      actionId: action.id, actionEn: action.en, actionAr: action.ar,
      headlineEn: parts.headlineEn, headlineAr: parts.headlineAr,
      explanationEn, explanationAr,
      status: "NEW", version: 1, groupKey,
      ackDueAt: sla.ackDueAt, resolveDueAt: sla.resolveDueAt,
      heldReason: opts.heldReason,
      noLongerDetected: false, firstRunId: runId, lastRunId: runId,
      evidenceJson: JSON.stringify(evidence), evidenceHash: r.evidenceHash ?? "",
    },
  });
  await db.observation.create({ data: { id: randomUUID(), exceptionKey: key, runId, ruleVersion: r.ruleVersion, evidenceHash: r.evidenceHash ?? "" } });
  if (!opts.noRoute) {
    await db.outbox.create({ data: { id: randomUUID(), type: "notification.inapp", payloadJson: JSON.stringify({ exceptionKey: key, team: routing.ownerTeam, severity, headline: parts.headlineEn }) } });
  }
  return snapshot;
}

async function upsertDqExceptions(
  runId: string,
  transactions: Transaction[],
  dqByRow: Map<string, Set<string>>,
  asOf: LocalDate,
  opts: { noRoute: boolean; heldReason: string | null; shadow: boolean },
): Promise<void> {
  for (const t of transactions) {
    const codes = [...(dqByRow.get(t.rowId) ?? [])].sort();
    for (const dq of codes) {
      const key = sha256(`${TENANT}|${t.rowId}|DQ|${dq}`);
      const existing = await db.exception.findUnique({ where: { exceptionKey: key } });
      const parts = explainDq(t, dq);
      const action = fillAction("CA-DQ-01", {}, { field: FIELD_FOR_DQ[dq] ?? dq, txn_id: t.txnId });
      const evidence = emptyEvidence("DQ", dq, t);
      const sla = opts.noRoute ? { ackDueAt: null, resolveDueAt: null } : slaDeadlines("LOW", asOf);
      if (existing) {
        await db.exception.update({
          where: { exceptionKey: key },
          data: opts.shadow
            ? { lastRunId: runId, noLongerDetected: false, updatedAt: new Date() }
            : {
                lastRunId: runId, noLongerDetected: false, updatedAt: new Date(),
                heldReason: opts.heldReason, ackDueAt: sla.ackDueAt, resolveDueAt: sla.resolveDueAt,
                headlineEn: parts.headlineEn, headlineAr: parts.headlineAr,
                actionEn: action.en, actionAr: action.ar,
              },
        });
        const obs = await db.observation.findFirst({ where: { exceptionKey: key, runId } });
        if (!obs) await db.observation.create({ data: { id: randomUUID(), exceptionKey: key, runId, ruleVersion: "1.0.0", evidenceHash: sha256(`${t.rowId}|${dq}`) } });
        continue;
      }
      const owner = dq === "DQ-017" ? "HR Compliance Triage" : "HRIS Data Stewardship";
      await db.exception.create({
        data: {
          exceptionKey: key, displayId: `F-${crockfordFromHex(key)}`, tenantId: TENANT,
          rowId: t.rowId, txnId: t.txnId, ruleId: "DQ", clauseId: dq, ruleVersion: "1.0.0",
          family: "data_quality", severity: "LOW",
          severityRationale: "Severity Low: base Low (data quality); never raised; goes to data stewardship.",
          ownerTeam: owner, ownerUserId: null, watchersJson: "[]",
          routingRationale: dq === "DQ-017"
            ? "Routed to HR Compliance Triage because the free text looks like an instruction; it is treated as data and tagged for security review (FS-15)."
            : "Routed to HRIS Data Stewardship because this is a data-quality exception (family overlay).",
          routingTableVersion: "routing-1.2.0",
          actionId: action.id, actionEn: action.en, actionAr: action.ar,
          headlineEn: parts.headlineEn, headlineAr: parts.headlineAr,
          explanationEn: canonicalText(parts, evidence, action.en, action.ar, owner, TEAM_AR[owner] ?? owner, "LOW", "Severity Low: base Low (data quality); never raised; goes to data stewardship.", "درجة الخطورة: منخفضة", "en"),
          explanationAr: canonicalText(parts, evidence, action.en, action.ar, owner, TEAM_AR[owner] ?? owner, "LOW", "Severity Low: base Low (data quality); never raised; goes to data stewardship.", "درجة الخطورة: منخفضة", "ar"),
          status: "NEW", version: 1, groupKey: sha256(`${t.employeeId}|DQ|${dq}`),
          ackDueAt: sla.ackDueAt, resolveDueAt: sla.resolveDueAt, heldReason: opts.heldReason,
          noLongerDetected: false, firstRunId: runId, lastRunId: runId,
          evidenceJson: JSON.stringify(evidence), evidenceHash: sha256(`${t.rowId}|${dq}`),
        },
      });
      await db.observation.create({ data: { id: randomUUID(), exceptionKey: key, runId, ruleVersion: "1.0.0", evidenceHash: sha256(`${t.rowId}|${dq}`) } });
      if (!opts.noRoute) {
        await db.outbox.create({ data: { id: randomUUID(), type: "notification.inapp", payloadJson: JSON.stringify({ exceptionKey: key, team: owner, severity: "LOW", headline: parts.headlineEn }) } });
      }
    }
  }
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

async function packHashes(pack: RuleSpec[]): Promise<string> {
  return sha256Json(pack.map((r) => ({ id: r.id, version: r.version, effective: r.effective, check: r.check, scope: r.scope, clauses: r.clauses, sourceSha: r.source.sha256 })));
}

function datasetHash(transactions: Transaction[], employees: Employee[]): string {
  return sha256Json({ transactions: transactions.map((t) => t.source.rowHash).sort(), employees: employees.map((e) => e.employeeId).sort() });
}
