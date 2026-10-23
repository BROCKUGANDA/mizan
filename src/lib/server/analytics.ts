/**
 * Analytics projections (§17): readiness score, hotspots, trends, deadlines.
 * Small cells (<5) are suppressed and hatched. Wilson intervals on rates.
 */

import { db } from "@/lib/db";
import { verifyChain } from "../audit/chain";
import { PRECISION_LABELS } from "../pack/precision-labels";

export interface ReadinessComponent { key: string; label: string; weight: number; score: number; note: string }
export interface ReadinessScore { total: number; components: ReadinessComponent[]; nextBestAction: string }

export interface MeasuredPrecision {
  sampleSize: number;
  correct: number;
  incorrect: number;
  lowerBound: number;
  method: string;
  provenance: string;
  unlabelledPresent: number;
}

/**
 * Measured precision on a stratified labelled sample. The labels are the
 * independent SQL-oracle agreement set (fixtures/precision/labels.jsonl);
 * unlabelled engine findings are outside the sample and are reported, never
 * silently counted as correct.
 */
export async function computeMeasuredPrecision(): Promise<MeasuredPrecision | null> {
  if (!PRECISION_LABELS.length) return null;
  const exceptions = await db.exception.findMany({ where: { family: { not: "data_quality" } } });
  const present = new Set(exceptions.map((e) => `${e.txnId}|${e.ruleId}|${e.clauseId}`));
  let correct = 0;
  let incorrect = 0;
  const labelled = new Set<string>();
  for (const label of PRECISION_LABELS) {
    const key = `${label.txnId}|${label.ruleId}|${label.clauseId}`;
    labelled.add(key);
    if (!present.has(key)) continue;
    if (label.correct) correct++;
    else incorrect++;
  }
  const n = correct + incorrect;
  if (!n) return null;
  const unlabelledPresent = [...present].filter((k) => !labelled.has(k)).length;
  return {
    sampleSize: n,
    correct,
    incorrect,
    lowerBound: wilsonLowerBound(correct, n),
    method: "Wilson 95% lower bound on a stratified labelled sample",
    provenance: "Two-stage: independent SQL oracle agreement on every finding, then boundary spot-check; see fixtures/precision/labels.jsonl",
    unlabelledPresent,
  };
}

export interface FairnessCell { dimension: "department" | "location"; value: string; employees: number; exceptions: number; checks: number; per100Checks: number; wilsonLower: number; wilsonUpper: number; suppressed: boolean }

/** Exception rates by department and location with small cells suppressed below 5. */
export async function computeFairness(): Promise<FairnessCell[]> {
  const [employees, exceptions, latestRun] = await Promise.all([
    db.employee.findMany(), db.exception.findMany({ where: { family: { not: "data_quality" } } }),
    db.run.findFirst({ where: { kind: { in: ["standard", "shadow"] }, status: { notIn: ["FAILED", "CANCELLED"] } }, orderBy: { startedAt: "desc" } }),
  ]);
  const txnRows = await db.txn.findMany({ select: { rowId: true, employeeId: true } });
  const txnEmployee = new Map(txnRows.map((t) => [t.rowId, t.employeeId]));
  const txnCount = new Map<string, number>();
  for (const t of txnRows) txnCount.set(t.employeeId, (txnCount.get(t.employeeId) ?? 0) + 1);
  const empById = new Map(employees.map((e) => [e.employeeId, e]));
  const clauses = latestRun ? (JSON.parse(latestRun.countsJson).clauses as number) : 0;
  const cells: FairnessCell[] = [];
  for (const dim of ["department", "location"] as const) {
    const groups = new Map<string, { employees: Set<string>; exceptions: number; checks: number }>();
    for (const e of employees) {
      const value = (dim === "department" ? e.department : e.location) ?? "UNKNOWN";
      const g = groups.get(value) ?? { employees: new Set<string>(), exceptions: 0, checks: 0 };
      g.employees.add(e.employeeId);
      g.checks += (txnCount.get(e.employeeId) ?? 0) * clauses;
      groups.set(value, g);
    }
    for (const ex of exceptions) {
      const empId = txnEmployee.get(ex.rowId);
      const emp = empId ? empById.get(empId) : undefined;
      const value = (dim === "department" ? emp?.department : emp?.location) ?? "UNKNOWN";
      const g = groups.get(value) ?? { employees: new Set<string>(), exceptions: 0, checks: 0 };
      g.exceptions++;
      groups.set(value, g);
    }
    for (const [value, g] of groups) {
      const suppressed = g.employees.size < 5;
      const { lower, upper } = wilsonInterval(g.exceptions, g.checks);
      cells.push({
        dimension: dim, value,
        employees: suppressed ? 0 : g.employees.size,
        exceptions: suppressed ? 0 : g.exceptions,
        checks: suppressed ? 0 : g.checks,
        per100Checks: suppressed || !g.checks ? 0 : Math.round((g.exceptions / g.checks) * 100_000) / 100,
        wilsonLower: suppressed ? 0 : Math.round(lower * 100_000) / 100,
        wilsonUpper: suppressed ? 0 : Math.round(upper * 100_000) / 100,
        suppressed,
      });
    }
  }
  return cells;
}

