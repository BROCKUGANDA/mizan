import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { startRun } from "@/lib/server/run-pipeline";
import { seedTestDatabase } from "./helpers/seed-test-db";

async function cleanRunState(): Promise<void> {
  await db.slaEscalation.deleteMany({});
  await db.runFinding.deleteMany({});
  await db.observation.deleteMany({});
  await db.decision.deleteMany({});
  await db.comment.deleteMany({});
  await db.exception.deleteMany({});
  await db.run.deleteMany({});
  await db.outbox.deleteMany({});
  await db.idempotencyKey.deleteMany({});
}

beforeAll(async () => {
  await seedTestDatabase();
});

beforeEach(async () => {
  await cleanRunState();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("run pipeline", () => {
  it("reconciles the census and records a complete manifest", async () => {
    const { runId, status } = await startRun({ kind: "standard", actor: "analyst-a" });
    expect(status).toBe("COMPLETED");
    const run = await db.run.findUniqueOrThrow({ where: { id: runId } });
    const counts = JSON.parse(run.countsJson);
    expect(counts.transactions).toBe(1061);
    expect(counts.clauses).toBe(15);
    expect(counts.checks).toBe(1061 * 15);
    expect(counts.applicable + counts.notApplicable).toBe(counts.checks);
    expect(counts.evaluated + counts.notEvaluable).toBe(counts.applicable);
    expect(run.packHash).not.toBe("pending");
    expect(run.outputHash).toMatch(/^[a-f0-9]{64}$/);
    const inputs = JSON.parse(run.inputsJson);
    expect(inputs.some((i: { kind: string }) => i.kind === "transactions")).toBe(true);
    expect(inputs.some((i: { kind: string }) => i.kind === "employees")).toBe(true);
  });

  it("creates routed exceptions and in-app notifications for a standard run", async () => {
    await startRun({ kind: "standard", actor: "analyst-a" });
    const exceptions = await db.exception.findMany();
    expect(exceptions.length).toBeGreaterThan(40);
    const outbox = await db.outbox.count({ where: { type: "notification.inapp" } });
    expect(outbox).toBe(exceptions.length);
    expect(exceptions.every((e) => e.ackDueAt && e.resolveDueAt)).toBe(true);
  });

  it("stores shadow findings without routing, notifications or SLA clocks", async () => {
    await startRun({ kind: "standard", actor: "analyst-a" });
    const before = await db.outbox.count();
    const standardAckDue = (await db.exception.findFirstOrThrow()).ackDueAt;

    const { status } = await startRun({ kind: "shadow", actor: "analyst-a" });
    expect(status).toBe("COMPLETED");
    expect(await db.outbox.count()).toBe(before);
    const afterAckDue = (await db.exception.findFirstOrThrow()).ackDueAt;
    expect(afterAckDue).toBe(standardAckDue);
  });

  it("does not write live exceptions for a backtest run", async () => {
    const { runId, status } = await startRun({ kind: "backtest", actor: "analyst-a" });
    expect(status).toBe("COMPLETED");
    expect(await db.exception.count()).toBe(0);
    const run = await db.run.findUniqueOrThrow({ where: { id: runId } });
    expect(JSON.parse(run.countsJson).failed).toBeGreaterThan(0);
  });

  it("holds routing for every finding when routing.enabled is false", async () => {
    await db.featureFlag.update({ where: { key: "routing.enabled" }, data: { value: "false" } });
    try {
      const { status } = await startRun({ kind: "standard", actor: "analyst-a" });
      expect(status).toBe("COMPLETED_WITH_HOLDS");
      expect(await db.outbox.count()).toBe(0);
      const exceptions = await db.exception.findMany();
      expect(exceptions.every((e) => e.heldReason !== null)).toBe(true);
    } finally {
      await db.featureFlag.update({ where: { key: "routing.enabled" }, data: { value: "true" } });
    }
  });

  it("uses the internal row ID for exception identity when transaction IDs repeat", async () => {
    await startRun({ kind: "standard", actor: "analyst-a" });
    const rows = await db.exception.findMany({ where: { txnId: "TXN-70001" } });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(new Set(rows.map((r) => r.rowId)).size).toBeGreaterThanOrEqual(2);
    expect(new Set(rows.map((r) => r.exceptionKey)).size).toBe(rows.length);
  });

  it("is deterministic across two standard runs", async () => {
    const first = await startRun({ kind: "standard", actor: "analyst-a" });
    const second = await startRun({ kind: "standard", actor: "analyst-b" });
    const a = await db.run.findUniqueOrThrow({ where: { id: first.runId } });
    const b = await db.run.findUniqueOrThrow({ where: { id: second.runId } });
    expect(a.outputHash).toBe(b.outputHash);
  });
});
