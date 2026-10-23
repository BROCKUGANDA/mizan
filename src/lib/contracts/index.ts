/**
 * MIZAN domain contracts (§7 DOMAIN MODEL AND DATA CONTRACTS, sandbox shape).
 * Shared by engine, API routes and UI. Field names camelCase.
 */

import type { LocalDate, Instant } from "../domain/dates";
import type { Fils } from "../domain/money";

export type Outcome = "PASS" | "FAIL" | "NOT_APPLICABLE" | "NOT_EVALUABLE";
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type ExceptionStatus =
  | "NEW" | "TRIAGED" | "ASSIGNED" | "IN_PROGRESS" | "PENDING_VERIFICATION" | "CLOSED"
  | "DISMISSED" | "ACCEPTED_RISK" | "DUPLICATE" | "REOPENED";
export type RunKind = "standard" | "shadow" | "backtest";
export type RunStatus =
  | "QUEUED" | "RUNNING" | "FINALIZING" | "COMPLETED" | "COMPLETED_WITH_HOLDS"
  | "COMPLETED_WITH_DQ" | "FAILED" | "CANCELLED";
export type DqCode =
  | "DQ-001" | "DQ-002" | "DQ-003" | "DQ-004" | "DQ-005" | "DQ-006" | "DQ-007"
  | "DQ-008" | "DQ-009" | "DQ-010" | "DQ-011" | "DQ-012" | "DQ-013" | "DQ-014"
  | "DQ-015" | "DQ-016" | "DQ-017" | "DQ-018";
export type CaveatCode =
  | DqCode | "SNAPSHOT_GRADE" | "DAY_PRECISION" | "FUTURE_DATED" | "PROVISIONAL_HOLIDAY"
  | "DEFAULT_DATE_ORDER" | "UNRECOGNISED_ATTACHMENT" | "DERIVED_BASE" | "DUPLICATE_ID";

export interface Caveat {
  code: CaveatCode;
  message: { en: string; ar: string };
  facts: string[];
}

export interface Approval {
  approverId: string | null;
  position: number;
  approvedAt: Instant | null;
  precision: "timestamp" | "date" | "none";
  role: string | null;
  gradeRaw: string | null;
  delegateFor: string | null;
}

export interface TxnDoc { raw: string; canonical: string | null }

export interface Transaction {
  rowId: string;
  txnId: string;
  type: string; // canonical code or UNKNOWN
  typeRaw: string;
  employeeId: string;
  gradeRaw: string | null;
  department: string | null;
  location: string | null;
  amountFils: Fils | null;
  currency: string | null;
  amountSemantics: "delta" | "new_total" | "unknown";
  effectiveDate: LocalDate | null;
  submittedAt: Instant | null;
  submittedPrecision: "timestamp" | "date" | "none" | null;
  requesterId: string | null;
  approvals: Approval[] | null; // null = column absent (unknown); [] = no approvals
  documents: TxnDoc[] | null;   // null = column absent; [] = none attached
  reversalOf: string | null;
  freeText: Record<string, string>; // quoted data only
  passthrough: Record<string, string>;
  source: { datasetId: string; rowNumber: number; rowHash: string };
  dq: DqCode[];
  caveats: Caveat[];
}

export interface EmploymentSpell { from: LocalDate; to: LocalDate | null }

export interface Employee {
  employeeId: string;
  gradeRaw: string | null;
  gradeOrdinal: number | null;
  department: string | null;
  location: string | null;
  managerId: string | null;
  hireDate: LocalDate | null;
  exitDate: LocalDate | null;
  statusRaw: string | null;
  status: "ACTIVE" | "EXITED" | "SUSPENDED" | "ON_LEAVE" | "UNKNOWN";
  roles: string[];
  spells: EmploymentSpell[];
  attributes: Record<string, string>; // allow-listed only
}

export interface EvidenceFact {
  name: string;
  value: string | number | boolean | null;
  display: { en: string; ar: string };
  source: "transaction" | "employee_master" | "derived" | "config";
  path: string;
  breaching: boolean;
}

export interface Evidence {
  ruleId: string;
  ruleVersion: string;
  clauseId: string;
  clauseText: string; // verbatim
  sourceAnchor: string;
  facts: EvidenceFact[];
  requirement: { en: string; ar: string; machine: string };
  comparison: { left: string; op: string; right: string; result: string } | null;
  relatedTxnIds: string[];
  calendarVersion: string | null;
  caveats: Caveat[];
}

export interface CheckResult {
  runId: string;
  rowId: string;
  txnId: string;
  ruleId: string;
  ruleVersion: string;
  clauseId: string;
  outcome: Outcome;
  evidence: Evidence | null; // null only when NOT_APPLICABLE
  evidenceHash: string | null;
  dq: DqCode[];
  slots?: Record<string, string | number | boolean | null>; // for explanation templates
}

