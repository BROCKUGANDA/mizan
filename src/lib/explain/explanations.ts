/**
 * Explanations (§16): 8 parts, EN + AR, canonical text only (no model needed).
 * Headlines ≤ 90 chars; sentences ≤ 25 words; neutral voice; fact-locked by construction.
 * Template output for the 5 worked examples matches finding_format.csv byte-exactly (FS-20).
 */

import type { Transaction, RuleSpec, Evidence } from "../contracts";
import { displayAED } from "../domain/money";
import type { Severity } from "../contracts";

export interface ExplanationParts {
  headlineEn: string; headlineAr: string;
  whatBrokeEn: string; whatBrokeAr: string;
  whyEn: string; whyAr: string;
}

const WHY: Record<string, { en: string; ar: string }> = {
  approval_limit: { en: "Approval limits make sure large pay commitments are checked by someone with authority over that budget.", ar: "تضمن حدود الاعتماد أن يراجع الالتزامات المالية الكبيرة شخصٌ يملك الصلاحية على تلك الميزانية." },
  approval_count: { en: "Required approvers bring the right oversight to people decisions that are hard to reverse.", ar: "الاعتمادات المطلوبة تجلب الرقابة المناسبة لقرارات الموظفين التي يصعب التراجع عنها." },
  approval_chain: { en: "Manager approvals keep the sending and receiving departments in control of the move.", ar: "موافقات المديرين تجعل الإدارتين المرسلة والمستلمة مسؤولتين عن النقل." },
  segregation_of_duties: { en: "Segregation of duties makes sure no single person controls a transaction from start to finish.", ar: "الفصل بين المهام يضمن ألا يتحكم شخص واحد بمعاملة من بدايتها إلى نهايتها." },
  required_documents: { en: "Required documents prove the transaction meets policy before it takes effect.", ar: "المستندات المطلوبة تثبت أن المعاملة مستوفية للسياسة قبل تنفيذها." },
  timing_window: { en: "Backdated transactions can hide when a decision was really made and affect the correct pay period.", ar: "المعاملات المؤرخة مسبقاً قد تُخفي وقت اتخاذ القرار الفعلي وتؤثر على فترة الرواتب الصحيحة." },
  sequence: { en: "Approvals recorded out of order can mean the approval was not given before the change took effect.", ar: "الاعتمادات المسجلة بترتيب خاطئ قد تعني أن الموافقة لم تُمنح قبل تنفيذ التغيير." },
  eligibility: { en: "Paying someone who has left the company can create overpayments that are hard to recover.", ar: "الدفع لشخص غادر الشركة قد يسبب مبالغ مدفوعة زيادة يصعب استردادها." },
  aggregate_limit: { en: "Limits on repeated changes protect employees and budgets from frequent unreviewed adjustments.", ar: "حدود التغييرات المتكررة تحمي الموظفين والميزانيات من تعديلات كثيرة دون مراجعة." },
  duplicate: { en: "Duplicate entries can pay the same change twice.", ar: "الإدخالات المكررة قد تدفع نفس التغيير مرتين." },
  reference_integrity: { en: "Approvals from people who cannot be verified in the master data do not provide assurance.", ar: "الموافقات من أشخاص لا يمكن التحقق منهم في البيانات الرئيسية لا توفر ضماناً." },
  value_bounds: { en: "Large percentage increases need senior review because they compound over time.", ar: "الزيادات النسبية الكبيرة تحتاج مراجعة عليا لأنها تتراكم مع الوقت." },
  data_quality: { en: "Good data is what makes every other check trustworthy.", ar: "جودة البيانات هي ما يجعل كل الفحوصات الأخرى موثوقة." },
};

const aed = (fils: number | null | undefined): string => (fils === null || fils === undefined ? "AED 0.00" : displayAED(fils));

