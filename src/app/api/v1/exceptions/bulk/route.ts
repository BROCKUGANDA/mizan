import { withApiRoute, json, requireMode } from "@/lib/server/api";
import { db } from "@/lib/db";
import { randomUUID } from "node:crypto";
import { withIdempotency } from "@/lib/server/idempotency";
import { roleCan } from "@/lib/server/session";
import { appendAudit } from "@/lib/audit/chain";
import { MzError } from "@/lib/domain/errors";

export const dynamic = "force-dynamic";

const BULK_CAP = 200;
const BULK_UNDO_WINDOW_MS = 10_000;

interface BulkBody {
  keys: string[];
  command: "dismiss" | "triage";
  reasonCategory?: string;
  reasonText?: string;
  confirmText?: string;
  undoOf?: string; // bulk id when undoing
}

/**
 * POST /api/v1/exceptions/bulk — bulk decisions with FS-18 limits:
 * cap 200, High/Critical excluded from dismissal, preview + typed confirmation,
 * one record per item, 10-second undo. Without `confirmText` returns the preview.
 */
export const POST = withApiRoute(async ({ req, actor }) => {
  await requireMode("decision");
  const body = (await req.json()) as BulkBody;
  const bulkEnabled = await db.featureFlag.findUnique({ where: { key: "bulk.enabled" } });
  if (bulkEnabled?.value === "false") throw new MzError("MZ-MODE-503", "Bulk decisions are off by flag bulk.enabled.");

  if (body.undoOf) {
    return json(await undo(actor.id, body.undoOf));
  }
  if (!roleCan(actor.role as never, body.command)) throw new MzError("MZ-AUTH-403", `Role ${actor.role} cannot run bulk ${body.command}.`);
  if (!Array.isArray(body.keys) || body.keys.length === 0) throw new MzError("MZ-VAL-422", "No items selected.");
  if (body.keys.length > BULK_CAP) throw new MzError("MZ-BULK-422", `Bulk actions cap at ${BULK_CAP} items.`);
  if (body.command === "dismiss" && (!body.reasonCategory || !body.reasonText || body.reasonText.trim().length < 15)) {
    throw new MzError("MZ-VAL-422", "A bulk dismissal needs a reason category and a reason of at least 15 characters.");
  }

  const items = await db.exception.findMany({ where: { exceptionKey: { in: body.keys } } });
  const excluded: { exceptionKey: string; reason: string }[] = [];
  const eligible: typeof items = [];
  for (const item of items) {
    if (body.command === "dismiss" && ["HIGH", "CRITICAL"].includes(item.severity)) {
      excluded.push({ exceptionKey: item.exceptionKey, reason: `dismissal of a ${item.severity} exception is never bulk` });
      continue;
    }
    if (!["TRIAGED"].includes(item.status)) {
      excluded.push({ exceptionKey: item.exceptionKey, reason: `status ${item.status} does not allow ${body.command}` });
      continue;
    }
    eligible.push(item);
  }

  // Preview when not confirmed: typed confirmation must be "BULK <n>"
  if (body.confirmText !== `BULK ${eligible.length}`) {
    return json({
      preview: true,
      eligible: eligible.map((e) => ({ exceptionKey: e.exceptionKey, displayId: e.displayId, severity: e.severity, headlineEn: e.headlineEn })),
      excluded,
      confirmTextRequired: `BULK ${eligible.length}`,
    });
  }

  const bulkId = randomUUID();
  const decisionIds: string[] = [];
  for (const item of eligible) {
    const audit = await appendAudit({
      actor: actor.id, type: `decision.bulk_${body.command}`, entity: "exception", entityId: item.exceptionKey,
      payload: { bulkId, command: body.command, from: item.status, to: body.command === "dismiss" ? "DISMISSED" : "TRIAGED" },
    });
    const decisionId = randomUUID();
    decisionIds.push(decisionId);
    await db.decision.create({
      data: {
        id: decisionId, exceptionKey: item.exceptionKey, command: body.command, actorId: actor.id,
        reasonCategory: body.reasonCategory, reasonText: body.reasonText,
        countersignedBy: "not-required", idempotencyKey: `bulk-${bulkId}-${item.exceptionKey}`, auditHash: audit.hash,
      },
    });
    await db.exception.update({ where: { exceptionKey: item.exceptionKey }, data: { status: body.command === "dismiss" ? "DISMISSED" : "TRIAGED", version: item.version + 1, updatedAt: new Date() } });
  }
  await appendAudit({ actor: actor.id, type: "bulk.completed", entity: "bulk", entityId: bulkId, payload: { count: eligible.length, excluded: excluded.length, undoWindowMs: BULK_UNDO_WINDOW_MS } });
  return json({ ok: true, bulkId, applied: eligible.length, excluded, undoAvailableForMs: BULK_UNDO_WINDOW_MS });
});

async function undo(actorId: string, bulkId: string): Promise<Record<string, unknown>> {
  const events = await db.auditEvent.findMany({ where: { entityId: bulkId, type: "bulk.completed" }, orderBy: { seq: "desc" }, take: 1 });
  const ev = events[0];
  if (!ev) throw new MzError("MZ-VAL-422", "Unknown bulk id.");
  if (Date.now() - new Date(ev.at).getTime() > BULK_UNDO_WINDOW_MS) {
    throw new MzError("MZ-VAL-422", "The 10-second undo window has passed.");
  }
  const decisions = await db.decision.findMany({ where: { id: { not: "" } } });
  void decisions;
  const items = await db.exception.findMany({ where: { status: "DISMISSED" } });
  let undone = 0;
  for (const item of items) {
    const d = await db.decision.findFirst({ where: { exceptionKey: item.exceptionKey, command: "dismiss", idempotencyKey: { startsWith: `bulk-${bulkId}` } } });
    if (d) {
      await db.exception.update({ where: { exceptionKey: item.exceptionKey }, data: { status: "TRIAGED", version: item.version + 1 } });
      await appendAudit({ actor: actorId, type: "bulk.undone", entity: "exception", entityId: item.exceptionKey, payload: { bulkId } });
      undone++;
    }
  }
  return { ok: true, undone };
}
