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
  submittedDate, firstApprovalInstant,
} from "./facts";
import { diffDays, instantToDubaiDate, type LocalDate } from "../domain/dates";
import { UAE_CALENDAR, dateOutsideCalendar } from "../domain/calendar";
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

function approvalLimit(txn: Transaction, rule: RuleSpec, p: Record<string, unknown>, indexes: EngineIndexes): FamilyEval {
  const minGrade = p.minApproverGrade as number;
  const quantifier = (p.quantifier as string) ?? "any";
  const thresholdFils = (rule.scope.where as { all: { value: number }[] } | undefined)?.all?.[0]?.value ?? null;
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
  const apps = humanApprovers(txn);
  if (apps.length === 0 && txn.approvals !== null) {
    // No approvals recorded: approval rules fail (EC-B13)
    return fail(
      [fact("amount_fils", txn.amountFils, `AED ${(txn.amountFils / 100).toLocaleString("en-US")}`, `${(txn.amountFils / 100).toLocaleString("en-US")} درهم`, "transaction", "txn.amount_fils", true),
       fact("approver_count", 0, "no approvals recorded", "لا توجد موافقات مسجلة", "transaction", "txn.approvals", true),
       fact("required_grade", minGrade, `grade ${minGrade}`, `الدرجة ${minGrade}`, "config", "rule.required_grade")],
      req,
      { left: "approver grades", op: "≥", right: String(minGrade), result: "no approvals" },
      { amountFils: txn.amountFils, thresholdFils, requiredGrade: minGrade, approverId: null, approverGrade: null, approverCount: 0 }
    );
  }
  const gradesWithSource = apps.map((a) => ({ a, g: approverGrade(txn, a, indexes) }));
  const caveats = gradesWithSource.map((x) => x.g.caveat).filter(Boolean) as Caveat[];
  const dq: DqCode[] = gradesWithSource.map((x) => x.g.dq).filter((x): x is DqCode => x !== null);
  const knownGrades = gradesWithSource.filter((x) => x.g.ordinal !== null);
  const facts: EvidenceFact[] = [
    fact("amount_fils", txn.amountFils, `AED ${(txn.amountFils! / 100).toLocaleString("en-US")}`, `${(txn.amountFils! / 100).toLocaleString("en-US")} درهم`, "transaction", "txn.amount_fils", txn.amountFils! > (thresholdFils ?? 0)),
    fact("threshold_fils", thresholdFils, `AED ${((thresholdFils ?? 0) / 100).toLocaleString("en-US")}`, `${((thresholdFils ?? 0) / 100).toLocaleString("en-US")} درهم`, "config", "rule.threshold"),
    fact("required_grade", minGrade, `grade ${minGrade}`, `الدرجة ${minGrade}`, "config", "rule.required_grade"),
  ];
  for (const x of gradesWithSource) {
    facts.push(fact("approver_grade", x.g.ordinal, `${x.a.approverId} is ${x.g.ordinal === null ? "of unknown grade" : `grade ${x.g.ordinal}`} (from ${x.g.source === "transaction" ? "transaction" : "master"})`, `${x.a.approverId} ${x.g.ordinal === null ? "بدرجة غير معروفة" : `من الدرجة ${x.g.ordinal}`} (من ${x.g.source === "transaction" ? "المعاملة" : "البيانات الرئيسية"})`, x.g.source === "transaction" ? "transaction" : "employee_master", `txn.approvals.${x.a.approverId}`, x.g.ordinal !== null && x.g.ordinal < minGrade));
  }
  if (dq.includes("DQ-005") || dq.includes("DQ-011")) {
    return { ...notEvaluable(rule, "C1", facts, { dq, caveats }), requirement: req };
  }
  if (quantifier === "any") {
    if (knownGrades.length === 0) return { ...notEvaluable(rule, "C1", facts, { dq: ["DQ-001"], caveats }), requirement: req };
    const meets = knownGrades.some((x) => x.g.ordinal! >= minGrade);
    const slots: FamilyEval["slots"] = {
      amountFils: txn.amountFils, thresholdFils, requiredGrade: minGrade,
      approverId: knownGrades[0]!.a.approverId, approverGrade: knownGrades[0]!.g.ordinal, approverCount: apps.length,
    };
    if (meets) {
      return pass(facts, req, { left: "approver grades", op: "≥", right: String(minGrade), result: "an approver meets the grade" }, slots, dq, caveats);
    }
    const breaching = knownGrades.filter((x) => x.g.ordinal! < minGrade);
    slots.approverId = breaching[0]?.a.approverId ?? slots.approverId;
    slots.approverGrade = breaching[0]?.g.ordinal ?? slots.approverGrade;
    return fail(facts, req, { left: gradeListDisplay(knownGrades.map((x) => x.g.ordinal)), op: "≥", right: String(minGrade), result: "no approver meets the grade" }, slots, dq, caveats);
  }
  // quantifier "all"
  if (knownGrades.length < apps.length) return { ...notEvaluable(rule, "C1", facts, { dq: ["DQ-001"], caveats }), requirement: req };
  const allMeet = knownGrades.every((x) => x.g.ordinal! >= minGrade);
  const slots2: FamilyEval["slots"] = { amountFils: txn.amountFils, thresholdFils, requiredGrade: minGrade, approverId: apps[0]?.approverId ?? null, approverGrade: knownGrades[0]?.g.ordinal ?? null, approverCount: apps.length };
  return (allMeet ? pass : fail)(facts, req, { left: gradeListDisplay(knownGrades.map((x) => x.g.ordinal)), op: "≥", right: String(minGrade), result: allMeet ? "all approvers meet the grade" : "an approver is below the grade" }, slots2, dq, caveats);
}

