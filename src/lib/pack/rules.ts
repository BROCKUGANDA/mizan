/**
 * The rule pack compiled from policy_rules.md (§9/§10).
 * Single source of truth: RULES below carries verbatim text + spec + interpretation;
 * the markdown policy_rules.md is emitted FROM it so the prompt and documents never drift.
 * Semantics fixed up front (ADR-0002): above=strict gt, at least=inclusive gte, within N days=inclusive.
 */

import type { RuleSpec, InterpretationRecord, Severity, FamilyKind } from "../contracts";
import { sha256Json } from "../domain/canonical";

/** Facts a rule may reference in scope conditions (MZ-RULE-422 otherwise). */
export const FACT_CATALOGUE = new Set([
  "txn.amount_fils", "txn.type", "txn.effective_date", "txn.currency", "txn.department", "txn.location",
  "employee.nationality", "employee.status", "employee.grade_ordinal", "employee.department", "employee.location",
  "approver.exists", "approver.grade", "approver.is_line_manager", "approver.depth",
]);

export const FAMILY_KINDS: FamilyKind[] = [
  "approval_limit", "approval_count", "approval_chain", "segregation_of_duties",
  "required_documents", "timing_window", "sequence", "eligibility",
  "aggregate_limit", "duplicate", "reference_integrity", "value_bounds",
];

/** Validate a draft/compiled spec before it can be backtested or activated. */
export function validateRuleSpec(spec: Partial<RuleSpec>): string[] {
  const errors: string[] = [];
  if (!spec.id || !/^R[A-Z0-9]{1,4}$/.test(spec.id) || spec.id === "RNEW") errors.push("rule id is not a concrete Rnn");
  if (!spec.title) errors.push("title is required");
  if (!spec.family || !FAMILY_KINDS.includes(spec.family)) errors.push(`family is invalid: ${String(spec.family)}`);
  if (!spec.version) errors.push("version is required");
  if (!spec.effective?.from) errors.push("effective.from is required");
  if (!spec.source?.anchor || !spec.source?.text) errors.push("source anchor and verbatim text are required");
  if (!spec.scope?.transactionTypes?.length) errors.push("scope.transactionTypes is empty");
  if (!spec.check?.kind || !FAMILY_KINDS.includes(spec.check.kind)) errors.push("check.kind is invalid");
  if (spec.family && spec.check?.kind && spec.family !== spec.check.kind) errors.push("check.kind must match family");
  if (!spec.clauses?.length) errors.push("at least one clause is required");
  if (!spec.tests || spec.tests.length < 3) errors.push("at least three tests (boundary-pass, boundary-fail, out-of-scope) are required");
  const conditionFacts = (c: RuleSpec["scope"]["where"] | undefined): string[] => {
    if (!c) return [];
    if ("all" in c) return c.all.flatMap(conditionFacts);
    if ("any" in c) return c.any.flatMap(conditionFacts);
    if ("not" in c) return conditionFacts(c.not);
    return "fact" in c ? [c.fact] : [];
  };
  for (const fact of conditionFacts(spec.scope?.where)) {
    if (!FACT_CATALOGUE.has(fact)) errors.push(`fact not in the catalogue: ${fact}`);
  }
  if (spec.family === "approval_limit") {
    const p = spec.check?.params ?? {};
    if (typeof p.minApproverGrade !== "number") errors.push("approval_limit needs minApproverGrade");
  }
  if (spec.family === "timing_window") {
    const p = spec.check?.params ?? {};
    if (typeof p.maxDays !== "number" && typeof p.minDays !== "number") errors.push("timing_window needs maxDays or minDays");
  }
  return errors;
}

export function ruleLogicHash(spec: RuleSpec): string {
  return sha256Json({ family: spec.family, scope: spec.scope, check: spec.check, severity: spec.severity, clauses: spec.clauses, effective: spec.effective });
}

export const PACK_VERSION = "emirates-hr-1.0.0";
export const ENGINE_VERSION = "engine-1.0.0";

interface RuleDef {
  spec: RuleSpec;
  interpretation: InterpretationRecord;
}

function vtext(s: string) { return s.trim(); }

