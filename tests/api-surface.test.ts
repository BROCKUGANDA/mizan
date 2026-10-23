import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { seedTestDatabase } from "./helpers/seed-test-db";
import { POST as uploadDataset } from "@/app/api/v1/datasets/route";
import { POST as checkTxn } from "@/app/api/v1/check/route";
import { GET as coverage } from "@/app/api/v1/runs/[id]/coverage/route";
import { GET as diff } from "@/app/api/v1/runs/[id]/diff/[b]/route";
import { GET as ready } from "@/app/api/v1/health/ready/route";
import { startRun } from "@/lib/server/run-pipeline";

const EMPLOYEES = [
  "employee_id,grade,department,location,manager_id,hire_date,exit_date,status,nationality,roles,base_salary",
  "E1,10,Finance,Dubai,,2020-01-01,,ACTIVE,EXPAT,,12000",
  "E2,14,Finance,Dubai,,2019-01-01,,ACTIVE,EXPAT,,20000",
].join("\r\n") + "\r\n";

const TRANSACTIONS = [
  "txn_id,type,employee_id,grade,department,location,amount,currency,amount_semantics,effective_date,submitted_at,requester_id,approver_ids,approver_grades,approver_times,approver_roles,documents,receiving_manager_id,from_department,reversal_of,comment",
  "UPL-1,LEAVE,E1,10,Finance,Dubai,,AED,delta,2026-03-01,2026-03-01T09:00:00+04:00,E1,E2,14,2026-03-01T10:00:00+04:00,LINE_MANAGER,,,,,",
  "UPL-2,ALLOWANCE_CHANGE,E1,10,Finance,Dubai,14500.00,AED,delta,2026-03-05,2026-03-03T09:00:00+04:00,E1,E2,14,2026-03-03T10:00:00+04:00,,,,,,",
].join("\r\n") + "\r\n";

function upload(file: File, kind: string, actor = "analyst-a", synthetic = true): NextRequest {
  const form = new FormData();
  form.set("file", file);
  form.set("kind", kind);
  form.set("synthetic", synthetic ? "true" : "false");
  form.set("source", "test");
  return new NextRequest("http://localhost/api/v1/datasets", { method: "POST", headers: { "x-mizan-actor": actor }, body: form });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await res.text()) as Record<string, unknown>;
}

beforeAll(async () => {
  await seedTestDatabase();
});

beforeEach(async () => {
  await seedTestDatabase();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("dataset upload", () => {
  it("uploads employees and transactions, deduplicates content and runs on the replacement set", async () => {
    const emp = await uploadDataset(upload(new File([EMPLOYEES], "employees.csv", { type: "text/csv" }), "employees"), {});
    expect(emp.status).toBe(201);
    const tx = await uploadDataset(upload(new File([TRANSACTIONS], "transactions.csv", { type: "text/csv" }), "transactions"), {});
    expect(tx.status).toBe(201);
    const again = await uploadDataset(upload(new File([TRANSACTIONS], "transactions-copy.csv", { type: "text/csv" }), "transactions"), {});
    expect(again.status).toBe(200);
    expect((await json(again)).dataset).toMatchObject({ deduplicated: true });

    const run = await startRun({ kind: "standard", actor: "analyst-a" });
    expect(run.status).toBe("COMPLETED");
    const stored = await db.txn.count();
    expect(stored).toBe(2);
    const runRow = await db.run.findUniqueOrThrow({ where: { id: run.runId } });
    expect(JSON.parse(runRow.countsJson).transactions).toBe(2);
  });

  it("refuses real-looking PII, non-CSV magic bytes and missing synthetic confirmation", async () => {
    const pii = TRANSACTIONS.replace("UPL-1,LEAVE", "UPL-1,LEAVE") + "UPL-3,LEAVE,E1,10,Finance,Dubai,,AED,delta,2026-03-01,2026-03-01T09:00:00+04:00,E1,E2,14,2026-03-01T10:00:00+04:00,LINE_MANAGER,,,,,contact hr@example.com\r\n";
    const piiRes = await uploadDataset(upload(new File([pii], "transactions.csv"), "transactions"), {});
    expect(piiRes.status).toBe(422);
    const zip = await uploadDataset(upload(new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])], "transactions.csv"), "transactions"), {});
    expect(zip.status).toBe(415);
    const noSynthetic = await uploadDataset(upload(new File([TRANSACTIONS], "transactions.csv"), "transactions", "analyst-a", false), {});
    expect(noSynthetic.status).toBe(422);
  });
});

describe("/check", () => {
  it("evaluates one transaction without creating an exception", async () => {
    const before = await db.exception.count();
    const req = new NextRequest("http://localhost/api/v1/check", {
      method: "POST",
      headers: { "content-type": "application/json", "x-mizan-actor": "analyst-a" },
      body: JSON.stringify({
        transaction: {
          txnId: "CHECK-1", type: "ALLOWANCE_CHANGE", employeeId: "E00260", amount: "14500.00",
          effectiveDate: "2026-03-05", submittedAt: "2026-03-03T09:00:00Z", requesterId: "E00260",
          approvals: [{ approverId: "E00001", approvedAt: "2026-03-03T10:00:00Z", grade: "9" }],
        },
      }),
    });
    const res = await checkTxn(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(Array.isArray(body.checks)).toBe(true);
    expect((body.checks as { outcome: string }[]).some((c) => c.outcome === "FAIL")).toBe(true);
    expect(await db.exception.count()).toBe(before);
  });
});

describe("run read endpoints", () => {
  it("serves coverage, diff and readiness", async () => {
    const a = await startRun({ kind: "standard", actor: "analyst-a" });
    const b = await startRun({ kind: "standard", actor: "analyst-a" });
    const cov = await coverage(new NextRequest(`http://localhost/api/v1/runs/${a.runId}/coverage`, { headers: { "x-mizan-actor": "analyst-a" } }), { params: Promise.resolve({ id: a.runId }) });
    expect(cov.status).toBe(200);
    expect((await json(cov)).rules).toBeTruthy();
    const d = await diff(new NextRequest(`http://localhost/api/v1/runs/${a.runId}/diff/${b.runId}`, { headers: { "x-mizan-actor": "analyst-a" } }), { params: Promise.resolve({ id: a.runId, b: b.runId }) });
    expect(d.status).toBe(200);
    expect((await json(d)).counts).toEqual({ added: 0, removed: 0, changed: 0 });
    const health = await ready();
    expect(health.status).toBe(200);
  });
});
