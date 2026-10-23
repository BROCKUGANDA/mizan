/**
 * Dataset ingestion (FS-09, FS-24, §8): limits, magic-byte sniffing, encoding,
 * PII guard, schema fingerprint, header mapping and quarantine. The same
 * normaliser the engine uses is applied before the working set is replaced.
 */

import { db } from "@/lib/db";
import { MzError } from "../domain/errors";
import { sha256 } from "../domain/canonical";
import { decodeCsv, parseCsv, normaliseTransactions, normaliseEmployees, type IngestIssues } from "../normalize";
import { randomUUID } from "node:crypto";
import { appendAudit } from "../audit/chain";
import { putObject } from "./object-store";

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_LINE_BYTES = 1024 * 1024;
export const MAX_ROWS = 2_000_000;

const PII_PATTERNS: [string, RegExp][] = [
  ["Emirates ID", /784-\d{4}-\d{7}-\d/g],
  ["passport", /\b[A-Z]{2}\d{7}\b/g],
  ["IBAN", /\bAE\d{2}\d{19}\b/g],
  ["phone", /(?:\+971|00971)?5\d{8}/g],
  ["email", /[\w.+-]+@[\w-]+\.[\w.]+/g],
];

export interface UploadInput {
  kind: "transactions" | "employees" | "policy" | "finding_format";
  source: string;
  filename: string;
  buffer: Uint8Array;
  synthetic: boolean;
  actor: string;
}

export interface IngestResult {
  dataset: {
    id: string; kind: string; source: string; sha256: string; rows: number;
    encoding: string; fingerprint: string; unknownColumns: string[];
    quarantined: number; deduplicated: boolean;
  };
  issues: Record<string, unknown>;
}

export function assertSafeUpload(input: UploadInput): void {
  if (input.buffer.length > MAX_FILE_BYTES) throw new MzError("MZ-DS-413", "The file is larger than 50 MB.");
  if (!input.synthetic) throw new MzError("MZ-DS-422", "Judge mode accepts synthetic or test data only. Confirm the synthetic/test checkbox.");
  const head = input.buffer.subarray(0, 8);
  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  const isPdf = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46;
  const isOle = head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0;
  if (isZip || isPdf || isOle) throw new MzError("MZ-DS-415", "The file content is not CSV or Markdown. Save it as CSV UTF-8 and try again.");
  if (input.kind === "policy" && !input.filename.toLowerCase().endsWith(".md")) throw new MzError("MZ-DS-415", "Policy files must be Markdown (.md).");
  if (input.kind !== "policy" && !input.filename.toLowerCase().endsWith(".csv")) throw new MzError("MZ-DS-415", "Transactions, employees and the finding format must be CSV.");
}

export function scanPii(text: string): { code: string; count: number }[] {
  const hits: { code: string; count: number }[] = [];
  for (const [code, re] of PII_PATTERNS) {
    const count = text.match(re)?.length ?? 0;
    if (count) hits.push({ code, count });
  }
  return hits;
}

