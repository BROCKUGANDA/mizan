"use client";

/**
 * Shared SADU primitives: severity/status badges (glyph + label, never colour
 * alone — §13/§31), mode chip, banners, empty/error/loading states.
 */

import { AlertTriangle, CircleAlert, CircleCheck, CircleMinus, CircleSlash, Info, OctagonAlert, PauseCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/use-i18n";
import type { Severity, ExceptionStatus } from "@/lib/contracts";

const SEV_STYLES: Record<Severity, { chip: string; icon: React.ReactNode }> = {
  CRITICAL: {
    chip: "bg-sev-critical/10 text-sev-critical border-sev-critical/30",
    icon: <OctagonAlert className="h-3.5 w-3.5" aria-hidden />,
  },
  HIGH: {
    chip: "bg-sev-high/10 text-sev-high border-sev-high/30",
    icon: <CircleAlert className="h-3.5 w-3.5" aria-hidden />,
  },
  MEDIUM: {
    chip: "bg-sev-medium/15 text-foreground border-sev-medium/40",
    icon: <AlertTriangle className="h-3.5 w-3.5" aria-hidden />,
  },
  LOW: {
    chip: "bg-sev-low/10 text-foreground border-sev-low/30",
    icon: <CircleMinus className="h-3.5 w-3.5" aria-hidden />,
  },
};

export function SeverityBadge({ severity, className }: { severity: Severity; className?: string }) {
  const { t } = useI18n();
  const s = SEV_STYLES[severity];
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium", s.chip, className)}
      role="status"
      aria-label={`${t(`severity.${severity}`)} severity`}
    >
      {s.icon}
      <span>{t(`severity.${severity}`)}</span>
    </span>
  );
}

const STATUS_ICON: Partial<Record<ExceptionStatus, React.ReactNode>> = {
  CLOSED: <CircleCheck className="h-3.5 w-3.5 text-ok" aria-hidden />,
  DISMISSED: <CircleSlash className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />,
  ACCEPTED_RISK: <PauseCircle className="h-3.5 w-3.5 text-hold" aria-hidden />,
  REOPENED: <AlertTriangle className="h-3.5 w-3.5 text-sev-high" aria-hidden />,
};

export function StatusBadge({ status, className }: { status: ExceptionStatus; className?: string }) {
  const { t } = useI18n();
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 text-xs", className)}>
      {STATUS_ICON[status]}
      <span>{t(`status.${status}`)}</span>
    </span>
  );
}

const MODE_STYLES: Record<string, string> = {
  M0: "border-ok/40 bg-ok/10 text-foreground",
  M1: "border-hold/40 bg-hold/10 text-foreground",
  M2: "border-sev-medium/50 bg-sev-medium/10 text-foreground",
  M3: "border-sev-high/40 bg-sev-high/10 text-foreground",
  M4: "border-sev-high/50 bg-sev-high/15 text-foreground",
  M5: "border-sev-critical/50 bg-sev-critical/15 text-sev-critical",
};

export function ModeChip({ mode, className }: { mode: string; className?: string }) {
  const { t } = useI18n();
  if (mode === "M0") {
    return (
      <span className={cn("inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-2.5 py-1 text-xs text-muted-foreground", className)} title="M0">
        <CircleCheck className="h-3.5 w-3.5 text-ok" aria-hidden /> M0 · {t("mode.M0")}
      </span>
    );
  }
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium", MODE_STYLES[mode], className)} title={mode}>
      <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> {mode} · {t(`mode.${mode}`)}
    </span>
  );
}

export function ModeBanner({ mode, banner, reason, operator }: { mode: string; banner: string; reason?: string | null; operator?: string | null }) {
  if (mode === "M0" || !banner) return null;
  const danger = mode === "M5";
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2 border-b px-4 py-2 text-sm",
        danger ? "border-sev-critical/30 bg-sev-critical/10 text-sev-critical" : "border-hold/30 bg-hold/10 text-foreground"
      )}
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div>
        <p className="font-medium">{banner}</p>
        {reason ? (
          <p className="text-xs opacity-80">
            {operator ? `Set by ${operator}. ` : ""}Reason: {reason}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function EmptyState({ title, hint, icon }: { title: string; hint?: string; icon?: React.ReactNode }) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-8 text-center" role="status">
      <div className="sadu-band w-24" aria-hidden />
      <div className="text-muted-foreground">{icon ?? <CircleMinus className="h-8 w-8" aria-hidden />}</div>
      <p className="text-sm font-medium">{title}</p>
      {hint ? <p className="max-w-sm text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function ErrorState({ message, code, onRetry }: { message: string; code?: string; onRetry?: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex min-h-48 flex-col items-center justify-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-8 text-center" role="alert">
      <OctagonAlert className="h-8 w-8 text-destructive" aria-hidden />
      <p className="text-sm font-medium">{t("common.error")}</p>
      <p className="max-w-md text-xs text-muted-foreground">{message}</p>
      {code ? <p className="font-mono text-[10px] text-muted-foreground">{code}</p> : null}
      {onRetry ? (
        <button onClick={onRetry} className="mt-1 rounded-md border border-border bg-secondary px-3 py-1.5 text-xs font-medium hover:bg-accent">
          {t("common.retry")}
        </button>
      ) : null}
    </div>
  );
}

export function SkeletonBlock({ className }: { className?: string }) {
  return <div className={cn("mizan-skeleton rounded-md", className)} aria-hidden />;
}

export function LoadingSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2" role="status" aria-label="loading">
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonBlock key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

export function StaleLabel({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-sev-medium/40 bg-sev-medium/10 px-1.5 py-0.5 text-[11px]">
      <PauseCircle className="h-3 w-3" aria-hidden /> {label}
    </span>
  );
}

export function ShadowChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-hold/60 bg-hold/5 px-2 py-0.5 text-[11px] text-foreground">
      {label}
    </span>
  );
}

export function JudgeRibbon({ label }: { label: string }) {
  return (
    <span className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full bg-brand px-2.5 py-1 text-[11px] font-semibold text-primary-foreground">
      {label}
    </span>
  );
}
