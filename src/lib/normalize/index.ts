/**
 * Ingestion & normalisation (§8): sniff, parse (RFC 4180), header mapping via
 * synonyms, field normalisers, DQ codes DQ-001..DQ-018, quarantine.
 * Pure functions; the engine never sees raw strings.
 */

import { canonicalJson, sha256 } from "../domain/canonical";
import { parseAmount, normaliseDigits, type Fils } from "../domain/money";
import {
  inferDayMonthOrder, parseCellDate, parseTimestamp, instantToDubaiDate,
  type DayMonthOrder, type LocalDate,
} from "../domain/dates";
import { TXN_TYPES, DOCUMENT_TYPES, STATUSES, DEPARTMENT_SYNONYMS, GRADE_LADDER } from "../pack/config";
import type { Transaction, Employee, Approval, TxnDoc, DqCode, Caveat } from "../contracts";

// ── RFC 4180 CSV parsing ─────────────────────────────────────────────────────

export interface ParsedCsv { headers: string[]; rows: string[][] }

export function parseCsv(text: string, delimiter = ","): ParsedCsv {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;
  // strip BOM
  const s = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      cur.push(field); field = "";
    } else if (c === "\n") {
      cur.push(field); field = "";
      rows.push(cur); cur = [];
    } else if (c === "\r") {
      // skip; handled by \n
    } else field += c;
  }
  if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur); }
  // drop trailing blank lines
  while (rows.length && rows[rows.length - 1]!.every((f) => f.trim() === "")) rows.pop();
  const headers = rows.shift() ?? [];
  return { headers: headers.map((h) => h.trim()), rows };
}

/** Sniff delimiter from the first 64 KB (EC-A05). */
export function sniffDelimiter(text: string): string {
  const head = text.slice(0, 64_000);
  const candidates = [",", ";", "\t", "|"];
  let best = ",";
  let bestCount = -1;
  for (const d of candidates) {
    let count = 0;
    let inQuotes = false;
    for (const ch of head.split("\n")[0] ?? "") {
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === d && !inQuotes) count++;
    }
    if (count > bestCount) { bestCount = count; best = d; }
  }
  return best;
}

export function sniffEncoding(buffer: Uint8Array): "utf-8" | "utf-16" | "windows-1256" {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return "utf-16";
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return "utf-8";
  // Heuristic: high rate of nulls in even positions → UTF-16BE
  let nulls = 0;
  const n = Math.min(buffer.length, 1024);
  for (let i = 0; i < n; i += 2) if (buffer[i] === 0) nulls++;
  if (nulls > n / 4) return "utf-16";
  return "utf-8"; // Windows-1256 decoding is a documented adapter point (infra stub)
}

// ── Text normalisation ───────────────────────────────────────────────────────

const ZERO_WIDTH = /[\u200B\u200C\u200D\uFEFF\u00AD]/g;

export function normText(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null;
  let s = raw.normalize("NFKC").replace(ZERO_WIDTH, "").replace(/\s+/g, " ").trim();
  if (!s || ["N/A", "NA", "NULL", "-", "—"].includes(s.toUpperCase())) return null;
  return s;
}

/** Instruction-like free text → DQ-017 tag (EC-L05). Data, never instructions. */
export function isInstructionLike(s: string): boolean {
  return /ignore (all )?(previous|prior) instructions|disregard .{0,20}instructions|you are now|system prompt|mark (this|it) as pass/i.test(s);
}

export function canonicalTxnType(raw: string): { code: string; dq: DqCode | null } {
  const s = normText(raw)?.toUpperCase().replace(/[\s-]+/g, "_") ?? "";
  if (!s) return { code: "UNKNOWN", dq: "DQ-006" };
  for (const canon of TXN_TYPES.canonical) if (s === canon) return { code: canon, dq: null };
  for (const [canon, list] of Object.entries(TXN_TYPES.synonyms as Record<string, string[]>)) {
    if (canon === s || list.includes(s)) return { code: canon, dq: null };
  }
  return { code: "UNKNOWN", dq: "DQ-006" };
}

