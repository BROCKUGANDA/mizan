import { withApiRoute, json } from "@/lib/server/api";
import { buildEvidencePack } from "@/lib/server/evidence";
import { MzError } from "@/lib/domain/errors";
import { appendAudit } from "@/lib/audit/chain";

export const dynamic = "force-dynamic";

/** POST /api/v1/evidence-packs — build a per-exception or per-run pack (role: audit). */
export const POST = withApiRoute(async ({ req, actor }) => {
  if (!["auditor", "compliance_lead", "admin"].includes(actor.role)) throw new MzError("MZ-AUTH-403", "Only audit and compliance roles can build evidence packs.");
  const body = (await req.json()) as { scope?: string };
  if (!body.scope) throw new MzError("MZ-VAL-422", "scope=exception:<key> or run:<id> is required.");
  const pack = await buildEvidencePack(body.scope);
  await appendAudit({ actor: actor.id, type: "evidence.pack_built", entity: "evidence_pack", entityId: pack.manifest.id, payload: { scope: body.scope, files: Object.keys(pack.files).length, signature: pack.manifest.signature } });
  return json(pack, 201);
});
