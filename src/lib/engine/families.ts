/**
 * Family semantics (§9): each family is a pure module with its own tests.
 * Evaluation order per transaction × rule: scope (NOT_APPLICABLE) → data
 * sufficiency (NOT_EVALUABLE + DQ) → check (PASS/FAIL) → evidence.
 * A family never emits one result per list item (one exception lists all missing documents).
 */

import type { Transaction, Employee, RuleSpec, Evidence, EvidenceFact, Caveat, DqCode, Outcome, Approval } from "../contracts";
import type { EngineIndexes } from "./facts";
import {
  activeAt, approverGrade, payChangePct, rollingAggregate, duplicateTwins, isLaterTwin,
  submittedDate, firstApprovalInstant, submittedIsDatePrecision, pointInTimeStatus,
} from "./facts";
import { diffDays, instantToDubaiDate, compareInstants, type LocalDate } from "../domain/dates";
import { UAE_CALENDAR, dateOutsideCalendar, businessDaysElapsed, isHoliday } from "../domain/calendar";
import { addDays } from "../domain/dates";
import { gradeOrdinal } from "../normalize";

export interface FamilyEval {
  outcome: Outcome;
  facts: EvidenceFact[];
  requirement: { en: string; ar: string; machine: string };
  comparison: Evidence["comparison"];
  dq: DqCode[];
  caveats: Caveat[];
  slots: Record<string, string | number | boolean | null>; // for explanation templates + finding format
  relatedTxnIds: string[];
}

const SYSTEM_ACTORS = new Set(["SYSTEM", "HRIS_BATCH", "BATCH", "AUTO"]);

function fact(name: string, value: string | number | boolean | null, displayEn: string, displayAr: string, source: EvidenceFact["source"], path: string, breaching = false): EvidenceFact {
  return { name, value, display: { en: displayEn, ar: displayAr }, source, path, breaching };
}

function humanApprovers(t: Transaction): Approval[] {
  return (t.approvals ?? []).filter((a) => a.approverId && !SYSTEM_ACTORS.has(a.approverId.toUpperCase()));
}

