import { withApiRoute, json, requireMode } from "@/lib/server/api";
import { getMode, setMode, MODE_META, type HealthMode } from "@/lib/server/mode";
import { appendAudit } from "@/lib/audit/chain";

export const dynamic = "force-dynamic";

const VALID: HealthMode[] = ["M0", "M1", "M2", "M3", "M4", "M5"];

export const GET = withApiRoute(async () => {
  const mode = await getMode();
  return json({ current: mode.mode, label: MODE_META[mode.mode].label, reason: mode.reason, since: mode.since });
});

/** POST /api/v1/system/mode — operator switch with a reason (admin only). */
export const POST = withApiRoute(async ({ req, actor }) => {
  const body = (await req.json()) as { mode: HealthMode; reason?: string };
  if (!VALID.includes(body.mode)) {
    return json({ error: "invalid mode", valid: VALID }, 422);
  }
  if (actor.role !== "admin" && actor.role !== "compliance_lead") {
    return json({ code: "MZ-AUTH-403", title: "Only an administrator can switch modes" }, 403);
  }
  const reason = body.reason?.trim();
  if (!reason || reason.length < 5) {
    return json({ code: "MZ-VAL-422", title: "A reason of at least 5 characters is required" }, 422);
  }
  await requireMode("config");
  await setMode(body.mode, reason, actor.id);
  const mode = await getMode();
  await appendAudit({ actor: actor.id, type: "mode.operator_set", entity: "system_mode", entityId: "default", payload: { mode: body.mode, reason } });
  return json({ current: mode.mode, label: MODE_META[mode.mode].label, reason: mode.reason, since: mode.since });
});
