import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { seedTestDatabase } from "./helpers/seed-test-db";
import { startRun, loadActivePack } from "@/lib/server/run-pipeline";
import { POST as createDraft } from "@/app/api/v1/rules/drafts/route";
import { POST as backtestDraft } from "@/app/api/v1/rules/drafts/[id]/backtest/route";
import { POST as transitionDraft } from "@/app/api/v1/rules/drafts/[id]/transition/route";
import { POST as transitionRule } from "@/app/api/v1/rules/[id]/transition/route";

function post(url: string, actor: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mizan-actor": actor, "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(body),
  });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await res.text()) as Record<string, unknown>;
}

async function clean(): Promise<void> {
  await db.slaEscalation.deleteMany({});
  await db.runFinding.deleteMany({});
  await db.observation.deleteMany({});
  await db.decision.deleteMany({});
  await db.comment.deleteMany({});
  await db.exception.deleteMany({});
  await db.run.deleteMany({});
  await db.outbox.deleteMany({});
  await db.idempotencyKey.deleteMany({});
  await db.ruleDraft.deleteMany({});
  await db.ruleApproval.deleteMany({});
  await db.ruleVersion.deleteMany({});
  await db.rule.deleteMany({ where: { id: { startsWith: "R1" } } });
}

beforeAll(async () => {
  await seedTestDatabase();
});

