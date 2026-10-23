import { withApiRoute, json } from "@/lib/server/api";
import { buildEvidencePack } from "@/lib/server/evidence";
import { MzError } from "@/lib/domain/errors";

export const dynamic = "force-dynamic";

/** GET /api/v1/evidence-pack?scope=exception:<key>|run:<id> — legacy read alias. */
export const GET = withApiRoute(async ({ req, actor }) => {
  if (!["auditor", "compliance_lead", "admin", "analyst"].includes(actor.role)) throw new MzError("MZ-AUTH-403", "Your role cannot export evidence.");
  const scope = new URL(req.url).searchParams.get("scope");
  if (!scope) throw new MzError("MZ-VAL-422", "scope=exception:<key> or run:<id> is required.");
  return json(await buildEvidencePack(scope));
});
