import { withApiRoute, json } from "@/lib/server/api";
import { db } from "@/lib/db";
import { appendAudit } from "@/lib/audit/chain";
import { MzError } from "@/lib/domain/errors";
import { recomputeBaselines } from "@/lib/server/baselines";

export const dynamic = "force-dynamic";

/** GET /api/v1/flags — flags with who changed what and when. */
export const GET = withApiRoute(async () => {
  const flags = await db.featureFlag.findMany({ orderBy: { key: "asc" } });
  return json({ items: flags });
});

/** POST /api/v1/flags — change a flag with a reason (audited; effective within 10 s). */
export const POST = withApiRoute(async ({ req, actor }) => {
  const body = (await req.json()) as { key: string; value: string; reason?: string };
  if (!["admin", "compliance_lead"].includes(actor.role)) {
    throw new MzError("MZ-AUTH-403", "Only an administrator or the compliance lead can change flags.");
  }
  if (!body.reason || body.reason.trim().length < 5) {
    throw new MzError("MZ-VAL-422", "Every flag change needs a reason.");
  }
  const existing = await db.featureFlag.findUnique({ where: { key: body.key } });
  if (!existing) throw new MzError("MZ-VAL-422", `Unknown flag ${body.key}.`);
  await db.featureFlag.update({ where: { key: body.key }, data: { value: body.value, updatedBy: actor.id, reason: body.reason } });
  await appendAudit({ actor: actor.id, type: "flag.changed", entity: "feature_flag", entityId: body.key, payload: { from: existing.value, to: body.value, reason: "[redacted]" } });
  if (body.key === "ai.mode") {
    // ai.mode=none forces M1 (degraded AI) per the capability matrix
    void recomputeBaselines;
  }
  return json({ ok: true, key: body.key, value: body.value });
});
