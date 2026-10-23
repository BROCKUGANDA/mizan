/** Debug: evaluate the seeded pack and break down results per rule and outcome. */
import { generatePack } from "../src/lib/pack/generate";
import { RULE_SPECS } from "../src/lib/pack/rules";
import { parseCsv, normaliseTransactions, normaliseEmployees } from "../src/lib/normalize";
import { evaluate } from "../src/lib/engine/evaluate";
import { UAE_CALENDAR } from "../src/lib/domain/calendar";

const pack = generatePack(42, 10000);
const txParsed = parseCsv(pack.transactionsCsv, ",");
const transactions = normaliseTransactions(txParsed, "ds", { quarantined: [], dqByRow: {}, dateOrderDefaulted: false });
const empParsed = parseCsv(pack.employeesCsv, ",");
const { employees } = normaliseEmployees(empParsed, "ds");
const result = evaluate({ transactions, employees, pack: RULE_SPECS.filter((r) => r.status === "active"), config: { calendarVersion: UAE_CALENDAR.version, routingTableVersion: "routing-1.2.0" }, asOf: "2026-04-01", runId: "dbg" });

console.log("== per rule ==");
for (const [id, c] of Object.entries(result.perRule)) {
  console.log(`${id}: total=${c.total} pass=${c.pass} na=${c.notApplicable} ne=${c.notEvaluable} fail=${c.failed}`);
}
console.log("== NOT_EVALUABLE by dq ==");
const neByDq: Record<string, number> = {};
for (const r of result.results.filter((x) => x.outcome === "NOT_EVALUABLE")) {
  for (const d of r.dq) neByDq[d] = (neByDq[d] ?? 0) + 1;
}
console.log(neByDq);
console.log("== FAIL by rule ==");
for (const [id, c] of Object.entries(result.perRule)) console.log(`${id}: ${c.failed}`);
console.log("== dq tags on txns ==");
const dqTags: Record<string, number> = {};
for (const t of transactions) for (const d of t.dq) dqTags[d] = (dqTags[d] ?? 0) + 1;
console.log(dqTags);
