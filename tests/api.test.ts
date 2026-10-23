import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { startRun } from "@/lib/server/run-pipeline";
import { seedTestDatabase } from "./helpers/seed-test-db";
import { POST as decide } from "@/app/api/v1/exceptions/[key]/decisions/route";
import { POST as countersign } from "@/app/api/v1/exceptions/[key]/countersign/route";
import { renderFindingsCsv, validateFindingsCsv, type FindingRow } from "@/lib/server/export";
import { appendAudit, verifyChain } from "@/lib/audit/chain";
import { withIdempotency } from "@/lib/server/idempotency";
import { runDeadlineTick } from "@/lib/server/deadlines";
import { buildEvidencePack, verifyEvidencePack } from "@/lib/server/evidence";
import { computeFairness, computeMeasuredPrecision } from "@/lib/server/analytics";
import { MzError } from "@/lib/domain/errors";

function request(url: string, actor: string, body: unknown, extra: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mizan-actor": actor, ...extra },
    body: JSON.stringify(body),
  });
}

async function responseJson(res: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await res.text()) as Record<string, unknown>;
}

async function exceptionFor(txnId: string): Promise<{ exceptionKey: string; version: number; severity: string }> {
  const e = await db.exception.findFirstOrThrow({ where: { txnId } });
  return { exceptionKey: e.exceptionKey, version: e.version, severity: e.severity };
}

beforeAll(async () => {
  await seedTestDatabase();
});

beforeEach(async () => {
  await db.slaEscalation.deleteMany({});
  await db.runFinding.deleteMany({});
  await db.observation.deleteMany({});
  await db.decision.deleteMany({});
  await db.comment.deleteMany({});
  await db.exception.deleteMany({});
  await db.run.deleteMany({});
  await db.outbox.deleteMany({});
  await db.idempotencyKey.deleteMany({});
  await db.auditEvent.deleteMany({});
  await db.featureFlag.update({ where: { key: "routing.enabled" }, data: { value: "true" } });
});

afterAll(async () => {
  await db.$disconnect();
});