export function explain(txn: Transaction, rule: RuleSpec, evidence: Evidence, slots: Record<string, string | number | boolean | null>): ExplanationParts {
  const s = slots;
  const empId = txn.employeeId;
  const amount = aed(txn.amountFils);
  switch (rule.id) {
    case "R04":
    case "R05": {
      const changeWord = rule.id === "R04" ? "allowance change" : "pay change";
      const changeWordAr = rule.id === "R04" ? "تغيير بدل" : "تغيير راتب";
      const requiredGrade = s.requiredGrade as number;
      const approverGrade = s.approverGrade as number | null;
      const approverId = s.approverId as string | null;
      const threshold = aed(s.thresholdFils as number);
      return {
        headlineEn: approverGrade !== null
          ? `${changeWord === "allowance change" ? "Allowance" : "Pay"} change approved below the required grade`
          : `${changeWord === "allowance change" ? "Allowance" : "Pay"} change with no qualifying approver`,
        headlineAr: approverGrade !== null ? "تمت الموافقة على التغيير من درجة أقل من المطلوبة" : "تغيير بدون معتمِم بالدرجة المطلوبة",
        whatBrokeEn: approverGrade !== null
          ? `This ${amount} ${changeWord} for employee ${empId} was approved only by ${approverId}, who is grade ${approverGrade}. Rule ${rule.id} requires an approver at grade ${requiredGrade} or above for ${changeWord}s above ${threshold}.`
          : `This ${amount} ${changeWord} for employee ${empId} has no approval recorded from someone at grade ${requiredGrade} or above. Rule ${rule.id} requires it for ${changeWord}s above ${threshold}.`,
        whatBrokeAr: approverGrade !== null
          ? `هذا ${changeWordAr} بقيمة ${amount} للموظف ${empId} اعتُمد فقط من ${approverId}، وهو من الدرجة ${approverGrade}. وتشترط القاعدة ${rule.id} معتمداً من الدرجة ${requiredGrade} أو أعلى لـ${changeWordAr} التي تتجاوز ${threshold}.`
          : `هذا ${changeWordAr} بقيمة ${amount} للموظف ${empId} ليس لديه موافقة مسجلة من الدرجة ${requiredGrade} أو أعلى. وتشترط القاعدة ${rule.id} ذلك لـ${changeWordAr} التي تتجاوز ${threshold}.`,
        whyEn: WHY.approval_limit!.en, whyAr: WHY.approval_limit!.ar,
      };
    }
    case "R06": {
      const approverId = s.approverId as string | null;
      if (evidence.clauseId === "C1") {
        return {
          headlineEn: "Requester approved their own transaction",
          headlineAr: "اعتمد الطالب المعاملة بنفسه",
          whatBrokeEn: `Transaction ${txn.txnId} for employee ${s.employeeId as string} was requested by ${s.requesterId as string} and approved by ${approverId ?? s.requesterId as string}. Rule R06 does not allow the requester to approve a transaction.`,
          whatBrokeAr: `المعاملة ${txn.txnId} للموظف ${s.employeeId as string} طلبها ${s.requesterId as string} واعتمدها ${approverId ?? s.requesterId as string}. ولا تسمح القاعدة R06 بأن يعتمد الطالب معاملته.`,
          whyEn: WHY.segregation_of_duties!.en, whyAr: WHY.segregation_of_duties!.ar,
        };
      }
      return {
        headlineEn: "Approver benefited from the transaction",
        headlineAr: "استفاد المعتمِم من المعاملة",
        whatBrokeEn: `Transaction ${txn.txnId} for employee ${s.employeeId as string} was approved by ${approverId ?? "an approver"}, who is the beneficiary. Rule R06 does not allow anyone to approve a transaction from which they benefit.`,
        whatBrokeAr: `المعاملة ${txn.txnId} للموظف ${s.employeeId as string} اعتمدها ${approverId ?? "معتمِم"} وهو المستفيد منها. ولا تسمح القاعدة R06 باعتماد معاملة يستفيد منها المعتمِم.`,
        whyEn: WHY.segregation_of_duties!.en, whyAr: WHY.segregation_of_duties!.ar,
      };
    }
    case "R09": {
      const changeWord = txn.type === "PAY_CHANGE" ? "changed pay" : "changed allowance";
      const changeWordAr = txn.type === "PAY_CHANGE" ? "غيّر الراتب" : "غيّر البدل";
      return {
        headlineEn: txn.type === "PAY_CHANGE" ? "Pay change processed for an employee who had left" : "Allowance change processed for an employee who had left",
        headlineAr: txn.type === "PAY_CHANGE" ? "تغيير راتب لموظف قد غادر" : "تغيير بدل لموظف قد غادر",
        whatBrokeEn: `Employee ${empId} had an exit date of ${s.exitDate as string}, but transaction ${txn.txnId} ${changeWord} by ${amount} with an effective date of ${s.effectiveDate as string}.`,
        whatBrokeAr: `الموظف ${empId} كان تاريخ مغادرته ${s.exitDate as string}، لكن المعاملة ${txn.txnId} ${changeWordAr} بمقدار ${amount} بتاريخ سريان ${s.effectiveDate as string}.`,
        whyEn: WHY.eligibility!.en, whyAr: WHY.eligibility!.ar,
      };
    }
    case "R08": {
      return {
        headlineEn: `Transaction backdated by ${s.backdatedDays as number} days`,
        headlineAr: `معاملة مؤرخة مسبقاً بـ ${s.backdatedDays as number} يوماً`,
        whatBrokeEn: `Transaction ${txn.txnId} for employee ${empId} has an effective date of ${s.effectiveDate as string} but was submitted on ${s.submittedDate as string}, which is ${s.backdatedDays as number} days later.`,
        whatBrokeAr: `المعاملة ${txn.txnId} للموظف ${empId} تاريخ سريانها ${s.effectiveDate as string} لكنها أُرسلت في ${s.submittedDate as string}، أي بعد ${s.backdatedDays as number} يوماً.`,
        whyEn: WHY.timing_window!.en, whyAr: WHY.timing_window!.ar,
      };
    }
    case "R11": {
      return {
        headlineEn: "Possible duplicate allowance change within 3 days",
        headlineAr: "تغيير بدل مكرر محتمل خلال 3 أيام",
        whatBrokeEn: `Transaction ${txn.txnId} for employee ${empId} is an allowance change of ${amount} effective ${s.effectiveDate as string}, which repeats ${s.txnA as string} of ${aed(s.amountFils as number)} effective ${(s.txnAEffectiveDate as string) ?? evidence.relatedTxnIds[0] ?? ""}.`,
        whatBrokeAr: `المعاملة ${txn.txnId} للموظف ${empId} هي تغيير بدل بقيمة ${amount} بتاريخ سريان ${s.effectiveDate as string}، وتكرر ${s.txnA as string} بقيمة ${aed(s.amountFils as number)} بتاريخ سريان ${(s.txnAEffectiveDate as string) ?? ""}.`,
        whyEn: WHY.duplicate!.en, whyAr: WHY.duplicate!.ar,
      };
    }
    case "R10": {
      return {
        headlineEn: "Too many allowance changes within 12 months",
        headlineAr: "تغييرات بدل كثيرة خلال 12 شهراً",
        whatBrokeEn: `Transaction ${txn.txnId} is allowance change number ${s.count as number} for employee ${empId} within 12 months. Rule R10 allows at most ${s.max as number}.`,
        whatBrokeAr: `المعاملة ${txn.txnId} هي تغيير البدل رقم ${s.count as number} للموظف ${empId} خلال 12 شهراً. وتسمح القاعدة R10 بـ ${s.max as number} كحد أقصى.`,
        whyEn: WHY.aggregate_limit!.en, whyAr: WHY.aggregate_limit!.ar,
      };
    }
    case "R01": {
      return {
        headlineEn: "Exit missing a required approver",
        headlineAr: "مغادرة بدون المعتمِم المطلوب",
        whatBrokeEn: `Transaction ${txn.txnId} for employee ${empId} has ${s.approverCount as number} distinct approver(s) but is missing ${s.rolesMissing as string}. Rule R01 requires the line manager and an HR business partner.`,
        whatBrokeAr: `المعاملة ${txn.txnId} للموظف ${empId} لديها ${s.approverCount as number} معتمِم مختلف لكنها تنقصها ${s.rolesMissing as string}. وتشترط القاعدة R01 المدير المباشر وشريك أعمال الموارد البشرية.`,
        whyEn: WHY.approval_count!.en, whyAr: WHY.approval_count!.ar,
      };
    }
    case "R02": {
      return {
        headlineEn: "Approval recorded before submission",
        headlineAr: "سُجلت الموافقة قبل الإرسال",
        whatBrokeEn: s.zeroApprovals === true
          ? `Transaction ${txn.txnId} for employee ${empId} has no approval recorded, so nothing was recorded after it was submitted at ${s.submittedAt as string}. Rule R02 requires the approval to come after submission.`
          : `Transaction ${txn.txnId} for employee ${empId} was submitted at ${s.submittedAt as string} but its approval was recorded at ${s.approvedAt as string}. Rule R02 requires the approval to come after submission.`,
        whatBrokeAr: s.zeroApprovals === true
          ? `المعاملة ${txn.txnId} للموظف ${empId} ليس فيها موافقة مسجلة، فلم يُسجل شيء بعد إرسالها في ${s.submittedAt as string}. وتشترط القاعدة R02 أن تأتي الموافقة بعد الإرسال.`
          : `المعاملة ${txn.txnId} للموظف ${empId} أُرسلت في ${s.submittedAt as string} لكن موافقتها سُجلت في ${s.approvedAt as string}. وتشترط القاعدة R02 أن تأتي الموافقة بعد الإرسال.`,
        whyEn: WHY.sequence!.en, whyAr: WHY.sequence!.ar,
      };
    }
    case "R03": {
      return evidence.clauseId === "C1"
        ? {
            headlineEn: "Transfer missing the sending manager's approval",
            headlineAr: "نقل بدون موافقة المدير المرسل",
            whatBrokeEn: `Transaction ${txn.txnId} was not approved by the employee's line manager (${s.requiredManager as string || "not recorded"}). Rule R03 requires the sending manager's approval.`,
            whatBrokeAr: `المعاملة ${txn.txnId} لم تعتمدها المدير المباشر للموظف (${s.requiredManager as string || "غير مسجل"}). وتشترط القاعدة R03 موافقة المدير المرسل.`,
            whyEn: WHY.approval_chain!.en, whyAr: WHY.approval_chain!.ar,
          }
        : {
            headlineEn: "Transfer missing the receiving manager's approval",
            headlineAr: "نقل بدون موافقة المدير المستلم",
            whatBrokeEn: `Transaction ${txn.txnId} from ${txn.passthrough.from_department ?? "the sending department"} to ${txn.department ?? "the receiving department"} was not approved by the receiving department manager (${s.requiredManager as string || "not recorded"}). Rule R03 requires the receiving manager's approval.`,
            whatBrokeAr: `المعاملة ${txn.txnId} من ${txn.passthrough.from_department ?? "الإدارة المرسلة"} إلى ${txn.department ?? "الإدارة المستلمة"} لم يعتمدها مدير الإدارة المستلمة (${s.requiredManager as string || "غير مسجل"}). وتشترط القاعدة R03 موافقة المدير المستلم.`,
            whyEn: WHY.approval_chain!.en, whyAr: WHY.approval_chain!.ar,
          };
    }
    case "R07": {
      return {
        headlineEn: "Required documents missing from a hire",
        headlineAr: "مستندات مطلوبة ناقصة في تعيين",
        whatBrokeEn: `Transaction ${txn.txnId} for employee ${empId} is missing ${s.missingDocumentsEn as string}. Rule R07 requires an offer letter and a passport copy for every new hire${String(s.missingDocumentsEn).includes("VISA_COPY") ? ", and a visa copy for non-national hires" : ""}.`,
        whatBrokeAr: `المعاملة ${txn.txnId} للموظف ${empId} تنقصها ${s.missingDocuments as string}. وتشترط القاعدة R07 خطاب عرض وصورة جواز سفر لكل تعيين جديد${String(s.missingDocumentsEn).includes("VISA_COPY") ? "، وصورة تأشيرة لغير الجنسية الإماراتية" : ""}.`,
        whyEn: WHY.required_documents!.en, whyAr: WHY.required_documents!.ar,
      };
    }
    case "R12": {
      return {
        headlineEn: "Approver could not be verified",
        headlineAr: "تعذر التحقق من المعتمِم",
        whatBrokeEn: `Approver ${s.personId as string} on transaction ${txn.txnId} ${s.problem as string}. Rule R12 requires every approver to exist in the employee master and be active at approval time.`,
        whatBrokeAr: `المعتمِم ${s.personId as string} في المعاملة ${txn.txnId} ${s.problem as string === "not found in the employee master" ? "غير موجود في بيانات الموظفين" : "لم يكن على رأس عمله وقت الموافقة"}. وتشترط القاعدة R12 أن يكون كل معتمِم موجوداً في البيانات وعلى رأس عمله وقت الموافقة.`,
        whyEn: WHY.reference_integrity!.en, whyAr: WHY.reference_integrity!.ar,
      };
    }
    case "R13": {
      return {
        headlineEn: "Pay increase above the policy bound",
        headlineAr: "زيادة راتب تتجاوز الحد السياسي",
        whatBrokeEn: `Transaction ${txn.txnId} increases pay by ${s.pctDisplay as number}%, which is more than ${s.pctMax as number}%, and no grade ${s.requiredGrade as number} approver approved it. Rule R13 requires grade ${s.requiredGrade as number} approval for increases above ${s.pctMax as number}%.`,
        whatBrokeAr: `المعاملة ${txn.txnId} تزيد الراتب بنسبة ${s.pctDisplay as number}%، وهي أكثر من ${s.pctMax as number}%، ولم تعتمدها الدرجة ${s.requiredGrade as number}. وتشترط القاعدة R13 موافقة الدرجة ${s.requiredGrade as number} للزيادات فوق ${s.pctMax as number}%.`,
        whyEn: WHY.value_bounds!.en, whyAr: WHY.value_bounds!.ar,
      };
    }
    default: {
      return {
        headlineEn: `${rule.id} breached`,
        headlineAr: `مخالفة ${rule.id}`,
        whatBrokeEn: `Transaction ${txn.txnId} breached rule ${rule.id}: ${evidence.requirement.en}`,
        whatBrokeAr: `المعاملة ${txn.txnId} خالفت القاعدة ${rule.id}: ${evidence.requirement.ar}`,
        whyEn: WHY[rule.family]?.en ?? WHY.data_quality!.en,
        whyAr: WHY[rule.family]?.ar ?? WHY.data_quality!.ar,
      };
    }
  }
}

