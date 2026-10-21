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
import type { LocalDate } from "../domain/dates";

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
  const rules = [...input.pack].sort((a, b) => a.id.localeCompare(b.id));
  const txns = [...input.transactions].sort((a, b) => a.rowId.localeCompare(b.rowId));

  const results: CheckResult[] = [];
  const perRule: EvaluateOutput["perRule"] = {};
  for (const r of rules) perRule[r.id] = { total: 0, pass: 0, notApplicable: 0, notEvaluable: 0, failed: 0 };

  for (const txn of txns) {
    for (const rule of rules) {
      // Rule version selection by effective date (single-version pack in v1; effective-dating recorded)
      if (rule.effective.from > (txn.effectiveDate ?? input.asOf) && rule.effective.dateBasis === "effective_date" && txn.effectiveDate) {
        // rule not yet in force at the transaction's effective date → NOT_APPLICABLE
        for (const clause of rule.clauses) {
          perRule[rule.id]!.total++;
          perRule[rule.id]!.notApplicable++;
          results.push({ runId: input.runId, rowId: txn.rowId, txnId: txn.txnId, ruleId: rule.id, ruleVersion: rule.version, clauseId: clause.id, outcome: "NOT_APPLICABLE", evidence: null, evidenceHash: null, dq: [] });
        }
        continue;
      }
      // Type-scoped rules on an unknown type → NOT_EVALUABLE (EC-A12), never silently skipped
      const typeScoped = !rule.scope.transactionTypes.includes(txn.type);
      const unknownType = txn.type === "UNKNOWN";
      if (typeScoped && unknownType) {
        for (const clause of rule.clauses) {
          const ev = notEvaluableEvidence(rule, clause.id, txn, [{ code: "DQ-006", message: { en: `Transaction type "${txn.typeRaw}" is unknown, so this rule cannot run.`, ar: `نوع المعاملة "${txn.typeRaw}" غير معروف، لذا لا يمكن تنفيذ هذه القاعدة.` }, facts: [txn.typeRaw] }], input.config);
          perRule[rule.id]!.total++;
          perRule[rule.id]!.notEvaluable++;
          results.push({ runId: input.runId, rowId: txn.rowId, txnId: txn.txnId, ruleId: rule.id, ruleVersion: rule.version, clauseId: clause.id, outcome: "NOT_EVALUABLE", evidence: ev, evidenceHash: evidenceHash(ev), dq: ["DQ-006"] });
        }
        continue;
      }
      if (typeScoped) {
        for (const clause of rule.clauses) {
          perRule[rule.id]!.total++;
          perRule[rule.id]!.notApplicable++;
          results.push({ runId: input.runId, rowId: txn.rowId, txnId: txn.txnId, ruleId: rule.id, ruleVersion: rule.version, clauseId: clause.id, outcome: "NOT_APPLICABLE", evidence: null, evidenceHash: null, dq: [] });
        }
        continue;
      }
      // Scope preconditions (e.g. amount above threshold). Unknown fact → NOT_EVALUABLE (unknown is not pass).
      if (rule.scope.where) {
        const scopeResult = evalCondition(rule.scope.where, txnFacts(txn));
        if (scopeResult === false) {
          for (const clause of rule.clauses) {
            perRule[rule.id]!.total++;
            perRule[rule.id]!.notApplicable++;
            results.push({ runId: input.runId, rowId: txn.rowId, txnId: txn.txnId, ruleId: rule.id, ruleVersion: rule.version, clauseId: clause.id, outcome: "NOT_APPLICABLE", evidence: null, evidenceHash: null, dq: [] });
          }
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
        const ev: Evidence = {
          ruleId: rule.id,
          ruleVersion: rule.version,
          clauseId: clause.id,
          clauseText: rule.clauses.find((c) => c.id === clause.id)?.text ?? rule.clauses[0]!.text,
          sourceAnchor: rule.source.anchor,
          facts: fe.facts,
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
  return {
    transactions: txns.length,
    rules: rules.length,
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

/** outputHash = SHA-256 over the sorted tuples (rowId, ruleId, clauseId, outcome, evidenceHash). */
export function computeOutputHash(results: CheckResult[]): string {
  const sorted = [...results]
    .map((r) => `${r.rowId}|${r.ruleId}|${r.clauseId}|${r.outcome}|${r.evidenceHash ?? ""}`)
    .sort();
  return sha256Json(sorted);
}

export { SEVERITY_ORDER };
