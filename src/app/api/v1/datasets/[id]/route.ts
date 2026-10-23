import { withApiRoute, json } from "@/lib/server/api";
import { db } from "@/lib/db";
import { MzError } from "@/lib/domain/errors";

export const dynamic = "force-dynamic";

/** GET /api/v1/datasets/{id} — metadata and validation summary. */
export const GET = withApiRoute<{ id: string }>(async ({ params }) => {
  const dataset = await db.dataset.findUnique({ where: { id: params.id } });
  if (!dataset) throw new MzError("MZ-AUTH-403", "Not found");
  const issues = dataset.issuesJson ? JSON.parse(dataset.issuesJson) as Record<string, unknown> : {};
  return json({
    id: dataset.id, kind: dataset.kind, sha256: dataset.sha256, rows: dataset.rows,
    syntheticTag: dataset.syntheticTag, createdAt: dataset.createdAt,
    mappingProfile: dataset.mappingProfileJson ? JSON.parse(dataset.mappingProfileJson) : null,
    issues: {
      ...issues,
      quarantined: (issues.quarantined as unknown[] | undefined)?.length ?? 0,
      dataQuality: Object.keys((issues.dqByRow as Record<string, unknown> | undefined) ?? {}).length,
    },
  });
});
