/**
 * Routing resolver (§13): override → table → family overlay → conflict-of-interest
 * guard → fallback. Records owner team, watchers, rationale text and table version.
 */

import type { Transaction, RuleSpec, Severity } from "../contracts";
import { ROUTING_TABLE, FAMILY_OVERLAY, FALLBACK_TEAM, ROUTING_TABLE_VERSION } from "../contracts";

export interface RoutingInput {
  txn: Transaction;
  rule: RuleSpec;
  severity: Severity;
  clauseId: string;
}

export interface RoutingResult {
  ownerTeam: string;
  watchers: string[];
  rationale: string;
  rationaleAr: string;
  routingTableVersion: string;
  fallbackUsed: boolean;
}

const PROCESS_EN: Record<string, string> = {
  HIRE: "hire",
  PAY_CHANGE: "pay change",
  ALLOWANCE_CHANGE: "allowance change",
  TRANSFER: "transfer",
  LEAVE: "leave",
  EXIT: "exit",
  UNKNOWN: "unknown-type",
};

const PROCESS_AR: Record<string, string> = {
  HIRE: "تعيين",
  PAY_CHANGE: "تغيير راتب",
  ALLOWANCE_CHANGE: "تغيير بدل",
  TRANSFER: "نقل",
  LEAVE: "إجازة",
  EXIT: "مغادرة",
  UNKNOWN: "غير معروف",
};

const TEAM_AR: Record<string, string> = {
  "Talent Acquisition Operations": "فريق عمليات اكتساب المواهب",
  "Compensation & Payroll Operations": "فريق عمليات التعويضات والرواتب",
  "Workforce Mobility Operations": "فريق عمليات تنقل القوى العاملة",
  "Leave & Attendance Operations": "فريق عمليات الإجازات والحضور",
  "Separations & Final Settlement Operations": "فريق عمليات المغادرة والتسوية النهائية",
  "HR Compliance (overlay)": "امتثال الموارد البشرية",
  "HRIS Data Stewardship": "أمنة بيانات نظام الموارد البشرية",
  "HR Compliance Triage": "فرز امتثال الموارد البشرية",
};

export function resolveRouting(input: RoutingInput): RoutingResult {
  const { txn, rule } = input;
  const process = rule.routing.process === "*" ? txn.type : rule.routing.process;

  // 1. Rule-level owner override (none in pack v1)
  // 2. Routing table by process
  let ownerTeam = ROUTING_TABLE[process];
  let rationale = "";
  let rationaleAr = "";
  let fallbackUsed = false;

  if (ownerTeam) {
    rationale = `Routed to ${ownerTeam} because this is a ${PROCESS_EN[process] ?? process} transaction (routing table ${ROUTING_TABLE_VERSION}).`;
    rationaleAr = `أُحيلت إلى ${TEAM_AR[ownerTeam] ?? ownerTeam} لأن المعاملة من نوع ${PROCESS_AR[process] ?? process} (جدول التوجيه ${ROUTING_TABLE_VERSION}).`;
  } else {
    // 5. Fallback
    ownerTeam = FALLBACK_TEAM;
    fallbackUsed = true;
    rationale = `Routed to ${FALLBACK_TEAM} because there is no routing entry for ${process} (routing table ${ROUTING_TABLE_VERSION}).`;
    rationaleAr = `أُحيلت إلى ${TEAM_AR[FALLBACK_TEAM]} لأنه لا يوجد إدخال توجيه لـ ${process} (جدول التوجيه ${ROUTING_TABLE_VERSION}).`;
  }

  // 3. Family overlay
  const watchers: string[] = [];
  const overlay = FAMILY_OVERLAY[rule.family];
  if (overlay && overlay !== "HRIS Data Stewardship") {
    watchers.push(overlay);
    rationale += ` ${overlay} is notified because this family is an integrity overlay.`;
    rationaleAr += ` ويتم إشعار ${TEAM_AR[overlay]} لأن هذه العائلة طبقة سلامة.`;
  }

  // 4. Conflict-of-interest guard: if a party to the transaction owns the resolved team, route one level up.
  const parties = new Set<string>([txn.requesterId ?? "", txn.employeeId, ...(txn.approvals ?? []).map((a) => a.approverId ?? "")].filter(Boolean));
  const teamLeads = TEAM_LEADS[ownerTeam];
  if (teamLeads && teamLeads.some((lead) => parties.has(lead))) {
    ownerTeam = FALLBACK_TEAM;
    fallbackUsed = true;
    watchers.push(ROUTING_TABLE[process] ?? FALLBACK_TEAM);
    rationale = `Routed one level up to ${FALLBACK_TEAM} because a party to the transaction owns the ${PROCESS_EN[process] ?? process} process (conflict-of-interest guard).`;
    rationaleAr = `أُحيلت مستوى واحداً أعلى إلى ${TEAM_AR[FALLBACK_TEAM]} لأن أحد أطراف المعاملة يملك عملية ${PROCESS_AR[process] ?? process} (حماية تضارب المصالح).`;
  }

  return { ownerTeam, watchers, rationale, rationaleAr, routingTableVersion: ROUTING_TABLE_VERSION, fallbackUsed };
}

/** Demo team leads used by the conflict-of-interest guard (production: HRIS lookup). */
export const TEAM_LEADS: Record<string, string[]> = {
  "Talent Acquisition Operations": ["E00210"],
  "Compensation & Payroll Operations": ["E00220"],
  "Workforce Mobility Operations": ["E00230"],
  "Leave & Attendance Operations": ["E00240"],
  "Separations & Final Settlement Operations": ["E00250"],
};

export { FALLBACK_TEAM };
