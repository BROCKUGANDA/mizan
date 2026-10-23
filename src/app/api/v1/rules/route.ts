import { withApiRoute, json } from "@/lib/server/api";
import { db } from "@/lib/db";
import { RULE_SPECS, INTERPRETATIONS, coverageReport } from "@/lib/pack/rules";

export const dynamic = "force-dynamic";

/** GET /api/v1/rules — rules with interpretation records, tests and coverage. */
export const GET = withApiRoute(async () => {
  const rules = await db.rule.findMany({ orderBy: { id: "asc" } });
  const approvals = await db.ruleApproval.findMany();
  return json({
    items: rules.map((r) => ({
      id: r.id,
      title: r.title,
      family: r.family,
      version: r.version,
      status: r.status,
      verbatimText: r.verbatimText,
      anchor: r.anchor,
      textSha256: r.textSha256,
      spec: JSON.parse(r.specJson),
      interpretation: JSON.parse(r.interpretationJson),
      baseSeverity: r.baseSeverity,
      routingProcess: r.routingProcess,
      actionTemplate: r.actionTemplate,
      effectiveFrom: r.effectiveFrom,
      approvals: approvals.filter((a) => a.ruleId === r.id),
    })),
    interpretations: INTERPRETATIONS,
    coverage: coverageReport(),
    specCount: RULE_SPECS.length,
  });
});
