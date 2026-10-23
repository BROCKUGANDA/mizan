import { withApiRoute, json } from "@/lib/server/api";
import { db } from "@/lib/db";
import { MzError } from "@/lib/domain/errors";
import { parse } from "yaml";
import { sha256Json } from "@/lib/domain/canonical";
import { validateRuleSpec } from "@/lib/pack/rules";
import { appendAudit } from "@/lib/audit/chain";
import { randomUUID } from "node:crypto";
import type { RuleSpec } from "@/lib/contracts";

export const dynamic = "force-dynamic";

interface PackFile { packVersion?: string; hash?: string; rules?: RuleSpec[] }

/**
 * POST /api/v1/rule-packs/import — a portable pack becomes drafts for human
 * review. Nothing is activated by import; approval and a shadow run still gate it.
 */
export const POST = withApiRoute(async ({ req, actor }) => {
  if (!["policy_author", "admin", "compliance_lead"].includes(actor.role)) throw new MzError("MZ-AUTH-403", "Only a policy author can import a rule pack.");
  const text = await req.text();
  if (!text.trim()) throw new MzError("MZ-VAL-422", "The request body must be a YAML rule pack.");
  let parsed: PackFile;
  try { parsed = parse(text) as PackFile; } catch { throw new MzError("MZ-VAL-422", "The YAML is not valid."); }
  if (!Array.isArray(parsed.rules) || !parsed.rules.length) throw new MzError("MZ-VAL-422", "The pack has no rules.");
  const canonicalHash = sha256Json(parsed.rules);
  const drafts: { id: string; ruleId: string; errors: string[] }[] = [];
  for (const spec of parsed.rules) {
    const existing = await db.rule.findUnique({ where: { id: spec.id } });
    if (existing) {
      drafts.push({ id: "", ruleId: spec.id, errors: [`rule ${spec.id} already exists; import as a new version through the studio`] });
      continue;
    }
    const errors = validateRuleSpec(spec);
    if (errors.length) { drafts.push({ id: "", ruleId: spec.id, errors }); continue; }
    const id = `draft-${randomUUID().slice(0, 8)}`;
    await db.ruleDraft.create({
      data: {
        id, plainEnglish: spec.title, specJson: JSON.stringify({ ...spec, status: "draft" }),
        ambiguitiesJson: "[]", status: "draft", author: actor.id,
        backtestJson: JSON.stringify({ importedFromPack: parsed.packVersion ?? "imported", specHash: sha256Json(spec), note: "import requires a fresh backtest before submission" }),
      },
    });
    drafts.push({ id, ruleId: spec.id, errors: [] });
  }
  await appendAudit({ actor: actor.id, type: "rule_pack.imported", entity: "rule_pack", entityId: parsed.packVersion ?? "imported", payload: { rules: parsed.rules.length, drafts: drafts.filter((d) => d.id).length, hash: canonicalHash, declaredHash: parsed.hash ?? null } });
  return json({
    ok: true,
    packVersion: parsed.packVersion ?? "imported",
    hash: canonicalHash,
    hashMatches: parsed.hash ? parsed.hash === canonicalHash : null,
    drafts,
    note: "Imported rules are drafts. Each needs a fresh backtest and a second-person approval before activation.",
  }, 201);
});
