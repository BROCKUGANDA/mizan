import { NextResponse } from "next/server";

export const dynamic = "force-static";

/** GET /api/v1/health/live — liveness only; no dependency checks. */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ status: "live" });
}
