import { withApiRoute } from "@/lib/server/api";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { MzError } from "@/lib/domain/errors";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/runs/{id}/events — server-sent progress. Heartbeat every 15 s;
 * Last-Event-ID resumes from the last seen stage sequence. Falls back to
 * polling on the client after three failed reconnects.
 */
export const GET = withApiRoute<{ id: string }>(async ({ req, params }) => {
  const run = await db.run.findUnique({ where: { id: params.id } });
  if (!run) throw new MzError("MZ-AUTH-403", "Not found");
  const lastEventId = Number(req.headers.get("last-event-id") ?? "0");
  const stream = new ReadableStream({
    start(controller) {
      let seq = Number.isFinite(lastEventId) ? lastEventId : 0;
      let closed = false;
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown, id = seq + 1): void => {
        if (closed) return;
        seq = id;
        controller.enqueue(encoder.encode(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const poll = async (): Promise<void> => {
        if (closed) return;
        const current = await db.run.findUnique({ where: { id: params.id } });
        if (!current) { closed = true; controller.close(); return; }
        const counts = JSON.parse(current.countsJson || "{}");
        send("run.progress", { runId: current.id, status: current.status, counts, outputHash: current.outputHash, finishedAt: current.finishedAt });
        if (["COMPLETED", "COMPLETED_WITH_HOLDS", "COMPLETED_WITH_DQ", "FAILED", "CANCELLED"].includes(current.status)) {
          send("run.completed", { runId: current.id, status: current.status, outputHash: current.outputHash });
          closed = true;
          clearInterval(timer);
          controller.close();
        }
      };
      const timer = setInterval(() => { void poll(); }, 2_000);
      void poll();
      req.signal.addEventListener("abort", () => {
        closed = true;
        clearInterval(timer);
        try { controller.close(); } catch { /* already closed */ }
      });
    },
  });
  return new NextResponse(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" } });
});
