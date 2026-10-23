import { withApiRoute, json } from "@/lib/server/api";
import { db } from "@/lib/db";
import { MzError } from "@/lib/domain/errors";
import { evaluate } from "@/lib/engine/evaluate";
import { loadActivePack, loadEmployees } from "@/lib/server/run-pipeline";
import { UAE_CALENDAR } from "@/lib/domain/calendar";
import { parseAmount } from "@/lib/domain/money";
import { canonicalTxnType, canonicalId } from "@/lib/normalize";
import { sha256 } from "@/lib/domain/canonical";
import { appendAudit } from "@/lib/audit/chain";
import type { Approval, Transaction, TxnDoc } from "@/lib/contracts";

export const dynamic = "force-dynamic";

interface CheckBody {
  transaction: {
    txnId: string; type: string; employeeId: string;
    amount?: string | number | null; currency?: string | null;
    effectiveDate?: string | null; submittedAt?: string | null; requesterId?: string | null;
    grade?: string | null; department?: string | null; location?: string | null;
    approvals?: { approverId: string; approvedAt?: string | null; grade?: string | null; role?: string | null }[];
    documents?: string[];
  };
  asOf?: string;
}

/**
 * POST /api/v1/check — read-only pre-flight for one transaction. Pure: no
 * exception, notification or run is written; only a metadata audit event.
 */
export const POST = withApiRoute(async ({ req, actor }) => {
  const body = (await req.json()) as CheckBody;
  if (!body?.transaction?.txnId || !body.transaction.type || !body.transaction.employeeId) {
    throw new MzError("MZ-VAL-422", "transaction.txnId, transaction.type and transaction.employeeId are required.");
  }
  const raw = body.transaction;
  const type = canonicalTxnType(raw.type);
  const amount = typeof raw.amount === "number" ? raw.amount : raw.amount ? parseAmount(String(raw.amount)).fils : null;
  const approvals: Approval[] = (raw.approvals ?? []).map((a, i) => ({
    approverId: canonicalId(a.approverId), position: i, approvedAt: a.approvedAt ?? null,
    precision: a.approvedAt ? "timestamp" : "none", role: a.role ?? null, gradeRaw: a.grade ?? null, delegateFor: null,
  }));
  const documents: TxnDoc[] = (raw.documents ?? []).map((d) => ({ raw: d, canonical: d.trim().toUpperCase().replace(/[\s\-.]+/g, "_") }));
  const txn: Transaction = {
    rowId: `check-${raw.txnId}`, txnId: raw.txnId, type: type.code, typeRaw: raw.type, employeeId: canonicalId(raw.employeeId),
    gradeRaw: raw.grade ?? null, department: raw.department ?? null, location: raw.location ?? null,
    amountFils: amount, currency: raw.currency ?? "AED", amountSemantics: "delta",
    effectiveDate: raw.effectiveDate ?? null, submittedAt: raw.submittedAt ?? null,
    submittedPrecision: raw.submittedAt ? "timestamp" : null, requesterId: raw.requesterId ? canonicalId(raw.requesterId) : null,
    approvals, documents, reversalOf: null, freeText: {}, passthrough: {},
    source: { datasetId: "check", rowNumber: 0, rowHash: sha256(JSON.stringify(raw)) },
    dq: type.dq ? [type.dq] : [], caveats: [],
  };
  const [employees, pack] = await Promise.all([loadEmployees(), loadActivePack()]);
  const result = evaluate({
    transactions: [txn], employees, pack,
    config: { calendarVersion: UAE_CALENDAR.version, routingTableVersion: "routing-1.2.0" },
    asOf: body.asOf && /^\d{4}-\d{2}-\d{2}$/.test(body.asOf) ? body.asOf : new Date().toISOString().slice(0, 10),
    runId: `check-${actor.id}`,
  });
  await appendAudit({ actor: actor.id, type: "check.performed", entity: "transaction", entityId: txn.txnId, payload: { txnId: txn.txnId, checks: result.counts.checks, failed: result.counts.failed } });
  return json({
    transactionId: txn.txnId,
    dataQuality: txn.dq,
    counts: result.counts,
    outputHash: result.outputHash,
    checks: result.results.map((r) => ({ ruleId: r.ruleId, clauseId: r.clauseId, ruleVersion: r.ruleVersion, outcome: r.outcome, evidence: r.evidence, evidenceHash: r.evidenceHash })),
  });
});
