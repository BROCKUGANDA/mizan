import { withApiRoute, json } from "@/lib/server/api";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/notifications — in-app notifications with the 10-in-15-minutes
 * digest (EC-K07). Individual messages remain in the outbox for audit.
 */
export const GET = withApiRoute(async ({ actor }) => {
  const rows = await db.outbox.findMany({ where: { type: "notification.inapp" }, orderBy: { createdAt: "desc" }, take: 200 });
  type Item = { id: string; at: Date; exceptionKey: string | null; team: string | null; severity: string | null; headline: string; event: string | null; status: string | null; digest?: boolean; count?: number; windowStart?: string };
  const items: Item[] = rows.map((o) => {
    const p = JSON.parse(o.payloadJson) as { exceptionKey?: string; team?: string; severity?: string; headline?: string; event?: string; to?: string };
    return {
      id: o.id, at: o.createdAt, exceptionKey: p.exceptionKey ?? null, team: p.team ?? null,
      severity: p.severity ?? null, headline: p.headline ?? p.event ?? o.type, event: p.event ?? null, status: p.to ?? null,
    };
  });
  const WINDOW = 15 * 60 * 1000;
  const byTeam = new Map<string, Item[]>();
  for (const item of items) {
    const key = item.team ?? "unassigned";
    const list = byTeam.get(key) ?? [];
    list.push(item);
    byTeam.set(key, list);
  }
  const digested = new Set<string>();
  const digests: Item[] = [];
  for (const [team, list] of byTeam) {
    const ascending = [...list].sort((a, b) => a.at.getTime() - b.at.getTime());
    for (let i = 0; i < ascending.length; i++) {
      const window = ascending.filter((x) => x.at.getTime() >= ascending[i]!.at.getTime() && x.at.getTime() - ascending[i]!.at.getTime() <= WINDOW);
      if (window.length > 10 && !window.some((w) => digested.has(w.id))) {
        for (const w of window) digested.add(w.id);
        const latest = window[window.length - 1]!;
        const worst = window.map((w) => w.severity ?? "LOW").sort((a, b) => ["CRITICAL", "HIGH", "MEDIUM", "LOW"].indexOf(a) - ["CRITICAL", "HIGH", "MEDIUM", "LOW"].indexOf(b))[0]!;
        digests.push({
          id: `digest-${team}-${ascending[i]!.at.getTime()}`, at: latest.at, exceptionKey: null, team,
          severity: worst, headline: `${window.length} notifications for ${team} within 15 minutes`, event: "digest",
          status: null, digest: true, count: window.length, windowStart: ascending[i]!.at.toISOString(),
        });
      }
    }
  }
  const visible = [...items.filter((i) => !digested.has(i.id)), ...digests].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 80);
  return json({ items: visible, actor: actor.id });
});
