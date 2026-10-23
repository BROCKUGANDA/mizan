/**
 * Configuration as data (NON-NEGOTIABLE #22): grade ladder, txn types, synonyms,
 * corrective-action library. Versioned, hashable, editable without a deploy.
 * Mirrors config/*.yaml in the production layout.
 */

import { sha256Json } from "../domain/canonical";

export const GRADE_LADDER = {
  version: "grade-ladder-1.1.0",
  direction: "ascending_is_senior" as const, // higher ordinal = more senior; grade 20 is the most senior (R14 definition)
  grades: [
    { grade: "1", ordinal: 1 }, { grade: "2", ordinal: 2 }, { grade: "3", ordinal: 3 },
    { grade: "4", ordinal: 4 }, { grade: "5", ordinal: 5 }, { grade: "6", ordinal: 6 },
    { grade: "7", ordinal: 7 }, { grade: "8", ordinal: 8 }, { grade: "9", ordinal: 9 },
    { grade: "10", ordinal: 10 }, { grade: "11", ordinal: 11 }, { grade: "12", ordinal: 12 },
    { grade: "13", ordinal: 13 }, { grade: "14", ordinal: 14 }, { grade: "15", ordinal: 15 },
    { grade: "16", ordinal: 16 }, { grade: "17", ordinal: 17 }, { grade: "18", ordinal: 18 },
    { grade: "19", ordinal: 19 }, { grade: "20", ordinal: 20 },
  ],
  knownAliases: {} as Record<string, string>, // e.g. "13A" stays unmapped → DQ-011
};

export const TXN_TYPES = {
  version: "txn-types-1.3.0",
  canonical: ["HIRE", "PAY_CHANGE", "ALLOWANCE_CHANGE", "TRANSFER", "LEAVE", "EXIT"],
  synonyms: {
    HIRE: ["NEW_HIRE", "HIRED", "JOINING", "ONBOARDING"],
    PAY_CHANGE: ["SALARY_CHANGE", "SALARY_ADJ", "PAY_REVIEW", "INCREMENT"],
    ALLOWANCE_CHANGE: ["ALLOWANCE", "ALLOWANCE_CHG", "ALLOWANCE_ADJ", "HOUSING_ALLOWANCE"],
    TRANSFER: ["DEPT_TRANSFER", "INTERNAL_TRANSFER", "MOBILITY"],
    LEAVE: ["ANNUAL_LEAVE", "LEAVE_REQ", "TIME_OFF"],
    EXIT: ["RESIGNATION", "TERMINATION", "END_OF_SERVICE", "LEAVER"],
  },
};

export const DOCUMENT_TYPES = {
  version: "doc-types-1.1.0",
  canonical: ["OFFER_LETTER", "PASSPORT_COPY", "VISA_COPY", "EDUCATION_CERT", "NO objection"],
  synonyms: {
    OFFER_LETTER: ["OFFER", "SIGNED_OFFER", "OFFER_LETTER_SIGNED"],
    PASSPORT_COPY: ["PASSPORT", "PP_COPY", "PASSPORT_SCAN"],
    VISA_COPY: ["VISA", "RESIDENCE_VISA", "ENTRY_PERMIT"],
    EDUCATION_CERT: ["DEGREE", "CERTIFICATE"],
  },
};

export const STATUSES = {
  version: "status-map-1.1.0",
  canonical: ["ACTIVE", "EXITED", "SUSPENDED", "ON_LEAVE"],
  synonyms: {
    ACTIVE: ["EMPLOYED", "CURRENT", "نعم"],
    EXITED: ["LEFT", "TERMINATED", "RESIGNED"],
    SUSPENDED: ["SUSP"],
    ON_LEAVE: ["LEAVE", "LONG_LEAVE"],
  },
};

export const DEPARTMENT_SYNONYMS = {
  version: "dept-map-1.0.3",
  canonical: ["Engineering", "Finance", "Cargo", "Cabin Crew", "Airport Ops", "IT", "HR", "Marketing"],
  synonyms: {
    Engineering: ["Eng", "ENG", "Engineering Division"],
    Finance: ["FIN", "Finance Division"],
    Cargo: ["SKYCARGO", "Cargo Division"],
    "Cabin Crew": ["CC", "CabinCrew"],
    "Airport Ops": ["AOPS", "Airport Services"],
    IT: ["Technology", "TECH"],
    HR: ["People", "Human Resources"],
    Marketing: ["MKT", "Brand"],
  },
};

