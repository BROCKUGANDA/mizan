import { withApiRoute, json } from "@/lib/server/api";
import { db } from "@/lib/db";
import { MzError } from "@/lib/domain/errors";
import { loadActivePack, loadEmployees, loadTransactions } from "@/lib/server/run-pipeline";
import { evaluate } from "@/lib/engine/evaluate";
import { UAE_CALENDAR } from "@/lib/domain/calendar";
import { validateRuleSpec, ruleLogicHash } from "@/lib/pack/rules";
import { sha256Json } from "@/lib/domain/canonical";
import type { RuleSpec } from "@/lib/contracts";

export const dynamic = "force-dynamic";

interface BacktestBody { spec: RuleSpec; asOf?: string }

/**
 * POST /api/v1/rules/drafts/{id}/backtest — 12-month replay on the frozen
 * dataset. Binds the result to the tested spec hash, so a later edit cannot
 * activate on the strength of an older backtest (FS-19, EC-I06).
 */
export const POST = withApiRoute<{ id: string }>(async ({ req, params }) => {
  const body = (await req.json()) as BacktestBody;
  if (!body.spec) throw new MzError("MZ-VAL-422", "A spec is required for the backtest.");
  const draft = await db.ruleDraft.findUnique({ where: { id: params.id } });
  if (!draft) throw new MzError("MZ-AUTH-403", "Draft not found");
  if (!["draft", "backtested"].includes(draft.status)) {
    throw new MzError("MZ-VAL-422", `A draft in status ${draft.status} cannot be re-backtested; create a new version.`);
  }
  const storedSpec = draft.specJson ? JSON.parse(draft.specJson) as RuleSpec : null;
  if (!storedSpec) throw new MzError("MZ-VAL-422", "The draft has no spec yet.");

  // Bind the test to the draft's allocated id and verbatim source; the client
  // may send a grammar-shaped spec with a placeholder id.
  const spec: RuleSpec = {
    ...body.spec,
    id: storedSpec.id,
    version: "0.1.0-draft",
    status: "draft",
    source: { ...body.spec.source, ...storedSpec.source, anchor: storedSpec.id },
    effective: body.spec.effective ?? storedSpec.effective,
    clauses: body.spec.clauses?.length ? body.spec.clauses : storedSpec.clauses,
  };
  spec.source.sha256 = sha256Json({ anchor: spec.source.anchor, text: spec.source.text });
  const errors = validateRuleSpec(spec);
  if (errors.length) throw new MzError("MZ-RULE-422", `RuleSpec invalid: ${errors.join("; ")}`);

  const [transactions, employees, activePack] = await Promise.all([loadTransactions(), loadEmployees(), loadActivePack()]);
  if (activePack.some((r) => r.id === spec.id)) throw new MzError("MZ-RULE-422", `Rule id ${spec.id} already exists.`);
  const latest = transactions.reduce((acc, t) => (t.effectiveDate && t.effectiveDate > acc ? t.effectiveDate : acc), "2025-01-01");
  const asOf = body.asOf && /^\d{4}-\d{2}-\d{2}$/.test(body.asOf) ? body.asOf : addDays(latest, 1);
  const result = evaluate({
    transactions, employees, pack: [...activePack, spec],
    config: { calendarVersion: UAE_CALENDAR.version, routingTableVersion: "routing-1.2.0" },
    asOf, runId: `backtest-${params.id}`,
  });

  const per = result.perRule[spec.id]!;
  const applicable = per.total - per.notApplicable;
  const draftResults = result.results.filter((r) => r.ruleId === spec.id && r.outcome === "FAIL");
  const flaggedTxns = new Set(draftResults.map((r) => r.txnId));

  const overlap: { ruleId: string; count: number; jaccard: number }[] = [];
  for (const [ruleId, c] of Object.entries(result.perRule)) {
    void c;
    if (ruleId === spec.id) continue;
    const ruleTxns = new Set(result.results.filter((r) => r.ruleId === ruleId && r.outcome === "FAIL").map((r) => r.txnId));
    let inter = 0;
    for (const t of flaggedTxns) if (ruleTxns.has(t)) inter++;
    const union = new Set([...flaggedTxns, ...ruleTxns]).size;
    if (inter > 0) overlap.push({ ruleId, count: inter, jaccard: union ? Math.round((inter / union) * 100) / 100 : 0 });
  }
  overlap.sort((a, b) => b.count - a.count);

  const sample = draftResults.slice(0, 10).map((r) => {
    const t = transactions.find((x) => x.rowId === r.rowId);
    return {
      txnId: r.txnId, employeeId: t?.employeeId ?? "", type: t?.type ?? "",
      amountFils: t?.amountFils ?? null, effectiveDate: t?.effectiveDate ?? "",
      headline: r.evidence?.requirement.en ?? "",
    };
  });
  const monthly: Record<string, number> = {};
  for (const r of draftResults) {
    const t = transactions.find((x) => x.rowId === r.rowId);
    if (t?.effectiveDate) monthly[t.effectiveDate.slice(0, 7)] = (monthly[t.effectiveDate.slice(0, 7)] ?? 0) + 1;
  }
  const failRate = applicable ? draftResults.length / applicable : 0;
  const backtest = {
    draftId: params.id,
    specHash: sha256Json(spec),
    logicHash: ruleLogicHash(spec),
    asOf,
    transactionCount: transactions.length,
    applicableChecks: applicable,
    wouldFlag: flaggedTxns.size,
    findings: draftResults.length,
    rate: transactions.length ? Math.round((flaggedTxns.size / transactions.length) * 1000) / 10 : 0,
    failRate: Math.round(failRate * 10_000) / 100,
    floodRisk: failRate > 0.1 ? "high" : failRate > 0.05 ? "medium" : "low",
    reviewerLoadPerWeek: Math.round((flaggedTxns.size / 52) * 10) / 10,
    overlap,
    sample,
    monthly,
    runAt: new Date().toISOString(),
  };
  await db.ruleDraft.update({
    where: { id: params.id },
    data: { specJson: JSON.stringify(spec), backtestJson: JSON.stringify(backtest), status: "backtested" },
  });
  return json(backtest);
});

function addDays(s: string, n: number): string {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
