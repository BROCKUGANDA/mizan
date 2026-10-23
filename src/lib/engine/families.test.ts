import { describe, expect, it } from "vitest";
import { buildIndexes } from "./facts";
import { evaluateFamily } from "./families";
import { RULE_SPECS } from "../pack/rules";
import type { Approval, Employee, RuleSpec, Transaction } from "../contracts";

function employee(overrides: Partial<Employee> = {}): Employee {
  return {
    employeeId: "E00001",
    gradeRaw: "10",
    gradeOrdinal: 10,
    department: "Finance",
    location: "Dubai",
    managerId: "E00002",
    hireDate: "2020-01-01",
    exitDate: null,
    statusRaw: "ACTIVE",
    status: "ACTIVE",
    roles: [],
    spells: [{ from: "2020-01-01", to: null }],
    attributes: { nationality: "EXPAT", baseSalaryFils: "1200000" },
    ...overrides,
  };
}

function approval(overrides: Partial<Approval> = {}): Approval {
  return {
    approverId: "E00002",
    position: 0,
    approvedAt: "2026-03-02T10:00:00Z",
    precision: "timestamp",
    role: "LINE_MANAGER",
    gradeRaw: "14",
    delegateFor: null,
    ...overrides,
  };
}

function txn(overrides: Partial<Transaction> = {}): Transaction {
  return {
    rowId: "TXN-1",
    txnId: "TXN-1",
    type: "ALLOWANCE_CHANGE",
    typeRaw: "ALLOWANCE_CHANGE",
    employeeId: "E00001",
    gradeRaw: "10",
    department: "Finance",
    location: "Dubai",
    amountFils: 1_450_000,
    currency: "AED",
    amountSemantics: "delta",
    effectiveDate: "2026-03-05",
    submittedAt: "2026-03-03T09:15:00+04:00",
    submittedPrecision: "timestamp",
    requesterId: "E00001",
    approvals: [approval({ approverId: "E00002", gradeRaw: "11" })],
    documents: [],
    reversalOf: null,
    freeText: {},
    passthrough: {},
    source: { datasetId: "test", rowNumber: 2, rowHash: "hash" },
    dq: [],
    caveats: [],
    ...overrides,
  };
}

function rule(id: string, params?: Record<string, unknown>): RuleSpec {
  const spec = RULE_SPECS.find((r) => r.id === id)!;
  return params ? { ...spec, check: { ...spec.check, params: { ...spec.check.params, ...params } } } : spec;
}

function run(t: Transaction, r: RuleSpec, clauseId = "C1", employees: Employee[] = [employee()]) {
  return evaluateFamily(t, r, clauseId, buildIndexes([t], employees), "2026-04-01");
}

describe("approval_limit quantifier semantics", () => {
  it("passes when one approver meets the grade even if another grade is unknown", () => {
    const t = txn({
      approvals: [
        approval({ approverId: "E00002", gradeRaw: "13" }),
        approval({ approverId: "E00003", gradeRaw: "13A" }),
      ],
    });
    expect(run(t, rule("R04")).outcome).toBe("PASS");
  });

  it("is not evaluable when every known grade is below and one is unknown", () => {
    const t = txn({
      approvals: [
        approval({ approverId: "E00002", gradeRaw: "11" }),
        approval({ approverId: "E00003", gradeRaw: "13A" }),
      ],
    });
    expect(run(t, rule("R04")).outcome).toBe("NOT_EVALUABLE");
  });

  it("fails when every approver has a known grade below the requirement", () => {
    const t = txn({
      approvals: [
        approval({ approverId: "E00002", gradeRaw: "11" }),
        approval({ approverId: "E00003", gradeRaw: "12" }),
      ],
    });
    expect(run(t, rule("R04")).outcome).toBe("FAIL");
  });
});

describe("sequence semantics", () => {
  it("compares instants, not ISO strings, across offsets", () => {
    const t = txn({
      submittedAt: "2026-03-01T08:00:00+04:00",
      approvals: [approval({ approvedAt: "2026-03-01T05:00:00Z" })],
    });
    expect(run(t, rule("R02")).outcome).toBe("PASS");
  });

  it("distinguishes an absent approvals column from an empty approval list", () => {
    expect(run(txn({ approvals: null }), rule("R02")).outcome).toBe("NOT_EVALUABLE");
    expect(run(txn({ approvals: [] }), rule("R02")).outcome).toBe("FAIL");
  });
});

