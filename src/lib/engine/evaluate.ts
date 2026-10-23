/**
 * Detection engine (§11): pure, synchronous per shard, no I/O, no wall clock,
 * no randomness, integer fils, canonical JSON hashing, stable sorting.
 * evaluate() never throws for business outcomes.
 */

import type {
  Transaction, Employee, RuleSpec, CheckResult, Evidence, Outcome, CensusCounts,
  Condition, EvidenceFact, Caveat, DqCode,
} from "../contracts";
import { buildIndexes, type EngineIndexes } from "./facts";
import { evaluateFamily, type FamilyEval } from "./families";
import { sha256Json } from "../domain/canonical";
import { cmpStr, type LocalDate } from "../domain/dates";

export interface EngineConfig {
  calendarVersion: string;
  routingTableVersion: string;
}

export interface EvaluateInput {
  transactions: Transaction[];
  employees: Employee[];
  pack: RuleSpec[];               // active + shadow rules
  config: EngineConfig;
  asOf: LocalDate;                // explicit input; the engine has no clock (FS-21)
  runId: string;
  quarantined?: number;
}

export interface EvaluateOutput {
  results: CheckResult[];
  counts: CensusCounts;
  perRule: Record<string, { total: number; pass: number; notApplicable: number; notEvaluable: number; failed: number }>;
  outputHash: string;
  quarantined: number;
}

const SEVERITY_ORDER = ["NOT_EVALUABLE", "PASS", "NOT_APPLICABLE", "FAIL"] as const;

/** Evaluate a scope condition tree against derived facts. */
export function evalCondition(c: Condition, facts: Record<string, string | number | boolean | null>): boolean | null {
  if ("all" in c) {
    for (const sub of c.all) { const r = evalCondition(sub, facts); if (r === false) return false; if (r === null) return null; }
    return true;
  }
  if ("any" in c) {
    let hasNull = false;
    for (const sub of c.any) {
      const r = evalCondition(sub, facts);
      if (r === true) return true;
      if (r === null) hasNull = true;
    }
    return hasNull ? null : false;
  }
  if ("not" in c) {
    const r = evalCondition(c.not, facts);
    return r === null ? null : !r;
  }
  const value = facts[c.fact];
  if (c.op === "exists") return value !== null && value !== undefined;
  if (c.op === "missing") return value === null || value === undefined;
  if (value === null || value === undefined) return null;
  switch (c.op) {
    case "eq": return value === c.value;
    case "ne": return value !== c.value;
    case "gt": return typeof value === "number" && typeof c.value === "number" ? value > c.value : String(value) > String(c.value);
    case "gte": return typeof value === "number" && typeof c.value === "number" ? value >= c.value : String(value) >= String(c.value);
    case "lt": return typeof value === "number" && typeof c.value === "number" ? value < c.value : String(value) < String(c.value);
    case "lte": return typeof value === "number" && typeof c.value === "number" ? value <= c.value : String(value) <= String(c.value);
    case "in": return (c.value as unknown[]).includes(value);
    case "nin": return !(c.value as unknown[]).includes(value);
    case "between": {
      const [lo, hi] = c.value as [number, number];
      return typeof value === "number" ? value >= lo && value <= hi : false;
    }
    default: return null;
  }
}

function txnFacts(t: Transaction): Record<string, string | number | boolean | null> {
  return { "txn.amount_fils": t.amountFils, "txn.type": t.type, "txn.effective_date": t.effectiveDate };
}

function evidenceHash(e: Evidence | null): string | null {
  return e ? sha256Json(e) : null;
}

