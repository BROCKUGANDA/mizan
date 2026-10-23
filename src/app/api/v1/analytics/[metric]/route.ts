import { withApiRoute, json } from "@/lib/server/api";
import { db } from "@/lib/db";
import { MzError } from "@/lib/domain/errors";
import { computeFairness, computeHotspots, computeReadiness, computeTrends } from "@/lib/server/analytics";
import { diffDays, instantToDubaiDate } from "@/lib/domain/dates";
import { ESCALATION_LADDER } from "@/lib/domain/calendar";

export const dynamic = "force-dynamic";

/** GET /api/v1/analytics/{hotspots|trends|readiness|deadlines}. */
export const GET = withApiRoute<{ metric: string }>(async ({ params }) => {
  switch (params.metric) {
    case "hotspots":
      return json({ items: await computeHotspots() });
    case "trends":
      return json({ items: await computeTrends() });
    case "readiness":
      return json(await computeReadiness());
    case "fairness":
      return json({ items: await computeFairness(), note: "Rates per 100,000 checks; cells with fewer than 5 employees are suppressed." });
    case "deadlines": {
      const now = instantToDubaiDate(new Date().toISOString());
      const open = await db.exception.findMany({ where: { status: { in: ["NEW", "TRIAGED", "ASSIGNED", "IN_PROGRESS", "PENDING_VERIFICATION", "REOPENED"] }, resolveDueAt: { not: null } } });
      const items = open.map((e) => {
        const start = instantToDubaiDate(e.createdAt.toISOString());
        const total = Math.max(1, diffDays(e.resolveDueAt!, start));
        const elapsed = diffDays(now, start);
        const ratio = Math.round((elapsed / total) * 100) / 100;
        const level = ratio >= ESCALATION_LADDER[2]! ? 3 : ratio >= ESCALATION_LADDER[1]! ? 2 : ratio >= ESCALATION_LADDER[0]! ? 1 : 0;
        return { exceptionKey: e.exceptionKey, displayId: e.displayId, severity: e.severity, ownerTeam: e.ownerTeam, dueAt: e.resolveDueAt, remainingDays: diffDays(e.resolveDueAt!, now), ratio, escalationLevel: level };
      }).sort((a, b) => a.remainingDays - b.remainingDays);
      return json({ asOf: now, items });
    }
    default:
      throw new MzError("MZ-VAL-422", `Unknown analytics metric ${params.metric}.`);
  }
});
