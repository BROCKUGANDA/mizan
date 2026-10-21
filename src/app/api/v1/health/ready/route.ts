import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** GET /api/v1/health/ready — database probe (queue/storage probes are stubs in the sandbox). */
export async function GET(): Promise<NextResponse> {
  try {
    await db.systemMode.findUnique({ where: { tenantId: "default" } });
    return NextResponse.json({ status: "ready", checks: { database: "ok", cache: "stub-ok (in-memory)", storage: "stub-ok (local fs)", queue: "stub-ok (in-process)" } });
  } catch (e) {
    return NextResponse.json({ status: "degraded", error: e instanceof Error ? e.message : "unknown" }, { status: 503 });
  }
}
