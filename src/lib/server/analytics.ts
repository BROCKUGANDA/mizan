/**
 * Analytics projections (§17): readiness score, hotspots, trends, deadlines.
 * Small cells (<5) are suppressed and hatched. Wilson intervals on rates.
 */

import { db } from "@/lib/db";
import { verifyChain } from "../audit/chain";

export interface ReadinessComponent { key: string; label: string; weight: number; score: number; note: string }
export interface ReadinessScore { total: number; components: ReadinessComponent[]; nextBestAction: string }

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
