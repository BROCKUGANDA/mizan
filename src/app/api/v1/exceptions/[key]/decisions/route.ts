import { withApiRoute, json, requireMode } from "@/lib/server/api";
import { db } from "@/lib/db";
import { randomUUID } from "node:crypto";
import { withIdempotency } from "@/lib/server/idempotency";
import { roleCan, type Role } from "@/lib/server/session";
import { appendAudit } from "@/lib/audit/chain";
import { MzError } from "@/lib/domain/errors";

export const dynamic = "force-dynamic";

interface DecisionBody {
  command: string;
  reasonCategory?: string;
  reasonText?: string;
  sourceRef?: string;
  expiry?: string;
  canonicalKey?: string;
  ownerUserId?: string;
}

const TRANSITIONS: Record<string, string[]> = {
  triage: ["NEW", "REOPENED"],
  assign: ["TRIAGED"],
  start: ["ASSIGNED"],
  record_fix: ["IN_PROGRESS"],
  verify: ["PENDING_VERIFICATION"],
  fail_verification: ["PENDING_VERIFICATION"],
  dismiss: ["TRIAGED"],
  accept_risk: ["TRIAGED"],
  mark_duplicate: ["TRIAGED"],
  reopen: ["CLOSED", "DISMISSED", "ACCEPTED_RISK", "DUPLICATE"],
  dispute: ["NEW", "TRIAGED", "ASSIGNED", "IN_PROGRESS", "PENDING_VERIFICATION", "REOPENED"],
};

/**
 * POST /api/v1/exceptions/{key}/decisions
 * Requires If-Match (version), Idempotency-Key; runs role, mode and conflict-of-interest
 * checks; writes the state change, an audit event and an outbox row in one transaction.
 */
export const POST = withApiRoute<{ key: string }>(async ({ req, actor, params }) => {
  const exceptionKey = params.key;
  const ifMatch = req.headers.get("if-match");
  const idempotencyKey = req.headers.get("idempotency-key");
  const body = (await req.json()) as DecisionBody;

  if (!ifMatch) throw new MzError("MZ-CONC-428", "If-Match header is required for state changes.");

  const result = await withIdempotency(idempotencyKey, "decisions", { exceptionKey, ...body }, async () => {
    return recordDecision({ exceptionKey, actor, body, ifMatch, idempotencyKey });
  }, actor.id);
  return json(result.result, { headers: { "mizan-idempotent-replay": result.replayed ? "true" : "false" } });
});

