/**
 * Server session & actor context. Judge accounts with a role switcher replace
 * OIDC in the sandbox (see integrations/oidc.ts for the production integration point).
 * The actor arrives as X-Mizan-Actor; role permissions + conflict-of-interest are
 * enforced in the API, never only in the UI.
 */

import { db } from "@/lib/db";

export type Role = "analyst" | "team_lead" | "ops_owner" | "policy_author" | "policy_approver" | "auditor" | "admin" | "compliance_lead";

export interface ActorContext {
  id: string;
  name: string;
  role: Role;
  employeeId: string | null;
}

export const DEFAULT_ACTOR = "analyst-a";

export async function resolveActor(headerValue: string | null): Promise<ActorContext> {
  const id = headerValue?.trim() || DEFAULT_ACTOR;
  const actor = await db.actor.findUnique({ where: { id } });
  if (!actor) {
    return { id: DEFAULT_ACTOR, name: "Analyst A", role: "analyst", employeeId: null };
  }
  return { id: actor.id, name: actor.name, role: actor.role as Role, employeeId: actor.employeeId };
}

/** Role permission matrix per command (§12). API-enforced, not UI-enforced. */
export const COMMAND_ROLES: Record<string, Role[]> = {
  triage: ["analyst", "team_lead", "compliance_lead", "admin"],
  assign: ["team_lead", "compliance_lead", "admin"],
  start: ["ops_owner", "analyst", "admin"],
  record_fix: ["ops_owner", "analyst", "admin"],
  verify: ["analyst", "compliance_lead", "admin"],
  fail_verification: ["analyst", "compliance_lead", "admin"],
  dismiss: ["analyst", "compliance_lead", "admin"],
  accept_risk: ["team_lead", "compliance_lead", "admin"],
  mark_duplicate: ["analyst", "compliance_lead", "admin"],
  reopen: ["auditor", "compliance_lead", "admin"],
  dispute: ["ops_owner", "analyst", "team_lead", "admin"],
  comment: ["analyst", "team_lead", "ops_owner", "auditor", "admin", "compliance_lead"],
};

export function roleCan(role: Role, command: string): boolean {
  return (COMMAND_ROLES[command] ?? []).includes(role);
}

/** Mode guard: writes in read-only or safe halt are rejected (capability matrix). */
export function writeAllowedInMode(mode: string, kind: "decision" | "run" | "upload" | "config"): { allowed: boolean; code?: string } {
  switch (mode) {
    case "M0":
    case "M1":
    case "M2":
    case "M3":
      return { allowed: true };
    case "M4":
      return { allowed: false, code: "MZ-MODE-503" };
    case "M5":
      return kind === "run" || kind === "upload" ? { allowed: false, code: "MZ-RUN-423" } : { allowed: false, code: "MZ-MODE-503" };
    default:
      return { allowed: true };
  }
}
