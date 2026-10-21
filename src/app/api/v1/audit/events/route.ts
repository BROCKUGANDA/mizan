import { withApiRoute, json } from "@/lib/server/api";
import { db } from "@/lib/db";
import { verifyChain } from "@/lib/audit/chain";

export const dynamic = "force-dynamic";

/** GET /api/v1/audit/events — trail search (audit + admin roles). */
export const GET = withApiRoute(async ({ req, actor }) => {
  if (!["auditor", "admin", "compliance_lead", "analyst", "team_lead"].includes(actor.role)) {
    return json({ items: [], note: "Read-only audit room" });
  }
  const url = new URL(req.url);
  const take = Math.min(200, parseInt(url.searchParams.get("limit") ?? "80", 10));
  const type = url.searchParams.get("type");
  const entityId = url.searchParams.get("entityId");
  const events = await db.auditEvent.findMany({
    where: { ...(type ? { type } : {}), ...(entityId ? { entityId } : {}) },
    orderBy: { seq: "desc" },
    take,
  });
  const verify = await verifyChain();
  return json({ items: events, head: events[0]?.seq ?? 0, verification: verify });
});
