import { db } from "@/lib/db";
import { generatePack } from "@/lib/pack/generate";
import { RULE_SPECS, INTERPRETATIONS } from "@/lib/pack/rules";
import { EXPORT_PROFILE } from "@/lib/pack/finding-format";
import { parseCsv, normaliseEmployees, normaliseTransactions } from "@/lib/normalize";
import { sha256, sha256Json } from "@/lib/domain/canonical";

export async function seedTestDatabase(): Promise<void> {
  await db.slaEscalation.deleteMany({});
  await db.runFinding.deleteMany({});
  await db.observation.deleteMany({});
  await db.decision.deleteMany({});
  await db.comment.deleteMany({});
  await db.exception.deleteMany({});
  await db.run.deleteMany({});
  await db.outbox.deleteMany({});
  await db.inbox.deleteMany({});
  await db.idempotencyKey.deleteMany({});
  await db.dlqItem.deleteMany({});
  await db.patternAlert.deleteMany({});
  await db.ruleVersion.deleteMany({});
  await db.ruleDraft.deleteMany({});
  await db.ruleApproval.deleteMany({});
  await db.evidencePack.deleteMany({});
  await db.auditEvent.deleteMany({});
  await db.productEvent.deleteMany({});
  await db.txn.deleteMany({});
  await db.employee.deleteMany({});
  await db.dataset.deleteMany({});
  await db.rule.deleteMany({});
  await db.featureFlag.deleteMany({});
  await db.systemMode.deleteMany({});
  await db.actor.deleteMany({});
  await db.tenant.deleteMany({});

  const pack = generatePack(42, 10000);
  await db.tenant.create({ data: { id: "default", name: "Synthetic test tenant" } });
  const actors: [string, string, string, string | null][] = [
    ["analyst-a", "Analyst A", "analyst", "E00260"],
    ["analyst-b", "Analyst B", "analyst", "E00259"],
    ["team-lead", "Team Lead", "team_lead", "E00220"],
    ["ops-owner", "Operations Owner", "ops_owner", "E06789"],
    ["analyst-c", "Analyst C (party)", "analyst", "E06789"],
    ["compliance-lead", "Compliance Lead", "compliance_lead", null],
    ["policy-author", "Policy Author", "policy_author", null],
    ["policy-approver", "Policy Approver", "policy_approver", null],
    ["auditor", "Auditor", "auditor", null],
    ["admin", "Administrator", "admin", null],
    ["admin-2", "Administrator Two", "admin", null],
  ];
  for (const [id, name, role, employeeId] of actors) await db.actor.create({ data: { id, name, role, employeeId } });

  for (const spec of RULE_SPECS) {
    await db.rule.create({
      data: {
        id: spec.id, version: spec.version, family: spec.family, title: spec.title,
        verbatimText: spec.clauses.map((c) => c.text).join(" "), anchor: spec.source.anchor,
        textSha256: spec.source.sha256, status: spec.status, specJson: JSON.stringify(spec),
        interpretationJson: JSON.stringify(INTERPRETATIONS[spec.id] ?? {}), baseSeverity: spec.severity.base,
        modifiersJson: JSON.stringify(spec.severity.modifiers), routingProcess: spec.routing.process,
        actionTemplate: spec.action.template, effectiveFrom: spec.effective.from, author: "policy-owner",
        specHash: sha256Json(spec),
      },
    });
    await db.ruleVersion.create({ data: { id: `${spec.id}@${spec.version}`, ruleId: spec.id, version: spec.version, specJson: JSON.stringify(spec), specHash: sha256Json(spec), status: spec.status, effectiveFrom: spec.effective.from, author: "policy-owner" } });
  }

  const employees = normaliseEmployees(parseCsv(pack.employeesCsv, ","), "ds-employees");
  const transactions = normaliseTransactions(parseCsv(pack.transactionsCsv, ","), "ds-transactions", { quarantined: [], dqByRow: {}, dateOrderDefaulted: false }, { employeeIds: new Set(employees.employees.map((e) => e.employeeId)) });
  await db.dataset.create({ data: { id: "ds-transactions", kind: "transactions", sha256: sha256(pack.transactionsCsv), rows: transactions.length } });
  await db.dataset.create({ data: { id: "ds-employees", kind: "employees", sha256: sha256(pack.employeesCsv), rows: employees.employees.length } });
  await db.dataset.create({ data: { id: "ds-policy", kind: "policy", sha256: sha256(pack.policyRulesMd), rows: RULE_SPECS.length } });
  await db.dataset.create({ data: { id: "ds-format", kind: "finding_format", sha256: sha256(pack.findingFormatCsv), rows: EXPORT_PROFILE.goldenRows.length } });
  await db.employee.createMany({
    data: employees.employees.map((e) => ({
      employeeId: e.employeeId, gradeRaw: e.gradeRaw, gradeOrdinal: e.gradeOrdinal,
      department: e.department, location: e.location, managerId: e.managerId,
      hireDate: e.hireDate, exitDate: e.exitDate, statusRaw: e.statusRaw, status: e.status,
      rolesJson: JSON.stringify(e.roles), spellsJson: JSON.stringify(e.spells),
      attributesJson: JSON.stringify(e.attributes), datasetId: "ds-employees",
    })),
  });
  await db.txn.createMany({
    data: transactions.map((t) => ({
      rowId: t.rowId, txnId: t.txnId, type: t.type, typeRaw: t.typeRaw, employeeId: t.employeeId,
      gradeRaw: t.gradeRaw, department: t.department, location: t.location, amountFils: t.amountFils,
      currency: t.currency, amountSemantics: t.amountSemantics, effectiveDate: t.effectiveDate,
      submittedAt: t.submittedAt, submittedPrecision: t.submittedPrecision, requesterId: t.requesterId,
      approvalsJson: t.approvals === null ? null : JSON.stringify(t.approvals),
      documentsJson: t.documents === null ? null : JSON.stringify(t.documents),
      reversalOf: t.reversalOf, freeTextJson: JSON.stringify(t.freeText), passthroughJson: JSON.stringify(t.passthrough),
      dqJson: JSON.stringify(t.dq), caveatsJson: JSON.stringify(t.caveats),
      sourceJson: JSON.stringify(t.source), datasetId: "ds-transactions", rowNumber: t.source.rowNumber,
    })),
  });

  const { evaluate } = await import("@/lib/engine/evaluate");
  const { UAE_CALENDAR } = await import("@/lib/domain/calendar");
  const baselineResult = evaluate({
    transactions, employees: employees.employees, pack: RULE_SPECS.filter((r) => r.status === "active"),
    config: { calendarVersion: UAE_CALENDAR.version, routingTableVersion: "routing-1.2.0" }, asOf: "2026-04-01", runId: "test-baseline",
  });
  const fail: Record<string, number> = {};
  const notEvaluable: Record<string, number> = {};
  for (const [ruleId, c] of Object.entries(baselineResult.perRule)) {
    const applicable = c.total - c.notApplicable;
    fail[ruleId] = applicable ? c.failed / applicable : 0;
    notEvaluable[ruleId] = c.notEvaluable;
  }

  const flags: [string, string][] = [
    ["backtest.baselines", JSON.stringify({ fail, notEvaluable })],
    ["ai.mode", "none"], ["ai.narrative.enabled", "true"], ["ai.authoring.enabled", "true"],
    ["routing.enabled", "true"], ["notifications.email.enabled", "false"], ["notifications.webhook.enabled", "false"],
    ["runs.enabled", "true"], ["patterns.enabled", "true"], ["uploads.enabled", "true"],
    ["exports.findings.enabled", "true"], ["bulk.enabled", "true"],
    ["flood_guard.multiplier", "3"], ["flood_guard.min_pp", "2"],
  ];
  for (const [key, value] of flags) await db.featureFlag.create({ data: { key, value, updatedBy: "test", reason: "test seed" } });
  await db.systemMode.create({ data: { tenantId: "default", mode: "M0" } });
}
