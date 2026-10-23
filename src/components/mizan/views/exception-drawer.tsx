"use client";

/**
 * Exception detail drawer (Task 2-b): opens from the app store selection.
 * Renders the 8-part explanation (headline, what broke, rule quote, evidence
 * table, why-it-matters, suggested action, routing/severity rationale,
 * caveats), contextual decision actions with If-Match concurrency +
 * Idempotency-Key headers, the two-person countersign gate, and the
 * decisions / observations / timeline / siblings tabs. RTL-aware.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, EyeOff, Flag, Loader2, PauseCircle, RotateCcw } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api, useAppStore, v1 } from "@/lib/client/store";
import { useI18n } from "@/lib/i18n/use-i18n";
import { ErrorState, SeverityBadge, SkeletonBlock, StatusBadge } from "@/components/mizan/primitives";
import type { ExceptionStatus, RuleSpec, Severity } from "@/lib/contracts";
import { cn } from "@/lib/utils";

// ── API payload types ──────────────────────────────────────────────────────

interface EvidenceFact {
  name: string;
  value: string | number | boolean | null;
  display: { en: string; ar: string };
  source: string;
  path: string;
  breaching: boolean;
}

interface EvidenceCaveat {
  code: string;
  message: { en: string; ar: string };
  facts: string[];
}

interface EvidencePayload {
  ruleId: string;
  clauseId: string;
  clauseText: string;
  facts: EvidenceFact[];
  requirement: { en: string; ar: string; machine: string };
  comparison: { left: string; op: string; right: string; result: string } | null;
  relatedTxnIds: string[];
  calendarVersion: string | null;
  caveats: EvidenceCaveat[];
}

interface ExceptionDetail {
  exceptionKey: string;
  displayId: string;
  txnId: string;
  ruleId: string;
  clauseId: string;
  ruleVersion: string;
  family: string;
  severity: Severity;
  severityRationale: string;
  ownerTeam: string;
  watchers: string[];
  routingRationale: string;
  routingTableVersion: string;
  action: { id: string; en: string; ar: string };
  headline: { en: string; ar: string };
  explanation: { en: string; ar: string };
  status: ExceptionStatus;
  version: number;
  groupKey: string;
  ackDueAt: string | null;
  resolveDueAt: string | null;
  heldReason: string | null;
  noLongerDetected: boolean;
  firstRunId: string;
  lastRunId: string;
  evidence: EvidencePayload;
  evidenceHash: string;
  createdAt: string;
  updatedAt: string;
  pendingCountersign: boolean;
}

interface DecisionRow {
  id: string;
  command: string;
  actorId: string;
  reasonCategory: string | null;
  reasonText: string | null;
  sourceRef: string | null;
  expiry: string | null;
  canonicalKey: string | null;
  countersignedBy: string | null;
  createdAt: string;
}

interface ObservationRow {
  id: string;
  runId: string;
  ruleVersion: string;
  evidenceHash: string;
  observedAt: string;
}

interface SiblingRow {
  exceptionKey: string;
  displayId: string;
  ruleId: string;
  severity: Severity;
  status: ExceptionStatus;
  headlineEn: string;
}

interface EventRow {
  seq: number;
  at: string;
  actor: string;
  type: string;
  payload: Record<string, unknown>;
}

interface DetailPayload {
  exception: ExceptionDetail;
  ruleSpec: RuleSpec | null;
  decisions: DecisionRow[];
  observations: ObservationRow[];
  comments: { id: string; actorId: string; text: string; createdAt: string }[];
  siblings: SiblingRow[];
  events: EventRow[];
}

// ── Constants ──────────────────────────────────────────────────────────────

/** api() reuses RequestInit typing; JSON object bodies are stringified inside api(), so cast here. */
const asBody = (body: unknown): BodyInit => body as BodyInit;

const CATEGORIES: { value: string; en: string; ar: string }[] = [
  { value: "false_positive", en: "False positive", ar: "إنذار كاذب" },
  { value: "duplicate_handled", en: "Duplicate handled", ar: "تكرار تمت معالجته" },
  { value: "data_corrected", en: "Data corrected", ar: "تم تصحيح البيانات" },
  { value: "other", en: "Other", ar: "أخرى" },
];

