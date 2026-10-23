import { withApiRoute, json } from "@/lib/server/api";
import { getEvidencePack, verifyEvidencePack } from "@/lib/server/evidence";
import { MzError } from "@/lib/domain/errors";

export const dynamic = "force-dynamic";

/** GET /api/v1/evidence-packs/{id} — download and verify a stored pack. */
export const GET = withApiRoute<{ id: string }>(async ({ params }) => {
  const pack = await getEvidencePack(params.id);
  if (!pack) throw new MzError("MZ-AUTH-403", "Not found");
  return json({ ...pack, verification: verifyEvidencePack(pack) });
});
