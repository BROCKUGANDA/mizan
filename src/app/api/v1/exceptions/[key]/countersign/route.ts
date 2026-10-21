import { withApiRoute, json, requireMode } from "@/lib/server/api";
import { db } from "@/lib/db";
import { withIdempotency } from "@/lib/server/idempotency";
import { appendAudit } from "@/lib/audit/chain";
import { MzError } from "@/lib/domain/errors";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/exceptions/{key}/countersign — second-person countersign for
 * High/Critical dismissals (FS-18). The countersigner must differ from the decider
 * and cannot countersign their own decision.
 */
export const POST = withApiRoute<{ key: string }>(async ({ req, actor, params }) => {
  const exceptionKey = params.key;
  const idempotencyKey = req.headers.get("idempotency-key");
  const body = (await req.json().catch(() => ({}))) as { note?: string };

  await requireMode("decision");

  const result = await withIdempotency(idempotencyKey, "countersign", { exceptionKey, note: body.note ?? null }, async () => {
    const e = await db.exception.findUnique({ where: { exceptionKey } });
    if (!e) throw new MzError("MZ-AUTH-403", "Not found");
    if (!["HIGH", "CRITICAL"].includes(e.severity)) {
      throw new MzError("MZ-VAL-422", "Countersign is only required for High or Critical dismissals.");
    }
    const pending = await db.decision.findFirst({
      where: { exceptionKey, command: "dismiss", countersignedBy: null },
      orderBy: { createdAt: "desc" },
    });
    if (!pending) throw new MzError("MZ-VAL-422", "No dismissal is waiting for a countersign.");
    if (pending.actorId === actor.id) {
      throw new MzError("MZ-AUTH-403", "Self-countersigning is impossible: the countersigner must be a second analyst (EC-J08).");
    }
    await db.decision.update({ where: { id: pending.id }, data: { countersignedBy: actor.id } });
    if (e.status === "TRIAGED") {
      await db.exception.update({ where: { exceptionKey }, data: { status: "DISMISSED", version: e.version + 1, updatedAt: new Date() } });
    }
    const audit = await appendAudit({
      actor: actor.id, type: "decision.countersign", entity: "exception", entityId: exceptionKey,
      payload: { decisionId: pending.id, dismissedBy: pending.actorId, note: body.note ? "[redacted]" : null },
    });
    return { ok: true, status: e.status === "TRIAGED" ? "DISMISSED" : e.status, countersignedBy: actor.id, auditHash: audit.hash };
  });

  return json(result.result);
});
