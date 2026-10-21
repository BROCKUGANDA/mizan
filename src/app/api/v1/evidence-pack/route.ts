import { withApiRoute, json } from "@/lib/server/api";
import { db } from "@/lib/db";
import { MzError } from "@/lib/domain/errors";
import { sha256, canonicalJson } from "@/lib/domain/canonical";
import { RULE_SPECS, INTERPRETATIONS } from "@/lib/pack/rules";
import { verifyChain } from "@/lib/audit/chain";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/evidence-pack?scope=exception:<key>|run:<id>
 * Per-scope or per-run pack: findings, manifest, rule pack, interpretation records,
 * audit extract and chain verification — with a signed (hash-anchored) manifest.
 */
export const GET = withApiRoute(async ({ req }) => {
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope");
  if (!scope) throw new MzError("MZ-VAL-422", "scope=exception:<key> or run:<id> is required.");

  const [kind, ref] = scope.split(":");
  const exceptions = kind === "exception"
    ? await db.exception.findMany({ where: { exceptionKey: ref } })
    : kind === "run"
      ? await db.exception.findMany({ where: { lastRunId: ref } })
      : [];
  if (!exceptions.length) throw new MzError("MZ-AUTH-403", "Not found");

  const run = kind === "run" ? await db.run.findUnique({ where: { id: ref } }) : await db.run.findFirst({ orderBy: { startedAt: "desc" } });
  const events = await db.auditEvent.findMany({
    where: { entityId: { in: exceptions.map((e) => e.exceptionKey) } },
    orderBy: { seq: "asc" }, take: 500,
  });
  const verify = await verifyChain();

  const files: Record<string, string> = {
    "findings.json": canonicalJson(exceptions.map((e) => ({ key: e.exceptionKey, displayId: e.displayId, ruleId: e.ruleId, clauseId: e.clauseId, severity: e.severity, status: e.status, explanation: { en: e.explanationEn, ar: e.explanationAr }, evidence: JSON.parse(e.evidenceJson) }))),
    "rule-pack.json": canonicalJson(RULE_SPECS),
    "interpretations.json": canonicalJson(INTERPRETATIONS),
    "run-manifest.json": run ? canonicalJson({ runId: run.id, counts: JSON.parse(run.countsJson), outputHash: run.outputHash, packHash: run.packHash, calendarHash: run.calendarHash, asOf: run.asOf }) : "{}",
    "audit-extract.json": canonicalJson(events.map((e) => ({ seq: e.seq, at: e.at, actor: e.actor, type: e.type, payloadJson: e.payloadJson, prevHash: e.prevHash, hash: e.hash }))),
    "chain-verification.json": canonicalJson(verify),
  };
  const manifest = {
    scope,
    generatedAt: new Date().toISOString(),
    files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, sha256(content)])),
    signature: sha256(canonicalJson(Object.values(files))),
  };

  return json({ manifest, files });
});