function approvalCount(txn: Transaction, rule: RuleSpec, p: Record<string, unknown>, indexes: EngineIndexes): FamilyEval {
  const minDistinct = p.minDistinct as number;
  const requiredRoles = p.requiredRoles as string[];
  const req: FamilyEval["requirement"] = {
    en: `At least ${minDistinct} distinct approvers covering ${requiredRoles.join(" and ")} are required.`,
    ar: `يلزم ${minDistinct} معتمِمين مختلفين على الأقيق يغطون ${requiredRoles.join(" و ")}.`,
    machine: `${rule.id}:distinct>=${minDistinct};roles=${requiredRoles.join("+")}`,
  };
  const apps = humanApprovers(txn);
  const rolesFound = new Set<string>();
  const emp = indexes.employeeById.get(txn.employeeId);
  for (const a of apps) {
    if (a.role === "HRBP" || indexes.employeeById.get(a.approverId ?? "")?.roles.includes("HRBP")) rolesFound.add("HRBP");
    if (a.role === "LINE_MANAGER" || (emp?.managerId && a.approverId === emp.managerId)) rolesFound.add("LINE_MANAGER");
  }
  const distinct = new Set(apps.map((a) => a.approverId));
  const facts: EvidenceFact[] = [
    fact("approver_count", distinct.size, `${distinct.size} distinct approver(s)`, `${distinct.size} معتمِم مختلف`, "transaction", "txn.approvals", distinct.size < minDistinct),
    ...requiredRoles.map((r) => fact(`role_${r}`, rolesFound.has(r), `${r} ${rolesFound.has(r) ? "present" : "missing"}`, `${r === "HRBP" ? "شريك الموارد البشرية" : "المدير المباشر"} ${rolesFound.has(r) ? "موجود" : "غير موجود"}`, "derived", `roles.${r}`, !rolesFound.has(r))),
  ];
  const missingRoles = requiredRoles.filter((r) => !rolesFound.has(r));
  const slots: FamilyEval["slots"] = { approverCount: distinct.size, rolesFound: [...rolesFound].join(", "), rolesMissing: missingRoles.join(", "), minDistinct, requiredRoles: requiredRoles.join(", ") };
  if (missingRoles.length === 0 && distinct.size >= minDistinct) return pass(facts, req, { left: `${distinct.size} distinct, roles ${[...rolesFound].join("+")}`, op: "≥", right: `${minDistinct} + ${requiredRoles.join("+")}`, result: "met" }, slots);
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
  if (emp && indexes.cycleEmployees.has(emp.employeeId)) {
    return { ...notEvaluable(rule, "C1", [], { dq: ["DQ-010"], caveats: [{ code: "DQ-010", message: { en: "The management chain has a cycle for this employee.", ar: "سلسلة الإدارة تحتوي على حلقة لهذا الموظف." }, facts: [emp.employeeId] }] }), requirement: req };
  }
  const lineMgr = emp?.managerId ?? null;
  const recMgr = (txn.passthrough.receiving_manager_id ?? null) || null;
  const linePresent = lineMgr ? approverIds.has(lineMgr) : false;
  const recPresent = recMgr ? approverIds.has(recMgr) : false;
  const clause = clauseId === "C2" ? "C2" : "C1";
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
  const apps = humanApprovers(txn);
  const requester = txn.requesterId;
  const beneficiary = txn.employeeId;
  if (requester === null) {
    return { ...notEvaluable(rule, clauseId, [], { dq: ["DQ-001"], caveats: [] }), requirement: req };
  }
  const clause = clauseId === "C2" ? "C2" : "C1";
  if (clause === "C1") {
    const offender = apps.find((a) => a.approverId === requester) ?? null;
    const facts: EvidenceFact[] = [
      fact("requester_id", requester, `requester ${requester}`, `الطالب ${requester}`, "transaction", "txn.requester_id", !!offender),
      ...apps.map((a) => fact("approver_id", a.approverId, `approver ${a.approverId}`, `المعتمِم ${a.approverId}`, "transaction", "txn.approvals", a.approverId === requester)),
    ];
    const slots: FamilyEval["slots"] = { requesterId: requester, approverId: offender?.approverId ?? null, employeeId: beneficiary, actor: offender?.approverId ?? requester };
    if (!offender) return pass(facts, req, { left: "requester", op: "≠", right: "approvers", result: "independent" }, slots);
    return fail(facts, req, { left: `requester ${requester}`, op: "≠", right: `approver ${offender.approverId}`, result: "the same person" }, slots);
  }
  const offender = apps.find((a) => a.approverId === beneficiary) ?? null;
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
    if (c.when.fact === "employee.nationality") {
      if (!nationality) { conditionMissing = true; continue; }
      if (c.when.op === "ne" && nationality !== c.when.value && !attached.has(c.document)) missing.push(c.document);
    }
  }
  if (conditionMissing) {
    return { ...notEvaluable(rule, "C1", [], { dq: ["DQ-001"], caveats: [{ code: "DQ-001", message: { en: "Nationality is missing, so the conditional visa requirement cannot be decided.", ar: "الجنسية غير موجودة، لذا لا يمكن تحديد شرط التأشيرة." }, facts: [] }] }), requirement: req };
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
  const maxDays = p.maxDays as number;
  const req: FamilyEval["requirement"] = {
    en: `Backdating must not exceed ${maxDays} days.`,
    ar: `يجب ألا يتجاوز التأريخ المسبق ${maxDays} يوماً.`,
    machine: `${rule.id}:backdated<=${maxDays}`,
  };
  const eff = txn.effectiveDate;
  const sub = submittedDate(txn);
  if (!eff || !sub) {
    return { ...notEvaluable(rule, "C1", [], { dq: ["DQ-001"], caveats: [] }), requirement: req };
  }
  const backdated = diffDays(sub, eff); // positive = effective before submission
  const isBackdated = backdated > 0;
  const within = backdated <= maxDays;
  const facts: EvidenceFact[] = [
    fact("effective_date", eff, `effective ${eff}`, `السريان ${eff}`, "transaction", "txn.effective_date", isBackdated && !within),
    fact("submitted_date", sub, `submitted ${sub}`, `الإرسال ${sub}`, "transaction", "txn.submitted_at"),
    fact("backdated_days", Math.max(0, backdated), `${Math.max(0, backdated)} day(s) backdated`, `${Math.max(0, backdated)} يوم تأريخ مسبق`, "derived", "submitted−effective", isBackdated && !within),
    fact("max_days", maxDays, `${maxDays} days allowed`, `${maxDays} يوماً مسموح`, "config", "rule.max_days"),
  ];
  const caveats: Caveat[] = [];
  if (dateOutsideCalendar(eff)) {
    caveats.push({ code: "DQ-015", message: { en: "The effective date is outside the loaded calendar years.", ar: "تاريخ السريان خارج سنوات التقويم المحمّلة." }, facts: [eff] });
  }
  const slots: FamilyEval["slots"] = { effectiveDate: eff, submittedDate: sub, backdatedDays: Math.max(0, backdated), maxDays };
  if (!isBackdated || within) return pass(facts, req, { left: `${Math.max(0, backdated)} days`, op: "≤", right: `${maxDays} days`, result: "within the window" }, slots, [], caveats);
  return fail(facts, req, { left: `${backdated} days`, op: "≤", right: `${maxDays} days`, result: "backdating exceeds the window" }, slots, [], caveats);
}

