import { withApiRoute, json } from "@/lib/server/api";
import { db } from "@/lib/db";
import { MzError } from "@/lib/domain/errors";

export const dynamic = "force-dynamic";

/** GET /api/v1/rules/{id}/versions — immutable, effective-dated version history. */
export const GET = withApiRoute<{ id: string }>(async ({ params }) => {
  const versions = await db.ruleVersion.findMany({ where: { ruleId: params.id }, orderBy: { createdAt: "asc" } });
  if (!versions.length) {
    const rule = await db.rule.findUnique({ where: { id: params.id } });
    if (!rule) throw new MzError("MZ-AUTH-403", "Not found");
  }
  return json({
    items: versions.map((v) => ({
      id: v.id, ruleId: v.ruleId, version: v.version, status: v.status,
      effectiveFrom: v.effectiveFrom, author: v.author, specHash: v.specHash,
      backtest: v.backtestJson ? JSON.parse(v.backtestJson) : null, createdAt: v.createdAt,
    })),
  });
});
