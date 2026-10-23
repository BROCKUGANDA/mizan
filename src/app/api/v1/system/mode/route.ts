import { withApiRoute, json } from "@/lib/server/api";
import { MzError } from "@/lib/domain/errors";
import { getMode, setMode, MODE_META, type HealthMode } from "@/lib/server/mode";
import { appendAudit, verifyChain } from "@/lib/audit/chain";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const VALID: HealthMode[] = ["M0", "M1", "M2", "M3", "M4", "M5"];

export const GET = withApiRoute(async () => {
  const mode = await getMode();
  return json({ current: mode.mode, label: MODE_META[mode.mode].label, reason: mode.reason, since: mode.since });
});

/** POST /api/v1/system/mode — operator switch with a reason (admin only). */
export const POST = withApiRoute(async ({ req, actor }) => {
  const body = (await req.json()) as { mode: HealthMode; reason?: string; countersignActor?: string };
  if (!VALID.includes(body.mode)) {
    return json({ error: "invalid mode", valid: VALID }, 422);
  }
  if (actor.role !== "admin") {
    return json({ code: "MZ-AUTH-403", title: "Only an administrator can switch modes" }, 403);
  }
  const reason = body.reason?.trim();
  if (!reason || reason.length < 5) {
    return json({ code: "MZ-VAL-422", title: "A reason of at least 5 characters is required" }, 422);
  }
  // Mode changes must work while M4/M5 is active, otherwise the system could
  // never be cleared. Clearing M5 also needs a second administrator (checked
  // by the caller's audit trail in the judge profile; production uses the same
  // two-person rule as rule approval).
  // Clearing safe halt requires a passing integrity verification and a second
  // administrator's countersign (RB-03). M5 always passes through M4.
  if ((await getMode()).mode === "M5" && body.mode !== "M5") {
    if (body.mode !== "M4") throw new MzError("MZ-VAL-422", "Safe halt clears through M4; select read-only first.");
    const verification = await verifyChain();
    if (!verification.ok) throw new MzError("MZ-INT-500", `Cannot clear safe halt: the audit chain still fails at seq ${verification.firstBadSeq}.`);
    if (!body.countersignActor) throw new MzError("MZ-AUTH-403", "Clearing safe halt needs a second administrator's countersign.");
    const second = await db.actor.findUnique({ where: { id: body.countersignActor } });
    if (!second || second.role !== "admin" || second.id === actor.id) throw new MzError("MZ-AUTH-403", "The countersigner must be a different administrator.");
    await appendAudit({ actor: body.countersignActor, type: "mode.countersign", entity: "system_mode", entityId: "default", payload: { mode: body.mode, countersigner: body.countersignActor } });
  }
  await setMode(body.mode, reason, actor.id);
  const mode = await getMode();
  await appendAudit({ actor: actor.id, type: "mode.operator_set", entity: "system_mode", entityId: "default", payload: { mode: body.mode, reason } });
  return json({ current: mode.mode, label: MODE_META[mode.mode].label, reason: mode.reason, since: mode.since });
});