const NEEDS_REASON_TEXT = new Set(["assign", "dismiss", "accept_risk", "reopen", "fail_verification"]);

interface ActionDef {
  command: string;
  needs: string[];
  danger?: boolean;
}

function actionsForStatus(status: ExceptionStatus): ActionDef[] {
  switch (status) {
    case "NEW":
    case "REOPENED":
      return [{ command: "triage", needs: [] }];
    case "TRIAGED":
      return [
        { command: "assign", needs: ["reasonText"] },
        { command: "dismiss", needs: ["reasonCategory", "reasonText"], danger: true },
        { command: "accept_risk", needs: ["expiry", "reasonText"] },
        { command: "mark_duplicate", needs: ["canonicalKey"] },
      ];
    case "ASSIGNED":
      return [{ command: "start", needs: [] }];
    case "IN_PROGRESS":
      return [{ command: "record_fix", needs: ["sourceRef"] }];
    case "PENDING_VERIFICATION":
      return [
        { command: "verify", needs: [] },
        { command: "fail_verification", needs: ["reasonText"], danger: true },
      ];
    case "CLOSED":
    case "DISMISSED":
      return [{ command: "reopen", needs: ["reasonText"] }];
    default:
      return [];
  }
}

// ── Component ──────────────────────────────────────────────────────────────

export function ExceptionDrawer() {
  const { dir } = useI18n();
  const { selectedExceptionKey: key, setSelectedException } = useAppStore();

  const detail = useQuery<DetailPayload>({
    queryKey: ["exception", key],
    queryFn: () => api<DetailPayload>(v1(`/exceptions/${encodeURIComponent(key ?? "")}`)),
    enabled: key !== null,
  });

  return (
    <Sheet open={key !== null} onOpenChange={(o) => { if (!o) setSelectedException(null); }}>
      <SheetContent side={dir === "rtl" ? "left" : "right"} className="w-full max-w-2xl gap-0 p-0 sm:max-w-2xl">
        {/* Remounts per exception so all decision-form state resets without effects. */}
        <DrawerBody
          key={key ?? "closed"}
          queryKey0={key ?? ""}
          payload={detail.data ?? null}
          isPending={detail.isPending}
          isError={detail.isError}
          errorMessage={detail.error instanceof Error ? detail.error.message : null}
          errorCode={detail.error instanceof ApiError ? detail.error.code : null}
          onRetry={() => void detail.refetch()}
        />
      </SheetContent>
    </Sheet>
  );
}

interface DrawerBodyProps {
  queryKey0: string;
  payload: DetailPayload | null;
  isPending: boolean;
  isError: boolean;
  errorMessage: string | null;
  errorCode: string | null;
  onRetry: () => void;
}

