/**
 * Pattern alerts P01–P10 (§18). Advisory only: never exported as findings,
 * never routed as breaches, never fed to a detector through a protected
 * attribute. Deterministic ordering; no randomness.
 */

import type { Transaction, Employee } from "../contracts";
import { buildIndexes, pointInTimeStatus } from "../engine/facts";
import { cmpStr, diffDays, instantToDubaiDate } from "../domain/dates";
import { isBusinessDay } from "../domain/calendar";

export interface PatternAlertOut {
  id: string;
  patternId: string;
  title: string;
  neutralText: string;
  detail: Record<string, string | number>;
}

const NEUTRAL: Record<string, string> = {
  P01: "Amounts sit just under an approval limit more often than for peers. This can indicate threshold avoidance and is worth a look.",
  P02: "Several transactions sat below a limit but together exceed it within two weeks. This can indicate split requests.",
  P03: "Approvals were recorded within 60 seconds of submission on material amounts. This pattern can indicate rubber-stamping and is worth a look.",
  P04: "Approvals were recorded at night, on weekends or on public holidays more often than for peers. Review the approval schedule.",
  P05: "People approve each other's requests. Reciprocal approval patterns can weaken independent review.",
  P06: "One approver handles a large share of a department's approvals outside the management chain. Review the approval coverage.",
  P07: "Amounts are far from the peer group for the same type, grade and department. Confirm the value and its documentation.",
  P08: "One employee received several pay or allowance changes in 90 days. Frequent changes are worth confirming against policy.",
  P09: "A pay or allowance increase was recorded shortly before an exit. This can affect end-of-service benefits and is worth confirming.",
  P10: "Transactions reference people who are not in the employee master or were not active at the reference time. Data completeness needs attention.",
};

const SYSTEM = new Set(["SYSTEM", "HRIS_BATCH", "BATCH", "AUTO"]);
const LIMITS: { type: string; limit: number; label: string }[] = [
  { type: "ALLOWANCE_CHANGE", limit: 1_000_000, label: "AED 10,000 allowance" },
  { type: "PAY_CHANGE", limit: 2_500_000, label: "AED 25,000 pay" },
];

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}
function mad(values: number[]): number {
  const m = median(values);
  return median(values.map((v) => Math.abs(v - m)));
}

