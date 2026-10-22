"use client";

/**
 * Exception queue view (Task 2-b): filter toolbar, census table with J/K
 * keyboard navigation (shell dispatches "mizan-queue-nav" events), bulk
 * decisions with preview + typed confirmation + 10-second undo, and the
 * no-run / too-strict-filters empty states. Data via TanStack Query over
 * GET /api/v1/exceptions; bulk via POST /api/v1/exceptions/bulk.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eraser, EyeOff, Flag, Loader2, PauseCircle, Play, Search, Undo2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ApiError, api, useAppStore, v1 } from "@/lib/client/store";
import { useI18n } from "@/lib/i18n/use-i18n";
import { EmptyState, ErrorState, LoadingSkeleton, SeverityBadge, StatusBadge } from "@/components/mizan/primitives";
import type { ExceptionStatus, Severity } from "@/lib/contracts";
import { cn } from "@/lib/utils";

interface QueueItem {
  exceptionKey: string;
  displayId: string;
  txnId: string;
  ruleId: string;
  clauseId: string;
  ruleVersion: string;
  family: string;
  severity: Severity;
  status: ExceptionStatus;
  version: number;
  headlineEn: string;
  headlineAr: string;
  ownerTeam: string;
  ackDueAt: string | null;
  resolveDueAt: string | null;
  heldReason: string | null;
  noLongerDetected: boolean;
  groupKey: string;
  createdAt: string;
}

interface QueueResponse {
  items: QueueItem[];
  nextCursor: string | null;
  total: number;
}

interface RunsList {
  items: { id: string }[];
}

interface BulkPreviewResponse {
  preview: true;
  eligible: { exceptionKey: string; displayId: string; severity: Severity; headlineEn: string }[];
  excluded: { exceptionKey: string; reason: string }[];
  confirmTextRequired: string;
}

interface BulkAppliedResponse {
  ok: true;
  bulkId: string;
  applied: number;
  excluded: { exceptionKey: string; reason: string }[];
  undoAvailableForMs: number;
}

interface BulkUndoResponse {
  ok: true;
  undone: number;
}

type BulkResponse = BulkPreviewResponse | BulkAppliedResponse | BulkUndoResponse;

type BulkCommand = "dismiss" | "triage";

interface SelState {
  qs: string;
  keys: Set<string>;
  capWarn: boolean;
}

const EMPTY_KEYS: Set<string> = new Set();

const CAP = 200;
const SEVERITIES: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
const STATUSES: ExceptionStatus[] = [
  "NEW", "TRIAGED", "ASSIGNED", "IN_PROGRESS", "PENDING_VERIFICATION",
  "CLOSED", "DISMISSED", "ACCEPTED_RISK", "DUPLICATE", "REOPENED",
];

const CATEGORIES: { value: string; en: string; ar: string }[] = [
  { value: "false_positive", en: "False positive", ar: "إنذار كاذب" },
  { value: "duplicate_handled", en: "Duplicate handled", ar: "تكرار تمت معالجته" },
  { value: "data_corrected", en: "Data corrected", ar: "تم تصحيح البيانات" },
  { value: "other", en: "Other", ar: "أخرى" },
];

/** api() reuses RequestInit typing; JSON object bodies are stringified inside api(), so cast here. */
const asBody = (body: unknown): BodyInit => body as BodyInit;

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

