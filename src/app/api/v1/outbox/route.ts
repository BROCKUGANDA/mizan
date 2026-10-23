import { withApiRoute, json } from "@/lib/server/api";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/outbox — the transactional outbox viewer. In-app messages are
 * delivered by the relay; email/webhook need a configured endpoint and flag.
 */
export const GET = withApiRoute(async () => {
  const items = await db.outbox.findMany({ orderBy: { createdAt: "desc" }, take: 80 });
  return json({
    items: items.map((o) => ({ id: o.id, type: o.type, status: o.status, attempts: o.attempts, payload: JSON.parse(o.payloadJson), createdAt: o.createdAt, sentAt: o.sentAt })),
    channels: {
      inapp: "active",
      email: process.env.MIZAN_SMTP_URL ? "configured" : "not configured (notifications.email.enabled must be true)",
      webhook: process.env.MIZAN_WEBHOOK_URL ? "configured" : "not configured (notifications.webhook.enabled must be true)",
    },
  });
});