/** DQ exception explanations (not-evaluable wording: what was missing + who fixes it; never a breach — EC-L09). */
export function explainDq(txn: Transaction, dq: string): ExplanationParts {
  const who = "the HRIS data steward";
  const whoAr = "أمين بيانات نظام الموارد البشرية";
  const MAP: Record<string, { en: string; ar: string; headline: string; headlineAr: string }> = {
    "DQ-001": { headline: "Required data missing", headlineAr: "بيانات مطلوبة غير موجودة", en: `Transaction ${txn.txnId} is missing a required field, so dependent checks could not run. ${who} can correct the source extract.`, ar: `المعاملة ${txn.txnId} تنقصها بيانات مطلوبة، لذا تعذر تشغيل الفحوصات المعتمدة عليها. يستطيع ${whoAr} تصحيح ملف البيانات المصدر.` },
    "DQ-003": { headline: "Date order resolved by default", headlineAr: "تم تحديد ترتيب التاريخ افتراضياً", en: `Transaction ${txn.txnId} has an ambiguous date. The day-month order was resolved by default (day first). ${who} can confirm the correct order.`, ar: `المعاملة ${txn.txnId} تحتوي تاريخاً غامضاً. تم تحديد ترتيب اليوم والشهر افتراضياً (اليوم أولاً). يستطيع ${whoAr} تأكيد الترتيب الصحيح.` },
    "DQ-004": { headline: "Employee not in the master data", headlineAr: "موظف غير موجود في البيانات الرئيسية", en: `Transaction ${txn.txnId} references employee ${txn.employeeId}, who is not in the employee master. ${who} can add or correct the record.`, ar: `المعاملة ${txn.txnId} تشير إلى الموظف ${txn.employeeId} غير الموجود في بيانات الموظفين. يستطيع ${whoAr} إضافة السجل أو تصحيحه.` },
    "DQ-006": { headline: "Unknown transaction type", headlineAr: "نوع معاملة غير معروف", en: `Transaction ${txn.txnId} has type "${txn.typeRaw}", which is not in the type vocabulary. ${who} can map it.`, ar: `المعاملة ${txn.txnId} من نوع "${txn.typeRaw}" غير الموجود في قائمة الأنواع. يستطيع ${whoAr} تصنيفه.` },
    "DQ-007": { headline: "Unrecognised attachment", headlineAr: "مرفق غير معروف", en: `Transaction ${txn.txnId} has an attachment that does not match the document list. ${who} can rename or classify it.`, ar: `المعاملة ${txn.txnId} تحتوي مرفقاً غير مطابق لقائمة المستندات. يستطيع ${whoAr} إعادة تسميته أو تصنيفه.` },
    "DQ-008": { headline: "Duplicate transaction ID with different content", headlineAr: "معرّف معاملة مكرر بمحتوى مختلف", en: `Transaction ${txn.txnId} appears more than once with different content. ${who} can confirm which row is correct.`, ar: `المعاملة ${txn.txnId} تظهر أكثر من مرة بمحتوى مختلف. يستطيع ${whoAr} تأكيد الصف الصحيح.` },
    "DQ-009": { headline: "Currency other than AED", headlineAr: "عملة غير الدرهم", en: `Transaction ${txn.txnId} is in ${txn.currency ?? "a foreign currency"}, so amount thresholds were not applied. ${who} can confirm the treatment.`, ar: `المعاملة ${txn.txnId} بعملة ${txn.currency ?? "أجنبية"}، لذا لم تُطبق حدود المبالغ. يستطيع ${whoAr} تأكيد المعاملة المحاسبية.` },
    "DQ-011": { headline: "Grade not on the ladder", headlineAr: "درجة غير موجودة في السلم", en: `Transaction ${txn.txnId} carries grade "${txn.gradeRaw}", which is not on the grade ladder. ${who} can map it.`, ar: `المعاملة ${txn.txnId} تحمل الدرجة "${txn.gradeRaw}" غير الموجودة في سلم الدرجات. يستطيع ${whoAr} تصنيفها.` },
    "DQ-013": { headline: "Amount ambiguous or out of convention", headlineAr: "مبلغ غامض أو مخالف لاتفاقية التنسيق", en: `The amount on transaction ${txn.txnId} could not be parsed under the column convention, so amount checks were not run. ${who} can correct the value.`, ar: `تعذر تحليل مبلغ المعاملة ${txn.txnId} وفق اتفاقية العمود، لذا لم تُنفَّذ فحوصات المبالغ. يستطيع ${whoAr} تصحيح القيمة.` },
    "DQ-016": { headline: "Status value not mapped", headlineAr: "قيمة حالة غير مصنفة", en: `The status on this record is not in the status vocabulary, so eligibility could not be decided. ${who} can map the value.`, ar: `الحالة في هذا السجل غير موجودة في قائمة الحالات، لذا تعذر تحديد الأهلية. يستطيع ${whoAr} تصنيفها.` },
    "DQ-017": { headline: "Instruction-like text tagged for review", headlineAr: "نص يشبه التعليمات، عُلّم للمراجعة", en: `A free-text field on transaction ${txn.txnId} looks like an instruction. It was treated as data only and tagged for security review.`, ar: `حقل نصي في المعاملة ${txn.txnId} يشبه التعليمات. عومِل كبيانات فقط وعُلّم للمراجعة الأمنية.` },
  };
  const m = MAP[dq] ?? { headline: `Data-quality issue ${dq}`, headlineAr: `مشكلة بيانات ${dq}`, en: `Transaction ${txn.txnId} has data-quality issue ${dq}. ${who} can review it.`, ar: `المعاملة ${txn.txnId} بها مشكلة بيانات ${dq}. يستطيع ${whoAr} مراجعتها.` };
  return { headlineEn: m.headline, headlineAr: m.headlineAr, whatBrokeEn: m.en, whatBrokeAr: m.ar, whyEn: WHY.data_quality!.en, whyAr: WHY.data_quality!.ar };
}

