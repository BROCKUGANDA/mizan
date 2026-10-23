/**
 * Labelled mutation operators (backtesting §4). Each case starts from a
 * transaction that PASSES the target rule, produces a positive that must FAIL
 * and a near-miss twin that must not, and records the operator id.
 */

import type { Approval, Employee, Transaction } from "../contracts";
import { addDays, instantToDubaiDate } from "../domain/dates";
import { evaluateDataset, outcomeFor, type Dataset } from "./dataset";

export interface MutationResult {
  operator: string;
  ruleId: string;
  clauseId: string;
  positiveDetected: boolean;
  nearMissFalsePositive: boolean;
  detail?: string;
}

interface MutationContext {
  dataset: Dataset;
  base: Transaction;
}

interface Mutation {
  operator: string;
  ruleId: string;
  clauseId: string;
  positive: (ctx: MutationContext) => { transactions: Transaction[]; employees: Employee[]; checkTxnId: string };
  nearMiss: (ctx: MutationContext) => { transactions: Transaction[]; employees: Employee[]; checkTxnId: string };
}

function cloneTxn(t: Transaction): Transaction {
  return { ...t, approvals: t.approvals ? t.approvals.map((a) => ({ ...a })) : t.approvals, documents: t.documents ? t.documents.map((d) => ({ ...d })) : t.documents, caveats: [...t.caveats], dq: [...t.dq] };
}

function withApproval(t: Transaction, approverId: string, grade: string, at: string, role = ""): Transaction {
  const clone = cloneTxn(t);
  const a: Approval = { approverId, position: 0, approvedAt: at, precision: "timestamp", role, gradeRaw: grade, delegateFor: null };
  clone.approvals = [a];
  return clone;
}

function activeWithGrade(employees: Employee[], minGrade: number, exclude: string[] = []): Employee {
  const found = employees.find((e) => e.status === "ACTIVE" && (e.gradeOrdinal ?? 0) >= minGrade && !exclude.includes(e.employeeId));
  if (!found) throw new Error(`no active employee at grade ${minGrade}`);
  return found;
}

function activeAtMost(employees: Employee[], maxGrade: number, exclude: string[] = []): Employee {
  const found = employees.find((e) => e.status === "ACTIVE" && (e.gradeOrdinal ?? 0) <= maxGrade && (e.gradeOrdinal ?? 0) > 0 && !exclude.includes(e.employeeId));
  if (!found) throw new Error(`no active employee at or below grade ${maxGrade}`);
  return found;
}

function replaced(dataset: Dataset, base: Transaction, next: Transaction, employees = dataset.employees): { transactions: Transaction[]; employees: Employee[]; checkTxnId: string } {
  return { transactions: dataset.transactions.map((t) => (t.rowId === base.rowId ? next : t)), employees, checkTxnId: next.txnId };
}

function appended(dataset: Dataset, base: Transaction, additions: Transaction[], employees = dataset.employees): { transactions: Transaction[]; employees: Employee[]; checkTxnId: string } {
  return { transactions: [...dataset.transactions, ...additions], employees, checkTxnId: base.txnId };
}

function isHrbp(t: Transaction, a: Approval, employees: Employee[]): boolean {
  if ((a.role ?? "").toUpperCase() === "HRBP") return true;
  return employees.find((e) => e.employeeId === a.approverId)?.roles.includes("HRBP") ?? false;
}

