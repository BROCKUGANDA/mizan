"use client";

/**
 * Runs view (Task 2-a): start runs (standard/shadow/backtest, optional as-of),
 * live "still working" strip while RUNNING/FINALIZING, run history, per-run
 * detail (manifest hashes, per-rule coverage matrix, holds) and the FS-20
 * export panel with validation report + CSV downloads.
 * Data: GET/POST /api/v1/runs, GET /api/v1/runs/{id}, GET /api/v1/runs/{id}/export.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronRight, Download, FileDown, Loader2, PauseCircle, Play, TriangleAlert } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/mizan/primitives";
import { useI18n } from "@/lib/i18n/use-i18n";
import { api, ApiError, useAppStore, v1 } from "@/lib/client/store";
import { cn } from "@/lib/utils";

// ── Payload contracts ────────────────────────────────────────────────────────

interface RunHold {
  ruleId?: string;
  reason: string;
  kind: string;
}

interface RunStage {
  stage: string;
  at?: string;
  detail: string;
}

interface RunCounts {
  transactions?: number;
  rules?: number;
  checks?: number;
  applicable?: number;
  notApplicable?: number;
  evaluated?: number;
  notEvaluable?: number;
  passed?: number;
  failed?: number;
  quarantined?: number;
  held?: number;
  dqExceptions?: number;
  error?: string;
}

interface RunRow {
  id: string;
  kind: string;
  status: string;
  asOf: string;
  outputHash: string;
  counts: RunCounts;
  holds: RunHold[];
  stages: RunStage[];
  startedAt: string;
  finishedAt: string | null;
}

interface PerRuleStat {
  total: number;
  pass: number;
  notApplicable: number;
  notEvaluable: number;
  failed: number;
}

interface RunDetail {
  id: string;
  kind: string;
  status: string;
  asOf: string;
  outputHash: string;
  manifest: {
    runId: string;
    kind: string;
    status: string;
    engineVersion: string;
    packVersion: string;
    packHash: string;
    calendarHash: string;
    routingHash: string;
    gradeLadderHash: string;
    synonymsHash: string;
    configHash: string;
    flagsHash: string;
    asOf: string;
    outputHash: string;
  };
  perRule: Record<string, PerRuleStat>;
  holds: RunHold[];
  stages: RunStage[];
}

interface WorkedExample {
  transactionId: string;
  ok: boolean;
  mismatches: { column: string; expected: string; actual: string }[];
}

interface ExportBundle {
  runId: string;
  profileVersion: string;
  validation: {
    ok: boolean;
    profileVersion: string;
    workedExamples: WorkedExample[];
    structuralErrors: string[];
    findingsSha256: string;
  };
  findingsCsvB64: string;
  dataQualityCsvB64: string;
  manifest: Record<string, unknown>;
}

const ACTIVE_STATUSES = ["RUNNING", "FINALIZING"];
const DONE_STATUSES = ["COMPLETED", "COMPLETED_WITH_HOLDS", "COMPLETED_WITH_DQ"];

/** api() reuses RequestInit's `body?: BodyInit` slot for JSON payloads; cast objects at call sites (runtime still JSON-stringifies). */
const jsonBody = (b: unknown): BodyInit => b as unknown as BodyInit;

function runStatusStyle(status: string): string {
  if (status === "COMPLETED") return "border-ok/40 bg-ok/10 text-foreground";
  if (status.endsWith("_WITH_HOLDS")) return "border-hold/40 bg-hold/10 text-hold";
  if (status.endsWith("_WITH_DQ")) return "border-sev-medium/40 bg-sev-medium/10 text-foreground";
  if (status === "FAILED" || status === "CANCELLED") return "border-destructive/40 bg-destructive/10 text-destructive";
  return "border-border bg-secondary text-foreground"; // QUEUED / RUNNING / FINALIZING
}

/** Decode base64 → bytes and trigger a client-side download. */
function downloadB64(b64: string, filename: string): void {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium", runStatusStyle(status))} role="status">
      {status}
    </span>
  );
}

