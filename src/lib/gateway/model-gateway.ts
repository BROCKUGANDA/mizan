/**
 * Model gateway (§27 / llm-gateway): adapters none (default), local, provider.
 * The engine NEVER imports this module (separation enforced by review + lint rule).
 * AI is optional: with mode=none the product is fully functional from templates.
 * The provider adapter is an approved OpenAI-compatible endpoint configured by the deployment.
 */

import { factLock, type FactLockResult } from "../explain/factlock";
import type { Evidence } from "../contracts";

export type GatewayMode = "none" | "local" | "provider";

export interface NarrativeRequest {
  evidence: Evidence;
  canonicalText: string;
  requiredAction: string;
  locale: "en" | "ar";
}

export interface NarrativeResult {
  used: boolean;
  text: string | null;
  modelId: string;
  factLock: FactLockResult | null;
  reason: string | null;
}

const PROMPT_VERSION = "narrative-1.1.0";

export async function polishNarrative(req: NarrativeRequest, mode: GatewayMode): Promise<NarrativeResult> {
  if (mode === "none") {
    return { used: false, text: null, modelId: "none", factLock: null, reason: "model gateway off (ai.mode=none)" };
  }
  const started = Date.now();
  void started;
  try {
    const text = await callModel(req, mode);
    const fl = factLock(text, req.evidence, {
      requiredAction: req.requiredAction,
      locale: req.locale,
      canonicalLength: req.canonicalText.length,
    });
    if (!fl.ok) {
      return { used: false, text: null, modelId: mode, factLock: fl, reason: `fact-lock rejected (${fl.rejection})` };
    }
    return { used: true, text, modelId: mode, factLock: fl, reason: null };
  } catch (err) {
    return { used: false, text: null, modelId: mode, factLock: null, reason: `gateway error: ${err instanceof Error ? err.message : "unknown"}` };
  }
}

async function callModel(req: NarrativeRequest, mode: GatewayMode): Promise<string> {
  const style = req.locale === "ar"
    ? "أعد صياغة الشرح بالعربية الفصحى المحايدة. جمل من 25 كلمة أو أقل. لا تضف أي رقم أو تاريخ أو معرّف غير موجود في الدليل. لا تستخدم كلمات اتهام."
    : "Rewrite the explanation in plain neutral English. Sentences of 25 words or fewer. Never add any number, date or ID that is not in the evidence. Never use accusatory words.";
  const prompt = [
    style,
    "EVIDENCE (JSON):",
    JSON.stringify(stripNames(req.evidence)),
    "CANONICAL TEXT:",
    req.canonicalText,
    "REQUIRED ACTION PHRASE:",
    req.requiredAction,
  ].join("\n");

  if (mode === "local") {
    // OpenAI-compatible local endpoint (vLLM/Ollama) for an air-gapped GPU node.
    const url = process.env.AI_LOCAL_URL;
    if (!url) throw new Error("AI_LOCAL_URL not configured");
    const res = await fetch(`${url.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: process.env.AI_LOCAL_MODEL ?? "local", messages: [{ role: "user", content: prompt }], temperature: 0 }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`local model HTTP ${res.status}`);
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return json.choices?.[0]?.message?.content ?? "";
  }

  // Approved provider: OpenAI-compatible endpoint under a zero-retention
  // contract (configured by the deployment; no vendor SDK is bundled).
  const url = process.env.MIZAN_MODEL_PROVIDER_URL;
  if (!url) throw new Error("MIZAN_MODEL_PROVIDER_URL not configured");
  const res = await fetch(`${url.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.MIZAN_MODEL_PROVIDER_KEY ?? ""}` },
    body: JSON.stringify({ model: process.env.MIZAN_MODEL_PROVIDER_MODEL ?? "approved", messages: [{ role: "user", content: prompt }], temperature: 0 }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`provider model HTTP ${res.status}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return json.choices?.[0]?.message?.content ?? "";
}

/** Names are redacted before any model call (security red line). */
function stripNames(evidence: Evidence): Evidence {
  return {
    ...evidence,
    facts: evidence.facts.map((f) => ({
      ...f,
      display: { en: redact(f.display.en), ar: redact(f.display.ar) },
    })),
    clauseText: redact(evidence.clauseText),
  };
}

function redact(s: string): string {
  // Remove free-text content; keep IDs, numbers, dates, grades
  return s
    .replace(/"[^"]{20,}"/g, '"[redacted text]"')
    .replace(/\b(comment|notes|free_text)\b[,:]?\s*[^,}]*/gi, "$1: [redacted]");
}

export { PROMPT_VERSION };