function sequence(txn: Transaction, rule: RuleSpec, p: Record<string, unknown>, _indexes: EngineIndexes): FamilyEval {
  void p;
  const req: FamilyEval["requirement"] = {
    en: "The approval must be recorded after the transaction is submitted.",
    ar: "يجب تسجيل الموافقة بعد إرسال المعاملة.",
    machine: `${rule.id}:approvedAt>submittedAt`,
  };
  const { instant: approvedAt, precision } = firstApprovalInstant(txn);
  if (!txn.submittedAt) {
    return { ...notEvaluable(rule, "C1", [], { dq: ["DQ-001"], caveats: [{ code: "DQ-001", message: { en: "Submission time is missing; the order cannot be checked.", ar: "وقت الإرسال غير موجود؛ لا يمكن التحقق من الترتيب." }, facts: [] }] }), requirement: req };
  }
  if (txn.approvals !== null && txn.approvals.length > 0 && !approvedAt) {
    // Approver present but timestamp missing (EC-D14): authority rules still evaluate; sequence NOT_EVALUABLE
    return { ...notEvaluable(rule, "C1", [], { dq: ["DQ-001"], caveats: [{ code: "DQ-001", message: { en: "Approval timestamp is missing; the order cannot be checked.", ar: "وقت الموافقة غير موجود؛ لا يمكن التحقق من الترتيب." }, facts: [] }] }), requirement: req };
  }
  if (!approvedAt) {
    // zero approvals → nothing recorded after submission → FAIL (EC-B13)
    return fail(
      [fact("approvals", 0, "no approvals recorded", "لا توجد موافقات مسجلة", "transaction", "txn.approvals", true)],
      req, { left: "approval", op: ">", right: "submission", result: "no approval recorded" },
      { approvedAt: null, submittedAt: txn.submittedAt, zeroApprovals: true }
    );
  }
  const approvedDate = instantToDubaiDate(approvedAt);
  const submittedDubai = instantToDubaiDate(txn.submittedAt);
  const dayPrecision = precision === "date" || txn.submittedPrecision === "date";
  const after = approvedAt > txn.submittedAt;
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
  const critical = approvedAt < txn.submittedAt; // strictly before submission
  return fail(facts, req, { left: "approval", op: ">", right: "submission", result: critical ? "approval recorded before submission" : "approval recorded at the same instant" }, { ...slots, approvalBeforeSubmission: critical }, [], caveats);
}

