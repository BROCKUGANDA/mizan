import { withApiRoute, json } from "@/lib/server/api";
import { db } from "@/lib/db";
import { MzError } from "@/lib/domain/errors";

export const dynamic = "force-dynamic";

/** GET /api/v1/exceptions/{key}/events — the exception's audit trail. */
export const GET = withApiRoute<{ key: string }>(async ({ req, params }) => {
  const e = await db.exception.findUnique({ where: { exceptionKey: params.key } });
  if (!e) throw new MzError("MZ-AUTH-403", "Not found");
  const url = new URL(req.url);
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") ?? "200", 10)));
  const events = await db.auditEvent.findMany({ where: { entityId: e.exceptionKey }, orderBy: { seq: "asc" }, take: limit });
  return json({ items: events.map((ev) => ({ seq: ev.seq, at: ev.at, actor: ev.actor, type: ev.type, payload: JSON.parse(ev.payloadJson), prevHash: ev.prevHash, hash: ev.hash })) });
});
