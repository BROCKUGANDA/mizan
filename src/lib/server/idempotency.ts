/**
 * Idempotency keys (FS-10): scoped to actor + route, stored 24 h.
 * First request runs; a completed repeat replays the stored response; a
 * concurrent repeat returns MZ-IDEM-409; the same key with a different body
 * returns MZ-IDEM-422.
 */

import { db } from "@/lib/db";
import { canonicalJson } from "../domain/canonical";
import { MzError } from "../domain/errors";

const IN_PROGRESS = "__MZ_IN_PROGRESS__";
const TTL_MS = 24 * 60 * 60 * 1000;

export async function withIdempotency<T>(
  key: string | null,
  route: string,
  body: unknown,
  handler: () => Promise<T>,
  actor = "system"
): Promise<{ result: T; replayed: boolean }> {
  if (!key) return { result: await handler(), replayed: false };
  const scopedKey = `${actor}|${route}|${key}`;
  const bodyHash = canonicalJson(body ?? null);

  const existing = await db.idempotencyKey.findUnique({ where: { key: scopedKey } });
  if (existing) {
    if (Date.now() - existing.createdAt.getTime() > TTL_MS) {
      await db.idempotencyKey.delete({ where: { key: scopedKey } });
    } else if (existing.responseJson === IN_PROGRESS) {
      throw new MzError("MZ-IDEM-409", "The same Idempotency-Key is still being processed. Retry after Retry-After.");
    } else {
      if (existing.route !== route || existing.bodyHash !== bodyHash) {
        throw new MzError("MZ-IDEM-422", "This Idempotency-Key was already used with a different request. Generate a new key; never retry automatically.");
      }
      return { result: JSON.parse(existing.responseJson) as T, replayed: true };
    }
  }

  // Reserve the key before doing side effects so a concurrent repeat cannot run twice.
  try {
    await db.idempotencyKey.create({
      data: { key: scopedKey, route, bodyHash, responseJson: IN_PROGRESS, createdAt: new Date() },
    });
  } catch {
    throw new MzError("MZ-IDEM-409", "The same Idempotency-Key is still being processed. Retry after Retry-After.");
  }
  try {
    const result = await handler();
    await db.idempotencyKey.update({
      where: { key: scopedKey },
      data: { responseJson: JSON.stringify(result ?? null) },
    });
    return { result, replayed: false };
  } catch (error) {
    await db.idempotencyKey.delete({ where: { key: scopedKey } }).catch(() => undefined);
    throw error;
  }
}

/**
 * One shared retry helper (full jitter, cap, Retry-After awareness, deadline).
 * A token-bucket budget keeps retries under 10% of calls per dependency.
 */
export interface RetryPolicy {
  baseMs: number;
  capMs: number;
  attempts: number;
  deadlineMs: number;
  retryOn?: (error: unknown) => boolean;
}

export const RETRY_POLICIES = {
  postgres: { baseMs: 50, capMs: 1_000, attempts: 5, deadlineMs: 3_000, retryOn: retryablePostgres },
  objectStore: { baseMs: 200, capMs: 5_000, attempts: 5, deadlineMs: 30_000 },
  llm: { baseMs: 500, capMs: 8_000, attempts: 3, deadlineMs: 8_000 },
  notify: { baseMs: 5_000, capMs: 900_000, attempts: 8, deadlineMs: 7_200_000 },
} satisfies Record<string, RetryPolicy>;

const BUDGETS = new Map<string, { tokens: number }>();

/** Deposit 0.1 token per first attempt; spend 1 per retry (NON-NEGOTIABLE: <10% retries). */
function spend(dependency: string): boolean {
  const bucket = BUDGETS.get(dependency) ?? { tokens: 10 };
  if (bucket.tokens < 1) {
    BUDGETS.set(dependency, bucket);
    return false;
  }
  bucket.tokens -= 1;
  BUDGETS.set(dependency, bucket);
  return true;
}
function deposit(dependency: string): void {
  const bucket = BUDGETS.get(dependency) ?? { tokens: 10 };
  bucket.tokens = Math.min(10, bucket.tokens + 0.1);
  BUDGETS.set(dependency, bucket);
}

function retryablePostgres(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  return code === "40001" || code === "40P01" || code === "P1008" || code === "P1017";
}

function retryAfterMs(error: unknown): number | null {
  const e = error as { retryAfterMs?: number; response?: { headers?: { get?: (name: string) => string | null } } };
  if (typeof e?.retryAfterMs === "number") return e.retryAfterMs;
  const header = e?.response?.headers?.get?.("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

export async function withRetry<T>(
  dependency: keyof typeof RETRY_POLICIES,
  fn: (signal: AbortSignal) => Promise<T>,
  opts: Partial<RetryPolicy> & { signal?: AbortSignal; rng?: () => number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<T> {
  const policy = { ...RETRY_POLICIES[dependency], ...opts } as RetryPolicy;
  const now = opts.now ?? Date.now;
  const rng = opts.rng ?? Math.random;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const started = now();
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    if (attempt === 1) deposit(dependency);
    const remaining = policy.deadlineMs - (now() - started);
    if (remaining <= 0) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("deadline exceeded")), remaining);
    const relay = (): void => controller.abort(opts.signal?.reason);
    opts.signal?.addEventListener("abort", relay, { once: true });
    try {
      return await fn(controller.signal);
    } catch (error) {
      lastError = error;
      const canRetry = (!policy.retryOn || policy.retryOn(error)) && attempt < policy.attempts && spend(dependency);
      if (!canRetry) throw error;
      const ceiling = Math.min(policy.capMs, policy.baseMs * 2 ** (attempt - 1));
      const jittered = Math.floor(rng() * ceiling);
      const delay = Math.max(jittered, retryAfterMs(error) ?? 0);
      const left = policy.deadlineMs - (now() - started);
      await sleep(Math.min(delay, Math.max(0, left)));
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", relay);
    }
  }
  throw lastError;
}

export function resetRetryBudget(): void {
  BUDGETS.clear();
}
