import { withApiRoute, json } from "@/lib/server/api";
import { db } from "@/lib/db";
import { MzError } from "@/lib/domain/errors";
import { withIdempotency } from "@/lib/server/idempotency";
import { appendAudit } from "@/lib/audit/chain";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";

/** POST /api/v1/exceptions/{key}/comments — comment or employee context. */
export const POST = withApiRoute<{ key: string }>(async ({ req, actor, params }) => {
  const e = await db.exception.findUnique({ where: { exceptionKey: params.key } });
  if (!e) throw new MzError("MZ-AUTH-403", "Not found");
  const body = (await req.json()) as { text?: string };
  if (!body.text || !body.text.trim()) throw new MzError("MZ-VAL-422", "A comment cannot be empty.");
  const result = await withIdempotency(req.headers.get("idempotency-key"), "comments", { key: params.key, text: body.text }, async () => {
    const id = randomUUID();
    const audit = await appendAudit({ actor: actor.id, type: "comment.added", entity: "exception", entityId: e.exceptionKey, payload: { commentId: id, text: "[redacted]" } });
    await db.comment.create({ data: { id, exceptionKey: e.exceptionKey, actorId: actor.id, text: body.text!.trim() } });
    return { ok: true, id, auditHash: audit.hash };
  }, actor.id);
  return json(result.result, 201);
});
