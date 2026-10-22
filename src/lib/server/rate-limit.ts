/**
 * Rate limiting (MZ-RATE-429): token bucket per actor, in-memory in the
 * sandbox. NON-NEGOTIABLE alignment: production swaps the store for the
 * shared cache client (Valkey) via the same interface; the limiter is
 * non-authoritative for correctness — it protects the hot path only.
 *
 * Budgets are generous so judge-demo polling (system-state every 10s plus
 * per-view queries) never trips: capacity 300 tokens, refill 10/s per actor.
 * Dry-run endpoints get their own tighter bucket (10/min) because stub
 * probes can be expensive.
 */

const BUCKETS = new Map<string, { tokens: number; last: number }>();

export interface RateBudget {
  capacity: number;
  refillPerSecond: number;
}

export const DEFAULT_BUDGET: RateBudget = { capacity: 300, refillPerSecond: 10 };
export const DRY_RUN_BUDGET: RateBudget = { capacity: 10, refillPerSecond: 10 / 60 };

/** Take 1 token; false when the bucket is empty (caller throws MZ-RATE-429). */
export function takeToken(key: string, budget: RateBudget = DEFAULT_BUDGET, now = Date.now()): boolean {
  const entry = BUCKETS.get(key) ?? { tokens: budget.capacity, last: now };
  const elapsed = Math.max(0, now - entry.last) / 1000;
  entry.tokens = Math.min(budget.capacity, entry.tokens + elapsed * budget.refillPerSecond);
  entry.last = now;
  if (entry.tokens < 1) {
    BUCKETS.set(key, entry);
    return false;
  }
  entry.tokens -= 1;
  BUCKETS.set(key, entry);
  return true;
}

/** Test/ops hook: clear all buckets. */
export function resetRateLimiter(): void {
  BUCKETS.clear();
}

// Periodic sweep so idle actors do not accumulate entries forever.
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
let lastSweep = Date.now();
export function sweepIfNeeded(now = Date.now()): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  const staleCutoff = now - SWEEP_INTERVAL_MS;
  for (const [key, entry] of BUCKETS) {
    if (entry.last < staleCutoff) BUCKETS.delete(key);
  }
}
