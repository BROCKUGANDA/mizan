import { execSync } from "node:child_process";

export default function setup(): void {
  execSync("bunx prisma db push --skip-generate --force-reset", {
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: "file:../db/test.db" },
  });
}
