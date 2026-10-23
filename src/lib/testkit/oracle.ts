/**
 * Independent oracle (backtesting §8). Reads the raw CSVs with its own parser,
 * normalises them with its own rules, and evaluates each rule in SQL over SQLite
 * (sql.js). It shares only the documented synonym/grade tables. Failing
 * (transaction, rule, clause) pairs are compared with the engine.
 */

import initSqlJs, { type Database } from "sql.js";
import type { RuleSpec, Transaction, Employee } from "../contracts";
import { evaluateDataset, type Dataset } from "./dataset";

export interface OracleResult {
  agreement: boolean;
  engineFails: number;
  oracleFails: number;
  missingFromOracle: string[];
  extraInOracle: string[];
}

const TYPE_SYNONYMS: Record<string, string> = {
  NEW_HIRE: "HIRE", HIRED: "HIRE", JOINING: "HIRE", ONBOARDING: "HIRE",
  SALARY_CHANGE: "PAY_CHANGE", SALARY_ADJ: "PAY_CHANGE", PAY_REVIEW: "PAY_CHANGE", INCREMENT: "PAY_CHANGE",
  ALLOWANCE: "ALLOWANCE_CHANGE", ALLOWANCE_CHG: "ALLOWANCE_CHANGE", ALLOWANCE_ADJ: "ALLOWANCE_CHANGE", HOUSING_ALLOWANCE: "ALLOWANCE_CHANGE",
  DEPT_TRANSFER: "TRANSFER", INTERNAL_TRANSFER: "TRANSFER", MOBILITY: "TRANSFER",
  ANNUAL_LEAVE: "LEAVE", LEAVE_REQ: "LEAVE", TIME_OFF: "LEAVE",
  RESIGNATION: "EXIT", TERMINATION: "EXIT", END_OF_SERVICE: "EXIT", LEAVER: "EXIT",
};
const DOC_SYNONYMS: Record<string, string> = {
  OFFER: "OFFER_LETTER", SIGNED_OFFER: "OFFER_LETTER", OFFER_LETTER_SIGNED: "OFFER_LETTER",
  PASSPORT: "PASSPORT_COPY", PP_COPY: "PASSPORT_COPY", PASSPORT_SCAN: "PASSPORT_COPY",
  VISA: "VISA_COPY", RESIDENCE_VISA: "VISA_COPY", ENTRY_PERMIT: "VISA_COPY",
  DEGREE: "EDUCATION_CERT", CERTIFICATE: "EDUCATION_CERT",
};

function parseCsvIndependent(text: string): string[][] {
  const s = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); field = ""; rows.push(row); row = []; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

function typeOf(raw: string): string {
  const s = raw.trim().toUpperCase().replace(/[\s-]+/g, "_");
  return TYPE_SYNONYMS[s] ?? s;
}
function canonicalId(raw: string): string {
  return raw.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}
function amountFils(raw: string): number | null {
  let s = raw.trim().replace(/AED|د\.إ|درهم/gi, "").replace(/,/g, "").trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  const fils = Math.round(n * 100);
  return neg ? -fils : fils;
}
function dateOnly(raw: string): string | null {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  return m ? `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}` : null;
}
function epochMs(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}
function dubaiDate(ms: number): string {
  return new Date(ms + 4 * 3600_000).toISOString().slice(0, 10);
}

interface RawTxn { id: number; txnId: string; type: string; employeeId: string; amount: number | null; effective: string | null; submitted: number | null; requester: string | null; manager: string | null; documents: string[] | null }

export async function runOracle(dataset: Dataset, specs: RuleSpec[]): Promise<OracleResult> {
  const SQL = await initSqlJs();
  const db: Database = new SQL.Database();
  createSchema(db);
  const employees = loadEmployees(db, dataset.employeesCsv);
  const txns = loadTransactions(db, dataset.transactionsCsv, employees);
  const engine = evaluateDataset(dataset.transactions, dataset.employees, "oracle-engine");
  const engineFails = new Set(engine.results.filter((r) => r.outcome === "FAIL").map((r) => `${r.txnId}|${r.ruleId}|${r.clauseId}`));
  const oracleFails = new Set<string>();
  for (const spec of specs) {
    if (spec.status !== "active") continue;
    const ids = queryFailures(db, spec);
    for (const id of ids) oracleFails.add(`${id}|${spec.id}|${spec.clauses[0]?.id ?? "C1"}`);
    if (spec.id === "R03") {
      for (const id of queryFailures(db, spec, "C2")) oracleFails.add(`${id}|R03|C2`);
    }
    if (spec.id === "R06") {
      for (const id of queryFailures(db, spec, "C2")) oracleFails.add(`${id}|R06|C2`);
    }
  }
  const missingFromOracle = [...engineFails].filter((k) => !oracleFails.has(k));
  const extraInOracle = [...oracleFails].filter((k) => !engineFails.has(k));
  return {
    agreement: missingFromOracle.length === 0 && extraInOracle.length === 0,
    engineFails: engineFails.size,
    oracleFails: oracleFails.size,
    missingFromOracle,
    extraInOracle,
  };
}