export function evaluate(input: EvaluateInput): EvaluateOutput {
  const indexes: EngineIndexes = buildIndexes(input.transactions, input.employees);
  const versionsById = new Map<string, RuleSpec[]>();
  for (const rule of input.pack) {
    const list = versionsById.get(rule.id) ?? [];
    list.push(rule);
    versionsById.set(rule.id, list);
  }
  const rules = [...versionsById.values()].map((versions) => selectLatestVersion(versions));
  const ruleIds = [...versionsById.keys()].sort(cmpStr);
  const latestById = new Map(rules.map((r) => [r.id, r]));
  const txns = [...input.transactions].sort((a, b) => cmpStr(a.rowId, b.rowId));

  const results: CheckResult[] = [];
  const perRule: EvaluateOutput["perRule"] = {};
  for (const id of ruleIds) perRule[id] = { total: 0, pass: 0, notApplicable: 0, notEvaluable: 0, failed: 0 };

  const emitNotApplicable = (txn: Transaction, rule: RuleSpec): void => {
    for (const clause of rule.clauses) {
      perRule[rule.id]!.total++;
      perRule[rule.id]!.notApplicable++;
      results.push({ runId: input.runId, rowId: txn.rowId, txnId: txn.txnId, ruleId: rule.id, ruleVersion: rule.version, clauseId: clause.id, outcome: "NOT_APPLICABLE", evidence: null, evidenceHash: null, dq: [] });
    }
  };
  const emitNotEvaluable = (txn: Transaction, rule: RuleSpec, dq: DqCode, caveat: Caveat): void => {
    for (const clause of rule.clauses) {
      const ev = notEvaluableEvidence(rule, clause.id, txn, [caveat], input.config);
      perRule[rule.id]!.total++;
      perRule[rule.id]!.notEvaluable++;
      results.push({ runId: input.runId, rowId: txn.rowId, txnId: txn.txnId, ruleId: rule.id, ruleVersion: rule.version, clauseId: clause.id, outcome: "NOT_EVALUABLE", evidence: ev, evidenceHash: evidenceHash(ev), dq: [dq] });
    }
  };

  for (const txn of txns) {
    const effective = txn.effectiveDate ?? input.asOf;
    for (const id of ruleIds) {
      const versions = versionsById.get(id)!;
      const rule = selectVersionInForce(versions, effective) ?? latestById.get(id)!;
      const inForce = selectVersionInForce(versions, effective);
      if (!inForce) { emitNotApplicable(txn, rule); continue; }
      // Type-scoped rules on an unknown type → NOT_EVALUABLE (EC-A12), never silently skipped
      const typeScoped = !rule.scope.transactionTypes.includes(txn.type);
      const unknownType = txn.type === "UNKNOWN";
      if (typeScoped && unknownType) {
        emitNotEvaluable(txn, rule, "DQ-006", { code: "DQ-006", message: { en: `Transaction type "${txn.typeRaw}" is unknown, so this rule cannot run.`, ar: `نوع المعاملة "${txn.typeRaw}" غير معروف، لذا لا يمكن تنفيذ هذه القاعدة.` }, facts: [txn.typeRaw] });
        continue;
      }
      if (typeScoped) { emitNotApplicable(txn, rule); continue; }
      // Scope preconditions (e.g. amount above threshold). Unknown fact → NOT_EVALUABLE (unknown is not pass).
      if (rule.scope.where) {
        const scopeResult = evalCondition(rule.scope.where, txnFacts(txn));
        if (scopeResult === false) { emitNotApplicable(txn, rule); continue; }
        if (scopeResult === null) {
          const code = txn.dq.find((d) => d === "DQ-013" || d === "DQ-009") ?? "DQ-001";
          emitNotEvaluable(txn, rule, code, {
            code,
            message: code === "DQ-013"
              ? { en: "The amount is ambiguous, so this rule's scope cannot be decided.", ar: "المبلغ غامض، لذا لا يمكن تحديد نطاق هذه القاعدة." }
              : code === "DQ-009"
                ? { en: "The currency is not AED, so amount thresholds cannot be applied.", ar: "العملة ليست الدرهم، لذا لا يمكن تطبيق حدود المبالغ." }
                : { en: "A field needed to decide whether this rule applies is missing.", ar: "حقل مطلوب لتحديد انطباق هذه القاعدة غير موجود." },
            facts: [],
          });
          continue;
        }
      }
      // Family evaluation per clause
      for (const clause of rule.clauses) {
        let fe: FamilyEval;
        try {
          fe = evaluateFamily(txn, rule, clause.id, indexes, input.asOf);
        } catch (err) {
          // A failing rule module yields NOT_EVALUABLE, never an aborted run (§11)
          fe = {
            outcome: "NOT_EVALUABLE", facts: [], comparison: null,
            requirement: { en: rule.title, ar: rule.title, machine: `${rule.id}:${clause.id}` },
            dq: ["DQ-001"], caveats: [{ code: "DQ-001", message: { en: `The rule module could not run: ${err instanceof Error ? err.message : "unknown error"}.`, ar: "لم تتمكن وحدة القاعدة من التنفيذ." }, facts: [] }],
            slots: {}, relatedTxnIds: [],
          };
        }
        const baseFacts: EvidenceFact[] = [
          { name: "txn_id", value: txn.txnId, display: { en: txn.txnId, ar: txn.txnId }, source: "transaction", path: "txn.txn_id", breaching: false },
          { name: "employee_id", value: txn.employeeId, display: { en: txn.employeeId, ar: txn.employeeId }, source: "transaction", path: "txn.employee_id", breaching: false },
        ];
        const factByName = new Map<string, EvidenceFact>();
        for (const f of [...baseFacts, ...fe.facts]) if (!factByName.has(f.name)) factByName.set(f.name, f);
        const ev: Evidence = {
          ruleId: rule.id,
          ruleVersion: rule.version,
          clauseId: clause.id,
          clauseText: rule.clauses.find((c) => c.id === clause.id)?.text ?? rule.clauses[0]!.text,
          sourceAnchor: rule.source.anchor,
          facts: [...factByName.values()],
          requirement: fe.requirement,
          comparison: fe.comparison,
          relatedTxnIds: fe.relatedTxnIds,
          calendarVersion: rule.family === "timing_window" ? input.config.calendarVersion : null,
          caveats: dedupeCaveats([...txn.caveats, ...fe.caveats]),
        };
        const outcome: Outcome = fe.outcome;
        perRule[rule.id]!.total++;
        if (outcome === "PASS") perRule[rule.id]!.pass++;
        else if (outcome === "FAIL") perRule[rule.id]!.failed++;
        else if (outcome === "NOT_APPLICABLE") perRule[rule.id]!.notApplicable++;
        else perRule[rule.id]!.notEvaluable++;
        results.push({
          runId: input.runId, rowId: txn.rowId, txnId: txn.txnId, ruleId: rule.id, ruleVersion: rule.version,
          clauseId: clause.id, outcome, evidence: outcome === "NOT_APPLICABLE" ? null : ev,
          evidenceHash: outcome === "NOT_APPLICABLE" ? null : evidenceHash(ev),
          dq: fe.dq, slots: fe.slots,
        });
      }
    }
  }

  const counts = census(txns, rules, results, input.quarantined ?? 0);
  const outputHash = computeOutputHash(results);
  return { results, counts, perRule, outputHash, quarantined: input.quarantined ?? 0 };
}

