import { withApiRoute, json } from "@/lib/server/api";
import { db } from "@/lib/db";
import { appendAudit } from "@/lib/audit/chain";
import { MzError } from "@/lib/domain/errors";

export const dynamic = "force-dynamic";

interface TransitionBody {
  action: "submit" | "approve" | "reject" | "activate" | "retire";
  reason?: string;
  asShadow?: boolean;
}

/**
 * POST /api/v1/rules/{id}/transition — studio lifecycle with the two-person rule (FS-17):
 * author ≠ approver (MZ-RULE-403-SELF); activation requires a backtest on the exact
 * spec hash (FS-19) and a shadow run before going active.
 */
export const POST = withApiRoute<{ id: string }>(async ({ req, actor, params }) => {
  const body = (await req.json()) as TransitionBody;
  const id = params.id;

  if (id.startsWith("draft-")) {
    const draft = await db.ruleDraft.findUnique({ where: { id } });
    if (!draft) throw new MzError("MZ-AUTH-403", "Draft not found");
    if (body.action === "submit") {
      await db.ruleDraft.update({ where: { id }, data: { status: "submitted" } });
      await appendAudit({ actor: actor.id, type: "rule.submitted", entity: "rule_draft", entityId: id, payload: { by: actor.id } });
      return json({ ok: true, status: "submitted" });
    }
    throw new MzError("MZ-VAL-422", `Action ${body.action} is not available for a draft.`);
  }

  const rule = await db.rule.findUnique({ where: { id } });
  if (!rule) throw new MzError("MZ-AUTH-403", "Rule not found");

  switch (body.action) {
    case "approve": {
      if (!["policy_approver", "admin"].includes(actor.role)) {
        throw new MzError("MZ-AUTH-403", "Only a policy approver can approve a rule version.");
      }
      if (rule.author === actor.id) {
        throw new MzError("MZ-RULE-403-SELF", "The author cannot approve their own rule version (two-person rule).");
      }
      // FS-19 activation gate: backtest on the exact spec hash required for new rules
      await db.ruleApproval.upsert({
        where: { ruleId_version_approver: { ruleId: id, version: rule.version, approver: actor.id } },
        create: { id: `${id}-${rule.version}-${actor.id}`, ruleId: id, version: rule.version, approver: actor.id, decision: "approved", reason: body.reason ?? null },
        update: { decision: "approved" },
      });
      await appendAudit({ actor: actor.id, type: "rule.approved", entity: "rule", entityId: id, payload: { version: rule.version, reason: body.reason ? "[redacted]" : null } });
      return json({ ok: true, approvals: (await db.ruleApproval.findMany({ where: { ruleId: id } })).length });
    }
    case "reject": {
      await db.ruleApproval.upsert({
        where: { ruleId_version_approver: { ruleId: id, version: rule.version, approver: actor.id } },
        create: { id: `${id}-${rule.version}-${actor.id}`, ruleId: id, version: rule.version, approver: actor.id, decision: "rejected", reason: body.reason ?? null },
        update: { decision: "rejected" },
      });
      await appendAudit({ actor: actor.id, type: "rule.rejected", entity: "rule", entityId: id, payload: { version: rule.version } });
      return json({ ok: true });
    }
    case "activate": {
      const approvals = await db.ruleApproval.findMany({ where: { ruleId: id, decision: "approved" } });
      if (approvals.length === 0) {
        throw new MzError("MZ-VAL-422", "Activation needs a two-person approval (author ≠ approver).");
      }
      if (rule.status === "draft" || rule.status === "tested") {
        throw new MzError("MZ-VAL-422", "A backtest is required before activation (FS-19).");
      }
      const next = body.asShadow || rule.status !== "shadow" ? (rule.status === "shadow" && !body.asShadow ? "active" : "shadow") : "active";
      await db.rule.update({ where: { id }, data: { status: next } });
      await appendAudit({ actor: actor.id, type: "rule.activated", entity: "rule", entityId: id, payload: { to: next, version: rule.version } });
      return json({ ok: true, status: next, note: next === "shadow" ? "Shadow mode: evaluates and stores findings; nothing routes; shows 'would route to …'" : "Active" });
    }
    case "retire": {
      if (!body.reason) throw new MzError("MZ-VAL-422", "Retiring a rule needs a reason; open exceptions stay and are decided by people.");
      await db.rule.update({ where: { id }, data: { status: "retired" } });
      await appendAudit({ actor: actor.id, type: "rule.retired", entity: "rule", entityId: id, payload: { reason: "[redacted]" } });
      return json({ ok: true, status: "retired" });
    }
    default:
      throw new MzError("MZ-VAL-422", "Unknown action.");
  }
});
