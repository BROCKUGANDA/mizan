"use client";

/**
 * Rule studio (§19): every written policy sentence is accounted for; the verbatim
 * clause is the source of record. Plain-English drafting works with the model OFF
 * (controlled grammar + guided builder, §19.8); ambiguity chips surface unresolved
 * readings instead of guessing; backtest previews flood risk before activation;
 * two-person rule (FS-17) and shadow-first activation are enforced server-side.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Beaker,
  ChevronRight,
  CircleCheck,
  FlaskConical,
  FileText,
  Lightbulb,
  ListChecks,
  Loader2,
  Send,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { SeverityBadge, EmptyState, ErrorState, LoadingSkeleton, ShadowChip } from "@/components/mizan/primitives";
import { api, v1, useAppStore, ApiError } from "@/lib/client/store";
import { useI18n } from "@/lib/i18n/use-i18n";
import { cn } from "@/lib/utils";

/* ── contracts (mirror of the API payloads) ─────────────────────────────────── */

type Outcome = "PASS" | "FAIL" | "NOT_APPLICABLE" | "NOT_EVALUABLE";

interface RuleTest {
  name: string;
  given: Record<string, unknown>;
  expect: Outcome | `${Outcome}:${string}`;
}

interface DraftSpec {
  id: string;
  title?: string;
  family: string;
  version: string;
  status?: string;
  effective?: { from: string; to: string | null; dateBasis: "effective_date" | "run_date" };
  source?: { document: string; anchor: string; text: string; sha256: string };
  scope: { transactionTypes: string[]; where?: unknown };
  check: { kind: string; params: Record<string, unknown> };
  severity: { base: string; modifiers: string[] };
  routing?: { process: string };
  action?: { template: string };
  explain?: { template: string };
  clauses: { id: string; text: string }[];
  tests: RuleTest[];
}

interface Interpretation {
  ruleId: string;
  ambiguityChips: { chip: string; options: string[]; chosen: string }[];
  comparatorSemantics: { term: string; meaning: string }[];
  notes: { en: string; ar: string };
}

interface RuleApproval {
  ruleId: string;
  version: string;
  approver: string;
  decision: string;
  reason: string | null;
  createdAt: string;
}

interface RuleItem {
  id: string;
  title: string;
  family: string;
  version: string;
  status: string;
  verbatimText: string;
  anchor: string;
  textSha256: string;
  spec: DraftSpec;
  interpretation: Interpretation | null;
  baseSeverity: string;
  routingProcess: string | null;
  actionTemplate: string | null;
  effectiveFrom: string;
  approvals: RuleApproval[];
}

interface Coverage {
  packVersion: string;
  compiled: { anchor: string; family: string; status: string }[];
  definitions: { anchor: string; status: string; usedBy?: string[] }[];
  scopeNotes: { anchor: string; status: string }[];
  attestations: { anchor: string; status: string; note?: string }[];
  total: number;
}

interface Ambiguity {
  chip: string;
  options: string[];
  chosen: string | null;
  note: string;
}

interface ParseResponse {
  id: string;
  understood?: boolean;
  note?: string;
  ambiguities: Ambiguity[];
  spec: DraftSpec | null;
}

interface BacktestResult {
  wouldFlag: number;
  transactionCount: number;
  rate: number;
  floodRisk: "low" | "medium" | "high";
  overlap: { ruleId: string; count: number; jaccard: number }[];
  sample: { txnId: string; employeeId: string; type: string; amountFils: number | null; effectiveDate: string }[];
  monthly: Record<string, number>;
}

const EXAMPLES = [
  "Any allowance change above AED 10,000 must be approved by someone at grade 13 or above.",
  "A hire must not be backdated by more than 30 days.",
  "No more than 2 allowance changes per employee within 3 months.",
];

const FAMILIES = ["approval_limit", "timing_window", "aggregate_limit"] as const;
const TXN_TYPES = ["HIRE", "PAY_CHANGE", "ALLOWANCE_CHANGE", "TRANSFER", "LEAVE", "EXIT"] as const;

const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** api() declares `body` via `RequestInit & { body?: unknown }` — the intersection collapses to
 * BodyInit, so JSON payloads go through this adapter (api() JSON-encodes them itself). */
function postJson<T>(path: string, payload: unknown, headers: Record<string, string> = {}): Promise<T> {
  return api<T>(path, { method: "POST", body: payload as BodyInit, headers });
}

const fmtAed = (fils: number | null, iso: (v: string) => string): string =>
  fils === null ? "—" : iso(`AED ${(fils / 100).toLocaleString("en-US")}`);

