import { withApiRoute, json } from "@/lib/server/api";
import { db } from "@/lib/db";
import { randomUUID } from "node:crypto";
import { sha256Json } from "@/lib/domain/canonical";

/** Draft specs carry the engine-required fields so backtests never 500. */
function completeDraftSpec(spec: Record<string, unknown>, text: string): Record<string, unknown> {
  return {
    effective: { from: "2025-01-01", to: null, dateBasis: "effective_date" },
    source: { document: "rule-studio", anchor: "RNEW", text, sha256: sha256Json({ text }) },
    routing: { process: "*" },
    action: { template: "CA-AL-01" },
    explain: { template: "EX-DRAFT" },
    ...spec,
  };
}

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/rules/drafts — plain English → draft spec (deterministic grammar).
 * With the model off (ai.mode=none), the controlled grammar and guided builder
 * still create the same rule (§19.8). Ambiguity chips surface unresolved readings.
 */
export const POST = withApiRoute(async ({ req, actor }) => {
  if (!["policy_author", "admin", "compliance_lead"].includes(actor.role)) {
    return json({ code: "MZ-AUTH-403", title: "Only a policy author drafts rules" }, 403);
  }
  const body = (await req.json()) as { text?: string; guided?: { family: string; transactionType: string; threshold?: string; unitGrade?: number; windowDays?: number; max?: number; maxDays?: number } };
  const id = `draft-${randomUUID().slice(0, 8)}`;

  if (body.guided) {
    const g = body.guided;
    const draft = {
      id, plainEnglish: body.text ?? `${g.transactionType} rule (${g.family})`, status: "draft", author: actor.id,
      spec: completeDraftSpec(buildGuidedSpec(g), body.text ?? `${g.transactionType} rule (${g.family})`), ambiguities: [],
    };
    await db.ruleDraft.create({
      data: { id, plainEnglish: draft.plainEnglish, specJson: JSON.stringify(draft.spec), ambiguitiesJson: "[]", status: "draft", author: actor.id },
    });
    return json(draft, 201);
  }

  const parsedRaw = parsePlainEnglish(body.text ?? "");
  const parsed = { ...parsedRaw, spec: parsedRaw.spec ? completeDraftSpec(parsedRaw.spec, body.text ?? "") : null };
  await db.ruleDraft.create({
    data: {
      id, plainEnglish: body.text ?? "", specJson: parsed.spec ? JSON.stringify(parsed.spec) : null,
      ambiguitiesJson: JSON.stringify(parsed.ambiguities), status: "draft", author: actor.id,
    },
  });
  return json({ id, ...parsed }, 201);
});

export const GET = withApiRoute(async () => {
  const drafts = await db.ruleDraft.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
  return json({ items: drafts.map((d) => ({ id: d.id, plainEnglish: d.plainEnglish, spec: d.specJson ? JSON.parse(d.specJson) : null, ambiguities: d.ambiguitiesJson ? JSON.parse(d.ambiguitiesJson) : [], status: d.status, author: d.author, backtest: d.backtestJson ? JSON.parse(d.backtestJson) : null })) });
});

interface Ambiguity { chip: string; options: string[]; chosen: string | null; note: string }

export interface ParsedDraft {
  spec: Record<string, unknown> | null;
  ambiguities: Ambiguity[];
  understood: boolean;
  note: string;
}

