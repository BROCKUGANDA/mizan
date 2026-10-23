import { withApiRoute, json } from "@/lib/server/api";
import { db } from "@/lib/db";
import { appendAudit } from "@/lib/audit/chain";
import { MzError } from "@/lib/domain/errors";
import { sha256Json } from "@/lib/domain/canonical";
import { validateRuleSpec, ruleLogicHash } from "@/lib/pack/rules";
import { randomUUID } from "node:crypto";
import type { RuleSpec, InterpretationRecord } from "@/lib/contracts";

export const dynamic = "force-dynamic";

interface DraftTransitionBody {
  action: "submit" | "approve" | "reject";
  reason?: string;
  acknowledged?: boolean;
}

/**
 * POST /api/v1/rules/drafts/{id}/transition
 * submit (author) → approve (different policy approver; creates an immutable
 * Rule + RuleVersion bound to the backtest) or reject.
 */
export const POST = withApiRoute<{ id: string }>(async ({ req, actor, params }) => {
  const body = (await req.json()) as DraftTransitionBody;
  const draft = await db.ruleDraft.findUnique({ where: { id: params.id } });
  if (!draft) throw new MzError("MZ-AUTH-403", "Draft not found");
  if (!draft.specJson) throw new MzError("MZ-VAL-422", "The draft has no spec.");
  const spec = JSON.parse(draft.specJson) as RuleSpec;
  const backtest = draft.backtestJson ? JSON.parse(draft.backtestJson) as { specHash: string; failRate: number; wouldFlag: number } : null;

  if (body.action === "submit") {
    if (!["policy_author", "admin", "compliance_lead"].includes(actor.role)) throw new MzError("MZ-AUTH-403", "Only a policy author can submit a draft.");
    if (draft.author !== actor.id && actor.role !== "admin" && actor.role !== "compliance_lead") throw new MzError("MZ-AUTH-403", "Only the author can submit this draft.");
    if (!backtest) throw new MzError("MZ-RULE-422", "A backtest on the exact spec is required before submission (FS-19).");
    if (backtest.specHash !== sha256Json(spec)) throw new MzError("MZ-RULE-422", "The spec changed after its backtest; re-run the backtest (EC-I06).");
    const errors = validateRuleSpec(spec);
    if (errors.length) throw new MzError("MZ-RULE-422", `RuleSpec invalid: ${errors.join("; ")}`);
    if (backtest.failRate > 10 && body.acknowledged !== true) {
      throw new MzError("MZ-RULE-422", `This rule flags ${backtest.failRate.toFixed(1)}% of applicable history. Explicit acknowledgement is required (FS-19).`);
    }
    await db.ruleDraft.update({ where: { id: params.id }, data: { status: "submitted" } });
    await appendAudit({ actor: actor.id, type: "rule.submitted", entity: "rule_draft", entityId: params.id, payload: { ruleId: spec.id, specHash: backtest.specHash, failRate: backtest.failRate, acknowledged: body.acknowledged === true } });
    return json({ ok: true, status: "submitted", ruleId: spec.id });
  }

  if (body.action === "reject") {
    if (!["policy_approver", "admin"].includes(actor.role)) throw new MzError("MZ-AUTH-403", "Only a policy approver can reject a draft.");
    if (!body.reason || body.reason.trim().length < 5) throw new MzError("MZ-VAL-422", "A rejection needs a reason.");
    await db.ruleDraft.update({ where: { id: params.id }, data: { status: "rejected" } });
    await appendAudit({ actor: actor.id, type: "rule.rejected", entity: "rule_draft", entityId: params.id, payload: { ruleId: spec.id, reason: "[redacted]" } });
    return json({ ok: true, status: "rejected" });
  }

  // approve
  if (!["policy_approver", "admin"].includes(actor.role)) throw new MzError("MZ-AUTH-403", "Only a policy approver can approve a rule.");
  if (draft.author === actor.id) throw new MzError("MZ-RULE-403-SELF", "The author cannot approve their own rule version (two-person rule).");
  if (draft.status !== "submitted") throw new MzError("MZ-VAL-422", `A draft in status ${draft.status} cannot be approved.`);
  if (!backtest) throw new MzError("MZ-RULE-422", "A backtest is required before approval.");
  if (backtest.specHash !== sha256Json(spec)) throw new MzError("MZ-RULE-422", "The spec changed after its backtest; re-run the backtest (EC-I06).");
  const existing = await db.rule.findUnique({ where: { id: spec.id } });
  if (existing) throw new MzError("MZ-RULE-422", `Rule id ${spec.id} is already in use.`);
  const errors = validateRuleSpec(spec);
  if (errors.length) throw new MzError("MZ-RULE-422", `RuleSpec invalid: ${errors.join("; ")}`);

  const interpretation: InterpretationRecord = {
    ruleId: spec.id,
    readings: (() => {
      const raw = draft.ambiguitiesJson ? JSON.parse(draft.ambiguitiesJson) as { chip: string; options: string[]; chosen: string | null; note: string }[] : [];
      return raw.map((a) => ({ option: a.chip, description: { en: a.note, ar: a.note }, chosen: a.chosen !== null, basis: a.chosen ?? "unresolved" }));
    })(),
    ambiguityChips: (() => {
      const raw = draft.ambiguitiesJson ? JSON.parse(draft.ambiguitiesJson) as { chip: string; options: string[]; chosen: string | null }[] : [];
      return raw.map((a) => ({ chip: a.chip, options: a.options, chosen: a.chosen ?? "" }));
    })(),
    comparatorSemantics: [{ term: "above", meaning: "strictly greater than" }, { term: "at least / or above", meaning: "greater than or equal" }],
    notes: { en: draft.plainEnglish, ar: draft.plainEnglish },
  };
  const ruleId = spec.id;
  const version = "1.0.0";
  const specHash = sha256Json(spec);
  const specWithVersion: RuleSpec = { ...spec, version, status: "approved" };
  await db.$transaction(async (tx) => {
    await tx.rule.create({
      data: {
        id: ruleId, version, family: spec.family, title: spec.title,
        verbatimText: spec.clauses.map((c) => c.text).join(" "), anchor: spec.source.anchor,
        textSha256: spec.source.sha256, status: "approved", specJson: JSON.stringify(specWithVersion),
        interpretationJson: JSON.stringify(interpretation), baseSeverity: spec.severity.base,
        modifiersJson: JSON.stringify(spec.severity.modifiers), routingProcess: spec.routing.process,
        actionTemplate: spec.action.template, effectiveFrom: spec.effective.from, author: draft.author,
        specHash, backtestJson: draft.backtestJson, sourceDraftId: draft.id,
      },
    });
    await tx.ruleVersion.create({
      data: { id: `${ruleId}@${version}`, ruleId, version, specJson: JSON.stringify(specWithVersion), specHash, status: "approved", effectiveFrom: spec.effective.from, author: draft.author, backtestJson: draft.backtestJson },
    });
    await tx.ruleApproval.create({ data: { id: randomUUID(), ruleId, version, approver: actor.id, decision: "approved", reason: "approved from rule studio draft" } });
    await tx.ruleDraft.update({ where: { id: draft.id }, data: { status: "approved" } });
    await appendAudit({ actor: actor.id, type: "rule.approved", entity: "rule", entityId: ruleId, payload: { version, draftId: draft.id, specHash, logicHash: ruleLogicHash(spec) } }, tx);
  }, { timeout: 15_000 });
  return json({ ok: true, status: "approved", ruleId, version, specHash, note: "Approved. Activate as shadow first; a shadow run is required before active." });
});
