/** Shared fixture loading for the backtesting harness (no database, no wall clock). */

import { parseCsv, normaliseEmployees, normaliseTransactions, type ParsedCsv } from "../normalize";
import { generatePack } from "../pack/generate";
import { RULE_SPECS } from "../pack/rules";
import { evaluate, type EvaluateOutput } from "../engine/evaluate";
import { UAE_CALENDAR } from "../domain/calendar";
import type { Employee, Transaction } from "../contracts";

export interface Dataset {
  transactionsCsv: string;
  employeesCsv: string;
  parsedTransactions: ParsedCsv;
  parsedEmployees: ParsedCsv;
  transactions: Transaction[];
  employees: Employee[];
}

export function packDataset(seed = 42, fromFiles?: { transactionsCsv: string; employeesCsv: string }): Dataset {
  const pack = fromFiles ?? generatePack(seed, 10000);
  const parsedEmployees = parseCsv(pack.employeesCsv, ",");
  const { employees } = normaliseEmployees(parsedEmployees, "bench-employees");
  const parsedTransactions = parseCsv(pack.transactionsCsv, ",");
  const transactions = normaliseTransactions(parsedTransactions, "bench-transactions", { quarantined: [], dqByRow: {}, dateOrderDefaulted: false }, {
    employeeIds: new Set(employees.map((e) => e.employeeId)),
    asOf: "2026-04-01",
  });
  return { transactionsCsv: pack.transactionsCsv, employeesCsv: pack.employeesCsv, parsedTransactions, parsedEmployees, transactions, employees };
}

export function evaluateDataset(transactions: Transaction[], employees: Employee[], runId = "bench"): EvaluateOutput {
  return evaluate({
    transactions, employees, pack: RULE_SPECS.filter((r) => r.status === "active"),
    config: { calendarVersion: UAE_CALENDAR.version, routingTableVersion: "routing-1.2.0" },
    asOf: "2026-04-01", runId,
  });
}

export function findingKeys(output: EvaluateOutput): Set<string> {
  return new Set(output.results.filter((r) => r.outcome === "FAIL").map((r) => `${r.txnId}|${r.ruleId}|${r.clauseId}`));
}

export function outcomeFor(output: EvaluateOutput, txnId: string, ruleId: string, clauseId = "C1"): string | null {
  return output.results.find((r) => r.txnId === txnId && r.ruleId === ruleId && r.clauseId === clauseId)?.outcome ?? null;
}

/** Serialise a parsed CSV (used by text-level format mutations). */
export function serialiseCsv(parsed: ParsedCsv, lineEnding = "\r\n", bom = false): string {
  const esc = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return (bom ? "\uFEFF" : "") + [parsed.headers.map(esc).join(","), ...parsed.rows.map((r) => r.map(esc).join(","))].join(lineEnding) + lineEnding;
}

export function columnIndex(parsed: ParsedCsv, ...names: string[]): number {
  const hs = parsed.headers.map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, "_"));
  for (const n of names) {
    const i = hs.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}

export function cloneParsed(parsed: ParsedCsv): ParsedCsv {
  return { headers: [...parsed.headers], rows: parsed.rows.map((r) => [...r]) };
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
