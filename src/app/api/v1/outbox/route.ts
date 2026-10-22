import { withApiRoute, json } from "@/lib/server/api";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/outbox — the in-app outbox viewer (judge profile O3).
 * In production the relay delivers email/webhook/Teams; the channels are stubbed
 * behind integrations (see src/lib/integrations/notify.ts).
 */
export const GET = withApiRoute(async () => {
  const items = await db.outbox.findMany({ orderBy: { createdAt: "desc" }, take: 80 });
  return json({
    items: items.map((o) => ({ id: o.id, type: o.type, status: o.status, attempts: o.attempts, payload: JSON.parse(o.payloadJson), createdAt: o.createdAt, sentAt: o.sentAt })),
    channels: {
      inapp: "active",
      email: "stub (integration point: SMTP / Microsoft Graph)",
      webhook: "stub (integration point: outbound webhook receiver)",
    },
  });
});
