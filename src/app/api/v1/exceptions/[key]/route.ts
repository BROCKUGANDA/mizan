import { withApiRoute, json } from "@/lib/server/api";
import { db } from "@/lib/db";
import { MzError } from "@/lib/domain/errors";

export const dynamic = "force-dynamic";

/** GET /api/v1/exceptions/{key} — detail: evidence, explanation, routing, rule, decisions, events. */
export const GET = withApiRoute(async ({ req, params }) => {
  void req;
  const { key } = params as { key: string };
  const e = await db.exception.findUnique({ where: { exceptionKey: key } });
  if (!e) throw new MzError("MZ-AUTH-403", "Not found"); // 404-equivalent: existence is never confirmed cross-tenant (EC-N01)

  const [decisions, observations, comments, rule, siblings] = await Promise.all([
    db.decision.findMany({ where: { exceptionKey: key }, orderBy: { createdAt: "asc" } }),
    db.observation.findMany({ where: { exceptionKey: key }, orderBy: { observedAt: "asc" } }),
    db.comment.findMany({ where: { exceptionKey: key }, orderBy: { createdAt: "asc" } }),
    db.rule.findUnique({ where: { id: e.ruleId } }),
    db.exception.findMany({ where: { groupKey: e.groupKey, exceptionKey: { not: key } }, take: 6 }),
  ]);
  const events = await db.auditEvent.findMany({ where: { entityId: key }, orderBy: { seq: "asc" }, take: 100 });

  const pendingCountersign = decisions.some((d) => d.command === "dismiss" && !d.countersignedBy && ["HIGH", "CRITICAL"].includes(e.severity));

  return json({
    exception: {
      exceptionKey: e.exceptionKey,
      displayId: e.displayId,
      tenantId: e.tenantId,
      rowId: e.rowId,
      txnId: e.txnId,
      ruleId: e.ruleId,
      clauseId: e.clauseId,
      ruleVersion: e.ruleVersion,
      family: e.family,
      severity: e.severity,
      severityRationale: e.severityRationale,
      ownerTeam: e.ownerTeam,
      watchers: JSON.parse(e.watchersJson ?? "[]"),
      routingRationale: e.routingRationale,
      routingTableVersion: e.routingTableVersion,
      action: { id: e.actionId, en: e.actionEn, ar: e.actionAr },
      headline: { en: e.headlineEn, ar: e.headlineAr },
      explanation: { en: e.explanationEn, ar: e.explanationAr },
      status: e.status,
      version: e.version,
      groupKey: e.groupKey,
      ackDueAt: e.ackDueAt,
      resolveDueAt: e.resolveDueAt,
      heldReason: e.heldReason,
      noLongerDetected: e.noLongerDetected,
      firstRunId: e.firstRunId,
      lastRunId: e.lastRunId,
      evidence: JSON.parse(e.evidenceJson),
      evidenceHash: e.evidenceHash,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      pendingCountersign,
    },
    interpretation: rule?.interpretationJson ? JSON.parse(rule.interpretationJson) : null,
    ruleSpec: rule ? JSON.parse(rule.specJson) : null,
    decisions,
    observations,
    comments,
    siblings: siblings.map((s) => ({ exceptionKey: s.exceptionKey, displayId: s.displayId, ruleId: s.ruleId, severity: s.severity, status: s.status, headlineEn: s.headlineEn })),
    events: events.map((ev) => ({ seq: ev.seq, at: ev.at, actor: ev.actor, type: ev.type, payload: JSON.parse(ev.payloadJson) })),
  });
});
