import { withApiRoute, json } from "@/lib/server/api";
import { db } from "@/lib/db";
import { computeReadiness, computeHotspots, computeTrends, computeMeasuredPrecision } from "@/lib/server/analytics";
import { coverageReport } from "@/lib/pack/rules";
import { detectPatterns } from "@/lib/server/patterns";
import { loadTransactions, loadEmployees } from "@/lib/server/run-pipeline";

export const dynamic = "force-dynamic";

/** GET /api/v1/overview — census banner, readiness, hotspots, trends, coverage. */
export const GET = withApiRoute(async () => {
  const [latestRun, readiness, hotspots, trends, exceptions] = await Promise.all([
    db.run.findFirst({ orderBy: { startedAt: "desc" } }),
    computeReadiness(),
    computeHotspots(),
    computeTrends(),
    db.exception.findMany({ orderBy: [{ severity: "asc" }, { createdAt: "desc" }] }),
  ]);

  const open = exceptions.filter((e) => !["CLOSED", "DISMISSED", "DUPLICATE", "ACCEPTED_RISK"].includes(e.status));
  const openBySeverity: Record<string, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const e of open) openBySeverity[e.severity] = (openBySeverity[e.severity] ?? 0) + 1;

  const topGroups = Object.entries(
    exceptions.reduce<Record<string, number>>((acc, e) => {
      acc[e.groupKey] = (acc[e.groupKey] ?? 0) + 1;
      return acc;
    }, {})
  ).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([groupKey, count]) => {
      const sample = exceptions.find((e) => e.groupKey === groupKey)!;
      return { groupKey, count, ruleId: sample.ruleId, family: sample.family, headline: sample.headlineEn };
    });

  const measuredPrecision = await computeMeasuredPrecision();

  return json({
    census: latestRun
      ? {
          runId: latestRun.id, status: latestRun.status, asOf: latestRun.asOf,
          ...JSON.parse(latestRun.countsJson),
          holds: JSON.parse(latestRun.holdsJson ?? "[]"),
          outputHash: latestRun.outputHash,
        }
      : null,
    counts: { open: open.length, openBySeverity, total: exceptions.length },
    readiness,
    hotspots,
    trends,
    topGroups,
    coverage: coverageReport(),
    measuredPrecision,
    patternsSummary: (await (async () => {
      const [transactions, employees] = await Promise.all([loadTransactions(), loadEmployees()]);
      return detectPatterns(transactions, employees).length;
    })()),
  });
});
