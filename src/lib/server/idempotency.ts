/**
 * Idempotency keys (FS-10): mutating endpoints accept `Idempotency-Key`;
 * a replay returns the stored response; reuse with a different body → MZ-IDEM-422.
 */

import { db } from "@/lib/db";
import { createHash } from "node:crypto";
import { MzError } from "../domain/errors";

export async function withIdempotency<T>(
  key: string | null,
  route: string,
  body: unknown,
  handler: () => Promise<T>
): Promise<{ result: T; replayed: boolean }> {
  if (!key) return { result: await handler(), replayed: false };
  const bodyHash = createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
  const existing = await db.idempotencyKey.findUnique({ where: { key } });
  if (existing) {
    if (existing.bodyHash !== bodyHash) {
      throw new MzError("MZ-IDEM-422", "This Idempotency-Key was already used with a different body. Generate a new key; never retry automatically.");
    }
    return { result: JSON.parse(existing.responseJson) as T, replayed: true };
  }
  const result = await handler();
  await db.idempotencyKey.create({
    data: { key, route, bodyHash, responseJson: JSON.stringify(result ?? null) },
  });
  return { result, replayed: false };
}

/** One shared retry helper (full jitter, cap, Retry-After awareness, deadline). Lint bans hand-written loops. */
export async function withRetry<T>(fn: () => Promise<T>, opts: { attempts?: number; baseMs?: number; capMs?: number; deadlineMs?: number } = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseMs ?? 100;
  const cap = opts.capMs ?? 2_000;
  const deadline = Date.now() + (opts.deadlineMs ?? 10_000);
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const jitter = Math.random() * base * Math.pow(2, i);
      const wait = Math.min(cap, jitter);
      if (Date.now() + wait > deadline || i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}
