/**
 * Evidence packs (§20): per-exception and per-run exports with a signed
 * (hash-anchored) manifest. Files are immutable once written; the pack bytes
 * are stored content-addressed in the object store.
 */

import { db } from "@/lib/db";
import { canonicalJson, sha256 } from "../domain/canonical";
import { verifyChain } from "../audit/chain";
import { putObject } from "./object-store";
import { randomUUID } from "node:crypto";

export interface EvidencePack {
  manifest: {
    id: string;
    scope: string;
    createdAt: string;
    algorithm: "SHA-256";
    files: Record<string, string>;
    signature: string;
    chainVerified: boolean;
  };
  files: Record<string, string>;
}

export async function buildEvidencePack(scope: string): Promise<EvidencePack> {
  const [kind, ref] = scope.split(":");
  if (!["exception", "run"].includes(kind ?? "") || !ref) throw new Error("scope must be exception:<key> or run:<id>");
  const run = kind === "run" ? await db.run.findUnique({ where: { id: ref } }) : await db.run.findFirst({ orderBy: { startedAt: "desc" } });
  const exceptions = kind === "exception"
    ? await db.exception.findMany({ where: { exceptionKey: ref } })
    : kind === "run"
      ? await db.exception.findMany({ where: { lastRunId: ref } })
      : [];
  if (!exceptions.length && kind === "exception") throw new Error("not found");
  const snapshots = kind === "run" ? await db.runFinding.findMany({ where: { runId: ref } }) : [];
  const decisions = await db.decision.findMany({ where: { exceptionKey: { in: exceptions.map((e) => e.exceptionKey) } }, orderBy: { createdAt: "asc" } });
  const observations = await db.observation.findMany({ where: { exceptionKey: { in: exceptions.map((e) => e.exceptionKey) } }, orderBy: { observedAt: "asc" } });
  const comments = await db.comment.findMany({ where: { exceptionKey: { in: exceptions.map((e) => e.exceptionKey) } }, orderBy: { createdAt: "asc" } });
  const entityIds = [ref, ...exceptions.map((e) => e.exceptionKey)];
  const events = await db.auditEvent.findMany({ where: { entityId: { in: entityIds } }, orderBy: { seq: "asc" }, take: 2_000 });
  const verify = await verifyChain();
  const rules = await db.rule.findMany({ orderBy: { id: "asc" } });

  const findings = snapshots.length ? snapshots.map((s) => JSON.parse(s.payloadJson)) : exceptions.map((e) => ({
    key: e.exceptionKey, displayId: e.displayId, txnId: e.txnId, rowId: e.rowId, ruleId: e.ruleId,
    clauseId: e.clauseId, ruleVersion: e.ruleVersion, severity: e.severity, status: e.status,
    ownerTeam: e.ownerTeam, headline: { en: e.headlineEn, ar: e.headlineAr },
    explanation: { en: e.explanationEn, ar: e.explanationAr }, action: { en: e.actionEn, ar: e.actionAr },
    evidence: JSON.parse(e.evidenceJson), evidenceHash: e.evidenceHash,
  }));

  const files: Record<string, string> = {
    "findings.json": canonicalJson(findings),
    "exceptions.json": canonicalJson(exceptions.map((e) => ({
      key: e.exceptionKey, displayId: e.displayId, status: e.status, version: e.version, severity: e.severity,
      ownerTeam: e.ownerTeam, routingRationale: e.routingRationale, severityRationale: e.severityRationale,
      explanation: { en: e.explanationEn, ar: e.explanationAr }, evidenceHash: e.evidenceHash,
    }))),
    "decisions.json": canonicalJson(decisions),
    "observations.json": canonicalJson(observations),
    "comments.json": canonicalJson(comments),
    "rule-pack.json": canonicalJson(rules.map((r) => ({ id: r.id, version: r.version, status: r.status, spec: JSON.parse(r.specJson), interpretation: JSON.parse(r.interpretationJson) }))),
    "run-manifest.json": canonicalJson(run ? {
      runId: run.id, kind: run.kind, status: run.status, asOf: run.asOf, engineVersion: run.engineVersion,
      packVersion: run.packVersion, packHash: run.packHash, calendarHash: run.calendarHash,
      routingHash: run.routingHash, gradeLadderHash: run.gradeLadderHash, synonymsHash: run.synonymsHash,
      configHash: run.configHash, flagsHash: run.flagsHash, inputs: JSON.parse(run.inputsJson),
      counts: JSON.parse(run.countsJson), outputHash: run.outputHash,
    } : null),
    "audit-extract.json": canonicalJson(events.map((e) => ({ seq: e.seq, at: e.at, actor: e.actor, type: e.type, entity: e.entity, entityId: e.entityId, payloadJson: e.payloadJson, prevHash: e.prevHash, hash: e.hash }))),
    "chain-verification.json": canonicalJson(verify),
  };
  const fileHashes = Object.fromEntries(Object.entries(files).map(([name, content]) => [name, sha256(content)]));
  const manifest = {
    id: `pack-${randomUUID()}`,
    scope,
    createdAt: new Date().toISOString(),
    algorithm: "SHA-256" as const,
    files: fileHashes,
    signature: sha256(canonicalJson(fileHashes)),
    chainVerified: verify.ok,
  };
  const pack: EvidencePack = { manifest, files };
  const stored = await putObject(new TextEncoder().encode(canonicalJson(pack)));
  await db.evidencePack.create({ data: { id: manifest.id, scope, manifestJson: JSON.stringify(manifest), filesJson: canonicalJson(files), objectKey: stored.key } });
  return pack;
}

export function verifyEvidencePack(pack: EvidencePack): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const [name, content] of Object.entries(pack.files)) {
    if (!pack.manifest.files[name]) errors.push(`manifest is missing ${name}`);
    else if (sha256(content) !== pack.manifest.files[name]) errors.push(`hash mismatch for ${name}`);
  }
  const signature = sha256(canonicalJson(pack.manifest.files));
  if (signature !== pack.manifest.signature) errors.push("manifest signature mismatch");
  return { ok: errors.length === 0, errors };
}

export async function getEvidencePack(id: string): Promise<EvidencePack | null> {
  const row = await db.evidencePack.findUnique({ where: { id } });
  if (!row) return null;
  return { manifest: JSON.parse(row.manifestJson), files: JSON.parse(row.filesJson) };
}
