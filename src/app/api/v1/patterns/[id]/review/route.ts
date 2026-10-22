import { withApiRoute, json } from "@/lib/server/api";
import { db } from "@/lib/db";
import { randomUUID } from "node:crypto";
import { appendAudit } from "@/lib/audit/chain";
import { MzError } from "@/lib/domain/errors";

export const dynamic = "force-dynamic";

/** POST /api/v1/patterns/{id}/review — promote to rule, monitor, or dismiss (§18). */
export const POST = withApiRoute<{ id: string }>(async ({ req, actor, params }) => {
  const body = (await req.json()) as { action: "promote" | "monitor" | "dismiss" };
  const alert = await db.patternAlert.findUnique({ where: { id: params.id } });
  if (!alert) throw new MzError("MZ-AUTH-403", "Not found");
  const status = body.action === "promote" ? "promoted" : body.action === "monitor" ? "monitored" : "dismissed";
  await db.patternAlert.update({ where: { id: params.id }, data: { status, reviewedBy: actor.id, reviewedAt: new Date() } });
  await appendAudit({ actor: actor.id, type: "pattern.reviewed", entity: "pattern", entityId: params.id, payload: { action: body.action, status } });
  if (body.action === "promote") {
    await db.ruleDraft.create({
      data: {
        id: `draft-${randomUUID().slice(0, 8)}`,
        plainEnglish: `Draft from pattern ${alert.patternId}: ${alert.title}. Review and complete in the studio.`,
        ambiguitiesJson: JSON.stringify([{ chip: "family", options: ["approval_limit", "aggregate_limit"], chosen: null, note: "choose the family for this pattern" }]),
        status: "draft", author: actor.id,
      },
    });
  }
  return json({ ok: true, status });
});
