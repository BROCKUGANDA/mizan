/**
 * Severity rubric (§13): base severity from the family; modifiers move one step
 * each, at most 2 steps total, capped at Critical and floored at Low.
 * The rationale is stored as text with every exception.
 */

import type { Severity, RuleSpec, Evidence } from "../contracts";

const ORDER: Severity[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

function step(s: Severity, n: number): Severity {
  const i = ORDER.indexOf(s);
  return ORDER[Math.max(0, Math.min(ORDER.length - 1, i + n))]!;
}

export interface SeverityInput {
  rule: RuleSpec;
  clauseId: string;
  slots: Record<string, string | number | boolean | null>;
  evidence: Evidence;
  asOf: string;
}

export interface SeverityResult {
  severity: Severity;
  rationale: string;
  rationaleAr: string;
  employeeImpacting: boolean;
}

const FAMILY_BASE: Record<string, Severity> = {
  approval_limit: "HIGH",
  approval_count: "HIGH",
  approval_chain: "HIGH",
  segregation_of_duties: "HIGH",
  required_documents: "MEDIUM",
  timing_window: "MEDIUM",
  sequence: "HIGH",
  eligibility: "CRITICAL",
  aggregate_limit: "MEDIUM",
  duplicate: "HIGH",
  reference_integrity: "MEDIUM",
  value_bounds: "HIGH",
  data_quality: "LOW",
};

const FAMILY_AR: Record<string, string> = {
  approval_limit: "حد الاعتماد",
  approval_count: "عدد الاعتمادات",
  approval_chain: "سلسلة الاعتماد",
  segregation_of_duties: "الفصل بين المهام",
  required_documents: "المستندات المطلوبة",
  timing_window: "نافذة التوقيت",
  sequence: "التسلسل",
  eligibility: "الأهلية",
  aggregate_limit: "الحد التجميعي",
  duplicate: "التكرار",
  reference_integrity: "سلامة المراجع",
  value_bounds: "حدود القيمة",
  data_quality: "جودة البيانات",
};

export function resolveSeverity(input: SeverityInput): SeverityResult {
  const { rule, clauseId, slots, evidence } = input;
  const base = (rule.severity.base as Severity) ?? FAMILY_BASE[rule.family] ?? "MEDIUM";
  const steps: string[] = [];
  const stepsAr: string[] = [];
  let current = base;
  let totalSteps = 0;
  const apply = (n: number, label: string, labelAr: string): void => {
    if (totalSteps >= 2 || n === 0) return;
    const allowed = Math.min(Math.abs(n), 2 - totalSteps) * Math.sign(n);
    if (allowed === 0) return;
    current = step(current, allowed);
    totalSteps += Math.abs(allowed);
    steps.push(`${allowed > 0 ? "+" : ""}${allowed} ${label}`);
    stepsAr.push(`${allowed > 0 ? "+" : ""}${allowed} ${labelAr}`);
  };

  const num = (k: string): number | null => (typeof slots[k] === "number" ? (slots[k] as number) : null);
  const isTrue = (k: string): boolean => slots[k] === true;

  switch (rule.family) {
    case "segregation_of_duties": {
      if (clauseId === "C2" || isTrue("self_benefit")) {
        current = "CRITICAL"; totalSteps = 2;
        steps.push("self-benefit: the approver is the beneficiary");
        stepsAr.push("منفذة ذاتياً: المعتمِم هو المستفيد");
      }
      break;
    }
    case "approval_limit": {
      const amount = num("amountFils");
      const threshold = num("thresholdFils");
      if (amount !== null && threshold !== null && threshold > 0) {
        if (amount >= 2 * threshold || amount >= 10_000_000) {
          apply(2, "amount at least 2× the limit or AED 100,000 or more", "المبلغ ضعف الحد أو 100,000 درهم أو أكثر");
        } else if (amount >= 1.5 * threshold) {
          apply(1, "amount 50% or more over the limit", "المبلغ 50% أو أكثر فوق الحد");
        }
        if (amount >= 5_000_000) apply(1, "financial exposure AED 50,000 or more", "التعرض المالي 50,000 درهم أو أكثر");
      }
      break;
    }
    case "duplicate": {
      // Critical when both twins are already effective AND in a closed payroll period.
      // No payroll calendar is provided in the pack (EC-F10): the modifier is not applied and the rationale says so.
      steps.push("both-effective modifier not applied: no payroll calendar provided");
      stepsAr.push("لم يُطبَّل معدِّل كون المعاملتين نافذتين: لا يوجد تقويم رواتب");
      break;
    }
    case "sequence": {
      if (isTrue("approvalBeforeSubmission")) {
        apply(1, "approval timestamp before submission", "طابع وقت الاعتماد قبل الإرسال");
      }
      break;
    }
    case "required_documents": {
      const missing = String(slots.missingDocumentsEn ?? "");
      if (missing.includes("PASSPORT_COPY") || missing.includes("VISA_COPY")) {
        apply(1, "right-to-work document missing on a hire", "مستند حق العمل ناقص في التعيين");
      } else {
        apply(-1, "documentary-only gap with complete approvals", "نقص مستندي فقط مع اكتمال الاعتمادات");
      }
      break;
    }
    case "timing_window": {
      const days = num("backdatedDays") ?? 0;
      if (days > 90) apply(1, "backdated beyond 90 days", "تأريخ مسبق لأكثر من 90 يوماً");
      steps.push("closed-payroll-period modifier not applied: no payroll calendar provided");
      stepsAr.push("لم يُطبَّل معدِّل فترة الرواتب المقفلة: لا يوجد تقويم رواتب");
      break;
    }
    case "reference_integrity": {
      if (String(slots.problem ?? "").includes("not found")) {
        apply(1, "approver not found in the employee master", "المعتمِم غير موجود في بيانات الموظفين");
      }
      break;
    }
    case "value_bounds": {
      const pct = num("pctBps") ?? 0;
      if (pct >= 3000) apply(1, "increase at least 30%", "زيادة 30% أو أكثر");
      break;
    }
    case "eligibility": {
      steps.push("eligibility for pay is Critical by policy");
      stepsAr.push("أهلية الرواتب حرجة بحكم السياسة");
      break;
    }
    default:
      break;
  }

  const familyLabel = FAMILY_AR[rule.family] ?? rule.family;
  const rationale = `Severity ${current}: base ${base} (${rule.family})` +
    (steps.length ? `; ${steps.join("; ")}` : "; no modifiers") +
    (totalSteps >= 2 ? "; capped at 2 steps" : "") + ".";
  const rationaleAr = `درجة الخطورة ${severityAr(current)}: الأساس ${severityAr(base)} (${familyLabel})` +
    (stepsAr.length ? `؛ ${stepsAr.join("؛ ")}` : "؛ دون معدِّلات") +
    (totalSteps >= 2 ? "؛ بحد أقصى خطوتين" : "") + ".";

  const employeeImpacting = rule.family === "eligibility" || clauseId === "C2" && rule.family === "segregation_of_duties";
  return { severity: current, rationale, rationaleAr, employeeImpacting };
}

export function severityAr(s: Severity): string {
  return { CRITICAL: "حرجة", HIGH: "عالية", MEDIUM: "متوسطة", LOW: "منخفضة" }[s];
}

export { FAMILY_BASE };
