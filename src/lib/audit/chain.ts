/**
 * Tamper-evident audit trail (§20): one chain per tenant.
 * hash = SHA-256(prevHash ‖ canonical_json(event without hash)); genesis prevHash
 * = SHA-256("MIZAN-GENESIS" ‖ tenantId). Order from the DB sequence, never wall-clock.
 * Appends happen inside the same transaction as the change they record.
 */

import { db } from "@/lib/db";
import { canonicalJson, sha256 } from "../domain/canonical";

export interface AuditInput {
  tenantId?: string;
  actor: string; // user id or system:<component>
  type: string;
  entity: string;
  entityId: string;
  payload: Record<string, unknown>;
  at?: string; // ISO instant; defaults to server time (UI only; engine never reads clocks)
}

const REDACT_KEYS = /(name|email|comment|notes|free_text|nationality)/i;

function redact(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (REDACT_KEYS.test(k) && typeof v === "string") out[k] = "[redacted]";
    else if (v && typeof v === "object" && !Array.isArray(v)) out[k] = redact(v as Record<string, unknown>);
    else out[k] = v;
  }
  return out;
}

export function genesisHash(tenantId: string): string {
  return sha256(`MIZAN-GENESIS‖${tenantId}`);
}

/** Append one event; returns the computed hash. Caller owns the surrounding transaction scope. */
export async function appendAudit(input: AuditInput): Promise<{ seq: number; hash: string }> {
  const tenantId = input.tenantId ?? "default";
  const last = await db.auditEvent.findFirst({ where: { tenantId }, orderBy: { seq: "desc" } });
  const prevHash = last?.hash ?? genesisHash(tenantId);
  const at = input.at ?? new Date().toISOString();
  const payloadJson = canonicalJson(redact(input.payload));
  const hash = sha256(prevHash + canonicalJson({ tenantId, at, actor: input.actor, type: input.type, entity: input.entity, entityId: input.entityId, payloadJson }));
  const row = await db.auditEvent.create({
    data: { tenantId, at, actor: input.actor, type: input.type, entity: input.entity, entityId: input.entityId, payloadJson, prevHash, hash },
  });
  return { seq: row.seq, hash: row.hash };
}

export interface VerifyResult {
  ok: boolean;
  checked: number;
  firstBadSeq: number | null;
  headHash: string | null;
  verifiedAt: string;
}

/** Full-chain verification (hourly job + on demand). A failure enters safe halt (M5). */
export async function verifyChain(tenantId = "default"): Promise<VerifyResult> {
  const events = await db.auditEvent.findMany({ where: { tenantId }, orderBy: { seq: "asc" } });
  let prevHash = genesisHash(tenantId);
  for (const e of events) {
    const expected = sha256(prevHash + canonicalJson({ tenantId: e.tenantId, at: e.at, actor: e.actor, type: e.type, entity: e.entity, entityId: e.entityId, payloadJson: e.payloadJson }));
    if (e.prevHash !== prevHash || e.hash !== expected) {
      return { ok: false, checked: events.length, firstBadSeq: e.seq, headHash: prevHash, verifiedAt: new Date().toISOString() };
    }
    prevHash = e.hash;
  }
  return { ok: true, checked: events.length, firstBadSeq: null, headHash: prevHash, verifiedAt: new Date().toISOString() };
}
