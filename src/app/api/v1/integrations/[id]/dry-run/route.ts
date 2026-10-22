import { withApiRoute, json } from "@/lib/server/api";
import { MzError } from "@/lib/domain/errors";
import { getIntegration } from "@/lib/integrations/registry";
import { getHrmsAdapter } from "@/lib/integrations/hrms-adapter";
import { getErpAdapter } from "@/lib/integrations/finance-adapter";
import { writebackAdapter } from "@/lib/integrations/writeback-adapter";
import { appendAudit } from "@/lib/audit/chain";
import { ANALYST_PAIR } from "@/lib/app-config";
import type { Role } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const DRY_RUN_ROLES: Role[] = ["compliance_lead", "admin", "auditor", "team_lead"];

/**
 * POST /api/v1/integrations/[id]/dry-run — exercises the stub and returns the
 * payload shape it would exchange with the real system. Read-only for source
 * adapters; for write-back it renders a sample proposal WITHOUT applying
 * anything (the stub's propose() is in-memory and idempotent).
 * Every dry-run is an audit event. Role-gated at the API.
 */
export const POST = withApiRoute<{ id: string }>(async ({ actor, params }) => {
  if (!DRY_RUN_ROLES.includes(actor.role)) {
    throw new MzError("MZ-AUTH-403", "Dry-runs are limited to compliance leads, team leads, auditors and admins.");
  }
  const entry = getIntegration(params.id);
  if (!entry) throw new MzError("MZ-VAL-422", `Unknown integration: ${params.id}`);

  const startedAt = Date.now();
  const result = await dryRun(params.id, actor.id);
  const elapsedMs = Date.now() - startedAt;

  await appendAudit({
    actor: actor.id,
    type: "integration.dry_run",
    entity: "integration",
    entityId: params.id,
    payload: { mode: entry.mode, elapsedMs, ok: result.ok, shapeKeys: result.shapeKeys.slice(0, 12) },
  });

  return json({ id: params.id, elapsedMs, ...result });
});

async function dryRun(id: string, actorId: string): Promise<{ ok: boolean; detail: string; recordCount?: number; shapeKeys: string[]; sample?: unknown }> {
  switch (id) {
    case "hrms": {
      const page = await getHrmsAdapter().listEmployees({ limit: 5 });
      return {
        ok: true,
        detail: "Stub page of the employee master; production pages OData with $skiptoken and records sourceHash in the run manifest.",
        recordCount: page.employees.length,
        shapeKeys: Object.keys(page.employees[0] ?? {}),
        sample: page.employees[0] ?? null,
      };
    }
    case "finance": {
      const page = await getErpAdapter().listTransactions({ limit: 5 });
      return {
        ok: true,
        detail: "Stub transaction page in the canonical ingest shape (integer fils, ISO dates). Production watermarks by business day.",
        recordCount: page.transactions.length,
        shapeKeys: Object.keys(page.transactions[0] ?? {}),
        sample: page.transactions[0] ?? null,
      };
    }
    case "writeback": {
      const proposal = await writebackAdapter.propose({
        exceptionKey: "DRY-RUN-SAMPLE",
        targetSystem: "finance-erp",
        targetEntity: "TXN-SAMPLE",
        changes: [{ field: "approverId", from: "EMP-100000", to: "EMP-100037", evidenceHash: "dry-run" }],
        createdBy: actorId,
        // never self-verified (segregation of duties; pair defined in app-config)
        verifiedBy: actorId === ANALYST_PAIR[1] ? ANALYST_PAIR[0] : ANALYST_PAIR[1],
        idempotencyKey: `dry-run-${actorId}`,
      });
      return {
        ok: true,
        detail: "Sample correction proposal rendered in memory — nothing is sent or applied. In production a human applies it in the target system and MIZAN verifies the echo.",
        recordCount: proposal.changes.length,
        shapeKeys: Object.keys(proposal),
        sample: { ...proposal, createdAt: "[rendered at dry-run time]" },
      };
    }
    default: {
      const fallback = getIntegration(id);
      const h = fallback ? await fallback.health() : { ok: false, detail: "unknown integration", mode: "unknown" };
      return { ok: h.ok, detail: h.detail, shapeKeys: ["mode", "detail"] };
    }
  }
}