function createSchema(db: Database): void {
  db.run(`
    CREATE TABLE employees (employee_id TEXT PRIMARY KEY, grade INTEGER, manager_id TEXT, hire_date TEXT, exit_date TEXT, status TEXT, nationality TEXT, roles TEXT, base_fils INTEGER);
    CREATE TABLE txns (id INTEGER PRIMARY KEY, txn_id TEXT, type TEXT, employee_id TEXT, amount INTEGER, effective TEXT, submitted INTEGER, requester TEXT, manager TEXT, documents TEXT);
    CREATE TABLE approvals (txn_id INTEGER, position INTEGER, approver_id TEXT, grade INTEGER, approved_ms INTEGER, role TEXT);
    CREATE INDEX tx_emp ON txns(employee_id);
    CREATE INDEX ap_txn ON approvals(txn_id);
  `);
}

function loadEmployees(db: Database, csv: string): Map<string, { grade: number | null; hire: string | null; exit: string | null; status: string; nationality: string | null; roles: string }> {
  const rows = parseCsvIndependent(csv);
  const header = rows.shift()!.map((h) => h.trim().toLowerCase());
  const col = (n: string): number => header.indexOf(n);
  const map = new Map<string, { grade: number | null; hire: string | null; exit: string | null; status: string; nationality: string | null; roles: string }>();
  const stmt = db.prepare("INSERT INTO employees VALUES (?,?,?,?,?,?,?,?,?)");
  for (const r of rows) {
    const id = canonicalId(r[col("employee_id")] ?? "");
    if (!id) continue;
    const grade = Number(r[col("grade")] ?? "");
    const hire = dateOnly(r[col("hire_date")] ?? "");
    const exit = dateOnly(r[col("exit_date")] ?? "");
    const status = (r[col("status")] ?? "").trim().toUpperCase();
    const nationality = (r[col("nationality")] ?? "").trim() || null;
    const roles = (r[col("roles")] ?? "").trim();
    const base = amountFils(r[col("base_salary")] ?? "");
    stmt.run([id, Number.isFinite(grade) ? grade : null, canonicalId(r[col("manager_id")] ?? "") || null, hire, exit, status, nationality, roles, base] as (string | number | null)[]);
    map.set(id, { grade: Number.isFinite(grade) ? grade : null, hire, exit, status, nationality, roles });
  }
  stmt.free();
  return map;
}

function loadTransactions(db: Database, csv: string, employees: Map<string, unknown>): RawTxn[] {
  const rows = parseCsvIndependent(csv);
  const header = rows.shift()!.map((h) => h.trim().toLowerCase());
  const col = (n: string): number => header.indexOf(n);
  const txStmt = db.prepare("INSERT INTO txns VALUES (?,?,?,?,?,?,?,?,?,?)");
  const apStmt = db.prepare("INSERT INTO approvals VALUES (?,?,?,?,?,?)");
  const out: RawTxn[] = [];
  rows.forEach((r, idx) => {
    const txnId = (r[col("txn_id")] ?? "").trim();
    if (!txnId) return;
    const docRaw = r[col("documents")] ?? "";
    const documents = docRaw ? docRaw.split(/[;,|]/).map((d) => d.trim()).filter(Boolean).map((d) => DOC_SYNONYMS[d.replace(/\.[A-Za-z0-9]+$/, "").toUpperCase().replace(/[\s-]+/g, "_")] ?? d.toUpperCase()) : [];
    const employeeId = canonicalId(r[col("employee_id")] ?? "");
    const submitted = epochMs(r[col("submitted_at")] ?? "");
    const amount = amountFils(r[col("amount")] ?? "");
    const effective = dateOnly(r[col("effective_date")] ?? "");
    const manager = canonicalId(r[col("receiving_manager_id")] ?? "") || null;
    const t: RawTxn = { id: idx, txnId, type: typeOf(r[col("type")] ?? ""), employeeId, amount, effective, submitted, requester: canonicalId(r[col("requester_id")] ?? "") || null, manager, documents: docRaw === "" ? null : documents };
    out.push(t);
    txStmt.run([t.id, txnId, t.type, employeeId, amount, effective, submitted, t.requester, manager, documents.join(",")] as (string | number | null)[]);
    const ids = (r[col("approver_ids")] ?? "").split(/[;,|]/).map((x) => x.trim()).filter(Boolean);
    const grades = (r[col("approver_grades")] ?? "").split(/[;,|]/).map((x) => x.trim());
    const times = (r[col("approver_times")] ?? "").split(/[;,|]/).map((x) => x.trim());
    const roles = (r[col("approver_roles")] ?? "").split(/[;,|]/).map((x) => x.trim());
    ids.forEach((id, k) => {
      const approver = canonicalId(id);
      const grade = Number(grades[k] ?? "");
      const ms = epochMs(times[k] ?? "");
      const master = employees.get(approver) as { grade: number | null } | undefined;
      apStmt.run([t.id, k, approver, Number.isFinite(grade) ? grade : master?.grade ?? null, ms, (roles[k] ?? "").toUpperCase()] as (string | number | null)[]);
    });
  });
  txStmt.free();
  apStmt.free();
  return out;
}