export function canonicalDocument(raw: string): { canonical: string | null; dq: DqCode | null } {
  const s = normText(raw)?.toUpperCase().replace(/[\s-]+/g, "_") ?? "";
  if (!s) return { canonical: null, dq: "DQ-001" };
  if (DOCUMENT_TYPES.canonical.includes(s)) return { canonical: s, dq: null };
  for (const [canon, list] of Object.entries(DOCUMENT_TYPES.synonyms as Record<string, string[]>)) {
    if (list.includes(s) || canon === s) return { canonical: canon, dq: null };
  }
  return { canonical: null, dq: "DQ-007" };
}

export function canonicalStatus(raw: string): { status: Employee["status"]; dq: DqCode | null } {
  const s = normText(raw)?.toUpperCase().replace(/[\s-]+/g, "_") ?? "";
  if (!s) return { status: "UNKNOWN", dq: "DQ-001" };
  if ((STATUSES.canonical as string[]).includes(s)) return { status: s as Employee["status"], dq: null };
  for (const [canon, list] of Object.entries(STATUSES.synonyms as Record<string, string[]>)) {
    if (list.includes(s) || canon === s) return { status: canon as Employee["status"], dq: null };
  }
  return { status: "UNKNOWN", dq: "DQ-016" };
}

export function canonicalDepartment(raw: string): string | null {
  const s = normText(raw);
  if (!s) return null;
  for (const [canon, list] of Object.entries(DEPARTMENT_SYNONYMS.synonyms as Record<string, string[]>)) {
    if (list.includes(s) || canon === s) return canon;
  }
  return s; // unmapped names are kept; detection unaffected; routing falls back (EC-C12)
}

/**
 * ID canonicalisation (EC-B10): uppercase, strip separators; leading-zero padding
 * is preserved because the E##### pattern is part of identity in this tenant.
 * Bare numbers are kept as-is and would be flagged DQ-014 by the collision check
 * (tenant ID-pattern configuration is an integration point — see docs/DEVIATIONS.md).
 */