const fmtTime = (s: string | Date | null | undefined, locale: string): string => {
  if (!s) return "—";
  const d = typeof s === "string" ? new Date(s) : s;
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(locale === "ar" ? "ar-AE" : "en-GB", { dateStyle: "medium", timeStyle: "short" });
};

/** Expect badge for generated tests: PASS ok / FAIL high / NOT_APPLICABLE muted / NOT_EVALUABLE hold. */
function ExpectBadge({ expect }: { expect: string }) {
  const raw = expect.split(":")[0] as Outcome;
  const styles: Record<Outcome, string> = {
    PASS: "border-ok/40 bg-ok/10 text-foreground",
    FAIL: "border-sev-high/40 bg-sev-high/10 text-sev-high",
    NOT_APPLICABLE: "border-border bg-secondary text-muted-foreground",
    NOT_EVALUABLE: "border-hold/40 bg-hold/10 text-foreground",
  };
  const label: Record<Outcome, string> = {
    PASS: "PASS",
    FAIL: "FAIL",
    NOT_APPLICABLE: "N/A",
    NOT_EVALUABLE: "HOLD",
  };
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium", styles[raw] ?? styles.NOT_APPLICABLE)}>
      {label[raw] ?? expect}
    </span>
  );
}

/** Interpretation card shared by compiled rules and fresh drafts. */
function InterpretationCard({
  title,
  understood,
  note,
  ambiguities,
  comparatorSemantics,
  notes,
  locale,
}: {
  title: string;
  understood?: boolean;
  note?: string;
  ambiguities: { chip: string; options: string[]; chosen: string | null; note?: string }[];
  comparatorSemantics: { term: string; meaning: string }[];
  notes: { en: string; ar: string } | null;
  locale: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Lightbulb className="h-4 w-4 text-brand" aria-hidden />
          {title}
          {understood !== undefined ? (
            understood ? (
              <Badge className="border-ok/40 bg-ok/10 text-foreground" variant="outline">
                <CircleCheck className="h-3 w-3" aria-hidden /> Understood
              </Badge>
            ) : (
              <Badge className="border-hold/40 bg-hold/10 text-foreground" variant="outline">
                <TriangleAlert className="h-3 w-3" aria-hidden /> Needs input
              </Badge>
            )
          ) : null}
        </CardTitle>
        {note ? <CardDescription>{note}</CardDescription> : null}
      </CardHeader>
      <CardContent className="space-y-3">
        {ambiguities.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Ambiguity chips — the chosen reading is highlighted, nothing is guessed:</p>
            <div className="flex flex-wrap gap-2">
              {ambiguities.map((a) => (
                <div key={a.chip} className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-muted-foreground">{a.chip}:</span>
                  {a.options.length > 0
                    ? a.options.map((opt) => (
                        <button
                          key={opt}
                          type="button"
                          disabled
                          aria-pressed={a.chosen === opt}
                          className={cn(
                            "rounded-full border px-2 py-0.5 font-mono text-[11px]",
                            a.chosen === opt
                              ? "border-primary/60 bg-primary/10 font-semibold text-primary"
                              : "border-dashed border-border bg-secondary text-muted-foreground"
                          )}
                        >
                          {opt}
                        </button>
                      ))
                    : null}
                  <span className="text-[11px] text-muted-foreground">{a.note ? `— ${a.note}` : ""}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {comparatorSemantics.length > 0 ? (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Comparator semantics:</p>
            {comparatorSemantics.map((c) => (
              <div key={c.term} className="flex items-baseline gap-2 text-xs">
                <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px]">{c.term}</span>
                <span aria-hidden>=</span>
                <span>{c.meaning}</span>
              </div>
            ))}
          </div>
        ) : null}
        {notes ? <p className="rounded-md bg-secondary px-3 py-2 text-xs text-muted-foreground">{locale === "ar" ? notes.ar : notes.en}</p> : null}
      </CardContent>
    </Card>
  );
}

/** Generated tests table (same shape for rules and drafts). */
function TestsTable({ tests }: { tests: RuleTest[] }) {
  if (!tests.length) {
    return <p className="px-1 text-xs text-muted-foreground">No generated tests for this family yet.</p>;
  }
  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[30%]">Test</TableHead>
            <TableHead>Given</TableHead>
            <TableHead className="w-[110px] text-end">Expect</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tests.map((tt) => (
            <TableRow key={tt.name}>
              <TableCell className="font-medium">{tt.name}</TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">{trunc(JSON.stringify(tt.given), 56)}</TableCell>
              <TableCell className="text-end">
                <ExpectBadge expect={tt.expect} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export default function RulesView() {
  const { t, locale, iso } = useI18n();
  const { actor } = useAppStore();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");
  const [guidedOpen, setGuidedOpen] = useState(false);
  const [guided, setGuided] = useState<{ family: string; transactionType: string; threshold: string; grade: string; maxDays: string; max: string }>({
    family: "approval_limit",
    transactionType: "ALLOWANCE_CHANGE",
    threshold: "10000",
    grade: "13",
    maxDays: "30",
    max: "2",
  });
  const [draft, setDraft] = useState<ParseResponse | null>(null);
  const [backtest, setBacktest] = useState<BacktestResult | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [backtestError, setBacktestError] = useState<string | null>(null);
  const [submitNote, setSubmitNote] = useState<string | null>(null);
  const [approveError, setApproveError] = useState<{ code: string; message: string } | null>(null);
  const [activateError, setActivateError] = useState<string | null>(null);

  const rulesQuery = useQuery<{ items: RuleItem[]; interpretations: Record<string, Interpretation>; coverage: Coverage; specCount: number }>({
    queryKey: ["rules"],
    queryFn: () => api(v1("/rules")),
  });

  const rules = rulesQuery.data?.items ?? [];
  const coverage = rulesQuery.data?.coverage;
  const selected = rules.find((r) => r.id === selectedId) ?? rules[0] ?? null;
  // Seed rows may store an empty interpretation record; the pack map is authoritative.
  const interpretations = rulesQuery.data?.interpretations ?? {};
  const selectedInterpretation: Interpretation | null = selected
    ? (Object.keys(interpretations[selected.id] ?? {}).length > 0
        ? interpretations[selected.id]!
        : selected.interpretation && Object.keys(selected.interpretation).length > 0
          ? selected.interpretation
          : null)
    : null;

  const roleQuery = useQuery<{ actors: { id: string; role: string }[] }>({
    queryKey: ["system-state", actor],
    queryFn: () => api(v1("/system/state")),
    staleTime: 30_000,
  });
  const role = roleQuery.data?.actors.find((a) => a.id === actor)?.role ?? null;
  const canApprove = role === "policy_approver" || role === "admin";
  const canDraft = role === "policy_author" || role === "admin" || role === "compliance_lead";

  const refetchRules = () => queryClient.invalidateQueries({ queryKey: ["rules"] });

  const transition = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      postJson<{ ok: boolean; status?: string; approvals?: number; note?: string }>(v1(`/rules/${id}/transition`), body, {
        "idempotency-key": crypto.randomUUID(),
      }),
  });

  const onApprove = (rule: RuleItem): void => {
    setApproveError(null);
    transition.mutate(
      { id: rule.id, body: { action: "approve" } },
      {
        onSuccess: () => refetchRules(),
        onError: (e) => {
          if (e instanceof ApiError) setApproveError({ code: e.code, message: e.message });
          else setApproveError({ code: "UNKNOWN", message: e.message });
        },
      }
    );
  };

  const onActivate = (rule: RuleItem, asShadow: boolean): void => {
    setActivateError(null);
    transition.mutate(
      { id: rule.id, body: { action: "activate", asShadow } },
      {
        onSuccess: () => refetchRules(),
        onError: (e) => setActivateError(e instanceof ApiError ? e.message : e.message),
      }
    );
  };

  const parseDraft = useMutation({
    mutationFn: (body: { text?: string; guided?: Record<string, unknown> }) =>
      postJson<ParseResponse>(v1("/rules/drafts"), body, { "idempotency-key": crypto.randomUUID() }),
  });

  const onParse = (): void => {
    setDraftError(null);
    setBacktest(null);
    setSubmitNote(null);
    const useGuided = guidedOpen && guided.family !== "";
    const body = useGuided
      ? {
          text: draftText || undefined,
          guided: {
            family: guided.family,
            transactionType: guided.transactionType,
            threshold: guided.threshold || undefined,
            unitGrade: guided.grade ? Number(guided.grade) : undefined,
            maxDays: guided.maxDays ? Number(guided.maxDays) : undefined,
            max: guided.max ? Number(guided.max) : undefined,
          },
        }
      : { text: draftText };
    parseDraft.mutate(body, {
      onSuccess: (d) => {
        setDraft({ ...d, understood: d.understood ?? d.spec !== null, note: d.note ?? "The guided builder produced a draft spec — review, backtest, then submit." });
      },
      onError: (e) => setDraftError(e instanceof ApiError ? `${e.message}` : e.message),
    });
  };

  const onBacktest = (): void => {
    if (!draft?.id || !draft.spec) return;
    setBacktestError(null);
    // The draft grammar returns the checkable core of a RuleSpec; the engine also
    // reads effective.from/dateBasis and source.anchor — fill pack defaults if absent.
    const spec: DraftSpec = {
      ...draft.spec,
      status: "draft",
      effective: draft.spec.effective ?? { from: "2025-01-01", to: null, dateBasis: "effective_date" },
      source: draft.spec.source ?? { document: "studio-draft", anchor: "studio", text: draft.spec.clauses[0]?.text ?? "", sha256: "" },
    };
    postJson<BacktestResult>(v1(`/rules/drafts/${draft.id}/backtest`), { spec }, {
      "idempotency-key": crypto.randomUUID(),
    })
      .then(setBacktest)
      .catch((e: unknown) => setBacktestError(e instanceof ApiError ? e.message : (e as Error).message));
  };

  const onSubmitDraft = (): void => {
    if (!draft?.id) return;
    setSubmitNote(null);
    setDraftError(null);
    postJson<{ ok: boolean; status: string }>(v1(`/rules/drafts/${draft.id}/transition`), { action: "submit" }, {
      "idempotency-key": crypto.randomUUID(),
    })
      .then((r) => setSubmitNote(`Submitted for approval (status: ${r.status}).`))
      .catch((e: unknown) => setDraftError(e instanceof ApiError ? e.message : (e as Error).message));
  };

  const monthlyBars = useMemo(() => {
    if (!backtest) return [];
    const entries = Object.entries(backtest.monthly).sort(([a], [b]) => a.localeCompare(b));
    const maxV = Math.max(1, ...entries.map(([, v]) => v));
    return entries.map(([month, v]) => ({ month, v, pct: Math.round((v / maxV) * 100) }));
  }, [backtest]);

  return (
    <div className="space-y-4" aria-label={t("nav.rules")}>
      <Tabs defaultValue="rules">
        <TabsList>
          <TabsTrigger value="rules">
            <ListChecks className="me-1.5 h-3.5 w-3.5" aria-hidden /> Rules
          </TabsTrigger>
          <TabsTrigger value="draft">
            <Sparkles className="me-1.5 h-3.5 w-3.5" aria-hidden /> Draft a rule
          </TabsTrigger>
        </TabsList>

        {/* ── Rules tab ─────────────────────────────────────────────────────── */}
        <TabsContent value="rules" className="mt-4 space-y-4">
          {rulesQuery.isLoading ? <LoadingSkeleton rows={6} /> : null}
          {rulesQuery.isError ? (
            <ErrorState message={(rulesQuery.error as Error).message} code={rulesQuery.error instanceof ApiError ? rulesQuery.error.code : undefined} onRetry={() => rulesQuery.refetch()} />
          ) : null}
          {rulesQuery.data ? (
            <div className="grid items-start gap-4 lg:grid-cols-[minmax(240px,320px)_1fr]">
              {/* Rule list */}
              <Card className="overflow-hidden">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Rule pack</CardTitle>
                  <CardDescription>
                    {rules.length} compiled {rules.length === 1 ? "rule" : "rules"} · every sentence accounted for
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <ScrollArea className="max-h-[70vh]">
                    <div className="flex flex-col">
                      {rules.map((r) => (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => {
                            setSelectedId(r.id);
                            setApproveError(null);
                            setActivateError(null);
                          }}
                          aria-current={selected?.id === r.id}
                          className={cn(
                            "flex items-start gap-2 border-b px-4 py-2.5 text-start text-sm transition-colors last:border-b-0 hover:bg-secondary",
                            selected?.id === r.id && "bg-secondary"
                          )}
                        >
                          <span className="mt-0.5 font-mono text-xs font-semibold text-primary">{r.id}</span>
                          <span className="flex-1 leading-snug">{r.title}</span>
                          {r.status === "shadow" ? (
                            <ShadowChip label="shadow" />
                          ) : (
                            <Badge variant="outline" className="shrink-0 border-border bg-secondary text-[11px] text-muted-foreground">
                              {r.status}
                            </Badge>
                          )}
                          <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                        </button>
                      ))}
                    </div>
                  </ScrollArea>
                </CardContent>
              </Card>

              {/* Selected rule detail */}
              {selected ? (
                <div className="space-y-4">
                  <Card>
                    <CardHeader className="pb-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm font-bold text-primary">{selected.id}</span>
                        <CardTitle className="text-base">{selected.title}</CardTitle>
                        <Badge variant="outline" className="border-border bg-secondary font-mono text-[11px]">
                          v{selected.version}
                        </Badge>
                        <Badge variant="outline" className="border-border bg-secondary font-mono text-[11px]">
                          {selected.family}
                        </Badge>
                        {selected.status === "shadow" ? <ShadowChip label="shadow — evaluates, never routes" /> : (
                          <Badge variant="outline" className="border-border bg-secondary text-[11px]">{selected.status}</Badge>
                        )}
                        <SeverityBadge severity={selected.baseSeverity as never} className="ms-auto" />
                      </div>
                      <CardDescription>
                        Anchor {selected.anchor} · sha256 {selected.textSha256.slice(0, 12)}… · effective {selected.effectiveFrom}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {/* Verbatim clause — source of record */}
                      <figure>
                        <figcaption className="mb-1 text-xs font-medium text-muted-foreground">Verbatim clause (source of record)</figcaption>
                        <blockquote className="border-s-4 border-primary/40 bg-secondary px-3 py-2 text-sm italic">
                          {selected.verbatimText}
                        </blockquote>
                      </figure>

                      <Separator />

                      <InterpretationCard
                        title="How MIZAN reads this rule"
                        ambiguities={selectedInterpretation?.ambiguityChips ?? []}
                        comparatorSemantics={selectedInterpretation?.comparatorSemantics ?? []}
                        notes={selectedInterpretation?.notes ?? null}
                        locale={locale}
                      />

                      {/* Scope & parameters */}
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="rounded-lg border p-3">
                          <p className="mb-2 text-xs font-medium text-muted-foreground">Scope — transaction types</p>
                          <div className="flex flex-wrap gap-1.5">
                            {selected.spec.scope.transactionTypes.map((tt) => (
                              <Badge key={tt} variant="outline" className="border-border bg-secondary font-mono text-[11px]">
                                {tt}
                              </Badge>
                            ))}
                          </div>
                          {selected.spec.scope.where ? (
                            <p className="mt-2 font-mono text-[11px] text-muted-foreground">{trunc(JSON.stringify(selected.spec.scope.where), 90)}</p>
                          ) : null}
                        </div>
                        <div className="rounded-lg border p-3">
                          <p className="mb-2 text-xs font-medium text-muted-foreground">
                            Parameters — {selected.spec.check.kind}
                          </p>
                          <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-x-3 gap-y-1">
                            {Object.entries(selected.spec.check.params).map(([k, v]) => (
                              <div key={k} className="col-span-2 grid grid-cols-subgrid items-baseline">
                                <dt className="text-xs text-muted-foreground">{k}</dt>
                                <dd className="truncate font-mono text-xs">{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
                              </div>
                            ))}
                          </dl>
                        </div>
                      </div>

                      {/* Generated tests */}
                      <div>
                        <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                          <FlaskConical className="h-3.5 w-3.5" aria-hidden /> Generated tests (executable examples from the spec)
                        </p>
                        <TestsTable tests={selected.spec.tests} />
                      </div>

                      {selected.routingProcess || selected.actionTemplate ? (
                        <p className="text-xs text-muted-foreground">
                          {selected.routingProcess ? (
                            <>
                              Routes to <span className="font-medium text-foreground">{selected.routingProcess}</span>.{" "}
                            </>
                          ) : null}
                          {selected.actionTemplate ? <>Action: {selected.actionTemplate}</> : null}
                        </p>
                      ) : null}

                      <Separator />

                      {/* Approvals + lifecycle */}
                      <div className="space-y-3">
                        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                          <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> Approvals &amp; lifecycle — two-person rule (author ≠ approver)
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          {selected.approvals.length === 0 ? (
                            <span className="text-xs text-muted-foreground">No approvals recorded yet.</span>
                          ) : (
                            selected.approvals.map((a) => (
                              <span key={`${a.ruleId}-${a.version}-${a.approver}`} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 py-1 text-xs">
                                <CircleCheck className={cn("h-3.5 w-3.5", a.decision === "approved" ? "text-ok" : "text-sev-high")} aria-hidden />
                                <span className="font-medium">{a.approver}</span>
                                <span className="text-muted-foreground">{a.decision}</span>
                                <span className="text-[10px] text-muted-foreground">{fmtTime(a.createdAt, locale)}</span>
                              </span>
                            ))
                          )}
                        </div>
                        {canApprove ? (
                          <Button size="sm" variant="outline" onClick={() => onApprove(selected)} disabled={transition.isPending}>
                            {transition.isPending ? <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : <ShieldCheck className="me-1.5 h-3.5 w-3.5" aria-hidden />}
                            Approve v{selected.version}
                          </Button>
                        ) : null}
                        {approveError ? (
                          <Alert
                            role="alert"
                            className={cn(
                              approveError.code === "MZ-RULE-403-SELF"
                                ? "border-sev-medium/50 bg-sev-medium/10 text-foreground"
                                : "border-destructive/40 bg-destructive/5 text-foreground"
                            )}
                          >
                            <TriangleAlert className="h-4 w-4 text-sev-medium" aria-hidden />
                            <AlertTitle>{approveError.code === "MZ-RULE-403-SELF" ? "Two-person rule" : "Cannot approve"}</AlertTitle>
                            <AlertDescription>{approveError.message}</AlertDescription>
                          </Alert>
                        ) : null}
                        <div className="flex flex-wrap items-center gap-2">
                          {selected.approvals.filter((a) => a.decision === "approved").length >= 1 && selected.status !== "active" && selected.status !== "retired" ? (
                            selected.status === "shadow" ? (
                              <Button size="sm" onClick={() => onActivate(selected, false)} disabled={transition.isPending}>
                                {transition.isPending ? <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Beaker className="me-1.5 h-3.5 w-3.5" aria-hidden />}
                                Go active
                              </Button>
                            ) : (
                              <Button size="sm" variant="outline" onClick={() => onActivate(selected, true)} disabled={transition.isPending}>
                                {transition.isPending ? <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Beaker className="me-1.5 h-3.5 w-3.5" aria-hidden />}
                                Activate (shadow first)
                              </Button>
                            )
                          ) : null}
                          {activateError ? (
                            <span className="text-xs text-destructive" role="alert">
                              {activateError}
                            </span>
                          ) : null}
                          {selected.status === "shadow" ? (
                            <span className="text-xs text-muted-foreground">Shadow mode: findings stored, nothing routes; the UI shows “would route to …”.</span>
                          ) : null}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              ) : (
                <EmptyState title="Select a rule" hint="Choose a rule from the pack to see its verbatim clause, interpretation and tests." icon={<FileText className="h-8 w-8" aria-hidden />} />
              )}
            </div>
          ) : null}
        </TabsContent>

        {/* ── Draft tab — plain English → spec without any model ────────────── */}
        <TabsContent value="draft" className="mt-4 space-y-4">
          {!canDraft ? (
            <Alert className="border-hold/40 bg-hold/10 text-foreground">
              <TriangleAlert className="h-4 w-4 text-hold" aria-hidden />
              <AlertTitle>Read-only for your role</AlertTitle>
              <AlertDescription>Drafting is available to a policy author, the compliance lead, or an administrator.</AlertDescription>
            </Alert>
          ) : null}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Draft a rule from plain English</CardTitle>
              <CardDescription>
                The controlled grammar parses the sentence deterministically — no model required (ai.mode=none still works). Ambiguities become chips, never guesses.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                value={draftText}
                onChange={(e) => setDraftText(e.target.value)}
                rows={3}
                aria-label="Policy sentence in plain English"
                placeholder={`e.g. ${EXAMPLES[0]}`}
              />
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">Try:</span>
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    type="button"
                    onClick={() => setDraftText(ex)}
                    className="rounded-full border border-dashed border-border bg-secondary px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-accent"
                  >
                    {trunc(ex, 42)}
                  </button>
                ))}
              </div>

              {/* Guided builder disclosure */}
              <Collapsible open={guidedOpen} onOpenChange={setGuidedOpen}>
                <CollapsibleTrigger asChild>
                  <Button type="button" variant="outline" size="sm" aria-expanded={guidedOpen}>
                    <ListChecks className="me-1.5 h-3.5 w-3.5" aria-hidden /> Guided builder
                    <span className="ms-1 text-[10px] text-muted-foreground">(same result, no code)</span>
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-3">
                  <div className="grid gap-3 rounded-lg border bg-secondary/40 p-3 sm:grid-cols-2 lg:grid-cols-3">
                    <div className="space-y-1">
                      <Label htmlFor="gb-family" className="text-xs">Family</Label>
                      <Select value={guided.family} onValueChange={(v) => setGuided((g) => ({ ...g, family: v }))}>
                        <SelectTrigger id="gb-family" size="sm"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {FAMILIES.map((f) => (
                            <SelectItem key={f} value={f}>{f}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="gb-type" className="text-xs">Transaction type</Label>
                      <Select value={guided.transactionType} onValueChange={(v) => setGuided((g) => ({ ...g, transactionType: v }))}>
                        <SelectTrigger id="gb-type" size="sm"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {TXN_TYPES.map((tt) => (
                            <SelectItem key={tt} value={tt}>{tt}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="gb-threshold" className="text-xs">Threshold (AED)</Label>
                      <Input id="gb-threshold" inputMode="decimal" value={guided.threshold} onChange={(e) => setGuided((g) => ({ ...g, threshold: e.target.value }))} placeholder="10000" />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="gb-grade" className="text-xs">Minimum approver grade</Label>
                      <Input id="gb-grade" inputMode="numeric" value={guided.grade} onChange={(e) => setGuided((g) => ({ ...g, grade: e.target.value }))} placeholder="13" />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="gb-days" className="text-xs">Max days (timing window)</Label>
                      <Input id="gb-days" inputMode="numeric" value={guided.maxDays} onChange={(e) => setGuided((g) => ({ ...g, maxDays: e.target.value }))} placeholder="30" />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="gb-max" className="text-xs">Max count (aggregate limit)</Label>
                      <Input id="gb-max" inputMode="numeric" value={guided.max} onChange={(e) => setGuided((g) => ({ ...g, max: e.target.value }))} placeholder="2" />
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>

              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" onClick={onParse} disabled={parseDraft.isPending || (!draftText && !(guidedOpen && guided.family))}>
                  {parseDraft.isPending ? <Loader2 className="me-1.5 h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="me-1.5 h-4 w-4" aria-hidden />}
                  Parse into a draft spec
                </Button>
                {!canDraft ? <span className="text-xs text-muted-foreground">Only a policy author, the compliance lead, or an administrator can draft rules.</span> : null}
              </div>
              {draftError ? (
                <Alert variant="destructive" role="alert">
                  <TriangleAlert className="h-4 w-4" aria-hidden />
                  <AlertTitle>Parse failed</AlertTitle>
                  <AlertDescription>{draftError}</AlertDescription>
                </Alert>
              ) : null}
            </CardContent>
          </Card>

          {/* Parse result */}
          {draft ? (
            <div className="space-y-4">
              <InterpretationCard
                title={`Draft ${draft.id} — interpretation`}
                understood={draft.understood}
                note={draft.note}
                ambiguities={draft.ambiguities}
                comparatorSemantics={[]}
                notes={draft.spec?.clauses[0] ? { en: `Clause C1 verbatim: “${draft.spec.clauses[0].text}”`, ar: `النص الحرفي للبند C1: «${draft.spec.clauses[0].text}»` } : null}
                locale={locale}
              />

              {draft.spec ? (
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm">Generated spec &amp; tests</CardTitle>
                    <CardDescription>
                      family {draft.spec.family} · severity {draft.spec.severity.base} · scope {draft.spec.scope.transactionTypes.join(", ")}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <TestsTable tests={draft.spec.tests} />
                    <div className="flex flex-wrap items-center gap-2">
                      <Button type="button" size="sm" variant="outline" onClick={onBacktest}>
                        <FlaskConical className="me-1.5 h-3.5 w-3.5" aria-hidden /> Backtest on 12 months
                      </Button>
                      <Button type="button" size="sm" onClick={onSubmitDraft} disabled={!draft.id}>
                        <Send className="me-1.5 h-3.5 w-3.5" aria-hidden /> Submit for approval
                      </Button>
                      {submitNote ? (
                        <span className="inline-flex items-center gap-1 text-xs text-ok" role="status">
                          <CircleCheck className="h-3.5 w-3.5" aria-hidden /> {submitNote}
                        </span>
                      ) : null}
                    </div>
                    {backtestError ? (
                      <Alert variant="destructive" role="alert">
                        <TriangleAlert className="h-4 w-4" aria-hidden />
                        <AlertTitle>Backtest failed</AlertTitle>
                        <AlertDescription>{backtestError}</AlertDescription>
                      </Alert>
                    ) : null}

                    {/* Backtest panel */}
                    {backtest ? (
                      <div className="space-y-3 rounded-lg border bg-secondary/40 p-4">
                        <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
                          <div>
                            <p className="text-4xl font-semibold tabular-nums text-primary">{iso(String(backtest.wouldFlag))}</p>
                            <p className="text-xs text-muted-foreground">would flag · of {iso(String(backtest.transactionCount))} transactions</p>
                          </div>
                          <div>
                            <p className="text-2xl font-semibold tabular-nums">{iso(String(backtest.rate))}%</p>
                            <p className="text-xs text-muted-foreground">flag rate</p>
                          </div>
                          <div className="pb-1">
                            {backtest.floodRisk === "high" ? (
                              <Badge className="border-sev-critical/40 bg-sev-critical/10 text-sev-critical" variant="outline">flood risk: high</Badge>
                            ) : backtest.floodRisk === "medium" ? (
                              <Badge className="border-sev-medium/50 bg-sev-medium/10 text-foreground" variant="outline">flood risk: medium</Badge>
                            ) : (
                              <Badge className="border-ok/40 bg-ok/10 text-foreground" variant="outline">flood risk: low</Badge>
                            )}
                          </div>
                        </div>

                        {backtest.overlap.length > 0 ? (
                          <div>
                            <p className="mb-1 text-xs font-medium text-muted-foreground">Overlap with existing rules</p>
                            <div className="overflow-hidden rounded-lg border bg-card">
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>Rule</TableHead>
                                    <TableHead className="text-end">Shared findings</TableHead>
                                    <TableHead className="text-end">Jaccard</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {backtest.overlap.map((o) => (
                                    <TableRow key={o.ruleId}>
                                      <TableCell className="font-mono text-xs">{o.ruleId}</TableCell>
                                      <TableCell className="text-end tabular-nums">{iso(String(o.count))}</TableCell>
                                      <TableCell className="text-end tabular-nums">{iso(String(o.jaccard))}</TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            </div>
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground">No overlap with existing rules.</p>
                        )}

                        {backtest.sample.length > 0 ? (
                          <div>
                            <p className="mb-1 text-xs font-medium text-muted-foreground">Sample of would-flag transactions (first 10)</p>
                            <div className="overflow-hidden rounded-lg border bg-card">
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>Txn</TableHead>
                                    <TableHead>Employee</TableHead>
                                    <TableHead>Type</TableHead>
                                    <TableHead className="text-end">Amount</TableHead>
                                    <TableHead>Effective</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {backtest.sample.map((s) => (
                                    <TableRow key={s.txnId}>
                                      <TableCell className="font-mono text-xs">{s.txnId}</TableCell>
                                      <TableCell className="font-mono text-xs">{s.employeeId}</TableCell>
                                      <TableCell className="font-mono text-xs">{s.type}</TableCell>
                                      <TableCell className="text-end font-mono text-xs tabular-nums">{fmtAed(s.amountFils, iso)}</TableCell>
                                      <TableCell className="font-mono text-xs">{s.effectiveDate || "—"}</TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            </div>
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground">No transactions would be flagged on the current dataset.</p>
                        )}

                        {monthlyBars.length > 0 ? (
                          <div>
                            <p className="mb-1 text-xs font-medium text-muted-foreground">Monthly would-flag counts</p>
                            <div className="flex h-16 items-end gap-1.5" role="img" aria-label="Monthly would-flag counts as bars">
                              {monthlyBars.map((m) => (
                                <div key={m.month} className="flex flex-1 flex-col items-center gap-1">
                                  <div className="flex h-12 w-full items-end">
                                    <div className="w-full rounded-sm bg-primary/70" style={{ height: `${Math.max(8, m.pct)}%` }} title={`${m.month}: ${m.v}`} />
                                  </div>
                                  <span className="font-mono text-[9px] text-muted-foreground">{m.month.slice(2)}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              ) : null}
            </div>
          ) : null}
        </TabsContent>
      </Tabs>

      {/* Coverage summary — every written sentence accounted for */}
      {coverage ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Policy coverage</CardTitle>
            <CardDescription>
              pack {coverage.packVersion} · every written sentence classified — nothing silent
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {[
              { label: "Total sentences", value: coverage.total },
              { label: "Compiled", value: coverage.compiled.length },
              { label: "Definitions", value: coverage.definitions.length },
              { label: "Attestations", value: coverage.attestations.length },
              { label: "Scope notes", value: coverage.scopeNotes.length },
            ].map((c) => (
              <div key={c.label} className="rounded-lg border bg-secondary/40 p-3">
                <p className="text-xl font-semibold tabular-nums">{iso(String(c.value))}</p>
                <p className="text-[11px] text-muted-foreground">{c.label}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
