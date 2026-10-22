import { withApiRoute, json, requireMode } from "@/lib/server/api";
import { db } from "@/lib/db";
import { randomUUID } from "node:crypto";
import { withIdempotency } from "@/lib/server/idempotency";
import { roleCan } from "@/lib/server/session";
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
}

/**
 * POST /api/v1/exceptions/{key}/decisions
 * Requires If-Match (version), Idempotency-Key; runs role, mode and conflict-of-interest
 * checks; writes the state change, an audit event and an outbox row.
 */
export const POST = withApiRoute<{ key: string }>(async ({ req, actor, params }) => {
  const exceptionKey = params.key;
  const ifMatch = req.headers.get("if-match");
  const idempotencyKey = req.headers.get("idempotency-key");
  const body = (await req.json()) as DecisionBody;

  if (!ifMatch) throw new MzError("MZ-CONC-428", "If-Match header is required for state changes.");

  const result = await withIdempotency(idempotencyKey, "decisions", { exceptionKey, ...body }, async () => {
    return recordDecision({ exceptionKey, actor, body, ifMatch, idempotencyKey });
  });
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

  // Mode guard
  await requireMode("decision");

  // Role check (API-enforced, not UI-enforced)
  if (!roleCan(actor.role as never, command)) {
    throw new MzError("MZ-AUTH-403", `Role ${actor.role} cannot run ${command}.`);
  }

  const e = await db.exception.findUnique({ where: { exceptionKey } });
  if (!e) throw new MzError("MZ-AUTH-403", "Not found"); // never confirm existence cross-tenant

  // Concurrency: If-Match must match the current version
  const clientVersion = parseInt((ifMatch ?? "").replace(/\D/g, ""), 10);
  if (isNaN(clientVersion)) throw new MzError("MZ-CONC-428", "If-Match must be the exception version.");
  if (clientVersion !== e.version) {
    throw new MzError("MZ-CONC-409", `Another analyst recorded a change at ${e.updatedAt.toISOString()}. Reload to see the latest version.`, { currentVersion: e.version });
  }

  // Conflict-of-interest guard (FS-16): requester, approvers and beneficiary cannot decide
  const txn = await db.txn.findUnique({ where: { rowId: e.rowId } });
  if (txn && actor.employeeId) {
    const approvals: { approverId: string | null }[] = txn.approvalsJson ? JSON.parse(txn.approvalsJson) : [];
    const parties = new Set<string>([txn.requesterId ?? "", txn.employeeId, ...approvals.map((a) => a.approverId ?? "")].filter(Boolean));
    if (parties.has(actor.employeeId)) {
      await appendAudit({ actor: actor.id, type: "decision.refused_coi", entity: "exception", entityId: exceptionKey, payload: { command } });
      throw new MzError("MZ-AUTH-403-COI", "You are the requester, an approver or the beneficiary of this transaction. Reassign the decision.", { suggestedOwnerTeam: e.ownerTeam });
    }
  }

  // Command-specific validation
  const validCommands = ["triage", "assign", "start", "record_fix", "verify", "fail_verification", "dismiss", "accept_risk", "mark_duplicate", "reopen", "dispute"];
  if (!validCommands.includes(command)) throw new MzError("MZ-VAL-422", `Unknown command ${command}.`);

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
    reopen: ["CLOSED", "DISMISSED"],
    dispute: ["NEW", "TRIAGED", "ASSIGNED", "IN_PROGRESS", "PENDING_VERIFICATION", "REOPENED"],
  };
  if (!TRANSITIONS[command]!.includes(e.status)) {
    throw new MzError("MZ-VAL-422", `${command} is not allowed from status ${e.status}.`);
  }

  if (command === "dismiss") {
    if (!body.reasonCategory || !body.reasonText || body.reasonText.trim().length < 15) {
      throw new MzError("MZ-VAL-422", "A dismissal needs a reason category and a reason of at least 15 characters.");
    }
  }
  if (command === "accept_risk") {
    if (!body.expiry || !/^\d{4}-\d{2}-\d{2}$/.test(body.expiry)) {
      throw new MzError("MZ-VAL-422", "Accepting a risk needs an expiry date (YYYY-MM-DD) and a reason.");
    }
    if (!body.reasonText || body.reasonText.trim().length < 5) {
      throw new MzError("MZ-VAL-422", "Accepting a risk needs a reason.");
    }
  }
  if (command === "record_fix" && !body.sourceRef) {
    throw new MzError("MZ-VAL-422", "Recording a fix needs the source-system reference.");
  }
  if (command === "assign" && (!body.reasonText || body.reasonText.trim().length < 5)) {
    throw new MzError("MZ-VAL-422", "Assigning needs a reason.");
  }
  if (command === "mark_duplicate" && !body.canonicalKey) {
    throw new MzError("MZ-VAL-422", "Marking a duplicate needs the canonical exception key.");
  }

  // Compute the next status
  let nextStatus: string;
  switch (command) {
    case "triage": nextStatus = "TRIAGED"; break;
    case "assign": nextStatus = "ASSIGNED"; break;
    case "start": nextStatus = "IN_PROGRESS"; break;
    case "record_fix": nextStatus = "PENDING_VERIFICATION"; break;
    case "verify": nextStatus = "CLOSED"; break;
    case "fail_verification": nextStatus = "IN_PROGRESS"; break;
    case "dismiss": nextStatus = ["HIGH", "CRITICAL"].includes(e.severity) ? "TRIAGED" : "DISMISSED"; break; // pending countersign for High/Critical
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
    payload: { command, from: e.status, to: nextStatus, reasonCategory: body.reasonCategory ?? null, reasonText: body.reasonText ? "[redacted]" : null, sourceRef: body.sourceRef ?? null, expiry: body.expiry ?? null },
  });

  await db.decision.create({
    data: {
      id: decisionId, exceptionKey, command, actorId: actor.id,
      reasonCategory: body.reasonCategory ?? null, reasonText: body.reasonText ?? null,
      sourceRef: body.sourceRef ?? null, expiry: body.expiry ?? null, canonicalKey: body.canonicalKey ?? null,
      countersignedBy: command === "dismiss" && nextStatus === "DISMISSED" ? "not-required" : null,
      idempotencyKey: opts.idempotencyKey ?? decisionId, auditHash: audit.hash,
    },
  });

  await db.exception.update({
    where: { exceptionKey },
    data: { status: nextStatus, version: e.version + 1, updatedAt: new Date() },
  });

  await db.outbox.create({
    data: { id: randomUUID(), type: "notification.inapp", payloadJson: JSON.stringify({ exceptionKey, event: `decision.${command}`, actor: actor.id, to: nextStatus }) },
  });

  return { ok: true, status: nextStatus, version: e.version + 1, decisionId, pendingCountersign: nextStatus === "TRIAGED" && command === "dismiss" };
}
