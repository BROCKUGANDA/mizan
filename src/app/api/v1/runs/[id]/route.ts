import { withApiRoute, json } from "@/lib/server/api";
import { db } from "@/lib/db";
import { MzError } from "@/lib/domain/errors";

export const dynamic = "force-dynamic";

export const GET = withApiRoute<{ id: string }>(async ({ params }) => {
  const r = await db.run.findUnique({ where: { id: params.id } });
  if (!r) throw new MzError("MZ-AUTH-403", "Not found");
  return json({
    id: r.id, kind: r.kind, status: r.status, asOf: r.asOf, outputHash: r.outputHash,
    manifest: {
      runId: r.id, kind: r.kind, status: r.status, engineVersion: r.engineVersion, packVersion: r.packVersion,
      packHash: r.packHash, calendarHash: r.calendarHash, routingHash: r.routingHash,
      gradeLadderHash: r.gradeLadderHash, synonymsHash: r.synonymsHash, configHash: r.configHash,
      flagsHash: r.flagsHash, asOf: r.asOf, inputs: JSON.parse(r.inputsJson),
      counts: JSON.parse(r.countsJson), outputHash: r.outputHash,
      startedAt: r.startedAt, finishedAt: r.finishedAt,
    },
    perRule: JSON.parse(r.perRuleJson),
    holds: JSON.parse(r.holdsJson ?? "[]"),
    stages: JSON.parse(r.stagesJson ?? "[]"),
  });
});
