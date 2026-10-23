import { beforeAll, describe, expect, it } from "vitest";
import { packDataset, evaluateDataset, findingKeys, type Dataset } from "@/lib/testkit/dataset";
import { applyFormatMutation, FORMAT_MUTATIONS, normaliseMutated } from "@/lib/testkit/format-mutations";
import { runMutations } from "@/lib/testkit/mutations";
import { runMetamorphic } from "@/lib/testkit/metamorphic";

let dataset: Dataset;
let baseline: Set<string>;

beforeAll(() => {
  dataset = packDataset(42);
  baseline = findingKeys(evaluateDataset(dataset.transactions, dataset.employees, "baseline"));
});

describe("format mutations F-1…F-9", () => {
  for (const id of FORMAT_MUTATIONS) {
    it(`${id} preserves the finding set`, () => {
      const text = applyFormatMutation(id, dataset);
      const transactions = normaliseMutated(text, new Set(dataset.employees.map((e) => e.employeeId)));
      const mutated = evaluateDataset(transactions, dataset.employees, `format-${id}`);
      const keys = findingKeys(mutated);
      const missing = [...baseline].filter((k) => !keys.has(k));
      const extra = [...keys].filter((k) => !baseline.has(k));
      expect({ missing, extra }).toEqual({ missing: [], extra: [] });
    });
  }
});

describe("metamorphic relations MR-1…MR-7", () => {
  it("all hold", () => {
    const results = runMetamorphic(dataset);
    const failed = results.filter((r) => !r.holds);
    expect(failed).toEqual([]);
  });
});

describe("labelled mutations", () => {
  it("meets 100% positive recall and 0 near-miss false positives", () => {
    const results = runMutations(dataset);
    const missed = results.filter((r) => !r.positiveDetected);
    const falsePositives = results.filter((r) => r.nearMissFalsePositive);
    expect(missed).toEqual([]);
    expect(falsePositives).toEqual([]);
    expect(new Set(results.map((r) => r.ruleId)).size).toBeGreaterThanOrEqual(13);
  });
});

describe("independent SQL oracle", () => {
  it("agrees with the engine on every failing pair", async () => {
    const { runOracle } = await import("@/lib/testkit/oracle");
    const { RULE_SPECS } = await import("@/lib/pack/rules");
    const result = await runOracle(dataset, RULE_SPECS);
    expect({ missing: result.missingFromOracle, extra: result.extraInOracle }).toEqual({ missing: [], extra: [] });
  });
});