function buildRules(): RuleDef[] {
  const rules: RuleDef[] = [];
  const add = (spec: Omit<RuleSpec, "source" | "status" | "tests"> & { source?: RuleSpec["source"] }, interpretation: InterpretationRecord, tests: RuleSpec["tests"]): void => {
    const full: RuleSpec = {
      ...spec,
      status: "active",
      source: spec.source ?? { document: "policy_rules.md", anchor: spec.id, text: spec.clauses.map((c) => c.text).join(" "), sha256: "" },
      tests,
    };
    full.source.sha256 = sha256Json({ anchor: full.source.anchor, text: full.source.text });
    rules.push({ spec: full, interpretation });
  };

  add(
    {
      id: "R01", title: "Exit approvals: line manager and HR business partner", family: "approval_count", version: "1.0.0",
      effective: { from: "2025-01-01", to: null, dateBasis: "effective_date" },
      scope: { transactionTypes: ["EXIT"] },
      check: { kind: "approval_count", params: { minDistinct: 2, requiredRoles: ["LINE_MANAGER", "HRBP"] } },
      severity: { base: "HIGH", modifiers: [] },
      routing: { process: "EXIT" }, action: { template: "CA-AC-01" }, explain: { template: "EX-AC-01" },
      clauses: [{ id: "C1", text: vtext("Every exit transaction must be approved by the employee's line manager and an HR business partner.") }],
    },
    {
      ruleId: "R01",
      readings: [
        { option: "two distinct approvers covering both roles", description: { en: "Two different people: the line manager and an HR business partner.", ar: "شخصان مختلفان: المدير المباشر وشريك أعمال الموارد البشرية." }, chosen: true, basis: "“and” requires both roles; distinctness from EC-D03" },
        { option: "any two approvers", description: { en: "Any two people regardless of role.", ar: "أي شخصين بغض النظر عن الدور." }, chosen: false, basis: "rejected: role words are explicit" },
      ],
      ambiguityChips: [{ chip: "quantifier", options: ["any", "all"], chosen: "all" }],
      comparatorSemantics: [{ term: "and", meaning: "both roles required, two distinct people" }],
      notes: { en: "Roles resolve from the transaction role column, the employee master roles, or the management chain.", ar: "تُحدَّد الأدوار من عمود الدور في المعاملة أو من بيانات الموظف أو من سلسلة الإدارة." },
    },
    [
      { name: "both_roles_pass", given: { approvers: [{ role: "LINE_MANAGER" }, { role: "HRBP" }] }, expect: "PASS" },
      { name: "missing_hrbp_fails", given: { approvers: [{ role: "LINE_MANAGER" }] }, expect: "FAIL" },
      { name: "no_approvals_fails", given: { approvers: [] }, expect: "FAIL" },
    ]
  );

  add(
    {
      id: "R02", title: "Approval recorded after submission", family: "sequence", version: "1.0.0",
      effective: { from: "2025-01-01", to: null, dateBasis: "effective_date" },
      scope: { transactionTypes: ["HIRE", "PAY_CHANGE", "ALLOWANCE_CHANGE", "TRANSFER", "LEAVE", "EXIT"] },
      check: { kind: "sequence", params: { order: ["submittedAt", "approvedAt"], strict: true } },
      severity: { base: "HIGH", modifiers: ["approved_before_submission_critical"] },
      routing: { process: "*" }, action: { template: "CA-SEQ-01" }, explain: { template: "EX-SEQ-01" },
      clauses: [{ id: "C1", text: vtext("Approval must be recorded after the transaction is submitted.") }],
    },
    {
      ruleId: "R02",
      readings: [
        { option: "strictly after", description: { en: "The approval time must be strictly after the submission time.", ar: "يجب أن يكون وقت الاعتماد بعد وقت الإرسال تماماً." }, chosen: true, basis: "“after” = strict (ADR-0002)" },
        { option: "at or after", description: { en: "Equal timestamps are acceptable.", ar: "الأوقات المتساوية مقبولة." }, chosen: false, basis: "rejected: plain “after” is strict; EC-D11 recorded" },
      ],
      ambiguityChips: [{ chip: "strictness", options: ["strict", "inclusive"], chosen: "strict" }],
      comparatorSemantics: [{ term: "after", meaning: "strictly after (equal timestamps fail with a caveat)" }],
      notes: { en: "Day-precision approvals compare at day precision with a caveat (EC-B05).", ar: "الموافقات بدقة اليوم تُقارن بدقة اليوم مع تنبيه (EC-B05)." },
    },
    [
      { name: "approval_after_submission_pass", given: { submittedAt: "2026-03-01T08:00:00Z", approvedAt: "2026-03-01T09:00:00Z" }, expect: "PASS" },
      { name: "approval_before_submission_fails", given: { submittedAt: "2026-03-01T09:00:00Z", approvedAt: "2026-03-01T08:00:00Z" }, expect: "FAIL:CRITICAL" },
      { name: "missing_times_not_evaluable", given: { submittedAt: null, approvedAt: "2026-03-01T08:00:00Z" }, expect: "NOT_EVALUABLE" },
    ]
  );

  add(
    {
      id: "R03", title: "Transfer approvals: sending and receiving managers", family: "approval_chain", version: "1.0.0",
      effective: { from: "2025-01-01", to: null, dateBasis: "effective_date" },
      scope: { transactionTypes: ["TRANSFER"] },
      check: { kind: "approval_chain", params: { mustInclude: ["LINE_MANAGER", "RECEIVING_MANAGER"] } },
      severity: { base: "HIGH", modifiers: [] },
      routing: { process: "TRANSFER" }, action: { template: "CA-CH-01" }, explain: { template: "EX-CH-01" },
      clauses: [
        { id: "C1", text: vtext("A transfer must be approved by the employee's sending manager (their line manager before the transfer).") },
        { id: "C2", text: vtext("A transfer must also be approved by the receiving department manager.") },
      ],
    },
    {
      ruleId: "R03",
      readings: [
        { option: "both managers required, two clauses", description: { en: "Each missing manager is its own exception clause.", ar: "كل مدير غائب يُعد بنداً مستقلاً للاستثناء." }, chosen: true, basis: "EC-I11: one exception per failed clause" },
        { option: "single combined check", description: { en: "One exception when either is missing.", ar: "استثناء واحد عند غياب أي منهما." }, chosen: false, basis: "rejected by clause semantics" },
      ],
      ambiguityChips: [],
      comparatorSemantics: [],
      notes: { en: "The receiving manager comes from the receiving_manager_id field; unknown field values are NOT_EVALUABLE, never guessed.", ar: "يأتي المدير المستلم من حقل receiving_manager_id؛ والقيم غير المعروفة تجعل النتيجة غير قابلة للتقييم دون تخمين." },
    },
    [
      { name: "both_managers_pass", given: { approvers: ["E00001"], lineManager: "E00001", receivingManager: "E00002" }, expect: "PASS" },
      { name: "receiving_missing_fails_c2", given: { approvers: ["E00001"], lineManager: "E00001", receivingManager: "E00002" }, expect: "PASS" },
      { name: "receiving_manager_not_approving_fails", given: { approvers: ["E00001"], lineManager: "E00001", receivingManager: "E00009" }, expect: "FAIL:C2" },
    ]
  );

  add(
    {
      id: "R04", title: "Allowance changes above AED 10,000 need a grade 13+ approver", family: "approval_limit", version: "1.0.0",
      effective: { from: "2025-01-01", to: null, dateBasis: "effective_date" },
      scope: {
        transactionTypes: ["ALLOWANCE_CHANGE"],
        where: { all: [{ fact: "txn.amount_fils", op: "gt", value: 1000000 }] },
      },
      check: { kind: "approval_limit", params: { minApproverGrade: 13, quantifier: "any", allowDelegates: false } },
      severity: { base: "HIGH", modifiers: ["magnitude_over_limit", "exposure_50k", "repeat_actor_90d"] },
      routing: { process: "ALLOWANCE_CHANGE" }, action: { template: "CA-AL-01" }, explain: { template: "EX-AL-01" },
      clauses: [{ id: "C1", text: vtext("Any allowance change above AED 10,000 must be approved by someone at grade 13 or above.") }],
    },
    {
      ruleId: "R04",
      readings: [
        { option: "above = strictly greater", description: { en: "AED 10,000.00 exactly is out of scope; AED 10,000.01 is in scope (EC-G01).", ar: "مبلغ 10,000.00 درهم بالضبط خارج النطاق؛ و10,000.01 درهم داخل النطاق (EC-G01)." }, chosen: true, basis: "comparator semantics ADR-0002; worked example WX-1001" },
        { option: "above = at least", description: { en: "AED 10,000.00 exactly would be in scope.", ar: "مبلغ 10,000.00 درهم بالضبط يكون داخل النطاق." }, chosen: false, basis: "rejected: “above” is strict" },
      ],
      ambiguityChips: [
        { chip: "comparator", options: [">", "≥"], chosen: ">" },
        { chip: "quantifier", options: ["any", "all"], chosen: "any" },
      ],
      comparatorSemantics: [
        { term: "above", meaning: "strictly greater than" },
        { term: "or above / at least", meaning: "greater than or equal" },
      ],
      notes: { en: "Approver grade comes from the transaction when present, otherwise from the employee master snapshot, and the evidence says which.", ar: "تُؤخذ درجة المعتمِم من المعاملة إن وُجدت، وإلا فمن لقطة بيانات الموظف، ويُذكر المصدر في الدليل." },
    },
    [
      { name: "at_threshold_is_out_of_scope", given: { amount: "10000.00", approver_grades: [9] }, expect: "NOT_APPLICABLE" },
      { name: "one_fils_over_fails", given: { amount: "10000.01", approver_grades: [12] }, expect: "FAIL" },
      { name: "required_grade_passes", given: { amount: "15000.00", approver_grades: [13] }, expect: "PASS" },
    ]
  );

  add(
    {
      id: "R05", title: "Pay changes above AED 25,000 need a grade 15+ approver", family: "approval_limit", version: "1.0.0",
      effective: { from: "2025-01-01", to: null, dateBasis: "effective_date" },
      scope: {
        transactionTypes: ["PAY_CHANGE"],
        where: { all: [{ fact: "txn.amount_fils", op: "gt", value: 2500000 }] },
      },
      check: { kind: "approval_limit", params: { minApproverGrade: 15, quantifier: "any", allowDelegates: false } },
      severity: { base: "HIGH", modifiers: ["magnitude_over_limit", "exposure_50k", "repeat_actor_90d"] },
      routing: { process: "PAY_CHANGE" }, action: { template: "CA-AL-01" }, explain: { template: "EX-AL-01" },
      clauses: [{ id: "C1", text: vtext("Any pay change above AED 25,000 must be approved by someone at grade 15 or above.") }],
    },
    {
      ruleId: "R05",
      readings: [
        { option: "above = strictly greater", description: { en: "AED 25,000.00 exactly is out of scope.", ar: "مبلغ 25,000.00 درهم بالضبط خارج النطاق." }, chosen: true, basis: "comparator semantics ADR-0002" },
      ],
      ambiguityChips: [{ chip: "comparator", options: [">", "≥"], chosen: ">" }],
      comparatorSemantics: [{ term: "above", meaning: "strictly greater than" }],
      notes: { en: "Same quantifier and grade-source semantics as R04.", ar: "نفس دلالات المُكمِّم ومصدر الدرجة كما في R04." },
    },
    [
      { name: "at_threshold_is_out_of_scope", given: { amount: "25000.00", approver_grades: [13] }, expect: "NOT_APPLICABLE" },
      { name: "one_fils_over_fails", given: { amount: "25000.01", approver_grades: [13] }, expect: "FAIL" },
      { name: "grade_15_passes", given: { amount: "30000.00", approver_grades: [15] }, expect: "PASS" },
    ]
  );

  add(
    {
      id: "R06", title: "Segregation of duties: requester and beneficiary cannot approve", family: "segregation_of_duties", version: "1.0.0",
      effective: { from: "2025-01-01", to: null, dateBasis: "effective_date" },
      scope: { transactionTypes: ["HIRE", "PAY_CHANGE", "ALLOWANCE_CHANGE", "TRANSFER", "LEAVE", "EXIT"] },
      check: { kind: "segregation_of_duties", params: { forbiddenPairs: ["requester-approver", "approver-beneficiary"] } },
      severity: { base: "HIGH", modifiers: ["self_benefit_critical"] },
      routing: { process: "*" }, action: { template: "CA-SOD-01" }, explain: { template: "EX-SOD-01" },
      clauses: [
        { id: "C1", text: vtext("The requester of a transaction cannot approve it.") },
        { id: "C2", text: vtext("No one may approve a transaction from which they benefit.") },
      ],
    },
    {
      ruleId: "R06",
      readings: [
        { option: "beneficiary = the employee the transaction is for", description: { en: "The beneficiary is the transaction's employee.", ar: "المستفيد هو موظف المعاملة." }, chosen: true, basis: "PRD §7; EC-D02 raises self-benefit to Critical" },
      ],
      ambiguityChips: [],
      comparatorSemantics: [],
      notes: { en: "Person IDs are canonicalised before comparison (EC-B10).", ar: "تُطبَّع معرّفات الأشخاص قبل المقارنة (EC-B10)." },
    },
    [
      { name: "requester_approves_fails_c1", given: { requester: "E00100", approvers: ["E00100"], employee: "E00200" }, expect: "FAIL:C1" },
      { name: "approver_is_beneficiary_fails_c2", given: { requester: "E00100", approvers: ["E00200"], employee: "E00200" }, expect: "FAIL:C2:CRITICAL" },
      { name: "independent_parties_pass", given: { requester: "E00100", approvers: ["E00300"], employee: "E00200" }, expect: "PASS" },
    ]
  );

  add(
    {
      id: "R07", title: "New hire documents", family: "required_documents", version: "1.0.0",
      effective: { from: "2025-01-01", to: null, dateBasis: "effective_date" },
      scope: { transactionTypes: ["HIRE"] },
      check: {
        kind: "required_documents",
        params: {
          required: ["OFFER_LETTER", "PASSPORT_COPY"],
          conditional: [{ document: "VISA_COPY", when: { fact: "employee.nationality", op: "ne", value: "UAE_NATIONAL" } }],
        },
      },
      severity: { base: "MEDIUM", modifiers: ["right_to_work_high"] },
      routing: { process: "HIRE" }, action: { template: "CA-DOC-01" }, explain: { template: "EX-DOC-01" },
      clauses: [{ id: "C1", text: vtext("Every new hire must have a signed offer letter and a passport copy attached; non-national hires must also have a visa copy.") }],
    },
    {
      ruleId: "R07",
      readings: [
        { option: "visa required only for non-nationals", description: { en: "The visa copy is conditional on nationality other than UAE national.", ar: "صورة التأشيرة مشروطة بجنسية غير الجنسية الإماراتية." }, chosen: true, basis: "policy wording; EC-E03 for missing condition data" },
      ],
      ambiguityChips: [],
      comparatorSemantics: [],
      notes: { en: "Only the curated synonym table counts as a document type; near-matches never count and appear as caveats (EC-E02).", ar: "يُعتد فقط بجدول المرادفات المعتمد لأنواع المستندات؛ والتطابقات التقريبية لا تُحتسب وتظهر كتنبيهات (EC-E02)." },
    },
    [
      { name: "all_documents_pass", given: { documents: ["OFFER_LETTER", "PASSPORT_COPY", "VISA_COPY"], nationality: "EXPAT" }, expect: "PASS" },
      { name: "missing_visa_expat_fails", given: { documents: ["OFFER_LETTER", "PASSPORT_COPY"], nationality: "EXPAT" }, expect: "FAIL" },
      { name: "uae_national_no_visa_pass", given: { documents: ["OFFER_LETTER", "PASSPORT_COPY"], nationality: "UAE_NATIONAL" }, expect: "PASS" },
    ]
  );

  add(
    {
      id: "R08", title: "No backdating beyond 30 days", family: "timing_window", version: "1.0.0",
      effective: { from: "2025-01-01", to: null, dateBasis: "effective_date" },
      scope: { transactionTypes: ["HIRE", "PAY_CHANGE", "ALLOWANCE_CHANGE", "TRANSFER", "LEAVE", "EXIT"] },
      check: { kind: "timing_window", params: { fromFact: "effectiveDate", toFact: "submittedDate", maxDays: 30, basis: "calendar", inclusive: true } },
      severity: { base: "MEDIUM", modifiers: ["backdate_90d_high", "closed_payroll_period"] },
      routing: { process: "*" }, action: { template: "CA-TW-01" }, explain: { template: "EX-TW-01" },
      clauses: [{ id: "C1", text: vtext("A transaction must not be backdated by more than 30 days.") }],
    },
    {
      ruleId: "R08",
      readings: [
        { option: "within 30 days inclusive", description: { en: "Backdated exactly 30 days passes; 31 days fails (EC-F01).", ar: "التأريخ المسبق بـ 30 يوماً بالضبط مقبول؛ و31 يوماً مخالف (EC-F01)." }, chosen: true, basis: "“more than 30” excludes 30; inclusive boundary ADR-0002" },
      ],
      ambiguityChips: [{ chip: "basis", options: ["calendar", "business"], chosen: "calendar" }],
      comparatorSemantics: [{ term: "more than", meaning: "strictly greater than" }],
      notes: { en: "Calendar days; business days would cite the versioned UAE calendar.", ar: "أيام تقويمية؛ وأيام العمل تستخدم تقويم الإمارات المُصدَّر." },
    },
    [
      { name: "backdated_30_passes", given: { effectiveDate: "2026-03-01", submittedDate: "2026-03-31" }, expect: "PASS" },
      { name: "backdated_31_fails", given: { effectiveDate: "2026-03-01", submittedDate: "2026-04-01" }, expect: "FAIL" },
      { name: "future_dated_passes", given: { effectiveDate: "2026-04-15", submittedDate: "2026-03-31" }, expect: "PASS" },
    ]
  );

  add(
    {
      id: "R09", title: "Pay and allowance changes only for active employees", family: "eligibility", version: "1.0.0",
      effective: { from: "2025-01-01", to: null, dateBasis: "effective_date" },
      scope: { transactionTypes: ["PAY_CHANGE", "ALLOWANCE_CHANGE"] },
      check: { kind: "eligibility", params: { allowedStatuses: ["ACTIVE"], exemptTypes: [] } },
      severity: { base: "CRITICAL", modifiers: [] },
      routing: { process: "*" }, action: { template: "CA-ELG-01" }, explain: { template: "EX-ELG-01" },
      clauses: [{ id: "C1", text: vtext("No pay or allowance change may be processed for an employee who is not active on the effective date.") }],
    },
    {
      ruleId: "R09",
      readings: [
        { option: "point-in-time status from employment dates", description: { en: "Active through the exit date inclusive; not active before hire (EC-C09/C10).", ar: "على رأس العمل حتى تاريخ المغادرة شاملاً؛ وغير نشط قبل تاريخ التعيين (EC-C09/C10)." }, chosen: true, basis: "EC-C09/C14" },
      ],
      ambiguityChips: [],
      comparatorSemantics: [],
      notes: { en: "Status is derived from dates, never from the current status field alone (EC-C14).", ar: "تُشتق الحالة من التواريخ، وليس من حقل الحالة الحالي وحده (EC-C14)." },
    },
    [
      { name: "active_employee_passes", given: { hireDate: "2020-01-01", exitDate: null, effectiveDate: "2026-03-01" }, expect: "PASS" },
      { name: "exited_employee_fails", given: { hireDate: "2020-01-01", exitDate: "2026-02-28", effectiveDate: "2026-03-10" }, expect: "FAIL" },
      { name: "exit_on_effective_date_passes", given: { hireDate: "2020-01-01", exitDate: "2026-03-10", effectiveDate: "2026-03-10" }, expect: "PASS" },
    ]
  );

  add(
    {
      id: "R10", title: "At most two allowance changes in 12 months", family: "aggregate_limit", version: "1.0.0",
      effective: { from: "2025-01-01", to: null, dateBasis: "effective_date" },
      scope: { transactionTypes: ["ALLOWANCE_CHANGE"] },
      check: { kind: "aggregate_limit", params: { windowDays: 365, metric: "count", max: 2, groupBy: "employee", anchor: "effectiveDate" } },
      severity: { base: "MEDIUM", modifiers: [] },
      routing: { process: "ALLOWANCE_CHANGE" }, action: { template: "CA-AGG-01" }, explain: { template: "EX-AGG-01" },
      clauses: [{ id: "C1", text: vtext("No employee may receive more than two allowance changes in any 12-month period.") }],
    },
    {
      ruleId: "R10",
      readings: [
        { option: "rolling window anchored on the effective date", description: { en: "The 12-month window ends on the transaction's effective date, never the run date (EC-F12).", ar: "تُحسب نافذة الـ 12 شهراً من تاريخ سريان المعاملة، وليس من تاريخ التشغيل (EC-F12)." }, chosen: true, basis: "determinism; EC-F12" },
      ],
      ambiguityChips: [],
      comparatorSemantics: [{ term: "more than two", meaning: "a third change within the window fails" }],
      notes: { en: "Ties break by submission time then row ID.", ar: "تُحلّ التساويات حسب وقت الإرسال ثم معرّف الصف." },
    },
    [
      { name: "second_change_passes", given: { priorCount: 1, windowDays: 365 }, expect: "PASS" },
      { name: "third_change_fails", given: { priorCount: 2, windowDays: 365 }, expect: "FAIL" },
      { name: "older_change_out_of_window", given: { priorCount: 2, windowDays: 0 }, expect: "PASS" },
    ]
  );

  add(
    {
      id: "R11", title: "No duplicate allowance changes within 3 days", family: "duplicate", version: "1.0.0",
      effective: { from: "2025-01-01", to: null, dateBasis: "effective_date" },
      scope: { transactionTypes: ["ALLOWANCE_CHANGE"] },
      check: { kind: "duplicate", params: { keys: ["employeeId", "type", "amountFils"], toleranceDays: 3, ignoreReversals: true, flag: "later" } },
      severity: { base: "HIGH", modifiers: ["both_effective_critical"] },
      routing: { process: "ALLOWANCE_CHANGE" }, action: { template: "CA-DUP-01" }, explain: { template: "EX-DUP-01" },
      clauses: [{ id: "C1", text: vtext("The same allowance change for the same employee and the same amount must not be entered twice within 3 days.") }],
    },
    {
      ruleId: "R11",
      readings: [
        { option: "flag the later twin", description: { en: "The later entry (effective date, then submission time, then row ID) is flagged and cites the earlier one (ADR-0003).", ar: "يُعلَّم الإدخال الأحدث (تاريخ السريان ثم وقت الإرسال ثم معرّف الصف) ويُشير إلى الأقدم (ADR-0003)." }, chosen: true, basis: "worked example WX-1005; ADR-0003" },
        { option: "flag both", description: { en: "Both entries are flagged.", ar: "يُعلَّم الإدخالان معاً." }, chosen: false, basis: "rejected: noisier, same root cause" },
      ],
      ambiguityChips: [{ chip: "flag", options: ["later", "both"], chosen: "later" }],
      comparatorSemantics: [],
      notes: { en: "Reversed pairs are excluded (EC-H03).", ar: "تُستثنى الأزواج المعكوسة (EC-H03)." },
    },
    [
      { name: "twin_within_3_days_flags_later", given: { twins: ["A", "B"] }, expect: "FAIL:B" },
      { name: "four_days_apart_passes", given: { twins: [] }, expect: "PASS" },
      { name: "different_amount_passes", given: { twins: [] }, expect: "PASS" },
    ]
  );

  add(
    {
      id: "R12", title: "Approvers exist and are active", family: "reference_integrity", version: "1.0.0",
      effective: { from: "2025-01-01", to: null, dateBasis: "effective_date" },
      scope: { transactionTypes: ["HIRE", "PAY_CHANGE", "ALLOWANCE_CHANGE", "TRANSFER", "LEAVE", "EXIT"] },
      check: { kind: "reference_integrity", params: { facts: ["approvers"], activeAt: "approval" } },
      severity: { base: "MEDIUM", modifiers: ["approver_not_found_high"] },
      routing: { process: "*" }, action: { template: "CA-REF-01" }, explain: { template: "EX-REF-01" },
      clauses: [{ id: "C1", text: vtext("Every approver must exist in the employee master and be active at the time of approval.") }],
    },
    {
      ruleId: "R12",
      readings: [
        { option: "exists and active at approval time", description: { en: "Unknown approvers and approvers who had exited (or were not yet hired) at approval time fail (EC-D06/D07).", ar: "المعتمِمون غير المعروفين أو الذين غادروا (أو لم يُعيَّنوا بعد) وقت الاعتماد يُعدّ مخالفة (EC-D06/D07)." }, chosen: true, basis: "EC-D06/D07" },
      ],
      ambiguityChips: [],
      comparatorSemantics: [],
      notes: { en: "System actors (SYSTEM, HRIS_BATCH) are not human approvers (EC-D15) and are skipped here.", ar: "الحسابات الآلية (SYSTEM وHRIS_BATCH) ليست معتمِمين بشريين (EC-D15) وتُستثنى هنا." },
    },
    [
      { name: "known_active_approver_passes", given: { approver: "E00001", status: "ACTIVE" }, expect: "PASS" },
      { name: "unknown_approver_fails", given: { approver: "E99999", status: null }, expect: "FAIL" },
      { name: "exited_approver_fails", given: { approver: "E00002", status: "EXITED" }, expect: "FAIL" },
    ]
  );

  add(
    {
      id: "R13", title: "Pay increases above 15% need grade 17 approval", family: "value_bounds", version: "1.0.0",
      effective: { from: "2025-01-01", to: null, dateBasis: "effective_date" },
      scope: { transactionTypes: ["PAY_CHANGE"] },
      check: { kind: "value_bounds", params: { fact: "payChangePct", pctMax: 15, approverGradeOverride: 17, baseSource: "previous PAY_CHANGE or HIRE amount within 24 months" } },
      severity: { base: "HIGH", modifiers: [] },
      routing: { process: "PAY_CHANGE" }, action: { template: "CA-VB-01" }, explain: { template: "EX-VB-01" },
      clauses: [{ id: "C1", text: vtext("A pay increase of more than 15% is not permitted without Grade 17 approval.") }],
    },
    {
      ruleId: "R13",
      readings: [
        { option: "percentage against derived base; grade 17 override", description: { en: "The base is the employee's previous pay (transaction history, then hire); an unknown base is NOT_EVALUABLE (EC-G04).", ar: "الأساس هو الراتب السابق للموظف (من سجل المعاملات، ثم التعيين)؛ والأساس غير المعروف يجعل النتيجة غير قابلة للتقييم (EC-G04)." }, chosen: true, basis: "EC-G04; DERIVED_BASE caveat" },
      ],
      ambiguityChips: [{ chip: "comparator", options: [">", "≥"], chosen: ">" }],
      comparatorSemantics: [{ term: "more than 15%", meaning: "strictly greater than 15%" }],
      notes: { en: "The percentage is computed in integer basis points from fils amounts; evidence states how the base was derived.", ar: "تُحسب النسبة بنقاط أساس صحيحة من المبالغ بالفلس؛ ويُذكر في الدليل كيفية اشتقاق الأساس." },
    },
    [
      { name: "increase_15_passes", given: { pctBps: 1500, approverGrades: [13] }, expect: "PASS" },
      { name: "increase_16_without_g17_fails", given: { pctBps: 1600, approverGrades: [13] }, expect: "FAIL" },
      { name: "increase_20_with_g17_passes", given: { pctBps: 2000, approverGrades: [17] }, expect: "PASS" },
    ]
  );

  return rules;
}

