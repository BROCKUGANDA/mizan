/**
 * Ingestion & normalisation (§8): sniff, parse (RFC 4180), header mapping via
 * synonyms, field normalisers, DQ codes DQ-001..DQ-018, quarantine.
 * Pure functions; the engine never sees raw strings.
 */

import { canonicalJson, sha256 } from "../domain/canonical";
import { parseAmount, normaliseDigits, inferDecimalConvention, type Fils } from "../domain/money";
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

export function sniffEncoding(buffer: Uint8Array): "utf-8" | "utf-16le" | "utf-16be" | "windows-1256" {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return "utf-16le";
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return "utf-16be";
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return "utf-8";
  // High rate of nulls in even positions → UTF-16BE; in odd positions → UTF-16LE.
  let evenNulls = 0;
  let oddNulls = 0;
  const n = Math.min(buffer.length, 2048);
  for (let i = 0; i + 1 < n; i += 2) {
    if (buffer[i] === 0) evenNulls++;
    if (buffer[i + 1] === 0) oddNulls++;
  }
  if (evenNulls > n / 8) return "utf-16be";
  if (oddNulls > n / 8) return "utf-16le";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return "utf-8";
  } catch {
    return "windows-1256";
  }
}

/** Decode an uploaded file, honouring BOMs and falling back to Windows-1256 (EC-A04). */
export function decodeCsv(buffer: Uint8Array): { text: string; encoding: string } {
  const encoding = sniffEncoding(buffer);
  if (encoding === "utf-16be") {
    const swapped = new Uint8Array(buffer.length);
    for (let i = 0; i + 1 < buffer.length; i += 2) { swapped[i] = buffer[i + 1]!; swapped[i + 1] = buffer[i]!; }
    return { text: new TextDecoder("utf-16le").decode(swapped), encoding };
  }
  return { text: new TextDecoder(encoding).decode(buffer), encoding };
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
  const withoutExtension = normText(raw)?.replace(/\.[A-Za-z0-9]{1,8}$/, "") ?? "";
  const s = withoutExtension.toUpperCase().replace(/[\s\-.]+/g, "_").replace(/^_+|_+$/g, "");
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
  // Arabic-Indic/Persian digits are digits, not illegal characters (EC-B06).
  const s = normaliseDigits(normText(raw) ?? "");
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

const REQUIRED_TXN_COLUMNS = ["txnId", "type", "employeeId", "effectiveDate"];

const TXN_HEADER_ALIASES: Record<string, string[]> = {
  txnId: ["txn_id", "transaction_id", "txn"],
  type: ["type", "txn_type", "transaction_type"],
  employeeId: ["employee_id", "emp_id", "employee"],
  grade: ["grade"],
  department: ["department", "dept"],
  location: ["location", "site"],
  amount: ["amount", "amount_aed", "value"],
  currency: ["currency"],
  amountSemantics: ["amount_semantics", "semantics"],
  effectiveDate: ["effective_date", "eff_date"],
  submittedAt: ["submitted_at", "submitted", "submission_time"],
  requesterId: ["requester_id", "requested_by"],
  approverIds: ["approver_ids", "approvers", "approver_id"],
  approverGrades: ["approver_grades"],
  approverTimes: ["approver_times", "approval_times"],
  approverRoles: ["approver_roles"],
  documents: ["documents", "attachments", "docs"],
  receivingManagerId: ["receiving_manager_id", "receiving_manager"],
  fromDepartment: ["from_department", "origin_department"],
  reversalOf: ["reversal_of", "reverses"],
  comment: ["comment", "notes", "free_text"],
};

/**
 * Header-driven mapping. Ambiguous duplicate headers (two columns that map to
 * the same logical field) fail with MZ-DS-422 before any evaluation (EC-A07).
 */
function resolveColumns(headers: string[], aliases: Record<string, string[]>): { col: Record<string, number>; used: Set<number>; duplicates: string[] } {
  const col: Record<string, number> = {};
  const used = new Set<number>();
  const duplicates: string[] = [];
  for (const [key, names] of Object.entries(aliases)) {
    const matches: number[] = [];
    headers.forEach((h, i) => { if (names.includes(h)) matches.push(i); });
    if (matches.length > 1) duplicates.push(key);
    col[key] = matches[0] ?? -1;
    if (matches[0] !== undefined) used.add(matches[0]);
  }
  return { col, used, duplicates };
}

/**
 * Normalise a transactions CSV into domain Transactions.
 * Header-driven mapping through synonyms; missing/ambiguous required columns → MZ-DS-422 upstream.
 */
export function normaliseTransactions(
  csv: ParsedCsv,
  datasetId: string,
  issues: IngestIssues,
  ctx: { employeeIds?: Set<string>; periodStart?: LocalDate; asOf?: LocalDate } = {}
): Transaction[] {
  const headers = csv.headers.map((h) => h.toLowerCase().replace(/[\s-]+/g, "_"));
  const { col, used, duplicates } = resolveColumns(headers, TXN_HEADER_ALIASES);
  if (duplicates.length) throw Object.assign(new Error(`MZ-DS-422: ambiguous duplicated columns: ${duplicates.join(", ")}`), { code: "MZ-DS-422" });
  const missing = REQUIRED_TXN_COLUMNS.filter((key) => (col[key] ?? -1) < 0);
  if (missing.length) throw Object.assign(new Error(`MZ-DS-422: required columns missing: ${missing.join(", ")}`), { code: "MZ-DS-422" });

  const cell = (row: string[], i: number): string | null => (i >= 0 ? normText(row[i] ?? "") : null);
  const cellRaw = (row: string[], i: number): string => (i >= 0 ? (row[i] ?? "").trim() : "");

  // Day-month order inference per column (EC-B01) and decimal convention per amount column.
  const effOrder: InferredOrder = inferColumnOrder(csv, col.effectiveDate);
  const subOrder: InferredOrder = inferColumnOrder(csv, col.submittedAt);
  const decimalConvention = inferDecimalConvention(csv.rows.map((r) => (col.amount >= 0 ? r[col.amount] ?? "" : "")));

  // Duplicate txn IDs with different content (EC-H02)
  const seenIds = new Map<string, string>(); // txnId → rowHash
  const out: Transaction[] = [];
  let quarantinedCount = 0;
  const rawIdVariants = new Map<string, Set<string>>();

  const noteRawId = (raw: string | null): void => {
    if (!raw) return;
    const canonical = canonicalId(raw);
    if (!canonical) return;
    const set = rawIdVariants.get(canonical) ?? new Set<string>();
    set.add(raw.normalize("NFKC").trim().toUpperCase().replace(/[\s\-_.]/g, ""));
    rawIdVariants.set(canonical, set);
  };

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
      const parsed = parseAmount(amountRaw, decimalConvention);
      if (parsed.dq) dq.push(parsed.dq);
      amountFils = parsed.fils;
    }
    const currency = cell(row, col.currency);
    if (currency && currency.toUpperCase() !== "AED") dq.push("DQ-009");

    const txnGrade = gradeOrdinal(cell(row, col.grade));
    if (txnGrade.dq) dq.push(txnGrade.dq);

    // effective date
    let effectiveDate: LocalDate | null = null;
    const effRaw = cellRaw(row, col.effectiveDate);
    if (effRaw) {
      effectiveDate = parseCellDate(effRaw, effOrder.order);
      if (!effectiveDate) dq.push("DQ-002");
      else if (effOrder.defaulted && isAmbiguousDayMonth(effRaw)) {
        dq.push("DQ-003");
        caveats.push({ code: "DEFAULT_DATE_ORDER", message: { en: "Day-month order was resolved by default (day first).", ar: "تم تحديد ترتيب اليوم والشهر افتراضياً (اليوم أولاً)." }, facts: [effRaw] });
      }
      if (effectiveDate && ctx.periodStart && effectiveDate < ctx.periodStart) dq.push("DQ-012");
      if (effectiveDate && ctx.asOf && effectiveDate > `${parseInt(ctx.asOf.slice(0, 4), 10) + 1}${ctx.asOf.slice(4)}`) dq.push("DQ-012");
    } else dq.push("DQ-001");

    // submitted timestamp
    let submittedAt: string | null = null;
    let submittedPrecision: Transaction["submittedPrecision"] = null;
    const subRaw = cellRaw(row, col.submittedAt);
    if (subRaw) {
      const parsedTs = parseTimestamp(subRaw, subOrder.order);
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
            const t = tRaw ? parseTimestamp(tRaw, subOrder.order) : null;
            const approverId = canonicalId(s);
            if (ctx.employeeIds && !ctx.employeeIds.has(approverId)) dq.push("DQ-005");
            if (hasNonAsciiId(s)) dq.push("DQ-014");
            noteRawId(s);
            return {
              approverId,
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

    const employeeIdRaw = cellRaw(row, col.employeeId);
    const employeeId = canonicalId(employeeIdRaw);
    if (!employeeId) dq.push("DQ-001");
    if (ctx.employeeIds && employeeId && !ctx.employeeIds.has(employeeId)) dq.push("DQ-004");
    if (employeeIdRaw && hasNonAsciiId(employeeIdRaw)) dq.push("DQ-014");
    noteRawId(employeeIdRaw);
    if (cellRaw(row, col.requesterId)) {
      if (hasNonAsciiId(cellRaw(row, col.requesterId))) dq.push("DQ-014");
      noteRawId(cellRaw(row, col.requesterId));
    }

    const passthrough: Record<string, string> = {};
    if (col.receivingManagerId >= 0 && cellRaw(row, col.receivingManagerId)) passthrough.receiving_manager_id = canonicalId(cellRaw(row, col.receivingManagerId));
    if (col.fromDepartment >= 0 && cellRaw(row, col.fromDepartment)) passthrough.from_department = cellRaw(row, col.fromDepartment) ?? "";
    if (col.reversalOf >= 0 && cellRaw(row, col.reversalOf)) passthrough.reversal_of = cellRaw(row, col.reversalOf) ?? "";
    // Unknown columns are pass-through, reviewed on the mapping screen, and never read by the engine.
    const known = used;
    headers.forEach((h, i) => {
      if (known.has(i)) return;
      const value = cellRaw(row, i);
      if (value) passthrough[h] = value;
    });

    const rowHash = sha256(canonicalJson(row));
    // Transaction IDs keep their punctuation for display/export but digits and
    // zero-width characters are normalised (EC-B06/EC-B14).
    const txnId = normaliseDigits(normText(txnIdRaw) ?? "");
    const dup = seenIds.get(txnId);
    let rowId = txnId;
    if (dup !== undefined) {
      if (dup !== rowHash) {
        dq.push("DQ-008");
        // Content-addressed suffix: stable when rows are shuffled (F-8), unlike a
        // sequence number that depends on encounter order.
        rowId = `${txnId}#${rowHash.slice(0, 8)}`;
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
  // EC-B11: two raw identifiers collapsing to one canonical identifier are a
  // collision. Flag every affected row; dependent checks must not guess.
  const collided = new Set<string>();
  for (const [canonical, variants] of rawIdVariants) if (variants.size > 1) collided.add(canonical);
  if (collided.size) {
    for (const t of out) {
      const ids = [t.employeeId, t.requesterId ?? "", ...(t.approvals ?? []).map((a) => a.approverId ?? "")];
      if (ids.some((id) => collided.has(id))) t.dq = [...new Set<DqCode>([...t.dq, "DQ-014"])];
    }
  }

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

function isAmbiguousDayMonth(raw: string): boolean {
  const m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-]\d{2,4}$/.exec(normaliseDigits(raw.trim()));
  return !!m && parseInt(m[1]!, 10) <= 12 && parseInt(m[2]!, 10) <= 12;
}

/** Cyrillic/Greek look-alikes inside an identifier are a confusable (DQ-014), never silently dropped. */
function hasNonAsciiId(raw: string): boolean {
  return /[^\x00-\x7F]/.test(raw.replace(/[\u200B-\u200D\uFEFF\u00AD]/g, ""));
}

// ── Dataset ingestion: employees ─────────────────────────────────────────────

const EMP_HEADER_ALIASES: Record<string, string[]> = {
  id: ["employee_id", "emp_id", "employee"],
  grade: ["grade"],
  department: ["department", "dept"],
  location: ["location"],
  managerId: ["manager_id", "manager"],
  hireDate: ["hire_date", "hiring_date"],
  exitDate: ["exit_date", "leaving_date"],
  status: ["status"],
  nationality: ["nationality"],
  roles: ["roles", "role"],
  baseSalary: ["base_salary", "salary"],
};

export function normaliseEmployees(csv: ParsedCsv, datasetId: string): { employees: Employee[]; issues: IngestIssues } {
  const headers = csv.headers.map((h) => h.toLowerCase().replace(/[\s-]+/g, "_"));
  const { col, duplicates } = resolveColumns(headers, EMP_HEADER_ALIASES);
  if (duplicates.length) throw Object.assign(new Error(`MZ-DS-422: ambiguous duplicated columns: ${duplicates.join(", ")}`), { code: "MZ-DS-422" });
  if (col.id === undefined || col.id < 0) throw Object.assign(new Error("MZ-DS-422: required columns missing: employee_id"), { code: "MZ-DS-422" });
  const issues: IngestIssues = { quarantined: [], dqByRow: {}, dateOrderDefaulted: false };
  const employees: Employee[] = [];
  const seen = new Map<string, string>();
  const salaryConvention = inferDecimalConvention(csv.rows.map((r) => (col.baseSalary >= 0 ? r[col.baseSalary] ?? "" : "")));
  csv.rows.forEach((row, iRow) => {
    const rowNumber = iRow + 2;
    const id = canonicalId(row[col.id] ?? "");
    if (!id) { issues.quarantined.push({ rowNumber, dq: "DQ-001", reason: "missing employee_id" }); return; }
    const rowDq: DqCode[] = [];
    if (hasNonAsciiId(row[col.id] ?? "")) rowDq.push("DQ-014");
    const rowHash = sha256(canonicalJson(row));
    const previous = seen.get(id);
    if (previous !== undefined && previous !== rowHash) rowDq.push("DQ-008");
    else if (previous === undefined) seen.set(id, rowHash);
    const statusRes = canonicalStatus(row[col.status] ?? "");
    if (statusRes.dq) rowDq.push(statusRes.dq);
    const gradeRes = gradeOrdinal(row[col.grade] ?? null);
    if (gradeRes.dq) rowDq.push(gradeRes.dq);
    const hireRaw = (row[col.hireDate] ?? "").trim();
    const exitRaw = (row[col.exitDate] ?? "").trim();
    const hire = hireRaw ? parseCellDate(hireRaw, "day_month") : null;
    const exit = exitRaw ? parseCellDate(exitRaw, "day_month") : null;
    if (hireRaw && !hire) rowDq.push("DQ-002");
    if (exitRaw && !exit) rowDq.push("DQ-002");
    if (hire && exit && exit < hire) rowDq.push("DQ-012");
    const spells = [{ from: hire ?? "1900-01-01", to: exit }];
    const rolesRaw = (row[col.roles] ?? "").trim();
    const salary = parseAmount(row[col.baseSalary] ?? "", salaryConvention).fils;
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
      attributes: { nationality: normText(row[col.nationality] ?? null) ?? "", baseSalaryFils: salary === null ? "" : String(salary) },
    });
    if (rowDq.length) issues.dqByRow[rowNumber] = [...new Set(rowDq)];
  });
  return { employees, issues };
}

export { instantToDubaiDate, normaliseDigits };
