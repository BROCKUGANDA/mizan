/**
 * Non-authoritative cache with single-flight. In this deployment it is an
 * in-process TTL map; production swaps the same interface for Valkey. The app
 * must remain correct when this is disabled (CACHE_DISABLED=true).
 */

interface Entry { expires: number; value: unknown }
const ENTRIES = new Map<string, Entry>();
const IN_FLIGHT = new Map<string, Promise<unknown>>();

export const cacheEnabled = (): boolean => process.env.CACHE_DISABLED !== "true";

export async function getOrSet<T>(key: string, ttlMs: number, producer: () => Promise<T>): Promise<T> {
  if (!cacheEnabled()) return producer();
  const now = Date.now();
  const hit = ENTRIES.get(key);
  if (hit && hit.expires > now) return hit.value as T;
  const existing = IN_FLIGHT.get(key);
  if (existing) return existing as Promise<T>;
  const promise = producer().then((value) => {
    ENTRIES.set(key, { expires: Date.now() + ttlMs, value });
    IN_FLIGHT.delete(key);
    return value;
  }).catch((error) => {
    IN_FLIGHT.delete(key);
    throw error;
  });
  IN_FLIGHT.set(key, promise);
  return promise;
}

export function invalidateCache(prefix?: string): void {
  if (!prefix) { ENTRIES.clear(); return; }
  for (const key of [...ENTRIES.keys()]) if (key.startsWith(prefix)) ENTRIES.delete(key);
}

export function cacheHealth(): { ok: boolean; detail: string; entries: number } {
  return { ok: true, detail: cacheEnabled() ? "in-process TTL cache (non-authoritative)" : "cache disabled", entries: ENTRIES.size };
}