describe("eligibility semantics", () => {
  it("fails a suspended employee when only ACTIVE is allowed", () => {
    const emp = employee({ status: "SUSPENDED", statusRaw: "SUSPENDED" });
    expect(run(txn(), rule("R09"), "C1", [emp]).outcome).toBe("FAIL");
  });

  it("applies exempt transaction types", () => {
    const r = rule("R09", { exemptTypes: ["ALLOWANCE_CHANGE"] });
    expect(run(txn(), r).outcome).toBe("NOT_APPLICABLE");
  });
});

describe("timing_window business-day basis", () => {
  it("counts business days, not calendar days, across a weekend", () => {
    const r = rule("R08", { basis: "business", maxDays: 1 });
    const t = txn({ effectiveDate: "2026-03-06", submittedAt: "2026-03-09T09:00:00+04:00" });
    expect(run(t, r).outcome).toBe("PASS");
  });
});

describe("reference_integrity semantics", () => {
  it("reports DQ-005 when the approver is not in the master", () => {
    const t = txn({ approvals: [approval({ approverId: "E99999", gradeRaw: "13" })] });
    const res = run(t, rule("R12"));
    expect(res.outcome).toBe("FAIL");
    expect(res.dq).toContain("DQ-005");
  });

  it("is not evaluable when an approval has no timestamp", () => {
    const t = txn({ approvals: [approval({ approvedAt: null, precision: "none" })] });
    expect(run(t, rule("R12"), "C1", [employee(), employee({ employeeId: "E00002" })]).outcome).toBe("NOT_EVALUABLE");
  });
});

describe("value_bounds base derivation", () => {
  it("uses the master base salary, not a previous delta, as the base", () => {
    const prior = txn({
      rowId: "TXN-0", txnId: "TXN-0", amountFils: 6_000_000,
      effectiveDate: "2025-06-01", approvals: [],
    });
    const current = txn({ rowId: "TXN-2", txnId: "TXN-2", type: "PAY_CHANGE", typeRaw: "PAY_CHANGE", amountFils: 260_000, effectiveDate: "2026-03-15" });
    const employees = [employee()];
    const indexes = buildIndexes([prior, current], employees);
    const res = evaluateFamily(current, rule("R13"), "C1", indexes, "2026-04-01");
    expect(res.outcome).toBe("FAIL");
  });
});

describe("aggregate_limit metrics", () => {
  it("supports sum limits", () => {
    const r = rule("R10", { metric: "sum", max: 100_000 });
    const earlier = txn({ rowId: "TXN-0", txnId: "TXN-0", amountFils: 80_000, effectiveDate: "2026-03-01", approvals: [] });
    const current = txn({ rowId: "TXN-2", txnId: "TXN-2", amountFils: 80_000, effectiveDate: "2026-03-02" });
    const indexes = buildIndexes([earlier, current], [employee()]);
    expect(evaluateFamily(current, r, "C1", indexes, "2026-04-01").outcome).toBe("FAIL");
  });
});

describe("duplicate flagging", () => {
  it("flags both twins when flag=both", () => {
    const r = rule("R11", { flag: "both" });
    const earlier = txn({ rowId: "TXN-0", txnId: "TXN-0", effectiveDate: "2026-03-02", approvals: [] });
    const later = txn({ rowId: "TXN-2", txnId: "TXN-2", effectiveDate: "2026-03-04" });
    const employees = [employee()];
    const indexes = buildIndexes([earlier, later], employees);
    expect(evaluateFamily(earlier, r, "C1", indexes, "2026-04-01").outcome).toBe("FAIL");
    expect(evaluateFamily(later, r, "C1", indexes, "2026-04-01").outcome).toBe("FAIL");
  });
});

describe("approval_chain semantics", () => {
  it("is not evaluable when the employee has no line manager", () => {
    const emp = employee({ managerId: null });
    const t = txn({
      type: "TRANSFER", typeRaw: "TRANSFER",
      approvals: [approval({ approverId: "E00009", role: "RECEIVING_MANAGER" })],
      passthrough: { receiving_manager_id: "E00009" },
    });
    expect(run(t, rule("R03"), "C1", [emp]).outcome).toBe("NOT_EVALUABLE");
  });
});