const MUTATIONS: Mutation[] = [
  {
    operator: "M-AL-1", ruleId: "R04", clauseId: "C1",
    positive: ({ dataset, base }) => {
      const bad = activeAtMost(dataset.employees, 12, [base.employeeId]);
      return replaced(dataset, base, withApproval({ ...base, type: "ALLOWANCE_CHANGE", typeRaw: "ALLOWANCE_CHANGE", amountFils: 1_000_001 }, bad.employeeId, String(bad.gradeOrdinal), "2026-03-03T10:00:00Z"));
    },
    nearMiss: ({ dataset, base }) => {
      const good = activeWithGrade(dataset.employees, 13, [base.employeeId]);
      return replaced(dataset, base, withApproval({ ...base, type: "ALLOWANCE_CHANGE", typeRaw: "ALLOWANCE_CHANGE", amountFils: 1_000_001 }, good.employeeId, String(good.gradeOrdinal), "2026-03-03T10:00:00Z"));
    },
  },
  {
    operator: "M-AL-1b", ruleId: "R05", clauseId: "C1",
    positive: ({ dataset, base }) => {
      const bad = activeAtMost(dataset.employees, 14, [base.employeeId]);
      return replaced(dataset, base, withApproval({ ...base, type: "PAY_CHANGE", typeRaw: "PAY_CHANGE", amountFils: 2_500_001 }, bad.employeeId, String(bad.gradeOrdinal), "2026-03-03T10:00:00Z"));
    },
    nearMiss: ({ dataset, base }) => {
      const good = activeWithGrade(dataset.employees, 15, [base.employeeId]);
      return replaced(dataset, base, withApproval({ ...base, type: "PAY_CHANGE", typeRaw: "PAY_CHANGE", amountFils: 2_500_001 }, good.employeeId, String(good.gradeOrdinal), "2026-03-03T10:00:00Z"));
    },
  },
  {
    operator: "M-AC-1", ruleId: "R01", clauseId: "C1",
    positive: ({ dataset, base }) => {
      const clone = cloneTxn(base);
      clone.approvals = (clone.approvals ?? []).filter((a) => !isHrbp(clone, a, dataset.employees));
      return replaced(dataset, base, clone);
    },
    nearMiss: ({ dataset, base }) => {
      const clone = cloneTxn(base);
      const hrbp = (clone.approvals ?? []).find((a) => isHrbp(clone, a, dataset.employees));
      if (hrbp) clone.approvals = [...(clone.approvals ?? []), { ...hrbp, position: (clone.approvals ?? []).length }];
      return replaced(dataset, base, clone);
    },
  },
  {
    operator: "M-SEQ-1", ruleId: "R02", clauseId: "C1",
    positive: ({ dataset, base }) => {
      const clone = cloneTxn(base);
      clone.submittedPrecision = "timestamp";
      const submitted = clone.submittedAt ?? `${clone.effectiveDate}T09:00:00Z`;
      const before = new Date(new Date(submitted).getTime() - 60_000).toISOString().replace(".000Z", "Z");
      clone.approvals = (clone.approvals ?? []).map((a, i) => (i === 0 ? { ...a, approvedAt: before } : a));
      return replaced(dataset, base, clone);
    },
    nearMiss: ({ dataset, base }) => {
      const clone = cloneTxn(base);
      clone.submittedPrecision = "timestamp";
      const submitted = clone.submittedAt ?? `${clone.effectiveDate}T09:00:00Z`;
      const after = new Date(new Date(submitted).getTime() + 1_000).toISOString().replace(".000Z", "Z");
      clone.approvals = (clone.approvals ?? []).map((a, i) => (i === 0 ? { ...a, approvedAt: after } : a));
      return replaced(dataset, base, clone);
    },
  },
  {
    operator: "M-CH-1", ruleId: "R03", clauseId: "C2",
    positive: ({ dataset, base }) => {
      const outsider = activeWithGrade(dataset.employees, 10, (base.approvals ?? []).map((a) => a.approverId ?? ""));
      const clone = cloneTxn(base);
      clone.passthrough = { ...clone.passthrough, receiving_manager_id: outsider.employeeId };
      return replaced(dataset, base, clone);
    },
    nearMiss: ({ dataset, base }) => {
      const approved = (base.approvals ?? []).find((a) => !!a.approverId && a.approverId !== base.employeeId);
      const clone = cloneTxn(base);
      clone.passthrough = { ...clone.passthrough, receiving_manager_id: approved?.approverId ?? base.employeeId };
      return replaced(dataset, base, clone);
    },
  },
  {
    operator: "M-SOD-1", ruleId: "R06", clauseId: "C1",
    positive: ({ dataset, base }) => {
      const clone = cloneTxn(base);
      const requester = clone.requesterId ?? clone.employeeId;
      const approver = (clone.approvals ?? [])[0];
      clone.requesterId = requester;
      clone.approvals = [{ ...(approver ?? { approverId: requester, position: 0, approvedAt: clone.submittedAt, precision: "timestamp", role: "", gradeRaw: "13", delegateFor: null }), approverId: requester }];
      return replaced(dataset, base, clone);
    },
    nearMiss: ({ dataset, base }) => {
      const independent = activeWithGrade(dataset.employees, 10, [base.employeeId, base.requesterId ?? ""]);
      return replaced(dataset, base, withApproval(cloneTxn(base), independent.employeeId, String(independent.gradeOrdinal), base.submittedAt ?? "2026-03-03T10:00:00Z"));
    },
  },
  {
    operator: "M-DOC-2", ruleId: "R07", clauseId: "C1",
    positive: ({ dataset, base }) => {
      const clone = cloneTxn(base);
      clone.documents = (clone.documents ?? []).filter((d) => d.canonical !== "VISA_COPY");
      const employees = dataset.employees.map((e) => e.employeeId === base.employeeId ? { ...e, attributes: { ...e.attributes, nationality: "EXPAT" } } : e);
      return replaced(dataset, base, clone, employees);
    },
    nearMiss: ({ dataset, base }) => {
      const clone = cloneTxn(base);
      clone.documents = [...(clone.documents ?? []).filter((d) => d.canonical !== "VISA_COPY"), { raw: "visa.jpg", canonical: "VISA_COPY" }];
      const employees = dataset.employees.map((e) => e.employeeId === base.employeeId ? { ...e, attributes: { ...e.attributes, nationality: "EXPAT" } } : e);
      return replaced(dataset, base, clone, employees);
    },
  },
  {
    operator: "M-TW-1", ruleId: "R08", clauseId: "C1",
    positive: ({ dataset, base }) => {
      const submitted = instantToDubaiDate(base.submittedAt ?? `${base.effectiveDate}T09:00:00Z`);
      return replaced(dataset, base, { ...base, effectiveDate: addDays(submitted, -31) });
    },
    nearMiss: ({ dataset, base }) => {
      const submitted = instantToDubaiDate(base.submittedAt ?? `${base.effectiveDate}T09:00:00Z`);
      return replaced(dataset, base, { ...base, effectiveDate: addDays(submitted, -30) });
    },
  },
  {
    operator: "M-ELG-1", ruleId: "R09", clauseId: "C1",
    positive: ({ dataset, base }) => {
      const employees = dataset.employees.map((e) => e.employeeId === base.employeeId ? { ...e, exitDate: addDays(base.effectiveDate ?? "2026-03-01", -1), status: "EXITED" as const } : e);
      return replaced(dataset, base, cloneTxn(base), employees);
    },
    nearMiss: ({ dataset, base }) => {
      const employees = dataset.employees.map((e) => e.employeeId === base.employeeId ? { ...e, exitDate: base.effectiveDate, status: "EXITED" as const } : e);
      return replaced(dataset, base, cloneTxn(base), employees);
    },
  },
  {
    operator: "M-AGG-1", ruleId: "R10", clauseId: "C1",
    positive: ({ dataset, base }) => {
      const prior = (n: number): Transaction => ({
        ...cloneTxn(base), rowId: `${base.txnId}-PRE${n}`, txnId: `${base.txnId}-PRE${n}`,
        amountFils: 100_000 + n, effectiveDate: addDays(base.effectiveDate ?? "2026-03-01", -n * 10),
        submittedAt: base.submittedAt, approvals: base.approvals,
      });
      return appended(dataset, base, [prior(1), prior(2)]);
    },
    nearMiss: ({ dataset, base }) => {
      const prior: Transaction = { ...cloneTxn(base), rowId: `${base.txnId}-PRE1`, txnId: `${base.txnId}-PRE1`, amountFils: 100_001, effectiveDate: addDays(base.effectiveDate ?? "2026-03-01", -10) };
      return appended(dataset, base, [prior]);
    },
  },
  {
    operator: "M-DUP-1", ruleId: "R11", clauseId: "C1",
    positive: ({ dataset, base }) => {
      const twin: Transaction = {
        ...cloneTxn(base), rowId: `${base.txnId}-TWIN`, txnId: `${base.txnId}-TWIN`,
        effectiveDate: addDays(base.effectiveDate ?? "2026-03-01", 1), submittedAt: base.submittedAt,
      };
      return { ...appended(dataset, base, [twin]), checkTxnId: twin.txnId };
    },
    nearMiss: ({ dataset, base }) => {
      const twin: Transaction = {
        ...cloneTxn(base), rowId: `${base.txnId}-FAR`, txnId: `${base.txnId}-FAR`,
        effectiveDate: addDays(base.effectiveDate ?? "2026-03-01", 30), submittedAt: base.submittedAt,
      };
      return { ...appended(dataset, base, [twin]), checkTxnId: twin.txnId };
    },
  },
  {
    operator: "M-REF-1", ruleId: "R12", clauseId: "C1",
    positive: ({ dataset, base }) => {
      const clone = cloneTxn(base);
      clone.approvals = [{ ...(clone.approvals ?? [])[0]!, approverId: "E99999", gradeRaw: "13" }];
      return replaced(dataset, base, clone);
    },
    nearMiss: ({ dataset, base }) => {
      const clone = cloneTxn(base);
      const known = (clone.approvals ?? [])[0]!;
      const active = activeWithGrade(dataset.employees, 1, []);
      clone.approvals = [{ ...known, approverId: active.employeeId }];
      return replaced(dataset, base, clone);
    },
  },
  {
    operator: "M-VB-1", ruleId: "R13", clauseId: "C1",
    positive: ({ dataset, base }) => {
      const emp = dataset.employees.find((e) => e.employeeId === base.employeeId);
      const baseFils = Number(emp?.attributes.baseSalaryFils ?? 0) || 2_000_000;
      const bad = activeAtMost(dataset.employees, 16, [base.employeeId]);
      const employees = dataset.employees.map((e) => e.employeeId === base.employeeId ? { ...e, attributes: { ...e.attributes, baseSalaryFils: String(baseFils) } } : e);
      return replaced(dataset, base, withApproval({ ...base, type: "PAY_CHANGE", typeRaw: "PAY_CHANGE", amountFils: Math.round(baseFils * 0.2) }, bad.employeeId, String(bad.gradeOrdinal), base.submittedAt ?? "2026-03-03T10:00:00Z"), employees);
    },
    nearMiss: ({ dataset, base }) => {
      const emp = dataset.employees.find((e) => e.employeeId === base.employeeId);
      const baseFils = Number(emp?.attributes.baseSalaryFils ?? 0) || 2_000_000;
      const good = activeWithGrade(dataset.employees, 17, [base.employeeId]);
      const employees = dataset.employees.map((e) => e.employeeId === base.employeeId ? { ...e, attributes: { ...e.attributes, baseSalaryFils: String(baseFils) } } : e);
      return replaced(dataset, base, withApproval({ ...base, type: "PAY_CHANGE", typeRaw: "PAY_CHANGE", amountFils: Math.round(baseFils * 0.2) }, good.employeeId, String(good.gradeOrdinal), base.submittedAt ?? "2026-03-03T10:00:00Z"), employees);
    },
  },
];

