import { ACTION_LIBRARY } from "./config";

/** Fill corrective-action templates from evidence slots only; no invented values. */
export function fillAction(templateId: string, slots: Record<string, string | number | boolean | null>, extras: Record<string, string> = {}): { en: string; ar: string; id: string } {
  const t = ACTION_LIBRARY[templateId] ?? { en: `Review the exception and record the outcome (missing template ${templateId})`, ar: `راجع الاستثناء وسجل النتيجة (القالب ${templateId} غير موجود)` };
  const map: Record<string, string> = {
    required_grade: String(slots.requiredGrade ?? ""),
    actor: String(slots.actor ?? ""),
    missing_documents: String(slots.missingDocumentsEn ?? slots.missingDocuments ?? ""),
    requester: String(slots.requesterId ?? ""),
    team_lead: "the team lead",
    days: String(slots.backdatedDays ?? ""),
    txn_a: String(slots.txnA ?? ""),
    txn_b: String(slots.txnB ?? ""),
    person: String(slots.personId ?? ""),
    value: `${slots.pctDisplay ?? ""}%`,
    bound: `${slots.pctMax ?? ""}%`,
    count: String(slots.count ?? ""),
    employee: String(slots.employeeId ?? ""),
    window_start: String(slots.windowStart ?? ""),
    required_manager: String(slots.requiredManager ?? ""),
    relationship: String(slots.relationship ?? ""),
    missing_roles: String(slots.rolesMissing ?? ""),
    ...extras,
  };
  const fill = (tpl: string): string => tpl.replace(/\{(\w+)\}/g, (_m, k: string) => map[k] ?? `{${k}}`);
  return { en: fill(t.en), ar: fill(t.ar), id: templateId };
}

/** Every action placeholder must be resolved before an exception is published. */
export function unresolvedPlaceholders(action: { en: string; ar: string }): string[] {
  return [...action.en.matchAll(/\{([a-z_]+)\}/g), ...action.ar.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]!);
}
