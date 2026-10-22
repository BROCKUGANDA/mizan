import { withApiRoute, json } from "@/lib/server/api";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { MzError } from "@/lib/domain/errors";
import { renderFindingsCsv, renderDataQualityCsv, validateFindingsCsv, type FindingRow, type DqRow } from "@/lib/server/export";
import { EXPORT_PROFILE } from "@/lib/pack/finding-format";
import { loadTransactions } from "@/lib/server/run-pipeline";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/runs/{id}/export — findings file in the official format + data_quality.csv.
 * The export is validated (FS-20) before download is enabled; `Digest` header carries sha-256.
 */
export const GET = withApiRoute<{ id: string }>(async ({ req, params }) => {
  const enabled = await db.featureFlag.findUnique({ where: { key: "exports.findings.enabled" } });
  if (enabled?.value === "false") throw new MzError("MZ-MODE-503", "The findings export is off by flag exports.findings.enabled.");

  const run = await db.run.findUnique({ where: { id: params.id } });
  if (!run) throw new MzError("MZ-AUTH-403", "Not found");
  if (!["COMPLETED", "COMPLETED_WITH_HOLDS", "COMPLETED_WITH_DQ"].includes(run.status)) {
    throw new MzError("MZ-VAL-422", `Run ${run.id} has not completed (status ${run.status}).`);
  }

  const format = new URL(req.url).searchParams.get("format") ?? "bundle";
  const exceptions = await db.exception.findMany({ where: { lastRunId: run.id, family: { not: "data_quality" } } });
  const transactions = await loadTransactions();

  const findings: FindingRow[] = exceptions.map((e) => {
    const txn = transactions.find((t) => t.txnId === e.txnId);
    return {
      finding_id: e.displayId,
      txnId: e.txnId,
      ruleId: e.ruleId,
      ruleVersion: e.ruleVersion,
      clauseId: e.clauseId,
      severity: e.severity,
      headlineEn: e.headlineEn,
      whatBrokeEn: e.explanationEn.split("\n\n")[1] ?? e.headlineEn,
      whyItMattersEn: (e.explanationEn.split("\n\n")[3] ?? "").replace(/^Why it matters: /, ""),
      actionEn: e.actionEn,
      ownerTeam: e.ownerTeam,
      evidenceJson: JSON.stringify(evidenceOf(e.evidenceJson)),
      runDate: run.asOf,
    };
    function evidenceOf(raw: string): Record<string, unknown> {
      try {
        const ev = JSON.parse(raw) as { facts?: { name: string; value: unknown }[] };
        const out: Record<string, unknown> = {};
        for (const f of ev.facts ?? []) out[f.name] = f.value;
        return out;
      } catch {
        return {};
      }
    }
    void txn;
  });

  const dqRows: DqRow[] = [];
  for (const t of transactions) {
    for (const dq of t.dq) {
      dqRows.push({ txnId: t.txnId, dqCode: dq, message: dqMessage(dq), rowNumber: t.source.rowNumber });
    }
  }

  const findingsCsv = renderFindingsCsv(findings);
  const validation = validateFindingsCsv(findingsCsv);
  const dqCsv = renderDataQualityCsv(dqRows);

  if (format === "findings") {
    if (!validation.ok) {
      throw new MzError("MZ-INT-500", "The findings file failed the export validator (FS-20); export is disabled.", { validation });
    }
    return new NextResponse(findingsCsv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="findings-${run.id}.csv"`,
        "digest": `sha-256=${(await import("node:crypto")).createHash("sha256").update(findingsCsv).digest("base64")}`,
        "mizan-run-id": run.id,
      },
    });
  }
  if (format === "data_quality") {
    return new NextResponse(dqCsv, {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="data_quality-${run.id}.csv"` },
    });
  }

  // bundle: validation report + both files base64 (single fetch for the demo)
  return json({
    runId: run.id,
    profileVersion: EXPORT_PROFILE.version,
    validation,
    findingsCsvB64: Buffer.from(findingsCsv).toString("base64"),
    dataQualityCsvB64: Buffer.from(dqCsv).toString("base64"),
    manifest: {
      runId: run.id, outputHash: run.outputHash, counts: JSON.parse(run.countsJson),
      packHash: run.packHash, calendarHash: run.calendarHash, asOf: run.asOf,
    },
  });
});

function dqMessage(dq: string): string {
  const M: Record<string, string> = {
    "DQ-001": "Required field missing",
    "DQ-002": "Unparseable date",
    "DQ-003": "Day-month order resolved by default",
    "DQ-004": "Employee not in the master data",
    "DQ-005": "Approver not in the master data",
    "DQ-006": "Unknown transaction type",
    "DQ-007": "Unknown document type",
    "DQ-008": "Duplicate transaction ID with different content",
    "DQ-009": "Currency other than AED",
    "DQ-010": "Management-chain cycle",
    "DQ-011": "Grade not on the ladder",
    "DQ-013": "Amount ambiguous or out of bounds",
    "DQ-016": "Status value not mapped",
    "DQ-017": "Instruction-like text in a free-text field",
    "DQ-018": "Field or line exceeds size limits",
  };
  return M[dq] ?? dq;
}
