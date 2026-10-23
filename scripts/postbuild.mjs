import { cpSync, existsSync, mkdirSync } from "node:fs";

if (existsSync(".next/standalone")) {
  mkdirSync(".next/standalone/.next", { recursive: true });
  if (existsSync(".next/static")) cpSync(".next/static", ".next/standalone/.next/static", { recursive: true });
  if (existsSync("public")) cpSync("public", ".next/standalone/public", { recursive: true });
}