export function runMutations(dataset: Dataset): MutationResult[] {
  const baseline = evaluateDataset(dataset.transactions, dataset.employees, "mutation-baseline");
  const out: MutationResult[] = [];
  for (const mutation of MUTATIONS) {
    const base = baseline.results.find((r) => r.ruleId === mutation.ruleId && r.clauseId === mutation.clauseId && r.outcome === "PASS")
      ?? baseline.results.find((r) => r.ruleId === mutation.ruleId && r.clauseId === mutation.clauseId && r.outcome === "NOT_APPLICABLE");
    if (!base) {
      out.push({ operator: mutation.operator, ruleId: mutation.ruleId, clauseId: mutation.clauseId, positiveDetected: false, nearMissFalsePositive: true, detail: "no passing base transaction" });
      continue;
    }
    const baseTxn = dataset.transactions.find((t) => t.rowId === base.rowId)!;
    const positive = mutation.positive({ dataset, base: baseTxn });
    const near = mutation.nearMiss({ dataset, base: baseTxn });
    const pOut = evaluateDataset(positive.transactions, positive.employees, `mut-${mutation.operator}`);
    const nOut = evaluateDataset(near.transactions, near.employees, `mut-${mutation.operator}-near`);
    const pOutcome = outcomeFor(pOut, positive.checkTxnId, mutation.ruleId, mutation.clauseId);
    const nOutcome = outcomeFor(nOut, near.checkTxnId, mutation.ruleId, mutation.clauseId);
    out.push({
      operator: mutation.operator,
      ruleId: mutation.ruleId,
      clauseId: mutation.clauseId,
      positiveDetected: pOutcome === "FAIL",
      nearMissFalsePositive: nOutcome === "FAIL",
      detail: `positive=${pOutcome ?? "missing"} near=${nOutcome ?? "missing"}`,
    });
  }
  return out;
}
