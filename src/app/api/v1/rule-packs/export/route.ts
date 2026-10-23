import { withApiRoute, json } from "@/lib/server/api";
import { MzError } from "@/lib/domain/errors";
import { RULE_SPECS, PACK_VERSION } from "@/lib/pack/rules";
import { sha256Json } from "@/lib/domain/canonical";
import { stringify } from "yaml";

export const dynamic = "force-dynamic";

/** GET /api/v1/rule-packs/export — portable YAML with tests and a canonical hash. */
export const GET = withApiRoute(async ({ actor }) => {
  if (!["policy_author", "policy_approver", "admin", "compliance_lead", "auditor"].includes(actor.role)) {
    throw new MzError("MZ-AUTH-403", "Your role cannot export the rule pack.");
  }
  const rules = RULE_SPECS.map((r) => ({ ...r, tests: r.tests }));
  const payload = { packVersion: PACK_VERSION, hash: sha256Json(rules), rules };
  return json({ filename: `emirates-hr-${PACK_VERSION}.yaml`, yaml: stringify(payload), hash: payload.hash, rules: rules.length });
});
