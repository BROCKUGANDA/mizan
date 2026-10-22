import { withApiRoute, json } from "@/lib/server/api";
import { getIntegrationRegistry, serializeIntegration } from "@/lib/integrations/registry";

export const dynamic = "force-dynamic";

/** GET /api/v1/integrations — catalog of seams with live health (stubs in the sandbox). */
export const GET = withApiRoute(async () => {
  const entries = getIntegrationRegistry();
  const healths = await Promise.all(
    entries.map(async (e) => ({ id: e.id, health: await safeHealth(e) }))
  );
  const byId = new Map(healths.map((h) => [h.id, h.health]));
  return json({
    syntheticOnly: true,
    note: "Live connection to Emirates systems is intentionally disabled (synthetic-data red line). Every entry is a documented integration seam served by a stub.",
    integrations: entries.map((e) => serializeIntegration(e, byId.get(e.id) ?? { ok: false, detail: "health probe failed", mode: "unknown" })),
  });
});

async function safeHealth(e: { health: () => Promise<{ ok: boolean; detail: string; mode: string }> }) {
  try {
    return await e.health();
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "health probe failed", mode: "unknown" };
  }
}