export type FamilyKind =
  | "approval_limit" | "approval_count" | "approval_chain" | "segregation_of_duties"
  | "required_documents" | "timing_window" | "sequence" | "eligibility"
  | "aggregate_limit" | "duplicate" | "reference_integrity" | "value_bounds";

export interface RuleSpec {
  id: string;                       // "R04"
  title: string;
  family: FamilyKind;
  version: string;
  status: "draft" | "tested" | "backtested" | "approved" | "shadow" | "active" | "retired";
  effective: { from: LocalDate; to: LocalDate | null; dateBasis: "effective_date" | "run_date" };
  source: { document: string; anchor: string; text: string; sha256: string };
  scope: {
    transactionTypes: string[];
    where?: Condition;              // extra scope preconditions (e.g. amount > threshold)
  };
  check: { kind: FamilyKind; params: Record<string, unknown> };
  severity: { base: Severity; modifiers: string[] };
  routing: { process: string };
  action: { template: string };
  explain: { template: string };
  clauses: { id: string; text: string }[]; // verbatim clause texts, in order
  tests: RuleTest[];
}

export interface RuleTest {
  name: string;
  given: Record<string, unknown>;
  expect: Outcome | `${Outcome}:${string}`;
}

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { fact: string; op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "nin" | "between" | "exists" | "missing"; value?: unknown };

export interface InterpretationRecord {
  ruleId: string;
  readings: { option: string; description: { en: string; ar: string }; chosen: boolean; basis: string }[];
  ambiguityChips: { chip: string; options: string[]; chosen: string }[];
  comparatorSemantics: { term: string; meaning: string }[]; // "above" = strict, "at least" = inclusive
  notes: { en: string; ar: string };
}

export interface RunManifest {
  runId: string;
  kind: RunKind;
  status: RunStatus;
  engineVersion: string;
  packVersion: string;
  packHash: string;
  calendarHash: string;
  routingHash: string;
  gradeLadderHash: string;
  synonymsHash: string;
  configHash: string;
  flagsHash: string;
  asOf: LocalDate;
  inputs: { datasetId: string; kind: string; sha256: string; rows: number }[];
  counts: CensusCounts;
  outputHash: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface CensusCounts {
  transactions: number;
  rules: number;
  clauses: number;        // rule clauses evaluated per transaction (multi-clause rules count twice)
  checks: number;         // transactions × clauses
  applicable: number;
  notApplicable: number;
  evaluated: number;
  notEvaluable: number;
  passed: number;
  failed: number;
  quarantined: number;
  held: number;
  dqExceptions: number;
}

export interface ExceptionRecord {
  tenantId: string;
  exceptionKey: string;
  displayId: string;      // "F-" + 12 Crockford chars
  rowId: string;
  txnId: string;
  ruleId: string;
  clauseId: string;
  ruleVersion: string;
  family: string;
  severity: Severity;
  severityRationale: string;
  ownerTeam: string;
  ownerUserId: string | null;
  watchers: string[];
  routingRationale: string;
  routingTableVersion: string;
  actionId: string;
  action: { en: string; ar: string };
  explanation: { en: string; ar: string };
  narrative?: { en?: string; ar?: string; modelId: string; promptVersion: string };
  status: ExceptionStatus;
  version: number;
  groupKey: string;
  ackDueAt: LocalDate | null;
  resolveDueAt: LocalDate | null;
  heldReason: string | null;
  noLongerDetected: boolean;
  firstRunId: string;
  lastRunId: string;
  evidence: Evidence;
  evidenceHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface DecisionRecord {
  id: string;
  exceptionKey: string;
  command: string;
  actorId: string;
  reasonCategory: string | null;
  reasonText: string | null;
  sourceRef: string | null;
  expiry: LocalDate | null;
  canonicalKey: string | null;
  countersignedBy: string | null;
  idempotencyKey: string;
  createdAt: string;
  auditHash: string;
}

export const ROUTING_TABLE_VERSION = "routing-1.2.0";

/** Routing table: process (from transaction type) → owner team (§13). */
export const ROUTING_TABLE: Record<string, string> = {
  HIRE: "Talent Acquisition Operations",
  PAY_CHANGE: "Compensation & Payroll Operations",
  ALLOWANCE_CHANGE: "Compensation & Payroll Operations",
  TRANSFER: "Workforce Mobility Operations",
  LEAVE: "Leave & Attendance Operations",
  EXIT: "Separations & Final Settlement Operations",
};

export const FAMILY_OVERLAY: Record<string, string> = {
  segregation_of_duties: "HR Compliance (overlay)",
  reference_integrity: "HR Compliance (overlay)",
  data_quality: "HRIS Data Stewardship",
};

export const FALLBACK_TEAM = "HR Compliance Triage";