export function detectPatterns(transactions: Transaction[], employees: Employee[]): PatternAlertOut[] {
  assertNoProtectedFeatures(DETECTOR_FEATURES);
  const out: PatternAlertOut[] = [];
  const indexes = buildIndexes(transactions, employees);
  const push = (patternId: string, title: string, detail: Record<string, string | number>): void => {
    out.push({ id: `${patternId}-${String(out.filter((o) => o.patternId === patternId).length + 1).padStart(4, "0")}`, patternId, title, neutralText: NEUTRAL[patternId]!, detail });
  };

  // P01 threshold hugging
  for (const { type, limit, label } of LIMITS) {
    const ofType = transactions.filter((t) => t.type === type && t.amountFils !== null && t.amountFils <= limit);
    if (!ofType.length) continue;
    const hugging = ofType.filter((t) => t.amountFils! >= limit * 0.95 && t.amountFils! < limit);
    const peerShare = hugging.length / ofType.length;
    const byEmployee = new Map<string, { hug: number; total: number }>();
    for (const t of ofType) {
      const e = byEmployee.get(t.employeeId) ?? { hug: 0, total: 0 };
      e.total++;
      if (t.amountFils! >= limit * 0.95 && t.amountFils! < limit) e.hug++;
      byEmployee.set(t.employeeId, e);
    }
    for (const [employeeId, e] of byEmployee) {
      const share = e.hug / e.total;
      if (e.hug >= 2 && share >= Math.max(0.5, peerShare * 3)) {
        push("P01", `${e.hug} of ${e.total} ${label} changes sit just under the limit for ${employeeId}`, { employeeId, hugging: e.hug, total: e.total, share: Math.round(share * 100), peerShare: Math.round(peerShare * 100) });
      }
    }
  }

  // P02 split transactions
  for (const { type, limit } of LIMITS) {
    const byEmployee = new Map<string, Transaction[]>();
    for (const t of transactions) {
      if (t.type !== type || t.amountFils === null || t.effectiveDate === null || t.amountFils >= limit) continue;
      const list = byEmployee.get(t.employeeId) ?? [];
      list.push(t);
      byEmployee.set(t.employeeId, list);
    }
    for (const [employeeId, list] of byEmployee) {
      const sorted = [...list].sort((a, b) => cmpStr(a.effectiveDate ?? "", b.effectiveDate ?? ""));
      for (let i = 0; i < sorted.length; i++) {
        const window = sorted.filter((x) => x.effectiveDate! >= sorted[i]!.effectiveDate! && diffDays(x.effectiveDate!, sorted[i]!.effectiveDate!) < 14);
        const sum = window.reduce((acc, x) => acc + (x.amountFils ?? 0), 0);
        if (window.length >= 2 && sum > limit) {
          push("P02", `${window.length} sub-limit ${type.toLowerCase()} changes for ${employeeId} total AED ${(sum / 100).toLocaleString("en-US")} within 14 days`, { employeeId, count: window.length, sumFils: sum, anchor: sorted[i]!.txnId });
          break;
        }
      }
    }
  }

  // P03 rubber-stamp approvals
  for (const t of transactions) {
    if (t.amountFils === null || t.amountFils < 500_000 || !t.submittedAt) continue;
    for (const a of t.approvals ?? []) {
      if (!a.approvedAt || SYSTEM.has((a.approverId ?? "").toUpperCase())) continue;
      const delta = new Date(a.approvedAt).getTime() - new Date(t.submittedAt).getTime();
      if (delta >= 0 && delta < 60_000) {
        push("P03", `Approval ${Math.round(delta / 1000)}s after submission on ${t.txnId}`, { txnId: t.txnId, secondsAfterSubmission: Math.round(delta / 1000), amountFils: t.amountFils, approverId: a.approverId ?? "" });
        break;
      }
    }
  }

  // P04 off-hours approvals
  const offHoursByApprover = new Map<string, { off: number; total: number }>();
  for (const t of transactions) {
    for (const a of t.approvals ?? []) {
      if (!a.approvedAt || SYSTEM.has((a.approverId ?? "").toUpperCase())) continue;
      const date = instantToDubaiDate(a.approvedAt);
      const hour = new Date(new Date(a.approvedAt).getTime() + 4 * 3600_000).getUTCHours();
      const off = hour < 8 || hour >= 18 || !isBusinessDay(date);
      const e = offHoursByApprover.get(a.approverId ?? "") ?? { off: 0, total: 0 };
      e.total++;
      if (off) e.off++;
      offHoursByApprover.set(a.approverId ?? "", e);
    }
  }
  const shares = [...offHoursByApprover.values()].filter((e) => e.total >= 5).map((e) => e.off / e.total);
  const mean = shares.length ? shares.reduce((a, b) => a + b, 0) / shares.length : 0;
  const spread = Math.sqrt(shares.reduce((acc, s) => acc + (s - mean) ** 2, 0) / Math.max(1, shares.length));
  for (const [approverId, e] of offHoursByApprover) {
    if (e.total < 5) continue;
    const z = spread ? (e.off / e.total - mean) / spread : 0;
    if (z >= 3.5 && e.off >= 3) push("P04", `${e.off} of ${e.total} approvals by ${approverId} were outside business hours`, { approverId, off: e.off, total: e.total, z: Math.round(z * 100) / 100 });
  }

  // P05 reciprocal approvals, cycles up to length 4
  const edges = new Map<string, Set<string>>();
  for (const t of transactions) {
    for (const a of t.approvals ?? []) {
      if (t.requesterId && a.approverId && t.requesterId !== a.approverId && !SYSTEM.has(a.approverId.toUpperCase())) {
        const set = edges.get(t.requesterId) ?? new Set<string>();
        set.add(a.approverId);
        edges.set(t.requesterId, set);
      }
    }
  }
  const cycles = new Set<string>();
  const nodes = [...edges.keys()].sort();
  for (const start of nodes) {
    const dfs = (node: string, path: string[]): void => {
      if (path.length > 4) return;
      for (const next of edges.get(node) ?? []) {
        if (next === start && path.length >= 2) {
          const canonical = [...path].sort().join("→");
          if (!cycles.has(canonical)) {
            cycles.add(canonical);
            push("P05", `Reciprocal approval cycle: ${[...path, start].join(" → ")}`, { cycle: [...path, start].join("→"), length: path.length });
          }
        } else if (!path.includes(next)) dfs(next, [...path, next]);
      }
    };
    dfs(start, [start]);
  }

  // P06 approver concentration
  const deptApprovals = new Map<string, Map<string, number>>();
  for (const t of transactions) {
    const emp = indexes.employeeById.get(t.employeeId);
    const dept = emp?.department ?? t.department ?? "UNKNOWN";
    for (const a of t.approvals ?? []) {
      if (!a.approverId || SYSTEM.has(a.approverId.toUpperCase())) continue;
      const m = deptApprovals.get(dept) ?? new Map<string, number>();
      m.set(a.approverId, (m.get(a.approverId) ?? 0) + 1);
      deptApprovals.set(dept, m);
    }
  }
  for (const [dept, counts] of deptApprovals) {
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    for (const [approverId, count] of counts) {
      const share = count / total;
      if (share < 0.4 || count < 5) continue;
      const outside = transactions.filter((t) => (indexes.employeeById.get(t.employeeId)?.department ?? t.department) === dept && (t.approvals ?? []).some((a) => a.approverId === approverId) && indexes.employeeById.get(t.employeeId)?.managerId !== approverId).length;
      if (outside >= Math.ceil(count / 2)) push("P06", `${approverId} handles ${Math.round(share * 100)}% of ${dept} approvals, mostly outside the chain`, { approverId, department: dept, share: Math.round(share * 100), count, outsideChain: outside });
    }
  }

  // P07 amount outliers by type × grade × department (robust z)
  const groups = new Map<string, { amounts: number[]; txns: Transaction[] }>();
  for (const t of transactions) {
    if (t.amountFils === null || t.type === "LEAVE") continue;
    const emp = indexes.employeeById.get(t.employeeId);
    const key = `${t.type}|${emp?.gradeRaw ?? t.gradeRaw ?? "?"}|${emp?.department ?? t.department ?? "?"}`;
    const g = groups.get(key) ?? { amounts: [], txns: [] };
    g.amounts.push(t.amountFils);
    g.txns.push(t);
    groups.set(key, g);
  }
  for (const [key, g] of groups) {
    if (g.amounts.length < 8) continue;
    const med = median(g.amounts);
    const scale = mad(g.amounts) || Math.max(1, Math.abs(med) * 0.1);
    for (const t of g.txns) {
      const z = Math.abs(t.amountFils! - med) / (1.4826 * scale);
      if (z >= 3.5) push("P07", `Amount for ${t.txnId} is far from peers in ${key}`, { txnId: t.txnId, employeeId: t.employeeId, group: key, z: Math.round(z * 100) / 100, amountFils: t.amountFils! });
    }
  }

  // P08 change velocity
  for (const [empId, list] of indexes.txnsByEmployee) {
    const changes = list.filter((t) => (t.type === "PAY_CHANGE" || t.type === "ALLOWANCE_CHANGE") && t.effectiveDate);
    for (const t of changes) {
      const from = new Date(`${t.effectiveDate}T00:00:00Z`);
      from.setUTCDate(from.getUTCDate() - 90);
      const windowCount = changes.filter((x) => x.effectiveDate && x.effectiveDate >= from.toISOString().slice(0, 10) && x.effectiveDate <= t.effectiveDate!).length;
      if (windowCount >= 3) {
        push("P08", `${windowCount} pay/allowance changes for ${empId} in 90 days`, { employeeId: empId, windowCount, anchorTxn: t.txnId });
        break;
      }
    }
  }

  // P09 pre-exit uplift
  for (const t of transactions) {
    if (t.type !== "PAY_CHANGE" && t.type !== "ALLOWANCE_CHANGE") continue;
    if (!t.amountFils || t.amountFils <= 0 || !t.effectiveDate) continue;
    const emp = indexes.employeeById.get(t.employeeId);
    if (!emp?.exitDate) continue;
    const days = diffDays(emp.exitDate, t.effectiveDate);
    if (days >= 0 && days <= 90) push("P09", `Increase of AED ${(t.amountFils / 100).toLocaleString("en-US")} for ${t.employeeId} ${days} days before exit`, { txnId: t.txnId, employeeId: t.employeeId, daysBeforeExit: days, amountFils: t.amountFils });
  }

  // P10 orphan activity
  for (const t of transactions) {
    const emp = indexes.employeeById.get(t.employeeId);
    if (!emp) {
      push("P10", `Transaction ${t.txnId} references unknown employee ${t.employeeId}`, { txnId: t.txnId, employeeId: t.employeeId, reason: "unknown_employee" });
      continue;
    }
    if (t.effectiveDate) {
      const state = pointInTimeStatus(emp, t.effectiveDate);
      if (state === "NOT_HIRED" || state === "EXITED" || state === "SUSPENDED") {
        push("P10", `Transaction ${t.txnId} references ${t.employeeId}, who was ${state} at the effective date`, { txnId: t.txnId, employeeId: t.employeeId, reason: `inactive_at_effective:${state}` });
      }
    }
    for (const a of t.approvals ?? []) {
      if (!a.approverId || SYSTEM.has(a.approverId.toUpperCase()) || !a.approvedAt) continue;
      const approver = indexes.employeeById.get(a.approverId);
      if (approver && pointInTimeStatus(approver, instantToDubaiDate(a.approvedAt)) === "EXITED") {
        push("P10", `Approver ${a.approverId} was inactive when approving ${t.txnId}`, { txnId: t.txnId, approverId: a.approverId, reason: "inactive_approver" });
        break;
      }
    }
  }

  return out.slice(0, 120);
}

/** The feature allow-list: detectors may read these fields only. */
export const DETECTOR_FEATURES = [
  "txn.type", "txn.amountFils", "txn.effectiveDate", "txn.submittedAt", "txn.employeeId", "txn.requesterId",
  "approval.approverId", "approval.approvedAt", "approval.role",
  "employee.department", "employee.gradeRaw", "employee.managerId", "employee.hireDate", "employee.exitDate", "employee.status",
] as const;

/** Protected attributes must never reach a detector (P07 / fairness). */
export const PROTECTED_ATTRIBUTES = ["nationality", "gender", "age", "religion", "marital_status", "ethnicity"] as const;

export function assertNoProtectedFeatures(features: readonly string[]): void {
  const bad = features.filter((f) => f.split(".").some((part) => (PROTECTED_ATTRIBUTES as readonly string[]).includes(part.toLowerCase())));
  if (bad.length) throw new Error(`MZ-RAI-500: protected attribute(s) reached a detector: ${bad.join(", ")}`);
}
