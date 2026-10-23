import { withApiRoute, json } from "@/lib/server/api";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** GET /api/v1/exceptions — queue with filters, sort, cursor pagination. */
export const GET = withApiRoute(async ({ req }) => {
  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10)));
  const cursor = url.searchParams.get("cursor");
  const status = url.searchParams.get("status");
  const severity = url.searchParams.get("severity");
  const ruleId = url.searchParams.get("ruleId");
  const ownerTeam = url.searchParams.get("ownerTeam");
  const q = url.searchParams.get("q");
  const openOnly = url.searchParams.get("open") === "true";

  const where: Record<string, unknown> = {};
  if (status) where.status = { in: status.split(",") };
  if (severity) where.severity = { in: severity.split(",") };
  if (ruleId) where.ruleId = ruleId;
  if (ownerTeam) where.ownerTeam = ownerTeam;
  if (q) where.OR = [{ txnId: { contains: q } }, { headlineEn: { contains: q } }, { displayId: { contains: q } }];
  if (openOnly) where.status = { in: ["NEW", "TRIAGED", "ASSIGNED", "IN_PROGRESS", "PENDING_VERIFICATION", "REOPENED"] };

  const items = await db.exception.findMany({
    where,
    orderBy: [{ severity: "asc" }, { createdAt: "desc" }],
    take: limit + 1,
    ...(cursor ? { skip: 1, cursor: { exceptionKey: cursor } } : {}),
  });
  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  const total = await db.exception.count({ where });
  return json({
    items: page.map((e) => ({
      exceptionKey: e.exceptionKey,
      displayId: e.displayId,
      txnId: e.txnId,
      ruleId: e.ruleId,
      clauseId: e.clauseId,
      ruleVersion: e.ruleVersion,
      family: e.family,
      severity: e.severity,
      status: e.status,
      version: e.version,
      headlineEn: e.headlineEn,
      headlineAr: e.headlineAr,
      ownerTeam: e.ownerTeam,
      ackDueAt: e.ackDueAt,
      resolveDueAt: e.resolveDueAt,
      heldReason: e.heldReason,
      noLongerDetected: e.noLongerDetected,
      groupKey: e.groupKey,
      createdAt: e.createdAt,
    })),
    nextCursor: hasMore ? page[page.length - 1]?.exceptionKey ?? null : null,
    total,
  });
});