function KindBadge({ kind }: { kind: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground",
        kind === "shadow" && "border-dashed border-hold/60 bg-hold/5 text-foreground"
      )}
    >
      {kind}
    </span>
  );
}

export default function RunsView() {
  const { t, locale, iso } = useI18n();
  const qc = useQueryClient();
  const [kind, setKind] = useState<"standard" | "shadow" | "backtest">("standard");
  const [asOf, setAsOf] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const runsQuery = useQuery<{ items: RunRow[] }>({
    queryKey: ["runs"],
    queryFn: () => api<{ items: RunRow[] }>(v1("/runs")),
    refetchInterval: (query) => {
      const newest = query.state.data?.items?.[0];
      return newest && ACTIVE_STATUSES.includes(newest.status) ? 3000 : false;
    },
  });

  const startMut = useMutation({
    mutationFn: (input: { kind: string; asOf?: string }) =>
      api<{ runId: string; status: string }>(v1("/runs"), {
        method: "POST",
        body: jsonBody({ kind: input.kind, ...(input.asOf ? { asOf: input.asOf } : {}) }),
        headers: { "idempotency-key": crypto.randomUUID() },
      }),
    onSuccess: async (r) => {
      setSelectedId(r.runId);
      await qc.invalidateQueries();
      toast({
        title: locale === "ar" ? "بدأ التشغيل" : "Run started",
        description: `${r.runId} · ${r.status}`,
      });
    },
    onError: (err) => {
      toast({
        variant: "destructive",
        title: t("common.error"),
        description: err instanceof Error ? err.message : "Failed to start run",
      });
    },
  });

  const items = runsQuery.data?.items ?? [];
  const newest = items[0];
  const liveRun = newest && ACTIVE_STATUSES.includes(newest.status) ? newest : null;
  const selectedRun = items.find((r) => r.id === selectedId) ?? null;

  const detailQuery = useQuery<RunDetail>({
    queryKey: ["run", selectedId],
    queryFn: () => api<RunDetail>(v1(`/runs/${selectedId as string}`)),
    enabled: selectedId != null,
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      return s && ACTIVE_STATUSES.includes(s) ? 3000 : false;
    },
  });

  const detail = detailQuery.data;
  const canExport = detail != null && DONE_STATUSES.includes(detail.status);
  const exportQuery = useQuery<ExportBundle>({
    queryKey: ["export", selectedId],
    queryFn: () => api<ExportBundle>(v1(`/runs/${selectedId as string}/export`)),
    enabled: canExport,
    staleTime: 60_000,
  });

  const onStart = (): void => {
    startMut.mutate({ kind, asOf: asOf || undefined });
  };

  return (
    <div className="space-y-6">
      {/* ── Start run + live strip ─────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-0">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {locale === "ar" ? "بدء تشغيل جديد" : "Start a new run"}
            </CardTitle>
            <span className="text-xs text-muted-foreground">
              {locale === "ar"
                ? "كل تشغيل يُقيِّم كل معاملة × كل قاعدة نشطة (تعداد كامل)."
                : "Each run evaluates every transaction × every active rule (a full census)."}
            </span>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
              <SelectTrigger className="w-44" aria-label={locale === "ar" ? "نوع التشغيل" : "Run kind"}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="standard">{locale === "ar" ? "قياسي" : "Standard"}</SelectItem>
                <SelectItem value="shadow">{locale === "ar" ? "ظلّي (بدون تأثير)" : "Shadow (no side effects)"}</SelectItem>
                <SelectItem value="backtest">{locale === "ar" ? "اختبار رجعي" : "Backtest"}</SelectItem>
              </SelectContent>
            </Select>
            <Input
              type="date"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
              className="w-44"
              aria-label={locale === "ar" ? "تاريخ البيانات (اختياري)" : "As-of date (optional)"}
            />
            <Button onClick={onStart} disabled={startMut.isPending} aria-busy={startMut.isPending}>
              {startMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
              {t("common.startRun")}
            </Button>
          </div>

          {/* Live "Still working…" strip with pipeline stepper */}
          {liveRun ? (
            <div role="status" aria-live="polite" className="flex flex-col gap-3 rounded-lg border border-hold/30 bg-hold/5 p-4">
              <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                <Loader2 className="h-4 w-4 animate-spin text-hold" aria-hidden />
                {t("stillWorking")}
                <span className="font-mono text-xs text-muted-foreground">{liveRun.id}</span>
                <StatusBadge status={liveRun.status} />
              </div>
              <ol className="flex flex-wrap items-center gap-2 text-xs">
                {liveRun.stages.map((s, i) => (
                  <li key={`${s.stage}-${i}`} className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-hold/30 bg-background px-2 py-1">
                      <span className="h-1.5 w-1.5 rounded-full bg-hold" aria-hidden />
                      <span className="font-medium">{s.stage}</span>
                      {s.detail ? <span className="text-muted-foreground">— {s.detail}</span> : null}
                    </span>
                    {i < liveRun.stages.length - 1 ? (
                      <ChevronRight className="h-3 w-3 text-muted-foreground mirror-x" aria-hidden />
                    ) : null}
                  </li>
                ))}
              </ol>
              {typeof liveRun.counts?.checks === "number" && liveRun.counts.checks > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {iso(String(liveRun.counts.transactions ?? 0))} × {iso(String(liveRun.counts.rules ?? 0))} ={" "}
                  {iso(String(liveRun.counts.checks))} {locale === "ar" ? "فحص" : "checks"}
                </p>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* ── Run history ────────────────────────────────────────────────────── */}
      <section aria-label={t("nav.runs")} className="space-y-3">
        {runsQuery.isPending ? (
          <LoadingSkeleton rows={4} />
        ) : runsQuery.isError ? (
          <ErrorState
            message={runsQuery.error instanceof Error ? runsQuery.error.message : "Unknown error"}
            code={runsQuery.error instanceof ApiError ? runsQuery.error.code : undefined}
            onRetry={() => void runsQuery.refetch()}
          />
        ) : items.length === 0 ? (
          <EmptyState
            title={locale === "ar" ? "لا توجد تشغيلات بعد" : "No runs yet"}
            hint={locale === "ar" ? "ابدأ التشغيل الأول بالأزرار أعلاه لملء قائمة الاستثناءات." : "Start the first run with the controls above to fill the exception queue."}
          />
        ) : (
          items.map((r) => {
            const selected = r.id === selectedId;
            const c = r.counts ?? {};
            return (
              <div
                key={r.id}
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                onClick={() => setSelectedId(r.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedId(r.id);
                  }
                }}
                className={cn(
                  "cursor-pointer rounded-xl border bg-card p-4 transition-colors duration-200 hover:bg-secondary/60",
                  selected ? "border-primary" : "border-border"
                )}
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span className="font-mono text-sm font-medium">{r.id}</span>
                  <KindBadge kind={r.kind} />
                  <StatusBadge status={r.status} />
                  <span className="ms-auto flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    <span>
                      {locale === "ar" ? "كما في" : "as of"} <span className="font-mono">{iso(r.asOf)}</span>
                    </span>
                    <span className="font-mono">{iso(r.outputHash.slice(0, 16))}</span>
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  {typeof c.checks === "number" && c.checks > 0 ? (
                    <span className="font-mono">
                      {iso(String(c.transactions ?? 0))} × {iso(String(c.rules ?? 0))} = {iso(String(c.checks))}
                    </span>
                  ) : null}
                  {typeof c.failed === "number" ? (
                    <span>
                      {locale === "ar" ? "فشل" : "failed"} <span className="font-mono">{iso(String(c.failed))}</span>
                    </span>
                  ) : null}
                  {typeof c.notEvaluable === "number" ? (
                    <span>
                      {locale === "ar" ? "غير قابل للتقييم" : "not evaluable"} <span className="font-mono">{iso(String(c.notEvaluable))}</span>
                    </span>
                  ) : null}
                  {typeof c.held === "number" ? (
                    <span>
                      {locale === "ar" ? "محتجز" : "held"} <span className="font-mono">{iso(String(c.held))}</span>
                    </span>
                  ) : null}
                  {r.holds.length > 0 ? (
                    <span className="inline-flex items-center gap-1 text-hold">
                      <PauseCircle className="h-3 w-3" aria-hidden />
                      {iso(String(r.holds.length))} {locale === "ar" ? "احتجاز" : "hold(s)"}
                    </span>
                  ) : null}
                  <span className="ms-auto">
                    {locale === "ar" ? "بدأ" : "started"} <span className="font-mono">{iso(r.startedAt.slice(0, 10))}</span>
                  </span>
                </div>
              </div>
            );
          })
        )}
      </section>

      {/* ── Selected run detail ────────────────────────────────────────────── */}
      {selectedId ? (
        detailQuery.isPending ? (
          <Card aria-busy>
            <CardContent>
              <LoadingSkeleton rows={5} />
            </CardContent>
          </Card>
        ) : detailQuery.isError ? (
          <ErrorState
            message={detailQuery.error instanceof Error ? detailQuery.error.message : "Unknown error"}
            code={detailQuery.error instanceof ApiError ? detailQuery.error.code : undefined}
            onRetry={() => void detailQuery.refetch()}
          />
        ) : detail ? (
          <Card>
            <CardHeader className="pb-0">
              <div className="flex flex-wrap items-center gap-3">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {locale === "ar" ? "تفاصيل التشغيل" : "Run detail"}
                </CardTitle>
                <span className="font-mono text-sm">{detail.id}</span>
                <KindBadge kind={detail.kind} />
                <StatusBadge status={detail.status} />
                <span className="text-xs text-muted-foreground">
                  {locale === "ar" ? "كما في" : "as of"} <span className="font-mono">{iso(detail.asOf)}</span>
                </span>
                <span className="font-mono text-xs text-muted-foreground">{iso(detail.outputHash.slice(0, 16))}</span>
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Manifest hashes / versions */}
              <div>
                <p className="mb-2 text-sm font-medium">{locale === "ar" ? "بيان التشغيل (manifest)" : "Run manifest"}</p>
                <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
                  {(
                    [
                      ["packHash", detail.manifest.packHash],
                      ["calendarHash", detail.manifest.calendarHash],
                      ["routingHash", detail.manifest.routingHash],
                      ["gradeLadderHash", detail.manifest.gradeLadderHash],
                      ["synonymsHash", detail.manifest.synonymsHash],
                      ["configHash", detail.manifest.configHash],
                      ["flagsHash", detail.manifest.flagsHash],
                      ["engineVersion", detail.manifest.engineVersion],
                      ["packVersion", detail.manifest.packVersion],
                    ] as const
                  ).map(([k, v]) => (
                    <div key={k} className="min-w-0">
                      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{k}</dt>
                      <dd className="truncate font-mono text-xs" title={String(v)}>
                        {String(v)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>

              {/* Holds */}
              {detail.holds.length > 0 ? (
                <div className="space-y-2">
                  {detail.holds.map((h, i) => (
                    <Alert key={`${h.kind}-${h.ruleId ?? i}`} className="border-hold/40 bg-hold/10 text-foreground">
                      <PauseCircle className="h-4 w-4 text-hold" aria-hidden />
                      <AlertTitle>
                        {locale === "ar" ? "احتجاز" : "Hold"} · {h.kind}
                        {h.ruleId ? ` · ${h.ruleId}` : ""}
                      </AlertTitle>
                      <AlertDescription>{h.reason}</AlertDescription>
                    </Alert>
                  ))}
                </div>
              ) : null}

              {/* Per-rule coverage matrix */}
              <div>
                <p className="mb-2 text-sm font-medium">{locale === "ar" ? "مصفوفة التغطية لكل قاعدة" : "Per-rule coverage matrix"}</p>
                {Object.keys(detail.perRule).length === 0 ? (
                  <EmptyState title={locale === "ar" ? "لا توجد نتائج لكل قاعدة" : "No per-rule results"} />
                ) : (
                  <div className="max-h-72 overflow-y-auto" role="region" aria-label={locale === "ar" ? "مصفوفة التغطية" : "Per-rule coverage matrix"}>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead scope="col">{locale === "ar" ? "القاعدة" : "Rule"}</TableHead>
                          <TableHead scope="col" className="text-end">{locale === "ar" ? "الإجمالي" : "Total"}</TableHead>
                          <TableHead scope="col" className="text-end">{locale === "ar" ? "ناجح" : "Pass"}</TableHead>
                          <TableHead scope="col" className="text-end">{locale === "ar" ? "غير منطبق" : "N/A"}</TableHead>
                          <TableHead scope="col" className="text-end">{locale === "ar" ? "غير قابل للتقييم" : "Not evaluable"}</TableHead>
                          <TableHead scope="col" className="text-end">{locale === "ar" ? "فشل" : "Failed"}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {Object.entries(detail.perRule)
                          .sort(([a], [b]) => a.localeCompare(b))
                          .map(([ruleId, s]) => (
                            <TableRow key={ruleId}>
                              <TableCell className="font-mono text-xs">{ruleId}</TableCell>
                              <TableCell className="text-end font-mono tabular-nums">{iso(String(s.total))}</TableCell>
                              <TableCell className="text-end font-mono tabular-nums">{iso(String(s.pass))}</TableCell>
                              <TableCell className="text-end font-mono tabular-nums">{iso(String(s.notApplicable))}</TableCell>
                              <TableCell className="text-end font-mono tabular-nums">{iso(String(s.notEvaluable))}</TableCell>
                              <TableCell className="text-end font-mono tabular-nums">{iso(String(s.failed))}</TableCell>
                            </TableRow>
                          ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>

              {/* FS-20 export panel */}
              <div className="rounded-lg border border-border p-4">
                <p className="mb-3 flex items-center gap-2 text-sm font-medium">
                  <FileDown className="h-4 w-4" aria-hidden />
                  {locale === "ar" ? "التصدير (FS-20)" : "Export (FS-20)"}
                </p>

                {!canExport ? (
                  <p className="text-xs text-muted-foreground" role="note">
                    {locale === "ar"
                      ? "يتاح التصدير بعد اكتمال التشغيل (COMPLETED أو WITH_HOLDS أو WITH_DQ)."
                      : "Export unlocks when the run completes (COMPLETED, COMPLETED_WITH_HOLDS or COMPLETED_WITH_DQ)."}
                  </p>
                ) : exportQuery.isPending ? (
                  <LoadingSkeleton rows={2} />
                ) : exportQuery.isError ? (
                  <ErrorState
                    message={exportQuery.error instanceof Error ? exportQuery.error.message : "Unknown error"}
                    code={exportQuery.error instanceof ApiError ? exportQuery.error.code : undefined}
                    onRetry={() => void exportQuery.refetch()}
                  />
                ) : exportQuery.data ? (
                  <div className="space-y-3">
                    {(() => {
                      const v = exportQuery.data.validation;
                      const passed = v.workedExamples.filter((w) => w.ok).length;
                      const total = v.workedExamples.length;
                      if (v.ok) {
                        return (
                          <Alert className="border-ok/40 bg-ok/10 text-foreground [&>svg]:text-ok">
                            <CheckCircle2 className="h-4 w-4" aria-hidden />
                            <AlertTitle>
                              {locale === "ar"
                                ? `اجتاز مُصادِق التصدير — أُعيد إنتاج ${iso(`${passed}/${total}`)} من الأمثلة المرجعية`
                                : `Export validator passed — ${iso(`${passed}/${total}`)} worked examples reproduced`}
                            </AlertTitle>
                            <AlertDescription>
                              {locale === "ar" ? "الملف الشخصي" : "profile"} {v.profileVersion} ·{" "}
                              {locale === "ar" ? "هاش الملف" : "findings sha-256"}{" "}
                              <span className="font-mono">{v.findingsSha256.slice(0, 16)}</span>
                            </AlertDescription>
                          </Alert>
                        );
                      }
                      return (
                        <div className="space-y-2">
                          <Alert variant="destructive">
                            <TriangleAlert className="h-4 w-4" aria-hidden />
                            <AlertTitle>
                              {locale === "ar" ? "فشل مُصادِق التصدير — التنزيل معطّل" : "Export validator failed — downloads are disabled"}
                            </AlertTitle>
                            <AlertDescription>
                              {locale === "ar"
                                ? `أُعيد إنتاج ${iso(`${passed}/${total}`)} من الأمثلة المرجعية.`
                                : `${iso(`${passed}/${total}`)} worked examples reproduced.`}
                            </AlertDescription>
                          </Alert>
                          {v.structuralErrors.length > 0 ? (
                            <ul className="list-inside list-disc space-y-0.5 font-mono text-xs text-destructive" role="alert">
                              {v.structuralErrors.map((e, i) => (
                                <li key={i}>{e}</li>
                              ))}
                            </ul>
                          ) : null}
                          {v.workedExamples.some((w) => !w.ok) ? (
                            <div className="overflow-x-auto">
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead scope="col">{locale === "ar" ? "المعاملة" : "Transaction"}</TableHead>
                                    <TableHead scope="col">{locale === "ar" ? "العمود" : "Column"}</TableHead>
                                    <TableHead scope="col">{locale === "ar" ? "المتوقع" : "Expected"}</TableHead>
                                    <TableHead scope="col">{locale === "ar" ? "الفعلي" : "Actual"}</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {v.workedExamples
                                    .filter((w) => !w.ok)
                                    .flatMap((w) =>
                                      w.mismatches.map((mm, j) => (
                                        <TableRow key={`${w.transactionId}-${j}`} className="bg-destructive/5">
                                          <TableCell className="font-mono text-xs">{w.transactionId}</TableCell>
                                          <TableCell className="font-mono text-xs">{mm.column}</TableCell>
                                          <TableCell className="font-mono text-xs">{mm.expected}</TableCell>
                                          <TableCell className="font-mono text-xs">{mm.actual}</TableCell>
                                        </TableRow>
                                      ))
                                    )}
                                </TableBody>
                              </Table>
                            </div>
                          ) : null}
                        </div>
                      );
                    })()}

                    <div className="flex flex-wrap items-center gap-3">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!exportQuery.data.validation.ok}
                        onClick={() =>
                          downloadB64(exportQuery.data!.findingsCsvB64, `findings-${exportQuery.data!.runId}.csv`)
                        }
                        aria-label={
                          exportQuery.data.validation.ok
                            ? locale === "ar" ? "تنزيل ملف النتائج" : "Download findings CSV"
                            : locale === "ar" ? "تنزيل ملف النتائج (معطّل: فشل المُصادِق)" : "Download findings CSV (disabled: validator failed)"
                        }
                      >
                        <Download className="h-4 w-4" aria-hidden />
                        findings-{exportQuery.data.runId}.csv
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          downloadB64(exportQuery.data!.dataQualityCsvB64, `data_quality-${exportQuery.data!.runId}.csv`)
                        }
                        aria-label={locale === "ar" ? "تنزيل ملف جودة البيانات" : "Download data quality CSV"}
                      >
                        <Download className="h-4 w-4" aria-hidden />
                        data_quality-{exportQuery.data.runId}.csv
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            </CardContent>
          </Card>
        ) : null
      ) : selectedRun === null && items.length > 0 ? (
        <EmptyState
          title={locale === "ar" ? "اختر تشغيلاً لعرض التفاصيل" : "Select a run to inspect"}
          hint={locale === "ar" ? "يعرض البيان، مصفوفة التغطية، الاحتجازات ولوحة التصدير." : "The manifest, coverage matrix, holds and the export panel appear here."}
        />
      ) : null}
    </div>
  );
}
