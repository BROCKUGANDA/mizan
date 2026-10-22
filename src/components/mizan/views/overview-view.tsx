"use client";

/**
 * Overview view (Task 2-a): FS-02 census reconciliation banner, audit-readiness
 * score, open exceptions by severity, hotspot matrix, severity trends (pure CSS
 * bars — no chart library), top exception groups and coverage/governance.
 * Data: GET /api/v1/overview. Run start: POST /api/v1/runs (idempotent).
 */

import { useCallback, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, useReducedMotion } from "framer-motion";
import { AlertTriangle, CheckCircle2, PauseCircle, Play, ShieldCheck } from "lucide-react";
import { useCountUpText } from "@/lib/client/use-count-up";
import { toast } from "@/hooks/use-toast";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorState, LoadingSkeleton, SeverityBadge } from "@/components/mizan/primitives";
import { useI18n } from "@/lib/i18n/use-i18n";
import { api, ApiError, useAppStore, v1 } from "@/lib/client/store";
import type { Severity } from "@/lib/contracts";
import { cn } from "@/lib/utils";

// ── Payload contracts (server: src/app/api/v1/overview + lib/server/analytics) ──

interface RunHold {
  ruleId?: string;
  reason: string;
  kind: string;
}

interface Census {
  runId: string;
  status: string;
  asOf: string;
  outputHash: string;
  holds: RunHold[];
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
}

interface ReadinessComponent {
  key: string;
  label: string;
  weight: number;
  score: number; // 0..1
  note: string;
}

interface Readiness {
  total: number; // 0..100
  components: ReadinessComponent[];
  nextBestAction: string;
}

interface HotspotCell {
  process: string;
  ruleId: string;
  count: number;
  per1000: number;
  suppressed: boolean;
}

interface TrendPoint {
  month: string;
  CRITICAL: number;
  HIGH: number;
  MEDIUM: number;
  LOW: number;
  total: number;
  suppressed: boolean;
}

interface TopGroup {
  groupKey: string;
  count: number;
  ruleId: string;
  family: string;
  headline: string;
}

interface CoverageSentence {
  anchor: string;
  status: string;
  family?: string;
  usedBy?: string[];
  note?: string;
}

interface Coverage {
  packVersion: string;
  compiled: CoverageSentence[];
  definitions: CoverageSentence[];
  scopeNotes: CoverageSentence[];
  attestations: CoverageSentence[];
  total: number;
}

interface MeasuredPrecision {
  decided: number;
  confirmed: number;
  lowerBound: number;
  method: string;
}

interface OverviewPayload {
  census: Census | null;
  counts: { open: number; openBySeverity: Record<string, number>; total: number };
  readiness: Readiness;
  hotspots: HotspotCell[];
  trends: TrendPoint[];
  topGroups: TopGroup[];
  coverage: Coverage;
  measuredPrecision: MeasuredPrecision | null;
  patternsSummary: number;
}

const SEVERITIES: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

const SEV_BAR: Record<Severity, string> = {
  CRITICAL: "bg-sev-critical",
  HIGH: "bg-sev-high",
  MEDIUM: "bg-sev-medium",
  LOW: "bg-sev-low",
};

/** Run status chip (short form used inside the census banner). */
function RunStateBadge({ status }: { status: string }) {
  const style =
    status === "COMPLETED"
      ? "border-ok/40 bg-ok/10 text-foreground"
      : status.endsWith("_WITH_HOLDS")
        ? "border-hold/40 bg-hold/10 text-hold"
        : status.endsWith("_WITH_DQ")
          ? "border-sev-medium/40 bg-sev-medium/10 text-foreground"
          : status === "FAILED" || status === "CANCELLED"
            ? "border-destructive/40 bg-destructive/10 text-destructive"
            : "border-border bg-secondary text-foreground";
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium", style)} role="status">
      {status}
    </span>
  );
}