export function QueueView() {
  const { t, locale, iso } = useI18n();
  const { setSelectedException, queueIndex, setQueueIndex } = useAppStore();
  const qc = useQueryClient();
  const L = useCallback((en: string, ar: string): string => (locale === "ar" ? ar : en), [locale]);

  // ── Filters ──────────────────────────────────────────────────────────────
  const [sev, setSev] = useState<Set<Severity>>(() => new Set());
  const [status, setStatus] = useState<string>("open");
  const [ruleId, setRuleId] = useState("");
  const [ownerTeam, setOwnerTeam] = useState("");
  const [q, setQ] = useState("");
  const dRuleId = useDebouncedValue(ruleId, 300);
  const dOwnerTeam = useDebouncedValue(ownerTeam, 300);
  const dQ = useDebouncedValue(q, 300);

  const qs = useMemo(() => {
    const p = new URLSearchParams({ limit: "100", open: status === "open" ? "true" : "false" });
    if (status !== "open" && status !== "all") p.set("status", status);
    if (sev.size > 0) p.set("severity", [...sev].join(","));
    if (dRuleId.trim()) p.set("ruleId", dRuleId.trim());
    if (dOwnerTeam.trim()) p.set("ownerTeam", dOwnerTeam.trim());
    if (dQ.trim()) p.set("q", dQ.trim());
    return p.toString();
  }, [status, sev, dRuleId, dOwnerTeam, dQ]);

  const filtersActive = sev.size > 0 || status !== "open" || ruleId.trim() !== "" || ownerTeam.trim() !== "" || q.trim() !== "";

  // ── Bulk selection — scoped to the current filter set (derived, no reset effect) ──
  const [selState, setSelState] = useState<SelState>(() => ({ qs, keys: new Set<string>(), capWarn: false }));
  const sel = selState.qs === qs ? selState.keys : EMPTY_KEYS;
  const capWarn = selState.qs === qs ? selState.capWarn : false;
  const setSel = (keys: Set<string>, warn = false): void => setSelState({ qs, keys, capWarn: warn });
  const setCapWarn = (warn: boolean): void =>
    setSelState((prev) => ({ qs, keys: prev.qs === qs ? prev.keys : new Set<string>(), capWarn: warn }));

  const clearFilters = useCallback((): void => {
    setSev(new Set());
    setStatus("open");
    setRuleId("");
    setOwnerTeam("");
    setQ("");
    setCapWarn(false);
  }, [setCapWarn]);

  const toggleSev = (s: Severity): void => {
    setSev((prev) => {
      const n = new Set(prev);
      if (n.has(s)) n.delete(s);
      else n.add(s);
      return n;
    });
  };

  // ── Data ─────────────────────────────────────────────────────────────────
  const queue = useQuery<QueueResponse>({
    queryKey: ["exceptions", qs],
    queryFn: () => api<QueueResponse>(v1(`/exceptions?${qs}`)),
  });
  const runsLite = useQuery<RunsList>({
    queryKey: ["runs-lite"],
    queryFn: () => api<RunsList>(v1("/runs")),
    staleTime: 15_000,
  });

  const items = useMemo(() => queue.data?.items ?? [], [queue.data]);
  const total = queue.data?.total ?? 0;
  const hasRun = (runsLite.data?.items?.length ?? 0) > 0;

  const itemsRef = useRef<QueueItem[]>(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // Keep the highlighted index inside range when the list changes.
  useEffect(() => {
    if (queueIndex > Math.max(0, items.length - 1)) {
      setQueueIndex(Math.max(0, items.length - 1));
    }
  }, [items.length, queueIndex, setQueueIndex]);

  // J/K: the shell dispatches "mizan-queue-nav" with detail.dir (1 = down, -1 = up).
  useEffect(() => {
    const onNav = (e: Event): void => {
      if (document.querySelector('[role="dialog"]')) return; // drawer / dialogs own the keyboard then
      const dir = (e as CustomEvent<{ dir?: number }>).detail?.dir ?? 1;
      const max = Math.max(0, itemsRef.current.length - 1);
      const next = Math.min(max, Math.max(0, useAppStore.getState().queueIndex + dir));
      setQueueIndex(next);
    };
    window.addEventListener("mizan-queue-nav", onNav);
    return () => window.removeEventListener("mizan-queue-nav", onNav);
  }, [setQueueIndex]);

  // Enter opens the highlighted row (when focus is not inside a control).
  useEffect(() => {
    const onEnter = (e: KeyboardEvent): void => {
      if (e.key !== "Enter") return;
      if (document.querySelector('[role="dialog"]')) return;
      const el = e.target as HTMLElement | null;
      if (el && (["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(el.tagName) || el.isContentEditable)) return;
      const it = itemsRef.current[useAppStore.getState().queueIndex];
      if (it) {
        e.preventDefault();
        setSelectedException(it.exceptionKey);
      }
    };
    window.addEventListener("keydown", onEnter);
    return () => window.removeEventListener("keydown", onEnter);
  }, [setSelectedException]);

  // Scroll the highlighted row into view.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-queue-idx="${queueIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [queueIndex, items.length]);

  // Bulk-selection keys are derived against the current filter set, so no reset effect is needed.

  const onRowCheck = (key: string, checked: boolean | "indeterminate"): void => {
    if (checked === true) {
      if (sel.size >= CAP) {
        setCapWarn(true);
        return;
      }
      const n = new Set(sel);
      n.add(key);
      setSel(n);
    } else {
      const n = new Set(sel);
      n.delete(key);
      setSel(n);
    }
  };

  const allVisibleSelected = items.length > 0 && items.every((i) => sel.has(i.exceptionKey));
  const onAllCheck = (checked: boolean | "indeterminate"): void => {
    if (checked === true) {
      const keys = items.map((i) => i.exceptionKey);
      if (keys.length > CAP) {
        setSel(new Set(keys.slice(0, CAP)), true);
      } else {
        setSel(new Set(keys));
      }
    } else {
      setSel(new Set());
    }
  };

  // ── Start run (no-run empty state) ───────────────────────────────────────
  const startRunMut = useMutation({
    mutationFn: () =>
      api<{ runId: string }>(v1("/runs"), {
        method: "POST",
        body: asBody({ kind: "standard" }),
        headers: { "Idempotency-Key": crypto.randomUUID() },
      }),
    onSuccess: () => {
      toast({ title: L("Run started", "بدأ التشغيل"), description: L("The queue will fill as checks complete.", "ستُملأ القائمة عند اكتمال الفحوصات.") });
      void qc.invalidateQueries({ queryKey: ["exceptions"] });
      void qc.invalidateQueries({ queryKey: ["runs-lite"] });
    },
    onError: (e) =>
      toast({ variant: "destructive", title: t("common.error"), description: e instanceof Error ? e.message : L("Could not start the run.", "تعذر بدء التشغيل.") }),
  });

  // ── Bulk actions (preview → typed confirm → apply → undo) ────────────────
  const [bulkCmd, setBulkCmd] = useState<BulkCommand>("dismiss");
  const [bulkCat, setBulkCat] = useState("");
  const [bulkReason, setBulkReason] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] = useState<BulkPreviewResponse | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const reasonOk = !!bulkCat && bulkReason.trim().length >= 15;

  const [undo, setUndo] = useState<{ bulkId: string; endsAt: number; applied: number; command: BulkCommand } | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!undo) return;
    const id = window.setInterval(() => {
      if (Date.now() >= undo.endsAt) {
        window.clearInterval(id);
        setUndo(null);
      } else {
        setNowTick(Date.now());
      }
    }, 200);
    return () => window.clearInterval(id);
  }, [undo]);
  const undoSeconds = undo ? Math.max(0, Math.ceil(Math.max(0, undo.endsAt - nowTick) / 1000)) : 0;

  const bulkMut = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<BulkResponse>(v1("/exceptions/bulk"), { method: "POST", body: asBody(body) }),
    onSuccess: (res) => {
      if ("preview" in res && res.preview) {
        setPreview(res);
        setConfirmText("");
        setPreviewOpen(true);
        return;
      }
      if ("bulkId" in res && res.ok) {
        setPreviewOpen(false);
        setPreview(null);
        setSel(new Set());
        toast({
          title: L("Bulk action applied", "تم تطبيق الإجراء الجماعي"),
          description: L(`${res.applied} exceptions updated.`, `تم تحديث ${iso(String(res.applied))} استثناءً.`),
        });
        void qc.invalidateQueries({ queryKey: ["exceptions"] });
        if (res.undoAvailableForMs > 0) {
          setNowTick(Date.now());
          setUndo({ bulkId: res.bulkId, endsAt: Date.now() + res.undoAvailableForMs, applied: res.applied, command: bulkCmd });
        }
      }
    },
    onError: (e) =>
      toast({ variant: "destructive", title: t("common.error"), description: e instanceof Error ? e.message : L("Bulk action failed.", "فشل الإجراء الجماعي.") }),
  });

  const previewBulk = (): void => {
    bulkMut.mutate({ keys: [...sel], command: bulkCmd, reasonCategory: bulkCat, reasonText: bulkReason.trim() });
  };
  const confirmBulk = (): void => {
    if (!preview) return;
    bulkMut.mutate({ keys: [...sel], command: bulkCmd, reasonCategory: bulkCat, reasonText: bulkReason.trim(), confirmText });
  };

  const undoMut = useMutation({
    mutationFn: (bulkId: string) => api<BulkUndoResponse>(v1("/exceptions/bulk"), { method: "POST", body: asBody({ undoOf: bulkId }) }),
    onSuccess: (res) => {
      setUndo(null);
      toast({ title: L("Undone", "تم التراجع"), description: L(`${res.undone} exceptions restored.`, `تمت استعادة ${iso(String(res.undone))} استثناءً.`) });
      void qc.invalidateQueries({ queryKey: ["exceptions"] });
    },
    onError: (e) => {
      setUndo(null);
      toast({ variant: "destructive", title: t("common.error"), description: e instanceof Error ? e.message : L("Undo failed.", "فشل التراجع.") });
    },
  });

  // ── Render helpers ───────────────────────────────────────────────────────
  const dateOnly = (v: string | null): string => (v ? v.slice(0, 10) : "—");
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Dubai" }); // YYYY-MM-DD in Asia/Dubai
  const isOverdue = (v: string | null): boolean => !!v && v.slice(0, 10) < today;

  // ── States ───────────────────────────────────────────────────────────────
  if (queue.isPending || runsLite.isPending) {
    return (
      <section aria-label={t("queue.title")} className="space-y-4">
        <h1 className="text-lg font-semibold">{t("queue.title")}</h1>
        <LoadingSkeleton rows={8} />
      </section>
    );
  }

  if (queue.isError) {
    const err = queue.error;
    return (
      <section aria-label={t("queue.title")} className="space-y-4">
        <h1 className="text-lg font-semibold">{t("queue.title")}</h1>
        <ErrorState
          message={err instanceof Error ? err.message : L("Could not load the queue.", "تعذر تحميل القائمة.")}
          code={err instanceof ApiError ? err.code : undefined}
          onRetry={() => void queue.refetch()}
        />
      </section>
    );
  }

  if (items.length === 0) {
    if (!hasRun) {
      return (
        <section aria-label={t("queue.title")} className="space-y-4">
          <h1 className="text-lg font-semibold">{t("queue.title")}</h1>
          <div className="flex flex-col items-center gap-3 py-10">
            <EmptyState title={t("queue.empty.noRun")} icon={<Play className="h-8 w-8" aria-hidden />} />
            <Button onClick={() => startRunMut.mutate()} disabled={startRunMut.isPending} aria-busy={startRunMut.isPending}>
              {startRunMut.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
              {t("common.startRun")}
            </Button>
            {startRunMut.isError ? (
              <p className="text-xs text-destructive" role="alert">
                {startRunMut.error instanceof Error ? startRunMut.error.message : L("Could not start the run.", "تعذر بدء التشغيل.")}
              </p>
            ) : null}
          </div>
        </section>
      );
    }
    return (
      <section aria-label={t("queue.title")} className="space-y-4">
        <h1 className="text-lg font-semibold">{t("queue.title")}</h1>
        <div className="flex flex-col items-center gap-3 py-10">
          <EmptyState title={t("queue.empty")} hint={L("Try widening the severity, status or search filters.", "وسّع مرشحات الدرجة أو الحالة أو البحث.")} />
          <Button variant="outline" onClick={clearFilters}>
            <Eraser className="h-4 w-4" aria-hidden />
            {L("Clear filters", "مسح المرشحات")}
          </Button>
        </div>
      </section>
    );
  }

  // ── Main render ──────────────────────────────────────────────────────────
  return (
    <section aria-label={t("queue.title")} className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-lg font-semibold">{t("queue.title")}</h1>
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {L("Showing", "يُعرض")} {iso(String(items.length))} {L("of", "من")} {iso(String(total))} {L("exceptions", "استثناءً")}
        </p>
      </div>

      {/* Filter toolbar */}
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={L("Queue filters", "مرشحات القائمة")}>
        {SEVERITIES.map((s) => (
          <label
            key={s}
            className="inline-flex min-h-6 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-card px-2 py-0.5 text-xs hover:bg-accent"
          >
            <Checkbox className="size-4" checked={sev.has(s)} onCheckedChange={() => toggleSev(s)} aria-label={t(`severity.${s}`)} />
            {t(`severity.${s}`)}
          </label>
        ))}
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger aria-label={L("Status filter", "مرشح الحالة")} className="h-9 w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">{L("All open", "كل المفتوحة")}</SelectItem>
            <SelectItem value="all">{L("All statuses", "كل الحالات")}</SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {t(`status.${s}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={ruleId}
          onChange={(e) => setRuleId(e.target.value)}
          placeholder={L("Rule ID (R04)", "رقم القاعدة (R04)")}
          aria-label={L("Rule ID", "رقم القاعدة")}
          className="h-9 w-36"
        />
        <Input
          value={ownerTeam}
          onChange={(e) => setOwnerTeam(e.target.value)}
          placeholder={L("Owner team", "الفريق المالك")}
          aria-label={L("Owner team", "الفريق المالك")}
          className="h-9 w-48"
        />
        <div className="relative">
          <Search className="pointer-events-none absolute start-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={L("Search id, txn, headline…", "ابحث برقم أو عنوان…")}
            aria-label={L("Search", "بحث")}
            className="h-9 w-60 ps-8"
          />
        </div>
        {filtersActive ? (
          <Button size="sm" variant="ghost" onClick={clearFilters}>
            <Eraser className="h-4 w-4" aria-hidden />
            {L("Clear filters", "مسح المرشحات")}
          </Button>
        ) : null}
      </div>

      {/* Bulk action bar */}
      {sel.size > 0 ? (
        <div className="space-y-3 rounded-lg border border-hold/40 bg-hold/5 p-4" role="region" aria-label={L("Bulk actions", "إجراءات جماعية")}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="border-hold/40 bg-hold/15 text-foreground">
              {iso(String(sel.size))} {L("selected", "محدد")}
            </Badge>
            {capWarn ? (
              <span className="text-xs font-medium text-sev-high" role="alert">
                {L("Selection capped at 200 items.", "التحديد محدود بـ 200 عنصراً.")}
              </span>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              className="ms-auto"
              onClick={() => {
                setSel(new Set());
              }}
            >
              {L("Clear selection", "مسح التحديد")}
            </Button>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="bulk-cmd">{L("Action", "الإجراء")}</Label>
              <Select value={bulkCmd} onValueChange={(v) => setBulkCmd(v === "dismiss" ? "dismiss" : "triage")}>
                <SelectTrigger id="bulk-cmd" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="dismiss">{t("decision.dismiss")}</SelectItem>
                  <SelectItem value="triage">{t("decision.triage")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bulk-cat">{L("Reason category", "فئة السبب")}</Label>
              <Select value={bulkCat} onValueChange={setBulkCat}>
                <SelectTrigger id="bulk-cat" className="w-full">
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
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bulk-reason">{L("Reason", "السبب")}</Label>
            <Textarea
              id="bulk-reason"
              value={bulkReason}
              onChange={(e) => setBulkReason(e.target.value)}
              className="min-h-16"
              placeholder={L("At least 15 characters — applied to every selected exception.", "15 حرفاً على الأقل — يُطبق على كل الاستثناءات المحددة.")}
            />
            <p className={cn("text-xs", bulkReason.trim().length >= 15 ? "text-muted-foreground" : "text-sev-high")}>
              {iso(String(bulkReason.trim().length))}/15
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={previewBulk} disabled={!reasonOk || bulkMut.isPending} aria-busy={bulkMut.isPending}>
              {bulkMut.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {bulkMut.isPending ? L("Working…", "جارٍ العمل…") : L("Preview", "معاينة")}
            </Button>
            <span className="text-xs text-muted-foreground">
              {L("High and Critical exceptions are never bulk-dismissed.", "لا تُستبعد الاستثناءات الحرجة والعالية جماعياً.")}
            </span>
          </div>
        </div>
      ) : null}

      {/* Queue table */}
      <div ref={scrollRef} className="max-h-[70vh] overflow-auto rounded-lg border bg-card">
        <Table aria-label={t("queue.title")}>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="sticky top-0 z-10 w-10 bg-card px-2">
                <Checkbox
                  className="size-6"
                  checked={allVisibleSelected ? true : sel.size > 0 ? "indeterminate" : false}
                  onCheckedChange={onAllCheck}
                  aria-label={L("Select all visible", "تحديد كل الظاهر")}
                />
              </TableHead>
              <TableHead className="sticky top-0 z-10 bg-card">{L("Severity", "الدرجة")}</TableHead>
              <TableHead className="sticky top-0 z-10 bg-card">ID</TableHead>
              <TableHead className="sticky top-0 z-10 bg-card">{L("Headline", "العنوان")}</TableHead>
              <TableHead className="sticky top-0 z-10 bg-card">{L("Rule", "القاعدة")}</TableHead>
              <TableHead className="sticky top-0 z-10 bg-card">{L("Status", "الحالة")}</TableHead>
              <TableHead className="sticky top-0 z-10 bg-card">{L("Owner team", "الفريق المالك")}</TableHead>
              <TableHead className="sticky top-0 z-10 bg-card">{L("Due", "الاستحقاق")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((it, i) => {
              const active = i === queueIndex;
              const overdue = isOverdue(it.resolveDueAt);
              const headline = locale === "ar" ? it.headlineAr : it.headlineEn;
              return (
                <TableRow
                  key={it.exceptionKey}
                  data-queue-idx={i}
                  aria-selected={active}
                  tabIndex={0}
                  className={cn("cursor-pointer", active && "bg-accent", sel.has(it.exceptionKey) && "bg-secondary/50")}
                  onClick={() => setSelectedException(it.exceptionKey)}
                  onFocus={() => setQueueIndex(i)}
                  onKeyDown={(e) => {
                    const el = e.target as HTMLElement;
                    if (["BUTTON", "INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedException(it.exceptionKey);
                    }
                  }}
                >
                  <TableCell className="px-2" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      className="size-6"
                      checked={sel.has(it.exceptionKey)}
                      onCheckedChange={(c) => onRowCheck(it.exceptionKey, c)}
                      aria-label={L(`Select ${it.displayId}`, `تحديد ${it.displayId}`)}
                    />
                  </TableCell>
                  <TableCell>
                    <SeverityBadge severity={it.severity} />
                  </TableCell>
                  <TableCell className="font-mono text-xs" title={it.txnId}>
                    {it.displayId}
                  </TableCell>
                  <TableCell className="max-w-72">
                    <div className="truncate text-sm" title={headline}>
                      {headline}
                    </div>
                    {it.heldReason || it.noLongerDetected ? (
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {it.heldReason ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge className="border-hold/40 bg-hold/10 text-foreground">
                                <PauseCircle className="h-3 w-3" aria-hidden /> {L("Held", "معلّق")}
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-64">
                              <p className="text-xs">{it.heldReason}</p>
                            </TooltipContent>
                          </Tooltip>
                        ) : null}
                        {it.noLongerDetected ? (
                          <Badge variant="outline">
                            <EyeOff className="h-3 w-3" aria-hidden /> {L("no longer detected", "لم يُكتشف مجدداً")}
                          </Badge>
                        ) : null}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs">
                    {it.ruleId} · {it.clauseId}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={it.status} />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{it.ownerTeam}</TableCell>
                  <TableCell className={cn("whitespace-nowrap font-mono text-xs", overdue && "font-medium text-sev-critical")}>
                    {overdue ? <Flag className="me-1 inline h-3 w-3" aria-hidden /> : null}
                    {dateOnly(it.resolveDueAt)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* Bulk preview + typed confirmation dialog */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-lg" aria-label={L("Bulk action preview", "معاينة الإجراء الجماعي")}>
          <DialogHeader>
            <DialogTitle>
              {L("Bulk", "إجراء جماعي")} — {t(`decision.${bulkCmd}`)}
            </DialogTitle>
            <DialogDescription>{L("Review what will change before you confirm.", "راجع ما سيتم تغييره قبل التأكيد.")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {L("Eligible", "المؤهلة")} ({iso(String(preview?.eligible.length ?? 0))})
              </p>
              <ul className="mt-1 max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
                {(preview?.eligible ?? []).map((e2) => (
                  <li key={e2.exceptionKey} className="flex items-center gap-2 text-xs">
                    <SeverityBadge severity={e2.severity} />
                    <span className="font-mono">{e2.displayId}</span>
                    <span className="truncate text-muted-foreground">{e2.headlineEn}</span>
                  </li>
                ))}
                {preview && preview.eligible.length === 0 ? (
                  <li className="text-xs text-muted-foreground">{L("Nothing is eligible.", "لا شيء مؤهل.")}</li>
                ) : null}
              </ul>
            </div>
            {preview && preview.excluded.length > 0 ? (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {L("Excluded", "المستبعدة")} ({iso(String(preview.excluded.length))})
                </p>
                <ul className="mt-1 max-h-48 space-y-1 overflow-y-auto rounded-md border border-sev-medium/40 p-2">
                  {preview.excluded.map((x) => (
                    <li key={x.exceptionKey} className="text-xs">
                      <span className="font-mono">{x.exceptionKey.slice(0, 18)}</span>
                      <span className="ms-2 text-muted-foreground">{x.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="bulk-confirm">{L("Typed confirmation", "تأكيد بكتابة نص")}</Label>
              <Input
                id="bulk-confirm"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                className="font-mono"
                autoComplete="off"
                placeholder={preview?.confirmTextRequired ?? "BULK 0"}
              />
              <p className="text-xs text-muted-foreground">
                {L("Type", "اكتب")}{" "}
                <code className="rounded bg-secondary px-1.5 py-0.5 font-mono">{preview?.confirmTextRequired ?? "BULK 0"}</code>{" "}
                {L("to confirm this bulk action.", "لتأكيد هذا الإجراء الجماعي.")}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewOpen(false)} disabled={bulkMut.isPending}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={confirmBulk}
              disabled={!preview || preview.eligible.length === 0 || confirmText !== preview.confirmTextRequired || bulkMut.isPending}
              aria-busy={bulkMut.isPending}
            >
              {bulkMut.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {bulkMut.isPending ? L("Working…", "جارٍ العمل…") : t("common.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Undo window (10 s) */}
      {undo ? (
        <div
          className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] end-4 z-50 flex items-center gap-3 rounded-lg border bg-card p-3 shadow-lg"
          role="status"
        >
          <p className="text-sm">
            {L(`Bulk ${undo.command} applied to ${undo.applied}.`, `تم تطبيق "${undo.command}" على ${iso(String(undo.applied))} استثناءً.`)}{" "}
            <span className="font-mono text-xs text-muted-foreground">{iso(String(undoSeconds))}s</span>
          </p>
          <Button size="sm" variant="outline" onClick={() => undoMut.mutate(undo.bulkId)} disabled={undoMut.isPending} aria-busy={undoMut.isPending}>
            {undoMut.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Undo2 className="h-4 w-4" aria-hidden />}
            {L("Undo", "تراجع")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

export default QueueView;
