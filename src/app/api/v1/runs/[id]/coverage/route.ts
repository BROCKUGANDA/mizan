import { withApiRoute, json } from "@/lib/server/api";
import { db } from "@/lib/db";
import { MzError } from "@/lib/domain/errors";

export const dynamic = "force-dynamic";

/** GET /api/v1/runs/{id}/coverage — the coverage matrix (rules × outcomes). */
export const GET = withApiRoute<{ id: string }>(async ({ params }) => {
  const run = await db.run.findUnique({ where: { id: params.id } });
  if (!run) throw new MzError("MZ-AUTH-403", "Not found");
  const perRule = JSON.parse(run.perRuleJson || "{}") as Record<string, { total: number; pass: number; notApplicable: number; notEvaluable: number; failed: number }>;
  const counts = JSON.parse(run.countsJson || "{}");
  const rules = await db.rule.findMany({ where: { id: { in: Object.keys(perRule) } }, select: { id: true, title: true, family: true, status: true, version: true } });
  const byId = new Map(rules.map((r) => [r.id, r]));
  return json({
    runId: run.id, asOf: run.asOf, status: run.status, counts,
    rules: Object.entries(perRule).map(([ruleId, c]) => ({
      ruleId, ...byId.get(ruleId), ...c,
      evaluated: c.total - c.notApplicable - c.notEvaluable,
    })),
  });
});
