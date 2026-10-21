import { withApiRoute, json } from "@/lib/server/api";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** GET /api/v1/notifications — in-app notifications for the actor's team. */
export const GET = withApiRoute(async ({ actor }) => {
  const items = await db.outbox.findMany({ where: { type: "notification.inapp" }, orderBy: { createdAt: "desc" }, take: 60 });
  return json({
    items: items.map((o) => {
      const p = JSON.parse(o.payloadJson) as { exceptionKey?: string; team?: string; severity?: string; headline?: string; event?: string; to?: string };
      return {
        id: o.id, at: o.createdAt, exceptionKey: p.exceptionKey ?? null, team: p.team ?? null,
        severity: p.severity ?? null, headline: p.headline ?? p.event ?? o.type, event: p.event ?? null, status: p.to ?? null,
      };
    }),
    actor: actor.id,
  });
});
