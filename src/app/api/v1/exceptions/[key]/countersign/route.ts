import { withApiRoute, json, requireMode } from "@/lib/server/api";
import { db } from "@/lib/db";
import { withIdempotency } from "@/lib/server/idempotency";
import { appendAudit } from "@/lib/audit/chain";
import { MzError } from "@/lib/domain/errors";
import type { Role } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const COUNTERSIGN_ROLES: Role[] = ["analyst", "team_lead", "compliance_lead", "admin"];

/**
 * POST /api/v1/exceptions/{key}/countersign — second-person countersign for
 * High/Critical dismissals. The countersigner must differ from the decider,
 * must not be a party to the transaction, and must send If-Match.
 */
export const POST = withApiRoute<{ key: string }>(async ({ req, actor, params }) => {
  const exceptionKey = params.key;
  const idempotencyKey = req.headers.get("idempotency-key");
  const ifMatch = req.headers.get("if-match");
  const body = (await req.json().catch(() => ({}))) as { note?: string };
  if (!ifMatch) throw new MzError("MZ-CONC-428", "If-Match is required for the countersign.");
  if (!COUNTERSIGN_ROLES.includes(actor.role as Role)) throw new MzError("MZ-AUTH-403", `Role ${actor.role} cannot countersign.`);

  await requireMode("decision");
  const result = await withIdempotency(idempotencyKey, "countersign", { exceptionKey, note: body.note ?? null }, async () => {
    const clientVersion = parseInt(ifMatch.replace(/\D/g, ""), 10);
    if (isNaN(clientVersion)) throw new MzError("MZ-CONC-428", "If-Match must be the exception version.");

    return db.$transaction(async (tx) => {
      const e = await tx.exception.findUnique({ where: { exceptionKey } });
      if (!e) throw new MzError("MZ-AUTH-403", "Not found");
      if (clientVersion !== e.version) {
        throw new MzError("MZ-CONC-409", "The exception changed since you opened it. Reload before countersigning.", { currentVersion: e.version });
      }
      if (!["HIGH", "CRITICAL"].includes(e.severity)) {
        throw new MzError("MZ-VAL-422", "Countersign is only required for High or Critical dismissals.");
      }
      const pending = await tx.decision.findFirst({
        where: { exceptionKey, command: "dismiss", countersignedBy: null },
        orderBy: { createdAt: "desc" },
      });
      if (!pending) throw new MzError("MZ-VAL-422", "No dismissal is waiting for a countersign.");
      if (pending.actorId === actor.id) {
        throw new MzError("MZ-AUTH-403", "Self-countersigning is impossible: the countersigner must be a second analyst (EC-J08).");
      }
      const txn = await tx.txn.findUnique({ where: { rowId: e.rowId } });
      if (txn && actor.employeeId) {
        const approvals: { approverId: string | null }[] = txn.approvalsJson ? JSON.parse(txn.approvalsJson) : [];
        const parties = new Set<string>([txn.requesterId ?? "", txn.employeeId, ...approvals.map((a) => a.approverId ?? "")].filter(Boolean));
        if (parties.has(actor.employeeId)) {
          await appendAudit({ actor: actor.id, type: "decision.refused_coi", entity: "exception", entityId: exceptionKey, payload: { command: "countersign" } }, tx);
          throw new MzError("MZ-AUTH-403-COI", "You are a party to this transaction and cannot countersign its dismissal.");
        }
      }
      await tx.decision.update({ where: { id: pending.id }, data: { countersignedBy: actor.id } });
      if (e.status === "TRIAGED") {
        await tx.exception.update({ where: { exceptionKey }, data: { status: "DISMISSED", version: e.version + 1, updatedAt: new Date() } });
      }
      const audit = await appendAudit({
        actor: actor.id, type: "decision.countersign", entity: "exception", entityId: exceptionKey,
        payload: { decisionId: pending.id, dismissedBy: pending.actorId, note: body.note ? "[redacted]" : null },
      }, tx);
      await tx.outbox.create({ data: { id: `countersign-${pending.id}`, type: "notification.inapp", payloadJson: JSON.stringify({ exceptionKey, event: "decision.countersign", to: "DISMISSED" }) } });
      return { ok: true, status: e.status === "TRIAGED" ? "DISMISSED" : e.status, version: e.version + 1, countersignedBy: actor.id, auditHash: audit.hash };
    }, { timeout: 15_000 });
  }, actor.id);

  return json(result.result);
});
