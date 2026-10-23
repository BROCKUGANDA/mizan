/**
 * Metamorphic relations MR-1…MR-7 (backtesting §6). Each returns the two
 * outputs and whether the expected invariant held.
 */

import type { Employee, Transaction } from "../contracts";
import { addDays } from "../domain/dates";
import { RULE_SPECS } from "../pack/rules";
import { evaluate } from "../engine/evaluate";
import { UAE_CALENDAR } from "../domain/calendar";
import { evaluateDataset, findingKeys, type Dataset } from "./dataset";

export interface RelationResult {
  id: string;
  holds: boolean;
  detail: string;
}

function run(transactions: Transaction[], employees: Employee[], runId: string) {
  return evaluate({
    transactions, employees, pack: RULE_SPECS.filter((r) => r.status === "active"),
    config: { calendarVersion: UAE_CALENDAR.version, routingTableVersion: "routing-1.2.0" },
    asOf: "2026-04-01", runId,
  });
}

function clone(t: Transaction): Transaction {
  return { ...t, approvals: t.approvals ? t.approvals.map((a) => ({ ...a })) : t.approvals, documents: t.documents ? t.documents.map((d) => ({ ...d })) : t.documents, caveats: [...t.caveats], dq: [...t.dq] };
}

function shiftInstant(value: string | null, days: number): string | null {
  if (!value) return null;
  return new Date(new Date(value).getTime() + days * 86_400_000).toISOString().replace(".000Z", "Z");
}

export function mr1RowPermutation(dataset: Dataset): RelationResult {
  const baseline = evaluateDataset(dataset.transactions, dataset.employees, "mr1-base");
  const permuted = [...dataset.transactions].reverse();
  const output = evaluateDataset(permuted, dataset.employees, "mr1-permuted");
  return { id: "MR-1", holds: baseline.outputHash === output.outputHash && baseline.counts.failed === output.counts.failed, detail: `hash ${baseline.outputHash.slice(0, 12)} vs ${output.outputHash.slice(0, 12)}` };
}

export function mr2IdRelabel(dataset: Dataset): RelationResult {
  const map = new Map<string, string>();
  for (const e of dataset.employees) map.set(e.employeeId, `X${e.employeeId.slice(1)}`);
  const ren = (id: string | null): string | null => (id ? map.get(id) ?? id : id);
  const employees = dataset.employees.map((e) => ({ ...e, employeeId: map.get(e.employeeId)!, managerId: ren(e.managerId) }));
  const transactions = dataset.transactions.map((t) => {
    const c = clone(t);
    c.employeeId = map.get(t.employeeId) ?? t.employeeId;
    c.requesterId = ren(t.requesterId);
    if (c.approvals) c.approvals = c.approvals.map((a) => ({ ...a, approverId: ren(a.approverId) }));
    if (c.passthrough.receiving_manager_id) c.passthrough = { ...c.passthrough, receiving_manager_id: ren(c.passthrough.receiving_manager_id) ?? c.passthrough.receiving_manager_id };
    return c;
  });
  const base = evaluateDataset(dataset.transactions, dataset.employees, "mr2-base");
  const out = evaluateDataset(transactions, employees, "mr2-relabelled");
  const a = findingKeys(base);
  const b = findingKeys(out);
  return { id: "MR-2", holds: a.size === b.size && [...a].every((k) => b.has(k)), detail: `${a.size} vs ${b.size}` };
}

export function mr3UnrelatedTransactions(dataset: Dataset): RelationResult {
  const base = evaluateDataset(dataset.transactions, dataset.employees, "mr3-base");
  const employee: Employee = {
    employeeId: "Z99999", gradeRaw: "10", gradeOrdinal: 10, department: "Finance", location: "Dubai",
    managerId: null, hireDate: "2020-01-01", exitDate: null, statusRaw: "ACTIVE", status: "ACTIVE",
    roles: [], spells: [{ from: "2020-01-01", to: null }], attributes: { nationality: "EXPAT", baseSalaryFils: "1500000" },
  };
  const txn: Transaction = {
    rowId: "Z-TXN-1", txnId: "Z-TXN-1", type: "LEAVE", typeRaw: "LEAVE", employeeId: "Z99999",
    gradeRaw: "10", department: "Finance", location: "Dubai", amountFils: null, currency: "AED",
    amountSemantics: "unknown", effectiveDate: "2026-03-01", submittedAt: "2026-03-01T09:00:00Z",
    submittedPrecision: "timestamp", requesterId: "Z99999", approvals: null, documents: null, reversalOf: null,
    freeText: {}, passthrough: {}, source: { datasetId: "mr3", rowNumber: 1, rowHash: "z" }, dq: [], caveats: [],
  };
  const out = evaluateDataset([...dataset.transactions, txn], [...dataset.employees, employee], "mr3-added");
  const baseKeys = findingKeys(base);
  const outKeys = findingKeys(out);
  const changed = [...baseKeys].filter((k) => !outKeys.has(k));
  return { id: "MR-3", holds: changed.length === 0, detail: `${changed.length} existing finding(s) changed` };
}

