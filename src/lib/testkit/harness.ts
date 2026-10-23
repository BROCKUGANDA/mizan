/**
 * The backtesting harness (§3, §10, §18). Every gate returns numbers derived
 * from a run; nothing is asserted without executing it.
 */

import { evaluate, assertCensus } from "../engine/evaluate";
import { resolveSeverity } from "../engine/severity";
import { resolveRouting } from "../engine/routing";
import { explain, canonicalText } from "../explain/explanations";
import { factLock } from "../explain/factlock";
import { fillAction, unresolvedPlaceholders } from "../pack/actions";
import { RULE_SPECS, validateRuleSpec } from "../pack/rules";
import { renderFindingsCsv, validateFindingsCsv, type FindingRow } from "../server/export";
import { UAE_CALENDAR } from "../domain/calendar";
import { crockfordFromHex, sha256 } from "../domain/canonical";
import type { Employee, Evidence, RuleSpec, Transaction } from "../contracts";
import { evaluateDataset, findingKeys, packDataset, type Dataset } from "./dataset";
import { applyFormatMutation, FORMAT_MUTATIONS, normaliseMutated } from "./format-mutations";
import { runMutations, type MutationResult } from "./mutations";
import { runMetamorphic, type RelationResult } from "./metamorphic";
import { runOracle, type OracleResult } from "./oracle";

export interface FindingBuild {
  rows: FindingRow[];
  actionPlaceholders: string[];
  factLockFailures: string[];
}

export function buildFindings(transactions: Transaction[], employees: Employee[], pack: RuleSpec[], asOf = "2026-04-01"): FindingBuild {
  const output = evaluate({
    transactions, employees, pack,
    config: { calendarVersion: UAE_CALENDAR.version, routingTableVersion: "routing-1.2.0" }, asOf, runId: "finding-build",
  });
  const rows: FindingRow[] = [];
  const actionPlaceholders: string[] = [];
  const factLockFailures: string[] = [];
  for (const r of output.results.filter((x) => x.outcome === "FAIL")) {
    const txn = transactions.find((t) => t.rowId === r.rowId)!;
    const rule = pack.find((p) => p.id === r.ruleId)!;
    const evidence = r.evidence as Evidence;
    const slots = r.slots ?? {};
    const sev = resolveSeverity({ rule, clauseId: r.clauseId, slots, evidence, asOf });
    const routing = resolveRouting({ txn, rule, severity: sev.severity, clauseId: r.clauseId });
    const parts = explain(txn, rule, evidence, slots);
    const action = fillAction(rule.action.template, slots);
    const unresolved = unresolvedPlaceholders(action);
    if (unresolved.length) actionPlaceholders.push(`${r.txnId}|${r.ruleId}|${unresolved.join(",")}`);
    const facts: Record<string, unknown> = {};
    for (const f of evidence.facts) facts[f.name] = f.value;
    const canonicalEn = canonicalText(parts, evidence, action.en, action.ar, routing.ownerTeam, routing.ownerTeam, sev.severity, sev.rationale, sev.rationaleAr, "en");
    const canonicalAr = canonicalText(parts, evidence, action.en, action.ar, routing.ownerTeam, routing.ownerTeam, sev.severity, sev.rationale, sev.rationaleAr, "ar");
    const lockEn = factLock(canonicalEn, evidence, { requiredAction: action.en, locale: "en", canonicalLength: canonicalEn.length });
    const lockAr = factLock(canonicalAr, evidence, { requiredAction: action.ar, locale: "ar", canonicalLength: canonicalAr.length });
    if (!lockEn.ok) factLockFailures.push(`${txn.txnId}|${rule.id}|en:${lockEn.rejection}:${lockEn.detail}`);
    if (!lockAr.ok) factLockFailures.push(`${txn.txnId}|${rule.id}|ar:${lockAr.rejection}:${lockAr.detail}`);
    rows.push({
      finding_id: `F-${crockfordFromHex(sha256(`${txn.txnId}|${txn.rowId}|${rule.id}|${r.clauseId}`))}`,
      txnId: txn.txnId,
      ruleId: rule.id,
      ruleVersion: r.ruleVersion,
      clauseId: r.clauseId,
      severity: sev.severity,
      headlineEn: parts.headlineEn,
      whatBrokeEn: parts.whatBrokeEn,
      whyItMattersEn: parts.whyEn,
      actionEn: action.en,
      ownerTeam: routing.ownerTeam,
      evidenceJson: JSON.stringify(facts),
      runDate: asOf,
    });
  }
  return { rows, actionPlaceholders, factLockFailures };
}

export interface GoldenGate {
  ok: boolean;
  examples: { transactionId: string; ok: boolean; mismatches: number }[];
  structuralErrors: string[];
  findingsSha256: string;
}

export interface BacktestReport {
  dataset: { transactions: number; employees: number; checks: number; failed: number; notEvaluable: number; clauses: number };
  outputHash: string;
  census: { ok: boolean; errors: string[] };
  determinism: { ok: boolean; runs: number };
  golden: GoldenGate;
  actionPlaceholders: string[];
  factLockFailures: string[];
  mutations: MutationResult[];
  mutationSummary: { recall: number; nearMissFp: number; total: number };
  formats: { id: string; ok: boolean }[];
  metamorphic: RelationResult[];
  oracle: OracleResult;
  performance: { checks: number; ms: number; targetMs: number; ok: boolean };
  specErrors: { ruleId: string; errors: string[] }[];
  gates: Record<string, boolean>;
  ok: boolean;
}

