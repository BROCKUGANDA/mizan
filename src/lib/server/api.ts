/**
 * API helpers: request id, actor resolution, mode guard, rate limit,
 * error → RFC 9457 problem+json. Every error carries an MZ- code and
 * retryable flag; no empty catch blocks.
 */

import { NextRequest, NextResponse } from "next/server";
import { MzError, toMzError, generateCorrelationId } from "../domain/errors";
import { resolveActor, type ActorContext } from "./session";
import { getMode } from "./mode";
import { sha256 } from "../domain/canonical";
import { takeToken, sweepIfNeeded, ROUTE_BUDGETS } from "./rate-limit";

export interface Ctx<P = Record<string, string>> {
  req: NextRequest;
  actor: ActorContext;
  correlationId: string;
  params: P;
}

type RouteHandler<P> = (ctx: Ctx<P>) => Promise<NextResponse> | NextResponse;

/** Wrap a route handler with actor + rate limit + error handling; params are awaited and passed through. */
export function withApiRoute<P = Record<string, string>>(handler: RouteHandler<P>) {
  return async (req: NextRequest, ctx?: { params?: Promise<P> }): Promise<NextResponse> => {
    const correlationId = generateCorrelationId();
    try {
      const actor = await resolveActor(req.headers.get("x-mizan-actor"));
      sweepIfNeeded();
      const routeClass = classifyRoute(req.method, req.nextUrl.pathname);
      if (!takeToken(`${actor.id}:${routeClass}`, ROUTE_BUDGETS[routeClass])) {
        throw new MzError("MZ-RATE-429", `Rate limit for ${routeClass} requests exceeded; retry after Retry-After.`);
      }
      const params = (ctx?.params ? await ctx.params : ({} as P)) as P;
      return await handler({ req, actor, correlationId, params });
    } catch (e) {
      return problemResponse(e, correlationId);
    }
  };
}

function classifyRoute(method: string, path: string): keyof typeof ROUTE_BUDGETS {
  if (path.includes("/check")) return "check";
  if (path.includes("/datasets") && method === "POST") return "upload";
  if (path.endsWith("/runs") && method === "POST") return "run";
  if (path.includes("/export") || path.includes("/evidence-pack")) return "export";
  if (path.includes("/decisions") || path.includes("/countersign") || path.includes("/assignments") || path.includes("/comments") || path.includes("/bulk")) return "decision";
  if (method === "GET") return "read";
  return "config";
}

export function problemResponse(e: unknown, correlationId: string): NextResponse {
  const mz = toMzError(e);
  // Full detail stays server-side only (hardening): the wire body carries the
  // generic MZ- title/detail; intentional MzErrors are expected control flow
  // and are not logged, unexpected errors are logged with the correlation id.
  if (!(e instanceof MzError)) {
    console.error(`[mizan:api] ${correlationId} -> ${mz.code}`, e instanceof Error ? e.stack : e);
  }
  const body = { ...mz.toProblem(), correlationId } as Record<string, unknown>;
  const headers: Record<string, string> = { "content-type": "application/problem+json", "x-request-id": correlationId };
  if (mz.code === "MZ-RATE-429" || mz.code === "MZ-MODE-503" || mz.code === "MZ-DEP-503") headers["retry-after"] = "5";
  if (typeof body.currentVersion === "number") headers.etag = `W/"${body.currentVersion}"`;
  return NextResponse.json(body, { status: mz.status, headers });
}

export async function requireMode(kind: "decision" | "run" | "upload" | "config"): Promise<string> {
  const { mode } = await getMode();
  if (mode === "M3" && kind === "upload") throw new MzError("MZ-DEP-503", "Storage is degraded (M3): uploads and evidence packs are paused.");
  if (mode === "M4") throw new MzError("MZ-MODE-503", "MIZAN is read-only (M4). Writes are paused; drafts stay local.");
  if (mode === "M5" && (kind === "run" || kind === "upload")) throw new MzError("MZ-RUN-423", "Runs are locked by safe halt (M5). Reads and audit exports continue.");
  if (mode === "M5") throw new MzError("MZ-MODE-503", "Safe halt (M5): decisions are blocked until an administrator clears it.");
  return mode;
}

export function json(data: unknown, init?: number | ResponseInit): NextResponse {
  const res = NextResponse.json(data, typeof init === "number" ? { status: init } : init);
  res.headers.set("cache-control", "no-store");
  return res;
}

export function etagFor(obj: unknown): string {
  return `W/"${sha256(JSON.stringify(obj)).slice(0, 16)}"`;
}