function eligibility(txn: Transaction, rule: RuleSpec, p: Record<string, unknown>, indexes: EngineIndexes): FamilyEval {
  const allowedStatuses = p.allowedStatuses as string[];
  const req: FamilyEval["requirement"] = {
    en: "The employee must be active on the effective date.",
    ar: "يجب أن يكون الموظف على رأس العمل في تاريخ السريان.",
    machine: `${rule.id}:status@effective∈{${allowedStatuses.join(",")}}`,
  };
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
  const effActive = activeAt(emp, eff);
  const caveats: Caveat[] = [];
  if (eff > (txn.effectiveDate ? eff : eff)) void caveats;
  const facts: EvidenceFact[] = [
    fact("employee_id", emp.employeeId, `employee ${emp.employeeId}`, `الموظف ${emp.employeeId}`, "employee_master", "employee.id"),
    fact("hire_date", emp.hireDate, emp.hireDate ? `hired ${emp.hireDate}` : "hire date unknown", emp.hireDate ? `التعيين ${emp.hireDate}` : "تاريخ التعيين غير معروف", "employee_master", "employee.hire_date"),
    fact("exit_date", emp.exitDate, emp.exitDate ? `exit ${emp.exitDate}` : "no exit date", emp.exitDate ? `المغادرة ${emp.exitDate}` : "لا يوجد تاريخ مغادرة", "employee_master", "employee.exit_date", !effActive),
    fact("effective_date", eff, `effective ${eff}`, `السريان ${eff}`, "transaction", "txn.effective_date", !effActive),
    fact("status_at_effective", effActive ? "ACTIVE" : "NOT_ACTIVE", effActive ? "active on the effective date" : "not active on the effective date", effActive ? "على رأس العمل في تاريخ السريان" : "ليس على رأس العمل في تاريخ السريان", "derived", "spells@effective", !effActive),
  ];
  const slots: FamilyEval["slots"] = { employeeId: emp.employeeId, exitDate: emp.exitDate, hireDate: emp.hireDate, effectiveDate: eff, statusAt: effActive ? "ACTIVE" : "NOT_ACTIVE" };
  if (effActive) return pass(facts, req, { left: "status at effective date", op: "∈", right: allowedStatuses.join("|"), result: "active" }, slots);
  return fail(facts, req, { left: "status at effective date", op: "∈", right: allowedStatuses.join("|"), result: "not active" }, slots);
}

