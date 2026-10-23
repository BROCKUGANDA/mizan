import { withApiRoute, json } from "@/lib/server/api";
import { db } from "@/lib/db";
import { MzError } from "@/lib/domain/errors";

export const dynamic = "force-dynamic";

/** GET /api/v1/runs/{a}/diff/{b} — added, removed and changed findings. */
export const GET = withApiRoute<{ id: string; b: string }>(async ({ params }) => {
  const [a, b] = await Promise.all([db.run.findUnique({ where: { id: params.id } }), db.run.findUnique({ where: { id: params.b } })]);
  if (!a || !b) throw new MzError("MZ-AUTH-403", "Not found");
  const [fa, fb] = await Promise.all([db.runFinding.findMany({ where: { runId: a.id } }), db.runFinding.findMany({ where: { runId: b.id } })]);
  const key = (r: { rowId: string; ruleId: string; clauseId: string }): string => `${r.rowId}|${r.ruleId}|${r.clauseId}`;
  const ma = new Map(fa.map((r) => [key(r), r]));
  const mb = new Map(fb.map((r) => [key(r), r]));
  const added = [...mb.entries()].filter(([k]) => !ma.has(k)).map(([, r]) => ({ rowId: r.rowId, txnId: r.txnId, ruleId: r.ruleId, clauseId: r.clauseId, severity: r.severity }));
  const removed = [...ma.entries()].filter(([k]) => !mb.has(k)).map(([, r]) => ({ rowId: r.rowId, txnId: r.txnId, ruleId: r.ruleId, clauseId: r.clauseId, severity: r.severity }));
  const changed = [...ma.entries()].filter(([k, r]) => mb.has(k) && mb.get(k)!.evidenceHash !== r.evidenceHash).map(([k, r]) => ({ key: k, fromSeverity: r.severity, toSeverity: mb.get(k)!.severity }));
  return json({ a: { id: a.id, asOf: a.asOf, outputHash: a.outputHash }, b: { id: b.id, asOf: b.asOf, outputHash: b.outputHash }, added, removed, changed, counts: { added: added.length, removed: removed.length, changed: changed.length } });
});