function DrawerBody({ queryKey0, payload, isPending, isError, errorMessage, errorCode, onRetry }: DrawerBodyProps) {
  const { t, locale, iso } = useI18n();
  const { setSelectedException } = useAppStore();
  const qc = useQueryClient();
  const L = (en: string, ar: string): string => (locale === "ar" ? ar : en);

  const exc = payload?.exception ?? null;

  // ── Decision form state (no optimistic status change — the server decides) ─
  const [activeCmd, setActiveCmd] = useState<string | null>(null);
  const [category, setCategory] = useState("");
  const [reasonText, setReasonText] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [expiry, setExpiry] = useState("");
  const [canonicalKey, setCanonicalKey] = useState("");
  const [pendingCmd, setPendingCmd] = useState<string | null>(null);
  const [err, setErr] = useState<{ code: string; message: string; currentVersion: number | null } | null>(null);
  const [csErr, setCsErr] = useState<string | null>(null);

  const decisionMut = useMutation({
    mutationFn: async (body: { command: string; reasonCategory?: string; reasonText?: string; sourceRef?: string; expiry?: string; canonicalKey?: string }) => {
      const current = payload?.exception;
      if (!current) throw new Error(L("Exception not loaded.", "الاستثناء غير محمّل."));
      return api<{ ok: boolean; status: string; version: number }>(v1(`/exceptions/${encodeURIComponent(current.exceptionKey)}/decisions`), {
        method: "POST",
        headers: { "If-Match": `W/"${current.version}"`, "Idempotency-Key": crypto.randomUUID() },
        body: asBody(body),
      });
    },
    onMutate: (body) => {
      setPendingCmd(body.command);
    },
    onSuccess: (res, body) => {
      setPendingCmd(null);
      setErr(null);
      setActiveCmd(null);
      setCategory("");
      setReasonText("");
      setSourceRef("");
      setExpiry("");
      setCanonicalKey("");
      toast({
        title: L("Decision recorded", "تم تسجيل القرار"),
        description: `${body.command} → ${res.status}`,
      });
      void qc.invalidateQueries({ queryKey: ["exception", queryKey0] });
      void qc.invalidateQueries({ queryKey: ["exceptions"] });
    },
    onError: (e) => {
      setPendingCmd(null);
      if (e instanceof ApiError) {
        const cv = typeof e.extra.currentVersion === "number" ? e.extra.currentVersion : null;
        setErr({ code: e.code, message: e.message, currentVersion: cv });
      } else {
        setErr({ code: "UNKNOWN", message: e instanceof Error ? e.message : L("Decision failed.", "فشل تسجيل القرار."), currentVersion: null });
      }
    },
  });

  const countersignMut = useMutation({
    mutationFn: () => {
      if (!exc) throw new Error(L("Exception not loaded.", "الاستثناء غير محمّل."));
      return api<{ ok: boolean; status: string; countersignedBy: string }>(v1(`/exceptions/${encodeURIComponent(exc.exceptionKey)}/countersign`), {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: asBody({}),
      });
    },
    onSuccess: (res) => {
      setCsErr(null);
      toast({ title: L("Countersigned", "تم التوقيع المشترك"), description: `${res.status} · ${res.countersignedBy}` });
      void qc.invalidateQueries({ queryKey: ["exception", queryKey0] });
      void qc.invalidateQueries({ queryKey: ["exceptions"] });
    },
    onError: (e) => {
      setCsErr(e instanceof Error ? e.message : L("Countersign failed.", "فشل التوقيع المشترك."));
    },
  });

  const run = (command: string, extra: { reasonCategory?: string; reasonText?: string; sourceRef?: string; expiry?: string; canonicalKey?: string } = {}): void => {
    decisionMut.mutate({ command, ...extra });
  };

  const fieldValid = (cmd: string): boolean => {
    if (cmd === "assign") return reasonText.trim().length >= 5;
    if (cmd === "dismiss") return !!category && reasonText.trim().length >= 15;
    if (cmd === "accept_risk") return /^\d{4}-\d{2}-\d{2}$/.test(expiry) && reasonText.trim().length >= 5;
    if (cmd === "mark_duplicate") return canonicalKey.trim().length > 0;
    if (cmd === "record_fix") return sourceRef.trim().length > 0;
    if (cmd === "reopen" || cmd === "fail_verification") return reasonText.trim().length > 0;
    return true;
  };

  const confirmActive = (): void => {
    if (!activeCmd) return;
    run(activeCmd, {
      ...(activeCmd === "dismiss" || activeCmd === "accept_risk" ? { reasonCategory: category } : {}),
      ...(reasonText.trim() ? { reasonText: reasonText.trim() } : {}),
      ...(sourceRef.trim() ? { sourceRef: sourceRef.trim() } : {}),
      ...(expiry ? { expiry } : {}),
      ...(canonicalKey.trim() ? { canonicalKey: canonicalKey.trim() } : {}),
    });
  };

  const cmdLabel = (c: string): string => (c === "fail_verification" ? L("Fail verification", "إخفاق التحقق") : t(`decision.${c}`));

  // Reload after a concurrency conflict: refetch then clear the alert.
  const reload = async (): Promise<void> => {
    await qc.refetchQueries({ queryKey: ["exception", queryKey0], exact: true });
    setErr(null);
  };

  // Explanation canonical text: blocks separated by a blank line.
  // [0] headline, [1] what broke, [2] rule quote, [3] why it matters, …
  const whatBroke = useMemo(() => {
    if (!exc) return "";
    const text = locale === "ar" ? exc.explanation.ar : exc.explanation.en;
    const blocks = text.split("\n\n");
    return blocks[1] ?? blocks[0] ?? "";
  }, [exc, locale]);

  const whyText = useMemo(() => {
    if (!exc) return "";
    const text = locale === "ar" ? exc.explanation.ar : exc.explanation.en;
    const blocks = text.split("\n\n");
    return (blocks[3] ?? "").replace(/^(Why it matters|أهمية ذلك):\s*/, "");
  }, [exc, locale]);

  const actions = exc ? actionsForStatus(exc.status) : [];

  return (
    <>
      <SheetHeader className="border-b p-4">
        {exc ? (
          <>
            <SheetTitle className="flex flex-wrap items-center gap-2 text-base">
              <span className="font-mono">{exc.displayId}</span>
              <SeverityBadge severity={exc.severity} />
              <StatusBadge status={exc.status} />
              <Badge variant="outline" className="font-mono text-[10px]">
                {exc.ruleId} · {exc.clauseId} · {exc.ruleVersion}
              </Badge>
            </SheetTitle>
            <SheetDescription id="mizan-drawer-desc" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span className="font-mono">{exc.txnId}</span>
              <span>{exc.ownerTeam}</span>
              <span className="font-mono text-[10px]" title={exc.evidenceHash}>
                {exc.evidenceHash.slice(0, 12)}…
              </span>
              {exc.watchers.length > 0 ? (
                <span>
                  {L("Watchers", "مراقبون")}: {exc.watchers.join(", ")}
                </span>
              ) : null}
            </SheetDescription>
          </>
        ) : (
          <SheetTitle className="sr-only">{t("common.loading")}</SheetTitle>
        )}
      </SheetHeader>

      <div className="flex-1 space-y-5 overflow-y-auto p-4" aria-busy={isPending}>
        {isPending ? (
          <div className="space-y-3">
            <SkeletonBlock className="h-6 w-2/3" />
            <SkeletonBlock className="h-4 w-full" />
            <SkeletonBlock className="h-4 w-5/6" />
            <SkeletonBlock className="h-24 w-full" />
            <SkeletonBlock className="h-32 w-full" />
          </div>
        ) : isError || !exc ? (
          <ErrorState
            message={errorMessage ?? L("Could not load the exception.", "تعذر تحميل الاستثناء.")}
            code={errorCode ?? undefined}
            onRetry={onRetry}
          />
        ) : (
          <>
            {/* Banners */}
            {exc.noLongerDetected ? (
              <div className="flex items-start gap-2 rounded-md border border-sev-medium/40 bg-sev-medium/10 px-3 py-2 text-sm" role="status">
                <EyeOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span>{L("No longer detected in the latest run.", "لم يُكتشف في التشغيل الأخير.")}</span>
              </div>
            ) : null}
            {exc.heldReason ? (
              <div className="flex items-start gap-2 rounded-md border border-hold/40 bg-hold/10 px-3 py-2 text-sm" role="status">
                <PauseCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span>
                  <span className="font-medium">{L("Held", "معلّق")}:</span> {exc.heldReason}
                </span>
              </div>
            ) : null}

            {/* 1 · Headline */}
            <h2 className="text-base font-semibold leading-snug">{locale === "ar" ? exc.headline.ar : exc.headline.en}</h2>

            {/* 2 · What broke */}
            <section className="space-y-1">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{L("What broke", "ما الذي خالف القاعدة")}</h3>
              <p className="text-sm leading-relaxed">{whatBroke}</p>
            </section>

            {/* 3 · Rule quote */}
            <section className="space-y-1">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{L("The rule", "القاعدة")}</h3>
              <blockquote className="border-s-4 border-primary/40 bg-secondary/60 p-3 text-[13px] leading-relaxed">
                <p>{exc.evidence.clauseText}</p>
              </blockquote>
              <p className="text-xs text-muted-foreground">
                {L("Required", "المطلوب")}: {locale === "ar" ? exc.evidence.requirement.ar : exc.evidence.requirement.en}
              </p>
            </section>

            {/* 4 · Evidence table */}
            <section className="space-y-1">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{L("Evidence", "الأدلة")}</h3>
              <div className="max-h-64 overflow-y-auto rounded-md border" tabIndex={0} aria-label={L("Evidence facts", "وقائع الإثبات")}>
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="sticky top-0 z-10 bg-card">{L("Fact", "الواقعة")}</TableHead>
                      <TableHead className="sticky top-0 z-10 bg-card">{L("Value", "القيمة")}</TableHead>
                      <TableHead className="sticky top-0 z-10 bg-card">{L("Source", "المصدر")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {exc.evidence.facts.map((f) => (
                      <TableRow key={f.name} className={f.breaching ? "bg-sev-critical/10 text-sev-critical hover:bg-sev-critical/10" : undefined}>
                        <TableCell className="text-xs font-medium">
                          {f.breaching ? <Flag className="me-1 inline h-3 w-3" aria-label={L("breaching", "مخالف")} /> : null}
                          {f.name}
                        </TableCell>
                        <TableCell className="text-xs">{locale === "ar" ? f.display.ar : f.display.en}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="font-mono text-[10px]">
                            {f.source}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {exc.evidence.comparison ? (
                <p className="font-mono text-xs text-muted-foreground">
                  {exc.evidence.comparison.left} {exc.evidence.comparison.op} {exc.evidence.comparison.right} → {exc.evidence.comparison.result}
                </p>
              ) : null}
              {exc.evidence.relatedTxnIds.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {L("Related transactions", "معاملات ذات صلة")}:{" "}
                  {exc.evidence.relatedTxnIds.map((r) => (
                    <span key={r} className="me-1 inline-block rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px]">
                      {r}
                    </span>
                  ))}
                </p>
              ) : null}
            </section>

            {/* 5 · Why it matters */}
            {whyText ? (
              <section className="space-y-1">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{L("Why it matters", "لماذا يهم هذا")}</h3>
                <p className="text-sm leading-relaxed">{whyText}</p>
              </section>
            ) : null}

            {/* 6 · Suggested action */}
            <section className="space-y-1">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{L("Suggested action", "الإجراء المقترح")}</h3>
              <div className="rounded-md border border-accent-foreground/10 bg-accent p-3 text-sm leading-relaxed">
                <p>{locale === "ar" ? exc.action.ar : exc.action.en}</p>
              </div>
            </section>

            {/* 7 · Owner + severity rationale */}
            <section className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1 rounded-md border bg-card p-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{L("Routing", "الإحالة")}</h3>
                <p className="text-sm font-medium">{exc.ownerTeam}</p>
                <p className="text-xs text-muted-foreground">{exc.routingRationale}</p>
                <Badge variant="outline" className="font-mono text-[10px]">
                  {exc.routingTableVersion}
                </Badge>
              </div>
              <div className="space-y-1 rounded-md border bg-card p-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{L("Severity rationale", "تبرير الدرجة")}</h3>
                <p className="text-xs leading-relaxed text-muted-foreground">{exc.severityRationale}</p>
              </div>
            </section>

            {/* 8 · Caveats */}
            {exc.evidence.caveats.length > 0 ? (
              <section className="space-y-1.5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{L("Caveats", "تنبيهات")}</h3>
                <ul className="space-y-1.5">
                  {exc.evidence.caveats.map((c) => (
                    <li key={c.code} className="flex items-start gap-2 text-xs">
                      <Badge variant="outline" className="mt-0.5 shrink-0 font-mono text-[10px]">
                        {c.code}
                      </Badge>
                      <span>{locale === "ar" ? c.message.ar : c.message.en}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {/* Decisions */}
            <section className="space-y-2 border-t pt-4">
              <h3 className="text-sm font-semibold">{L("Decisions", "القرارات")}</h3>

              {err ? (
                err.code === "MZ-CONC-409" ? (
                  <Alert variant="destructive" role="alert">
                    <AlertTriangle className="h-4 w-4" aria-hidden />
                    <AlertTitle>{L("This exception changed since you opened it", "تغيّر هذا الاستثناء منذ فتحته")}</AlertTitle>
                    <AlertDescription className="flex flex-wrap items-center gap-2">
                      <span>
                        {err.message}
                        {err.currentVersion !== null ? ` · ${L("server version", "إصدار الخادم")} ${iso(String(err.currentVersion))}` : ""}
                      </span>
                      <Button size="sm" variant="outline" onClick={() => void reload()}>
                        <RotateCcw className="h-4 w-4" aria-hidden />
                        {L("Reload", "إعادة التحميل")}
                      </Button>
                    </AlertDescription>
                  </Alert>
                ) : (
                  <Alert
                    role="alert"
                    className={cn(
                      err.code === "MZ-AUTH-403-COI" ? "border-hold/40 bg-hold/10" : "border-destructive/30 bg-destructive/5",
                    )}
                  >
                    <AlertTriangle className="h-4 w-4" aria-hidden />
                    <AlertTitle className="font-mono text-xs">{err.code}</AlertTitle>
                    <AlertDescription>
                      <span>{err.message}</span>
                      {err.code === "MZ-AUTH-403-COI" ? (
                        <span className="mt-1 block text-xs">
                          {L(
                            "Suggest reassignment to an analyst outside the transaction parties.",
                            "اقترح إعادة الإسناد إلى محلل خارج أطراف المعاملة.",
                          )}
                        </span>
                      ) : null}
                    </AlertDescription>
                  </Alert>
                )
              ) : null}

              {exc.pendingCountersign ? (
                <Alert className="border-sev-medium/40 bg-sev-medium/10" role="alert">
                  <AlertTriangle className="h-4 w-4" aria-hidden />
                  <AlertTitle>{L("Dismissal pending countersign", "الاستبعاد بانتظار التوقيع المشترك")}</AlertTitle>
                  <AlertDescription className="space-y-2">
                    <p className="text-xs">
                      {L(
                        "A High/Critical dismissal needs a second analyst to countersign before it takes effect.",
                        "استبعاد الحرج/العالي يحتاج توقيع محلل ثانٍ قبل أن يسري.",
                      )}
                    </p>
                    {csErr ? (
                      <p className="text-xs font-medium text-destructive" role="alert">
                        {csErr}
                      </p>
                    ) : null}
                    <Button
                      size="sm"
                      onClick={() => countersignMut.mutate()}
                      disabled={!!csErr || pendingCmd !== null || countersignMut.isPending}
                      aria-busy={countersignMut.isPending}
                    >
                      {countersignMut.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                      {countersignMut.isPending ? L("Saving decision…", "جارٍ حفظ القرار…") : t("decision.countersign")}
                    </Button>
                  </AlertDescription>
                </Alert>
              ) : null}

              <div className="flex flex-wrap gap-2" role="group" aria-label={L("Available decisions", "القرارات المتاحة")}>
                {actions.map((a) => (
                  <Button
                    key={a.command}
                    size="sm"
                    variant={pendingCmd === a.command ? "default" : a.danger ? "destructive" : "outline"}
                    disabled={pendingCmd !== null || countersignMut.isPending}
                    aria-busy={pendingCmd === a.command}
                    onClick={() => (a.needs.length > 0 ? setActiveCmd(activeCmd === a.command ? null : a.command) : run(a.command))}
                  >
                    {pendingCmd === a.command ? <Loader2 className="animate-spin" aria-hidden /> : null}
                    {pendingCmd === a.command ? L("Saving decision…", "جارٍ حفظ القرار…") : cmdLabel(a.command)}
                  </Button>
                ))}
                {actions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{L("No actions available for this status.", "لا توجد إجراءات متاحة لهذه الحالة.")}</p>
                ) : null}
              </div>

              {activeCmd ? (
                <div className="space-y-3 rounded-md border bg-secondary/40 p-3">
                  {activeCmd === "dismiss" || activeCmd === "accept_risk" ? (
                    <div className="space-y-1.5">
                      <Label htmlFor="dec-cat">{L("Reason category", "فئة السبب")}</Label>
                      <Select value={category} onValueChange={setCategory}>
                        <SelectTrigger id="dec-cat" className="w-full">
                          <SelectValue placeholder={L("Choose…", "اختر…")} />
                        </SelectTrigger>
                        <SelectContent>
                          {CATEGORIES.map((c) => (
                            <SelectItem key={c.value} value={c.value}>
                              {locale === "ar" ? c.ar : c.en}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}
                  {NEEDS_REASON_TEXT.has(activeCmd) ? (
                    <div className="space-y-1.5">
                      <Label htmlFor="dec-reason">{L("Reason", "السبب")}</Label>
                      <Textarea
                        id="dec-reason"
                        value={reasonText}
                        onChange={(e) => setReasonText(e.target.value)}
                        className="min-h-16"
                        placeholder={L("Explain the decision for the audit trail.", "اشرح القرار لسجل التدقيق.")}
                      />
                      {activeCmd === "dismiss" ? (
                        <p className={cn("text-xs", reasonText.trim().length >= 15 ? "text-muted-foreground" : "text-sev-high")}>
                          {L("At least 15 characters.", "15 حرفاً على الأقل.")} ({iso(String(reasonText.trim().length))})
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  {activeCmd === "accept_risk" ? (
                    <div className="space-y-1.5">
                      <Label htmlFor="dec-expiry">{L("Risk expiry date", "تاريخ انتهاء المخاطرة")}</Label>
                      <Input id="dec-expiry" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} className="w-48" />
                    </div>
                  ) : null}
                  {activeCmd === "mark_duplicate" ? (
                    <div className="space-y-1.5">
                      <Label htmlFor="dec-canonical">{L("Canonical exception key", "مفتاح الاستثناء الأساسي")}</Label>
                      <Input
                        id="dec-canonical"
                        value={canonicalKey}
                        onChange={(e) => setCanonicalKey(e.target.value)}
                        className="font-mono"
                        placeholder="F-…"
                      />
                    </div>
                  ) : null}
                  {activeCmd === "record_fix" ? (
                    <div className="space-y-1.5">
                      <Label htmlFor="dec-ref">{L("Source-system reference", "مرجع النظام المصدر")}</Label>
                      <Input id="dec-ref" value={sourceRef} onChange={(e) => setSourceRef(e.target.value)} />
                    </div>
                  ) : null}
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={confirmActive}
                      disabled={!fieldValid(activeCmd) || pendingCmd !== null}
                      aria-busy={pendingCmd === activeCmd}
                    >
                      {pendingCmd === activeCmd ? <Loader2 className="animate-spin" aria-hidden /> : null}
                      {pendingCmd === activeCmd ? L("Saving decision…", "جارٍ حفظ القرار…") : t("common.confirm")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setActiveCmd(null)} disabled={pendingCmd !== null}>
                      {t("common.cancel")}
                    </Button>
                  </div>
                </div>
              ) : null}
            </section>
          </>
        )}
      </div>

      {/* Bottom tabs */}
      {exc ? (
        <div className="border-t p-4">
          <Tabs defaultValue="decisions">
            <TabsList className="w-full justify-start overflow-x-auto">
              <TabsTrigger value="decisions">
                {L("Decisions", "القرارات")} ({iso(String(payload?.decisions.length ?? 0))})
              </TabsTrigger>
              <TabsTrigger value="observations">
                {L("Observations", "الملاحظات")} ({iso(String(payload?.observations.length ?? 0))})
              </TabsTrigger>
              <TabsTrigger value="timeline">
                {L("Timeline", "الخط الزمني")} ({iso(String(payload?.events.length ?? 0))})
              </TabsTrigger>
              <TabsTrigger value="siblings">
                {L("Siblings", "المجموعة")} ({iso(String(payload?.siblings.length ?? 0))})
              </TabsTrigger>
            </TabsList>
            <TabsContent value="decisions">
              <ul className="max-h-48 space-y-1.5 overflow-y-auto pe-1">
                {(payload?.decisions ?? []).map((d) => (
                  <li key={d.id} className="rounded-md border bg-card p-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{cmdLabel(d.command)}</span>
                      <span className="text-muted-foreground">{d.actorId}</span>
                      <span className="ms-auto font-mono text-[10px] text-muted-foreground">
                        {iso(d.createdAt.slice(0, 16).replace("T", " "))}
                      </span>
                    </div>
                    {d.reasonCategory || d.reasonText ? (
                      <p className="mt-1 text-muted-foreground">{[d.reasonCategory, d.reasonText].filter(Boolean).join(" — ")}</p>
                    ) : null}
                    {d.sourceRef ? <p className="mt-1 font-mono text-[10px]">{d.sourceRef}</p> : null}
                    {d.expiry ? (
                      <p className="mt-1">
                        {L("expires", "ينتهي")} {d.expiry}
                      </p>
                    ) : null}
                    <p className="mt-1">
                      {d.countersignedBy === "not-required" ? (
                        <Badge variant="outline" className="text-[10px]">
                          {L("no countersign needed", "لا حاجة لتوقيع")}
                        </Badge>
                      ) : d.countersignedBy ? (
                        <Badge className="border-ok/40 bg-ok/10 text-[10px] text-foreground">
                          {L("countersigned by", "وقّعه")} {d.countersignedBy}
                        </Badge>
                      ) : d.command === "dismiss" ? (
                        <Badge className="border-sev-medium/40 bg-sev-medium/10 text-[10px] text-foreground">
                          {L("awaiting countersign", "بانتظار التوقيع")}
                        </Badge>
                      ) : null}
                    </p>
                  </li>
                ))}
                {(payload?.decisions.length ?? 0) === 0 ? (
                  <li className="text-xs text-muted-foreground">{L("No decisions yet.", "لا قرارات بعد.")}</li>
                ) : null}
              </ul>
            </TabsContent>
            <TabsContent value="observations">
              <ul className="max-h-48 space-y-1.5 overflow-y-auto pe-1">
                {(payload?.observations ?? []).map((o) => (
                  <li key={o.id} className="rounded-md border bg-card p-2 font-mono text-xs">
                    <span>{o.runId}</span> · {o.ruleVersion} · <span title={o.evidenceHash}>{o.evidenceHash.slice(0, 12)}…</span> ·{" "}
                    <span className="text-muted-foreground">{iso(o.observedAt.slice(0, 16).replace("T", " "))}</span>
                  </li>
                ))}
                {(payload?.observations.length ?? 0) === 0 ? (
                  <li className="text-xs text-muted-foreground">{L("No observations recorded.", "لا ملاحظات مسجلة.")}</li>
                ) : null}
              </ul>
            </TabsContent>
            <TabsContent value="timeline">
              <ol className="max-h-48 space-y-1 overflow-y-auto pe-1">
                {(payload?.events ?? []).map((ev) => (
                  <li key={ev.seq} className="flex flex-wrap items-baseline gap-2 text-xs">
                    <span className="font-mono text-[10px] text-muted-foreground">#{iso(String(ev.seq))}</span>
                    <span className="font-medium">{ev.type}</span>
                    <span className="text-muted-foreground">{ev.actor}</span>
                    <span className="ms-auto font-mono text-[10px] text-muted-foreground">{iso(ev.at.slice(0, 16).replace("T", " "))}</span>
                  </li>
                ))}
                {(payload?.events.length ?? 0) === 0 ? (
                  <li className="text-xs text-muted-foreground">{L("No events yet.", "لا أحداث بعد.")}</li>
                ) : null}
              </ol>
            </TabsContent>
            <TabsContent value="siblings">
              <ul className="max-h-48 space-y-1.5 overflow-y-auto pe-1">
                {(payload?.siblings ?? []).map((s) => (
                  <li key={s.exceptionKey}>
                    <button
                      type="button"
                      onClick={() => setSelectedException(s.exceptionKey)}
                      className="flex min-h-9 w-full items-center gap-2 rounded-md border bg-card p-2 text-xs text-start hover:bg-accent"
                    >
                      <SeverityBadge severity={s.severity} />
                      <span className="font-mono">{s.displayId}</span>
                      <span className="truncate text-muted-foreground">{s.headlineEn}</span>
                      <span className="ms-auto shrink-0">
                        <StatusBadge status={s.status} />
                      </span>
                    </button>
                  </li>
                ))}
                {(payload?.siblings.length ?? 0) === 0 ? (
                  <li className="text-xs text-muted-foreground">{L("No sibling exceptions in this group.", "لا استثناءات شقيقة في هذه المجموعة.")}</li>
                ) : null}
              </ul>
            </TabsContent>
          </Tabs>
        </div>
      ) : null}
    </>
  );
}

export default ExceptionDrawer;
