import { describe, expect, it } from "vitest";
import { detectPatterns } from "@/lib/server/patterns";
import type { Approval, Employee, Transaction } from "@/lib/contracts";

function emp(id: string, overrides: Partial<Employee> = {}): Employee {
  return {
    employeeId: id, gradeRaw: "10", gradeOrdinal: 10, department: "Engineering", location: "Dubai",
    managerId: "MGR", hireDate: "2020-01-01", exitDate: null, statusRaw: "ACTIVE", status: "ACTIVE",
    roles: [], spells: [{ from: "2020-01-01", to: null }], attributes: {}, ...overrides,
  };
}

function ap(id: string, at: string): Approval {
  return { approverId: id, position: 0, approvedAt: at, precision: "timestamp", role: "", gradeRaw: "13", delegateFor: null };
}

let seq = 0;
function txn(overrides: Partial<Transaction> = {}): Transaction {
  seq++;
  return {
    rowId: `P-${seq}`, txnId: `P-${seq}`, type: "ALLOWANCE_CHANGE", typeRaw: "ALLOWANCE_CHANGE",
    employeeId: "E1", gradeRaw: "10", department: "Engineering", location: "Dubai",
    amountFils: 100_000, currency: "AED", amountSemantics: "delta",
    effectiveDate: "2026-03-02", submittedAt: "2026-03-02T09:00:00Z", submittedPrecision: "timestamp",
    requesterId: "E1", approvals: [ap("A1", "2026-03-02T10:00:00Z")], documents: [],
    reversalOf: null, freeText: {}, passthrough: {}, source: { datasetId: "p", rowNumber: seq, rowHash: `h${seq}` },
    dq: [], caveats: [], ...overrides,
  };
}

describe("pattern detectors P01–P10", () => {
  it("fires every detector on targeted fixtures and stays deterministic", () => {
    const employees = [
      emp("E1"), emp("E2"), emp("E3"), emp("E4"), emp("E5"), emp("E6"),
      emp("A1", { managerId: null }), emp("X", { managerId: null }), emp("MGR", { managerId: null }),
      emp("B1"), emp("CYC-A"), emp("CYC-B"), emp("OUT", { gradeRaw: "10" }), emp("EXIT", { exitDate: "2026-04-15" }),
      emp("C1", { department: "Cargo" }), emp("C2", { department: "Cargo" }), emp("C3", { department: "Cargo" }), emp("C4", { department: "Cargo" }), emp("C5", { department: "Cargo" }),
    ];
    const txs: Transaction[] = [
      // P01 threshold hugging
      txn({ employeeId: "E1", amountFils: 960_000 }),
      txn({ employeeId: "E1", amountFils: 970_000 }),
      // P02 split transactions
      txn({ employeeId: "E2", amountFils: 600_000, effectiveDate: "2026-03-01" }),
      txn({ employeeId: "E2", amountFils: 600_000, effectiveDate: "2026-03-05" }),
      // P03 rubber stamp
      txn({ employeeId: "E3", amountFils: 600_000, submittedAt: "2026-03-02T09:00:00Z", approvals: [ap("A1", "2026-03-02T09:00:30Z")] }),
      // P05 cycle
      txn({ employeeId: "E4", requesterId: "CYC-A", approvals: [ap("CYC-B", "2026-03-02T10:00:00Z")] }),
      txn({ employeeId: "E4", requesterId: "CYC-B", approvals: [ap("CYC-A", "2026-03-02T10:00:00Z")] }),
      // P06 concentration (X approves 100% of Cargo approvals outside the chain)
      ...Array.from({ length: 5 }, (_, i) => txn({ employeeId: `C${i + 1}`, department: "Cargo", approvals: [ap("X", "2026-03-02T10:00:00Z")] })),
      // P07 outlier (8 peers near 100k and one 9m)
      ...Array.from({ length: 8 }, () => txn({ employeeId: "E5", amountFils: 100_000 })),
      txn({ employeeId: "E6", amountFils: 9_000_000 }),
      // P08 velocity
      txn({ employeeId: "B1", type: "PAY_CHANGE", typeRaw: "PAY_CHANGE", effectiveDate: "2026-01-10" }),
      txn({ employeeId: "B1", type: "PAY_CHANGE", typeRaw: "PAY_CHANGE", effectiveDate: "2026-02-10" }),
      txn({ employeeId: "B1", type: "PAY_CHANGE", typeRaw: "PAY_CHANGE", effectiveDate: "2026-03-10" }),
      // P09 pre-exit uplift
      txn({ employeeId: "EXIT", type: "PAY_CHANGE", typeRaw: "PAY_CHANGE", amountFils: 500_000, effectiveDate: "2026-03-20" }),
      // P10 orphan
      txn({ employeeId: "UNKNOWN-PERSON", approvals: [] }),
    ];
    // P04 off-hours: one approver with six weekend approvals, 20 peers inside hours
    for (let i = 0; i < 6; i++) txs.push(txn({ employeeId: "E5", approvals: [ap("OUT", "2026-03-07T10:00:00Z")] }));
    for (let p = 0; p < 20; p++) {
      employees.push(emp(`PEER${p}`, { managerId: null }));
      for (let i = 0; i < 5; i++) txs.push(txn({ employeeId: "E5", approvals: [ap(`PEER${p}`, "2026-03-03T10:00:00Z")] }));
    }

    const alerts = detectPatterns(txs, employees);
    const ids = new Set(alerts.map((a) => a.patternId));
    expect([...ids].sort()).toEqual(["P01", "P02", "P03", "P04", "P05", "P06", "P07", "P08", "P09", "P10"]);

    const randomised = employees.map((e) => ({ ...e, attributes: { ...e.attributes, nationality: e.employeeId.endsWith("1") ? "UAE_NATIONAL" : "EXPAT" } }));
    const again = detectPatterns(txs, randomised);
    expect(again.map((a) => `${a.id}|${a.title}`)).toEqual(alerts.map((a) => `${a.id}|${a.title}`));
  });

  it("keeps protected attributes out of the feature allow-list", async () => {
    const { DETECTOR_FEATURES, assertNoProtectedFeatures } = await import("@/lib/server/patterns");
    expect(() => assertNoProtectedFeatures(DETECTOR_FEATURES)).not.toThrow();
    expect(() => assertNoProtectedFeatures(["employee.gender"])).toThrow(/MZ-RAI-500/);
  });
});