/** A number rendered as a small font-mono badge (digits through iso()). */
function Num({ value, className }: { value: string | number; className?: string }) {
  const { iso } = useI18n();
  return (
    <span className={cn("inline-flex min-w-8 items-center justify-center rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-xs tabular-nums", className)}>
      {iso(String(value))}
    </span>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <CardTitle className="text-sm font-medium text-muted-foreground">
      {children}
    </CardTitle>
  );
}

/** api() reuses RequestInit's `body?: BodyInit` slot for JSON payloads; cast objects at call sites (runtime still JSON-stringifies). */
const jsonBody = (b: unknown): BodyInit => b as unknown as BodyInit;

/* ─── Luxury/retention layer (§31 polish) ─────────────────────────────────── */

/** Count-up numeral. variant "chip" mirrors Num, "plain" is a bare figure. */
function AnimatedNum({
  value,
  variant = "chip",
  durationMs,
  className,
}: {
  value: string | number;
  variant?: "chip" | "plain";
  durationMs?: number;
  className?: string;
}) {
  const { iso } = useI18n();
  const numeric = typeof value === "number" ? value : Number(String(value).replace(/[^\d.-]/g, "")) || 0;
  const fmt = useCallback((n: number) => iso(String(Math.round(n))), [iso]);
  const ref = useCountUpText<HTMLSpanElement>(numeric, fmt, { durationMs: durationMs ?? 900 });
  if (variant === "chip") {
    return (
      <span ref={ref} className={cn("inline-flex min-w-8 items-center justify-center rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-xs tabular-nums", className)} />
    );
  }
  return <span ref={ref} className={cn("font-mono tabular-nums", className)} />;
}

/** Gold→brand progress ring with a count-up score; one eased rAF drives both. */
function ReadinessRing({ value }: { value: number }) {
  const { iso } = useI18n();
  const clamped = Math.max(0, Math.min(100, value));
  const r = 52;
  const c = 2 * Math.PI * r;
  const circleRef = useRef<SVGCircleElement | null>(null);
  const fmt = useCallback((n: number) => iso(String(Math.round(n))), [iso]);
  const numRef = useCountUpText<HTMLSpanElement>(clamped, fmt, {
    durationMs: 1100,
    onUpdate: (v) => {
      const pct = Math.max(0, Math.min(100, v)) / 100;
      circleRef.current?.setAttribute("stroke-dashoffset", String(c * (1 - pct)));
    },
  });
  return (
    <div className="relative h-28 w-28 shrink-0" role="img" aria-label={`${value} / 100`}>
      <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90" aria-hidden>
        <circle cx="60" cy="60" r={r} fill="none" stroke="var(--border)" strokeWidth="8" />
        <defs>
          <linearGradient id="mizan-rr-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--gold)" />
            <stop offset="100%" stopColor="var(--brand)" />
          </linearGradient>
        </defs>
        <circle
          ref={circleRef}
          cx="60"
          cy="60"
          r={r}
          fill="none"
          stroke="url(#mizan-rr-grad)"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span ref={numRef} className="font-mono text-2xl font-bold tabular-nums" />
        <span className="text-[10px] text-muted-foreground">{iso("100")}</span>
      </div>
    </div>
  );
}

/** Staggered entrance wrapper; reduced-motion users get a plain div. */
function Reveal({ index, className, children }: { index: number; className?: string; children: React.ReactNode }) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, delay: Math.min(index * 0.06, 0.42), ease: "easeOut" }}
    >
      {children}
    </motion.div>
  );
}

interface SystemStateLite {
  actors: { id: string; name: string; role: string }[];
}