function ids(db: Database, sql: string): string[] {
  const res = db.exec(sql);
  if (!res.length) return [];
  return res[0]!.values.map((v) => String(v[0]));
}

function queryFailures(db: Database, spec: RuleSpec, clauseId = "C1"): string[] {
  const SYSTEM = "'SYSTEM','HRIS_BATCH','BATCH','AUTO'";
  switch (spec.id) {
    case "R01":
      return ids(db, `
        SELECT t.txn_id FROM txns t WHERE t.type='EXIT'
        AND (SELECT manager_id FROM employees e WHERE e.employee_id=t.employee_id) IS NOT NULL
        AND (
          NOT EXISTS (SELECT 1 FROM approvals a WHERE a.txn_id=t.id AND (a.role='LINE_MANAGER' OR a.approver_id=(SELECT manager_id FROM employees e WHERE e.employee_id=t.employee_id)))
          OR NOT EXISTS (SELECT 1 FROM approvals a JOIN employees e ON e.employee_id=a.approver_id WHERE a.txn_id=t.id AND (a.role='HRBP' OR instr(e.roles,'HRBP')>0))
          OR (SELECT COUNT(DISTINCT a.approver_id) FROM approvals a WHERE a.txn_id=t.id AND a.approver_id NOT IN (${SYSTEM})) < 2
        ) AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.txn_id=t.id AND a.approver_id IN (${SYSTEM}))`);
    case "R02":
      return ids(db, `
        SELECT t.txn_id FROM txns t WHERE t.submitted IS NOT NULL AND (
          (NOT EXISTS (SELECT 1 FROM approvals a WHERE a.txn_id=t.id) AND t.txn_id NOT IN (SELECT txn_id FROM txns WHERE 0))
          OR EXISTS (SELECT 1 FROM approvals a WHERE a.txn_id=t.id AND a.approved_ms IS NOT NULL AND a.approved_ms <= t.submitted)
        )`);
    case "R03": {
      const mgr = clauseId === "C2" ? "t.manager" : "(SELECT manager_id FROM employees e WHERE e.employee_id=t.employee_id)";
      return ids(db, `SELECT t.txn_id FROM txns t WHERE t.type='TRANSFER' AND ${mgr} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.txn_id=t.id AND a.approver_id=${mgr})`);
    }
    case "R04":
      return approvalLimit(db, "ALLOWANCE_CHANGE", 1_000_000, 13);
    case "R05":
      return approvalLimit(db, "PAY_CHANGE", 2_500_000, 15);
    case "R06":
      if (clauseId === "C2") return ids(db, "SELECT t.txn_id FROM txns t WHERE EXISTS (SELECT 1 FROM approvals a WHERE a.txn_id=t.id AND a.approver_id=t.employee_id AND a.approver_id NOT IN (" + SYSTEM + "))");
      return ids(db, "SELECT t.txn_id FROM txns t WHERE t.requester IS NOT NULL AND EXISTS (SELECT 1 FROM approvals a WHERE a.txn_id=t.id AND a.approver_id=t.requester AND a.approver_id NOT IN (" + SYSTEM + "))");
    case "R07":
      return ids(db, `
        SELECT t.txn_id FROM txns t LEFT JOIN employees e ON e.employee_id=t.employee_id
        WHERE t.type='HIRE' AND t.documents IS NOT NULL AND e.nationality IS NOT NULL AND (
          instr(t.documents,'OFFER_LETTER')=0 OR instr(t.documents,'PASSPORT_COPY')=0 OR
          (e.nationality <> 'UAE_NATIONAL' AND instr(t.documents,'VISA_COPY')=0)
        )`);
    case "R08":
      return ids(db, `SELECT t.txn_id FROM txns t WHERE t.effective IS NOT NULL AND t.submitted IS NOT NULL AND julianday(date(t.submitted/1000,'unixepoch','+4 hours')) - julianday(t.effective) > 30`);
    case "R09":
      return ids(db, `
        SELECT t.txn_id FROM txns t JOIN employees e ON e.employee_id=t.employee_id
        WHERE t.type IN ('PAY_CHANGE','ALLOWANCE_CHANGE') AND t.effective IS NOT NULL AND (
          (e.hire_date IS NOT NULL AND e.hire_date > t.effective) OR
          (e.exit_date IS NOT NULL AND e.exit_date < t.effective) OR
          (e.status='EXITED' AND e.exit_date IS NULL) OR e.status='SUSPENDED'
        )`);
    case "R10":
      return ids(db, `
        SELECT t.txn_id FROM txns t WHERE t.type='ALLOWANCE_CHANGE' AND t.effective IS NOT NULL AND (
          SELECT COUNT(*) FROM txns x WHERE x.employee_id=t.employee_id AND x.type='ALLOWANCE_CHANGE' AND x.effective IS NOT NULL AND x.effective <= t.effective AND x.effective >= date(t.effective,'-364 days')
        ) > 2`);
    case "R11":
      return ids(db, `
        SELECT t.txn_id FROM txns t WHERE t.type='ALLOWANCE_CHANGE' AND t.amount IS NOT NULL AND t.effective IS NOT NULL AND EXISTS (
          SELECT 1 FROM txns x WHERE x.id<>t.id AND x.employee_id=t.employee_id AND x.type='ALLOWANCE_CHANGE' AND x.amount=t.amount AND x.effective IS NOT NULL
            AND abs(julianday(x.effective)-julianday(t.effective)) <= 3
            AND (x.effective < t.effective OR (x.effective = t.effective AND COALESCE(x.submitted,0) < COALESCE(t.submitted,0)) OR (x.effective = t.effective AND COALESCE(x.submitted,0) = COALESCE(t.submitted,0) AND x.txn_id < t.txn_id))
        )`);
    case "R12":
      return ids(db, `
        SELECT DISTINCT t.txn_id FROM txns t JOIN approvals a ON a.txn_id=t.id
        WHERE a.approver_id NOT IN (${SYSTEM}) AND a.approved_ms IS NOT NULL AND (
          NOT EXISTS (SELECT 1 FROM employees e WHERE e.employee_id=a.approver_id)
          OR EXISTS (SELECT 1 FROM employees e WHERE e.employee_id=a.approver_id AND ((e.hire_date IS NOT NULL AND e.hire_date > date(a.approved_ms/1000,'unixepoch','+4 hours')) OR (e.exit_date IS NOT NULL AND e.exit_date < date(a.approved_ms/1000,'unixepoch','+4 hours'))))
        )`);
    case "R13":
      return ids(db, `
        SELECT t.txn_id FROM txns t JOIN employees e ON e.employee_id=t.employee_id
        WHERE t.type='PAY_CHANGE' AND t.amount IS NOT NULL AND t.effective IS NOT NULL AND e.base_fils IS NOT NULL
          AND (e.base_fils - COALESCE((SELECT SUM(x.amount) FROM txns x WHERE x.employee_id=t.employee_id AND x.type='PAY_CHANGE' AND x.effective > t.effective),0)) > 0
          AND (t.amount * 10000.0 / (e.base_fils - COALESCE((SELECT SUM(x.amount) FROM txns x WHERE x.employee_id=t.employee_id AND x.type='PAY_CHANGE' AND x.effective > t.effective),0))) > 1500
          AND NOT EXISTS (
          SELECT 1 FROM approvals a WHERE a.txn_id=t.id AND a.approver_id NOT IN (${SYSTEM}) AND a.grade IS NOT NULL AND a.grade >= 17
        ) AND NOT EXISTS (
          SELECT 1 FROM approvals a WHERE a.txn_id=t.id AND a.approver_id NOT IN (${SYSTEM}) AND a.grade IS NULL
        )`);
    default:
      return [];
  }
}

function approvalLimit(db: Database, type: string, threshold: number, minGrade: number): string[] {
  const SYSTEM = "'SYSTEM','HRIS_BATCH','BATCH','AUTO'";
  return ids(db, `
    SELECT t.txn_id FROM txns t
    WHERE t.amount IS NOT NULL AND t.amount > ${threshold}
      AND t.type = '${type}' 
      AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.txn_id=t.id AND a.approver_id NOT IN (${SYSTEM}) AND a.grade IS NOT NULL AND a.grade >= ${minGrade})
      AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.txn_id=t.id AND a.approver_id NOT IN (${SYSTEM}) AND a.grade IS NULL)
  `);
}

export function engineFailSet(dataset: Dataset): Set<string> {
  const r = evaluateDataset(dataset.transactions, dataset.employees, "oracle-check");
  return new Set(r.results.filter((x) => x.outcome === "FAIL").map((x) => `${x.txnId}|${x.ruleId}|${x.clauseId}`));
}
