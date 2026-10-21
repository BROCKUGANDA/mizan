import { withApiRoute, json } from "@/lib/server/api";
import { db } from "@/lib/db";
import { startRun } from "@/lib/server/run-pipeline";
import { withIdempotency } from "@/lib/server/idempotency";

export const dynamic = "force-dynamic";

export const GET = withApiRoute(async () => {
  const runs = await db.run.findMany({ orderBy: { startedAt: "desc" }, take: 50 });
  return json({
    items: runs.map((r) => ({
      id: r.id, kind: r.kind, status: r.status, asOf: r.asOf, outputHash: r.outputHash,
      counts: JSON.parse(r.countsJson), holds: JSON.parse(r.holdsJson ?? "[]"),
      stages: JSON.parse(r.stagesJson ?? "[]"),
      startedAt: r.startedAt, finishedAt: r.finishedAt,
    })),
  });
});

/** POST /api/v1/runs — start a run (idempotent by key). */
export const POST = withApiRoute(async ({ req, actor }) => {
  const body = (await req.json().catch(() => ({}))) as { kind?: string; asOf?: string };
  const idempotencyKey = req.headers.get("idempotency-key");
  const result = await withIdempotency(idempotencyKey, "runs", body, async () => {
    return startRun({
      kind: (body.kind === "shadow" || body.kind === "backtest" ? body.kind : "standard"),
      asOf: body.asOf && /^\d{4}-\d{2}-\d{2}$/.test(body.asOf) ? body.asOf : undefined,
      actor: actor.id,
    });
  });
  return json(result.result, 202);
});
