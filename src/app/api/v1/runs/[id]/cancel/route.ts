import { withApiRoute, json } from "@/lib/server/api";
import { db } from "@/lib/db";
import { MzError } from "@/lib/domain/errors";
import { appendAudit } from "@/lib/audit/chain";

export const dynamic = "force-dynamic";

/** POST /api/v1/runs/{id}/cancel — cancel a queued or running run. */
export const POST = withApiRoute<{ id: string }>(async ({ actor, params }) => {
  const run = await db.run.findUnique({ where: { id: params.id } });
  if (!run) throw new MzError("MZ-AUTH-403", "Not found");
  if (!["QUEUED", "RUNNING", "FINALIZING"].includes(run.status)) {
    throw new MzError("MZ-VAL-422", `Run ${run.id} is already ${run.status}.`);
  }
  await db.run.update({ where: { id: run.id }, data: { status: "CANCELLED", finishedAt: new Date() } });
  await appendAudit({ actor: actor.id, type: "run.cancelled", entity: "run", entityId: run.id, payload: { from: run.status } });
  return json({ ok: true, runId: run.id, status: "CANCELLED" });
});
