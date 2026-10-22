"use client";

/**
 * Audit room (§20): hash-chained event log with offline verification semantics.
 * Every mutation lands here; the strip re-verifies the chain on every load, and
 * the tamper demonstration (admin, judge profile) shows detection + safe halt (M5)
 * by mutating one row on purpose. Append-only in production — UPDATE/DELETE revoked.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleCheck,
  FlaskConical,
  Link2,
  Loader2,
  OctagonAlert,
  RefreshCw,
  Search,
  ShieldAlert,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/mizan/primitives";
import { api, v1, useAppStore, ApiError } from "@/lib/client/store";
import { useI18n } from "@/lib/i18n/use-i18n";
import { cn } from "@/lib/utils";

interface AuditEvent {
  seq: number;
  at: string;
  actor: string;
  type: string;
  entity: string;
  entityId: string;
  payloadJson: string;
  prevHash: string;
  hash: string;
}

interface Verification {
  ok: boolean;
  checked: number;
  firstBadSeq: number | null;
  headHash: string | null;
  verifiedAt: string;
}

interface AuditResponse {
  items: AuditEvent[];
  head: number;
  verification: Verification;
}

interface TamperResult {
  tamperedSeq: number;
  verify: Verification;
  note: string;
}

const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

export default function AuditView() {
  const { t, locale, iso } = useI18n();
  const { actor } = useAppStore();
  const queryClient = useQueryClient();
  const [typeFilter, setTypeFilter] = useState("");
  const [entityFilter, setEntityFilter] = useState("");
  const [tamper, setTamper] = useState<TamperResult | null>(null);
  const [tamperError, setTamperError] = useState<string | null>(null);

  const query = useQuery<AuditResponse>({
    queryKey: ["audit-events", actor],
    queryFn: () => api<AuditResponse>(v1("/audit/events?limit=80")),
  });

  const tamperMutation = useMutation({
    mutationFn: () => api<TamperResult>(v1("/audit/tamper"), { method: "POST", headers: { "idempotency-key": crypto.randomUUID() } }),
    onSuccess: (result) => {
      setTamper(result);
      setTamperError(null);
      queryClient.invalidateQueries({ queryKey: ["audit-events"] });
    },
    onError: (e) => setTamperError(e instanceof ApiError ? e.message : (e as Error).message),
  });

  const events = query.data?.items ?? [];
  const verification = query.data?.verification;

  const filtered = useMemo(() => {
    const type = typeFilter.trim().toLowerCase();
    const entity = entityFilter.trim().toLowerCase();
    return events.filter((e) => {
      if (type && !e.type.toLowerCase().startsWith(type)) return false;
      if (entity && !`${e.entity}/${e.entityId}`.toLowerCase().includes(entity)) return false;
      return true;
    });
  }, [events, typeFilter, entityFilter]);

  /** Chain visualisation: the first 40 events in append order. */
  const chain = useMemo(() => [...events].sort((a, b) => a.seq - b.seq).slice(0, 40), [events]);

  return (
    <div className="space-y-4" aria-label={t("nav.audit")}>
      {/* Verification strip */}
      {verification ? (
        verification.ok ? (
          <Alert className="border-ok/40 bg-ok/10 text-foreground" role="status">
            <CircleCheck className="h-4 w-4 text-ok" aria-hidden />
            <AlertTitle>Hash chain verified — {iso(String(verification.checked))} events, head {verification.headHash?.slice(0, 8) ?? "—"}</AlertTitle>
            <AlertDescription>
              Every event hashes to the previous one; the head hash is what an offline verifier ({locale === "ar" ? "mizan audit verify" : "`mizan audit verify`"}) reproduces. Verified {new Date(verification.verifiedAt).toLocaleTimeString(locale === "ar" ? "ar-AE" : "en-GB")}.
            </AlertDescription>
          </Alert>
        ) : (
          <Alert className="border-destructive/40 bg-destructive/10 text-destructive" role="alert">
            <OctagonAlert className="h-4 w-4" aria-hidden />
            <AlertTitle>Integrity failure at seq {iso(String(verification.firstBadSeq ?? 0))} — safe halt (M5)</AlertTitle>
            <AlertDescription>
              A stored row no longer matches the hash chain. The system entered safe halt: runs and decisions are blocked until an administrator clears it. Preserve this state for forensics.
            </AlertDescription>
          </Alert>
        )
      ) : null}

      {/* Chain visualisation */}
      {chain.length > 0 ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Link2 className="h-4 w-4 text-brand" aria-hidden /> Chain — first {iso(String(chain.length))} events
            </CardTitle>
            <CardDescription>Each block hashes to the next; a red block means the stored row no longer matches its hash.</CardDescription>
          </CardHeader>
          <CardContent>
            <TooltipProvider delayDuration={100}>
              <div className="flex h-6 items-center gap-0.5 overflow-x-auto pb-1" role="img" aria-label={`Hash chain of the first ${chain.length} audit events`}>
                {chain.map((e, i) => {
                  const bad = verification !== undefined && !verification.ok && verification.firstBadSeq === e.seq;
                  return (
                    <div key={e.seq} className="flex items-center">
                      {i > 0 ? <span className={cn("h-px w-1.5", bad ? "bg-destructive/60" : "bg-ok/60")} aria-hidden /> : null}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className={cn("h-6 w-2 rounded-sm", bad ? "bg-destructive" : "bg-ok")} />
                        </TooltipTrigger>
                        <TooltipContent className="font-mono text-[11px]">
                          seq {e.seq} · {e.type}
                          {bad ? " · hash mismatch" : ""}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  );
                })}
              </div>
            </TooltipProvider>
          </CardContent>
        </Card>
      ) : null}

      {/* Events table */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-sm">Event trail</CardTitle>
              <CardDescription>
                {iso(String(filtered.length))} of {iso(String(events.length))} events · newest first
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="pointer-events-none absolute start-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                  placeholder="Filter by type prefix…"
                  aria-label="Filter events by type prefix"
                  className="h-8 w-44 ps-7 font-mono text-xs"
                />
              </div>
              <Input
                value={entityFilter}
                onChange={(e) => setEntityFilter(e.target.value)}
                placeholder="Search entity…"
                aria-label="Search events by entity"
                className="h-8 w-44 font-mono text-xs"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {query.isLoading ? (
            <div className="p-4">
              <LoadingSkeleton rows={8} />
            </div>
          ) : null}
          {query.isError ? (
            <div className="p-4">
              <ErrorState message={(query.error as Error).message} code={query.error instanceof ApiError ? query.error.code : undefined} onRetry={() => query.refetch()} />
            </div>
          ) : null}
          {query.data && filtered.length === 0 ? (
            <div className="p-4">
              <EmptyState title="No events match" hint="Clear the type or entity filters to see the trail." icon={<Search className="h-8 w-8" aria-hidden />} />
            </div>
          ) : null}
          {query.data && filtered.length > 0 ? (
            <div className="max-h-[60vh] overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-card shadow-[0_1px_0_0_var(--border)]">
                  <TableRow>
                    <TableHead className="w-14">Seq</TableHead>
                    <TableHead className="w-40">At</TableHead>
                    <TableHead className="w-32">Actor</TableHead>
                    <TableHead className="w-40">Type</TableHead>
                    <TableHead>Entity</TableHead>
                    <TableHead className="w-32">Hash</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((e) => (
                    <TableRow key={e.seq}>
                      <TableCell className="tabular-nums">{iso(String(e.seq))}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        {new Date(e.at).toLocaleString(locale === "ar" ? "ar-AE" : "en-GB", { dateStyle: "short", timeStyle: "medium" })}
                      </TableCell>
                      <TableCell className="text-xs">{e.actor}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="border-border bg-secondary font-mono text-[10px]">
                          {e.type}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {e.entity}/{trunc(e.entityId, 22)}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground" title={e.hash}>
                        {e.hash.slice(0, 10)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Tamper demonstration — admin only, judge profile */}
      {actor === "admin" ? (
        <Card className="border-sev-medium/40">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <ShieldAlert className="h-4 w-4 text-sev-medium" aria-hidden /> Tamper demonstration
            </CardTitle>
            <CardDescription>
              Mutates one audit row on purpose to show that the chain verifier catches it and the system enters safe halt (M5). The audit table is append-only in production.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="outline" className="border-sev-medium/50 text-foreground hover:bg-sev-medium/10">
                  <FlaskConical className="me-1.5 h-3.5 w-3.5" aria-hidden /> Run tamper demonstration
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Mutate one audit row?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This deliberately corrupts a stored audit event to demonstrate detection: the next verification fails at that sequence number and MIZAN enters safe halt (M5), blocking runs and decisions until cleared. Judge-mode demo only.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-primary-foreground hover:bg-destructive/90"
                    onClick={() => tamperMutation.mutate()}
                  >
                    {tamperMutation.isPending ? <Loader2 className="me-1.5 h-4 w-4 animate-spin" aria-hidden /> : null}
                    Tamper &amp; verify
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            {tamperError ? (
              <Alert variant="destructive" role="alert">
                <OctagonAlert className="h-4 w-4" aria-hidden />
                <AlertTitle>Tamper demonstration failed</AlertTitle>
                <AlertDescription>{tamperError}</AlertDescription>
              </Alert>
            ) : null}

            {tamper ? (
              <div className="space-y-2 rounded-lg border bg-secondary/40 p-3" role="status">
                <p className="text-xs">
                  Tampered <span className="font-mono font-semibold">seq {iso(String(tamper.tamperedSeq))}</span> — {tamper.note}
                </p>
                <p className="font-mono text-[11px] text-muted-foreground">
                  verify: ok={String(tamper.verify.ok)} · checked={tamper.verify.checked} · firstBadSeq={tamper.verify.firstBadSeq ?? "—"} · head={tamper.verify.headHash?.slice(0, 8) ?? "—"}
                </p>
                <Button size="sm" variant="outline" onClick={() => queryClient.invalidateQueries({ queryKey: ["audit-events"] })}>
                  <RefreshCw className="me-1.5 h-3.5 w-3.5" aria-hidden /> Refresh trail
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