function aggregateLimit(txn: Transaction, rule: RuleSpec, p: Record<string, unknown>, indexes: EngineIndexes): FamilyEval {
  const windowDays = p.windowDays as number;
  const max = p.max as number;
  const req: FamilyEval["requirement"] = {
    en: `At most ${max} allowance changes per employee in any ${Math.round(windowDays / 30)}-month period.`,
    ar: `${max} تغييرات على البدل كحد أقصى لكل موظف في أي فترة ${Math.round(windowDays / 30)} أشهر.`,
    machine: `${rule.id}:count@${windowDays}d<=${max}`,
  };
  const agg = rollingAggregate(txn, indexes, windowDays);
  if (!txn.effectiveDate) {
    return { ...notEvaluable(rule, "C1", [], { dq: ["DQ-001"], caveats: [] }), requirement: req };
  }
  const facts: EvidenceFact[] = [
    fact("count_in_window", agg.count, `${agg.count} changes in the window`, `${agg.count} تغييرات في النافذة`, "derived", "aggregate.count", agg.count > max),
    fact("max", max, `max ${max}`, `الحد ${max}`, "config", "rule.max"),
    fact("contributing", agg.contributing.join(", "), `contributing: ${agg.contributing.join(", ")}`, `المساهِمات: ${agg.contributing.join("، ")}`, "derived", "aggregate.contributing", agg.count > max),
  ];
  const slots: FamilyEval["slots"] = { count: agg.count, max, windowDays, contributing: agg.contributing.join(", "), employeeId: txn.employeeId, windowStart: txn.effectiveDate };
  if (agg.count <= max) return pass(facts, req, { left: `${agg.count} changes`, op: "≤", right: `${max}`, result: "within the limit" }, slots);
  return fail(facts, req, { left: `${agg.count} changes`, op: "≤", right: `${max}`, result: "the limit is exceeded" }, slots);
}

