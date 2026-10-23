import { withApiRoute, json } from "@/lib/server/api";
import { db } from "@/lib/db";
import { MzError } from "@/lib/domain/errors";

export const dynamic = "force-dynamic";

const LIMIT = 200;

/** GET /api/v1/datasets/{id}/issues — quarantined rows, DQ tags, mapping drift. */
export const GET = withApiRoute<{ id: string }>(async ({ req, params }) => {
  const dataset = await db.dataset.findUnique({ where: { id: params.id } });
  if (!dataset) throw new MzError("MZ-AUTH-403", "Not found");
  const issues = dataset.issuesJson ? JSON.parse(dataset.issuesJson) as { quarantined?: unknown[]; dqByRow?: Record<string, string[]>; unknownColumns?: string[]; drift?: boolean } : {};
  const url = new URL(req.url);
  const limit = Math.min(LIMIT, Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10)));
  const quarantined = issues.quarantined ?? [];
  const dq = Object.entries(issues.dqByRow ?? {}).map(([rowNumber, codes]) => ({ rowNumber: Number(rowNumber), codes }));
  return json({
    datasetId: dataset.id,
    summary: {
      quarantined: quarantined.length,
      dataQualityRows: dq.length,
      unknownColumns: issues.unknownColumns ?? [],
      schemaDrift: issues.drift === true,
    },
    quarantined: quarantined.slice(0, limit),
    dataQuality: dq.slice(0, limit),
    nextCursor: quarantined.length > limit ? String(limit) : null,
  });
});
