import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { objectStoreHealth } from "@/lib/server/object-store";
import { cacheHealth } from "@/lib/server/cache";

export const dynamic = "force-dynamic";

/** GET /api/v1/health/ready — real dependency probes: database, object store, cache and outbox. */
export async function GET(): Promise<NextResponse> {
  const checks: Record<string, { ok: boolean; detail: string }> = {};
  try {
    await db.systemMode.findUnique({ where: { tenantId: "default" } });
    checks.database = { ok: true, detail: "SQLite reachable" };
  } catch (error) {
    checks.database = { ok: false, detail: error instanceof Error ? error.message : "database unavailable" };
  }
  checks.objectStore = await objectStoreHealth();
  const cache = cacheHealth();
  checks.cache = { ok: cache.ok, detail: cache.detail };
  try {
    const pending = await db.outbox.count({ where: { status: "pending" } });
    checks.outbox = { ok: true, detail: `${pending} pending notification(s)` };
  } catch (error) {
    checks.outbox = { ok: false, detail: error instanceof Error ? error.message : "outbox unavailable" };
  }
  const ready = checks.database.ok && checks.objectStore.ok;
  return NextResponse.json({ status: ready ? "ready" : "degraded", checks }, { status: ready ? 200 : 503 });
}
