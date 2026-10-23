import { withApiRoute, json } from "@/lib/server/api";
import { db } from "@/lib/db";
import { appendAudit } from "@/lib/audit/chain";
import { MzError } from "@/lib/domain/errors";
import { RULE_SPECS } from "@/lib/pack/rules";

export const dynamic = "force-dynamic";

interface TransitionBody {
  action: "submit" | "approve" | "reject" | "activate" | "retire";
  reason?: string;
  asShadow?: boolean;
  acknowledged?: boolean;
}

/**
 * POST /api/v1/rules/{id}/transition — compiled-rule lifecycle with the
 * two-person rule (FS-17) and the activation gate (FS-19): exact-hash
 * backtest, >10% acknowledgement plus a second approver, shadow run first.
 */
export const POST = withApiRoute<{ id: string }>(async ({ req, actor, params }) => {
  const body = (await req.json()) as TransitionBody;
  const id = params.id;

  if (id.startsWith("draft-")) {
    throw new MzError("MZ-VAL-422", "Drafts use /rules/drafts/{id}/transition.");
  }

  const rule = await db.rule.findUnique({ where: { id } });
  if (!rule) throw new MzError("MZ-AUTH-403", "Rule not found");
  const backtest = rule.backtestJson ? JSON.parse(rule.backtestJson) as { specHash: string; failRate: number } : null;
  const compiled = RULE_SPECS.some((r) => r.id === rule.id);

  switch (body.action) {
    case "approve": {
      if (!["policy_approver", "admin"].includes(actor.role)) throw new MzError("MZ-AUTH-403", "Only a policy approver can approve a rule version.");
      if (rule.author === actor.id) throw new MzError("MZ-RULE-403-SELF", "The author cannot approve their own rule version (two-person rule).");
      if (rule.status === "retired") throw new MzError("MZ-VAL-422", "A retired rule cannot be approved; create a new version.");
      await db.ruleApproval.upsert({
        where: { ruleId_version_approver: { ruleId: id, version: rule.version, approver: actor.id } },
        create: { id: `${id}-${rule.version}-${actor.id}`, ruleId: id, version: rule.version, approver: actor.id, decision: "approved", reason: body.reason ?? null },
        update: { decision: "approved" },
      });
      if (!["active", "shadow"].includes(rule.status)) {
        await db.rule.update({ where: { id }, data: { status: "approved" } });
        await db.ruleVersion.updateMany({ where: { ruleId: id, version: rule.version }, data: { status: "approved" } });
      }
      await appendAudit({ actor: actor.id, type: "rule.approved", entity: "rule", entityId: id, payload: { version: rule.version, reason: body.reason ? "[redacted]" : null } });
      return json({ ok: true, approvals: await db.ruleApproval.count({ where: { ruleId: id, decision: "approved" } }) });
    }
    case "reject": {
      if (!["policy_approver", "admin"].includes(actor.role)) throw new MzError("MZ-AUTH-403", "Only a policy approver can reject a rule version.");
      if (!body.reason || body.reason.trim().length < 5) throw new MzError("MZ-VAL-422", "A rejection needs a reason.");
      await db.ruleApproval.upsert({
        where: { ruleId_version_approver: { ruleId: id, version: rule.version, approver: actor.id } },
        create: { id: `${id}-${rule.version}-${actor.id}`, ruleId: id, version: rule.version, approver: actor.id, decision: "rejected", reason: body.reason },
        update: { decision: "rejected" },
      });
      await appendAudit({ actor: actor.id, type: "rule.rejected", entity: "rule", entityId: id, payload: { version: rule.version } });
      return json({ ok: true });
    }
    case "activate": {
      if (!["policy_approver", "admin"].includes(actor.role)) throw new MzError("MZ-AUTH-403", "Only a policy approver can activate a rule.");
      const approvals = await db.ruleApproval.findMany({ where: { ruleId: id, decision: "approved" } });
      if (approvals.length === 0) throw new MzError("MZ-VAL-422", "Activation needs a two-person approval (author ≠ approver).");
      if (!backtest) {
        if (!compiled) throw new MzError("MZ-RULE-422", "A backtest on the exact spec is required before activation (FS-19).");
      } else {
        if (rule.specHash && backtest.specHash !== rule.specHash) throw new MzError("MZ-RULE-422", "The spec changed after its backtest; re-run the backtest (EC-I06).");
        if (backtest.failRate > 10) {
          if (body.acknowledged !== true) throw new MzError("MZ-RULE-422", `This rule flags ${backtest.failRate.toFixed(1)}% of applicable history; acknowledgement is required (FS-19).`);
          if (approvals.length < 2) throw new MzError("MZ-RULE-422", "A rule failing more than 10% of history needs a second approver (FS-19).");
        }
      }
      if (body.asShadow || rule.status === "approved" || rule.status === "draft" || rule.status === "tested" || rule.status === "backtested") {
        await db.rule.update({ where: { id }, data: { status: "shadow", activatedAt: new Date() } });
        await db.ruleVersion.updateMany({ where: { ruleId: id, version: rule.version }, data: { status: "shadow" } });
        await appendAudit({ actor: actor.id, type: "rule.activated", entity: "rule", entityId: id, payload: { to: "shadow", version: rule.version } });
        return json({ ok: true, status: "shadow", note: "Shadow mode: evaluates and stores findings; no routing, notifications or SLA clocks. Run a shadow run before going active." });
      }
      if (rule.status !== "shadow") throw new MzError("MZ-VAL-422", `A rule in status ${rule.status} cannot be activated.`);
      if (!rule.shadowRunId) throw new MzError("MZ-RULE-422", "A successful shadow run is required before active (FS-19).");
      await db.rule.update({ where: { id }, data: { status: "active", activatedAt: new Date() } });
      await db.ruleVersion.updateMany({ where: { ruleId: id, version: rule.version }, data: { status: "active" } });
      await appendAudit({ actor: actor.id, type: "rule.activated", entity: "rule", entityId: id, payload: { to: "active", version: rule.version, shadowRunId: rule.shadowRunId } });
      return json({ ok: true, status: "active" });
    }
    case "retire": {
      if (!["policy_approver", "admin", "compliance_lead"].includes(actor.role)) throw new MzError("MZ-AUTH-403", "Only a policy approver or compliance lead can retire a rule.");
      if (!body.reason) throw new MzError("MZ-VAL-422", "Retiring a rule needs a reason; open exceptions stay and are decided by people.");
      await db.rule.update({ where: { id }, data: { status: "retired" } });
      await db.ruleVersion.updateMany({ where: { ruleId: id, version: rule.version }, data: { status: "retired" } });
      await appendAudit({ actor: actor.id, type: "rule.retired", entity: "rule", entityId: id, payload: { reason: "[redacted]" } });
      return json({ ok: true, status: "retired" });
    }
    default:
      throw new MzError("MZ-VAL-422", "Unknown action.");
  }
});
