/**
 * finding_format.csv — the official findings format with 5 worked examples (§7/FS-20).
 * The exporter learns the profile from here; the validator reproduces the 5 rows
 * exactly on every scored column before export is enabled.
 */

import { canonicalJson, sha256 } from "../domain/canonical";

export interface ExportProfile {
  version: string;
  columns: { header: string; source: string; scored: boolean }[];
  enums: Record<string, Record<string, string>>;
  idFormat: string;
  dateFormat: string;
  delimiter: string;
  encoding: string;
  lineEnding: string;
  quoteStyle: string;
  sortBy: string[];
  goldenRows: Record<string, string>[];
}

export const FINDING_FORMAT_VERSION = "finding_format-1.0.0";

/** Columns generated at export time (never compared to the golden rows). */
export const GENERATED_COLUMNS = ["finding_id", "run_date"];

export const EXPORT_PROFILE: ExportProfile = {
  version: FINDING_FORMAT_VERSION,
  columns: [
    { header: "finding_id", source: "finding_id", scored: false },
    { header: "transaction_id", source: "txnId", scored: true },
    { header: "rule_id", source: "ruleId", scored: true },
    { header: "rule_version", source: "ruleVersion", scored: true },
    { header: "clause_id", source: "clauseId", scored: true },
    { header: "severity", source: "severity", scored: true },
    { header: "headline", source: "headlineEn", scored: true },
    { header: "what_broke", source: "whatBrokeEn", scored: true },
    { header: "why_it_matters", source: "whyItMattersEn", scored: true },
    { header: "corrective_action", source: "actionEn", scored: true },
    { header: "owner_team", source: "ownerTeam", scored: true },
    { header: "evidence", source: "evidenceJson", scored: false },
    { header: "run_date", source: "runDate", scored: false },
  ],
  enums: {
    severity: { CRITICAL: "CRITICAL", HIGH: "HIGH", MEDIUM: "MEDIUM", LOW: "LOW" },
  },
  idFormat: "F-CCCCCCCCCCCC", // Crockford base32, 12 chars
  dateFormat: "YYYY-MM-DD",
  delimiter: ",",
  encoding: "UTF-8",
  lineEnding: "CRLF",
  quoteStyle: "minimal (RFC 4180)",
  sortBy: ["rule_id", "transaction_id", "clause_id"],
  // The 5 worked examples. The engine must reproduce every scored column exactly (FS-20).
  goldenRows: [
    {
      finding_id: "F-WX0000000001",
      transaction_id: "WX-1001",
      rule_id: "R04",
      rule_version: "1.0.0",
      clause_id: "C1",
      severity: "HIGH",
      headline: "Allowance change approved below the required grade",
      what_broke: "This AED 14,500.00 allowance change for employee E01234 was approved only by E00987, who is grade 11. Rule R04 requires an approver at grade 13 or above for allowance changes above AED 10,000.00.",
      why_it_matters: "Approval limits make sure large pay commitments are checked by someone with authority over that budget.",
      corrective_action: "Obtain retrospective approval from an approver at grade 13 or above and attach it; if refused, raise a reversal before the next payroll cut-off",
      owner_team: "Compensation & Payroll Operations",
      evidence: '{"amount_fils":1450000,"approver_id":"E00987","approver_grade":11,"required_grade":13,"threshold_fils":1000000}',
      run_date: "2026-04-01",
    },
    {
      finding_id: "F-WX0000000002",
      transaction_id: "WX-1002",
      rule_id: "R06",
      rule_version: "1.0.0",
      clause_id: "C1",
      severity: "HIGH",
      headline: "Requester approved their own transaction",
      what_broke: "Transaction WX-1002 for employee E02345 was requested by E00311 and approved by E00311. Rule R06 does not allow the requester to approve a transaction.",
      why_it_matters: "Segregation of duties makes sure no single person controls a transaction from start to finish.",
      corrective_action: "Have an independent approver, not E00311, re-review the transaction; review all transactions E00311 approved for the same team in the last 90 days",
      owner_team: "Compensation & Payroll Operations",
      evidence: '{"requester_id":"E00311","approver_id":"E00311","employee_id":"E02345"}',
      run_date: "2026-04-01",
    },
    {
      finding_id: "F-WX0000000003",
      transaction_id: "WX-1003",
      rule_id: "R09",
      rule_version: "1.0.0",
      clause_id: "C1",
      severity: "CRITICAL",
      headline: "Pay change processed for an employee who had left",
      what_broke: "Employee E04567 had an exit date of 2026-02-28, but transaction WX-1003 changed pay by AED 8,200.00 with an effective date of 2026-03-10.",
      why_it_matters: "Paying someone who has left the company can create overpayments that are hard to recover.",
      corrective_action: "Hold any pending payment linked to the transaction, confirm employment status and recover any overpayment under policy",
      owner_team: "Compensation & Payroll Operations",
      evidence: '{"employee_id":"E04567","exit_date":"2026-02-28","effective_date":"2026-03-10","amount_fils":820000}',
      run_date: "2026-04-01",
    },
    {
      finding_id: "F-WX0000000004",
      transaction_id: "WX-1004",
      rule_id: "R08",
      rule_version: "1.0.0",
      clause_id: "C1",
      severity: "MEDIUM",
      headline: "Transaction backdated by 45 days",
      what_broke: "Transaction WX-1004 for employee E05678 has an effective date of 2026-02-10 but was submitted on 2026-03-27, which is 45 days later.",
      why_it_matters: "Backdated transactions can hide when a decision was really made and affect the correct pay period.",
      corrective_action: "Record the business justification for backdating by 45 days and obtain the policy owner's sign-off; check whether payroll for the period needs adjustment",
      owner_team: "Leave & Attendance Operations",
      evidence: '{"effective_date":"2026-02-10","submitted_date":"2026-03-27","backdated_days":45,"max_days":30}',
      run_date: "2026-04-01",
    },
    {
      finding_id: "F-WX0000000005",
      transaction_id: "WX-1006",
      rule_id: "R11",
      rule_version: "1.0.0",
      clause_id: "C1",
      severity: "HIGH",
      headline: "Possible duplicate allowance change within 3 days",
      what_broke: "Transaction WX-1006 for employee E06789 is an allowance change of AED 3,000.00 effective 2026-03-04, which repeats WX-1005 of AED 3,000.00 effective 2026-03-02.",
      why_it_matters: "Duplicate entries can pay the same change twice.",
      corrective_action: "Confirm whether WX-1005 and WX-1006 are the same change and cancel the duplicate before the next payroll cut-off",
      owner_team: "Compensation & Payroll Operations",
      evidence: '{"txn_a":"WX-1005","txn_b":"WX-1006","employee_id":"E06789","amount_fils":300000,"days_apart":2}',
      run_date: "2026-04-01",
    },
  ],
};

export function findingFormatSha256(): string {
  return sha256(canonicalJson(EXPORT_PROFILE));
}

/** Render finding_format.csv exactly as shipped in data/pack/. */
export function renderFindingFormatCsv(): string {
  const header = EXPORT_PROFILE.columns.map((c) => c.header).join(",");
  const rows = EXPORT_PROFILE.goldenRows.map((r) =>
    EXPORT_PROFILE.columns.map((c) => csvCell(r[c.header] ?? "")).join(",")
  );
  return [header, ...rows].join("\r\n") + "\r\n";
}

/**
 * RFC 4180 quoting plus formula-injection neutralisation: a cell that starts
 * with = + - @ is prefixed with an apostrophe before quoting (§26).
 */
export function csvCell(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  if (/[",\r\n]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}
