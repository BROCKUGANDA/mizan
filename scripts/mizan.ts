/**
 * `mizan` CLI (§36) — offline commands that work without the server.
 *   mizan verify                 all backtesting gates on data/pack
 *   mizan verify-export <file>    structural + golden validation of a findings CSV
 *   mizan bench <golden|mutate|format|score|oracle|metamorphic|determinism|shift|perf|report>
 *   mizan hidden-test <file>      T−72h protocol: hash, shift report, run, export, manifest
 *   mizan gen-pack [--seed N]     regenerate a seeded pack
 *   mizan audit-verify            verify the hash chain from the DB
 *   mizan mode get|set            read or force a health mode
 *   mizan dlq list|show|replay    dead-letter tooling
 *   mizan scan-pii <file>         PII scan (FS-24)
 * Exit codes: 0 ok · 1 failed gate · 2 invalid input · 3 integrity failure.
 */

import { generatePack } from "../src/lib/pack/generate";
import { RULE_SPECS, PACK_VERSION, ENGINE_VERSION } from "../src/lib/pack/rules";
import { EXPORT_PROFILE as FORMAT, renderFindingFormatCsv } from "../src/lib/pack/finding-format";
import { parseCsv, normaliseEmployees, normaliseTransactions } from "../src/lib/normalize";
import { evaluate, assertCensus } from "../src/lib/engine/evaluate";
import { UAE_CALENDAR } from "../src/lib/domain/calendar";
import { validateFindingsCsv, renderFindingsCsv, renderDataQualityCsv, dqMessage, parseCsvRows } from "../src/lib/server/export";
import { buildFindings, runBacktestSuite, renderReport } from "../src/lib/testkit/harness";
import { packDataset, evaluateDataset, findingKeys, type Dataset } from "../src/lib/testkit/dataset";
import { runMutations } from "../src/lib/testkit/mutations";
import { applyFormatMutation, FORMAT_MUTATIONS, normaliseMutated } from "../src/lib/testkit/format-mutations";
import { runOracle } from "../src/lib/testkit/oracle";
import { runMetamorphic } from "../src/lib/testkit/metamorphic";
import { buildShiftReport, renderShiftMarkdown } from "../src/lib/testkit/shift";
import { verifyChain } from "../src/lib/audit/chain";
import { buildEvidencePack, verifyEvidencePack, type EvidencePack } from "../src/lib/server/evidence";
import { getMode, setMode, type HealthMode } from "../src/lib/server/mode";
import { listDlq, replayAllDlq, replayDlq } from "../src/lib/server/outbox";
import { sha256 } from "../src/lib/domain/canonical";
import { addDays } from "../src/lib/domain/dates";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

function die(code: number, message: string): never {
  console.error(`mizan: ${message}`);
  process.exit(code);
}

function loadPack(dir = "data/pack"): Dataset {
  const txPath = `${dir}/transactions.csv`;
  const empPath = `${dir}/employees.csv`;
  if (existsSync(txPath) && existsSync(empPath)) {
    return packDataset(42, { transactionsCsv: readFileSync(txPath, "utf8"), employeesCsv: readFileSync(empPath, "utf8") });
  }
  const pack = generatePack(42, 10000);
  return packDataset(42, { transactionsCsv: pack.transactionsCsv, employeesCsv: pack.employeesCsv });
}

function datasetFromCsv(transactionsCsv: string, employeesCsv: string): Dataset {
  const parsedEmployees = parseCsv(employeesCsv, ",");
  const { employees } = normaliseEmployees(parsedEmployees, "cli-employees");
  const parsedTransactions = parseCsv(transactionsCsv, ",");
  const transactions = normaliseTransactions(parsedTransactions, "cli-transactions", { quarantined: [], dqByRow: {}, dateOrderDefaulted: false }, { employeeIds: new Set(employees.map((e) => e.employeeId)), asOf: "2026-04-01" });
  return { transactionsCsv, employeesCsv, parsedTransactions, parsedEmployees, transactions, employees };
}

