import { withApiRoute, json } from "@/lib/server/api";
import { db } from "@/lib/db";
import { MzError } from "@/lib/domain/errors";
import { loadTransactions } from "@/lib/server/run-pipeline";
import { evaluate } from "@/lib/engine/evaluate";
import { UAE_CALENDAR } from "@/lib/domain/calendar";
import { RULE_SPECS } from "@/lib/pack/rules";
import type { RuleSpec, Transaction, Employee } from "@/lib/contracts";

export const dynamic = "force-dynamic";

interface BacktestBody { spec: RuleSpec }

/** POST /api/v1/rules/drafts/{id}/backtest — 12-month replay: would-flag count, sample, overlap. */
export const POST = withApiRoute<{ id: string }>(async ({ req, params }) => {
  const body = (await req.json()) as BacktestBody;
  const spec = body.spec;
  if (!spec || !spec.check) throw new MzError("MZ-VAL-422", "A spec is required for the backtest.");
  if (spec.id !== "RNEW") {
    const existing = await db.rule.findUnique({ where: { id: spec.id } });
    if (existing && existing.textSha256 !== spec.source?.sha256) {
      // EC-I06: spec edited after its backtest → activation blocked until re-backtest
      // (backtesting a new hash is exactly what this endpoint does)
      void existing;
    }
  }

  const draft = await db.ruleDraft.findUnique({ where: { id: params.id } });
  if (!draft) throw new MzError("MZ-AUTH-403", "Draft not found");

  const transactions = await loadTransactions();
  const employees: Employee[] = (await import("@/lib/server/run-pipeline")).loadEmployees !== undefined ? await (await import("@/lib/server/run-pipeline")).loadEmployees() : [];
  const withDraft: RuleSpec[] = [
    ...RULE_SPECS.filter((r) => r.status === "active"),
    { ...spec, id: "RNEW", status: "draft" } as RuleSpec,
  ];
  const result = evaluate({
    transactions, employees, pack: withDraft,
    config: { calendarVersion: UAE_CALENDAR.version, routingTableVersion: "routing-1.2.0" },
    asOf: "2026-04-01", runId: `backtest-${params.id}`,
  });

  const draftResults = result.results.filter((r) => r.ruleId === "RNEW" && r.outcome === "FAIL");
  const flaggedTxns = new Set(draftResults.map((r) => r.txnId));

  // overlap with existing rules
  const overlap: { ruleId: string; count: number; jaccard: number }[] = [];
  for (const [ruleId, c] of Object.entries(result.perRule)) {
    if (ruleId === "RNEW") continue;
    const ruleTxns = new Set(result.results.filter((r) => r.ruleId === ruleId && r.outcome === "FAIL").map((r) => r.txnId));
    let inter = 0;
    for (const t of flaggedTxns) if (ruleTxns.has(t)) inter++;
    const union = new Set([...flaggedTxns, ...ruleTxns]).size;
    if (inter > 0) overlap.push({ ruleId, count: inter, jaccard: union ? Math.round((inter / union) * 100) / 100 : 0 });
  }
  overlap.sort((a, b) => b.count - a.count);

  const sample = draftResults.slice(0, 10).map((r) => {
    const t: Transaction | undefined = transactions.find((x) => x.txnId === r.txnId);
    return {
      txnId: r.txnId, employeeId: t?.employeeId ?? "", type: t?.type ?? "",
      amountFils: t?.amountFils ?? null, effectiveDate: t?.effectiveDate ?? "",
      headline: r.evidence?.requirement.en ?? "",
    };
  });

  const monthly: Record<string, number> = {};
  for (const r of draftResults) {
    const t = transactions.find((x) => x.txnId === r.txnId);
    if (t?.effectiveDate) monthly[t.effectiveDate.slice(0, 7)] = (monthly[t.effectiveDate.slice(0, 7)] ?? 0) + 1;
  }

  const backtest = {
    draftId: params.id,
    specHash: (await import("@/lib/domain/canonical")).sha256Json(spec),
    wouldFlag: draftResults.length,
    transactionCount: transactions.length,
    rate: transactions.length ? Math.round((draftResults.length / transactions.length) * 1000) / 10 : 0,
    floodRisk: draftResults.length > transactions.length * 0.1 ? "high" : draftResults.length > transactions.length * 0.05 ? "medium" : "low",
    overlap,
    sample,
    monthly,
    runAt: new Date().toISOString(),
  };
  await db.ruleDraft.update({ where: { id: params.id }, data: { backtestJson: JSON.stringify(backtest), status: draft.status === "draft" ? "backtested" : draft.status } });
  return json(backtest);
});


