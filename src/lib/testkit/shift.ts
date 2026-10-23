/**
 * Distribution-shift checks (§15): schema, value domains, nulls, date range,
 * duplicates and per-rule fire/NE rates between training and test files.
 */

import { parseCsv } from "../normalize";
import type { Employee } from "../contracts";
import { evaluateDataset, type Dataset } from "./dataset";
import { columnIndex } from "./dataset";

export interface ShiftReport {
  trainRows: number;
  testRows: number;
  missingColumns: string[];
  extraColumns: string[];
  newTransactionTypes: string[];
  newDepartments: string[];
  newGrades: string[];
  newLocations: string[];
  newCurrencies: string[];
  dateRange: { train: [string, string]; test: [string, string] };
  nullRateIncreases: { column: string; train: number; test: number }[];
  duplicateIdRate: { train: number; test: number };
  ruleRates: { ruleId: string; trainFail: number; testFail: number; trainNe: number; testNe: number }[];
  actions: string[];
}

function valuesAt(parsed: ReturnType<typeof parseCsv>, column: string): string[] {
  const i = columnIndex(parsed, column);
  if (i < 0) return [];
  return parsed.rows.map((r) => (r[i] ?? "").trim()).filter(Boolean);
}

function domain(parsed: ReturnType<typeof parseCsv>, column: string): Set<string> {
  return new Set(valuesAt(parsed, column).map((v) => v.toUpperCase()));
}

function range(parsed: ReturnType<typeof parseCsv>): [string, string] {
  const values = valuesAt(parsed, "effective_date").filter((v) => /^\d{4}-\d{2}-\d{2}$/.test(v)).sort();
  return [values[0] ?? "—", values[values.length - 1] ?? "—"];
}

export function buildShiftReport(train: Dataset, test: Dataset): ShiftReport {
  const trainParsed = train.parsedTransactions;
  const testParsed = test.parsedTransactions;
  const trainHeaders = new Set(trainParsed.headers.map((h) => h.trim().toLowerCase()));
  const testHeaders = new Set(testParsed.headers.map((h) => h.trim().toLowerCase()));
  const diffs = (a: Set<string>, b: Set<string>): string[] => [...a].filter((v) => !b.has(v));
  const diffsUpper = (col: string): string[] => {
    const trainValues = domain(trainParsed, col);
    return [...domain(testParsed, col)].filter((v) => !trainValues.has(v));
  };
  const nullRate = (parsed: ReturnType<typeof parseCsv>, column: string): number => {
    const i = columnIndex(parsed, column);
    if (i < 0 || !parsed.rows.length) return 0;
    return parsed.rows.filter((r) => !(r[i] ?? "").trim()).length / parsed.rows.length;
  };
  const dupRate = (parsed: ReturnType<typeof parseCsv>): number => {
    const i = columnIndex(parsed, "txn_id");
    if (i < 0 || !parsed.rows.length) return 0;
    const ids = parsed.rows.map((r) => r[i] ?? "");
    return (ids.length - new Set(ids).size) / ids.length;
  };
  const trainOut = evaluateDataset(train.transactions, train.employees, "shift-train");
  const testOut = evaluateDataset(test.transactions, test.employees.length ? test.employees : train.employees, "shift-test");
  const rules = new Set([...Object.keys(trainOut.perRule), ...Object.keys(testOut.perRule)]);
  const ruleRates = [...rules].sort().map((ruleId) => {
    const t = trainOut.perRule[ruleId] ?? { total: 0, failed: 0, notApplicable: 0, notEvaluable: 0 };
    const s = testOut.perRule[ruleId] ?? { total: 0, failed: 0, notApplicable: 0, notEvaluable: 0 };
    const tApp = t.total - t.notApplicable;
    const sApp = s.total - s.notApplicable;
    return {
      ruleId,
      trainFail: tApp ? Math.round((t.failed / tApp) * 10_000) / 100 : 0,
      testFail: sApp ? Math.round((s.failed / sApp) * 10_000) / 100 : 0,
      trainNe: tApp ? Math.round((t.notEvaluable / tApp) * 10_000) / 100 : 0,
      testNe: sApp ? Math.round((s.notEvaluable / sApp) * 10_000) / 100 : 0,
    };
  });
  const nullRateIncreases = ["employee_id", "approver_ids", "effective_date", "submitted_at", "amount", "documents"]
    .map((column) => ({ column, train: nullRate(trainParsed, column), test: nullRate(testParsed, column) }))
    .filter((x) => x.test > x.train * 2 && x.test - x.train > 0.02)
    .map((x) => ({ ...x, train: Math.round(x.train * 1000) / 10, test: Math.round(x.test * 1000) / 10 }));

  const actions: string[] = [];
  if (diffs(trainHeaders, testHeaders).length || diffs(testHeaders, trainHeaders).length) actions.push("Map the new/missing columns explicitly and record an ADR.");
  if (diffsUpper("type").length) actions.push("Map new transaction types with a synonym entry; never default silently.");
  if (diffsUpper("department").length) actions.push("Review new departments for routing; unmapped names fall back to triage.");
  if (diffsUpper("grade").length) actions.push("Map new grades on the ladder or mark them DQ-011.");
  if (diffsUpper("currency").length) actions.push("Confirm currency handling; non-AED amounts are not converted silently.");
  if (nullRateIncreases.length) actions.push("Inspect columns with more than 2× the training null rate.");
  if (ruleRates.some((r) => r.trainFail >= 10 && (r.testFail > r.trainFail * 3 || r.testFail < r.trainFail / 3))) actions.push("Investigate rules whose fire rate shifted by more than 3×.");
  if (ruleRates.some((r) => r.testNe > 1)) actions.push("Investigate rules with a not-evaluable rate above 1%.");
  return {
    trainRows: trainParsed.rows.length, testRows: testParsed.rows.length,
    missingColumns: diffs(trainHeaders, testHeaders), extraColumns: diffs(testHeaders, trainHeaders),
    newTransactionTypes: diffsUpper("type"), newDepartments: diffsUpper("department"),
    newGrades: diffsUpper("grade"), newLocations: diffsUpper("location"), newCurrencies: diffsUpper("currency"),
    dateRange: { train: range(trainParsed), test: range(testParsed) },
    nullRateIncreases,
    duplicateIdRate: { train: Math.round(dupRate(trainParsed) * 1000) / 10, test: Math.round(dupRate(testParsed) * 1000) / 10 },
    ruleRates, actions,
  };
}