/** Deterministic grammar for the most common policy phrasings (no model needed). */
export function parsePlainEnglish(text: string): ParsedDraft {
  const t = text.toLowerCase();
  const ambiguities: Ambiguity[] = [];
  const typeMatch = /allowance/.test(t) ? "ALLOWANCE_CHANGE" : /pay|salary/.test(t) ? "PAY_CHANGE" : null;
  const amountMatch = /(?:aed\s*)?([\d,]+(?:\.\d+)?)\s*(?:aed|dirhams?)?/.exec(t.replace(/grade|day/g, ""));
  const gradeMatch = /grade\s+(\d+)/.exec(t);
  const daysMatch = /(\d+)\s*(?:calendar\s*|business\s*)?days/.exec(t);
  const withinMatch = /within\s+(\d+)\s*days/.exec(t);

  if (typeMatch && amountMatch && /approved|approval/.test(t)) {
    const comparator = /\bat least|or above|or more\b/.test(t) ? "gte" : "gt";
    ambiguities.push({ chip: "comparator", options: [">", "≥"], chosen: comparator === "gt" ? ">" : "≥", note: "“above” is strictly greater; “at least / or above” is inclusive (ADR-0002)" });
    ambiguities.push({ chip: "quantifier", options: ["any", "all"], chosen: /all approvers/.test(t) ? "all" : "any", note: "whether one qualifying approver is enough" });
    const thresholdFils = Math.round(parseFloat(amountMatch[1]!.replace(/,/g, "")) * 100);
    const grade = gradeMatch ? parseInt(gradeMatch[1]!, 10) : null;
    if (!grade) return { spec: null, ambiguities: [...ambiguities, { chip: "grade", options: [], chosen: null, note: "which grade is required?" }], understood: false, note: "Add the required approver grade." };
    return {
      understood: true,
      ambiguities,
      note: "Parsed with the controlled grammar; the interpretation card renders the spec back in plain English.",
      spec: {
        id: "RNEW", title: text.slice(0, 80), family: "approval_limit", version: "0.1.0-draft",
        scope: { transactionTypes: [typeMatch], where: { all: [{ fact: "txn.amount_fils", op: comparator, value: thresholdFils }] } },
        check: { kind: "approval_limit", params: { minApproverGrade: grade, quantifier: "any", allowDelegates: false } },
        severity: { base: "HIGH", modifiers: ["magnitude_over_limit", "exposure_50k"] },
        clauses: [{ id: "C1", text }],
        tests: [
          { name: "at_boundary", given: { amount: (thresholdFils / 100).toFixed(2), approver_grades: [grade - 1] }, expect: comparator === "gt" ? "NOT_APPLICABLE" : "FAIL" },
          { name: "just_over", given: { amount: ((thresholdFils + 1) / 100).toFixed(2), approver_grades: [grade - 1] }, expect: "FAIL" },
          { name: "qualifying_approver", given: { amount: ((thresholdFils * 2) / 100).toFixed(2), approver_grades: [grade] }, expect: "PASS" },
        ],
      },
    };
  }
  if (typeMatch && /backdat/.test(t) && daysMatch) {
    return {
      understood: true, ambiguities: [{ chip: "basis", options: ["calendar", "business"], chosen: /business/.test(t) ? "business" : "calendar", note: "calendar days unless the rule says business days" }],
      note: "Parsed as a timing window.",
      spec: {
        id: "RNEW", title: text.slice(0, 80), family: "timing_window", version: "0.1.0-draft",
        scope: { transactionTypes: ["HIRE", "PAY_CHANGE", "ALLOWANCE_CHANGE", "TRANSFER", "LEAVE", "EXIT"] },
        check: { kind: "timing_window", params: { fromFact: "effectiveDate", toFact: "submittedDate", maxDays: parseInt(daysMatch[1]!, 10), basis: "calendar", inclusive: true } },
        severity: { base: "MEDIUM", modifiers: ["backdate_90d_high"] },
        clauses: [{ id: "C1", text }], tests: [],
      },
    };
  }
  if (typeMatch && withinMatch && /more than|at most/.test(t)) {
    return {
      understood: true, ambiguities: [],
      note: "Parsed as an aggregate limit.",
      spec: {
        id: "RNEW", title: text.slice(0, 80), family: "aggregate_limit", version: "0.1.0-draft",
        scope: { transactionTypes: [typeMatch] },
        check: { kind: "aggregate_limit", params: { windowDays: parseInt(withinMatch[1]!, 10) * 30, metric: "count", max: /at most (\d+)/.exec(t) ? parseInt(/at most (\d+)/.exec(t)![1]!, 10) : 2, groupBy: "employee", anchor: "effectiveDate" } },
        severity: { base: "MEDIUM", modifiers: [] },
        clauses: [{ id: "C1", text }], tests: [],
      },
    };
  }
  return {
    spec: null,
    ambiguities: [{ chip: "family", options: ["approval_limit", "timing_window", "aggregate_limit", "required_documents"], chosen: null, note: "use the guided builder to pick the family and fill parameters" }],
    understood: false,
    note: "The controlled grammar could not parse this sentence. Use the guided builder (same result, no code) or resolve the ambiguity chips.",
  };
}

function buildGuidedSpec(g: { family: string; transactionType: string; threshold?: string; unitGrade?: number; windowDays?: number; max?: number; maxDays?: number }): Record<string, unknown> {
  if (g.family === "approval_limit") {
    const fils = Math.round(parseFloat((g.threshold ?? "0").replace(/,/g, "")) * 100);
    return {
      id: "RNEW", family: "approval_limit", version: "0.1.0-draft",
      scope: { transactionTypes: [g.transactionType], where: { all: [{ fact: "txn.amount_fils", op: "gt", value: fils }] } },
      check: { kind: "approval_limit", params: { minApproverGrade: g.unitGrade ?? 13, quantifier: "any", allowDelegates: false } },
      severity: { base: "HIGH", modifiers: ["magnitude_over_limit"] },
      clauses: [{ id: "C1", text: `Any ${g.transactionType.toLowerCase()} above AED ${(fils / 100).toLocaleString("en-US")} must be approved by someone at grade ${g.unitGrade ?? 13} or above.` }],
      tests: [
        { name: "at_boundary", given: { amount: (fils / 100).toFixed(2), approver_grades: [(g.unitGrade ?? 13) - 1] }, expect: "NOT_APPLICABLE" },
        { name: "just_over", given: { amount: ((fils + 1) / 100).toFixed(2), approver_grades: [(g.unitGrade ?? 13) - 1] }, expect: "FAIL" },
        { name: "qualifying_approver", given: { amount: ((fils * 2) / 100).toFixed(2), approver_grades: [g.unitGrade ?? 13] }, expect: "PASS" },
      ],
    };
  }
  if (g.family === "timing_window") {
    return {
      id: "RNEW", family: "timing_window", version: "0.1.0-draft",
      scope: { transactionTypes: [g.transactionType] },
      check: { kind: "timing_window", params: { fromFact: "effectiveDate", toFact: "submittedDate", maxDays: g.maxDays ?? 30, basis: "calendar", inclusive: true } },
      severity: { base: "MEDIUM", modifiers: ["backdate_90d_high"] },
      clauses: [{ id: "C1", text: `A ${g.transactionType.toLowerCase()} must not be backdated by more than ${g.maxDays ?? 30} days.` }],
      tests: [],
    };
  }
  return {
    id: "RNEW", family: "aggregate_limit", version: "0.1.0-draft",
    scope: { transactionTypes: [g.transactionType] },
    check: { kind: "aggregate_limit", params: { windowDays: g.windowDays ?? 365, metric: "count", max: g.max ?? 2, groupBy: "employee", anchor: "effectiveDate" } },
    severity: { base: "MEDIUM", modifiers: [] },
    clauses: [{ id: "C1", text: `At most ${g.max ?? 2} ${g.transactionType.toLowerCase()} changes per employee in ${g.windowDays ?? 365} days.` }],
    tests: [],
  };
}