async function cmdVerify(): Promise<number> {
  console.log("◆ mizan verify — training gates");
  const dataset = loadPack();
  const report = await runBacktestSuite(dataset);
  console.log(renderReport(report));
  if (!report.ok) {
    for (const [gate, ok] of Object.entries(report.gates)) if (!ok) console.error(`  ✗ ${gate}`);
    if (!report.golden.ok) console.error(JSON.stringify(report.golden, null, 2));
    if (!report.oracle.agreement) console.error(JSON.stringify(report.oracle, null, 2));
    return 1;
  }
  console.log("✔ all gates passed");
  return 0;
}

async function cmdVerifyExport(file: string): Promise<number> {
  if (!existsSync(file)) die(2, `file not found: ${file}`);
  const csv = readFileSync(file, "utf8");
  const v = validateFindingsCsv(csv, { requireGolden: true });
  console.log(`profile ${v.profileVersion} · ok=${v.ok}`);
  for (const w of v.workedExamples) console.log(`  ${w.transactionId}: ${w.ok ? "ok" : `MISMATCH ${JSON.stringify(w.mismatches)}`}`);
  for (const e of v.structuralErrors) console.log(`  structural: ${e}`);
  return v.ok ? 0 : 1;
}

async function cmdBench(args: string[]): Promise<number> {
  const sub = args[0] ?? "report";
  const dataset = loadPack();
  switch (sub) {
    case "golden": {
      const built = buildFindings(dataset.transactions, dataset.employees, RULE_SPECS.filter((r) => r.status === "active"));
      const v = validateFindingsCsv(renderFindingsCsv(built.rows), { requireGolden: true });
      console.log(`golden ${v.workedExamples.filter((w) => w.ok).length}/${v.workedExamples.length} exact · ok=${v.ok}`);
      for (const w of v.workedExamples) console.log(`  ${w.transactionId}: ${w.ok ? "ok" : JSON.stringify(w.mismatches)}`);
      for (const e of v.structuralErrors) console.log(`  structural: ${e}`);
      return v.ok ? 0 : 1;
    }
    case "mutate": {
      const results = runMutations(dataset);
      const missed = results.filter((r) => !r.positiveDetected);
      const fps = results.filter((r) => r.nearMissFalsePositive);
      for (const r of results) console.log(`  ${r.operator} ${r.ruleId}: positive ${r.positiveDetected ? "caught" : "MISSED"} · near-miss ${r.nearMissFalsePositive ? "FALSE POSITIVE" : "clean"} (${r.detail})`);
      console.log(`recall ${results.length - missed.length}/${results.length} · near-miss FP ${fps.length}`);
      return missed.length === 0 && fps.length === 0 ? 0 : 1;
    }
    case "format": {
      const baseline = findingKeys(evaluateDataset(dataset.transactions, dataset.employees, "cli-base"));
      let ok = true;
      for (const id of FORMAT_MUTATIONS) {
        const t = normaliseMutated(applyFormatMutation(id, dataset), new Set(dataset.employees.map((e) => e.employeeId)));
        const keys = findingKeys(evaluateDataset(t, dataset.employees, `cli-format-${id}`));
        const same = baseline.size === keys.size && [...baseline].every((k) => keys.has(k));
        if (!same) ok = false;
        console.log(`  ${id}: ${same ? "identical findings" : "DIFFERENT"}`);
      }
      return ok ? 0 : 1;
    }
    case "score": {
      const labelsPath = argValue(args, "--labels");
      const findingsPath = argValue(args, "--findings");
      if (!labelsPath || !findingsPath || !existsSync(labelsPath) || !existsSync(findingsPath)) die(2, "usage: bench score --labels labels.jsonl --findings findings.csv");
      const labels = readFileSync(labelsPath, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as { txnId: string; ruleId: string; clauseId?: string; expected: "FAIL" | "PASS" });
      const rows = parseCsvRows(readFileSync(findingsPath, "utf8"));
      const found = new Set(rows.slice(1).map((r) => `${r[1]}|${r[2]}|${r[4]}`));
      let tp = 0; let fp = 0; let fn = 0;
      for (const l of labels) {
        const key = `${l.txnId}|${l.ruleId}|${l.clauseId ?? "C1"}`;
        if (l.expected === "FAIL" && found.has(key)) tp++;
        else if (l.expected === "FAIL") fn++;
        else if (found.has(key)) fp++;
      }
      const precision = tp + fp ? tp / (tp + fp) : 1;
      const recall = tp + fn ? tp / (tp + fn) : 1;
      console.log(`TP ${tp} · FP ${fp} · FN ${fn} · precision ${(precision * 100).toFixed(1)}% · recall ${(recall * 100).toFixed(1)}%`);
      return fn === 0 && fp === 0 ? 0 : 1;
    }
    case "oracle": {
      const result = await runOracle(dataset, RULE_SPECS.filter((r) => r.status === "active"));
      console.log(`engine fails ${result.engineFails} · oracle fails ${result.oracleFails} · agreement ${result.agreement}`);
      for (const k of result.missingFromOracle) console.log(`  missing from oracle: ${k}`);
      for (const k of result.extraInOracle) console.log(`  extra in oracle: ${k}`);
      return result.agreement ? 0 : 1;
    }
    case "metamorphic": {
      const results = runMetamorphic(dataset);
      for (const r of results) console.log(`  ${r.id}: ${r.holds ? "holds" : "FAILED"} (${r.detail})`);
      return results.every((r) => r.holds) ? 0 : 1;
    }
    case "determinism": {
      const runs = Number(argValue(args, "--runs") ?? "2");
      const hashes = new Set<string>();
      for (let i = 0; i < Math.max(2, runs); i++) hashes.add(evaluateDataset(dataset.transactions, dataset.employees, `det-${i}`).outputHash);
      console.log(`${hashes.size === 1 ? "identical" : "DIFFERENT"} across ${Math.max(2, runs)} runs · ${[...hashes][0]?.slice(0, 16)}…`);
      return hashes.size === 1 ? 0 : 1;
    }
    case "shift": {
      const trainPath = argValue(args, "--train") ?? "data/pack/transactions.csv";
      const testPath = argValue(args, "--test");
      if (!testPath) die(2, "usage: bench shift --train <csv> --test <csv> [--employees <csv>]");
      const empPath = argValue(args, "--employees") ?? "data/pack/employees.csv";
      const employeesCsv = existsSync(empPath) ? readFileSync(empPath, "utf8") : generatePack(42, 10000).employeesCsv;
      const train = datasetFromCsv(readFileSync(trainPath, "utf8"), employeesCsv);
      const test = datasetFromCsv(readFileSync(testPath, "utf8"), employeesCsv);
      const report = buildShiftReport(train, test);
      console.log(renderShiftMarkdown(report));
      return 0;
    }
    case "perf": {
      const scales = (argValue(args, "--scale") ?? "10k").split(",");
      let ok = true;
      for (const s of scales) {
        const scale = s === "1m" ? 1000000 : s === "100k" ? 100000 : 10000;
        const pack = generatePack(42, scale);
        const ds = packDataset(42, { transactionsCsv: pack.transactionsCsv, employeesCsv: pack.employeesCsv });
        const started = Date.now();
        const out = evaluateDataset(ds.transactions, ds.employees, `perf-${s}`);
        const ms = Date.now() - started;
        console.log(`  ${ds.transactions.length} transactions × ${out.counts.clauses} clauses = ${out.counts.checks} checks in ${ms} ms`);
        if (ms > 10_000 && ds.transactions.length <= 10_000) ok = false;
      }
      return ok ? 0 : 1;
    }
    case "report": {
      const report = await runBacktestSuite(dataset);
      const dir = `reports/${new Date().toISOString().slice(0, 10)}`;
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${dir}/backtest.json`, JSON.stringify(report, null, 2));
      writeFileSync(`${dir}/backtest.md`, renderReport(report));
      console.log(`wrote ${dir}/backtest.md and backtest.json`);
      return report.ok ? 0 : 1;
    }
    default:
      die(2, "usage: mizan bench <golden|mutate|format|score|oracle|metamorphic|determinism|shift|perf|report>");
  }
}

async function cmdHiddenTest(file: string): Promise<number> {
  if (!existsSync(file)) die(2, `file not found: ${file}`);
  const csv = readFileSync(file, "utf8");
  const sha = sha256(csv);
  const empPath = argValue(process.argv.slice(3), "--employees") ?? "data/pack/employees.csv";
  if (!existsSync(empPath)) die(2, `employees file not found: ${empPath}`);
  const employeesCsv = readFileSync(empPath, "utf8");
  const train = loadPack();
  const test = datasetFromCsv(csv, employeesCsv);
  const outDir = `output/hidden-${sha.slice(0, 12)}`;
  mkdirSync(outDir, { recursive: true });
  const shift = buildShiftReport(train, test);
  writeFileSync(`${outDir}/shift_report.md`, renderShiftMarkdown(shift));

  // as-of follows the data, exactly like a server run: the day after the latest
  // effective date in the supplied file (FS-21 — as-of is an input, never a clock).
  const asOf = argValue(process.argv.slice(3), "--as-of")
    ?? addDays(test.transactions.reduce((acc, t) => (t.effectiveDate && t.effectiveDate > acc ? t.effectiveDate : acc), "2025-01-01"), 1);
  const cfg = { calendarVersion: UAE_CALENDAR.version, routingTableVersion: "routing-1.2.0" };
  const pack = RULE_SPECS.filter((r) => r.status === "active");
  const first = evaluate({ transactions: test.transactions, employees: test.employees, pack, config: cfg, asOf, runId: "hidden-1" });
  const second = evaluate({ transactions: test.transactions, employees: test.employees, pack, config: cfg, asOf, runId: "hidden-2" });
  const censusErrors = assertCensus(first.counts);
  const built = buildFindings(test.transactions, test.employees, pack);
  const findingsCsv = renderFindingsCsv(built.rows);
  const validation = validateFindingsCsv(findingsCsv, { requireGolden: false });
  // Same merge the server run does: normalisation tags plus any DQ code the
  // engine raised while evaluating (e.g. grade off the ladder, date outside the calendar).
  const dqCodesByRow = new Map<string, Set<string>>();
  for (const t of test.transactions) {
    if (!t.dq.length) continue;
    dqCodesByRow.set(t.rowId, new Set(t.dq));
  }
  for (const r of first.results) {
    if (!r.dq.length) continue;
    const set = dqCodesByRow.get(r.rowId) ?? new Set<string>();
    for (const dq of r.dq) set.add(dq);
    dqCodesByRow.set(r.rowId, set);
  }
  const byRowId = new Map(test.transactions.map((t) => [t.rowId, t]));
  const dqRows = [...dqCodesByRow.entries()].flatMap(([rowId, codes]) => {
    const t = byRowId.get(rowId);
    if (!t) return [];
    return [...codes].map((code) => ({ txnId: t.txnId, dqCode: code, message: dqMessage(code), rowNumber: t.source.rowNumber }));
  });
  const dqCsv = renderDataQualityCsv(dqRows);
  writeFileSync(`${outDir}/findings.csv`, findingsCsv);
  writeFileSync(`${outDir}/data_quality.csv`, dqCsv);
  const manifest = {
    input: { file, sha256: sha, rows: test.transactions.length },
    engineVersion: ENGINE_VERSION,
    packVersion: PACK_VERSION,
    packHash: sha256(JSON.stringify(RULE_SPECS.map((r) => ({ id: r.id, version: r.version, specHash: r.source.sha256 })))),
    calendarHash: sha256(JSON.stringify(UAE_CALENDAR)),
    asOf,
    counts: first.counts,
    outputHash: first.outputHash,
    findingsSha256: validation.findingsSha256,
    dataQualityRows: dqRows.length,
    dataQualitySha256: sha256(dqCsv),
    validation: { ok: validation.ok, structuralErrors: validation.structuralErrors, goldenApplicable: false },
    determinism: { runs: 2, identical: first.outputHash === second.outputHash },
    census: { ok: censusErrors.length === 0, errors: censusErrors },
  };
  writeFileSync(`${outDir}/run-manifest.json`, JSON.stringify(manifest, null, 2));
  console.log(`hidden test ${file}`);
  console.log(`  sha256 ${sha}`);
  console.log(`  rows ${test.transactions.length} · checks ${first.counts.checks} · failed ${first.counts.failed} · NE ${first.counts.notEvaluable}`);
  console.log(`  findings ${built.rows.length} · data-quality rows ${dqRows.length} · structural ${validation.ok ? "valid" : "INVALID"} · determinism ${manifest.determinism.identical ? "2/2" : "FAILED"}`);
  console.log(`  wrote ${outDir}/findings.csv, data_quality.csv, run-manifest.json, shift_report.md`);
  return validation.ok && censusErrors.length === 0 && manifest.determinism.identical ? 0 : 1;
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function cmdGenPack(args: string[]): Promise<number> {
  const seed = Number(argValue(args, "--seed") ?? "42");
  const out = argValue(args, "--out") ?? "data/generated";
  const pack = generatePack(seed, 10000);
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/transactions.csv`, pack.transactionsCsv);
  writeFileSync(`${out}/employees.csv`, pack.employeesCsv);
  writeFileSync(`${out}/policy_rules.md`, pack.policyRulesMd);
  writeFileSync(`${out}/finding_format.csv`, pack.findingFormatCsv);
  console.log(`✔ pack written to ${out} (seed ${seed})`);
  console.log(`  sha256 transactions: ${pack.hashes.transactionsCsv.slice(0, 16)}…`);
  return 0;
}

async function cmdAuditVerify(args: string[] = []): Promise<number> {
  if (args[0] === "verify-pack") {
    const file = args[1];
    if (!file || !existsSync(file)) die(2, "usage: mizan audit verify-pack <pack.json>");
    const pack = JSON.parse(readFileSync(file, "utf8")) as EvidencePack;
    const result = verifyEvidencePack(pack);
    console.log(`evidence pack ${result.ok ? "valid" : "INVALID"} · signature ${pack.manifest.signature.slice(0, 16)}… · chain ${pack.manifest.chainVerified ? "verified" : "FAILED"}`);
    for (const e of result.errors) console.log(`  ${e}`);
    return result.ok && pack.manifest.chainVerified ? 0 : 3;
  }
  if (args[0] === "pack") {
    const scope = args[1];
    if (!scope) die(2, "usage: mizan audit pack <exception:key|run:id> [--out file.json]");
    const pack = await buildEvidencePack(scope);
    const out = argValue(args, "--out") ?? `output/evidence-${pack.manifest.id}.json`;
    mkdirSync("output", { recursive: true });
    writeFileSync(out, JSON.stringify(pack, null, 2));
    console.log(`✔ evidence pack written to ${out} · signature ${pack.manifest.signature.slice(0, 16)}…`);
    return 0;
  }
  void args;
  const v = await verifyChain();
  console.log(`chain ok=${v.ok} checked=${v.checked} firstBadSeq=${v.firstBadSeq ?? "-"} head=${v.headHash?.slice(0, 16) ?? "-"}`);
  if (!v.ok) console.log("→ safe halt (M5) is entered by the running system; runbook RB-03");
  return v.ok ? 0 : 3;
}

async function cmdMode(args: string[]): Promise<number> {
  if (args[0] === "set") {
    const mode = args[1] as HealthMode;
    const reason = argValue(args, "--reason") ?? "";
    if (!["M0", "M1", "M2", "M3", "M4", "M5"].includes(mode)) die(2, `invalid mode ${mode}`);
    if (reason.length < 5) die(2, "--reason of at least 5 characters is required");
    await setMode(mode, reason, "cli");
    console.log(`mode set to ${mode}`);
    return 0;
  }
  const m = await getMode();
  console.log(`${m.mode} since ${m.since}${m.reason ? ` — ${m.reason}` : ""}`);
  return 0;
}

async function cmdDlq(args: string[]): Promise<number> {
  const sub = args[0] ?? "list";
  if (sub === "list") {
    const items = await listDlq();
    if (!items.length) console.log("DLQ is empty");
    for (const i of items) console.log(`${i.id} ${i.queue} attempts=${i.attempts} ${i.error.slice(0, 60)}`);
    return 0;
  }
  if (sub === "show") {
    const item = await db.dlqItem.findUnique({ where: { id: args[1] ?? "" } });
    if (!item) die(2, "not found");
    console.log(JSON.stringify(JSON.parse(item.payloadJson), null, 2));
    return 0;
  }
  if (sub === "replay") {
    if (args.includes("--all")) {
      const result = await replayAllDlq(argValue(args, "--since"));
      console.log(`✔ replayed ${result.replayed} message(s); the outbox relay delivers them again`);
      return 0;
    }
    const id = args[1];
    if (!id) die(2, "usage: mizan dlq replay <id> | --all [--since ISO]");
    const result = await replayDlq(id);
    console.log(`✔ replayed ${id} → outbox ${result.outboxId}`);
    return 0;
  }
  die(2, "usage: mizan dlq list | show <id> | replay <id> | replay --all [--since ISO]");
}

async function cmdScanPii(file: string): Promise<number> {
  if (!existsSync(file)) die(2, `file not found: ${file}`);
  const text = readFileSync(file, "utf8");
  const patterns: [string, RegExp][] = [
    ["Emirates ID", /784-\d{4}-\d{7}-\d/g],
    ["passport", /\b[A-Z]{2}\d{7}\b/g],
    ["IBAN", /\bAE\d{2}\d{19}\b/g],
    ["phone", /(\+971|00971)?5\d{8}/g],
    ["email", /[\w.+-]+@[\w-]+\.[\w.]+/g],
  ];
  let hits = 0;
  for (const [name, re] of patterns) {
    const m = text.match(re);
    if (m?.length) { console.log(`  ${name}: ${m.length} match(es)`); hits += m.length; }
  }
  console.log(hits === 0 ? "✔ PII scan clean" : `✗ PII detected (${hits}) — upload blocked in judge mode (FS-24)`);
  return hits === 0 ? 0 : 1;
}

async function main(): Promise<number> {
  const cmd = process.argv[2];
  const args = process.argv.slice(3);
  switch (cmd) {
    case "verify": return cmdVerify();
    case "verify-export": return cmdVerifyExport(args[0] ?? "data/pack/finding_format.csv");
    case "bench": return cmdBench(args);
    case "hidden-test": return cmdHiddenTest(args[0] ?? "");
    case "gen-pack": return cmdGenPack(args);
    case "audit-verify": return cmdAuditVerify(args);
    case "audit": return cmdAuditVerify(args);
    case "mode": return cmdMode(args);
    case "dlq": return cmdDlq(args);
    case "scan-pii": return cmdScanPii(args[0] ?? "");
    default:
      console.log(`mizan — offline CLI
  verify                       run every backtesting gate on data/pack
  verify-export <file.csv>     validate a findings file (structural + 5 worked examples)
  bench golden                 reproduce the 5 worked examples
  bench mutate                 labelled mutation recall + near-miss twins
  bench format                 F-1…F-9 format mutations
  bench score --labels <jsonl> --findings <csv>
  bench oracle                 independent SQL oracle vs engine
  bench metamorphic            MR-1…MR-7
  bench determinism [--runs N]
  bench shift --train <csv> --test <csv> [--employees <csv>]
  bench perf [--scale 10k,100k,1m]
  bench report                 write reports/<date>/backtest.{md,json}
  hidden-test <file>           T−72h protocol with manifest
  gen-pack [--seed N] [--out DIR]
  audit-verify                 verify the audit hash chain
  audit verify-pack <file>     verify an evidence pack manifest and hashes
  audit pack <scope>           build an evidence pack offline
  mode get | set <M#> --reason "…"
  dlq list | show <id> | replay <id> | replay --all [--since ISO]
  scan-pii <file>              PII scan (FS-24)
Exit codes: 0 ok · 1 failed gate · 2 invalid input · 3 integrity failure`);
      return 0;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void db.$disconnect();
    void FORMAT;
    void renderFindingFormatCsv;
  });