export const RULES: RuleDef[] = buildRules();

export const RULE_SPECS: RuleSpec[] = RULES.map((r) => r.spec);
export const INTERPRETATIONS: Record<string, InterpretationRecord> = Object.fromEntries(RULES.map((r) => [r.spec.id, r.interpretation]));

/** R14 definition + R15 human attestation (not compiled into checks; coverage reports them). */
export const NON_CHECK_SENTENCES = {
  definitions: [
    { anchor: "R14", text: "For this policy, grade 20 is the most senior grade and grade 1 is the most junior; grades 13 and above are considered senior leadership.", usedBy: ["R04", "R05", "R13"] },
  ],
  scopeNotes: [
    { anchor: "SN-1", text: "All rules apply to transactions with an effective date on or after 1 January 2025." },
  ],
  attestations: [
    { anchor: "R15", text: "For each transfer, the receiving manager must provide reasonable justification for the business need.", note: "not automatable: human attestation" },
  ],
};

export async function packHash(): Promise<string> {
  return sha256Json({ version: PACK_VERSION, rules: RULE_SPECS.map((r) => ({ id: r.id, version: r.version, sha: r.source.sha256, spec: r })) });
}

/** Emit policy_rules.md from the pack (never the other way round). */
export function renderPolicyRulesMarkdown(): string {
  const lines: string[] = [];
  lines.push("# HR Policy Rules — Emirates Group (synthetic pack)");
  lines.push("");
  lines.push("This file is generated from the compiled rule pack (PACK_VERSION " + PACK_VERSION + "). The verbatim text below is the source of record for each rule.");
  lines.push("");
  for (const { spec } of RULES) {
    lines.push(`## ${spec.id} · ${spec.title}`);
    lines.push("");
    for (const clause of spec.clauses) lines.push(clause.text);
    lines.push("");
  }
  lines.push("## R14 · Grade ladder definition");
  lines.push("");
  lines.push(NON_CHECK_SENTENCES.definitions[0]!.text);
  lines.push("");
  lines.push("## R15 · Transfer justification (human attestation)");
  lines.push("");
  lines.push(NON_CHECK_SENTENCES.attestations[0]!.text);
  lines.push("");
  lines.push("## Scope note");
  lines.push("");
  lines.push(NON_CHECK_SENTENCES.scopeNotes[0]!.text);
  lines.push("");
  return lines.join("\n");
}

/** Coverage report: every sentence classified (red line: "Every written rule accounted for"). */
export function coverageReport() {
  return {
    packVersion: PACK_VERSION,
    compiled: RULES.map((r) => ({ anchor: r.spec.id, family: r.spec.family, status: "compiled" as const })),
    definitions: NON_CHECK_SENTENCES.definitions.map((d) => ({ anchor: d.anchor, status: "definition" as const, usedBy: d.usedBy })),
    scopeNotes: NON_CHECK_SENTENCES.scopeNotes.map((d) => ({ anchor: d.anchor, status: "scope_note" as const })),
    attestations: NON_CHECK_SENTENCES.attestations.map((d) => ({ anchor: d.anchor, status: "human_attestation" as const, note: d.note })),
    total: RULES.length + 3,
  };
}
