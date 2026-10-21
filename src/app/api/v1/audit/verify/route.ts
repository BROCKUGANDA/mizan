import { withApiRoute, json } from "@/lib/server/api";
import { verifyChain } from "@/lib/audit/chain";
import { getMode, setMode } from "@/lib/server/mode";

export const dynamic = "force-dynamic";

/** GET /api/v1/audit/verify — chain verification; a failure enters safe halt (RB-03). */
export const GET = withApiRoute(async () => {
  const verify = await verifyChain();
  if (!verify.ok) {
    const mode = await getMode();
    if (mode.mode !== "M5") {
      await setMode("M5", `integrity.verify failed at seq ${verify.firstBadSeq}`, "system:integrity");
    }
  }
  return json(verify);
});