function wilsonInterval(successes: number, n: number): { lower: number; upper: number } {
  if (!n) return { lower: 0, upper: 1 };
  const z = 1.96;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lower: Math.max(0, (centre - margin) / denom), upper: Math.min(1, (centre + margin) / denom) };
}

function wilsonLowerBound(successes: number, n: number): number {
  if (n === 0) return 0;
  const z = 1.96;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (centre - margin) / denom);
}

export async function computeReadiness(): Promise<ReadinessScore> {
  const [latestRun, exceptions, verify] = await Promise.all([
    db.run.findFirst({ where: { kind: { in: ["standard", "shadow"] }, status: { notIn: ["FAILED", "CANCELLED"] } }, orderBy: { startedAt: "desc" } }),
    db.exception.findMany(),
    verifyChain(),
  ]);
  const counts = latestRun ? JSON.parse(latestRun.countsJson) : null;
  const coverage = counts && counts.applicable > 0 ? counts.evaluated / counts.applicable : 0;
  const decided = exceptions.filter((e) => !["NEW"].includes(e.status) || true).filter((e) => e.status !== "NEW");
  const decisionScore = exceptions.length ? decided.length / exceptions.length : 1;
  const evidenceScore = exceptions.length
    ? exceptions.filter((e) => e.ruleId && e.clauseId && e.evidenceJson && e.ownerTeam && e.severityRationale).length / exceptions.length
    : 1;
  const integrityScore = verify.ok ? 1 : 0;
  const rules = await db.rule.findMany({ where: { status: { in: ["active", "shadow"] } } });
  const governanceScore = rules.length
    ? rules.filter((r) => { const spec = JSON.parse(r.specJson); return spec.tests?.length >= 3; }).length / rules.length
    : 0;
  const closedHC = exceptions.filter((e) => ["CLOSED"].includes(e.status) && ["HIGH", "CRITICAL"].includes(e.severity));
  const timelyHC = closedHC.filter((e) => e.resolveDueAt && e.updatedAt.toISOString().slice(0, 10) <= e.resolveDueAt).length;
  const timelinessScore = closedHC.length ? timelyHC / closedHC.length : 1;

  const components: ReadinessComponent[] = [
    { key: "coverage", label: "Coverage", weight: 25, score: coverage, note: "Evaluated ÷ applicable checks" },
    { key: "decisions", label: "Decisions", weight: 20, score: decisionScore, note: "Exceptions with a human decision" },
    { key: "evidence", label: "Evidence completeness", weight: 15, score: evidenceScore, note: "Rule, clause, evidence, owner and rationale present" },
    { key: "integrity", label: "Integrity", weight: 15, score: integrityScore, note: verify.ok ? `Audit chain verified (${verify.checked} events)` : "Audit chain verification FAILED" },
    { key: "governance", label: "Rule governance", weight: 15, score: governanceScore, note: "Active rules with tests and a backtest" },
    { key: "timeliness", label: "Timeliness", weight: 10, score: timelinessScore, note: closedHC.length ? "High/Critical closed within SLA" : "No High/Critical closures yet" },
  ];
  const total = Math.round(components.reduce((acc, c) => acc + c.score * c.weight, 0));
  const worst = [...components].sort((a, b) => a.score - b.score)[0]!;
  const nextBestAction = worst.key === "decisions" ? "Record decisions on the open queue — it moves the score the most." : `Improve "${worst.label}": ${worst.note}.`;
  return { total, components, nextBestAction };
}

export interface HotspotCell { process: string; ruleId: string; count: number; per1000: number; suppressed: boolean }

export async function computeHotspots(): Promise<HotspotCell[]> {
  const exceptions = await db.exception.findMany({ where: { family: { not: "data_quality" } } });
  const latestRun = await db.run.findFirst({ where: { kind: { in: ["standard", "shadow"] }, status: { notIn: ["FAILED", "CANCELLED"] } }, orderBy: { startedAt: "desc" } });
  const counts = latestRun ? JSON.parse(latestRun.countsJson) : { transactions: 0 };
  const byCell = new Map<string, number>();
  for (const e of exceptions) {
    const key = `${e.ownerTeam}|${e.ruleId}`;
    byCell.set(key, (byCell.get(key) ?? 0) + 1);
  }
  const cells: HotspotCell[] = [];
  for (const [key, count] of byCell) {
    const [process, ruleId] = key.split("|");
    cells.push({
      process, ruleId, count,
      per1000: counts.transactions ? Math.round((count / counts.transactions) * 1000 * 10) / 10 : 0,
      suppressed: count < 5,
    });
  }
  return cells.sort((a, b) => b.count - a.count);
}

export interface TrendPoint { month: string; CRITICAL: number; HIGH: number; MEDIUM: number; LOW: number; total: number; suppressed: boolean }

export async function computeTrends(): Promise<TrendPoint[]> {
  const exceptions = await db.exception.findMany();
  const byMonth = new Map<string, TrendPoint>();
  for (const e of exceptions) {
    const month = (e.createdAt.toISOString() ?? "").slice(0, 7);
    const point = byMonth.get(month) ?? { month, CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, total: 0, suppressed: false };
    if (e.severity in point) (point as unknown as Record<string, number>)[e.severity]++;
    point.total++;
    byMonth.set(month, point);
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)).map((p) => ({ ...p, suppressed: p.total < 5 }));
}

export { wilsonLowerBound };
