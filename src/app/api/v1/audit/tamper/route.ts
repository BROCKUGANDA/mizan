import { withApiRoute, json } from "@/lib/server/api";
import { db } from "@/lib/db";
import { MzError } from "@/lib/domain/errors";
import { verifyChain } from "@/lib/audit/chain";
import { getMode, setMode } from "@/lib/server/mode";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/audit/tamper — judge-mode demonstration only: mutates one audit row
 * to show that the chain verification catches it and the system enters M5.
 * The audit table is append-only in production (UPDATE/DELETE revoked).
 */
export const POST = withApiRoute(async ({ actor }) => {
  if (actor.role !== "admin") throw new MzError("MZ-AUTH-403", "Only an administrator can run the tamper demonstration.");
  const row = await db.auditEvent.findFirst({ orderBy: { seq: "asc" }, skip: 2 });
  if (!row) throw new MzError("MZ-VAL-422", "Not enough audit events to demonstrate tampering.");
  // Raw mutation (bypasses the append-only discipline on purpose, for the demo)
  await db.$executeRawUnsafe(`UPDATE AuditEvent SET payloadJson = json_set(payloadJson, '$.tampered', json('true')) WHERE seq = ${row.seq}`);
  const verify = await verifyChain();
  if (!verify.ok) {
    const mode = await getMode();
    if (mode.mode !== "M5") {
      await setMode("M5", `integrity.verify failed at seq ${verify.firstBadSeq} (tamper demonstration)`, "system:integrity");
    }
  }
  return json({ tamperedSeq: row.seq, verify, note: verify.ok ? "verification unexpectedly passed" : "Chain verification failed → safe halt (M5)" });
});
