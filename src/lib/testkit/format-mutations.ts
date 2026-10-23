/**
 * Label-preserving format mutations F-1…F-9 (backtesting §5).
 * Each returns a CSV text that must yield exactly the same findings as the
 * unmutated pack.
 */

import { parseCsv, normaliseTransactions, type ParsedCsv } from "../normalize";
import { cloneParsed, columnIndex, mulberry32, serialiseCsv, type Dataset } from "./dataset";

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";

function arDigits(s: string): string {
  return s.replace(/[0-9]/g, (d) => AR_DIGITS[Number(d)]!);
}

function rewriteColumn(parsed: ParsedCsv, index: number, fn: (value: string) => string): void {
  if (index < 0) return;
  for (const row of parsed.rows) row[index] = fn(row[index] ?? "");
}

function dateToDayMonth(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

function timestampToDayMonth(value: string): string {
  const v = value.trim();
  if (!v) return v;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(v);
  if (!m) return v;
  return `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}${m[6] ? `:${m[6]}` : ""}`;
}

export function applyFormatMutation(id: string, dataset: Dataset): string {
  const parsed = cloneParsed(dataset.parsedTransactions);
  const eff = columnIndex(parsed, "effective_date");
  const sub = columnIndex(parsed, "submitted_at");
  const approverTimes = columnIndex(parsed, "approver_times");
  const amount = columnIndex(parsed, "amount");
  const approvers = columnIndex(parsed, "approver_ids", "approvers");
  const grades = columnIndex(parsed, "approver_grades");
  const roles = columnIndex(parsed, "approver_roles");
  const employee = columnIndex(parsed, "employee_id");
  const txnId = columnIndex(parsed, "txn_id", "transaction_id");
  const requester = columnIndex(parsed, "requester_id");
  const documents = columnIndex(parsed, "documents", "attachments");

  switch (id) {
    case "F-1":
      rewriteColumn(parsed, eff, dateToDayMonth);
      rewriteColumn(parsed, sub, timestampToDayMonth);
      rewriteColumn(parsed, approverTimes, (v) => v.split(/[;,|]/).map(timestampToDayMonth).join("; "));
      return serialiseCsv(parsed);
    case "F-2":
      rewriteColumn(parsed, amount, (v) => {
        const n = Number(v.replace(/,/g, ""));
        if (!v || !Number.isFinite(n)) return v;
        const [whole, frac] = n.toFixed(2).split(".");
        return `AED ${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
      });
      return serialiseCsv(parsed);
    case "F-3":
      rewriteColumn(parsed, amount, arDigits);
      rewriteColumn(parsed, employee, arDigits);
      rewriteColumn(parsed, txnId, arDigits);
      rewriteColumn(parsed, requester, arDigits);
      rewriteColumn(parsed, approvers, (v) => arDigits(v));
      return serialiseCsv(parsed);
    case "F-4": {
      for (const row of parsed.rows) {
        for (let i = 0; i < row.length; i++) if (row[i] && row[i]!.length < 40) row[i] = ` ${row[i]} `;
      }
      return serialiseCsv(parsed, "\n", true).replace(/\n/g, "\r\n");
    }
    case "F-5": {
      const order = parsed.headers.map((_, i) => i).reverse(); // reorder columns
      const newHeaders = parsed.headers.map((h) => {
        const lower = h.trim().toLowerCase();
        if (lower === "txn_id") return "Txn ID";
        if (lower === "employee_id") return "Emp ID";
        if (lower === "effective_date") return "Effective Date";
        if (lower === "approver_ids") return "Approvers";
        return h.toUpperCase();
      });
      return serialiseCsv({ headers: order.map((i) => newHeaders[i]!), rows: parsed.rows.map((r) => order.map((i) => r[i] ?? "")) });
    }
    case "F-6":
      for (const col of [approvers, grades, approverTimes, roles]) rewriteColumn(parsed, col, (v) => v.replace(/;/g, "|").replace(/,/g, "|"));
      return serialiseCsv(parsed);
    case "F-7":
      for (const col of [txnId, employee, requester, approvers]) rewriteColumn(parsed, col, (v) => v.replace(/([A-Z0-9])/g, "$1\u200B"));
      return serialiseCsv(parsed);
    case "F-8": {
      const rng = mulberry32(42);
      for (let i = parsed.rows.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [parsed.rows[i], parsed.rows[j]] = [parsed.rows[j]!, parsed.rows[i]!];
      }
      return serialiseCsv(parsed);
    }
    case "F-9":
      rewriteColumn(parsed, documents, (v) => v.split(/[;,|]/).map((d) => {
        const t = d.trim().toLowerCase();
        if (t === "offer_letter") return "Offer_LETTER.pdf";
        if (t === "passport_copy") return "passport copy.png";
        if (t === "visa_copy") return "VISA.JPG";
        return d;
      }).join("; "));
      return serialiseCsv(parsed);
    default:
      return dataset.transactionsCsv;
  }
}

export const FORMAT_MUTATIONS = ["F-1", "F-2", "F-3", "F-4", "F-5", "F-6", "F-7", "F-8", "F-9"] as const;

export function normaliseMutated(text: string, employeeIds: Set<string>) {
  return normaliseTransactions(parseCsv(text, ","), "bench-format", { quarantined: [], dqByRow: {}, dateOrderDefaulted: false }, { employeeIds, asOf: "2026-04-01" });
}