export function canonicalId(raw: string): string {
  const s = normText(raw) ?? "";
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function gradeOrdinal(raw: string | null | undefined): { ordinal: number | null; dq: DqCode | null } {
  const s = normText(raw);
  if (!s) return { ordinal: null, dq: null };
  const found = GRADE_LADDER.grades.find((g) => g.grade === s);
  if (found) return { ordinal: found.ordinal, dq: null };
  return { ordinal: null, dq: "DQ-011" };
}

/** Boolean variants (EC-B15). */
export function parseBoolean(raw: string): boolean | null {
  const s = normText(raw)?.toUpperCase() ?? "";
  if (["Y", "YES", "TRUE", "1", "نعم"].includes(s)) return true;
  if (["N", "NO", "FALSE", "0", "لا"].includes(s)) return false;
  return null;
}

// ── Dataset ingestion: transactions ─────────────────────────────────────────

export interface IngestIssues {
  quarantined: { rowNumber: number; dq: DqCode; reason: string }[];
  dqByRow: Record<number, DqCode[]>;
  dateOrderDefaulted: boolean;
}

const REQUIRED_TXN_COLUMNS = ["txn_id", "type", "employee_id", "effective_date"];

/**
 * Normalise a transactions CSV into domain Transactions.
 * Header-driven mapping through synonyms; missing required columns → MZ-DS-422 upstream.
 */
export function normaliseTransactions(csv: ParsedCsv, datasetId: string, issues: IngestIssues): Transaction[] {
  const headers = csv.headers.map((h) => h.toLowerCase().replace(/[\s-]+/g, "_"));
  const idx = (names: string[]): number => {
    for (const n of names) {
      const i = headers.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const col = {
    txnId: idx(["txn_id", "transaction_id", "txn"]),
    type: idx(["type", "txn_type", "transaction_type"]),
    employeeId: idx(["employee_id", "emp_id", "employee"]),
    grade: idx(["grade"]),
    department: idx(["department", "dept"]),
    location: idx(["location", "site"]),
    amount: idx(["amount", "amount_aed", "value"]),
    currency: idx(["currency"]),
    amountSemantics: idx(["amount_semantics", "semantics"]),
    effectiveDate: idx(["effective_date", "eff_date"]),
    submittedAt: idx(["submitted_at", "submitted", "submission_time"]),
    requesterId: idx(["requester_id", "requested_by"]),
    approverIds: idx(["approver_ids", "approvers", "approver_id"]),
    approverGrades: idx(["approver_grades"]),
    approverTimes: idx(["approver_times", "approval_times"]),
    approverRoles: idx(["approver_roles"]),
    documents: idx(["documents", "attachments", "docs"]),
    receivingManagerId: idx(["receiving_manager_id", "receiving_manager"]),
    fromDepartment: idx(["from_department", "origin_department"]),
    reversalOf: idx(["reversal_of", "reverses"]),
    comment: idx(["comment", "notes", "free_text"]),
  };
  const missing = REQUIRED_TXN_COLUMNS.filter((c) => col[c === "txn_id" ? "txnId" : c === "type" ? "type" : c === "employee_id" ? "employeeId" : "effectiveDate"] < 0);
  if (missing.length) throw Object.assign(new Error(`required columns missing: ${missing.join(", ")}`), { code: "MZ-DS-422" });

  const cell = (row: string[], i: number): string | null => (i >= 0 ? normText(row[i] ?? "") : null);
  const cellRaw = (row: string[], i: number): string => (i >= 0 ? (row[i] ?? "").trim() : "");

  // Day-month order inference per column (EC-B01)
  const effOrder: InferredOrder = inferColumnOrder(csv, col.effectiveDate);

  // Duplicate txn IDs with different content (EC-H02)
  const seenIds = new Map<string, string>(); // txnId → rowHash
  const out: Transaction[] = [];
  let quarantinedCount = 0;

  csv.rows.forEach((row, iRow) => {
    const rowNumber = iRow + 2; // 1-based with header
    const dq: DqCode[] = [];
    const caveats: Caveat[] = [];
    const txnIdRaw = cell(row, col.txnId);
    if (!txnIdRaw) {
      issues.quarantined.push({ rowNumber, dq: "DQ-001", reason: "missing txn_id" });
      quarantinedCount++;
      return;
    }
    if ((row.length > 0 && row.some((f) => (f ?? "").length > 32_000))) {
      issues.quarantined.push({ rowNumber, dq: "DQ-018", reason: "field larger than 32 KB" });
      quarantinedCount++;
      return;
    }
    const typeRes = canonicalTxnType(cellRaw(row, col.type));
    if (typeRes.dq) dq.push(typeRes.dq);

    // amount
    let amountFils: Fils | null = null;
    const amountRaw = cellRaw(row, col.amount);
    if (amountRaw) {
      const parsed = parseAmount(amountRaw, "dot");
      if (parsed.dq) dq.push(parsed.dq);
      amountFils = parsed.fils;
    }
    const currency = cell(row, col.currency);
    if (currency && currency.toUpperCase() !== "AED") dq.push("DQ-009");

    // effective date
    let effectiveDate: LocalDate | null = null;
    const effRaw = cellRaw(row, col.effectiveDate);
    if (effRaw) {
      effectiveDate = parseCellDate(effRaw, effOrder.order);
      if (!effectiveDate) dq.push("DQ-002");
      else if (effOrder.defaulted && /[/.\-]/.test(effRaw) && !/^\d{4}-/.test(effRaw)) {
        dq.push("DQ-003");
        caveats.push({ code: "DEFAULT_DATE_ORDER", message: { en: "Day-month order was resolved by default (day first).", ar: "تم تحديد ترتيب اليوم والشهر افتراضياً (اليوم أولاً)." }, facts: [effRaw] });
      }
    } else dq.push("DQ-001");

    // submitted timestamp
    let submittedAt: string | null = null;
    let submittedPrecision: Transaction["submittedPrecision"] = null;
    const subRaw = cellRaw(row, col.submittedAt);
    if (subRaw) {
      const parsedTs = parseTimestamp(subRaw);
      if (parsedTs) { submittedAt = parsedTs.instant; submittedPrecision = parsedTs.precision; }
      else dq.push("DQ-002");
    }

    // approvers: split on ; , | (EC-B12)
    const approverIdsRaw = cellRaw(row, col.approverIds);
    const approvalsCol = col.approverIds >= 0;
    let approvals: Approval[] | null = null;
    if (approvalsCol) {
      approvals = approverIdsRaw
        ? approverIdsRaw.split(/[;,|]/).map((s) => s.trim()).filter(Boolean).map((s, k) => {
            const times = cellRaw(row, col.approverTimes).split(/[;,|]/).map((x) => x.trim());
            const grades = cellRaw(row, col.approverGrades).split(/[;,|]/).map((x) => x.trim());
            const roles = cellRaw(row, col.approverRoles).split(/[;,|]/).map((x) => x.trim());
            const tRaw = times[k] ?? "";
            const t = tRaw ? parseTimestamp(tRaw) : null;
            return {
              approverId: canonicalId(s),
              position: k,
              approvedAt: t?.instant ?? null,
              precision: t?.precision ?? ("none" as const),
              role: roles[k] || null,
              gradeRaw: grades[k] || null,
              delegateFor: null,
            };
          })
        : [];
    }

    // documents (EC-E02)
    const docsCol = col.documents >= 0;
    let documents: TxnDoc[] | null = null;
    if (docsCol) {
      const docsRaw = cellRaw(row, col.documents);
      documents = docsRaw
        ? docsRaw.split(/[;,|]/).map((s) => s.trim()).filter(Boolean).map((s) => {
            const res = canonicalDocument(s);
            if (res.dq === "DQ-007") {
              caveats.push({ code: "UNRECOGNISED_ATTACHMENT", message: { en: `1 unrecognised attachment: "${s}"`, ar: `مرفق غير معروف: "${s}"` }, facts: [s] });
              dq.push("DQ-007");
            }
            return { raw: s, canonical: res.canonical };
          })
        : [];
    }

    // free text: quoted data only; instruction-like → DQ-017 (FS-15)
    const comment = cellRaw(row, col.comment);
    const freeText: Record<string, string> = comment ? { comment } : {};
    if (comment && isInstructionLike(comment)) dq.push("DQ-017");

    const employeeId = canonicalId(cellRaw(row, col.employeeId));
    if (!employeeId) dq.push("DQ-001");

    const passthrough: Record<string, string> = {};
    if (col.receivingManagerId >= 0 && cellRaw(row, col.receivingManagerId)) passthrough.receiving_manager_id = canonicalId(cellRaw(row, col.receivingManagerId));
    if (col.fromDepartment >= 0 && cellRaw(row, col.fromDepartment)) passthrough.from_department = cellRaw(row, col.fromDepartment) ?? "";
    if (col.reversalOf >= 0 && cellRaw(row, col.reversalOf)) passthrough.reversal_of = cellRaw(row, col.reversalOf) ?? "";

    const rowHash = sha256(canonicalJson(row));
    const txnId = txnIdRaw;
    const dup = seenIds.get(txnId);
    let rowId = txnId;
    if (dup !== undefined) {
      if (dup !== rowHash) {
        dq.push("DQ-008");
        const n = out.filter((t) => t.txnId === txnId).length + 1;
        rowId = `${txnId}#${n}`;
      } else {
        caveats.push({ code: "DUPLICATE_ID", message: { en: "Duplicate transaction row with identical content was evaluated once.", ar: "تم تقييم صف مكرر بمحتوى مطابق مرة واحدة." }, facts: [txnId] });
        return; // identical content → evaluate once (EC-H01)
      }
    } else seenIds.set(txnId, rowHash);

    issues.dqByRow[rowNumber] = dq;
    out.push({
      rowId, txnId, type: typeRes.code, typeRaw: cellRaw(row, col.type) || "UNKNOWN",
      employeeId,
      gradeRaw: cell(row, col.grade),
      department: canonicalDepartment(cellRaw(row, col.department)),
      location: cell(row, col.location),
      amountFils, currency, amountSemantics: (cell(row, col.amountSemantics) as Transaction["amountSemantics"]) ?? (amountFils === null ? "unknown" : "delta"),
      effectiveDate, submittedAt, submittedPrecision, requesterId: cell(row, col.requesterId) ? canonicalId(cellRaw(row, col.requesterId)) : null,
      approvals, documents, reversalOf: passthrough.reversal_of ?? null,
      freeText, passthrough,
      source: { datasetId, rowNumber, rowHash },
      dq: [...new Set(dq)],
      caveats,
    });
  });
  issues.dateOrderDefaulted = effOrder.defaulted;
  return out;
}

interface InferredOrder { order: DayMonthOrder; defaulted: boolean }

function inferColumnOrder(csv: ParsedCsv, colIdx: number): InferredOrder {
  if (colIdx < 0) return { order: "day_month", defaulted: false };
  const values = csv.rows.map((r) => r[colIdx] ?? "");
  const inferred = inferDayMonthOrder(values);
  return { order: inferred.order, defaulted: inferred.defaulted };
}

// ── Dataset ingestion: employees ─────────────────────────────────────────────

export function normaliseEmployees(csv: ParsedCsv, datasetId: string): { employees: Employee[]; issues: IngestIssues } {
  const headers = csv.headers.map((h) => h.toLowerCase().replace(/[\s-]+/g, "_"));
  const idx = (names: string[]): number => {
    for (const n of names) { const i = headers.indexOf(n); if (i >= 0) return i; }
    return -1;
  };
  const col = {
    id: idx(["employee_id", "emp_id", "employee"]),
    grade: idx(["grade"]),
    department: idx(["department", "dept"]),
    location: idx(["location"]),
    managerId: idx(["manager_id", "manager"]),
    hireDate: idx(["hire_date", "hiring_date"]),
    exitDate: idx(["exit_date", "leaving_date"]),
    status: idx(["status"]),
    nationality: idx(["nationality"]),
    roles: idx(["roles", "role"]),
    baseSalary: idx(["base_salary", "salary"]),
  };
  const issues: IngestIssues = { quarantined: [], dqByRow: {}, dateOrderDefaulted: false };
  const employees: Employee[] = [];
  csv.rows.forEach((row, iRow) => {
    const rowNumber = iRow + 2;
    const id = canonicalId(row[col.id] ?? "");
    if (!id) { issues.quarantined.push({ rowNumber, dq: "DQ-001", reason: "missing employee_id" }); return; }
    const statusRes = canonicalStatus(row[col.status] ?? "");
    const gradeRes = gradeOrdinal(row[col.grade] ?? null);
    const hireRaw = (row[col.hireDate] ?? "").trim();
    const exitRaw = (row[col.exitDate] ?? "").trim();
    const hire = hireRaw ? parseCellDate(hireRaw, "day_month") : null;
    const exit = exitRaw ? parseCellDate(exitRaw, "day_month") : null;
    const spells = [{ from: hire ?? "1900-01-01", to: exit }];
    const rolesRaw = (row[col.roles] ?? "").trim();
    employees.push({
      employeeId: id,
      gradeRaw: normText(row[col.grade] ?? null),
      gradeOrdinal: gradeRes.ordinal,
      department: canonicalDepartment(row[col.department] ?? ""),
      location: normText(row[col.location] ?? null),
      managerId: (row[col.managerId] ?? "").trim() ? canonicalId(row[col.managerId] ?? "") : null,
      hireDate: hire, exitDate: exit,
      statusRaw: normText(row[col.status] ?? null),
      status: statusRes.status,
      roles: rolesRaw ? rolesRaw.split(/[;,|]/).map((s) => s.trim()).filter(Boolean) : [],
      spells,
      attributes: { nationality: normText(row[col.nationality] ?? null) ?? "", baseSalaryFils: (() => { const p = parseAmount(row[col.baseSalary] ?? "", "dot"); return p.fils === null ? "" : String(p.fils); })() },
    });
    if (statusRes.dq) issues.dqByRow[rowNumber] = [statusRes.dq];
  });
  return { employees, issues };
}

export { instantToDubaiDate, normaliseDigits };