describe("decision API", () => {
  it("requires If-Match and returns MZ-CONC-428 without it", async () => {
    await startRun({ kind: "standard", actor: "analyst-a" });
    const e = await exceptionFor("WX-1006");
    const res = await decide(request(`/api/v1/exceptions/${e.exceptionKey}/decisions`, "analyst-a", { command: "triage" }), { params: Promise.resolve({ key: e.exceptionKey }) });
    expect(res.status).toBe(428);
    expect((await responseJson(res)).code).toBe("MZ-CONC-428");
  });

  it("records a decision once and rejects a stale If-Match", async () => {
    await startRun({ kind: "standard", actor: "analyst-a" });
    const e = await exceptionFor("WX-1006");
    const first = await decide(request(`/api/v1/exceptions/${e.exceptionKey}/decisions`, "analyst-a", { command: "triage" }, { "if-match": `W/"${e.version}"`, "idempotency-key": "triage-wx-1006" }), { params: Promise.resolve({ key: e.exceptionKey }) });
    expect(first.status).toBe(200);
    const body = await responseJson(first);
    expect(body.status).toBe("TRIAGED");
    expect(body.auditHash).toBeTruthy();

    const stale = await decide(request(`/api/v1/exceptions/${e.exceptionKey}/decisions`, "analyst-a", { command: "triage" }, { "if-match": `W/"${e.version}"`, "idempotency-key": "stale-triage-wx-1006" }), { params: Promise.resolve({ key: e.exceptionKey }) });
    expect(stale.status).toBe(409);
    const staleBody = await responseJson(stale);
    expect(staleBody.code).toBe("MZ-CONC-409");
    expect(staleBody.currentVersion).toBe(e.version + 1);
  });

  it("blocks a party to the transaction with MZ-AUTH-403-COI", async () => {
    await startRun({ kind: "standard", actor: "analyst-a" });
    const e = await exceptionFor("WX-1006");
    const res = await decide(request(`/api/v1/exceptions/${e.exceptionKey}/decisions`, "analyst-c", { command: "triage" }, { "if-match": `W/"${e.version}"` }), { params: Promise.resolve({ key: e.exceptionKey }) });
    expect(res.status).toBe(403);
    expect((await responseJson(res)).code).toBe("MZ-AUTH-403-COI");
  });

  it("needs a second analyst to countersign a High dismissal and records it atomically", async () => {
    await startRun({ kind: "standard", actor: "analyst-a" });
    const e = await exceptionFor("WX-1006");
    const triage = await decide(request(`/api/v1/exceptions/${e.exceptionKey}/decisions`, "analyst-b", { command: "triage" }, { "if-match": `W/"${e.version}"`, "idempotency-key": "triage-1" }), { params: Promise.resolve({ key: e.exceptionKey }) });
    const triaged = await responseJson(triage);
    const dismiss = await decide(request(`/api/v1/exceptions/${e.exceptionKey}/decisions`, "analyst-a", { command: "dismiss", reasonCategory: "not_an_exception", reasonText: "The duplicate pair was corrected at source." }, { "if-match": `W/"${triaged.version}"`, "idempotency-key": "dismiss-1" }), { params: Promise.resolve({ key: e.exceptionKey }) });
    const dismissed = await responseJson(dismiss);
    expect(dismissed.pendingCountersign).toBe(true);
    expect(dismissed.status).toBe("TRIAGED");

    const self = await countersign(request(`/api/v1/exceptions/${e.exceptionKey}/countersign`, "analyst-a", { note: "self" }, { "if-match": `W/"${dismissed.version}"`, "idempotency-key": "cs-self" }), { params: Promise.resolve({ key: e.exceptionKey }) });
    expect(self.status).toBe(403);

    const cs = await countersign(request(`/api/v1/exceptions/${e.exceptionKey}/countersign`, "analyst-b", { note: "reviewed" }, { "if-match": `W/"${dismissed.version}"`, "idempotency-key": "cs-1" }), { params: Promise.resolve({ key: e.exceptionKey }) });
    expect(cs.status).toBe(200);
    const csBody = await responseJson(cs);
    expect(csBody.status).toBe("DISMISSED");
    const stored = await db.exception.findUniqueOrThrow({ where: { exceptionKey: e.exceptionKey } });
    expect(stored.status).toBe("DISMISSED");
    const d = await db.decision.findFirstOrThrow({ where: { exceptionKey: e.exceptionKey, command: "dismiss" } });
    expect(d.countersignedBy).toBe("analyst-b");
  });

  it("replays an idempotent decision without creating a second decision", async () => {
    await startRun({ kind: "standard", actor: "analyst-a" });
    const e = await exceptionFor("WX-1006");
    const headers = { "if-match": `W/"${e.version}"`, "idempotency-key": "same-triage" };
    const one = await decide(request(`/api/v1/exceptions/${e.exceptionKey}/decisions`, "analyst-a", { command: "triage" }, headers), { params: Promise.resolve({ key: e.exceptionKey }) });
    const two = await decide(request(`/api/v1/exceptions/${e.exceptionKey}/decisions`, "analyst-a", { command: "triage" }, headers), { params: Promise.resolve({ key: e.exceptionKey }) });
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect(two.headers.get("mizan-idempotent-replay")).toBe("true");
    expect(await db.decision.count({ where: { exceptionKey: e.exceptionKey, command: "triage" } })).toBe(1);
  });
});

describe("deadline tick", () => {
  it("returns an expired accepted risk to triage and never closes it", async () => {
    await startRun({ kind: "standard", actor: "analyst-a" });
    const e = await exceptionFor("WX-1006");
    await db.exception.update({ where: { exceptionKey: e.exceptionKey }, data: { status: "ACCEPTED_RISK" } });
    await db.decision.create({
      data: {
        id: "risk-1", exceptionKey: e.exceptionKey, command: "accept_risk", actorId: "team-lead",
        reasonText: "accepted for the pilot window", expiry: "2026-01-01", idempotencyKey: "risk-key",
      },
    });
    const result = await runDeadlineTick("2026-01-02");
    expect(result.expiredRisks).toBe(1);
    const stored = await db.exception.findUniqueOrThrow({ where: { exceptionKey: e.exceptionKey } });
    expect(stored.status).toBe("TRIAGED");
    expect(await db.slaEscalation.count({ where: { exceptionKey: e.exceptionKey } })).toBe(0);
  });

  it("creates the 75/100/150% escalation levels exactly once", async () => {
    await startRun({ kind: "standard", actor: "analyst-a" });
    const e = await exceptionFor("WX-1006");
    await db.exception.update({
      where: { exceptionKey: e.exceptionKey },
      data: { status: "IN_PROGRESS", createdAt: new Date("2026-01-01T00:00:00Z"), resolveDueAt: "2026-01-05" },
    });
    const first = await runDeadlineTick("2026-01-10");
    expect(first.escalations).toBe(3);
    const second = await runDeadlineTick("2026-01-11");
    expect(second.escalations).toBe(0);
    expect(await db.slaEscalation.count({ where: { exceptionKey: e.exceptionKey } })).toBe(3);
  });
});