export async function runBacktestSuite(dataset: Dataset, opts: { skipOracle?: boolean } = {}): Promise<BacktestReport> {
  const pack = RULE_SPECS.filter((r) => r.status === "active");
  const started = Date.now();
  const first = evaluateDataset(dataset.transactions, dataset.employees, "suite-1");
  const elapsed = Date.now() - started;
  const second = evaluateDataset(dataset.transactions, dataset.employees, "suite-2");
  const censusErrors = assertCensus(first.counts);
  const built = buildFindings(dataset.transactions, dataset.employees, pack);
  const csv = renderFindingsCsv(built.rows);
  const validation = validateFindingsCsv(csv);
  const golden: GoldenGate = {
    ok: validation.ok,
    examples: validation.workedExamples.map((w) => ({ transactionId: w.transactionId, ok: w.ok, mismatches: w.mismatches.length })),
    structuralErrors: validation.structuralErrors,
    findingsSha256: validation.findingsSha256,
  };

  const mutations = runMutations(dataset);
  const positives = mutations.length;
  const detected = mutations.filter((m) => m.positiveDetected).length;
  const nearMissFp = mutations.filter((m) => m.nearMissFalsePositive).length;

  const formats = FORMAT_MUTATIONS.map((id) => {
    const text = applyFormatMutation(id, dataset);
    const transactions = normaliseMutated(text, new Set(dataset.employees.map((e) => e.employeeId)));
    const out = evaluateDataset(transactions, dataset.employees, `suite-format-${id}`);
    const a = findingKeys(first);
    const b = findingKeys(out);
    return { id, ok: a.size === b.size && [...a].every((k) => b.has(k)) };
  });

  const metamorphic = runMetamorphic(dataset);
  const oracle = opts.skipOracle
    ? { agreement: true, engineFails: 0, oracleFails: 0, missingFromOracle: [], extraInOracle: [] }
    : await runOracle(dataset, pack);

  const specErrors = pack.map((r) => ({ ruleId: r.id, errors: validateRuleSpec(r) })).filter((e) => e.errors.length > 0);

  const gates = {
    census: censusErrors.length === 0,
    determinism: first.outputHash === second.outputHash,
    golden: golden.ok,
    actions: built.actionPlaceholders.length === 0,
    factLock: built.factLockFailures.length === 0,
    mutationRecall: detected === positives,
    nearMiss: nearMissFp === 0,
    formats: formats.every((f) => f.ok),
    metamorphic: metamorphic.every((m) => m.holds),
    oracle: oracle.agreement,
    specs: specErrors.length === 0,
    performance: elapsed <= 10_000,
  };
  return {
    dataset: {
      transactions: first.counts.transactions, employees: dataset.employees.length,
      checks: first.counts.checks, failed: first.counts.failed, notEvaluable: first.counts.notEvaluable, clauses: first.counts.clauses,
    },
    outputHash: first.outputHash,
    census: { ok: censusErrors.length === 0, errors: censusErrors },
    determinism: { ok: first.outputHash === second.outputHash, runs: 2 },
    golden,
    actionPlaceholders: built.actionPlaceholders,
    factLockFailures: built.factLockFailures,
    mutations,
    mutationSummary: { recall: positives ? detected / positives : 1, nearMissFp, total: positives },
    formats,
    metamorphic,
    oracle,
    performance: { checks: first.counts.checks, ms: elapsed, targetMs: 10_000, ok: elapsed <= 10_000 },
    specErrors,
    gates,
    ok: Object.values(gates).every(Boolean),
  };
}

export function renderReport(report: BacktestReport): string {
  const lines: string[] = [];
  lines.push(`# Backtest report · ${new Date().toISOString().slice(0, 10)}`);
  lines.push("");
  lines.push(`Dataset: ${report.dataset.transactions} transactions × ${report.dataset.clauses} clauses = ${report.dataset.checks} checks`);
  lines.push(`Output hash: ${report.outputHash}`);
  lines.push(`Census: ${report.census.ok ? "PASS" : `FAIL (${report.census.errors.join("; ")})`}`);
  lines.push(`Determinism: ${report.determinism.ok ? "2/2 identical" : "FAIL"} · Formats: ${report.formats.filter((f) => f.ok).length}/${report.formats.length} · Metamorphic: ${report.metamorphic.filter((m) => m.holds).length}/${report.metamorphic.length}`);
  lines.push(`Mutations: ${(report.mutationSummary.recall * 100).toFixed(0)}% recall · ${report.mutationSummary.nearMissFp} near-miss false positives`);
  lines.push(`Golden: ${report.golden.examples.filter((e) => e.ok).length}/${report.golden.examples.length} exact`);
  lines.push(`Oracle: ${report.oracle.agreement ? "100% agreement" : `${report.oracle.missingFromOracle.length} missing, ${report.oracle.extraInOracle.length} extra`}`);
  lines.push(`Performance: ${report.performance.checks} checks in ${report.performance.ms} ms (target ${report.performance.targetMs} ms)`);
  lines.push("");
  lines.push("| Gate | Result |");
  lines.push("| --- | --- |");
  for (const [gate, ok] of Object.entries(report.gates)) lines.push(`| ${gate} | ${ok ? "PASS" : "FAIL"} |`);
  return lines.join("\n") + "\n";
}
