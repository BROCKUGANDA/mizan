/**
 * Integration stubs — every stub is a documented seam for the real thing.
 * The product is fully functional with these stubs; production swaps them by config.
 */

// ── Identity: OIDC / Entra ID (§38) ─────────────────────────────────────────
// Production: OIDC (Authorization Code + PKCE) against Emirates' IdP; directory
// groups map to MIZAN roles. The judge profile uses the role switcher instead.

export interface OidcConfig {
  issuer: string;      // e.g. https://login.microsoftonline.com/<tenant>/v2.0
  clientId: string;
  clientSecret: string; // vault-injected; never in the repo
  redirectUri: string;
  scopes: string[];
}

export const OIDC_STUB: OidcConfig = {
  issuer: process.env.OIDC_ISSUER ?? "stub://local",
  clientId: process.env.OIDC_CLIENT_ID ?? "mizan-sandbox",
  clientSecret: "stub (vault-injected in production)",
  redirectUri: "/api/v1/auth/callback",
  scopes: ["openid", "profile", "email", "groups"],
};

/** Maps directory groups to MIZAN roles (production logic; identity stub here). */
export function mapGroupsToRoles(groups: string[]): string {
  if (groups.includes("SG-MIZAN-ADMIN")) return "admin";
  if (groups.includes("SG-MIZAN-COMPLIANCE-LEAD")) return "compliance_lead";
  if (groups.includes("SG-MIZAN-TEAM-LEAD")) return "team_lead";
  if (groups.includes("SG-MIZAN-AUDIT")) return "auditor";
  return "analyst";
}

// ── Object storage: S3/MinIO with object lock (WORM) ────────────────────────

export interface ObjectStore {
  put(key: string, body: Uint8Array, opts?: { immutability?: "worm" }): Promise<{ etag: string }>;
  get(key: string): Promise<Uint8Array | null>;
  head(key: string): Promise<{ size: number } | null>;
}

/** Local-filesystem adapter (sandbox). Swap for S3-compatible client in production. */
export class LocalObjectStore implements ObjectStore {
  private root = process.env.OBJECT_STORE_ROOT ?? ".data/objects";
  async put(key: string, body: Uint8Array): Promise<{ etag: string }> {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const path = join(this.root, key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    const { createHash } = await import("node:crypto");
    return { etag: createHash("sha256").update(body).digest("hex").slice(0, 32) };
  }
  async get(key: string): Promise<Uint8Array | null> {
    try {
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      return new Uint8Array(readFileSync(join(this.root, key)));
    } catch {
      return null; // not-found is a normal outcome, not an error
    }
  }
  async head(key: string): Promise<{ size: number } | null> {
    try {
      const { statSync } = await import("node:fs");
      const { join } = await import("node:path");
      return { size: statSync(join(this.root, key)).size };
    } catch {
      return null;
    }
  }
}

export const objectStore: ObjectStore = new LocalObjectStore();

// ── Notification channels: email / webhook / Teams ──────────────────────────

export interface NotifyChannel {
  name: string;
  send(message: { to: string; subject: string; body: string }): Promise<{ ok: boolean; error?: string }>;
}

/** Email channel stub — production: SMTP or Microsoft Graph (severity + sign-on link only, never personal data). */
export const emailChannel: NotifyChannel = {
  name: "email",
  async send() {
    return { ok: false, error: "stub: notifications.email.enabled=false in the sandbox; outbox viewer shows messages instead" };
  },
};

/** Webhook channel stub — receivers deduplicate by event ID; retries carry the same ID. */
export const webhookChannel: NotifyChannel = {
  name: "webhook",
  async send() {
    return { ok: false, error: "stub: notifications.webhook.enabled=false in the sandbox" };
  },
};

// ── Cache: Valkey-compatible non-authoritative cache ────────────────────────
// NON-NEGOTIABLE #18: caches are never authoritative. With the cache OFF the
// product is correct (chaos-tested by disabling via CACHE_DISABLED=true).

export interface CacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  incr(key: string): Promise<number>;
}

class MemoryCache implements CacheClient {
  private store = new Map<string, { value: string; expires: number }>();
  async get(key: string): Promise<string | null> {
    if (process.env.CACHE_DISABLED === "true") return null;
    const hit = this.store.get(key);
    if (!hit) return null;
    if (hit.expires < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return hit.value;
  }
  async set(key: string, value: string, ttlSeconds = 30): Promise<void> {
    if (process.env.CACHE_DISABLED === "true") return;
    this.store.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
  }
  async incr(key: string): Promise<number> {
    const cur = parseInt((await this.get(key)) ?? "0", 10) + 1;
    await this.set(key, String(cur), 60);
    return cur;
  }
}

export const cache: CacheClient = new MemoryCache(); // swap for Valkey client in production
