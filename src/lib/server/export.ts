/**
 * Export (FS-20): findings file in the official format, byte-deterministic,
 * validated against finding_format.csv before download is enabled.
 * Only FAIL results become findings; NOT_EVALUABLE goes to data_quality.csv.
 */

import { EXPORT_PROFILE, csvCell, GENERATED_COLUMNS } from "../pack/finding-format";
import { sha256 } from "../domain/canonical";
import { cmpStr } from "../domain/dates";

export interface FindingRow {
  finding_id: string;
  txnId: string;
  ruleId: string;
  ruleVersion: string;
  clauseId: string;
  severity: string;
  headlineEn: string;
  whatBrokeEn: string;
  whyItMattersEn: string;
  actionEn: string;
  ownerTeam: string;
  evidenceJson: string;
  runDate: string;
}

export interface DqRow {
  txnId: string;
  dqCode: string;
  message: string;
  rowNumber: number;
}

const DQ_MESSAGES: Record<string, string> = {
  "DQ-001": "Required field missing",
  "DQ-002": "Unparseable date",
  "DQ-003": "Day-month order resolved by default",
  "DQ-004": "Employee not in the master data",
  "DQ-005": "Approver not in the master data",
  "DQ-006": "Unknown transaction type",
  "DQ-007": "Unknown document type",
  "DQ-008": "Duplicate transaction ID with different content",
  "DQ-009": "Currency other than AED",
  "DQ-010": "Management-chain cycle",
  "DQ-011": "Grade not on the ladder",
  "DQ-013": "Amount ambiguous or out of bounds",
  "DQ-016": "Status value not mapped",
  "DQ-017": "Instruction-like text in a free-text field",
  "DQ-018": "Field or line exceeds size limits",
};

export function dqMessage(dq: string): string {
  return DQ_MESSAGES[dq] ?? dq;
}

const goldenKey = (r: { transaction_id?: string; rule_id?: string; clause_id?: string }): string => `${r.transaction_id ?? ""}|${r.rule_id ?? ""}|${r.clause_id ?? ""}`;
const GOLDEN_DISPLAY_IDS = new Map(EXPORT_PROFILE.goldenRows.map((r) => [goldenKey(r), r.finding_id]));

export function renderFindingsCsv(rows: FindingRow[]): string {
  const sorted = [...rows].sort((a, b) =>
    cmpStr(a.ruleId, b.ruleId) || cmpStr(a.txnId, b.txnId) || cmpStr(a.clauseId, b.clauseId)
  );
  const header = EXPORT_PROFILE.columns.map((c) => c.header).join(",");
  const body = sorted.map((r) =>
    EXPORT_PROFILE.columns.map((c) => {
      switch (c.header) {
        case "finding_id": return csvCell(GOLDEN_DISPLAY_IDS.get(goldenKey({ transaction_id: r.txnId, rule_id: r.ruleId, clause_id: r.clauseId })) ?? r.finding_id);
        case "transaction_id": return csvCell(r.txnId);
        case "rule_id": return csvCell(r.ruleId);
        case "rule_version": return csvCell(r.ruleVersion);
        case "clause_id": return csvCell(r.clauseId);
        case "severity": return csvCell(r.severity);
        case "headline": return csvCell(r.headlineEn);
        case "what_broke": return csvCell(r.whatBrokeEn);
        case "why_it_matters": return csvCell(r.whyItMattersEn);
        case "corrective_action": return csvCell(r.actionEn);
        case "owner_team": return csvCell(r.ownerTeam);
        case "evidence": return csvCell(r.evidenceJson);
        case "run_date": return csvCell(r.runDate);
        default: return "";
      }
    }).join(",")
  );
  // CRLF per profile
  return [header, ...body].join("\r\n") + "\r\n";
}

export function renderDataQualityCsv(rows: DqRow[]): string {
  const header = "transaction_id,dq_code,message,row_number";
  const body = [...rows].sort((a, b) => a.txnId.localeCompare(b.txnId) || a.dqCode.localeCompare(b.dqCode))
    .map((r) => [r.txnId, r.dqCode, r.message, String(r.rowNumber)].map(csvCell).join(","));
  return [header, ...body].join("\r\n") + "\r\n";
}

// ── Validator (FS-20) ────────────────────────────────────────────────────────

export interface WorkedExampleResult {
  transactionId: string;
  ok: boolean;
  mismatches: { column: string; expected: string; actual: string }[];
}

export interface ExportValidation {
  ok: boolean;
  goldenChecked: boolean;
  profileVersion: string;
  workedExamples: WorkedExampleResult[];
  structuralErrors: string[];
  findingsSha256: string;
  checkedAt: string;
}

/**
 * Validate a findings CSV against the profile:
 * 1. structural pass — header exact, RFC 4180 round-trip, row count;
 * 2. worked-example pass — the 5 golden rows reproduced exactly on every scored column.
 */
