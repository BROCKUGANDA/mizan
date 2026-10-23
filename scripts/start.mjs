import { spawn } from "node:child_process";
import { resolve } from "node:path";

// Next standalone runs with a different cwd; make the seed database and
// object store paths explicit instead of resolving .env relative to the bundle.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = `file:${resolve("db/custom.db").replace(/\\/g, "/")}`;
}
if (!process.env.MIZAN_OBJECT_DIR) {
  process.env.MIZAN_OBJECT_DIR = resolve("data/objects");
}

const child = spawn(process.execPath, [".next/standalone/server.js"], { stdio: "inherit", env: process.env });
child.on("exit", (code) => process.exit(code ?? 1));
