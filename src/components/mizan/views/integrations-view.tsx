"use client";

/**
 * Integrations (stubs as seams): the catalog of every boundary between MIZAN
 * and the outside world. Live Emirates systems are intentionally NOT connected
 * (synthetic-data red line) — each card documents the production adapter, the
 * config keys that flip it on, and its guardrails. Dry-runs exercise the stub
 * transport and are audited server-side. Write-back can never mutate
 * automatically: proposals are rendered for a human to apply.
 */

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  BadgeCheck,
  CircleCheck,
  CircleMinus,
  Database,
  Droplets,
  FlaskConical,
  KeyRound,
  Landmark,
  Lock,
  Mail,
  Plug,
  ScrollText,
  ShieldCheck,
  Undo2,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/mizan/primitives";
import { api, v1, useAppStore, ApiError } from "@/lib/client/store";
import { useI18n } from "@/lib/i18n/use-i18n";
import { cn } from "@/lib/utils";

interface ConfigKey {
  key: string;
  purpose: string;
  present: boolean;
  secret: boolean;
}

interface Integration {
  id: string;
  label: string;
  labelAr: string;
  category: string;
  production: string;
  productionAr: string;
  mode: string;
  liveConfigured: boolean;
  canWrite: boolean;
  guardrails: string[];
  guardrailsAr: string[];
  configKeys: ConfigKey[];
  health: { ok: boolean; detail: string; mode: string };
}

interface IntegrationsResponse {
  syntheticOnly: boolean;
  note: string;
  integrations: Integration[];
}

interface DryRunResult {
  id: string;
  elapsedMs: number;
  ok: boolean;
  detail: string;
  recordCount?: number;
  shapeKeys: string[];
  sample?: Record<string, unknown> | null;
}

const CATEGORY_ICON: Record<string, React.ReactNode> = {
  hrms: <Database className="h-4 w-4" aria-hidden />,
  finance: <Landmark className="h-4 w-4" aria-hidden />,
  writeback: <Undo2 className="h-4 w-4" aria-hidden />,
  identity: <KeyRound className="h-4 w-4" aria-hidden />,
  notify: <Mail className="h-4 w-4" aria-hidden />,
  storage: <ScrollText className="h-4 w-4" aria-hidden />,
  cache: <Droplets className="h-4 w-4" aria-hidden />,
};

export default function IntegrationsView() {
  const { t, locale, iso } = useI18n();
  const actor = useAppStore((s) => s.actor);
  const [openSample, setOpenSample] = useState<string | null>(null);

  const { data, isLoading, isError, error, refetch } = useQuery<IntegrationsResponse>({
    queryKey: ["integrations"],
    queryFn: () => api<IntegrationsResponse>(v1("/integrations")),
  });

  const dry = useMutation<DryRunResult, unknown, { id: string }>({
    mutationFn: ({ id }) =>
      api<DryRunResult>(v1(`/integrations/${id}/dry-run`), { method: "POST", body: {} }),
    onSuccess: (r) => setOpenSample(r.id),
  });

  if (isLoading) {
    return (
      <div className="space-y-4" aria-busy>
        <LoadingSkeleton rows={2} />
        <div className="grid gap-4 md:grid-cols-2">
          <LoadingSkeleton rows={4} />
          <LoadingSkeleton rows={4} />
        </div>
      </div>
    );
  }
  if (isError || !data) {
    return <ErrorState message={error instanceof Error ? error.message : "integrations unavailable"} onRetry={() => refetch()} />;
  }

  const writeback = data.integrations.find((i) => i.id === "writeback");
  const others = data.integrations.filter((i) => i.id !== "writeback");

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-bold tracking-tight">{t("integrations.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("integrations.subtitle")}</p>
      </header>

      <Alert className="border-brand/30 bg-brand/5">
        <Plug className="h-4 w-4 text-brand" aria-hidden />
        <AlertTitle className="flex items-center gap-2">
          {t("integrations.banner").split(".")[0]}.
          <Badge variant="outline" className="border-brand/40 bg-brand/10 text-brand">
            {t("app.synthetic")}
          </Badge>
        </AlertTitle>
        <AlertDescription>{locale === "ar" ? t("integrations.banner") : data.note}</AlertDescription>
      </Alert>

      {writeback ? (
        <WritebackSpotlight integration={writeback} onDryRun={() => dry.mutate({ id: "writeback" })} dryState={dry} openSample={openSample === "writeback"} />
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        {others.map((it) => (
          <IntegrationCard
            key={it.id}
            integration={it}
            locale={locale}
            dryState={dry}
            openSample={openSample === it.id}
            onToggleSample={() => setOpenSample((cur) => (cur === it.id ? null : it.id))}
            onDryRun={() => dry.mutate({ id: it.id })}
          />
        ))}
      </div>

      <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5 text-ok" aria-hidden />
        {t("integrations.audited")} · <span className="font-mono">{iso("integration.dry_run")}</span>
      </p>
      <span className="sr-only" aria-live="polite">
        {dry.isPending ? t("integrations.dryRunning") : dry.isSuccess ? t("integrations.dryRunOk") : ""}
      </span>
      <span className="hidden">{actor}</span>
    </div>
  );
}

