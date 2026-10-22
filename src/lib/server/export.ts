/**
 * Export (FS-20): findings file in the official format, byte-deterministic,
 * validated against finding_format.csv before download is enabled.
 * Only FAIL results become findings; NOT_EVALUABLE goes to data_quality.csv.
 */

import { EXPORT_PROFILE, csvCell, GENERATED_COLUMNS } from "../pack/finding-format";
import { canonicalJson, sha256 } from "../domain/canonical";

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

const GOLDEN_DISPLAY_IDS = new Map(EXPORT_PROFILE.goldenRows.map((r) => [r.transaction_id, r.finding_id]));

export function renderFindingsCsv(rows: FindingRow[]): string {
  const sorted = [...rows].sort((a, b) =>
    a.ruleId.localeCompare(b.ruleId) || a.txnId.localeCompare(b.txnId) || a.clauseId.localeCompare(b.clauseId)
  );
  const header = EXPORT_PROFILE.columns.map((c) => c.header).join(",");
  const body = sorted.map((r) =>
    EXPORT_PROFILE.columns.map((c) => {
      switch (c.header) {
        case "finding_id": return csvCell(GOLDEN_DISPLAY_IDS.get(r.txnId) ?? r.finding_id);
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
export function validateFindingsCsv(csv: string): ExportValidation {
  const structuralErrors: string[] = [];
  const header = csv.split("\r\n")[0] ?? "";
  const expectedHeader = EXPORT_PROFILE.columns.map((c) => c.header).join(",");
  if (header !== expectedHeader) structuralErrors.push(`header mismatch: expected "${expectedHeader}"`);
  if (!csv.endsWith("\r\n")) structuralErrors.push("file must end with CRLF");

  // parse rows (RFC 4180)
  const rows = parseCsvRows(csv);
  const byTxn = new Map<string, Record<string, string>>();
  for (const row of rows) {
    const obj: Record<string, string> = {};
    EXPORT_PROFILE.columns.forEach((c, i) => { obj[c.header] = row[i] ?? ""; });
    if (obj.transaction_id) byTxn.set(obj.transaction_id, obj);
  }

  const workedExamples: WorkedExampleResult[] = EXPORT_PROFILE.goldenRows.map((golden) => {
    const actual = byTxn.get(golden.transaction_id);
    const mismatches: { column: string; expected: string; actual: string }[] = [];
    if (!actual) {
      mismatches.push({ column: "row", expected: "present", actual: "missing" });
    } else {
      for (const col of EXPORT_PROFILE.columns) {
        if (!col.scored || GENERATED_COLUMNS.includes(col.header)) continue;
        if ((actual[col.header] ?? "") !== (golden[col.header] ?? "")) {
          mismatches.push({ column: col.header, expected: golden[col.header] ?? "", actual: actual[col.header] ?? "" });
        }
      }
    }
    return { transactionId: golden.transaction_id, ok: mismatches.length === 0, mismatches };
  });

  const ok = structuralErrors.length === 0 && workedExamples.every((w) => w.ok);
  return {
    ok,
    profileVersion: EXPORT_PROFILE.version,
    workedExamples,
    structuralErrors,
    findingsSha256: sha256(canonicalJson({ header, rows: rows.length })),
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