export async function ingestUpload(input: UploadInput): Promise<IngestResult> {
  assertSafeUpload(input);
  const { text, encoding } = decodeCsv(input.buffer);
  const lines = text.split(/\r?\n/);
  if (lines.some((l) => Buffer.byteLength(l, "utf8") > MAX_LINE_BYTES)) throw new MzError("MZ-DS-413", "A line is longer than 1 MB.");
  if (lines.length > MAX_ROWS + 1) throw new MzError("MZ-DS-413", "The file has more than 2,000,000 rows.");
  const pii = scanPii(text);
  if (pii.length) throw new MzError("MZ-DS-422", `The upload looks like real personal data (${pii.map((p) => p.code).join(", ")}). Judge mode refuses real employee data.`);
  const hash = sha256(text);
  const stored = await putObject(input.buffer);
  const existing = await db.dataset.findFirst({ where: { kind: input.kind, sha256: hash } });
  if (existing) {
    const meta = existing.mappingProfileJson ? JSON.parse(existing.mappingProfileJson) as { source?: string; fingerprint?: string; unknownColumns?: string[] } : {};
    return {
      dataset: { id: existing.id, kind: existing.kind, source: meta.source ?? input.source, sha256: hash, rows: existing.rows, encoding, fingerprint: meta.fingerprint ?? "", unknownColumns: meta.unknownColumns ?? [], quarantined: 0, deduplicated: true },
      issues: existing.issuesJson ? JSON.parse(existing.issuesJson) : {},
    };
  }

  if (input.kind === "policy" || input.kind === "finding_format") {
    const rows = text.split(/\r?\n/).filter(Boolean).length;
    const id = `ds-${input.kind}-${randomUUID().slice(0, 8)}`;
    const fingerprint = sha256(text.split(/\r?\n/)[0] ?? "");
    await db.dataset.create({ data: { id, kind: input.kind, sha256: hash, objectKey: stored.key, rows, issuesJson: "{}", mappingProfileJson: JSON.stringify({ source: input.source, fingerprint, unknownColumns: [] }), syntheticTag: "SYNTHETIC-UPLOAD" } });
    await appendAudit({ actor: input.actor, type: "dataset.uploaded", entity: "dataset", entityId: id, payload: { kind: input.kind, sha256: hash, rows } });
    return { dataset: { id, kind: input.kind, source: input.source, sha256: hash, rows, encoding, fingerprint, unknownColumns: [], quarantined: 0, deduplicated: false }, issues: {} };
  }

  const parsed = parseCsv(text, sniffDelimiterIndependent(text));
  const headers = parsed.headers.map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, "_"));
  const issues: IngestIssues = { quarantined: [], dqByRow: {}, dateOrderDefaulted: false };
  const prior = await db.dataset.findFirst({ where: { kind: input.kind }, orderBy: { createdAt: "desc" } });
  const priorMeta = prior?.mappingProfileJson ? JSON.parse(prior.mappingProfileJson) as { fingerprint?: string; headers?: string[] } : null;
  const fingerprint = sha256(headers.join("|"));
  const known = input.kind === "transactions"
    ? new Set(["txn_id", "transaction_id", "txn", "type", "txn_type", "transaction_type", "employee_id", "emp_id", "employee", "grade", "department", "dept", "location", "site", "amount", "amount_aed", "value", "currency", "amount_semantics", "semantics", "effective_date", "eff_date", "submitted_at", "submitted", "submission_time", "requester_id", "requested_by", "approver_ids", "approvers", "approver_id", "approver_grades", "approver_times", "approval_times", "approver_roles", "documents", "attachments", "docs", "receiving_manager_id", "receiving_manager", "from_department", "origin_department", "reversal_of", "reverses", "comment", "notes", "free_text"])
    : new Set(["employee_id", "emp_id", "employee", "grade", "department", "dept", "location", "manager_id", "manager", "hire_date", "hiring_date", "exit_date", "leaving_date", "status", "nationality", "roles", "role", "base_salary", "salary"]);
  const unknownColumns = headers.filter((h) => !known.has(h));

  let rows: number;
  if (input.kind === "transactions") {
    const employeeRows = await db.employee.findMany({ select: { employeeId: true } });
    const employeeIds = new Set(employeeRows.map((e) => e.employeeId));
    const transactions = normaliseTransactions(parsed, `ds-${input.kind}`, issues, { employeeIds, asOf: new Date().toISOString().slice(0, 10) });
    rows = transactions.length;
    const id = `ds-${input.kind}-${randomUUID().slice(0, 8)}`;
    await db.$transaction(async (tx) => {
      await tx.dataset.create({ data: { id, kind: input.kind, sha256: hash, objectKey: stored.key, rows, issuesJson: JSON.stringify({ ...issues, encoding, unknownColumns, drift: priorMeta ? priorMeta.fingerprint !== fingerprint : false }), mappingProfileJson: JSON.stringify({ source: input.source, fingerprint, headers, unknownColumns }), syntheticTag: "SYNTHETIC-UPLOAD" } });
      await tx.txn.deleteMany({});
      for (let i = 0; i < transactions.length; i += 500) {
        await tx.txn.createMany({
          data: transactions.slice(i, i + 500).map((t) => ({
            rowId: t.rowId, txnId: t.txnId, type: t.type, typeRaw: t.typeRaw, employeeId: t.employeeId,
            gradeRaw: t.gradeRaw, department: t.department, location: t.location, amountFils: t.amountFils,
            currency: t.currency, amountSemantics: t.amountSemantics, effectiveDate: t.effectiveDate,
            submittedAt: t.submittedAt, submittedPrecision: t.submittedPrecision, requesterId: t.requesterId,
            approvalsJson: t.approvals === null ? null : JSON.stringify(t.approvals),
            documentsJson: t.documents === null ? null : JSON.stringify(t.documents),
            reversalOf: t.reversalOf, freeTextJson: JSON.stringify(t.freeText), passthroughJson: JSON.stringify(t.passthrough),
            dqJson: JSON.stringify(t.dq), caveatsJson: JSON.stringify(t.caveats),
            sourceJson: JSON.stringify(t.source), datasetId: id, rowNumber: t.source.rowNumber,
          })),
        });
      }
    }, { timeout: 60_000 });
    await appendAudit({ actor: input.actor, type: "dataset.uploaded", entity: "dataset", entityId: id, payload: { kind: input.kind, sha256: hash, rows, unknownColumns, quarantined: issues.quarantined.length } });
    return { dataset: { id, kind: input.kind, source: input.source, sha256: hash, rows, encoding, fingerprint, unknownColumns, quarantined: issues.quarantined.length, deduplicated: false }, issues: { ...issues, unknownColumns, drift: priorMeta ? priorMeta.fingerprint !== fingerprint : false } };
  }

  const { employees, issues: empIssues } = normaliseEmployees(parsed, `ds-${input.kind}`);
  rows = employees.length;
  const id = `ds-${input.kind}-${randomUUID().slice(0, 8)}`;
  await db.$transaction(async (tx) => {
    await tx.dataset.create({ data: { id, kind: input.kind, sha256: hash, objectKey: stored.key, rows, issuesJson: JSON.stringify({ ...empIssues, encoding, unknownColumns }), mappingProfileJson: JSON.stringify({ source: input.source, fingerprint, headers, unknownColumns }), syntheticTag: "SYNTHETIC-UPLOAD" } });
    await tx.employee.deleteMany({});
    for (let i = 0; i < employees.length; i += 500) {
      await tx.employee.createMany({
        data: employees.slice(i, i + 500).map((e) => ({
          employeeId: e.employeeId, gradeRaw: e.gradeRaw, gradeOrdinal: e.gradeOrdinal, department: e.department,
          location: e.location, managerId: e.managerId, hireDate: e.hireDate, exitDate: e.exitDate,
          statusRaw: e.statusRaw, status: e.status, rolesJson: JSON.stringify(e.roles), spellsJson: JSON.stringify(e.spells),
          attributesJson: JSON.stringify(e.attributes), datasetId: id,
        })),
      });
    }
  }, { timeout: 60_000 });
  await appendAudit({ actor: input.actor, type: "dataset.uploaded", entity: "dataset", entityId: id, payload: { kind: input.kind, sha256: hash, rows, unknownColumns } });
  return { dataset: { id, kind: input.kind, source: input.source, sha256: hash, rows, encoding, fingerprint, unknownColumns, quarantined: empIssues.quarantined.length, deduplicated: false }, issues: empIssues as unknown as Record<string, unknown> };
}

function sniffDelimiterIndependent(text: string): string {
  const line = text.split(/\r?\n/)[0] ?? "";
  const candidates = [",", ";", "\t", "|"];
  let best = ",";
  let bestCount = -1;
  for (const d of candidates) {
    let count = 0;
    let quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (ch === d && !quoted) count++;
    }
    if (count > bestCount) { bestCount = count; best = d; }
  }
  return best;
}