export function mr4ScaleAmounts(dataset: Dataset): RelationResult {
  const base = evaluateDataset(dataset.transactions, dataset.employees, "mr4-base");
  const transactions = dataset.transactions.map((t) => ({ ...clone(t), amountFils: t.amountFils === null ? null : Math.round(t.amountFils / 100) }));
  const employees = dataset.employees.map((e) => ({ ...e, attributes: { ...e.attributes, baseSalaryFils: e.attributes.baseSalaryFils ? String(Math.round(Number(e.attributes.baseSalaryFils) / 100)) : "" } }));
  const out = evaluateDataset(transactions, employees, "mr4-scaled");
  const approvalFailures = out.results.filter((r) => r.outcome === "FAIL" && (r.ruleId === "R04" || r.ruleId === "R05"));
  const otherBase = new Set(base.results.filter((r) => r.outcome === "FAIL" && r.ruleId !== "R04" && r.ruleId !== "R05").map((r) => `${r.txnId}|${r.ruleId}|${r.clauseId}`));
  const otherOut = new Set(out.results.filter((r) => r.outcome === "FAIL" && r.ruleId !== "R04" && r.ruleId !== "R05").map((r) => `${r.txnId}|${r.ruleId}|${r.clauseId}`));
  const otherChanged = [...otherBase].filter((k) => !otherOut.has(k)).length + [...otherOut].filter((k) => !otherBase.has(k)).length;
  return { id: "MR-4", holds: approvalFailures.length === 0 && otherChanged === 0, detail: `approval failures ${approvalFailures.length}, other changes ${otherChanged}` };
}

export function mr5ShiftWeeks(dataset: Dataset): RelationResult {
  const base = evaluateDataset(dataset.transactions, dataset.employees, "mr5-base");
  const transactions = dataset.transactions.map((t) => {
    const c = clone(t);
    c.effectiveDate = t.effectiveDate ? addDays(t.effectiveDate, 7) : null;
    c.submittedAt = shiftInstant(t.submittedAt, 7);
    if (c.approvals) c.approvals = c.approvals.map((a) => ({ ...a, approvedAt: shiftInstant(a.approvedAt, 7) }));
    return c;
  });
  const employees = dataset.employees.map((e) => ({ ...e, hireDate: e.hireDate ? addDays(e.hireDate, 7) : null, exitDate: e.exitDate ? addDays(e.exitDate, 7) : null }));
  const out = evaluateDataset(transactions, employees, "mr5-shifted");
  const a = findingKeys(base);
  const b = findingKeys(out);
  return { id: "MR-5", holds: a.size === b.size && [...a].every((k) => b.has(k)), detail: `${a.size} vs ${b.size}` };
}

export function mr6RemoveRule(dataset: Dataset): RelationResult {
  const base = evaluateDataset(dataset.transactions, dataset.employees, "mr6-base");
  const pack = RULE_SPECS.filter((r) => r.status === "active" && r.id !== "R04");
  const out = evaluate({ transactions: dataset.transactions, employees: dataset.employees, pack, config: { calendarVersion: UAE_CALENDAR.version, routingTableVersion: "routing-1.2.0" }, asOf: "2026-04-01", runId: "mr6" });
  const others = (r: { ruleId: string; outcome: string; txnId: string; clauseId: string }) => `${r.txnId}|${r.ruleId}|${r.clauseId}`;
  const a = new Set(base.results.filter((r) => r.outcome === "FAIL" && r.ruleId !== "R04").map(others));
  const b = new Set(out.results.filter((r) => r.outcome === "FAIL").map(others));
  return { id: "MR-6", holds: a.size === b.size && [...a].every((k) => b.has(k)), detail: `${a.size} vs ${b.size}` };
}

export function mr7SameFileTwice(dataset: Dataset): RelationResult {
  const one = evaluateDataset(dataset.transactions, dataset.employees, "mr7-one");
  const two = evaluateDataset(dataset.transactions.map(clone), dataset.employees, "mr7-two");
  return { id: "MR-7", holds: one.outputHash === two.outputHash, detail: `${one.outputHash.slice(0, 12)} vs ${two.outputHash.slice(0, 12)}` };
}

export function runMetamorphic(dataset: Dataset): RelationResult[] {
  return [
    mr1RowPermutation(dataset),
    mr2IdRelabel(dataset),
    mr3UnrelatedTransactions(dataset),
    mr4ScaleAmounts(dataset),
    mr5ShiftWeeks(dataset),
    mr6RemoveRule(dataset),
    mr7SameFileTwice(dataset),
  ];
}