function differs(a: Set<string>, b: Set<string>): boolean {
  for (const v of a) if (!b.has(v)) return true;
  return false;
}

export function renderShiftMarkdown(report: ShiftReport): string {
  const lines = [
    "# Distribution-shift report",
    "",
    `Rows: train ${report.trainRows} · test ${report.testRows}`,
    `Date range: train ${report.dateRange.train.join(" → ")} · test ${report.dateRange.test.join(" → ")}`,
    `Missing columns: ${report.missingColumns.join(", ") || "none"}`,
    `New columns: ${report.extraColumns.join(", ") || "none"}`,
    `New types: ${report.newTransactionTypes.join(", ") || "none"}`,
    `New departments: ${report.newDepartments.join(", ") || "none"}`,
    `New grades: ${report.newGrades.join(", ") || "none"}`,
    `New currencies: ${report.newCurrencies.join(", ") || "none"}`,
    `Null-rate increases: ${report.nullRateIncreases.map((n) => `${n.column} ${n.train}%→${n.test}%`).join(", ") || "none"}`,
    `Duplicate-ID rate: train ${report.duplicateIdRate.train}% · test ${report.duplicateIdRate.test}%`,
    "",
    "| Rule | Train fail % | Test fail % | Train NE % | Test NE % |",
    "| --- | --- | --- | --- | --- |",
    ...report.ruleRates.map((r) => `| ${r.ruleId} | ${r.trainFail} | ${r.testFail} | ${r.trainNe} | ${r.testNe} |`),
    "",
    "## Actions",
    ...(report.actions.length ? report.actions.map((a) => `- ${a}`) : ["- None; the test file is within the training domain."]),
  ];
  return lines.join("\n") + "\n";
}

export { parseCsv, type Employee };
