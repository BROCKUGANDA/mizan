import { describe, expect, it } from "vitest";
import { parseCellDate, parseTimestamp } from "../domain/dates";
import { parseAmount } from "../domain/money";
import { normaliseTransactions, parseCsv, type IngestIssues } from "./index";

function issues(): IngestIssues {
  return { quarantined: [], dqByRow: {}, dateOrderDefaulted: false };
}

function csv(rows: string[], header = "txn_id,type,employee_id,effective_date"): string {
  return [header, ...rows].join("\r\n") + "\r\n";
}

describe("dates", () => {
  it("parses Arabic month names", () => {
    expect(parseCellDate("14 مارس 2026", "day_month")).toBe("2026-03-14");
  });

  it("parses dates with Arabic-Indic digits", () => {
    expect(parseCellDate("١٤/٠٣/٢٠٢٦", "day_month")).toBe("2026-03-14");
  });

  it("parses timestamps with Arabic-Indic digits and offsets", () => {
    const parsed = parseTimestamp("٢٠٢٦-٠٣-٠١T٠٩:٠٠:٠٠+٠٤:٠٠");
    expect(parsed?.instant).toBe("2026-03-01T05:00:00Z");
  });

  it("parses day-first timestamps without an offset as Asia/Dubai", () => {
    const parsed = parseTimestamp("01/03/2026 09:00");
    expect(parsed?.instant).toBe("2026-03-01T05:00:00Z");
  });
});

describe("amounts", () => {
  it("parses comma-decimal amounts in a comma column convention", () => {
    expect(parseAmount("14.500,00", "comma").fils).toBe(1_450_000);
  });

  it("returns DQ-013 for more than two decimals", () => {
    const parsed = parseAmount("4500.123");
    expect(parsed.fils).toBeNull();
    expect(parsed.dq).toBe("DQ-013");
  });

  it("parses Arabic-Indic digits and separators", () => {
    expect(parseAmount("١٢٥٠٫٠٠").fils).toBe(125_000);
  });
});

describe("ingestion", () => {
  it("keeps unknown columns as pass-through", () => {
    const parsed = parseCsv(csv(["T1,LEAVE,E1,2026-03-01"], "txn_id,type,employee_id,effective_date,cost_centre"), ",");
    const out = normaliseTransactions(parsed, "ds", issues());
    expect(out[0]?.passthrough).toBeDefined();
  });

  it("quarantines rows with a field over 32 KB", () => {
    const big = "x".repeat(32_001);
    const parsed = parseCsv(csv([`T1,LEAVE,E1,2026-03-01,${big}`], "txn_id,type,employee_id,effective_date,comment"), ",");
    const iss = issues();
    const out = normaliseTransactions(parsed, "ds", iss);
    expect(out).toHaveLength(0);
    expect(iss.quarantined[0]?.dq).toBe("DQ-018");
  });

  it("uses the column decimal convention for amounts", () => {
    const parsed = parseCsv(csv(['T1,ALLOWANCE_CHANGE,E1,2026-03-01,"14.500,00",AED'], "txn_id,type,employee_id,effective_date,amount,currency"), ",");
    const out = normaliseTransactions(parsed, "ds", issues());
    expect(out[0]?.amountFils).toBe(1_450_000);
  });

  it("canonicalises approver IDs with case and surrounding spaces at ingestion", () => {
    const parsed = parseCsv(csv(["T1,LEAVE,E1,2026-03-01, E00001 "], "txn_id,type,employee_id,effective_date,approver_ids"), ",");
    const out = normaliseTransactions(parsed, "ds", issues());
    expect(out[0]?.approvals?.[0]?.approverId).toBe("E00001");
  });

  it("rejects two columns that map to the same required header", () => {
    const parsed = parseCsv(csv(["T1,LEAVE,E1,2026-03-01"], "txn_id,transaction_id,type,employee_id,effective_date"), ",");
    expect(() => normaliseTransactions(parsed, "ds", issues())).toThrow(/MZ-DS-422/);
  });
});
