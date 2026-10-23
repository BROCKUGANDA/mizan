/**
 * Facts (§7 derived facts, computed once per run; pure, no clock).
 * Pre-indexed for the engine: employees, management graph with cycle detection,
 * per-employee transaction lists in effective-date order.
 */

import type { Employee, Transaction, Approval, Caveat, DqCode } from "../contracts";
import type { LocalDate, Instant } from "../domain/dates";
import { instantToDubaiDate, diffDays, localDateToDays } from "../domain/dates";
import { gradeOrdinal } from "../normalize";

export interface EngineIndexes {
  employeeById: Map<string, Employee>;
  managerChainCache: Map<string, string[]>; // employeeId → chain from employee to top (with cycle marker)
  cycleEmployees: Set<string>;              // employees in a management cycle (DQ-010)
  txnsByEmployee: Map<string, Transaction[]>; // effective-date order, ties by submission time then rowId
  txnByRowId: Map<string, Transaction>;
  txnByTxnId: Map<string, Transaction[]>;   // for duplicate detection / reversal links
  reversedIds: Set<string>;                 // txnId/rowId of transactions that a reversal supersedes
}

export function buildIndexes(transactions: Transaction[], employees: Employee[]): EngineIndexes {
  const employeeById = new Map(employees.map((e) => [e.employeeId, e]));
  const cycleEmployees = new Set<string>();
  const managerChainCache = new Map<string, string[]>();
  const GRAY = new Set<string>();
  const BLACK = new Set<string>();

  const chain = (id: string, stack: string[]): string[] => {
    if (managerChainCache.has(id)) return managerChainCache.get(id)!;
    if (BLACK.has(id)) return managerChainCache.get(id) ?? [];
    if (GRAY.has(id)) {
      // cycle detected
      for (const s of stack) cycleEmployees.add(s);
      return [];
    }
    const emp = employeeById.get(id);
    if (!emp || !emp.managerId || !employeeById.has(emp.managerId)) { BLACK.add(id); managerChainCache.set(id, []); return []; }
    GRAY.add(id);
    const result = [emp.managerId, ...chain(emp.managerId, [...stack, id])];
    GRAY.delete(id);
    BLACK.add(id);
    managerChainCache.set(id, result);
    return result;
  };
  for (const e of employees) chain(e.employeeId, []);

  const txnsByEmployee = new Map<string, Transaction[]>();
  const txnByRowId = new Map<string, Transaction>();
  const txnByTxnId = new Map<string, Transaction[]>();
  const reversedIds = new Set<string>();
  for (const t of transactions) {
    const list = txnsByEmployee.get(t.employeeId) ?? [];
    list.push(t);
    txnsByEmployee.set(t.employeeId, list);
    txnByRowId.set(t.rowId, t);
    const byId = txnByTxnId.get(t.txnId) ?? [];
    byId.push(t);
    txnByTxnId.set(t.txnId, byId);
    if (t.reversalOf) reversedIds.add(t.reversalOf);
  }
  for (const list of txnsByEmployee.values()) {
    list.sort((a, b) => {
      const d = (a.effectiveDate ?? "9999").localeCompare(b.effectiveDate ?? "9999");
      if (d !== 0) return d;
      const s = (a.submittedAt ?? "9999").localeCompare(b.submittedAt ?? "9999");
      if (s !== 0) return s;
      return a.rowId.localeCompare(b.rowId);
    });
  }
  return { employeeById, managerChainCache, cycleEmployees, txnsByEmployee, txnByRowId, txnByTxnId, reversedIds };
}

// ── Derived facts ────────────────────────────────────────────────────────────

export interface PersonAtTime {
  exists: boolean;
  employee: Employee | null;
  activeAt: boolean;       // active at a given date (point-in-time)
  gradeOrdinal: number | null;
  gradeSource: "transaction" | "master_snapshot" | "none";
  isLineManagerOf: (employeeId: string, at: LocalDate | null) => boolean;
  inChainOf: (employeeId: string) => boolean;
}

/** Point-in-time status from employment dates (EC-C09/C14). Active through exit date inclusive. */
export function activeAt(employee: Employee, date: LocalDate): boolean {
  return pointInTimeStatus(employee, date) === "ACTIVE" || pointInTimeStatus(employee, date) === "ON_LEAVE";
}

