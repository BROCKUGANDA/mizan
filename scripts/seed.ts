/**
 * Seed: generate the synthetic pack (seed 42), normalise, and populate the DB.
 * Run: bun run seed
 */

import { generatePack } from "../src/lib/pack/generate";
import { RULE_SPECS, NON_CHECK_SENTENCES, coverageReport, INTERPRETATIONS } from "../src/lib/pack/rules";
import { EXPORT_PROFILE } from "../src/lib/pack/finding-format";
import { parseCsv, normaliseTransactions, normaliseEmployees } from "../src/lib/normalize";
import { sha256, sha256Json } from "../src/lib/domain/canonical";
import { db } from "../src/lib/db";
import { writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

async function main(): Promise<void> {
  console.log("◆ generating synthetic pack (seed 42)…");
  const pack = generatePack(42, 10000);

  // Write pack files (as the challenge provides them in data/pack/)
  mkdirSync("data/pack", { recursive: true });
  writeFileSync("data/pack/transactions.csv", pack.transactionsCsv);
  writeFileSync("data/pack/employees.csv", pack.employeesCsv);
  writeFileSync("data/pack/policy_rules.md", pack.policyRulesMd);
  writeFileSync("data/pack/finding_format.csv", pack.findingFormatCsv);
  writeFileSync("data/generated/README.txt", "Generated stand-ins live here (mizan gen-pack --seed 42 --out data/generated).\n");
  console.log("  pack files written to data/pack/ (sha256 recorded)");

  await db.tenant.upsert({ where: { id: "default" }, create: { id: "default", name: "Emirates Group HR (synthetic)" }, update: {} });

  // Actors (judge accounts)
  const actors: [string, string, string, string | null][] = [
    ["analyst-a", "Analyst A", "analyst", "E00260"],
    ["analyst-b", "Analyst B", "analyst", "E00259"],
    ["team-lead", "Team Lead", "team_lead", "E00220"],
    ["ops-owner", "Operations Owner", "ops_owner", "E06789"], // CoI demo: this employee benefits from WX-1006
    ["compliance-lead", "Compliance Lead", "compliance_lead", null],
    ["policy-author", "Policy Author", "policy_author", null],
    ["policy-approver", "Policy Approver", "policy_approver", null],
    ["auditor", "Auditor", "auditor", null],
    ["admin", "Administrator", "admin", null],
    ["admin-2", "Administrator Two", "admin", null],
  ];
  for (const [id, name, role, employeeId] of actors) {
    await db.actor.upsert({ where: { id }, create: { id, name, role, employeeId }, update: { name, role, employeeId } });
  }

  // Rules
  for (const spec of RULE_SPECS) {
    const data = {
      version: spec.version, family: spec.family, title: spec.title,
      verbatimText: spec.clauses.map((c) => c.text).join(" "), anchor: spec.source.anchor,
      textSha256: spec.source.sha256, status: spec.status, specJson: JSON.stringify(spec),
      interpretationJson: JSON.stringify(INTERPRETATIONS[spec.id] ?? {}), baseSeverity: spec.severity.base,
      modifiersJson: JSON.stringify(spec.severity.modifiers), routingProcess: spec.routing.process,
      actionTemplate: spec.action.template, effectiveFrom: spec.effective.from, author: "policy-owner",
      specHash: sha256Json(spec), backtestJson: null, sourceDraftId: null, activatedAt: null, shadowRunId: null,
    };
    await db.rule.upsert({ where: { id: spec.id }, create: { id: spec.id, ...data }, update: data });
    await db.ruleVersion.upsert({
      where: { ruleId_version: { ruleId: spec.id, version: spec.version } },
      create: { id: `${spec.id}@${spec.version}`, ruleId: spec.id, version: spec.version, specJson: JSON.stringify(spec), specHash: sha256Json(spec), status: spec.status, effectiveFrom: spec.effective.from, author: "policy-owner" },
      update: {},
    });
  }

  // Datasets + normalised rows (and every derived artefact, so the seed is a full reset)
  await db.slaEscalation.deleteMany({});
  await db.runFinding.deleteMany({});
  await db.observation.deleteMany({});
  await db.decision.deleteMany({});
  await db.comment.deleteMany({});
  await db.exception.deleteMany({});
  await db.evidencePack.deleteMany({});
  await db.auditEvent.deleteMany({});
  await db.dlqItem.deleteMany({});
  await db.productEvent.deleteMany({});
  await db.run.deleteMany({});
  await db.outbox.deleteMany({});
  await db.inbox.deleteMany({});
  await db.idempotencyKey.deleteMany({});
  await db.patternAlert.deleteMany({});
  await db.ruleVersion.deleteMany({});
  await db.ruleDraft.deleteMany({});
  await db.txn.deleteMany({});
  await db.employee.deleteMany({});
  await db.dataset.deleteMany({});

  const empParsed = parseCsv(pack.employeesCsv, ",");
  const { employees, issues: empIssues } = normaliseEmployees(empParsed, "ds-employees-42");
  const txParsed = parseCsv(pack.transactionsCsv, ",");
  const issues = { quarantined: [], dqByRow: {}, dateOrderDefaulted: false };
  const transactions = normaliseTransactions(txParsed, "ds-transactions-42", issues, { employeeIds: new Set(employees.map((e) => e.employeeId)), asOf: "2026-04-01" });

  await db.dataset.create({ data: { id: "ds-transactions-42", kind: "transactions", sha256: sha256(pack.transactionsCsv), rows: transactions.length, issuesJson: JSON.stringify({ quarantined: issues.quarantined, dateOrderDefaulted: issues.dateOrderDefaulted }) } });
  await db.dataset.create({ data: { id: "ds-employees-42", kind: "employees", sha256: sha256(pack.employeesCsv), rows: employees.length, issuesJson: JSON.stringify({ quarantined: empIssues.quarantined }) } });
  await db.dataset.create({ data: { id: "ds-policy-42", kind: "policy", sha256: sha256(pack.policyRulesMd), rows: RULE_SPECS.length + 3 } });
  await db.dataset.create({ data: { id: "ds-fmt-42", kind: "finding_format", sha256: sha256(pack.findingFormatCsv), rows: EXPORT_PROFILE.goldenRows.length } });

  console.log(`  normalised: ${transactions.length} transactions, ${employees.length} employees`);
  const dqCounts: Record<string, number> = {};
  for (const t of transactions) for (const d of t.dq) dqCounts[d] = (dqCounts[d] ?? 0) + 1;
  console.log("  DQ tags:", JSON.stringify(dqCounts));

  // Bulk insert
  const CHUNK = 400;
  for (let i = 0; i < employees.length; i += CHUNK) {
    await db.employee.createMany({
      data: employees.slice(i, i + CHUNK).map((e) => ({
        employeeId: e.employeeId, gradeRaw: e.gradeRaw, gradeOrdinal: e.gradeOrdinal,
        department: e.department, location: e.location, managerId: e.managerId,
        hireDate: e.hireDate, exitDate: e.exitDate, statusRaw: e.statusRaw, status: e.status,
        rolesJson: JSON.stringify(e.roles), spellsJson: JSON.stringify(e.spells),
        attributesJson: JSON.stringify(e.attributes), datasetId: "ds-employees-42",
      })),
    });
  }
  for (let i = 0; i < transactions.length; i += CHUNK) {
    await db.txn.createMany({
      data: transactions.slice(i, i + CHUNK).map((t) => ({
        rowId: t.rowId, txnId: t.txnId, type: t.type, typeRaw: t.typeRaw, employeeId: t.employeeId,
        gradeRaw: t.gradeRaw, department: t.department, location: t.location, amountFils: t.amountFils,
        currency: t.currency, amountSemantics: t.amountSemantics, effectiveDate: t.effectiveDate,
        submittedAt: t.submittedAt, submittedPrecision: t.submittedPrecision, requesterId: t.requesterId,
        approvalsJson: t.approvals === null ? null : JSON.stringify(t.approvals),
        documentsJson: t.documents === null ? null : JSON.stringify(t.documents),
        reversalOf: t.reversalOf, freeTextJson: JSON.stringify(t.freeText), passthroughJson: JSON.stringify(t.passthrough),
        dqJson: JSON.stringify(t.dq), caveatsJson: JSON.stringify(t.caveats),
        sourceJson: JSON.stringify(t.source), datasetId: "ds-transactions-42", rowNumber: t.source.rowNumber,
      })),
    });
  }

  // Feature flags (defaults; every change needs a reason — §5)
  const flags: [string, string, string][] = [
    ["ai.mode", "none", "default: engine decides, model explains; judge profile runs offline"],
    ["ai.narrative.enabled", "true", "narrative polish on when the gateway is on"],
    ["routing.enabled", "true", "global routing on"],
    ["notifications.email.enabled", "false", "email channel off in the sandbox (outbox viewer instead)"],
    ["notifications.webhook.enabled", "false", "webhook channel off in the sandbox (outbox viewer instead)"],
    ["runs.enabled", "true", "runs on"],
    ["patterns.enabled", "true", "pattern detection on"],
    ["uploads.enabled", "true", "uploads on"],
    ["exports.findings.enabled", "true", "findings export on"],
    ["bulk.enabled", "true", "bulk decisions on"],
    ["flood_guard.multiplier", "3", "flood guard multiplier within bounds 2–5"],
    ["flood_guard.min_pp", "2", "flood guard minimum percentage points within bounds 1–5"],
  ];
  for (const [key, value, reason] of flags) {
    await db.featureFlag.upsert({ where: { key }, create: { key, value, updatedBy: "system:seed", reason }, update: { value, reason } });
  }

  await db.systemMode.upsert({ where: { tenantId: "default" }, create: { tenantId: "default", mode: "M0", reason: null, operator: null }, update: { mode: "M0", reason: null, operator: null } });

  // Compute training baselines directly from the engine (backtest equivalent)
  console.log("◆ computing backtest baselines…");
  const { evaluate } = await import("../src/lib/engine/evaluate");
  const { UAE_CALENDAR } = await import("../src/lib/domain/calendar");
  const result = evaluate({
    transactions, employees, pack: RULE_SPECS.filter((r) => r.status === "active"),
    config: { calendarVersion: UAE_CALENDAR.version, routingTableVersion: "routing-1.2.0" },
    asOf: "2026-04-01", runId: "baseline-seed",
  });
  const failBase: Record<string, number> = {};
  const neBase: Record<string, number> = {};
  for (const [ruleId, c] of Object.entries(result.perRule)) {
    const applicable = c.total - c.notApplicable;
    failBase[ruleId] = applicable ? c.failed / applicable : 0;
    neBase[ruleId] = c.notEvaluable;
  }
  const baselinePayload = JSON.stringify({ fail: failBase, notEvaluable: neBase });
  await db.featureFlag.upsert({
    where: { key: "backtest.baselines" },
    create: { key: "backtest.baselines", value: baselinePayload, updatedBy: "system:backtest", reason: "training baselines from seed pack" },
    update: { value: baselinePayload, updatedBy: "system:backtest", reason: "training baselines from seed pack" },
  });
  console.log("  census:", JSON.stringify(result.counts));
  console.log("  outputHash:", result.outputHash.slice(0, 16) + "…");
  const fails = result.results.filter((r) => r.outcome === "FAIL");
  console.log(`  findings: ${fails.length}`);
  const wx = fails.filter((r) => ["WX-1001", "WX-1002", "WX-1003", "WX-1004", "WX-1006"].includes(r.txnId));
  console.log("  worked-example findings:", wx.map((r) => `${r.txnId}:${r.ruleId}:${r.clauseId}`).join(" ") || "NONE");

  await db.productEvent.create({ data: { id: randomUUID(), event: "seed.completed", actorHash: sha256("system"), role: "system", propsJson: JSON.stringify({ transactions: transactions.length, employees: employees.length, rules: RULE_SPECS.length, coverage: coverageReport().total }) } });
  console.log("✔ seed complete");
  console.log(`  coverage report: ${coverageReport().total} sentences classified (${RULE_SPECS.length} compiled, ${NON_CHECK_SENTENCES.definitions.length} definition, ${NON_CHECK_SENTENCES.attestations.length} attestation, ${NON_CHECK_SENTENCES.scopeNotes.length} scope note)`);
  console.log("  uploaded finding_format profile:", EXPORT_PROFILE.version);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
