import { withApiRoute, json, requireMode } from "@/lib/server/api";
import { db } from "@/lib/db";
import { MzError } from "@/lib/domain/errors";
import { withIdempotency } from "@/lib/server/idempotency";
import { appendAudit } from "@/lib/audit/chain";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";

/** POST /api/v1/exceptions/{key}/assignments — assign an owner with a reason. */
export const POST = withApiRoute<{ key: string }>(async ({ req, actor, params }) => {
  await requireMode("decision");
  if (!["team_lead", "compliance_lead", "admin"].includes(actor.role)) throw new MzError("MZ-AUTH-403", "Only a team lead can assign an exception.");
  const ifMatch = req.headers.get("if-match");
  if (!ifMatch) throw new MzError("MZ-CONC-428", "If-Match is required for an assignment.");
  const body = (await req.json()) as { ownerUserId?: string; reason?: string };
  if (!body.ownerUserId) throw new MzError("MZ-VAL-422", "ownerUserId is required.");
  if (!body.reason || body.reason.trim().length < 5) throw new MzError("MZ-VAL-422", "Assigning needs a reason.");
  const result = await withIdempotency(req.headers.get("idempotency-key"), "assignments", { key: params.key, ...body }, async () => {
    const version = parseInt(ifMatch.replace(/\D/g, ""), 10);
    return db.$transaction(async (tx) => {
      const e = await tx.exception.findUnique({ where: { exceptionKey: params.key } });
      if (!e) throw new MzError("MZ-AUTH-403", "Not found");
      if (version !== e.version) throw new MzError("MZ-CONC-409", "The exception changed since you opened it.", { currentVersion: e.version });
      const owner = await tx.actor.findUnique({ where: { id: body.ownerUserId! } });
      if (!owner || !owner.active) throw new MzError("MZ-VAL-422", "The assigned owner is not an active user.");
      const txn = await tx.txn.findUnique({ where: { rowId: e.rowId } });
      if (txn && actor.employeeId) {
        const approvals: { approverId: string | null }[] = txn.approvalsJson ? JSON.parse(txn.approvalsJson) : [];
        const parties = new Set<string>([txn.requesterId ?? "", txn.employeeId, ...approvals.map((a) => a.approverId ?? "")].filter(Boolean));
        if (parties.has(actor.employeeId)) throw new MzError("MZ-AUTH-403-COI", "A party to the transaction cannot assign it.");
      }
      await tx.exception.update({ where: { exceptionKey: e.exceptionKey }, data: { ownerUserId: body.ownerUserId, status: ["NEW", "TRIAGED", "REOPENED"].includes(e.status) ? "ASSIGNED" : e.status, version: e.version + 1, updatedAt: new Date() } });
      const audit = await appendAudit({ actor: actor.id, type: "decision.assign", entity: "exception", entityId: e.exceptionKey, payload: { ownerUserId: body.ownerUserId, reason: "[redacted]", from: e.status } }, tx);
      await tx.decision.create({ data: { id: randomUUID(), exceptionKey: e.exceptionKey, command: "assign", actorId: actor.id, reasonText: body.reason, idempotencyKey: req.headers.get("idempotency-key") ?? randomUUID(), auditHash: audit.hash } });
      await tx.outbox.create({ data: { id: randomUUID(), type: "notification.inapp", payloadJson: JSON.stringify({ exceptionKey: e.exceptionKey, event: "assignment", ownerUserId: body.ownerUserId, headline: e.headlineEn }) } });
      return { ok: true, status: "ASSIGNED", version: e.version + 1, ownerUserId: body.ownerUserId, auditHash: audit.hash };
    }, { timeout: 15_000 });
  }, actor.id);
  return json(result.result);
});