/** Time-aware greeting + Gregorian and Umm al-Qura Hijri dates (luxury, zero deps). */
function GreetingHeader({ live }: { live: boolean }) {
  const { locale } = useI18n();
  const actor = useAppStore((s) => s.actor);
  // Shares the shell's ["system-state", actor] cache — no extra polling.
  const { data: system } = useQuery<SystemStateLite>({
    queryKey: ["system-state", actor],
    queryFn: () => api<SystemStateLite>(v1("/system/state")),
    staleTime: 10_000,
    refetchInterval: false,
  });
  const name = system?.actors.find((a) => a.id === actor)?.name ?? actor;
  const now = new Date();
  const h = now.getHours();
  const greeting =
    locale === "ar"
      ? h < 12
        ? "صباح الخير"
        : "مساء الخير"
      : h < 12
        ? "Good morning"
        : h < 17
          ? "Good afternoon"
          : "Good evening";
  const gregorian = new Intl.DateTimeFormat(locale === "ar" ? "ar-AE" : "en-AE", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(now);
  let hijri = "";
  try {
    hijri = new Intl.DateTimeFormat(locale === "ar" ? "ar-AE-u-ca-islamic-umalqura" : "en-u-ca-islamic-umalqura", {
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(now);
  } catch {
    hijri = ""; // ICU without islamic calendar — Gregorian line still shows
  }
  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {greeting}, <span className="text-brand">{name}</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {gregorian}
            {hijri ? (
              <>
                <span aria-hidden> · </span>
                {hijri}
              </>
            ) : null}
          </p>
        </div>
        {live ? (
          <span
            className="inline-flex items-center gap-2 rounded-full border border-ok/40 bg-ok/10 px-3 py-1 text-xs text-foreground"
            role="status"
          >
            <span className="pulse-dot h-2 w-2 rounded-full bg-ok" aria-hidden />
            {locale === "ar" ? "التعداد محدَّث" : "Census current"}
          </span>
        ) : null}
      </div>
      <div className="gold-rule mt-4" aria-hidden />
    </div>
  );
}

export default function OverviewView() {
  const { t, locale, iso } = useI18n();
  const setView = useAppStore((s) => s.setView);
  const setSelectedException = useAppStore((s) => s.setSelectedException);
  const qc = useQueryClient();

  const { data, isPending, isError, error, refetch } = useQuery<OverviewPayload>({
    queryKey: ["overview"],
    queryFn: () => api<OverviewPayload>(v1("/overview")),
  });

  const startMut = useMutation({
    mutationFn: () =>
      api<{ runId: string; status: string }>(v1("/runs"), {
        method: "POST",
        body: jsonBody({}),
        headers: { "idempotency-key": crypto.randomUUID() },
      }),
    onSuccess: async (r) => {
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

  if (isPending) {
    return (
      <div className="space-y-6" aria-busy>
        <LoadingSkeleton rows={3} />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <LoadingSkeleton rows={2} />
          <LoadingSkeleton rows={2} />
          <LoadingSkeleton rows={2} />
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : "Unknown error"}
        code={error instanceof ApiError ? error.code : undefined}
        onRetry={() => void refetch()}
      />
    );
  }

  const d = data as OverviewPayload;
  const census = d.census;
  const readiness = d.readiness;
  const openBySev = d.counts.openBySeverity ?? {};
  const maxTrend = Math.max(1, ...d.trends.map((p) => p.total));

  return (
    <>
      <GreetingHeader live={census?.status === "COMPLETED"} />
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
      {/* ── 1. Census banner (FS-02) — full width ──────────────────────────── */}
      <Reveal index={0} className="lg:col-span-3">
      <Card className="lux-card">
        <CardHeader className="pb-0">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SectionTitle>{t("overview.census")}</SectionTitle>
            {census ? (
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <RunStateBadge status={census.status} />
                <span>
                  {locale === "ar" ? "كما في" : "as of"}{" "}
                  <span className="font-mono">{iso(census.asOf)}</span>
                </span>
                <span className="inline-flex items-center gap-1" title={locale === "ar" ? "هاش المخرجات" : "Output hash (sha-256, truncated)"}>
                  <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                  <span className="font-mono">{iso(census.outputHash.slice(0, 16))}</span>
                </span>
              </div>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {startMut.isPending ? (
            <LoadingSkeleton rows={3} />
          ) : !census ? (
            <div className="flex flex-col items-center gap-4">
              <EmptyState
                title={locale === "ar" ? "لا يوجد تعداد بعد" : "No census yet"}
                hint={
                  locale === "ar"
                    ? "ابدأ التشغيل الأول لتحليل كل معاملة مقابل كل قاعدة نشطة وإنتاج التعداد الكامل (FS-02)."
                    : "Start the first run to evaluate every transaction against every active rule and produce the full census (FS-02)."
                }
                icon={<Play className="h-8 w-8" aria-hidden />}
              />
              <Button onClick={() => startMut.mutate()} aria-label={t("common.startRun")} className="active-press">
                <Play className="h-4 w-4" aria-hidden />
                {t("common.startRun")}
              </Button>
            </div>
          ) : (
            <>
              {/* Reconciliation sentence */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm" role="group" aria-label={locale === "ar" ? "معادلة التعداد" : "Census reconciliation"}>
                <AnimatedNum value={census.transactions ?? 0} />
                <span className="text-muted-foreground">{locale === "ar" ? "معاملة" : "transactions"}</span>
                <span className="text-muted-foreground" aria-hidden>×</span>
                <AnimatedNum value={census.rules ?? 0} />
                <span className="text-muted-foreground">{locale === "ar" ? "قاعدة" : "rules"}</span>
                <span className="text-muted-foreground" aria-hidden>=</span>
                <AnimatedNum value={census.checks ?? 0} />
                <span className="text-muted-foreground">{locale === "ar" ? "فحص" : "checks"}</span>
                <span className="text-muted-foreground" aria-hidden>·</span>
                <AnimatedNum value={census.applicable ?? 0} />
                <span className="text-muted-foreground">{locale === "ar" ? "منطبق" : "applicable"}</span>
                <span className="text-muted-foreground" aria-hidden>·</span>
                <AnimatedNum value={census.evaluated ?? 0} />
                <span className="text-muted-foreground">{locale === "ar" ? "مُقيَّم" : "evaluated"}</span>
                <span className="text-muted-foreground" aria-hidden>·</span>
                <AnimatedNum value={census.notEvaluable ?? 0} />
                <span className="text-muted-foreground">{locale === "ar" ? "غير قابل للتقييم" : "not evaluable"}</span>
                <span className="text-muted-foreground" aria-hidden>·</span>
                <AnimatedNum value={census.failed ?? 0} />
                <span className="text-muted-foreground">{locale === "ar" ? "فشل" : "failed"}</span>
              </div>

              {/* Secondary census stats */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  {locale === "ar" ? "ناجح" : "passed"} <Num value={census.passed ?? 0} />
                </span>
                <span className="inline-flex items-center gap-1.5">
                  {locale === "ar" ? "غير منطبق" : "not applicable"} <Num value={census.notApplicable ?? 0} />
                </span>
                <span className="inline-flex items-center gap-1.5">
                  {locale === "ar" ? "محجور" : "quarantined"} <Num value={census.quarantined ?? 0} />
                </span>
                <span className="inline-flex items-center gap-1.5">
                  {locale === "ar" ? "محتجز" : "held"} <Num value={census.held ?? 0} />
                </span>
                <span className="inline-flex items-center gap-1.5">
                  {locale === "ar" ? "استثناءات جودة بيانات" : "data-quality exceptions"} <Num value={census.dqExceptions ?? 0} />
                </span>
              </div>

              {/* Run holds (FS-05/FS-06/FS-07) */}
              {census.holds.length > 0 ? (
                <div className="space-y-2">
                  {census.holds.map((h, i) => (
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
            </>
          )}
        </CardContent>
      </Card>
      </Reveal>

      {/* ── 2. Audit readiness ─────────────────────────────────────────────── */}
      <Reveal index={1}>
      <Card className="lux-card">
        <CardHeader className="pb-0">
          <SectionTitle>{t("overview.readiness")}</SectionTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4">
            <ReadinessRing value={readiness.total} />
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {readiness.total >= 80
                  ? locale === "ar"
                    ? "جاهز للتدقيق"
                    : "Audit ready"
                  : locale === "ar"
                    ? "قيد التحصين"
                    : "Hardening in progress"}
              </p>
              <p className="text-xs text-muted-foreground">
                {locale === "ar" ? "الدرجة المركّبة من " : "Composite score out of "}
                {iso("100")}
              </p>
            </div>
          </div>
          <div className="space-y-3">
            {readiness.components.map((c) => (
              <div key={c.key} className="space-y-1">
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="font-medium">{c.label}</span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-mono tabular-nums">{iso(String(Math.round(c.score * 100)))}%</span>
                    <span aria-hidden>·</span>
                    <span>{locale === "ar" ? "وزن" : "w"} {iso(String(c.weight))}</span>
                  </span>
                </div>
                <Progress value={Math.round(c.score * 100)} aria-label={`${c.label}: ${Math.round(c.score * 100)}%`} />
                <p className="text-xs text-muted-foreground">{c.note}</p>
              </div>
            ))}
          </div>
          <div className="rounded-md border border-brand/30 bg-brand/5 p-3" role="note">
            <p className="text-xs font-medium text-brand">{locale === "ar" ? "أفضل إجراء تالٍ" : "Next best action"}</p>
            <p className="mt-1 text-sm">{readiness.nextBestAction}</p>
          </div>
        </CardContent>
      </Card>
      </Reveal>

      {/* ── 3. Open by severity ────────────────────────────────────────────── */}
      <Reveal index={2}>
      <Card className="lux-card">
        <CardHeader className="pb-0">
          <SectionTitle>{locale === "ar" ? "المفتوحة حسب الخطورة" : "Open by severity"}</SectionTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {SEVERITIES.map((s) => (
            <div key={s} className="flex items-center justify-between gap-2">
              <SeverityBadge severity={s} />
              <AnimatedNum value={openBySev[s] ?? 0} variant="plain" className="text-sm" />
            </div>
          ))}
          <div className="flex items-center justify-between gap-2 border-t pt-3 text-sm">
            <span className="text-muted-foreground">{locale === "ar" ? "إجمالي المفتوحة" : "Open total"}</span>
            <AnimatedNum value={d.counts.open ?? 0} variant="plain" />
          </div>
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="text-muted-foreground">{locale === "ar" ? "كل الاستثناءات" : "All exceptions"}</span>
            <AnimatedNum value={d.counts.total ?? 0} variant="plain" />
          </div>
        </CardContent>
      </Card>
      </Reveal>

      {/* ── 4. Hotspots ────────────────────────────────────────────────────── */}
      <Reveal index={3}>
      <Card className="lux-card">
        <CardHeader className="pb-0">
          <SectionTitle>{t("overview.hotspots")}</SectionTitle>
        </CardHeader>
        <CardContent>
          {d.hotspots.length === 0 ? (
            <EmptyState
              title={locale === "ar" ? "لا توجد بؤر ساخنة" : "No hotspots"}
              hint={locale === "ar" ? "ستظهر العمليات × القواعد هنا بعد التشغيل الأول." : "Process × rule cells appear here after the first run."}
            />
          ) : (
            <div className="max-h-72 overflow-y-auto" role="region" aria-label={t("overview.hotspots")}>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">{locale === "ar" ? "العملية" : "Process"}</TableHead>
                    <TableHead scope="col">{locale === "ar" ? "القاعدة" : "Rule"}</TableHead>
                    <TableHead scope="col" className="text-end">{locale === "ar" ? "العدد" : "Count"}</TableHead>
                    <TableHead scope="col" className="text-end">{locale === "ar" ? "لكل ١٠٠٠" : "Per 1,000"}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.hotspots.map((cell) => (
                    <TableRow
                      key={`${cell.process}|${cell.ruleId}`}
                      className={cn(cell.suppressed && "hatch-suppressed")}
                      title={cell.suppressed ? "fewer than 5" : undefined}
                    >
                      <TableCell className="max-w-48 truncate">{cell.process}</TableCell>
                      <TableCell className="font-mono text-xs">{cell.ruleId}</TableCell>
                      <TableCell className="text-end font-mono tabular-nums">
                        {cell.suppressed ? (
                          <span className="text-xs italic text-muted-foreground">fewer than 5</span>
                        ) : (
                          iso(String(cell.count))
                        )}
                      </TableCell>
                      <TableCell className="text-end font-mono tabular-nums">{iso(String(cell.per1000))}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
      </Reveal>

      {/* ── 5. Trends (pure CSS bars) ──────────────────────────────────────── */}
      <Reveal index={4}>
      <Card className="lux-card">
        <CardHeader className="pb-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SectionTitle>{t("overview.trends")}</SectionTitle>
            <div className="flex items-center gap-2" aria-hidden>
              {SEVERITIES.map((s) => (
                <span key={s} className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                  <span className={cn("h-2 w-2 rounded-sm", SEV_BAR[s])} /> {t(`severity.${s}`)}
                </span>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {d.trends.length === 0 ? (
            <EmptyState
              title={locale === "ar" ? "لا توجد بيانات اتجاهات" : "No trend data"}
              hint={locale === "ar" ? "تظهر الاتجاهات الشهرية بعد أول تشغيل." : "Monthly trend appears after the first run."}
            />
          ) : (
            <div className="flex items-end gap-4 overflow-x-auto pb-1" role="img" aria-label={locale === "ar" ? "استثناءات لكل شهر حسب الخطورة" : "Exceptions per month by severity"}>
              {d.trends.map((p) => (
                <div key={p.month} className="flex min-w-14 flex-col items-center gap-1">
                  <div
                    className={cn("flex h-12 items-end gap-0.5", p.suppressed && "hatch-suppressed rounded-sm")}
                    title={p.suppressed ? "fewer than 5" : undefined}
                  >
                    {SEVERITIES.map((s) => {
                      const count = p[s] ?? 0;
                      const h = count === 0 ? 0 : Math.max(4, Math.round((count / maxTrend) * 48));
                      return (
                        <div
                          key={s}
                          className={cn("w-2 rounded-t-sm", SEV_BAR[s], h === 0 && "opacity-20")}
                          style={{ height: `${h}px` }}
                          title={`${s}: ${count}`}
                        />
                      );
                    })}
                  </div>
                  <span className="font-mono text-[10px] text-muted-foreground">{iso(p.month)}</span>
                  <span className="font-mono text-xs tabular-nums">{iso(String(p.total))}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      </Reveal>

      {/* ── 6. Top groups ──────────────────────────────────────────────────── */}
      <Reveal index={5}>
      <Card className="lux-card">
        <CardHeader className="pb-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SectionTitle>{locale === "ar" ? "أكبر المجموعات" : "Top groups"}</SectionTitle>
            <span className="text-xs text-muted-foreground">{locale === "ar" ? "اضغط للانتقال إلى القائمة" : "click to open the queue"}</span>
          </div>
        </CardHeader>
        <CardContent>
          {d.topGroups.length === 0 ? (
            <EmptyState
              title={locale === "ar" ? "لا توجد مجموعات" : "No groups yet"}
              hint={locale === "ar" ? "تُجمَّع الاستثناءات المتشابهة تلقائياً بعد التشغيل." : "Similar exceptions are grouped automatically after a run."}
            />
          ) : (
            <div className="max-h-64 space-y-1 overflow-y-auto" role="list" aria-label={locale === "ar" ? "أكبر المجموعات" : "Top groups"}>
              {d.topGroups.map((g) => (
                <button
                  key={g.groupKey}
                  type="button"
                  role="listitem"
                  onClick={() => {
                    setSelectedException(null);
                    setView("queue");
                  }}
                  className="flex w-full items-center gap-3 rounded-md border border-transparent px-2 py-2 text-start transition-colors duration-200 hover:border-border hover:bg-secondary"
                  aria-label={`${g.ruleId}: ${g.headline} (${g.count})`}
                >
                  <Num value={g.count} />
                  <span className="font-mono text-xs text-muted-foreground">{g.ruleId}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">{g.headline}</span>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      </Reveal>

      {/* ── 7. Coverage & governance ───────────────────────────────────────── */}
      <Reveal index={6}>
      <Card className="lux-card">
        <CardHeader className="pb-0">
          <SectionTitle>{t("overview.coverage")}</SectionTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-baseline gap-2">
            <AnimatedNum value={d.coverage.total} variant="plain" className="text-2xl font-bold" durationMs={1200} />
            <span className="text-sm text-muted-foreground">
              {locale === "ar" ? "جملة مصنَّفة — كل قاعدة مكتوبة محسوبة" : "sentences classified — every written rule accounted for"}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {(
              [
                { key: "compiled", label: locale === "ar" ? "مُجمَّعة (فحوص)" : "Compiled checks", items: d.coverage.compiled },
                { key: "definitions", label: locale === "ar" ? "تعريفات" : "Definitions", items: d.coverage.definitions },
                { key: "attestations", label: locale === "ar" ? "إقرارات بشرية" : "Human attestations", items: d.coverage.attestations },
                { key: "scopeNotes", label: locale === "ar" ? "ملاحظات نطاق" : "Scope notes", items: d.coverage.scopeNotes },
              ] as const
            ).map((row) => (
              <div key={row.key} className="rounded-md border border-border bg-secondary/50 p-3">
                <p className="text-xs text-muted-foreground">{row.label}</p>
                <p className="mt-0.5 font-mono text-lg font-semibold tabular-nums">{iso(String(row.items.length))}</p>
                <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                  {row.items.map((i) => i.anchor).join(", ")}
                </p>
              </div>
            ))}
          </div>

          <div className="rounded-md border border-border p-3">
            <p className="flex items-center gap-1.5 text-xs font-medium">
              <CheckCircle2 className="h-3.5 w-3.5 text-ok" aria-hidden />
              {locale === "ar" ? "الدقة المقاسة (حد ويلسون الأدنى)" : "Measured precision (Wilson lower bound)"}
            </p>
            {d.measuredPrecision ? (
              <div className="mt-1.5 flex flex-wrap items-baseline gap-2">
                <span className="font-mono text-xl font-semibold tabular-nums">
                  {iso(`${(d.measuredPrecision.lowerBound * 100).toFixed(1)}%`)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {iso(`${d.measuredPrecision.confirmed}/${d.measuredPrecision.decided}`)}{" "}
                  {locale === "ar" ? "قرارات مؤكدة" : "confirmed decisions"}
                </span>
                <p className="w-full text-xs text-muted-foreground">{d.measuredPrecision.method}</p>
              </div>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">
                {locale === "ar" ? "لا توجد قرارات مُصنَّفة يدوياً بعد." : "No hand-labelled decisions yet."}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground" role="note">
            <AlertTriangle className="h-3.5 w-3.5 text-sev-medium" aria-hidden />
            {iso(String(d.patternsSummary))}{" "}
            {locale === "ar" ? "تنبيهات أنماط استشارية في انتظار المراجعة" : "advisory pattern alerts awaiting review"}
          </div>
        </CardContent>
      </Card>
      </Reveal>
      </div>
    </>
  );
}
