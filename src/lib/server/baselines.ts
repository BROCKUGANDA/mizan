/**
 * Baseline helpers shared by the seed, reset and flag routes.
 */

import { db } from "@/lib/db";
import { evaluate } from "@/lib/engine/evaluate";
import { RULE_SPECS } from "@/lib/pack/rules";
import { UAE_CALENDAR } from "@/lib/domain/calendar";
import { loadTransactions, loadEmployees } from "./run-pipeline";

export async function recomputeBaselines(): Promise<{ fail: Record<string, number>; notEvaluable: Record<string, number> }> {
  const [transactions, employees] = await Promise.all([loadTransactions(), loadEmployees()]);
  const result = evaluate({
    transactions, employees, pack: RULE_SPECS.filter((r) => r.status === "active"),
    config: { calendarVersion: UAE_CALENDAR.version, routingTableVersion: "routing-1.2.0" },
    asOf: "2026-04-01", runId: "baseline-recompute",
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
    create: { key: "backtest.baselines", value: JSON.stringify(baselines), updatedBy: "system", reason: "recomputed" },
    update: { value: JSON.stringify(baselines), updatedBy: "system", reason: "recomputed" },
  });
  return baselines;
}
