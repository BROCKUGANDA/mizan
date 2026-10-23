/**
 * Content-addressed local object store. This is the real store for the
 * single-host deployment; the production swap is an S3-compatible bucket with
 * object lock (WORM). Objects are immutable: a key is the SHA-256 of its bytes.
 */

import { mkdir, writeFile, readFile, access, constants } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sha256Bytes } from "../domain/canonical";

const ROOT = resolve(process.env.MIZAN_OBJECT_DIR ?? "data/objects");

export async function putObject(bytes: Uint8Array): Promise<{ sha256: string; key: string; deduplicated: boolean }> {
  const hash = sha256Bytes(bytes);
  const key = `${hash.slice(0, 2)}/${hash}`;
  const path = join(ROOT, key);
  await mkdir(join(ROOT, hash.slice(0, 2)), { recursive: true });
  try {
    await access(path, constants.F_OK);
    return { sha256: hash, key, deduplicated: true };
  } catch {
    await writeFile(path, bytes, { flag: "wx" });
    return { sha256: hash, key, deduplicated: false };
  }
}

export async function getObject(key: string): Promise<Uint8Array> {
  const path = join(ROOT, key);
  if (!path.startsWith(ROOT)) throw new Error("object key escapes the store root");
  return readFile(path);
}

export async function objectStoreHealth(): Promise<{ ok: boolean; detail: string }> {
  try {
    await mkdir(ROOT, { recursive: true });
    const probe = join(ROOT, ".health");
    await writeFile(probe, new Date().toISOString());
    await readFile(probe, "utf8");
    return { ok: true, detail: `content-addressed store at ${ROOT}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "object store unavailable" };
  }
}
