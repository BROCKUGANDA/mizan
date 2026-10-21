"use client";

/**
 * Pattern alerts (§18): advisory signals from detectors (P01..P10) that suggest
 * a *possible* new rule. They never appear in exports or routing, never block
 * anything — a human reviews and either promotes one to a draft rule, keeps it
 * monitored, or dismisses it. Review actions are audited server-side.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleCheck,
  CircleMinus,
  Eye,
  Loader2,
  ShieldQuestion,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/mizan/primitives";
import { toast } from "@/hooks/use-toast";
import { api, v1, ApiError , useAppStore } from "@/lib/client/store";
import { useI18n } from "@/lib/i18n/use-i18n";
import { cn } from "@/lib/utils";

interface PatternItem {
  id: string;
  patternId: string;
  title: string;
  neutralText: string;
  detailJson: string;
  status: "open" | "monitored" | "promoted" | "dismissed";
  reviewedBy: string | null;
  reviewedAt: string | null;
}

interface PatternsResponse {
  items: PatternItem[];
  advisory: boolean;
  note: string;
}

const STATUS_STYLES: Record<PatternItem["status"], string> = {
  open: "border-sev-medium/50 bg-sev-medium/10 text-foreground",
  monitored: "border-hold/40 bg-hold/10 text-foreground",
  promoted: "border-ok/40 bg-ok/10 text-foreground",
  dismissed: "border-border bg-secondary text-muted-foreground",
};

/** api() declares `body` via `RequestInit & { body?: unknown }` — the intersection collapses to
 * BodyInit, so JSON payloads go through this adapter (api() JSON-encodes them itself). */
function postJson<T>(path: string, payload: unknown, headers: Record<string, string> = {}): Promise<T> {
  return api<T>(path, { method: "POST", body: payload as BodyInit, headers });
}

/** Neutral detail grid: parsed JSON as key/value pairs (no narrative, no model). */
function DetailGrid({ detailJson }: { detailJson: string }) {
  let detail: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(detailJson);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) detail = parsed as Record<string, unknown>;
  } catch {
    detail = { detail: detailJson };
  }
  const entries = Object.entries(detail);
  if (entries.length === 0) return null;
  return (
    <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] gap-x-3 gap-y-1 rounded-md bg-secondary/60 p-2.5">
      {entries.map(([k, v]) => (
        <div key={k} className="col-span-2 grid grid-cols-subgrid items-baseline">
          <dt className="truncate text-[11px] text-muted-foreground">{k}</dt>
          <dd className="break-all font-mono text-xs">{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function PatternsView() {
  const { locale, iso } = useI18n();
  const { actor } = useAppStore();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null);

  const query = useQuery<PatternsResponse>({
    queryKey: ["patterns", actor],
    queryFn: () => api<PatternsResponse>(v1("/patterns")),
  });

  const review = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "promote" | "monitor" | "dismiss" }) =>
      postJson<{ ok: boolean; status: string }>(v1(`/patterns/${id}/review`), { action }, {
        "idempotency-key": crypto.randomUUID(),
      }),
  });

  const onReview = (item: PatternItem, action: "promote" | "monitor" | "dismiss"): void => {
    setActionError(null);
    review.mutate(
      { id: item.id, action },
      {
        onSuccess: () => {
          if (action === "promote") {
            toast({ description: "Draft created in the rule studio" });
          }
          queryClient.invalidateQueries({ queryKey: ["patterns"] });
        },
        onError: (e) => setActionError({ id: item.id, message: e instanceof ApiError ? e.message : (e as Error).message }),
      }
    );
  };

  const items = query.data?.items ?? [];

  return (
    <div className="space-y-4" aria-label="Pattern alerts">
      {/* Advisory banner — the red line: patterns never gate anything */}
      <Alert className="border-hold/40 bg-hold/10 text-foreground" role="note">
        <ShieldQuestion className="h-4 w-4 text-hold" aria-hidden />
        <AlertTitle className="flex items-center gap-2">
          Advisory only
          <Badge variant="outline" className="border-hold/50 bg-card text-[10px]">Advisory only</Badge>
        </AlertTitle>
        <AlertDescription>
          {query.data?.note ?? "Pattern alerts never appear in exports or routing."} They suggest a rule a human might write; they never gate a transaction.
        </AlertDescription>
      </Alert>

      {query.isLoading ? <LoadingSkeleton rows={4} /> : null}
      {query.isError ? (
        <ErrorState message={(query.error as Error).message} code={query.error instanceof ApiError ? query.error.code : undefined} onRetry={() => query.refetch()} />
      ) : null}

      {query.data && items.length === 0 ? (
        <EmptyState
          title="No pattern alerts"
          hint={query.data.note ?? "The detectors found nothing to review on this dataset."}
          icon={<ShieldQuestion className="h-8 w-8" aria-hidden />}
        />
      ) : null}

      <div className="grid gap-4 xl:grid-cols-2">
        {items.map((item) => {
          const reviewed = item.status !== "open";
          return (
            <Card key={item.id}>
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="border-primary/40 bg-primary/5 font-mono text-[11px] text-primary">
                    {item.patternId}
                  </Badge>
                  <CardTitle className="text-sm">{item.title}</CardTitle>
                  <span className={cn("ms-auto inline-flex items-center rounded-full border px-2 py-0.5 text-[11px]", STATUS_STYLES[item.status])}>
                    {item.status}
                  </span>
                </div>
                <CardDescription className="text-xs text-muted-foreground">{item.neutralText}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <DetailGrid detailJson={item.detailJson} />

                {reviewed ? (
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
                    <CircleCheck className="h-3.5 w-3.5 text-ok" aria-hidden />
                    Reviewed by <span className="font-medium text-foreground">{item.reviewedBy}</span>
                    {item.reviewedAt ? (
                      <>
                        {" · "}
                        {new Date(item.reviewedAt).toLocaleString(locale === "ar" ? "ar-AE" : "en-GB", { dateStyle: "medium", timeStyle: "short" })}
                      </>
                    ) : null}
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => onReview(item, "promote")} disabled={review.isPending && review.variables?.id === item.id}>
                      {review.isPending && review.variables?.id === item.id ? (
                        <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                      ) : (
                        <Sparkles className="me-1.5 h-3.5 w-3.5" aria-hidden />
                      )}
                      Promote to rule
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => onReview(item, "monitor")} disabled={review.isPending && review.variables?.id === item.id}>
                      <Eye className="me-1.5 h-3.5 w-3.5" aria-hidden /> Monitor
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => onReview(item, "dismiss")} disabled={review.isPending && review.variables?.id === item.id}>
                      <CircleMinus className="me-1.5 h-3.5 w-3.5" aria-hidden /> Dismiss
                    </Button>
                  </div>
                )}
                {actionError?.id === item.id ? (
                  <p className="flex items-center gap-1.5 text-xs text-destructive" role="alert">
                    <TriangleAlert className="h-3.5 w-3.5" aria-hidden /> {actionError.message}
                  </p>
                ) : null}
                <p className="text-[11px] text-muted-foreground">
                  {iso(String(items.indexOf(item) + 1))} of {iso(String(items.length))} alerts · detector {item.id}
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