const SEVERITY_LABEL_AR: Record<Severity, string> = { CRITICAL: "حرجة", HIGH: "عالية", MEDIUM: "متوسطة", LOW: "منخفضة" };

/**
 * One canonical text (red line: UI, export and evidence pack show the same explanation).
 * Deterministic assembly of the 8 parts.
 */
export function canonicalText(parts: ExplanationParts, evidence: Evidence, actionEn: string, actionAr: string, ownerTeam: string, ownerTeamAr: string, severity: Severity, severityRationale: string, severityRationaleAr: string, locale: "en" | "ar"): string {
  if (locale === "ar") {
    return [
      parts.headlineAr,
      parts.whatBrokeAr,
      `القاعدة ${evidence.ruleId} (الإصدار ${evidence.ruleVersion}): «${evidence.clauseText}»`,
      `أهمية ذلك: ${parts.whyAr}`,
      `الإجراء المقترح: ${actionAr}`,
      `أُحيلت إلى ${ownerTeamAr}. ${severityRationaleAr || `درجة الخطورة: ${SEVERITY_LABEL_AR[severity]}.`}`,
    ].join("\n\n");
  }
  return [
    parts.headlineEn,
    parts.whatBrokeEn,
    `Rule ${evidence.ruleId} (version ${evidence.ruleVersion}): "${evidence.clauseText}"`,
    `Why it matters: ${parts.whyEn}`,
    `Suggested action: ${actionEn}`,
    `Routed to ${ownerTeam}. ${severityRationale || `Severity ${severity}.`}`,
  ].join("\n\n");
}