export function pointInTimeStatus(employee: Employee, date: LocalDate): "ACTIVE" | "EXITED" | "SUSPENDED" | "ON_LEAVE" | "NOT_HIRED" | "UNKNOWN" {
  if (employee.status === "UNKNOWN") return "UNKNOWN";
  if (employee.hireDate && date < employee.hireDate) return "NOT_HIRED";
  if (employee.exitDate && date > employee.exitDate) return "EXITED";
  if (employee.status === "EXITED" && !employee.exitDate) return "EXITED";
  if (employee.status === "SUSPENDED") return "SUSPENDED";
  if (employee.status === "ON_LEAVE") return "ON_LEAVE";
  return "ACTIVE";
}

/** Grade of an approver: transaction value wins, then master snapshot (evidence states which). */
export function approverGrade(t: Transaction, ap: Approval, indexes: EngineIndexes): { ordinal: number | null; dq: DqCode | null; source: "transaction" | "master_snapshot" | "none"; caveat: Caveat | null } {
  if (ap.gradeRaw) {
    const { ordinal, dq } = gradeOrdinal(ap.gradeRaw);
    return { ordinal, dq, source: "transaction", caveat: null };
  }
  const master = indexes.employeeById.get(ap.approverId ?? "");
  if (master?.gradeOrdinal !== undefined && master?.gradeOrdinal !== null) {
    return {
      ordinal: master.gradeOrdinal, dq: null, source: "master_snapshot",
      caveat: { code: "SNAPSHOT_GRADE", message: { en: `Grade taken from the employee master snapshot for ${ap.approverId}.`, ar: `تم اعتماد الدرجة من لقطة بيانات الموظف ${ap.approverId}.` }, facts: [ap.approverId ?? ""] },
    };
  }
  const unknown = master ? null : "DQ-005";
  return { ordinal: null, dq: unknown, source: "none", caveat: null };
}

function requireGradeLookup(raw: string): { ordinal: number | null; dq: DqCode | null } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { gradeOrdinal } = require("../normalize") as typeof import("../normalize");
  return gradeOrdinal(raw);
}

/**
 * Pay-increase percentage in basis points vs a derived base (EC-G04).
 * The employee master carries the current base salary. For a historical change,
 * the base at that date is the current base minus later pay deltas. A previous
 * delta is never used as a base (that would turn a 2.6k raise on 12k into 100%).
 */
export function payChangePct(t: Transaction, indexes: EngineIndexes): { pctBps: number | null; baseFils: number | null; baseSource: string | null; caveat: Caveat | null; dq: DqCode | null } {
  if (t.amountFils === null || t.type !== "PAY_CHANGE") return { pctBps: null, baseFils: null, baseSource: null, caveat: null, dq: null };
  const emp = indexes.employeeById.get(t.employeeId);
  if (!emp) return { pctBps: null, baseFils: null, baseSource: null, caveat: null, dq: "DQ-004" };
  const masterRaw = emp.attributes.baseSalaryFils;
  const masterBase = masterRaw ? parseInt(masterRaw, 10) : null;
  const history = indexes.txnsByEmployee.get(t.employeeId) ?? [];
  const laterDeltas = history
    .filter((x) => x.type === "PAY_CHANGE" && x.amountFils !== null && x.effectiveDate !== null && t.effectiveDate !== null &&
      x.effectiveDate > t.effectiveDate && !x.reversalOf && !indexes.reversedIds.has(x.rowId) && !indexes.reversedIds.has(x.txnId))
    .reduce((sum, x) => sum + (x.amountFils ?? 0), 0);
  let base = masterBase !== null && masterBase - laterDeltas > 0 ? masterBase - laterDeltas : null;
  let baseSource: string | null = base !== null ? (laterDeltas ? "employee_master_adjusted_for_later_changes" : "employee_master_snapshot") : null;
  if (base === null) {
    const priorTotal = history
      .filter((x) => x.type === "PAY_CHANGE" && x.amountSemantics === "new_total" && x.amountFils !== null && x.effectiveDate !== null && t.effectiveDate !== null &&
        x.effectiveDate < t.effectiveDate && !x.reversalOf)
      .sort((a, b) => cmpInstantDesc(a.effectiveDate!, b.effectiveDate!))[0];
    if (priorTotal?.amountFils) { base = priorTotal.amountFils; baseSource = "previous_pay_total"; }
  }
  if (base === null || base <= 0) {
    return { pctBps: null, baseFils: null, baseSource: null, caveat: null, dq: "DQ-001" };
  }
  const pctBps = Math.round((t.amountFils * 10_000) / base);
  const caveat: Caveat = {
    code: "DERIVED_BASE",
    message: {
      en: `Base pay of AED ${formatFils(base)} derived from the employee master (${baseSource}).`,
      ar: `الراتب الأساسي ${formatFils(base)} درهم مشتق من بيانات الموظف (${baseSource}).`,
    },
    facts: [t.employeeId, String(base)],
  };
  return { pctBps, baseFils: base, baseSource, caveat, dq: null };
}