function duplicate(txn: Transaction, rule: RuleSpec, p: Record<string, unknown>, indexes: EngineIndexes): FamilyEval {
  const toleranceDays = p.toleranceDays as number;
  const flag = (p.flag as string) ?? "later";
  const req: FamilyEval["requirement"] = {
    en: `The same change must not be entered twice within ${toleranceDays} days.`,
    ar: `يجب عدم إدخال نفس التغيير مرتين خلال ${toleranceDays} أيام.`,
    machine: `${rule.id}:twin@${toleranceDays}d flag:${flag}`,
  };
  if (txn.amountFils === null || txn.effectiveDate === null || txn.dq.includes("DQ-013")) {
    return { ...notEvaluable(rule, "C1", [], { dq: ["DQ-013"], caveats: [{ code: "DQ-013", message: { en: "The amount is ambiguous, so duplicate matching cannot run.", ar: "المبلغ غامض، لذا تعذر تشغيل مطابقة التكرار." }, facts: [] }] }), requirement: req };
  }
  const twins = duplicateTwins(txn, indexes, toleranceDays);
  if (twins.length === 0) {
    return pass(
      [fact("twins", 0, "no duplicate entries found", "لا توجد إدخالات مكررة", "derived", "duplicate.twins")],
      req, { left: "twins", op: "=", right: "0", result: "none" }, { twins: 0 }
    );
  }
  const laterOf = (a: Transaction, b: Transaction) => (isLaterTwin(a, b) ? a : b);
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
    void laterOf;
  }
  const daysApart = Math.abs(diffDays(flagged.effectiveDate!, cited.effectiveDate!));
  const facts: EvidenceFact[] = [
    fact("txn_a", cited.txnId, `earlier ${cited.txnId} effective ${cited.effectiveDate}`, `الأقدم ${cited.txnId} سريان ${cited.effectiveDate}`, "transaction", "twins"),
    fact("txn_b", flagged.txnId, `this ${flagged.txnId} effective ${flagged.effectiveDate}`, `الحالية ${flagged.txnId} سريان ${flagged.effectiveDate}`, "transaction", "txn", true),
    fact("amount_fils", flagged.amountFils, `AED ${((flagged.amountFils ?? 0) / 100).toLocaleString("en-US")}`, `${((flagged.amountFils ?? 0) / 100).toLocaleString("en-US")} درهم`, "transaction", "txn.amount_fils"),
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
  const apps = humanApprovers(txn);
  if (!apps.length) {
    return pass([fact("approvers", 0, "no approvers to check", "لا يوجد معتمِمون للتحقق", "transaction", "txn.approvals")], req, { left: "approvers", op: "exist", right: "in master", result: "none recorded" }, { approverCount: 0 });
  }
  const facts: EvidenceFact[] = [];
  const problemApprovers: { id: string; problem: string }[] = [];
  for (const a of apps) {
    const master = indexes.employeeById.get(a.approverId ?? "");
    if (!master) {
      problemApprovers.push({ id: a.approverId ?? "?", problem: "not found in the employee master" });
      facts.push(fact("approver", a.approverId, `approver ${a.approverId} not found in the employee master`, `المعتمِم ${a.approverId} غير موجود في بيانات الموظفين`, "derived", "master", true));
      continue;
    }
    const at = a.approvedAt ? instantToDubaiDate(a.approvedAt) : txn.effectiveDate;
    const ok = at ? activeAt(master, at) : false;
    if (!ok) {
      const reason = master.exitDate && at && master.exitDate < at ? "had already left when the approval was recorded" : "was not active at approval time";
      problemApprovers.push({ id: a.approverId ?? "?", problem: reason });
      facts.push(fact("approver", a.approverId, `approver ${a.approverId} ${reason} (exit ${master.exitDate ?? "?"}, approval ${at ?? "?"})`, `المعتمِم ${a.approverId} ${reason === "had already left when the approval was recorded" ? "كان قد غادر عند تسجيل الموافقة" : "لم يكن على رأس عمله وقت الموافقة"} (المغادرة ${master.exitDate ?? "؟"}، الموافقة ${at ?? "؟"})`, "employee_master", "master", true));
    } else {
      facts.push(fact("approver", a.approverId, `approver ${a.approverId} exists and was active at approval time`, `المعتمِم ${a.approverId} موجود وكان على رأس عمله وقت الموافقة`, "employee_master", "master"));
    }
  }
  const slots: FamilyEval["slots"] = { personId: problemApprovers[0]?.id ?? "", problem: problemApprovers[0]?.problem ?? "", approverCount: apps.length };
  if (problemApprovers.length === 0) return pass(facts, req, { left: "all approvers", op: "exist+active", right: "at approval", result: "met" }, slots);
  return fail(facts, req, { left: "approvers", op: "exist+active", right: "at approval", result: problemApprovers.map((x) => `${x.id}: ${x.problem}`).join("; ") }, slots);
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
    fact("amount_fils", txn.amountFils, `AED ${((txn.amountFils ?? 0) / 100).toLocaleString("en-US")}`, `${((txn.amountFils ?? 0) / 100).toLocaleString("en-US")} درهم`, "transaction", "txn.amount_fils", over),
    fact("base_fils", baseFils, `base AED ${((baseFils ?? 0) / 100).toLocaleString("en-US")} (${baseSource})`, `الأساس ${((baseFils ?? 0) / 100).toLocaleString("en-US")} درهم (${baseSource === "previous_pay_transaction" ? "من معاملة سابقة" : "من البيانات الرئيسية"})`, "derived", "base"),
    fact("pay_change_pct", pctWhole, `${pctWhole}% increase`, `زيادة ${pctWhole}%`, "derived", "pct", over),
    fact("pct_max", pctMax, `max ${pctMax}%`, `الحد ${pctMax}%`, "config", "rule.pct_max"),
    ...gradesWithSource.map((g, i) => fact("approver_grade", g.ordinal, `approver grade ${g.ordinal ?? "unknown"}`, `درجة المعتمِم ${g.ordinal ?? "غير معروفة"}`, "transaction", `txn.approvals.${i}`, over && (g.ordinal ?? 0) < (overrideGrade ?? 0))),
  ];
  const caveats: Caveat[] = caveat ? [caveat] : [];
  if (over && overrideGrade !== null) {
    if (dqGrades.includes("DQ-005") || dqGrades.includes("DQ-011")) {
      return { ...notEvaluable(rule, "C1", facts, { dq: dqGrades, caveats }), requirement: req };
    }
    const known = gradesWithSource.filter((g) => g.ordinal !== null);
    if (!known.length) return { ...notEvaluable(rule, "C1", facts, { dq: ["DQ-001"], caveats }), requirement: req };
    const meets = known.some((g) => g.ordinal! >= overrideGrade!);
    const slots: FamilyEval["slots"] = { pctBps, pctDisplay: pctWhole, pctMax, baseFils, requiredGrade: overrideGrade, approverGrade: known[0]!.ordinal, approverId: apps[0]?.approverId ?? null };
    if (meets) return pass(facts, req, { left: `${pctWhole}% with grade ${known[0]!.ordinal} approver`, op: "override", right: `grade ${overrideGrade}`, result: "approved at the required grade" }, slots, [], caveats);
    return fail(facts, req, { left: `${pctWhole}%`, op: ">", right: `${pctMax}% without grade ${overrideGrade}`, result: "increase over the bound without the required grade" }, slots, [], caveats);
  }
  const slots2: FamilyEval["slots"] = { pctBps, pctDisplay: pctWhole, pctMax, baseFils, requiredGrade: overrideGrade };
  if (!over) return pass(facts, req, { left: `${pctWhole}%`, op: "≤", right: `${pctMax}%`, result: "within the bound" }, slots2, [], caveats);
  return fail(facts, req, { left: `${pctWhole}%`, op: ">", right: `${pctMax}%`, result: "over the bound" }, slots2, [], caveats);
}

export function employeeGradeOrdinal(emp: Employee | null): number | null {
  return emp?.gradeOrdinal ?? null;
}

export { UAE_CALENDAR };