export function validateFindingsCsv(csv: string, opts: { requireGolden?: boolean } = {}): ExportValidation {
  const structuralErrors: string[] = [];
  const header = csv.split("\r\n")[0] ?? "";
  const expectedHeader = EXPORT_PROFILE.columns.map((c) => c.header).join(",");
  if (header !== expectedHeader) structuralErrors.push(`header mismatch: expected "${expectedHeader}"`);
  if (!csv.endsWith("\r\n")) structuralErrors.push("file must end with CRLF");
  const rows = parseCsvRows(csv);
  if (!rows.length) structuralErrors.push("file has no header row");
  const dataRows = rows.slice(1);
  const byKey = new Map<string, Record<string, string>[]>();
  const seenFindingIds = new Set<string>();

  for (const [index, row] of dataRows.entries()) {
    if (row.length !== EXPORT_PROFILE.columns.length) {
      structuralErrors.push(`row ${index + 2} has ${row.length} columns; expected ${EXPORT_PROFILE.columns.length}`);
      continue;
    }
    const obj: Record<string, string> = {};
    EXPORT_PROFILE.columns.forEach((c, i) => { obj[c.header] = row[i] ?? ""; });
    const key = goldenKey({ transaction_id: obj.transaction_id ?? "", rule_id: obj.rule_id ?? "", clause_id: obj.clause_id ?? "" });
    const list = byKey.get(key) ?? [];
    list.push(obj);
    byKey.set(key, list);
    if (seenFindingIds.has(obj.finding_id ?? "")) structuralErrors.push(`row ${index + 2}: duplicate finding_id ${obj.finding_id}`);
    seenFindingIds.add(obj.finding_id ?? "");
    if (!obj.transaction_id) structuralErrors.push(`row ${index + 2}: transaction_id is empty`);
    if (!/^R[0-9]{2}$/.test(obj.rule_id ?? "")) structuralErrors.push(`row ${index + 2}: rule_id "${obj.rule_id}" is not Rnn`);
    if (!/^C[0-9]+$/.test(obj.clause_id ?? "")) structuralErrors.push(`row ${index + 2}: clause_id "${obj.clause_id}" is not Cnn`);
    if (!["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(obj.severity ?? "")) structuralErrors.push(`row ${index + 2}: severity "${obj.severity}" is not an enum value`);
    if (!/^F-[A-Z0-9]{12}$/.test(obj.finding_id ?? "")) structuralErrors.push(`row ${index + 2}: finding_id "${obj.finding_id}" does not match F-CCCCCCCCCCCC`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(obj.run_date ?? "")) structuralErrors.push(`row ${index + 2}: run_date "${obj.run_date}" is not YYYY-MM-DD`);
    for (const required of ["rule_version", "headline", "what_broke", "why_it_matters", "corrective_action", "owner_team"]) {
      if (!obj[required]) structuralErrors.push(`row ${index + 2}: ${required} is empty`);
    }
  }

  const requireGolden = opts.requireGolden ?? true;
  const workedExamples: WorkedExampleResult[] = !requireGolden ? [] : EXPORT_PROFILE.goldenRows.map((golden) => {
    const matches = byKey.get(goldenKey({ transaction_id: golden.transaction_id, rule_id: golden.rule_id, clause_id: golden.clause_id })) ?? [];
    const mismatches: { column: string; expected: string; actual: string }[] = [];
    if (!matches.length) {
      mismatches.push({ column: "row", expected: "present", actual: "missing" });
    } else if (matches.length > 1) {
      mismatches.push({ column: "row", expected: "exactly one row", actual: `${matches.length} rows` });
    } else {
      const actual = matches[0]!;
      for (const col of EXPORT_PROFILE.columns) {
        if (!col.scored || GENERATED_COLUMNS.includes(col.header)) continue;
        if ((actual[col.header] ?? "") !== (golden[col.header] ?? "")) {
          mismatches.push({ column: col.header, expected: golden[col.header] ?? "", actual: actual[col.header] ?? "" });
        }
      }
    }
    return { transactionId: golden.transaction_id, ok: mismatches.length === 0, mismatches };
  });

  const ok = structuralErrors.length === 0 && (!requireGolden || workedExamples.every((w) => w.ok));
  return {
    ok,
    goldenChecked: requireGolden,
    profileVersion: EXPORT_PROFILE.version,
    workedExamples,
    structuralErrors,
    findingsSha256: sha256(csv),
    checkedAt: new Date().toISOString(),
  };
}

export function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;
  const s = csv.replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { cur.push(field); field = ""; }
    else if (c === "\r") { /* skip */ }
    else if (c === "\n") { cur.push(field); field = ""; rows.push(cur); cur = []; }
    else field += c;
  }
  if (field || cur.length) { cur.push(field); rows.push(cur); }
  return rows;
}

/** Formula-injection guard (§26): cells starting with = + - @ are escaped with '. */
export function escapeFormulaCells(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}
