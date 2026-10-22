/**
 * Canonical JSON (RFC 8785-compatible subset) + SHA-256 helpers.
 * Pure, deterministic, shared by engine / audit / manifest / export.
 * NON-NEGOTIABLE #3: same inputs → byte-identical output and the same hash.
 */

/** Deterministic stringify: objects sorted by key, no undefined. */
export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) throw new Error("MZ-INT-500: non-finite number in canonical JSON");
    return String(n);
  }
  if (t === "boolean") return value ? "true" : "false";
  if (t === "string") return JSON.stringify(value as string);
  if (Array.isArray(value)) {
    let out = "[";
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out += ",";
      out += canonicalize(value[i]);
    }
    return out + "]";
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    let out = "{";
    for (let i = 0; i < keys.length; i++) {
      if (i > 0) out += ",";
      out += JSON.stringify(keys[i]) + ":" + canonicalize(obj[keys[i]]);
    }
    return out + "}";
  }
  throw new Error(`MZ-INT-500: unsupported type in canonical JSON: ${t}`);
}

/** SHA-256 of a UTF-8 string → lowercase hex (sync, Node runtime). */
export function sha256(input: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeCrypto = require("node:crypto") as typeof import("node:crypto");
  return nodeCrypto.createHash("sha256").update(input, "utf8").digest("hex");
}

export function sha256Json(value: unknown): string {
  return sha256(canonicalJson(value));
}

/** Crockford base32 display ID from a hex digest, first n chars (e.g. F-XXXXXXXXXXXX). */
export function crockfordFromHex(hex: string, length = 12): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let out = "";
  let carry = 0;
  for (let i = 0; i < length; i++) {
    const a = parseInt(hex[i % hex.length] ?? "0", 16);
    const b = parseInt(hex[(i * 7 + 3) % hex.length] ?? "0", 16);
    const idx = (a ^ (b << 1) ^ carry) % 32;
    out += alphabet[idx];
    carry = (a + b) % 32;
  }
  return out;
}