function ModeBadge({ mode, locale }: { mode: string; locale: string }) {
  const { t } = useI18n();
  const isLive = mode === "live" || mode === "human_approved_api";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold tracking-wide",
        isLive ? "border-sev-high/40 bg-sev-high/10 text-foreground" : "border-dashed border-hold/60 bg-hold/5 text-foreground"
      )}
    >
      {isLive ? <BadgeCheck className="h-3 w-3" aria-hidden /> : <FlaskConical className="h-3 w-3" aria-hidden />}
      {isLive ? t("integrations.live") : t("integrations.stub")}
      <span className="sr-only">{mode}</span>
      <span aria-hidden className="font-mono font-normal opacity-70">{locale === "ar" ? "" : mode}</span>
    </span>
  );
}

function IntegrationCard({
  integration: it,
  locale,
  dryState,
  openSample,
  onToggleSample,
  onDryRun,
}: {
  integration: Integration;
  locale: string;
  dryState: { isPending: boolean; isError: boolean; error: unknown; data?: DryRunResult; variables?: { id: string } };
  openSample: boolean;
  onToggleSample: () => void;
  onDryRun: () => void;
}) {
  const { t, iso } = useI18n();
  const running = dryState.isPending && dryState.variables?.id === it.id;
  const result = dryState.data?.id === it.id ? dryState.data : undefined;
  const failed = dryState.isError && dryState.variables?.id === it.id;

  return (
    <Card className="flex flex-col gap-0 overflow-hidden border-border py-0">
      <CardHeader className="border-b bg-sand/40 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-background text-brand" aria-hidden>
              {CATEGORY_ICON[it.category] ?? <Plug className="h-4 w-4" />}
            </span>
            <div className="min-w-0">
              <CardTitle className="truncate text-sm">{locale === "ar" ? it.labelAr : it.label}</CardTitle>
              <CardDescription className="truncate font-mono text-[11px]">{it.id}</CardDescription>
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <ModeBadge mode={it.mode} locale={locale} />
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              {it.canWrite ? <Lock className="h-3 w-3 text-hold" aria-hidden /> : <CircleCheck className="h-3 w-3 text-ok" aria-hidden />}
              {it.canWrite ? t("integrations.canWrite") : t("integrations.readOnly")}
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3 p-4">
        <section>
          <p className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t("integrations.production")}</p>
          <p className="text-sm leading-relaxed">{locale === "ar" ? it.productionAr : it.production}</p>
        </section>

        <section>
          <p className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t("integrations.guardrails")}</p>
          <ul className="space-y-1">
            {(locale === "ar" ? it.guardrailsAr : it.guardrails).map((g) => (
              <li key={g} className="flex items-start gap-1.5 text-xs">
                <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0 text-ok" aria-hidden />
                <span>{g}</span>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <p className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t("integrations.configKeys")}</p>
          <ul className="space-y-1 font-mono text-[11px]">
            {it.configKeys.map((k) => (
              <li key={k.key} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className={cn("inline-block h-1.5 w-1.5 rounded-full", k.present ? "bg-ok" : "bg-border")} aria-hidden />
                <span className="font-semibold">{k.key}</span>
                <span className="text-muted-foreground">{k.purpose}</span>
                {k.secret ? (
                  <span className="rounded border border-border px-1 text-[10px] text-muted-foreground">{t("integrations.secret")}</span>
                ) : (
                  <span className={cn("rounded border px-1 text-[10px]", k.present ? "border-ok/40 text-ok" : "border-border text-muted-foreground")}>
                    {k.present ? t("integrations.set") : t("integrations.unset")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>

        <p className="rounded-md border border-border bg-secondary/60 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
          {it.health.detail}
        </p>

        <div className="mt-auto flex items-center gap-2 pt-1">
          <Button size="sm" variant="outline" onClick={onDryRun} disabled={running} aria-busy={running}>
            {running ? <FlaskConical className="me-1 h-3.5 w-3.5 animate-pulse" aria-hidden /> : <FlaskConical className="me-1 h-3.5 w-3.5" aria-hidden />}
            {running ? t("integrations.dryRunning") : t("integrations.dryRun")}
          </Button>
          {result ? (
            <Button size="sm" variant="ghost" onClick={onToggleSample} aria-expanded={openSample}>
              {openSample ? <CircleMinus className="me-1 h-3.5 w-3.5" aria-hidden /> : <CircleCheck className="me-1 h-3.5 w-3.5 text-ok" aria-hidden />}
              {t("integrations.dryRunOk")} · {iso(`${dryState.data?.elapsedMs ?? 0}ms`)}
            </Button>
          ) : null}
          {failed ? (
            <span className="text-xs text-destructive">{t("common.error")}</span>
          ) : null}
        </div>

        {result && openSample ? (
          <div className="space-y-2 rounded-md border border-border bg-background p-3">
            <p className="text-xs text-muted-foreground">{result.detail}</p>
            {typeof result.recordCount === "number" ? (
              <p className="text-xs">
                <span className="font-mono font-semibold">{iso(String(result.recordCount))}</span>{" "}
                <span className="text-muted-foreground">{t("integrations.recordCount")}</span>
              </p>
            ) : null}
            <div>
              <p className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t("integrations.shape")}</p>
              <div className="flex flex-wrap gap-1">
                {result.shapeKeys.map((k) => (
                  <code key={k} className="rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px]">
                    {k}
                  </code>
                ))}
              </div>
            </div>
            {result.sample ? (
              <div>
                <p className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t("integrations.sample")}</p>
                <pre className="max-h-44 overflow-auto rounded-md border border-border bg-secondary p-2 font-mono text-[10px] leading-relaxed">
                  {JSON.stringify(result.sample, null, 2)}
                </pre>
              </div>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function WritebackSpotlight({
  integration: it,
  onDryRun,
  dryState,
  openSample,
}: {
  integration: Integration;
  onDryRun: () => void;
  dryState: { isPending: boolean; isError: boolean; data?: DryRunResult };
  openSample: boolean;
}) {
  const { t, locale, iso } = useI18n();
  const running = dryState.isPending;
  const result = dryState.data?.id === "writeback" ? dryState.data : undefined;

  return (
    <Card className="border-brand/30 bg-gradient-to-br from-brand/5 via-background to-background py-0">
      <CardHeader className="pb-3 pt-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-md border border-brand/30 bg-brand/10 text-brand" aria-hidden>
              <Undo2 className="h-4 w-4" />
            </span>
            <CardTitle className="text-sm">{locale === "ar" ? it.labelAr : it.label}</CardTitle>
            <ModeBadge mode={it.mode} locale={locale} />
          </div>
          <Button size="sm" variant="outline" onClick={onDryRun} disabled={running} aria-busy={running}>
            <FlaskConical className="me-1 h-3.5 w-3.5" aria-hidden />
            {running ? t("integrations.dryRunning") : t("integrations.dryRun")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pb-5">
        <Alert className="border-hold/40 bg-hold/5">
          <Lock className="h-4 w-4 text-hold" aria-hidden />
          <AlertTitle>{t("integrations.humanNote")}</AlertTitle>
          <AlertDescription>
            <ul className="mt-1 space-y-1">
              {(locale === "ar" ? it.guardrailsAr : it.guardrails).map((g) => (
                <li key={g} className="flex items-start gap-1.5 text-xs">
                  <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0 text-ok" aria-hidden />
                  <span>{g}</span>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
        {result && openSample ? (
          <div className="space-y-2 rounded-md border border-border bg-background p-3">
            <p className="text-xs text-muted-foreground">{result.detail}</p>
            <p className="text-xs">
              <span className="text-muted-foreground">{t("integrations.dryRunOk")} · </span>
              <span className="font-mono">{iso(`${result.elapsedMs}ms`)}</span>
            </p>
            {result.sample ? (
              <pre className="max-h-44 overflow-auto rounded-md border border-border bg-secondary p-2 font-mono text-[10px] leading-relaxed">
                {JSON.stringify(result.sample, null, 2)}
              </pre>
            ) : null}
          </div>
        ) : null}
        {dryState.isError ? <p className="text-xs text-destructive">{t("common.error")}</p> : null}
      </CardContent>
    </Card>
  );
}

/* Empty state guard: registry always returns ≥7 adapters; this is future-proofing. */
export function IntegrationsEmpty() {
  return <EmptyState title="No integrations registered" />;
}
