import { withApiRoute, json } from "@/lib/server/api";
import { getMode, MODE_META } from "@/lib/server/mode";
import { db } from "@/lib/db";
import { DEFAULT_ACTOR } from "@/lib/app-config";

export const dynamic = "force-dynamic";

/** GET /api/v1/system/state — mode, profile, flags, actors (the boot payload). */
export const GET = withApiRoute(async ({ req }) => {
  const mode = await getMode();
  const flags = await db.featureFlag.findMany({ orderBy: { key: "asc" } });
  const actors = await db.actor.findMany({ orderBy: { id: "asc" } });
  const latestRun = await db.run.findFirst({ orderBy: { startedAt: "desc" } });
  return json({
    mode: { current: mode.mode, ...MODE_META[mode.mode], reason: mode.reason, operator: mode.operator, since: mode.since },
    profile: "judge",
    syntheticOnly: true,
    flags: flags.filter((f) => f.key !== "backtest.baselines").map((f) => ({ key: f.key, value: f.value, updatedBy: f.updatedBy, reason: f.reason, updatedAt: f.updatedAt })),
    actors: actors.map((a) => ({ id: a.id, name: a.name, role: a.role })),
    currentActor: req.headers.get("x-mizan-actor") ?? DEFAULT_ACTOR,
    latestRunId: latestRun?.id ?? null,
  });
});