function formatFils(fils: number): string {
  const abs = Math.abs(fils);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${fils < 0 ? "-" : ""}${whole}.${String(abs % 100).padStart(2, "0")}`;
}

function cmpInstantDesc(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

/** Rolling aggregates per employee (§7): count/sum of same-type txns in [anchor − window + 1, anchor]. */
export function rollingAggregate(t: Transaction, indexes: EngineIndexes, windowDays: number, metric: "count" | "sum" = "count"): { count: number; sumFils: number; contributing: string[]; missingAmounts: number } {
  if (!t.effectiveDate) return { count: 0, sumFils: 0, contributing: [], missingAmounts: 0 };
  const list = indexes.txnsByEmployee.get(t.employeeId) ?? [];
  const anchorDays = localDateToDays(t.effectiveDate);
  const contributing: string[] = [];
  let sumFils = 0;
  let missingAmounts = 0;
  for (const x of list) {
    if (x.type !== t.type || x.effectiveDate === null) continue;
    if (x.reversalOf || indexes.reversedIds.has(x.rowId) || indexes.reversedIds.has(x.txnId)) continue;
    const d = localDateToDays(x.effectiveDate);
    if (d > anchorDays || d < anchorDays - Math.max(1, windowDays) + 1) continue;
    contributing.push(x.rowId);
    if (metric === "sum") {
      if (x.amountFils === null) missingAmounts++;
      else sumFils += x.amountFils;
    }
  }
  return { count: contributing.length, sumFils, contributing, missingAmounts };
}

/** Duplicate twins for R11 (flag: later). */
export function duplicateTwins(t: Transaction, indexes: EngineIndexes, toleranceDays: number): Transaction[] {
  if (t.amountFils === null || t.effectiveDate === null || t.reversalOf) return [];
  const list = indexes.txnsByEmployee.get(t.employeeId) ?? [];
  const anchorDays = localDateToDays(t.effectiveDate);
  if (indexes.reversedIds.has(t.rowId) || indexes.reversedIds.has(t.txnId)) return [];
  return list.filter((x) =>
    x.rowId !== t.rowId &&
    x.type === t.type &&
    x.amountFils === t.amountFils &&
    !x.reversalOf &&
    !indexes.reversedIds.has(x.rowId) &&
    !indexes.reversedIds.has(x.txnId) &&
    x.effectiveDate !== null &&
    Math.abs(localDateToDays(x.effectiveDate) - anchorDays) <= toleranceDays
  );
}

export function isLaterTwin(a: Transaction, b: Transaction): boolean {
  const d = (a.effectiveDate ?? "").localeCompare(b.effectiveDate ?? "");
  if (d !== 0) return d > 0;
  const s = (a.submittedAt ?? "").localeCompare(b.submittedAt ?? "");
  if (s !== 0) return s > 0;
  return a.rowId.localeCompare(b.rowId) > 0;
}

/** Submitted date as LocalDate in Asia/Dubai (null when absent). */
export function submittedDate(t: Transaction): LocalDate | null {
  return t.submittedAt ? instantToDubaiDate(t.submittedAt) : null;
}

export function submittedIsDatePrecision(t: Transaction): boolean {
  return t.submittedPrecision === "date";
}

/** Approval instants ordered (first recorded approval). */
export function firstApprovalInstant(t: Transaction): { instant: Instant | null; precision: "timestamp" | "date" | "none" } {
  if (!t.approvals || t.approvals.length === 0) return { instant: null, precision: "none" };
  const withTime = t.approvals.filter((a) => a.approvedAt);
  if (!withTime.length) return { instant: null, precision: "none" };
  const sorted = [...withTime].sort((a, b) => a.approvedAt!.localeCompare(b.approvedAt!));
  return { instant: sorted[0]!.approvedAt!, precision: sorted[0]!.precision };
}
