import { withApiRoute, json } from "@/lib/server/api";
import { db } from "@/lib/db";
import { appendAudit, genesisHash } from "@/lib/audit/chain";
import { resolveActor } from "@/lib/server/session";
import { evaluate } from "@/lib/engine/evaluate";
import { RULE_SPECS } from "@/lib/pack/rules";
import { UAE_CALENDAR } from "@/lib/domain/calendar";
import { loadTransactions, loadEmployees } from "@/lib/server/run-pipeline";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/judge/reset — judge-mode Reset: restores the seeded state in < 5 s.
 * Sandbox profile only (documented in docs/DEVIATIONS.md): production has no reset.
 */
export const POST = withApiRoute(async ({ req }) => {
  const actor = await resolveActor(req.headers.get("x-mizan-actor"));
  const t0 = Date.now();

  await db.$transaction(async (tx) => {
    await tx.observation.deleteMany({});
    await tx.decision.deleteMany({});
    await tx.comment.deleteMany({});
    await tx.exception.deleteMany({});
    await tx.run.deleteMany({});
    await tx.outbox.deleteMany({});
    await tx.inbox.deleteMany({});
    await tx.idempotencyKey.deleteMany({});
    await tx.dlqItem.deleteMany({});
    await tx.patternAlert.deleteMany({});
    await tx.ruleDraft.deleteMany({});
    await tx.ruleApproval.deleteMany({});
    await tx.evidencePack.deleteMany({});
    await tx.auditEvent.deleteMany({});
    await tx.productEvent.deleteMany({});
  });

  // Reset flags to defaults and baselines recomputed from the pack
  await db.featureFlag.updateMany({ where: { key: { not: "backtest.baselines" } }, data: { updatedBy: "system:reset", reason: "judge reset" } });
  await db.systemMode.upsert({
    where: { tenantId: "default" },
    create: { tenantId: "default", mode: "M0" },
    update: { mode: "M0", reason: null, operator: null },
  });

  // Re-pin baselines deterministically
  const [transactions, employees] = await Promise.all([loadTransactions(), loadEmployees()]);
  const result = evaluate({
    transactions, employees, pack: RULE_SPECS.filter((r) => r.status === "active"),
    config: { calendarVersion: UAE_CALENDAR.version, routingTableVersion: "routing-1.2.0" },
    asOf: "2026-04-01", runId: "baseline-reset",
  });
  const failBase: Record<string, number> = {};
  const neBase: Record<string, number> = {};
  for (const [ruleId, c] of Object.entries(result.perRule)) {
    failBase[ruleId] = c.total ? c.failed / c.total : 0;
    neBase[ruleId] = c.notEvaluable;
  }
  const baselines = { fail: failBase, notEvaluable: neBase };
  await db.featureFlag.upsert({
    where: { key: "backtest.baselines" },
    create: { key: "backtest.baselines", value: JSON.stringify(baselines), updatedBy: "system:reset", reason: "judge reset" },
    update: { value: JSON.stringify(baselines), updatedBy: "system:reset", reason: "judge reset" },
  });

  // Re-anchor the audit chain with a reset event (the judge-profile reset truncates history;
  // production reset does not exist — see docs/DEVIATIONS.md)
  await appendAudit({ actor: actor.id, type: "judge.reset", entity: "system", entityId: "default", payload: { note: "Judge-mode reset to seeded state", genesis: genesisHash("default") } });

  const elapsed = Date.now() - t0;
  return json({ ok: true, elapsedMs: elapsed, outputHash: result.outputHash });
});
