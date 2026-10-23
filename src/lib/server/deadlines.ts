/**
 * deadline.tick (warm job, every 5 minutes): accepted-risk expiry and the
 * 75/100/150% SLA escalation ladder. Nothing closes automatically; expired risk
 * returns to TRIAGED. The tick is idempotent through SlaEscalation's unique key.
 */

import { db } from "@/lib/db";
import { randomUUID } from "node:crypto";
import { appendAudit } from "@/lib/audit/chain";
import { diffDays, instantToDubaiDate, type LocalDate } from "../domain/dates";
import { ESCALATION_LADDER } from "../domain/calendar";

export function todayGst(): LocalDate {
  return new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export interface TickResult {
  asOf: LocalDate;
  expiredRisks: number;
  escalations: number;
}

export async function runDeadlineTick(asOf: LocalDate = todayGst()): Promise<TickResult> {
  let expiredRisks = 0;
  const expiring = await db.exception.findMany({ where: { status: "ACCEPTED_RISK" } });
  for (const e of expiring) {
    const decision = await db.decision.findFirst({ where: { exceptionKey: e.exceptionKey, command: "accept_risk" }, orderBy: { createdAt: "desc" } });
    if (!decision?.expiry || decision.expiry > asOf) continue;
    await db.exception.update({ where: { exceptionKey: e.exceptionKey }, data: { status: "TRIAGED", version: e.version + 1, updatedAt: new Date() } });
    const audit = await appendAudit({
      actor: "system:deadline", type: "risk.expired", entity: "exception", entityId: e.exceptionKey,
      payload: { expiry: decision.expiry, from: "ACCEPTED_RISK", to: "TRIAGED" },
    });
    await db.outbox.create({
      data: { id: randomUUID(), type: "notification.inapp", payloadJson: JSON.stringify({ exceptionKey: e.exceptionKey, event: "risk.expired", severity: e.severity, headline: e.headlineEn, team: e.ownerTeam, auditHash: audit.hash }) },
    });
    expiredRisks++;
  }

  let escalations = 0;
  const open = await db.exception.findMany({ where: { status: { in: ["NEW", "TRIAGED", "ASSIGNED", "IN_PROGRESS", "PENDING_VERIFICATION", "REOPENED"] } } });
  for (const e of open) {
    if (!e.resolveDueAt) continue;
    const start = instantToDubaiDate(e.createdAt.toISOString());
    const total = Math.max(1, diffDays(e.resolveDueAt, start));
    const elapsed = diffDays(asOf, start);
    const ratio = elapsed / total;
    const level = ratio >= ESCALATION_LADDER[2]! ? 3 : ratio >= ESCALATION_LADDER[1]! ? 2 : ratio >= ESCALATION_LADDER[0]! ? 1 : 0;
    for (let l = 1; l <= level; l++) {
      const existing = await db.slaEscalation.findUnique({ where: { exceptionKey_level: { exceptionKey: e.exceptionKey, level: l } } }).catch(() => null);
      if (existing) continue;
      await db.slaEscalation.create({ data: { id: randomUUID(), exceptionKey: e.exceptionKey, level: l } });
      await appendAudit({
        actor: "system:deadline", type: "sla.escalation", entity: "exception", entityId: e.exceptionKey,
        payload: { level: l, ratio: Math.round(ratio * 1000) / 1000, dueAt: e.resolveDueAt, ownerTeam: e.ownerTeam },
      });
      await db.outbox.create({
        data: { id: randomUUID(), type: "notification.inapp", payloadJson: JSON.stringify({ exceptionKey: e.exceptionKey, event: `sla.escalation.${l}`, severity: e.severity, headline: e.headlineEn, team: l >= 3 ? "compliance-lead" : e.ownerTeam }) },
      });
      escalations++;
    }
  }
  return { asOf, expiredRisks, escalations };
}