/** Corrective-action library (§15) — EN/AR templates, parameters from evidence only. */
export const ACTION_LIBRARY: Record<string, { en: string; ar: string }> = {
  "CA-AL-01": {
    en: "Obtain retrospective approval from an approver at grade {required_grade} or above and attach it; if refused, raise a reversal before the next payroll cut-off",
    ar: "الحصول على موافقة لاحقة من معتمِد من الدرجة {required_grade} أو أعلى وإرفاقها، وفي حال الرفض يُرفع طلب لعكس المعاملة قبل موعد الإقفال القادم للرواتب",
  },
  "CA-AC-01": {
    en: "Obtain the missing approval from {missing_roles} and attach it. If the change is already effective, record a retrospective approval with the reason",
    ar: "الحصول على الموافقة الناقصة من {missing_roles} وإرفاقها. وإذا كانت المعاملة قد نفّذت، يُسجَّل اعتماد لاحق مع ذكر السبب",
  },
  "CA-CH-01": {
    en: "Obtain approval from {required_manager} ({relationship}) and attach it, and confirm the management chain in the HR system is correct",
    ar: "الحصول على موافقة {required_manager} ({relationship}) وإرفاقها، والتأكد من صحة سلسلة الإدارة في نظام الموارد البشرية",
  },
  "CA-SOD-01": {
    en: "Have an independent approver, not {actor}, re-review the transaction; review all transactions {actor} approved for the same team in the last 90 days",
    ar: "يقوم معتمِد مستقل غير {actor} بمراجعة المعاملة مرة أخرى، ومراجعة جميع المعاملات التي اعتمدها {actor} للفريق نفسه خلال آخر 90 يوماً",
  },
  "CA-DOC-01": {
    en: "Request {missing_documents} from {requester}; attach within 5 business days or escalate to {team_lead}",
    ar: "طلب {missing_documents} من {requester}؛ وإرفاقها خلال 5 أيام عمل أو التصعيد إلى {team_lead}",
  },
  "CA-TW-01": {
    en: "Record the business justification for backdating by {days} days and obtain the policy owner's sign-off; check whether payroll for the period needs adjustment",
    ar: "توثيق المبرر التجاري للتأريخ المسبق بمقدار {days} يوماً والحصول على اعتماد مالك السياسة، والتحقق مما إذا كانت رواتب الفترة تحتاج إلى تعديل",
  },
  "CA-SEQ-01": {
    en: "Confirm the actual approval date with the approver and have the HRIS data steward correct the record",
    ar: "تأكيد تاريخ الاعتماد الفعلي مع المعتمِم، وقيام أمين بيانات النظام بتصحيح السجل",
  },
  "CA-ELG-01": {
    en: "Hold any pending payment linked to the transaction, confirm employment status and recover any overpayment under policy",
    ar: "إيقاف أي دفعة معلّقة مرتبطة بالمعاملة، وتأكيد حالة التوظيف، واسترداد أي مبالغ مدفوعة زيادة وفقاً للسياسة",
  },
  "CA-DUP-01": {
    en: "Confirm whether {txn_a} and {txn_b} are the same change and cancel the duplicate before the next payroll cut-off",
    ar: "التأكد مما إذا كانت {txn_a} و{txn_b} نفس التغيير، وإلغاء المعاملة المكررة قبل موعد الإقفال القادم للرواتب",
  },
  "CA-REF-01": {
    en: "Confirm the identity and status of {person}; correct the reference in the HR system or re-approve with an active approver",
    ar: "تأكيد هوية {person} وحالته؛ وتصحيح المرجع في نظام الموارد البشرية أو إعادة الاعتماد بمعتمِد على رأس عمله",
  },
  "CA-VB-01": {
    en: "Check the increase of {value} against the policy bound {bound}; obtain grade {required_grade} approval or correct the record",
    ar: "مراجعة الزيادة البالغة {value} مقابل الحد السياسي {bound}؛ والحصول على موافقة الدرجة {required_grade} أو تصحيح السجل",
  },
  "CA-AGG-01": {
    en: "Review the {count} allowance changes for {employee} since {window_start}; confirm which are justified and obtain the required approval for the excess",
    ar: "مراجعة {count} تغييرات على البدل لـ {employee} منذ {window_start}؛ وتأكيد التغييرات المبررة والحصول على الموافقة المطلوبة للزيادة",
  },
  "CA-DQ-01": {
    en: "Correct {field} for {txn_id} in the source extract. MIZAN will evaluate it on the next run",
    ar: "تصحيح {field} للمعاملة {txn_id} في ملف البيانات المصدر. سيعيد MIZAN التقييم في التشغيل القادم",
  },
};

export function configHashes(): Promise<{ gradeLadderHash: string; synonymsHash: string; routingHash: string; configHash: string; actionsHash: string }> {
  return Promise.all([
    sha256Json(GRADE_LADDER),
    sha256Json({ types: TXN_TYPES, docs: DOCUMENT_TYPES, statuses: STATUSES, departments: DEPARTMENT_SYNONYMS }),
    sha256Json({ version: "routing-1.2.0" }),
    sha256Json({ sla: "sla-1.0.0", exportProfile: "finding_format-1.0.0" }),
    sha256Json(ACTION_LIBRARY),
  ]).then(([gradeLadderHash, synonymsHash, routingHash, configHash, actionsHash]) => ({
    gradeLadderHash, synonymsHash, routingHash, configHash, actionsHash,
  }));
}