describe("analytics", () => {
  it("computes measured precision on the labelled sample and suppresses small cells", async () => {
    await startRun({ kind: "standard", actor: "analyst-a" });
    const precision = await computeMeasuredPrecision();
    expect(precision).not.toBeNull();
    expect(precision!.sampleSize).toBeGreaterThan(20);
    expect(precision!.lowerBound).toBeGreaterThanOrEqual(0.9);
    const fairness = await computeFairness();
    expect(fairness.length).toBeGreaterThan(0);
    const small = fairness.filter((c) => c.suppressed);
    expect(small.every((c) => c.exceptions === 0 && c.employees === 0)).toBe(true);
    const visible = fairness.filter((c) => !c.suppressed);
    expect(visible.every((c) => c.wilsonLower <= c.wilsonUpper && c.checks > 0)).toBe(true);
  });
});

describe("evidence packs", () => {
  it("builds a verifiable per-run pack and detects tampering", async () => {
    const run = await startRun({ kind: "standard", actor: "analyst-a" });
    const pack = await buildEvidencePack(`run:${run.runId}`);
    expect(pack.files["findings.json"]).toBeTruthy();
    expect(pack.manifest.chainVerified).toBe(true);
    expect(verifyEvidencePack(pack).ok).toBe(true);
    const tampered = { ...pack, files: { ...pack.files, "findings.json": pack.files["findings.json"] + " " } };
    const result = verifyEvidencePack(tampered);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("findings.json"))).toBe(true);
  });
});

describe("export validator", () => {
  const row = (overrides: Partial<FindingRow> = {}): FindingRow => ({
    finding_id: "F-ABCDEFGHJKMN",
    txnId: "TXN-1",
    ruleId: "R04",
    ruleVersion: "1.0.0",
    clauseId: "C1",
    severity: "HIGH",
    headlineEn: "Headline",
    whatBrokeEn: "What broke",
    whyItMattersEn: "Why",
    actionEn: "Fix it",
    ownerTeam: "Compensation & Payroll Operations",
    evidenceJson: "{}",
    runDate: "2026-03-01",
    ...overrides,
  });

  it("hashes the actual bytes and rejects a malformed enum or ID", () => {
    const csv = renderFindingsCsv([row()]);
    const good = validateFindingsCsv(csv);
    expect(good.findingsSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(good.structuralErrors.filter((e) => !e.includes("worked example"))).toHaveLength(0);
    const bad = validateFindingsCsv(renderFindingsCsv([row({ severity: "SEVERE", finding_id: "X" })]));
    expect(bad.structuralErrors.some((e) => e.includes("severity"))).toBe(true);
    expect(bad.structuralErrors.some((e) => e.includes("finding_id"))).toBe(true);
  });

  it("neutralises formula injection in exported cells", () => {
    const csv = renderFindingsCsv([row({ headlineEn: "=HYPERLINK(\"http://evil\")" })]);
    expect(csv).toContain("\"'=HYPERLINK");
  });
});

describe("audit chain", () => {
  it("detects a tampered event at the first changed sequence", async () => {
    await db.auditEvent.deleteMany({});
    await appendAudit({ actor: "analyst-a", type: "test.one", entity: "test", entityId: "1", payload: { n: 1 } });
    const second = await appendAudit({ actor: "analyst-a", type: "test.two", entity: "test", entityId: "2", payload: { n: 2 } });
    expect((await verifyChain()).ok).toBe(true);
    await db.$executeRawUnsafe(`UPDATE AuditEvent SET payloadJson = '{"tampered":true}' WHERE seq = ${second.seq}`);
    const result = await verifyChain();
    expect(result.ok).toBe(false);
    expect(result.firstBadSeq).toBe(second.seq);
  });
});

describe("idempotency", () => {
  it("replays the stored response and rejects a different body", async () => {
    const first = await withIdempotency("key-1", "route-a", { a: 1 }, async () => ({ ok: true, value: 1 }), "actor");
    const replay = await withIdempotency("key-1", "route-a", { a: 1 }, async () => ({ ok: true, value: 2 }), "actor");
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual({ ok: true, value: 1 });
    await expect(withIdempotency("key-1", "route-a", { a: 2 }, async () => ({ ok: true }), "actor")).rejects.toBeInstanceOf(MzError);
  });

  it("scopes keys by actor and route", async () => {
    await withIdempotency("shared", "route-a", { a: 1 }, async () => 1, "actor-a");
    const otherRoute = await withIdempotency("shared", "route-b", { a: 1 }, async () => 2, "actor-a");
    expect(otherRoute.replayed).toBe(false);
    expect(otherRoute.result).toBe(2);
    const otherActor = await withIdempotency("shared", "route-a", { a: 1 }, async () => 3, "actor-b");
    expect(otherActor.replayed).toBe(false);
    expect(otherActor.result).toBe(3);
  });
});
