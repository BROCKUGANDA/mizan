import { withApiRoute, json } from "@/lib/server/api";
import { db } from "@/lib/db";
import { appendAudit } from "@/lib/audit/chain";
import { MzError } from "@/lib/domain/errors";
import type { Role } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const BOOLEAN_FLAGS = new Set([
  "ai.narrative.enabled", "ai.authoring.enabled", "routing.enabled",
  "notifications.email.enabled", "notifications.webhook.enabled",
  "runs.enabled", "patterns.enabled", "uploads.enabled",
  "exports.findings.enabled", "bulk.enabled",
]);
const NUMBER_BOUNDS: Record<string, [number, number]> = {
  "flood_guard.multiplier": [2, 5],
  "flood_guard.min_pp": [1, 5],
};
const ADMIN_ONLY = new Set([
  "ai.mode", "ai.narrative.enabled", "ai.authoring.enabled", "notifications.email.enabled",
  "notifications.webhook.enabled", "runs.enabled", "uploads.enabled", "mode.override",
]);
const COMPLIANCE_FLAGS = new Set(["routing.enabled", "patterns.enabled", "exports.findings.enabled", "bulk.enabled", "flood_guard.multiplier", "flood_guard.min_pp"]);

/** GET /api/v1/flags — flags with who changed what and when. */
export const GET = withApiRoute(async () => {
  const flags = await db.featureFlag.findMany({ orderBy: { key: "asc" } });
  return json({ items: flags });
});

/** POST /api/v1/flags — validated change with a reason (audited; effective immediately). */
export const POST = withApiRoute(async ({ req, actor }) => {
  const body = (await req.json()) as { key: string; value: string; reason?: string };
  if (!body.key || typeof body.key !== "string") throw new MzError("MZ-VAL-422", "A flag key is required.");
  if (!body.reason || body.reason.trim().length < 5) throw new MzError("MZ-VAL-422", "Every flag change needs a reason.");

  const ruleHold = /^rule\.[A-Z0-9]+\.hold$/.test(body.key);
  if (ruleHold) {
    const ruleId = body.key.split(".")[1]!;
    const rule = await db.rule.findUnique({ where: { id: ruleId } });
    if (!rule) throw new MzError("MZ-VAL-422", `Unknown rule ${ruleId}.`);
  }
  const existing = await db.featureFlag.findUnique({ where: { key: body.key } });
  if (!existing && !ruleHold) throw new MzError("MZ-VAL-422", `Unknown flag ${body.key}.`);

  const allowedRoles: Role[] = ruleHold ? ["admin", "compliance_lead", "policy_author", "policy_approver"] : ADMIN_ONLY.has(body.key) ? ["admin"] : COMPLIANCE_FLAGS.has(body.key) ? ["admin", "compliance_lead"] : ["admin"];
  if (!allowedRoles.includes(actor.role)) {
    throw new MzError("MZ-AUTH-403", `Role ${actor.role} cannot change ${body.key}.`);
  }

  const value = String(body.value);
  if (body.key === "ai.mode") {
    if (!["none", "local", "provider"].includes(value)) throw new MzError("MZ-VAL-422", "ai.mode must be none, local or provider.");
    if (value === "local" && !process.env.MIZAN_MODEL_URL) throw new MzError("MZ-VAL-422", "ai.mode=local requires MIZAN_MODEL_URL (no model gateway is configured).");
    if (value === "provider" && !process.env.MIZAN_MODEL_PROVIDER_URL) throw new MzError("MZ-VAL-422", "ai.mode=provider requires MIZAN_MODEL_PROVIDER_URL (no approved provider is configured).");
  } else if (ruleHold) {
    if (!["true", "false"].includes(value)) throw new MzError("MZ-VAL-422", `${body.key} must be true or false.`);
  } else if (BOOLEAN_FLAGS.has(body.key)) {
    if (!["true", "false"].includes(value)) throw new MzError("MZ-VAL-422", `${body.key} must be true or false.`);
  } else if (body.key in NUMBER_BOUNDS) {
    const [min, max] = NUMBER_BOUNDS[body.key]!;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new MzError("MZ-VAL-422", `${body.key} must be between ${min} and ${max}.`);
  } else {
    throw new MzError("MZ-VAL-422", `Flag ${body.key} has no validator.`);
  }

  if (existing) {
    await db.featureFlag.update({ where: { key: body.key }, data: { value, updatedBy: actor.id, reason: body.reason } });
  } else {
    await db.featureFlag.create({ data: { key: body.key, value, updatedBy: actor.id, reason: body.reason } });
  }
  await appendAudit({ actor: actor.id, type: "flag.changed", entity: "feature_flag", entityId: body.key, payload: { from: existing?.value ?? "false", to: value, reason: "[redacted]" } });
  await db.outbox.create({ data: { id: `flag-${Date.now()}-${body.key}`, type: "flag.changed", payloadJson: JSON.stringify({ key: body.key, from: existing?.value ?? "false", to: value, by: actor.id }) } });
  return json({ ok: true, key: body.key, value });
});
