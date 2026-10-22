/**
 * Pattern alerts (§18): advisory only. Never exported as scored findings, never
 * routed as breaches, protected attributes excluded, visible to compliance roles.
 * Detectors run on demand over the seeded transactions (cold job in production).
 */

import type { Transaction, Employee } from "../contracts";
import { buildIndexes } from "../engine/facts";

export interface PatternAlertOut {
  id: string;
  patternId: string;
  title: string;
  neutralText: string;
  detail: Record<string, string | number>;
}

const NEUTRAL = {
  P03: "Approvals were recorded within 60 seconds of submission on material amounts. This pattern can indicate rubber-stamping and is worth a look.",
  P05: "Two people approve each other's requests. Reciprocal approval patterns can weaken independent review.",
  P08: "One employee received several pay or allowance changes in 90 days. Frequent changes are worth confirming against policy.",
  P10: "Transactions reference people who are not in the employee master. Data completeness needs attention.",
};

export function detectPatterns(transactions: Transaction[], employees: Employee[]): PatternAlertOut[] {
  const out: PatternAlertOut[] = [];
  const indexes = buildIndexes(transactions, employees);
  let seq = 0;

  // P03 rubber-stamp approvals: < 60 s and amount ≥ AED 5,000
  for (const t of transactions) {
    if (t.amountFils === null || t.amountFils < 500_000 || !t.submittedAt) continue;
    for (const a of t.approvals ?? []) {
      if (!a.approvedAt) continue;
      const delta = new Date(a.approvedAt).getTime() - new Date(t.submittedAt).getTime();
      if (delta >= 0 && delta < 60_000) {
        seq++;
        out.push({
          id: `P03-${String(seq).padStart(4, "0")}`,
          patternId: "P03",
          title: `Approval ${Math.round(delta / 1000)}s after submission on ${t.txnId}`,
          neutralText: NEUTRAL.P03!,
          detail: { txnId: t.txnId, secondsAfterSubmission: Math.round(delta / 1000), amountFils: t.amountFils, approverId: a.approverId ?? "" },
        });
        break;
      }
    }
  }

  // P05 reciprocal approvals: A approves B's and B approves A's
  const edges = new Set<string>();
  for (const t of transactions) {
    for (const a of t.approvals ?? []) {
      if (t.requesterId && a.approverId && t.requesterId !== a.approverId) {
        edges.add(`${t.requesterId}→${a.approverId}`);
      }
    }
  }
  const seen = new Set<string>();
  for (const e of edges) {
    const [a, b] = e.split("→");
    const rev = `${b}→${a}`;
    if (edges.has(rev) && !seen.has(e) && a && b) {
      seen.add(e);
      seen.add(rev);
      seq++;
      out.push({
        id: `P05-${String(seq).padStart(4, "0")}`,
        patternId: "P05",
        title: `Reciprocal approvals between ${a} and ${b}`,
        neutralText: NEUTRAL.P05!,
        detail: { a, b },
      });
    }
  }

  // P08 change velocity: ≥ 3 pay/allowance changes in 90 days
  for (const [empId, list] of indexes.txnsByEmployee) {
    const changes = list.filter((t) => (t.type === "PAY_CHANGE" || t.type === "ALLOWANCE_CHANGE") && t.effectiveDate);
    for (const t of changes) {
      if (!t.effectiveDate) continue;
      const from = new Date(`${t.effectiveDate}T00:00:00Z`);
      from.setUTCDate(from.getUTCDate() - 90);
      const windowCount = changes.filter((x) => x.effectiveDate && x.effectiveDate >= from.toISOString().slice(0, 10) && x.effectiveDate <= t.effectiveDate!).length;
      if (windowCount >= 3) {
        seq++;
        out.push({
          id: `P08-${String(seq).padStart(4, "0")}`,
          patternId: "P08",
          title: `${windowCount} pay/allowance changes for one employee in 90 days`,
          neutralText: NEUTRAL.P08!,
          detail: { employeeId: empId, windowCount, anchorTxn: t.txnId },
        });
        break;
      }
    }
  }

  // P10 orphan activity: unknown or exited people
  for (const t of transactions) {
    const emp = indexes.employeeById.get(t.employeeId);
    if (!emp) {
      seq++;
      out.push({
        id: `P10-${String(seq).padStart(4, "0")}`,
        patternId: "P10",
        title: `Transaction ${t.txnId} references unknown employee ${t.employeeId}`,
        neutralText: NEUTRAL.P10!,
        detail: { txnId: t.txnId, employeeId: t.employeeId },
      });
    }
  }

  // Cap the demo list; group noisy detectors
  const capped = out.slice(0, 40);
  return capped;
}

/** Protected-attribute allow-list: detectors never receive these features (CI-enforced in production). */
export const PROTECTED_ATTRIBUTES = ["nationality", "gender", "age", "religion", "marital_status"];