beforeEach(async () => {
  await clean();
  await seedTestDatabase();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("rule studio lifecycle", () => {
  it("draft → backtest → submit → approve → shadow run → active, with the exact-hash gates", async () => {
    const text = "Any allowance change above AED 10,000 must be approved by someone at grade 13 or above.";
    const created = await createDraft(post("/api/v1/rules/drafts", "policy-author", { text }), {});
    expect(created.status).toBe(201);
    const draft = await json(created);
    expect(draft.spec).toBeTruthy();
    const draftId = String(draft.id);

    const bt = await backtestDraft(post(`/api/v1/rules/drafts/${draftId}/backtest`, "policy-author", { spec: draft.spec }), { params: Promise.resolve({ id: draftId }) });
    expect(bt.status).toBe(200);
    const backtest = await json(bt);
    expect(backtest.specHash).toMatch(/^[a-f0-9]{64}$/);

    const submitted = await transitionDraft(post(`/api/v1/rules/drafts/${draftId}/transition`, "policy-author", { action: "submit", acknowledged: true }), { params: Promise.resolve({ id: draftId }) });
    expect(submitted.status).toBe(200);
    expect((await json(submitted)).status).toBe("submitted");

    const self = await transitionDraft(post(`/api/v1/rules/drafts/${draftId}/transition`, "policy-author", { action: "approve" }), { params: Promise.resolve({ id: draftId }) });
    expect(self.status).toBe(403);

    const approved = await transitionDraft(post(`/api/v1/rules/drafts/${draftId}/transition`, "policy-approver", { action: "approve" }), { params: Promise.resolve({ id: draftId }) });
    expect(approved.status).toBe(200);
    const approvedBody = await json(approved);
    const ruleId = String(approvedBody.ruleId);
    expect(ruleId).toMatch(/^R\d+$/);
    const rule = await db.rule.findUniqueOrThrow({ where: { id: ruleId } });
    expect(rule.status).toBe("approved");
    expect(rule.specHash).toBe(backtest.specHash);
    expect(await db.ruleVersion.count({ where: { ruleId } })).toBe(1);

    const shadow = await transitionRule(post(`/api/v1/rules/${ruleId}/transition`, "policy-approver", { action: "activate", asShadow: true }), { params: Promise.resolve({ id: ruleId }) });
    expect(shadow.status).toBe(200);
    expect((await json(shadow)).status).toBe("shadow");

    const tooSoon = await transitionRule(post(`/api/v1/rules/${ruleId}/transition`, "policy-approver", { action: "activate" }), { params: Promise.resolve({ id: ruleId }) });
    expect(tooSoon.status).toBe(422);

    await startRun({ kind: "shadow", actor: "analyst-a" });
    const afterRun = await db.rule.findUniqueOrThrow({ where: { id: ruleId } });
    expect(afterRun.shadowRunId).toBeTruthy();

    const active = await transitionRule(post(`/api/v1/rules/${ruleId}/transition`, "policy-approver", { action: "activate" }), { params: Promise.resolve({ id: ruleId }) });
    expect(active.status).toBe(200);
    expect((await json(active)).status).toBe("active");
    const pack = await loadActivePack();
    expect(pack.some((r) => r.id === ruleId && r.status === "active")).toBe(true);
  });

  it("rejects a submission whose spec changed after the backtest", async () => {
    const text = "Any allowance change above AED 10,000 must be approved by someone at grade 13 or above.";
    const created = await createDraft(post("/api/v1/rules/drafts", "policy-author", { text }), {});
    const draft = await json(created);
    const draftId = String(draft.id);
    await backtestDraft(post(`/api/v1/rules/drafts/${draftId}/backtest`, "policy-author", { spec: draft.spec }), { params: Promise.resolve({ id: draftId }) });
    const stored = await db.ruleDraft.findUniqueOrThrow({ where: { id: draftId } });
    const spec = JSON.parse(stored.specJson!);
    spec.check.params.minApproverGrade = 15;
    await db.ruleDraft.update({ where: { id: draftId }, data: { specJson: JSON.stringify(spec) } });
    const res = await transitionDraft(post(`/api/v1/rules/drafts/${draftId}/transition`, "policy-author", { action: "submit", acknowledged: true }), { params: Promise.resolve({ id: draftId }) });
    expect(res.status).toBe(422);
    expect((await json(res)).code).toBe("MZ-RULE-422");
  });

  it("requires acknowledgement when the backtest fails more than 10% of applicable history", async () => {
    const text = "Any allowance change above AED 1 must be approved by someone at grade 20 or above.";
    const created = await createDraft(post("/api/v1/rules/drafts", "policy-author", { text }), {});
    const draft = await json(created);
    const draftId = String(draft.id);
    const bt = await backtestDraft(post(`/api/v1/rules/drafts/${draftId}/backtest`, "policy-author", { spec: draft.spec }), { params: Promise.resolve({ id: draftId }) });
    const backtest = await json(bt);
    expect(Number(backtest.failRate)).toBeGreaterThan(10);
    const noAck = await transitionDraft(post(`/api/v1/rules/drafts/${draftId}/transition`, "policy-author", { action: "submit", acknowledged: false }), { params: Promise.resolve({ id: draftId }) });
    expect(noAck.status).toBe(422);
    const ack = await transitionDraft(post(`/api/v1/rules/drafts/${draftId}/transition`, "policy-author", { action: "submit", acknowledged: true }), { params: Promise.resolve({ id: draftId }) });
    expect(ack.status).toBe(200);
  });
});

describe("plain-English grammar", () => {
  it("keeps 'above AED X' strict even when the grade says 'or above'", async () => {
    const { parsePlainEnglish } = await import("@/app/api/v1/rules/drafts/route");
    const parsed = parsePlainEnglish("Any allowance change above AED 10,000 must be approved by someone at grade 13 or above.");
    expect(parsed.spec).toBeTruthy();
    const spec = parsed.spec as { scope: { where: { all: { op: string; value: number }[] } }; tests: { name: string; expect: string }[] } | null;
    expect(spec?.scope.where.all[0]).toMatchObject({ op: "gt", value: 1_000_000 });
    expect(parsed.ambiguities.find((a) => a.chip === "comparator")?.chosen).toBe(">");
    expect(spec?.tests.find((t) => t.name === "at_boundary")?.expect).toBe("NOT_APPLICABLE");
  });

  it("keeps 'at least AED X' inclusive", async () => {
    const { parsePlainEnglish } = await import("@/app/api/v1/rules/drafts/route");
    const parsed = parsePlainEnglish("Any allowance change at least AED 10,000 must be approved by someone at grade 13 or above.");
    const spec = parsed.spec as { scope: { where: { all: { op: string; value: number }[] } } } | null;
    expect(spec?.scope.where.all[0]?.op).toBe("gte");
    expect(parsed.ambiguities.find((a) => a.chip === "comparator")?.chosen).toBe("≥");
  });
});
