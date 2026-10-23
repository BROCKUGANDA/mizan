import { withApiRoute, json } from "@/lib/server/api";
import { runDeadlineTick } from "@/lib/server/deadlines";
import { MzError } from "@/lib/domain/errors";

export const dynamic = "force-dynamic";

/** POST /api/v1/deadlines/tick — run the deadline job now (admin/compliance). */
export const POST = withApiRoute(async ({ actor }) => {
  if (!["admin", "compliance_lead"].includes(actor.role)) throw new MzError("MZ-AUTH-403", "Only an administrator or compliance lead can run the deadline tick.");
  return json(await runDeadlineTick());
});
