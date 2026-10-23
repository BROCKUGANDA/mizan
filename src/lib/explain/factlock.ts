/**
 * Fact-lock (FS-14): every number, date and ID in model text must exist in the
 * evidence; banned terms rejected; rule ID and action required. On any failure
 * the canonical text is shown and the rejection reason logged.
 */

import type { Evidence } from "../contracts";

export type FactLockRejection =
  | "FL-NUM" | "FL-DATE" | "FL-ID" | "FL-RULE" | "FL-ACTION" | "FL-BANNED" | "FL-LENGTH" | "FL-LOCALE" | "FL-SCHEMA";

export interface FactLockResult {
  ok: boolean;
  rejection?: FactLockRejection;
  detail?: string;
}

const BANNED_EN = /\b(fraud|fraudulent|deliberate|deliberately|negligent|negligence|suspicious)\b/i;
const BANNED_AR = /(احتيال|متعمد|اهمال|إهمال|مشبوه)/;

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const toAsciiDigits = (s: string): string => s.replace(/[٠-٩]/g, (d) => String(ARABIC_INDIC.indexOf(d)));

export function factLock(
  text: string,
  evidence: Evidence,
  opts: { requiredAction: string; locale: "en" | "ar"; canonicalLength: number }
): FactLockResult {
  // 1. Build the allowed token set from the evidence
  const allowed = new Set<string>();
  const add = (v: unknown): void => {
    if (v === null || v === undefined) return;
    const s = String(v);
    allowed.add(s);
    allowed.add(s.replace(/,/g, ""));
  };
  for (const f of evidence.facts) {
    add(f.display.en);
    add(f.display.ar);
    add(f.value);
  }
  add(evidence.ruleId);
  add(evidence.ruleVersion);
  add(evidence.clauseId);
  for (const rel of evidence.relatedTxnIds) add(rel);
  for (const c of evidence.caveats) { add(c.message.en); add(c.message.ar); }
  // dates in every display format from fact values
  for (const f of evidence.facts) {
    if (typeof f.value === "string" && /^\d{4}-\d{2}-\d{2}/.test(f.value)) add(f.value.slice(0, 10));
  }
  // action parameters (all numeric tokens inside the required action are allowed)
  for (const m of opts.requiredAction.matchAll(/\d[\d,.]*/g)) add(m[0]);

  // 2. Tokenise numbers, money, dates and ID-like strings
  const tokens: string[] = [];
  for (const m of text.matchAll(/\b[A-Z]{1,4}-?\d{2,}[A-Z0-9#]*\b|\b\d[\d,.]*\b|\b\d{4}-\d{2}-\d{2}\b/g)) tokens.push(m[0]);
  for (const m of toAsciiDigits(text).matchAll(/\b\d[\d,.]*\b/g)) tokens.push(m[0]);

  // 3. Checks
  if (!text.includes(evidence.ruleId)) return { ok: false, rejection: "FL-RULE", detail: `rule id ${evidence.ruleId} missing` };
  if (!text.includes(opts.requiredAction.slice(0, 24))) return { ok: false, rejection: "FL-ACTION", detail: "action missing" };
  if (BANNED_EN.test(text) || BANNED_AR.test(text)) return { ok: false, rejection: "FL-BANNED", detail: "accusatory term" };
  const words = text.split(/\s+/).filter(Boolean);
  // The canonical text may be long; fact-lock bounds only runaway model output.
  if (text.length > opts.canonicalLength * 1.5 + 200) return { ok: false, rejection: "FL-LENGTH", detail: `${words.length} words, ${text.length} chars` };
  const hasArabic = /[\u0600-\u06FF]/.test(text);
  if (opts.locale === "ar" && !hasArabic) return { ok: false, rejection: "FL-LOCALE", detail: "no Arabic script" };
  if (opts.locale === "en" && hasArabic && text.length < 40) return { ok: false, rejection: "FL-LOCALE", detail: "mostly Arabic for en request" };
  for (const t of tokens) {
    const bare = t.replace(/[,.]$/, "");
    if (!allowed.has(t) && !allowed.has(bare) && !allowed.has(bare.replace(/,/g, ""))) {
      // numbers that appear inside allowed strings (e.g. "14,500.00" inside "AED 14,500.00")
      const bareDigits = bare.replace(/,/g, "");
      let found = false;
      for (const a of allowed) {
        if (typeof a === "string" && (a.includes(bareDigits) || a.includes(bare))) { found = true; break; }
      }
      if (!found) return { ok: false, rejection: "FL-NUM", detail: `token ${t} not in evidence` };
    }
  }
  return { ok: true };
}