async function recordDecision(opts: {
  exceptionKey: string;
  actor: { id: string; name: string; role: string; employeeId: string | null };
  body: DecisionBody;
  ifMatch: string | null;
  idempotencyKey: string | null;
}): Promise<Record<string, unknown>> {
  const { exceptionKey, actor, body, ifMatch } = opts;
  const command = body.command;

  await requireMode("decision");
  if (!roleCan(actor.role as Role, command)) {
    throw new MzError("MZ-AUTH-403", `Role ${actor.role} cannot run ${command}.`);
  }
  const validCommands = Object.keys(TRANSITIONS);
  if (!validCommands.includes(command)) throw new MzError("MZ-VAL-422", `Unknown command ${command}.`);
  const clientVersion = parseInt((ifMatch ?? "").replace(/\D/g, ""), 10);
  if (isNaN(clientVersion)) throw new MzError("MZ-CONC-428", "If-Match must be the exception version.");

  validateBody(command, body);

  return db.$transaction(async (tx) => {
    const e = await tx.exception.findUnique({ where: { exceptionKey } });
    if (!e) throw new MzError("MZ-AUTH-403", "Not found"); // never confirm existence cross-tenant
    if (clientVersion !== e.version) {
      throw new MzError("MZ-CONC-409", `Another analyst recorded a change at ${e.updatedAt.toISOString()}. Reload to see the latest version.`, { currentVersion: e.version });
    }
    if (!TRANSITIONS[command]!.includes(e.status)) {
      throw new MzError("MZ-VAL-422", `${command} is not allowed from status ${e.status}.`);
    }

    const txn = await tx.txn.findUnique({ where: { rowId: e.rowId } });
    if (txn && actor.employeeId) {
      const approvals: { approverId: string | null }[] = txn.approvalsJson ? JSON.parse(txn.approvalsJson) : [];
      const parties = new Set<string>([txn.requesterId ?? "", txn.employeeId, ...approvals.map((a) => a.approverId ?? "")].filter(Boolean));
      if (parties.has(actor.employeeId)) {
        await appendAudit({ actor: actor.id, type: "decision.refused_coi", entity: "exception", entityId: exceptionKey, payload: { command } }, tx);
        throw new MzError("MZ-AUTH-403-COI", "You are the requester, an approver or the beneficiary of this transaction. Reassign the decision.", { suggestedOwnerTeam: e.ownerTeam });
      }
    }

    if (command === "assign" && body.ownerUserId) {
      const owner = await tx.actor.findUnique({ where: { id: body.ownerUserId } });
      if (!owner || !owner.active) throw new MzError("MZ-VAL-422", "The assigned owner is not an active user.");
    }
    if (command === "dismiss" && ["HIGH", "CRITICAL"].includes(e.severity)) {
      const pending = await tx.decision.findFirst({ where: { exceptionKey, command: "dismiss", countersignedBy: null } });
      if (pending) throw new MzError("MZ-CONC-409", "A dismissal is already waiting for a second analyst's countersign.", { currentVersion: e.version });
    }

    let nextStatus: string;
    switch (command) {
      case "triage": nextStatus = "TRIAGED"; break;
      case "assign": nextStatus = "ASSIGNED"; break;
      case "start": nextStatus = "IN_PROGRESS"; break;
      case "record_fix": nextStatus = "PENDING_VERIFICATION"; break;
      case "verify": nextStatus = "CLOSED"; break;
      case "fail_verification": nextStatus = "IN_PROGRESS"; break;
      case "dismiss": nextStatus = ["HIGH", "CRITICAL"].includes(e.severity) ? "TRIAGED" : "DISMISSED"; break;
      case "accept_risk": nextStatus = "ACCEPTED_RISK"; break;
      case "mark_duplicate": nextStatus = "DUPLICATE"; break;
      case "reopen": nextStatus = "REOPENED"; break;
      default: nextStatus = e.status;
    }

    const decisionId = randomUUID();
    const audit = await appendAudit({
      actor: actor.id,
      type: `decision.${command}`,
      entity: "exception",
      entityId: exceptionKey,
      payload: { command, from: e.status, to: nextStatus, reasonCategory: body.reasonCategory ?? null, reasonText: body.reasonText ? "[redacted]" : null, sourceRef: body.sourceRef ?? null, expiry: body.expiry ?? null, ownerUserId: body.ownerUserId ?? null },
    }, tx);

    await tx.decision.create({
      data: {
        id: decisionId, exceptionKey, command, actorId: actor.id,
        reasonCategory: body.reasonCategory ?? null, reasonText: body.reasonText ?? null,
        sourceRef: body.sourceRef ?? null, expiry: body.expiry ?? null, canonicalKey: body.canonicalKey ?? null,
        countersignedBy: command === "dismiss" && nextStatus === "DISMISSED" ? "not-required" : null,
        idempotencyKey: opts.idempotencyKey ?? decisionId, auditHash: audit.hash,
      },
    });

    await tx.exception.update({
      where: { exceptionKey },
      data: {
        status: nextStatus,
        version: e.version + 1,
        updatedAt: new Date(),
        ...(command === "assign" && body.ownerUserId ? { ownerUserId: body.ownerUserId } : {}),
      },
    });

    await tx.outbox.create({
      data: { id: randomUUID(), type: "notification.inapp", payloadJson: JSON.stringify({ exceptionKey, event: `decision.${command}`, actor: actor.id, to: nextStatus }) },
    });

    return { ok: true, status: nextStatus, version: e.version + 1, decisionId, auditHash: audit.hash, pendingCountersign: nextStatus === "TRIAGED" && command === "dismiss" };
  }, { timeout: 15_000 });
}

function validateBody(command: string, body: DecisionBody): void {
  if (command === "dismiss") {
    if (!body.reasonCategory || !body.reasonText || body.reasonText.trim().length < 15) {
      throw new MzError("MZ-VAL-422", "A dismissal needs a reason category and a reason of at least 15 characters.");
    }
  }
  if (command === "accept_risk") {
    if (!body.expiry || !/^\d{4}-\d{2}-\d{2}$/.test(body.expiry)) {
      throw new MzError("MZ-VAL-422", "Accepting a risk needs an expiry date (YYYY-MM-DD) and a reason.");
    }
    if (body.expiry <= new Date().toISOString().slice(0, 10)) {
      throw new MzError("MZ-VAL-422", "An accepted-risk expiry must be in the future.");
    }
    if (!body.reasonText || body.reasonText.trim().length < 15) {
      throw new MzError("MZ-VAL-422", "Accepting a risk needs a reason of at least 15 characters.");
    }
  }
  if (command === "record_fix" && !body.sourceRef) throw new MzError("MZ-VAL-422", "Recording a fix needs the source-system reference.");
  if (command === "assign" && (!body.reasonText || body.reasonText.trim().length < 5)) {
    throw new MzError("MZ-VAL-422", "Assigning needs a reason.");
  }
  if (command === "mark_duplicate" && !body.canonicalKey) {
    throw new MzError("MZ-VAL-422", "Marking a duplicate needs the canonical exception key.");
  }
}