function selectLatestVersion(versions: RuleSpec[]): RuleSpec {
  return [...versions].sort((a, b) => cmpStr(b.effective.from, a.effective.from) || cmpStr(b.version, a.version))[0]!;
}

function selectVersionInForce(versions: RuleSpec[], date: LocalDate): RuleSpec | null {
  const inForce = versions.filter((r) => r.effective.from <= date && (r.effective.to === null || date <= r.effective.to));
  if (!inForce.length) return null;
  return [...inForce].sort((a, b) => cmpStr(b.effective.from, a.effective.from) || cmpStr(b.version, a.version))[0]!;
}

function dedupeCaveats(caveats: Caveat[]): Caveat[] {
  const seen = new Set<string>();
  const out: Caveat[] = [];
  for (const c of caveats) {
    const key = `${c.code}:${c.message.en}`;
    if (!seen.has(key)) { seen.add(key); out.push(c); }
  }
  return out;
}

function notEvaluableEvidence(rule: RuleSpec, clauseId: string, txn: Transaction, caveats: Caveat[], config: EngineConfig): Evidence {
  const facts: EvidenceFact[] = [new FactBuilder().build(txn)];
  return {
    ruleId: rule.id, ruleVersion: rule.version, clauseId,
    clauseText: rule.clauses.find((c) => c.id === clauseId)?.text ?? rule.clauses[0]!.text,
    sourceAnchor: rule.source.anchor,
    facts, requirement: { en: rule.title, ar: rule.title, machine: `${rule.id}:${clauseId}:not_evaluable` },
    comparison: null, relatedTxnIds: [], calendarVersion: config.calendarVersion, caveats,
  };
}

class FactBuilder {
  build(t: Transaction): EvidenceFact {
    return { name: "txn_id", value: t.txnId, display: { en: t.txnId, ar: t.txnId }, source: "transaction", path: "txn.txn_id", breaching: false };
  }
}

/** Census counts (FS-02): applicable + notApplicable = total; evaluated + notEvaluable = applicable. */
export function census(txns: Transaction[], rules: RuleSpec[], results: CheckResult[], quarantined: number): CensusCounts {
  const total = results.length;
  const notApplicable = results.filter((r) => r.outcome === "NOT_APPLICABLE").length;
  const notEvaluable = results.filter((r) => r.outcome === "NOT_EVALUABLE").length;
  const failed = results.filter((r) => r.outcome === "FAIL").length;
  const applicable = total - notApplicable;
  const evaluated = applicable - notEvaluable;
  const clauses = rules.reduce((acc, r) => acc + r.clauses.length, 0);
  return {
    transactions: txns.length,
    rules: rules.length,
    clauses,
    checks: total,
    applicable,
    notApplicable,
    evaluated,
    notEvaluable,
    passed: evaluated - failed,
    failed,
    quarantined,
    held: 0,
    dqExceptions: 0,
  };
}

/** FS-02: every transaction × clause pair has exactly one outcome and the arithmetic reconciles. */
export function assertCensus(counts: CensusCounts): string[] {
  const errors: string[] = [];
  if (counts.applicable + counts.notApplicable !== counts.checks) errors.push("applicable + notApplicable ≠ checks");
  if (counts.evaluated + counts.notEvaluable !== counts.applicable) errors.push("evaluated + notEvaluable ≠ applicable");
  if (counts.passed + counts.failed !== counts.evaluated) errors.push("passed + failed ≠ evaluated");
  if (counts.transactions * counts.clauses !== counts.checks) errors.push(`transactions × clauses = ${counts.transactions * counts.clauses} ≠ checks ${counts.checks}`);
  return errors;
}

/** outputHash = SHA-256 over the sorted tuples (rowId, ruleId, clauseId, outcome, evidenceHash). */
export function computeOutputHash(results: CheckResult[]): string {
  const sorted = [...results]
    .map((r) => `${r.rowId}|${r.ruleId}|${r.clauseId}|${r.outcome}|${r.evidenceHash ?? ""}`)
    .sort();
  return sha256Json(sorted);
}

export { SEVERITY_ORDER };