export function evaluateFamily(
  txn: Transaction,
  rule: RuleSpec,
  clauseId: string,
  indexes: EngineIndexes,
  asOf: LocalDate
): FamilyEval {
  const p = rule.check.params;
  switch (rule.family) {
    case "approval_limit": return approvalLimit(txn, rule, p, indexes);
    case "approval_count": return approvalCount(txn, rule, p, indexes);
    case "approval_chain": return approvalChain(txn, rule, clauseId, p, indexes);
    case "segregation_of_duties": return segregationOfDuties(txn, rule, clauseId, p, indexes);
    case "required_documents": return requiredDocuments(txn, rule, p, indexes);
    case "timing_window": return timingWindow(txn, rule, p, indexes);
    case "sequence": return sequence(txn, rule, p, indexes);
    case "eligibility": return eligibility(txn, rule, p, indexes);
    case "aggregate_limit": return aggregateLimit(txn, rule, p, indexes);
    case "duplicate": return duplicate(txn, rule, p, indexes);
    case "reference_integrity": return referenceIntegrity(txn, rule, p, indexes);
    case "value_bounds": return valueBounds(txn, rule, p, indexes);
    default:
      return notEvaluable(rule, clauseId, [], [{ code: "DQ-001", message: { en: "Family module failed; never abort a run.", ar: "فشلت وحدة العائلة؛ لا يتم إلغاء التشغيل." }, facts: [] }], {});
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function pass(facts: EvidenceFact[], requirement: FamilyEval["requirement"], comparison: Evidence["comparison"], slots: FamilyEval["slots"], dq: DqCode[] = [], caveats: Caveat[] = [], related: string[] = []): FamilyEval {
  return { outcome: "PASS", facts, requirement, comparison, dq, caveats, slots, relatedTxnIds: related };
}
function fail(facts: EvidenceFact[], requirement: FamilyEval["requirement"], comparison: Evidence["comparison"], slots: FamilyEval["slots"], dq: DqCode[] = [], caveats: Caveat[] = [], related: string[] = []): FamilyEval {
  return { outcome: "FAIL", facts, requirement, comparison, dq, caveats, slots, relatedTxnIds: related };
}
function notEvaluable(rule: RuleSpec, _clauseId: string, facts: EvidenceFact[], dqWithCaveats: { dq: DqCode[]; caveats: Caveat[] } | Caveat[], slots: FamilyEval["slots"] = {}): FamilyEval {
  const caveats = Array.isArray(dqWithCaveats) ? dqWithCaveats : (dqWithCaveats as { caveats: Caveat[] }).caveats ?? [];
  const dqCodes = Array.isArray(dqWithCaveats) ? ["DQ-001" as DqCode] : ((dqWithCaveats as { dq: DqCode[] }).dq ?? ["DQ-001"]);
  return {
    outcome: "NOT_EVALUABLE", facts, comparison: null, dq: dqCodes, caveats, slots,
    requirement: requirementFor(rule), relatedTxnIds: [],
  };
}
function requirementFor(rule: RuleSpec): FamilyEval["requirement"] {
  return { en: rule.clauses[0]?.text ?? rule.title, ar: rule.clauses[0]?.text ?? rule.title, machine: `${rule.id}:C1:${rule.family}` };
}
function notApplicable(): FamilyEval {
  return { outcome: "NOT_APPLICABLE", facts: [], requirement: { en: "", ar: "", machine: "" }, comparison: null, dq: [], caveats: [], slots: {}, relatedTxnIds: [] };
}

function gradeListDisplay(grades: (number | null)[]): string {
  return grades.map((g) => (g === null ? "unknown" : String(g))).join(", ");
}

// ── Families ─────────────────────────────────────────────────────────────────

function amountScope(condition: RuleSpec["scope"]["where"]): { op: "gt" | "gte"; value: number } | null {
  if (!condition) return null;
  if ("all" in condition) {
    for (const sub of condition.all) {
      const found = amountScope(sub);
      if (found) return found;
    }
    return null;
  }
  if ("fact" in condition && condition.fact === "txn.amount_fils" && (condition.op === "gt" || condition.op === "gte") && typeof condition.value === "number") {
    return { op: condition.op, value: condition.value };
  }
  return null;
}

function approvalLimit(txn: Transaction, rule: RuleSpec, p: Record<string, unknown>, indexes: EngineIndexes): FamilyEval {
  const minGrade = p.minApproverGrade as number;
  const quantifier = (p.quantifier as string) ?? "any";
  const allowDelegates = p.allowDelegates === true;
  const scope = amountScope(rule.scope.where);
  const thresholdFils = scope?.value ?? null;
  const req: FamilyEval["requirement"] = {
    en: `An approver at grade ${minGrade} or above is required.`,
    ar: `يلزم معتمِم من الدرجة ${minGrade} أو أعلى.`,
    machine: `${rule.id}:approver_grade>=${minGrade}`,
  };
  // Data sufficiency: ambiguous amount / currency when in scope by type
  if (txn.dq.includes("DQ-013") || txn.dq.includes("DQ-009")) {
    const f: EvidenceFact[] = [fact("amount_fils", txn.amountFils, txn.amountFils === null ? "not parseable" : String(txn.amountFils), txn.amountFils === null ? "غير قابل للتحليل" : String(txn.amountFils), "transaction", "txn.amount_fils")];
    return { ...notEvaluable(rule, "C1", f, { dq: txn.dq.filter((d): d is DqCode => d === "DQ-013" || d === "DQ-009"), caveats: txn.caveats }), requirement: req };
  }
  if (txn.amountFils === null) {
    return { ...notEvaluable(rule, "C1", [], { dq: ["DQ-001"], caveats: [] }), requirement: req };
  }
  if (txn.approvals === null) {
    return { ...notEvaluable(rule, "C1", [], { dq: ["DQ-001"], caveats: [{ code: "DQ-001", message: { en: "The approvals column is missing; authority cannot be checked.", ar: "عمود الموافقات غير موجود؛ لا يمكن التحقق من الصلاحية." }, facts: [] }] }), requirement: req };
  }
  // Exited approvers do not count toward authority (§9 approval_limit).
  const counted = humanApprovers(txn).filter((a) => {
    if (a.delegateFor && !allowDelegates) return false;
    const master = indexes.employeeById.get(a.approverId ?? "");
    if (!master) return true; // grade may come from the transaction; DQ-005 is reported below
    const at = a.approvedAt ? instantToDubaiDate(a.approvedAt) : txn.effectiveDate;
    if (!at) return true;
    return activeAt(master, at);
  });
  const excluded = humanApprovers(txn).length - counted.length;
  if (counted.length === 0) {
    // Empty approvals column = no approvals (FAIL, EC-B13); a non-empty column whose
    // only approvers were exited also leaves nobody with authority.
    return fail(
      [fact("amount_fils", txn.amountFils, `AED ${formatAmount(txn.amountFils)}`, `${formatAmount(txn.amountFils)} درهم`, "transaction", "txn.amount_fils", true),
       fact("approver_count", 0, excluded ? `no counted approvers (${excluded} exited/delegate excluded)` : "no approvals recorded", excluded ? "لا يوجد معتمِمون محتسبون" : "لا توجد موافقات مسجلة", "transaction", "txn.approvals", true),
       fact("required_grade", minGrade, `grade ${minGrade}`, `الدرجة ${minGrade}`, "config", "rule.required_grade")],
      req,
      { left: "approver grades", op: "≥", right: String(minGrade), result: "no counted approvals" },
      { amountFils: txn.amountFils, thresholdFils, requiredGrade: minGrade, approverId: null, approverGrade: null, approverCount: 0 }
    );
  }
  const gradesWithSource = counted.map((a) => ({ a, g: approverGrade(txn, a, indexes) }));
  const caveats = gradesWithSource.map((x) => x.g.caveat).filter(Boolean) as Caveat[];
  const dq: DqCode[] = gradesWithSource.map((x) => x.g.dq).filter((x): x is DqCode => x !== null);
  const unknownGrades = gradesWithSource.filter((x) => x.g.ordinal === null);
  const knownGrades = gradesWithSource.filter((x) => x.g.ordinal !== null);
  const facts: EvidenceFact[] = [
    fact("amount_fils", txn.amountFils, `AED ${formatAmount(txn.amountFils)}`, `${formatAmount(txn.amountFils)} درهم`, "transaction", "txn.amount_fils", txn.amountFils > (thresholdFils ?? 0)),
    fact("threshold_fils", thresholdFils, `AED ${formatAmount(thresholdFils ?? 0)}`, `${formatAmount(thresholdFils ?? 0)} درهم`, "config", "rule.threshold"),
    fact("required_grade", minGrade, `grade ${minGrade}`, `الدرجة ${minGrade}`, "config", "rule.required_grade"),
  ];
  for (const x of gradesWithSource) {
    facts.push(fact("approver_grade", x.g.ordinal, `${x.a.approverId} is ${x.g.ordinal === null ? "of unknown grade" : `grade ${x.g.ordinal}`} (from ${x.g.source === "transaction" ? "transaction" : "master"})`, `${x.a.approverId} ${x.g.ordinal === null ? "بدرجة غير معروفة" : `من الدرجة ${x.g.ordinal}`} (من ${x.g.source === "transaction" ? "المعاملة" : "البيانات الرئيسية"})`, x.g.source === "transaction" ? "transaction" : "employee_master", `txn.approvals.${x.a.approverId}`, x.g.ordinal !== null && x.g.ordinal < minGrade));
  }
  const slots: FamilyEval["slots"] = {
    amountFils: txn.amountFils, thresholdFils, requiredGrade: minGrade,
    approverId: knownGrades[0]?.a.approverId ?? counted[0]?.approverId ?? null,
    approverGrade: knownGrades[0]?.g.ordinal ?? null,
    approverCount: counted.length,
  };
  if (quantifier === "all") {
    if (unknownGrades.length > 0) return { ...notEvaluable(rule, "C1", facts, { dq: dq.length ? dq : ["DQ-001"], caveats }), requirement: req };
    const allMeet = knownGrades.every((x) => x.g.ordinal! >= minGrade);
    return (allMeet ? pass : fail)(facts, req, { left: gradeListDisplay(knownGrades.map((x) => x.g.ordinal)), op: "≥", right: String(minGrade), result: allMeet ? "all approvers meet the grade" : "an approver is below the grade" }, slots, dq, caveats);
  }
  const meeting = knownGrades.find((x) => x.g.ordinal! >= minGrade);
  if (meeting) {
    slots.approverId = meeting.a.approverId;
    slots.approverGrade = meeting.g.ordinal;
    return pass(facts, req, { left: "approver grades", op: "≥", right: String(minGrade), result: "an approver meets the grade" }, slots, dq, caveats);
  }
  if (unknownGrades.length > 0) {
    // An unknown grade could still meet the requirement: never guess a FAIL.
    return { ...notEvaluable(rule, "C1", facts, { dq: dq.length ? dq : ["DQ-001"], caveats }), requirement: req };
  }
  const breaching = knownGrades.filter((x) => x.g.ordinal! < minGrade);
  slots.approverId = breaching[0]?.a.approverId ?? slots.approverId;
  slots.approverGrade = breaching[0]?.g.ordinal ?? slots.approverGrade;
  return fail(facts, req, { left: gradeListDisplay(knownGrades.map((x) => x.g.ordinal)), op: "≥", right: String(minGrade), result: "no approver meets the grade" }, slots, dq, caveats);
}

function formatAmount(fils: number): string {
  const abs = Math.abs(fils);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${fils < 0 ? "-" : ""}${whole}.${String(abs % 100).padStart(2, "0")}`;
}

function approvalCount(txn: Transaction, rule: RuleSpec, p: Record<string, unknown>, indexes: EngineIndexes): FamilyEval {
  const minDistinct = p.minDistinct as number;
  const requiredRoles = p.requiredRoles as string[];
  const req: FamilyEval["requirement"] = {
    en: `At least ${minDistinct} distinct approvers covering ${requiredRoles.join(" and ")} are required.`,
    ar: `يلزم ${minDistinct} معتمِمين مختلفين على الأقل يغطون ${requiredRoles.join(" و ")}.`,
    machine: `${rule.id}:distinct>=${minDistinct};roles=${requiredRoles.join("+")}`,
  };
  if (txn.approvals === null) {
    return { ...notEvaluable(rule, "C1", [], { dq: ["DQ-001"], caveats: [{ code: "DQ-001", message: { en: "The approvals column is missing; roles cannot be checked.", ar: "عمود الموافقات غير موجود؛ لا يمكن التحقق من الأدوار." }, facts: [] }] }), requirement: req };
  }
  const apps = humanApprovers(txn);
  const rolesFound = new Set<string>();
  let unresolvedRole = false;
  const emp = indexes.employeeById.get(txn.employeeId);
  for (const a of apps) {
    const master = indexes.employeeById.get(a.approverId ?? "");
    const role = (a.role ?? "").toUpperCase();
    if (role === "HRBP" || master?.roles.includes("HRBP")) rolesFound.add("HRBP");
    if (role === "LINE_MANAGER" || (emp?.managerId && a.approverId === emp.managerId)) rolesFound.add("LINE_MANAGER");
    const knownRole = role === "HRBP" || role === "LINE_MANAGER" || role === "RECEIVING_MANAGER" || role === "";
    const masterKnown = master?.roles.includes("HRBP") || (emp?.managerId !== undefined && emp?.managerId === a.approverId);
    if (!knownRole && !masterKnown) unresolvedRole = true;
    if (!master && !knownRole) unresolvedRole = true;
  }
  const distinct = new Set(apps.map((a) => a.approverId));
  const missingRoles = requiredRoles.filter((r) => !rolesFound.has(r));
  const lineManagerUnknown = requiredRoles.includes("LINE_MANAGER") && !!emp && !emp.managerId;
  const facts: EvidenceFact[] = [
    fact("approver_count", distinct.size, `${distinct.size} distinct approver(s)`, `${distinct.size} معتمِم مختلف`, "transaction", "txn.approvals", distinct.size < minDistinct),
    ...requiredRoles.map((r) => fact(`role_${r}`, rolesFound.has(r), `${r} ${rolesFound.has(r) ? "present" : "missing"}`, `${r === "HRBP" ? "شريك الموارد البشرية" : "المدير المباشر"} ${rolesFound.has(r) ? "موجود" : "غير موجود"}`, "derived", `roles.${r}`, !rolesFound.has(r))),
  ];
  const slots: FamilyEval["slots"] = { approverCount: distinct.size, rolesFound: [...rolesFound].join(", "), rolesMissing: missingRoles.join(", "), minDistinct, requiredRoles: requiredRoles.join(", ") };
  if (missingRoles.length === 0 && distinct.size >= minDistinct) return pass(facts, req, { left: `${distinct.size} distinct, roles ${[...rolesFound].join("+")}`, op: "≥", right: `${minDistinct} + ${requiredRoles.join("+")}`, result: "met" }, slots);
  if (unresolvedRole || lineManagerUnknown) {
    // Role information cannot be resolved, so a missing role is unknown, never a breach.
    return { ...notEvaluable(rule, "C1", facts, { dq: ["DQ-001"], caveats: [{ code: "DQ-001", message: { en: "An approver's role cannot be resolved from the transaction or the employee master.", ar: "تعذر تحديد دور أحد المعتمِمین من المعاملة أو البيانات الرئيسية." }, facts: [] }] }), requirement: req };
  }
  return fail(facts, req, { left: `${distinct.size} distinct, roles ${[...rolesFound].join("+")}`, op: "≥", right: `${minDistinct} + ${requiredRoles.join("+")}`, result: missingRoles.length ? `missing ${missingRoles.join(", ")}` : "not enough distinct approvers" }, slots);
}

function approvalChain(txn: Transaction, rule: RuleSpec, clauseId: string, p: Record<string, unknown>, indexes: EngineIndexes): FamilyEval {
  const mustInclude = p.mustInclude as string[];
  const emp = indexes.employeeById.get(txn.employeeId);
  const apps = humanApprovers(txn);
  const approverIds = new Set(apps.map((a) => a.approverId));
  const req: FamilyEval["requirement"] = {
    en: "Both the sending manager (line manager) and the receiving department manager must approve the transfer.",
    ar: "يلزم اعتماد المدير المرسل (المدير المباشر) ومدير الإدارة المستلمة لنقل المعاملة.",
    machine: `${rule.id}:must_include=${mustInclude.join("+")}`,
  };
  if (!emp) {
    return { ...notEvaluable(rule, clauseId, [], { dq: ["DQ-004"], caveats: [{ code: "DQ-004", message: { en: `Employee ${txn.employeeId} is not in the employee master, so the chain is unknown.`, ar: `الموظف ${txn.employeeId} غير موجود في بيانات الموظفين، لذا سلسلة الإدارة غير معروفة.` }, facts: [txn.employeeId] }] }), requirement: req };
  }
  if (indexes.cycleEmployees.has(emp.employeeId)) {
    return { ...notEvaluable(rule, clauseId, [], { dq: ["DQ-010"], caveats: [{ code: "DQ-010", message: { en: "The management chain has a cycle for this employee.", ar: "سلسلة الإدارة تحتوي على حلقة لهذا الموظف." }, facts: [emp.employeeId] }] }), requirement: req };
  }
  const lineMgr = emp.managerId ?? null;
  const recMgr = (txn.passthrough.receiving_manager_id ?? null) || null;
  const linePresent = lineMgr ? approverIds.has(lineMgr) : false;
  const recPresent = recMgr ? approverIds.has(recMgr) : false;
  const clause = clauseId === "C2" ? "C2" : "C1";
  if (clause === "C1" && !lineMgr) {
    return { ...notEvaluable(rule, clause, [], { dq: ["DQ-001"], caveats: [{ code: "DQ-001", message: { en: "No line manager is recorded for this employee, so the sending-manager approval cannot be checked.", ar: "لا يوجد مدير مباشر مسجل لهذا الموظف، لذا لا يمكن التحقق من موافقة المدير المرسل." }, facts: [emp.employeeId] }] }), requirement: req };
  }
  if (clause === "C2" && !recMgr) {
    return { ...notEvaluable(rule, clause, [], { dq: ["DQ-001"], caveats: [{ code: "DQ-001", message: { en: "The receiving manager is not recorded, so the receiving approval cannot be checked.", ar: "المدير المستلم غير مسجل، لذا لا يمكن التحقق من موافقته." }, facts: [txn.txnId] }] }), requirement: req };
  }
  const facts: EvidenceFact[] = [
    fact("line_manager", lineMgr, lineMgr ? `line manager ${lineMgr} ${linePresent ? "approved" : "did not approve"}` : "no line manager recorded", lineMgr ? `المدير المباشر ${lineMgr} ${linePresent ? "اعتمد" : "لم يعتمد"}` : "لا يوجد مدير مباشر مسجل", "employee_master", "employee.manager_id", clause === "C1" && !linePresent),
    fact("receiving_manager", recMgr, recMgr ? `receiving manager ${recMgr} ${recPresent ? "approved" : "did not approve"}` : "receiving manager not recorded", recMgr ? `المدير المستلم ${recMgr} ${recPresent ? "اعتمد" : "لم يعتمد"}` : "المدير المستلم غير مسجل", "transaction", "txn.receiving_manager_id", clause === "C2" && !recPresent),
  ];
  const missing = clause === "C1" && !linePresent ? "LINE_MANAGER" : clause === "C2" && !recPresent ? "RECEIVING_MANAGER" : null;
  const slots: FamilyEval["slots"] = {
    requiredManager: clause === "C1" ? (lineMgr ?? "") : (recMgr ?? ""),
    relationship: clause === "C1" ? "sending manager (line manager)" : "receiving department manager",
    missingRole: missing ?? "",
    chainPath: [txn.employeeId, ...(indexes.managerChainCache.get(txn.employeeId) ?? [])].join(" → "),
  };
  const ok = clause === "C1" ? linePresent : recPresent;
  if (ok) return pass(facts, req, { left: clause === "C1" ? "line manager approval" : "receiving manager approval", op: "exists", right: "required", result: "present" }, slots);
  return fail(facts, req, { left: clause === "C1" ? "line manager approval" : "receiving manager approval", op: "exists", right: "required", result: "missing" }, slots);
}

function segregationOfDuties(txn: Transaction, rule: RuleSpec, clauseId: string, p: Record<string, unknown>, _indexes: EngineIndexes): FamilyEval {
  void p;
  const req: FamilyEval["requirement"] = {
    en: "The requester cannot approve, and nobody approves a transaction from which they benefit.",
    ar: "لا يمكن للطالب اعتماد المعاملة، ولا يجوز لأحد اعتماد معاملة يستفيد منها.",
    machine: `${rule.id}:requester≠approver;approver≠beneficiary`,
  };
  if (txn.approvals === null) {
    return { ...notEvaluable(rule, clauseId, [], { dq: ["DQ-001"], caveats: [{ code: "DQ-001", message: { en: "The approvals column is missing; segregation of duties cannot be checked.", ar: "عمود الموافقات غير موجود؛ لا يمكن التحقق من الفصل بين المهام." }, facts: [] }] }), requirement: req };
  }
  const apps = humanApprovers(txn);
  const requester = txn.requesterId;
  const beneficiary = txn.employeeId;
  const clause = clauseId === "C2" ? "C2" : "C1";
  if (clause === "C1" && requester === null) {
    return { ...notEvaluable(rule, clauseId, [], { dq: ["DQ-001"], caveats: [{ code: "DQ-001", message: { en: "The requester is missing, so the requester–approver check cannot run.", ar: "الطالب غير موجود، لذا لا يمكن تنفيذ فحص الطالب والمعتمِِم." }, facts: [] }] }), requirement: req };
  }
  if (clause === "C1") {
    const offender = apps.find((a) => a.approverId === requester || a.delegateFor === requester) ?? null;
    const facts: EvidenceFact[] = [
      fact("requester_id", requester, `requester ${requester}`, `الطالب ${requester}`, "transaction", "txn.requester_id", !!offender),
      ...apps.map((a) => fact("approver_id", a.approverId, `approver ${a.approverId}`, `المعتمِم ${a.approverId}`, "transaction", "txn.approvals", a.approverId === requester)),
    ];
    const slots: FamilyEval["slots"] = { requesterId: requester, approverId: offender?.approverId ?? null, employeeId: beneficiary, actor: offender?.approverId ?? requester };
    if (!offender) return pass(facts, req, { left: "requester", op: "≠", right: "approvers", result: "independent" }, slots);
    return fail(facts, req, { left: `requester ${requester}`, op: "≠", right: `approver ${offender.approverId}`, result: "the same person" }, slots);
  }
  const offender = apps.find((a) => a.approverId === beneficiary || a.delegateFor === beneficiary) ?? null;
  const facts: EvidenceFact[] = [
    fact("employee_id", beneficiary, `beneficiary ${beneficiary}`, `المستفيد ${beneficiary}`, "transaction", "txn.employee_id", !!offender),
    ...apps.map((a) => fact("approver_id", a.approverId, `approver ${a.approverId}`, `المعتمِم ${a.approverId}`, "transaction", "txn.approvals", a.approverId === beneficiary)),
  ];
  const slots: FamilyEval["slots"] = { requesterId: requester, approverId: offender?.approverId ?? null, employeeId: beneficiary, actor: offender?.approverId ?? "" };
  if (!offender) return pass(facts, req, { left: "approver", op: "≠", right: "beneficiary", result: "independent" }, slots);
  return fail(facts, req, { left: `approver ${offender.approverId}`, op: "≠", right: `beneficiary ${beneficiary}`, result: "the same person (self-benefit)" }, slots);
}

function requiredDocuments(txn: Transaction, rule: RuleSpec, p: Record<string, unknown>, indexes: EngineIndexes): FamilyEval {
  const required = p.required as string[];
  const conditionals = (p.conditional ?? []) as { document: string; when: { fact: string; op: string; value: string } }[];
  const req: FamilyEval["requirement"] = {
    en: `Required documents: ${required.join(", ")}${conditionals.length ? `, plus ${conditionals.map((c) => c.document).join(", ")} when the condition applies` : ""}.`,
    ar: `المستندات المطلوبة: ${required.map((d) => DOC_AR[d] ?? d).join("، ")}${conditionals.length ? `، بالإضافة إلى ${conditionals.map((c) => DOC_AR[c.document] ?? c.document).join("، ")} عند تحقق الشرط` : ""}.`,
    machine: `${rule.id}:required=${required.join("+")}${conditionals.map((c) => `;cond:${c.document}=${c.when.op}:${c.when.value}`).join("")}`,
  };
  if (txn.documents === null) {
    return { ...notEvaluable(rule, "C1", [], { dq: ["DQ-001"], caveats: [{ code: "DQ-001", message: { en: "Documents column is missing; presence cannot be checked.", ar: "عمود المستندات غير موجود؛ لا يمكن التحقق من الوجود." }, facts: [] }] }), requirement: req };
  }
  const attached = new Set(txn.documents.map((d) => d.canonical).filter(Boolean) as string[]);
  const emp = indexes.employeeById.get(txn.employeeId);
  const nationality = emp?.attributes.nationality ?? null;
  const missing: string[] = [];
  let conditionMissing = false;
  for (const r of required) if (!attached.has(r)) missing.push(r);
  for (const c of conditionals) {
    let factValue: string | null = null;
    if (c.when.fact === "employee.nationality") factValue = nationality;
    else if (c.when.fact === "txn.type") factValue = txn.type;
    else if (c.when.fact === "txn.department") factValue = txn.department;
    if (factValue === null) { conditionMissing = true; continue; }
    const matches =
      c.when.op === "eq" ? factValue === c.when.value :
      c.when.op === "ne" ? factValue !== c.when.value :
      c.when.op === "in" ? (c.when.value as unknown as string[]).includes(factValue) :
      c.when.op === "nin" ? !(c.when.value as unknown as string[]).includes(factValue) :
      false;
    if (matches && !attached.has(c.document)) missing.push(c.document);
  }
  if (conditionMissing) {
    return { ...notEvaluable(rule, "C1", [], { dq: ["DQ-001"], caveats: [{ code: "DQ-001", message: { en: "A condition field needed for the document requirement is missing; the check cannot be decided.", ar: "حقل شرط مطلوب لمتطلب المستند غير موجود؛ لا يمكن تحديد النتيجة." }, facts: [] }] }), requirement: req };
  }
  const facts: EvidenceFact[] = [
    ...[...attached].map((d) => fact("attached", d, `attached: ${d}`, `مرفق: ${DOC_AR[d] ?? d}`, "transaction", "txn.documents")),
    ...missing.map((d) => fact("missing", d, `missing: ${d}`, `ناقص: ${DOC_AR[d] ?? d}`, "derived", "required−attached", true)),
  ];
  const slots: FamilyEval["slots"] = {
    missingDocuments: missing.map((d) => DOC_AR[d] ?? d).join(", "),
    missingDocumentsEn: missing.join(", "),
    attachedDocuments: txn.documents.map((d) => d.raw).join(", ") || "none",
    nationality: nationality ?? "",
    requesterId: txn.requesterId ?? txn.employeeId,
  };
  if (missing.length === 0) return pass(facts, req, { left: "attached documents", op: "⊇", right: required.join("+"), result: "all present" }, slots, [], txn.caveats);
  return fail(facts, req, { left: "attached documents", op: "⊇", right: required.join("+"), result: `missing ${missing.join(", ")}` }, slots, [], txn.caveats);
}

const DOC_AR: Record<string, string> = {
  OFFER_LETTER: "خطاب العرض", PASSPORT_COPY: "صورة جواز السفر", VISA_COPY: "صورة التأشيرة", EDUCATION_CERT: "الشهادة الدراسية",
};

function timingWindow(txn: Transaction, rule: RuleSpec, p: Record<string, unknown>, _indexes: EngineIndexes): FamilyEval {
  const maxDays = typeof p.maxDays === "number" ? p.maxDays : null;
  const minDays = typeof p.minDays === "number" ? p.minDays : null;
  const basis = (p.basis as string) === "business" ? "business" : "calendar";
  const req: FamilyEval["requirement"] = {
    en: maxDays !== null ? `Backdating must not exceed ${maxDays} ${basis === "business" ? "business " : ""}days.` : `The interval must be at least ${minDays} ${basis === "business" ? "business " : ""}days.`,
    ar: maxDays !== null ? `يجب ألا يتجاوز التأريخ المسبق ${maxDays} ${basis === "business" ? "أيام عمل " : "يوماً"}.` : `يجب ألا تقل الفترة عن ${minDays} ${basis === "business" ? "أيام عمل " : "يوماً"}.`,
    machine: `${rule.id}:${basis}${maxDays !== null ? `<=${maxDays}` : `>=${minDays}`}`,
  };
  const dateFor = (name: string): LocalDate | null => {
    if (name === "effectiveDate") return txn.effectiveDate;
    if (name === "submittedDate") return submittedDate(txn);
    if (name === "approvedDate") {
      const a = firstApprovalInstant(txn).instant;
      return a ? instantToDubaiDate(a) : null;
    }
    return null;
  };
  const fromFact = (p.fromFact as string) ?? "effectiveDate";
  const toFact = (p.toFact as string) ?? "submittedDate";
  const from = dateFor(fromFact);
  const to = dateFor(toFact);
  if (!from || !to) {
    return { ...notEvaluable(rule, "C1", [], { dq: ["DQ-001"], caveats: [{ code: "DQ-001", message: { en: "A date needed for the timing window is missing.", ar: "تاريخ مطلوب لنافذة التوقيت غير موجود." }, facts: [] }] }), requirement: req };
  }
  if (basis === "business" && (dateOutsideCalendar(from) || dateOutsideCalendar(to))) {
    return { ...notEvaluable(rule, "C1", [], { dq: ["DQ-015"], caveats: [{ code: "DQ-015", message: { en: "A date is outside the loaded calendar years, so business days cannot be counted.", ar: "أحد التاريخين خارج سنوات التقويم المحمّلة، لذا لا يمكن حساب أيام العمل." }, facts: [from, to] }] }), requirement: req };
  }
  const elapsed = basis === "business" ? businessDaysElapsed(from, to) : diffDays(to, from); // positive = to after from
  const isBackdated = elapsed > 0;
  const withinMax = maxDays === null || elapsed <= maxDays;
  const withinMin = minDays === null || elapsed >= minDays;
  const ok = withinMax && withinMin;
  const provisional: string[] = [];
  if (basis === "business") {
    let d = from;
    while (d < to) {
      const h = isHoliday(d);
      if (h?.provisional) provisional.push(h.date);
      d = addDays(d, 1);
    }
  }
  const caveats: Caveat[] = [];
  if (provisional.length) caveats.push({ code: "PROVISIONAL_HOLIDAY", message: { en: `Provisional holidays were counted: ${provisional.join(", ")}.`, ar: `تم احتساب أعياد مؤقتة: ${provisional.join("، ")}.` }, facts: provisional });
  const facts: EvidenceFact[] = [
    fact(fromFact === "effectiveDate" ? "effective_date" : fromFact, from, `${fromFact} ${from}`, `${fromFact} ${from}`, "transaction", `txn.${fromFact}`, isBackdated && !ok),
    fact(toFact === "submittedDate" ? "submitted_date" : toFact, to, `${toFact} ${to}`, `${toFact} ${to}`, "transaction", `txn.${toFact}`),
    fact("interval_days", elapsed, `${elapsed} ${basis === "business" ? "business " : ""}day(s)`, `${elapsed} ${basis === "business" ? "أيام عمل" : "يوم"}`, "derived", `${toFact}−${fromFact}`, isBackdated && !ok),
    ...(maxDays !== null ? [fact("max_days", maxDays, `${maxDays} days allowed`, `${maxDays} يوماً مسموح`, "config", "rule.max_days")] : []),
    ...(minDays !== null ? [fact("min_days", minDays, `${minDays} days required`, `${minDays} يوماً مطلوب`, "config", "rule.min_days")] : []),
  ];
  const slots: FamilyEval["slots"] = { effectiveDate: txn.effectiveDate, submittedDate: submittedDate(txn), backdatedDays: Math.max(0, elapsed), maxDays: maxDays ?? "", intervalDays: elapsed, basis, from: fromFact, to: toFact };
  const comparison = maxDays !== null
    ? { left: `${elapsed} days`, op: "≤", right: `${maxDays} days`, result: ok ? "within the window" : "backdating exceeds the window" }
    : { left: `${elapsed} days`, op: "≥", right: `${minDays} days`, result: ok ? "within the window" : "the interval is below the minimum" };
  if (ok) return pass(facts, req, comparison, slots, [], caveats);
  return fail(facts, req, comparison, slots, [], caveats);
}

function sequence(txn: Transaction, rule: RuleSpec, p: Record<string, unknown>, _indexes: EngineIndexes): FamilyEval {
  void p;
  const req: FamilyEval["requirement"] = {
    en: "The approval must be recorded after the transaction is submitted.",
    ar: "يجب تسجيل الموافقة بعد إرسال المعاملة.",
    machine: `${rule.id}:approvedAt>submittedAt`,
  };
  if (txn.approvals === null) {
    return { ...notEvaluable(rule, "C1", [], { dq: ["DQ-001"], caveats: [{ code: "DQ-001", message: { en: "The approvals column is missing; the order cannot be checked.", ar: "عمود الموافقات غير موجود؛ لا يمكن التحقق من الترتيب." }, facts: [] }] }), requirement: req };
  }
  const { instant: approvedAt, precision } = firstApprovalInstant(txn);
  if (!txn.submittedAt) {
    return { ...notEvaluable(rule, "C1", [], { dq: ["DQ-001"], caveats: [{ code: "DQ-001", message: { en: "Submission time is missing; the order cannot be checked.", ar: "وقت الإرسال غير موجود؛ لا يمكن التحقق من الترتيب." }, facts: [] }] }), requirement: req };
  }
  if (txn.approvals.length > 0 && !approvedAt) {
    // Approver present but timestamp missing (EC-D14): authority rules still evaluate; sequence NOT_EVALUABLE
    return { ...notEvaluable(rule, "C1", [], { dq: ["DQ-001"], caveats: [{ code: "DQ-001", message: { en: "Approval timestamp is missing; the order cannot be checked.", ar: "وقت الموافقة غير موجود؛ لا يمكن التحقق من الترتيب." }, facts: [] }] }), requirement: req };
  }
  if (!approvedAt) {
    // zero approvals → nothing recorded after submission → FAIL (EC-B13)
    return fail(
      [fact("approvals", 0, "no approvals recorded", "لا توجد موافقات مسجلة", "transaction", "txn.approvals", true),
       fact("submitted_at", txn.submittedAt, `submitted ${txn.submittedAt}`, `الإرسال ${txn.submittedAt}`, "transaction", "txn.submitted_at")],
      req, { left: "approval", op: ">", right: "submission", result: "no approval recorded" },
      { approvedAt: null, submittedAt: txn.submittedAt, zeroApprovals: true }
    );
  }
  const approvedDate = instantToDubaiDate(approvedAt);
  const submittedDubai = instantToDubaiDate(txn.submittedAt);
  const dayPrecision = precision === "date" || submittedIsDatePrecision(txn);
  const ordering = compareInstants(approvedAt, txn.submittedAt);
  const after = ordering > 0;
  const equalDay = approvedDate === submittedDubai;
  const caveats: Caveat[] = [];
  if (dayPrecision) caveats.push({ code: "DAY_PRECISION", message: { en: "Compared at day precision because a timestamp is missing.", ar: "تمت المقارنة بدقة اليوم لغياب الطابع الزمني." }, facts: [] });
  const facts: EvidenceFact[] = [
    fact("submitted_at", txn.submittedAt, `submitted ${txn.submittedAt}`, `الإرسال ${txn.submittedAt}`, "transaction", "txn.submitted_at"),
    fact("approved_at", approvedAt, `approved ${approvedAt}`, `الاعتماد ${approvedAt}`, "transaction", "txn.approvals", !after),
  ];
  const slots: FamilyEval["slots"] = { approvedAt, submittedAt: txn.submittedAt, approvedDate, submittedDate: submittedDubai };
  if (after) return pass(facts, req, { left: "approval", op: ">", right: "submission", result: "after" }, slots, [], caveats);
  if (!after && equalDay && dayPrecision) {
    // date-precision same-day: "not before" is satisfied at day precision — treated as pass with caveat
    return pass(facts, req, { left: "approval (date precision)", op: "≥", right: "submission (date precision)", result: "same day" }, slots, [], caveats);
  }
  const critical = ordering < 0; // strictly before submission
  return fail(facts, req, { left: "approval", op: ">", right: "submission", result: critical ? "approval recorded before submission" : "approval recorded at the same instant" }, { ...slots, approvalBeforeSubmission: critical }, [], caveats);
}

function eligibility(txn: Transaction, rule: RuleSpec, p: Record<string, unknown>, indexes: EngineIndexes): FamilyEval {
  const allowedStatuses = (p.allowedStatuses as string[]) ?? ["ACTIVE"];
  const exemptTypes = (p.exemptTypes as string[]) ?? [];
  const probationDays = typeof p.probationDays === "number" ? p.probationDays : null;
  const req: FamilyEval["requirement"] = {
    en: probationDays !== null ? `The transaction must not happen during the ${probationDays}-day probation period.` : "The employee must be active on the effective date.",
    ar: probationDays !== null ? `يجب ألا تحدث المعاملة خلال فترة التجربة البالغة ${probationDays} يوماً.` : "يجب أن يكون الموظف على رأس العمل في تاريخ السريان.",
    machine: `${rule.id}:status@effective∈{${allowedStatuses.join(",")}}${probationDays !== null ? `;probation=${probationDays}` : ""}`,
  };
  if (exemptTypes.includes(txn.type)) return notApplicable();
  const emp = indexes.employeeById.get(txn.employeeId);
  if (!emp) {
    return { ...notEvaluable(rule, "C1", [], { dq: ["DQ-004"], caveats: [{ code: "DQ-004", message: { en: `Employee ${txn.employeeId} is not in the employee master.`, ar: `الموظف ${txn.employeeId} غير موجود في بيانات الموظفين.` }, facts: [txn.employeeId] }] }), requirement: req };
  }
  if (emp.status === "UNKNOWN" || !emp.status) {
    return { ...notEvaluable(rule, "C1", [], { dq: ["DQ-016"], caveats: [{ code: "DQ-016", message: { en: `Status "${emp.statusRaw ?? ""}" is not mapped; eligibility cannot be decided.`, ar: `الحالة "${emp.statusRaw ?? ""}" غير مصنفة؛ لا يمكن تحديد الأهلية.` }, facts: [emp.statusRaw ?? ""] }] }), requirement: req };
  }
  const eff = txn.effectiveDate;
  if (!eff) {
    return { ...notEvaluable(rule, "C1", [], { dq: ["DQ-001"], caveats: [] }), requirement: req };
  }
  const stateAt = pointInTimeStatus(emp, eff);
  const inProbation = probationDays !== null && emp.hireDate !== null && eff > emp.hireDate && diffDays(eff, emp.hireDate) <= probationDays;
  // ON_LEAVE is still employed (an approved leave does not end employment); a
  // policy that says "active" is about the employment relationship, while
  // SUSPENDED and EXITED are not active. The status remains in the evidence.
  const passesStatus = allowedStatuses.includes(stateAt) || (stateAt === "ON_LEAVE" && allowedStatuses.includes("ACTIVE"));
  const passes = probationDays !== null ? !inProbation : passesStatus;
  const caveats: Caveat[] = [];
  const facts: EvidenceFact[] = [
    fact("employee_id", emp.employeeId, `employee ${emp.employeeId}`, `الموظف ${emp.employeeId}`, "employee_master", "employee.id"),
    fact("amount_fils", txn.amountFils, txn.amountFils === null ? "no amount" : `AED ${formatAmount(txn.amountFils)}`, txn.amountFils === null ? "لا يوجد مبلغ" : `${formatAmount(txn.amountFils)} درهم`, "transaction", "txn.amount_fils"),
    fact("hire_date", emp.hireDate, emp.hireDate ? `hired ${emp.hireDate}` : "hire date unknown", emp.hireDate ? `التعيين ${emp.hireDate}` : "تاريخ التعيين غير معروف", "employee_master", "employee.hire_date"),
    fact("exit_date", emp.exitDate, emp.exitDate ? `exit ${emp.exitDate}` : "no exit date", emp.exitDate ? `المغادرة ${emp.exitDate}` : "لا يوجد تاريخ مغادرة", "employee_master", "employee.exit_date", !passes),
    fact("effective_date", eff, `effective ${eff}`, `السريان ${eff}`, "transaction", "txn.effective_date", !passes),
    fact("status_at_effective", stateAt, `status at effective date: ${stateAt}`, `الحالة في تاريخ السريان: ${stateAt}`, "derived", "spells@effective", !passesStatus),
    ...(probationDays !== null ? [fact("in_probation", inProbation, inProbation ? `within ${probationDays} days of hire` : "probation ended", inProbation ? `خلال ${probationDays} يوماً من التعيين` : "انتهت فترة التجربة", "derived", "probation", inProbation)] : []),
  ];
  const slots: FamilyEval["slots"] = { employeeId: emp.employeeId, exitDate: emp.exitDate, hireDate: emp.hireDate, effectiveDate: eff, statusAt: stateAt, inProbation };
  if (passes) return pass(facts, req, { left: "status at effective date", op: "∈", right: probationDays !== null ? `not within ${probationDays} days of hire` : allowedStatuses.join("|"), result: "met" }, slots, [], caveats);
  return fail(facts, req, { left: "status at effective date", op: "∈", right: probationDays !== null ? `not within ${probationDays} days of hire` : allowedStatuses.join("|"), result: inProbation ? "inside probation" : `status ${stateAt}` }, slots, [], caveats);
}

function aggregateLimit(txn: Transaction, rule: RuleSpec, p: Record<string, unknown>, indexes: EngineIndexes): FamilyEval {
  const windowDays = p.windowDays as number;
  const max = p.max as number;
  const metric = (p.metric as string) === "sum" ? "sum" : "count";
  const req: FamilyEval["requirement"] = {
    en: metric === "sum" ? `At most AED ${formatAmount(max)} of ${txn.type.toLowerCase()} per employee in any ${Math.round(windowDays / 30)}-month period.` : `At most ${max} ${txn.type.toLowerCase()} transactions per employee in any ${Math.round(windowDays / 30)}-month period.`,
    ar: metric === "sum" ? `الحد الأقصى ${formatAmount(max)} درهم من ${txn.type} لكل موظف في أي فترة ${Math.round(windowDays / 30)} أشهر.` : `${max} معاملة ${txn.type} كحد أقصى لكل موظف في أي فترة ${Math.round(windowDays / 30)} أشهر.`,
    machine: `${rule.id}:${metric}@${windowDays}d<=${max}`,
  };
  if (!txn.effectiveDate) {
    return { ...notEvaluable(rule, "C1", [], { dq: ["DQ-001"], caveats: [] }), requirement: req };
  }
  const agg = rollingAggregate(txn, indexes, windowDays, metric);
  if (metric === "sum" && agg.missingAmounts > 0) {
    return { ...notEvaluable(rule, "C1", [], { dq: ["DQ-001"], caveats: [{ code: "DQ-001", message: { en: "An amount inside the aggregation window is missing.", ar: "مبلغ داخل نافذة التجميع غير موجود." }, facts: [] }] }), requirement: req };
  }
  const actual = metric === "sum" ? agg.sumFils : agg.count;
  const breached = actual > max;
  const facts: EvidenceFact[] = [
    fact("window_months", Math.round(windowDays / 30), `${Math.round(windowDays / 30)} months`, `${Math.round(windowDays / 30)} أشهر`, "config", "rule.window_months"),
    fact("metric", metric, metric, metric, "config", "rule.metric"),
    fact("value_in_window", actual, metric === "sum" ? `AED ${formatAmount(actual)} in the window` : `${actual} changes in the window`, metric === "sum" ? `${formatAmount(actual)} درهم في النافذة` : `${actual} تغييرات في النافذة`, "derived", `aggregate.${metric}`, breached),
    fact("max", max, metric === "sum" ? `max AED ${formatAmount(max)}` : `max ${max}`, metric === "sum" ? `الحد ${formatAmount(max)} درهم` : `الحد ${max}`, "config", "rule.max"),
    fact("contributing", agg.contributing.join(", "), `contributing: ${agg.contributing.join(", ")}`, `المساهِمات: ${agg.contributing.join("، ")}`, "derived", "aggregate.contributing", breached),
  ];
  const slots: FamilyEval["slots"] = { count: agg.count, max, metric, sumFils: agg.sumFils, windowDays, contributing: agg.contributing.join(", "), employeeId: txn.employeeId, windowStart: txn.effectiveDate };
  if (!breached) return pass(facts, req, { left: metric === "sum" ? `${formatAmount(actual)}` : `${actual} changes`, op: "≤", right: metric === "sum" ? formatAmount(max) : `${max}`, result: "within the limit" }, slots);
  return fail(facts, req, { left: metric === "sum" ? `${formatAmount(actual)}` : `${actual} changes`, op: "≤", right: metric === "sum" ? formatAmount(max) : `${max}`, result: "the limit is exceeded" }, slots);
}

function duplicate(txn: Transaction, rule: RuleSpec, p: Record<string, unknown>, indexes: EngineIndexes): FamilyEval {
  const toleranceDays = p.toleranceDays as number;
  const flag = (p.flag as string) ?? "later";
  const req: FamilyEval["requirement"] = {
    en: `The same change must not be entered twice within ${toleranceDays} days.`,
    ar: `يجب عدم إدخال نفس التغيير مرتين خلال ${toleranceDays} أيام.`,
    machine: `${rule.id}:twin@${toleranceDays}d flag:${flag}`,
  };
  if (txn.dq.includes("DQ-013")) {
    return { ...notEvaluable(rule, "C1", [], { dq: ["DQ-013"], caveats: [{ code: "DQ-013", message: { en: "The amount is ambiguous, so duplicate matching cannot run.", ar: "المبلغ غامض، لذا تعذر تشغيل مطابقة التكرار." }, facts: [] }] }), requirement: req };
  }
  if (txn.amountFils === null || txn.effectiveDate === null) {
    return { ...notEvaluable(rule, "C1", [], { dq: ["DQ-001"], caveats: [{ code: "DQ-001", message: { en: "The amount or effective date is missing, so duplicate matching cannot run.", ar: "المبلغ أو تاريخ السريان غير موجود، لذا تعذر تشغيل مطابقة التكرار." }, facts: [] }] }), requirement: req };
  }
  const twins = duplicateTwins(txn, indexes, toleranceDays);
  if (twins.length === 0) {
    return pass(
      [fact("twins", 0, "no duplicate entries found", "لا توجد إدخالات مكررة", "derived", "duplicate.twins")],
      req, { left: "twins", op: "=", right: "0", result: "none" }, { twins: 0 }
    );
  }
  let flagged = txn;
  let cited = twins[0]!;
  if (flag === "later") {
    // this rule flags only the later twin; earlier twin passes
    if (!twins.every((x) => isLaterTwin(txn, x))) {
      return pass(
        [fact("twin_of", twins[0]!.txnId, `pairs with ${twins[0]!.txnId} (this is the earlier entry)`, `مرتبطة بـ ${twins[0]!.txnId} (هذا هو الإدخال الأقدم)`, "derived", "duplicate")],
        req, { left: "entry", op: "=", right: "earlier twin", result: "earlier of the pair" }, { twins: twins.length, earlier: true }
      );
    }
    flagged = txn;
    cited = twins.reduce((a, b) => (isLaterTwin(a, b) ? a : b));
  } else {
    // flag=both: cite the earliest twin of this pair.
    cited = twins.reduce((a, b) => (isLaterTwin(a, b) ? b : a));
  }
  const daysApart = Math.abs(diffDays(flagged.effectiveDate!, cited.effectiveDate!));
  const facts: EvidenceFact[] = [
    fact("txn_a", cited.txnId, `earlier ${cited.txnId} effective ${cited.effectiveDate}`, `الأقدم ${cited.txnId} سريان ${cited.effectiveDate}`, "transaction", "twins"),
    fact("txn_b", flagged.txnId, `this ${flagged.txnId} effective ${flagged.effectiveDate}`, `الحالية ${flagged.txnId} سريان ${flagged.effectiveDate}`, "transaction", "txn", true),
    fact("amount_fils", flagged.amountFils, `AED ${formatAmount(flagged.amountFils ?? 0)}`, `${formatAmount(flagged.amountFils ?? 0)} درهم`, "transaction", "txn.amount_fils"),
    fact("days_apart", daysApart, `${daysApart} days apart`, `بفارق ${daysApart} أيام`, "derived", "dates", true),
  ];
  const bothEffective = flagged.effectiveDate !== null && cited.effectiveDate !== null;
  return fail(facts, req, { left: `${cited.txnId} ↔ ${flagged.txnId}`, op: "Δ≤", right: `${toleranceDays} days`, result: `${daysApart} days apart, same type and amount` }, { txnA: cited.txnId, txnAEffectiveDate: cited.effectiveDate, txnB: flagged.txnId, effectiveDate: flagged.effectiveDate, daysApart, amountFils: flagged.amountFils, employeeId: flagged.employeeId, bothEffective }, [], [], [cited.rowId]);
}

function referenceIntegrity(txn: Transaction, rule: RuleSpec, p: Record<string, unknown>, indexes: EngineIndexes): FamilyEval {
  void p;
  const req: FamilyEval["requirement"] = {
    en: "Every approver must exist in the employee master and be active at approval time.",
    ar: "يجب أن يكون كل معتمِم موجوداً في بيانات الموظفين وعلى رأس عمله وقت الموافقة.",
    machine: `${rule.id}:approvers exist+active@approval`,
  };
  if (txn.approvals === null) {
    return { ...notEvaluable(rule, "C1", [], { dq: ["DQ-001"], caveats: [{ code: "DQ-001", message: { en: "The approvals column is missing; references cannot be checked.", ar: "عمود الموافقات غير موجود؛ لا يمكن التحقق من المراجع." }, facts: [] }] }), requirement: req };
  }
  const apps = humanApprovers(txn);
  if (!apps.length) {
    return pass([fact("approvers", 0, "no approvers to check", "لا يوجد معتمِمون للتحقق", "transaction", "txn.approvals")], req, { left: "approvers", op: "exist", right: "in master", result: "none recorded" }, { approverCount: 0 });
  }
  const facts: EvidenceFact[] = [];
  const problemApprovers: { id: string; problem: string }[] = [];
  const unknownApprovers: { id: string; problem: string }[] = [];
  for (const a of apps) {
    const master = indexes.employeeById.get(a.approverId ?? "");
    if (!master) {
      problemApprovers.push({ id: a.approverId ?? "?", problem: "not found in the employee master" });
      facts.push(fact("approver", a.approverId, `approver ${a.approverId} not found in the employee master`, `المعتمِم ${a.approverId} غير موجود في بيانات الموظفين`, "derived", "master", true));
      continue;
    }
    if (!a.approvedAt) {
      unknownApprovers.push({ id: a.approverId ?? "?", problem: "approval timestamp is missing" });
      facts.push(fact("approver", a.approverId, `approver ${a.approverId} has no approval timestamp, so activity at approval time is unknown`, `المعتمِم ${a.approverId} ليس لديه وقت موافقة، لذا نشاطه وقت الموافقة غير معروف`, "transaction", "txn.approvals", false));
      continue;
    }
    const at = instantToDubaiDate(a.approvedAt);
    const ok = activeAt(master, at);
    if (!ok) {
      const reason = master.hireDate && master.hireDate > at
        ? "had not been hired when the approval was recorded"
        : master.exitDate && master.exitDate < at
          ? "had already left when the approval was recorded"
          : "was not active at approval time";
      problemApprovers.push({ id: a.approverId ?? "?", problem: reason });
      facts.push(fact("approver", a.approverId, `approver ${a.approverId} ${reason} (exit ${master.exitDate ?? "?"}, approval ${at})`, `المعتمِم ${a.approverId} لم يكن على رأس عمله وقت الموافقة (المغادرة ${master.exitDate ?? "؟"}، الموافقة ${at})`, "employee_master", "master", true));
    } else {
      facts.push(fact("approver", a.approverId, `approver ${a.approverId} exists and was active at approval time`, `المعتمِم ${a.approverId} موجود وكان على رأس عمله وقت الموافقة`, "employee_master", "master"));
    }
  }
  const slots: FamilyEval["slots"] = { personId: problemApprovers[0]?.id ?? "", problem: problemApprovers[0]?.problem ?? "", approverCount: apps.length };
  const dq: DqCode[] = problemApprovers.some((p) => p.problem === "not found in the employee master") ? ["DQ-005"] : [];
  if (problemApprovers.length > 0) {
    return fail(facts, req, { left: "approvers", op: "exist+active", right: "at approval", result: problemApprovers.map((x) => `${x.id}: ${x.problem}`).join("; ") }, slots, dq);
  }
  if (unknownApprovers.length > 0) {
    return { ...notEvaluable(rule, "C1", facts, { dq: ["DQ-001"], caveats: [{ code: "DQ-001", message: { en: "An approval timestamp is missing, so activity at approval time is unknown.", ar: "وقت الموافقة غير موجود، لذا نشاط المعتمِم وقت الموافقة غير معروف." }, facts: unknownApprovers.map((x) => x.id) }] }), requirement: req };
  }
  return pass(facts, req, { left: "all approvers", op: "exist+active", right: "at approval", result: "met" }, slots);
}

function valueBounds(txn: Transaction, rule: RuleSpec, p: Record<string, unknown>, indexes: EngineIndexes): FamilyEval {
  const pctMax = p.pctMax as number;
  const overrideGrade = (p.approverGradeOverride as number) ?? null;
  const req: FamilyEval["requirement"] = {
    en: `A pay increase of more than ${pctMax}% needs grade ${overrideGrade} approval.`,
    ar: `الزيادة في الراتب التي تتجاوز ${pctMax}% تتطلب موافقة الدرجة ${overrideGrade}.`,
    machine: `${rule.id}:pct<=${pctMax}|approver>=${overrideGrade}`,
  };
  const { pctBps, baseFils, baseSource, caveat, dq } = payChangePct(txn, indexes);
  if (txn.dq.includes("DQ-013") || txn.dq.includes("DQ-009")) {
    return { ...notEvaluable(rule, "C1", [], { dq: txn.dq.filter((d): d is DqCode => d === "DQ-013" || d === "DQ-009"), caveats: txn.caveats }), requirement: req };
  }
  if (pctBps === null || dq) {
    const dqCodes: DqCode[] = dq ? [dq] : ["DQ-001"];
    return { ...notEvaluable(rule, "C1", [], { dq: dqCodes, caveats: [{ code: "DQ-001", message: { en: "The base pay needed for the percentage is missing.", ar: "الراتب الأساسي المطلوب لحساب النسبة غير موجود." }, facts: [] }] }), requirement: req };
  }
  const pctWhole = Math.round(pctBps / 100 * 100) / 100; // 2 dp for display
  const over = pctBps > pctMax * 100;
  const apps = humanApprovers(txn);
  const gradesWithSource = apps.map((a) => approverGrade(txn, a, indexes));
  const dqGrades = gradesWithSource.map((g) => g.dq).filter((x): x is DqCode => x !== null);
  const facts: EvidenceFact[] = [
    fact("amount_fils", txn.amountFils, `AED ${formatAmount(txn.amountFils ?? 0)}`, `${formatAmount(txn.amountFils ?? 0)} درهم`, "transaction", "txn.amount_fils", over),
    fact("base_fils", baseFils, `base AED ${formatAmount(baseFils ?? 0)} (${baseSource})`, `الأساس ${formatAmount(baseFils ?? 0)} درهم (${baseSource === "previous_pay_transaction" ? "من معاملة سابقة" : "من البيانات الرئيسية"})`, "derived", "base"),
    fact("pay_change_pct", pctWhole, `${pctWhole}% increase`, `زيادة ${pctWhole}%`, "derived", "pct", over),
    fact("pct_max", pctMax, `max ${pctMax}%`, `الحد ${pctMax}%`, "config", "rule.pct_max"),
    ...gradesWithSource.map((g, i) => fact("approver_grade", g.ordinal, `approver grade ${g.ordinal ?? "unknown"}`, `درجة المعتمِم ${g.ordinal ?? "غير معروفة"}`, "transaction", `txn.approvals.${i}`, over && (g.ordinal ?? 0) < (overrideGrade ?? 0))),
  ];
  const caveats: Caveat[] = caveat ? [caveat] : [];
  if (over && overrideGrade !== null) {
    const known = gradesWithSource.filter((g) => g.ordinal !== null);
    const meeting = known.find((g) => g.ordinal! >= overrideGrade);
    const slots: FamilyEval["slots"] = { pctBps, pctDisplay: pctWhole, pctMax, baseFils, requiredGrade: overrideGrade, approverGrade: meeting?.ordinal ?? known[0]?.ordinal ?? null, approverId: meeting ? apps[known.indexOf(meeting)]?.approverId ?? null : apps[0]?.approverId ?? null };
    if (meeting) return pass(facts, req, { left: `${pctWhole}% with grade ${meeting.ordinal} approver`, op: "override", right: `grade ${overrideGrade}`, result: "approved at the required grade" }, slots, dqGrades, caveats);
    if (known.length < apps.length) {
      // An unknown grade could meet the override: never guess.
      return { ...notEvaluable(rule, "C1", facts, { dq: dqGrades.length ? dqGrades : ["DQ-001"], caveats }), requirement: req };
    }
    return fail(facts, req, { left: `${pctWhole}%`, op: ">", right: `${pctMax}% without grade ${overrideGrade}`, result: known.length ? "increase over the bound without the required grade" : "increase over the bound with no approval" }, slots, dqGrades, caveats);
  }
  const slots2: FamilyEval["slots"] = { pctBps, pctDisplay: pctWhole, pctMax, baseFils, requiredGrade: overrideGrade };
  if (!over) return pass(facts, req, { left: `${pctWhole}%`, op: "≤", right: `${pctMax}%`, result: "within the bound" }, slots2, dqGrades, caveats);
  return fail(facts, req, { left: `${pctWhole}%`, op: ">", right: `${pctMax}%`, result: "over the bound" }, slots2, dqGrades, caveats);
}

export function employeeGradeOrdinal(emp: Employee | null): number | null {
  return emp?.gradeOrdinal ?? null;
}

export { UAE_CALENDAR };
