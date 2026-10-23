import { withApiRoute, json } from "@/lib/server/api";
import { db } from "@/lib/db";
import { randomUUID } from "node:crypto";
import { detectPatterns } from "@/lib/server/patterns";
import { loadTransactions, loadEmployees } from "@/lib/server/run-pipeline";

export const dynamic = "force-dynamic";

/** GET /api/v1/patterns — advisory alerts; visible to compliance roles only (§18). */
export const GET = withApiRoute(async ({ actor }) => {
  if (actor.role === "ops_owner") {
    return json({ items: [], note: "Pattern alerts are advisory and visible to compliance roles only." });
  }
  // Detector run (cold job in production): refresh when the table is empty
  let items = await db.patternAlert.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
  if (items.length === 0) {
    const [transactions, employees] = await Promise.all([loadTransactions(), loadEmployees()]);
    const detected = detectPatterns(transactions, employees);
    // Deduplicate by patternId + title, cap per pattern for a calm review queue
    const perPattern: Record<string, number> = {};
    for (const d of detected) {
      perPattern[d.patternId] = (perPattern[d.patternId] ?? 0) + 1;
      if (perPattern[d.patternId]! > 8) continue;
      await db.patternAlert.create({
        data: { id: d.id, patternId: d.patternId, title: d.title, neutralText: d.neutralText, detailJson: JSON.stringify(d.detail) },
      });
    }
    items = await db.patternAlert.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
    if (detected.length === 0) {
      await db.patternAlert.create({ data: { id: `P00-${randomUUID().slice(0, 4)}`, patternId: "P00", title: "No pattern alerts detected on the current dataset", neutralText: "The detectors found nothing to review on this dataset.", detailJson: "{}" } });
      items = await db.patternAlert.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
    }
  }
  return json({ items, advisory: true, note: "Pattern alerts never appear in exports or routing." });
});
