import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function engineSources(): { name: string; content: string }[] {
  const dir = join(process.cwd(), "src", "lib", "engine");
  return readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => ({ name: f, content: readFileSync(join(dir, f), "utf8") }));
}

describe("engine separation", () => {
  it("imports no model, network, clock or randomness", () => {
    const forbidden = [/from ["'][^"']*(gateway|llm|model|integrations)[^"']*["']/, /\bfetch\s*\(/, /\bDate\.now\s*\(/, /\bnew Date\s*\(\s*\)/, /\bMath\.random\s*\(/, /\bprocess\.env/];
    for (const source of engineSources()) {
      for (const pattern of forbidden) {
        expect(pattern.test(source.content), `${source.name} matches ${pattern}`).toBe(false);
      }
    }
  });

  it("does not import the HTTP, database or gateway layers", () => {
    for (const source of engineSources()) {
      expect(source.content, source.name).not.toMatch(/@\/lib\/(server|db|gateway|integrations)/);
    }
  });
});
