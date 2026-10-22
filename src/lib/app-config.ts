/**
 * App-wide operational constants — the single source of truth.
 *
 * Production standard: no component, hook or route may hardcode storage keys,
 * polling intervals, custom event names, timings, default identities or build
 * strings. They are imported from here so there is exactly one place to audit
 * and change operational behaviour.
 *
 * This module must stay isomorphic (no server-only imports — it is bundled
 * into client components) and free of side effects.
 */

import { ENGINE_VERSION, PACK_VERSION } from "@/lib/pack/rules";

/* ── Build identity ─────────────────────────────────────────────────────────
 * engine/pack versions live in the rule pack (src/lib/pack/rules.ts); the UI
 * composes its footer from the same constants so the two can never drift. */
export const APP_NAME = "MIZAN";
export const APP_VERSION = "1.0.0";
export const BUILD_LINE = `${APP_NAME} v${APP_VERSION} · ${ENGINE_VERSION} · pack ${PACK_VERSION}`;

/* ── localStorage keys (user preferences; one namespace, auditable) ──────── */
export const STORAGE_KEYS = {
  locale: "mizan-locale",
  digits: "mizan-digits",
  theme: "mizan-theme",
  accent: "mizan-accent",
  kbdHint: "mizan.kbd-hint",
} as const;

/* ── Timing: polling, query tuning, transient UI ────────────────────────────
 * All values in milliseconds unless noted. */
export const POLL = {
  /** In-app notification centre refresh (§14). */
  notificationsMs: 8_000,
  /** Header mode/actor state refresh. */
  systemStateMs: 10_000,
  /** TanStack Query defaults. */
  queryStaleMs: 5_000,
  queryRetry: 1,
  /** ⌘K onboarding hint auto-dismiss. */
  kbdHintDismissMs: 12_000,
  /** Live-run progress polling while a run is in an active status. */
  liveRunMs: 3_000,
  /** Per-view staleness windows (ms). */
  staleMs: {
    overview: 10_000,
    queue: 15_000,
    runs: 60_000,
    rules: 30_000,
    settings: 30_000,
  },
} as const;

/* ── Custom DOM events (shell ↔ views; names are a contract) ─────────────── */
export const EVENTS = {
  /** Detail: { dir: 1 | -1 } — moves the queue cursor down/up. */
  queueNav: "mizan-queue-nav",
} as const;

/* ── Default identity ───────────────────────────────────────────────────────
 * Must match a seeded Actor id (prisma/seed). The server re-exports this from
 * src/lib/server/session.ts; the client store seeds its zustand state here. */
export const DEFAULT_ACTOR = "analyst-a";

/* ── Segregation-of-duties fallback pair (dry-run verification) ─────────────
 * "Never self-verified" needs two distinct seeded analysts; production swaps
 * this for a directory lookup (see integrations/registry.ts). */
export const ANALYST_PAIR = ["analyst-a", "analyst-b"] as const;
