"use client";

/**
 * Settings (§21/§22): feature flags with reasons, failsafe mode control (M0–M5),
 * the outbox viewer (judge profile O3) and signed evidence packs. Privileged
 * controls are role-aware in the UI and always re-enforced server-side.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleCheck,
  CircleMinus,
  Download,
  FileArchive,
  Flag,
  Inbox,
  Loader2,
  OctagonAlert,
  PackageCheck,
  Settings2,
  TriangleAlert,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, ErrorState, LoadingSkeleton, ModeChip } from "@/components/mizan/primitives";
import { api, v1, useAppStore, ApiError } from "@/lib/client/store";
import { useI18n } from "@/lib/i18n/use-i18n";
import { POLL } from "@/lib/app-config";
import { cn } from "@/lib/utils";

/* ── payload mirrors ────────────────────────────────────────────────────────── */

interface FlagItem {
  key: string;
  value: string;
  updatedBy: string;
  reason: string;
  updatedAt: string;
}

interface ModeState {
  current: string;
  label: string;
  reason: string | null;
  since: string;
}

interface SystemState {
  mode: { current: string };
  actors: { id: string; name: string; role: string }[];
  currentActor: string;
  latestRunId: string | null;
}

interface OutboxItem {
  id: string;
  type: string;
  status: string;
  attempts: number;
  payload: Record<string, unknown>;
  createdAt: string;
  sentAt: string | null;
}

interface OutboxResponse {
  items: OutboxItem[];
  channels: { inapp: string; email: string; webhook: string };
}

interface RunItem {
  id: string;
  status: string;
  startedAt: string;
}

interface EvidencePack {
  manifest: { scope: string; generatedAt: string; files: Record<string, string>; signature: string };
  files: Record<string, string>;
}

const MODES = ["M0", "M1", "M2", "M3", "M4", "M5"] as const;

const MODE_INFO: Record<string, { en: string; ar: string }> = {
  M0: { en: "Everything runs: census checks, routing, exports. The engine decides; the model only explains.", ar: "كل شيء يعمل: تعداد وفحوصات وتوجيه وتصدير. المحرك يقرر والنموذج يشرح فقط." },
  M1: { en: "Degraded AI: narrative explanations fall back to deterministic templates; detection is unaffected.", ar: "ذكاء اصطناعي متدهور: تعود الشروحات إلى القوالب الحتمية؛ الفحص غير متأثر." },
  M2: { en: "Degraded analytics: heavy projections are suppressed; the queue, runs and exports continue.", ar: "تحليلات متدهورة: تُوقف الإسقاطات الثقيلة؛ تستمر القائمة والتشغيلات والتصدير." },
  M3: { en: "Degraded storage: attachments and exports degrade gracefully; findings and the trail remain.", ar: "تخزين متدهور: تتراجع المرفقات والتصدير بلطف؛ تبقى النتائج وسجل التدقيق." },
  M4: { en: "Read-only: writes are paused; drafts stay local; the audit trail stays append-only.", ar: "قراءة فقط: تُوقف الكتابة؛ تبقى المسودات محلية؛ ويبقى سجل التدقيق إضافيًا فقط." },
  M5: { en: "Safe halt: an integrity failure froze the system — runs and decisions are blocked until an administrator clears it.", ar: "توقف آمن: جمّ فشل السلامة النظام — تُحظر التشغيلات والقرارات حتى يزيلها مسؤول." },
};

const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

const fmtTime = (s: string | null | undefined, locale: string): string => {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(locale === "ar" ? "ar-AE" : "en-GB", { dateStyle: "medium", timeStyle: "short" });
};

const OUTBOX_STATUS_STYLES: Record<string, string> = {
  pending: "border-sev-medium/50 bg-sev-medium/10 text-foreground",
  sent: "border-ok/40 bg-ok/10 text-foreground",
  failed: "border-destructive/40 bg-destructive/10 text-destructive",
  dead: "border-destructive/50 bg-destructive/15 text-destructive",
};

/** api() declares `body` via `RequestInit & { body?: unknown }` — the intersection collapses to
 * BodyInit, so JSON payloads go through this adapter (api() JSON-encodes them itself). */
function postJson<T>(path: string, payload: unknown, headers: Record<string, string> = {}): Promise<T> {
  return api<T>(path, { method: "POST", body: payload as BodyInit, headers });
}

export default function SettingsView() {
  return (
    <div className="space-y-4" aria-label="Settings">
      <Tabs defaultValue="flags">
        <TabsList>
          <TabsTrigger value="flags">
            <Flag className="me-1.5 h-3.5 w-3.5" aria-hidden /> Flags
          </TabsTrigger>
          <TabsTrigger value="modes">
            <Settings2 className="me-1.5 h-3.5 w-3.5" aria-hidden /> Modes
          </TabsTrigger>
          <TabsTrigger value="outbox">
            <Inbox className="me-1.5 h-3.5 w-3.5" aria-hidden /> Outbox
          </TabsTrigger>
          <TabsTrigger value="evidence">
            <FileArchive className="me-1.5 h-3.5 w-3.5" aria-hidden /> Evidence
          </TabsTrigger>
        </TabsList>
        <TabsContent value="flags" className="mt-4">
          <FlagsTab />
        </TabsContent>
        <TabsContent value="modes" className="mt-4">
          <ModesTab />
        </TabsContent>
        <TabsContent value="outbox" className="mt-4">
          <OutboxTab />
        </TabsContent>
        <TabsContent value="evidence" className="mt-4">
          <EvidenceTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ── shared role hook (server-enforced; UI only hides what it must) ─────────── */

function useRole(): string | null {
  const { actor } = useAppStore();
  const { data } = useQuery<SystemState>({
    queryKey: ["system-state", actor],
    queryFn: () => api<SystemState>(v1("/system/state")),
    staleTime: POLL.staleMs.settings,
  });
  return data?.actors.find((a) => a.id === actor)?.role ?? null;
}

/* ── Flags ──────────────────────────────────────────────────────────────────── */

function FlagsTab() {
  const { locale, iso } = useI18n();
  const queryClient = useQueryClient();
  const role = useRole();
  const privileged = role === "admin" || role === "compliance_lead";
  const [editing, setEditing] = useState<FlagItem | null>(null);
  const [editValue, setEditValue] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const query = useQuery<{ items: FlagItem[] }>({
    queryKey: ["flags"],
    queryFn: () => api<{ items: FlagItem[] }>(v1("/flags")),
  });

  const save = useMutation({
    mutationFn: (body: { key: string; value: string; reason: string }) =>
      postJson<{ ok: boolean }>(v1("/flags"), body, { "idempotency-key": crypto.randomUUID() }),
    onSuccess: () => {
      setEditing(null);
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["flags"] });
      queryClient.invalidateQueries({ queryKey: ["system-state"] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : (e as Error).message),
  });

  const openEdit = (f: FlagItem): void => {
    setEditing(f);
    setEditValue(f.value);
    setReason("");
    setError(null);
  };

  const onSave = (): void => {
    if (!editing) return;
    if (reason.trim().length < 5) {
      setError("Every flag change needs a reason (at least 5 characters).");
      return;
    }
    save.mutate({ key: editing.key, value: editValue, reason: reason.trim() });
  };

  const isBoolean = (v: string): boolean => v === "true" || v === "false";

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Feature flags</CardTitle>
        <CardDescription>Every change is audited with who changed what, when, and why. Effective within 10 seconds.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!privileged ? (
          <Alert className="border-hold/40 bg-hold/10 text-foreground" role="note">
            <TriangleAlert className="h-4 w-4 text-hold" aria-hidden />
            <AlertTitle>Read-only</AlertTitle>
            <AlertDescription>Only an administrator or the compliance lead can change flags.</AlertDescription>
          </Alert>
        ) : null}

        {query.isLoading ? <LoadingSkeleton rows={6} /> : null}
        {query.isError ? (
          <ErrorState message={(query.error as Error).message} code={query.error instanceof ApiError ? query.error.code : undefined} onRetry={() => query.refetch()} />
        ) : null}
        {query.data && query.data.items.length === 0 ? <EmptyState title="No flags defined" icon={<Flag className="h-8 w-8" aria-hidden />} /> : null}

        {query.data && query.data.items.length > 0 ? (
          <div className="max-h-[60vh] overflow-y-auto rounded-lg border">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card shadow-[0_1px_0_0_var(--border)]">
                <TableRow>
                  <TableHead>Key</TableHead>
                  <TableHead className="w-28">Value</TableHead>
                  <TableHead className="w-36">Updated by</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead className="w-36">Updated</TableHead>
                  {privileged ? <TableHead className="w-16 text-end">Edit</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.items.map((f) => (
                  <TableRow key={f.key}>
                    <TableCell className="font-mono text-xs">{f.key}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={cn("max-w-28 border-border bg-secondary font-mono text-[11px]", f.value === "true" && "border-ok/40 bg-ok/10", f.value === "false" && "text-muted-foreground")}>
                        <span className="truncate">{trunc(f.value, 20)}</span>
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">{f.updatedBy}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{f.reason}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{fmtTime(f.updatedAt, locale)}</TableCell>
                    {privileged ? (
                      <TableCell className="text-end">
                        <Button size="sm" variant="ghost" onClick={() => openEdit(f)} aria-label={`Edit flag ${f.key}`}>
                          <Settings2 className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}
        <p className="text-[11px] text-muted-foreground">{iso(String(query.data?.items.length ?? 0))} flags</p>
      </CardContent>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">{editing?.key}</DialogTitle>
            <DialogDescription>Changing a flag takes effect within 10 seconds and is written to the audit trail with your reason.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {editing && isBoolean(editing.value) ? (
              <div className="space-y-1.5">
                <Label htmlFor="flag-value" className="text-xs">New value</Label>
                <Select value={editValue} onValueChange={setEditValue}>
                  <SelectTrigger id="flag-value" size="sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="true">true</SelectItem>
                    <SelectItem value="false">false</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="flag-value" className="text-xs">New value</Label>
                <Input id="flag-value" value={editValue} onChange={(e) => setEditValue(e.target.value)} className="font-mono text-xs" aria-label="New flag value" />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="flag-reason" className="text-xs">Reason (required, ≥ 5 characters)</Label>
              <Textarea id="flag-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} aria-label="Reason for the flag change" />
            </div>
            {error ? (
              <p className="text-xs text-destructive" role="alert">{error}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setEditing(null)}>Cancel</Button>
            <Button size="sm" onClick={onSave} disabled={save.isPending || reason.trim().length < 5}>
              {save.isPending ? <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
              Save flag
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/* ── Modes ──────────────────────────────────────────────────────────────────── */

function ModesTab() {
  const { t, locale, iso } = useI18n();
  const queryClient = useQueryClient();
  const role = useRole();
  const privileged = role === "admin" || role === "compliance_lead";
  const [nextMode, setNextMode] = useState<string>("M0");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const query = useQuery<ModeState>({
    queryKey: ["system-mode"],
    queryFn: () => api<ModeState>(v1("/system/mode")),
  });

  const setMode = useMutation({
    mutationFn: (body: { mode: string; reason: string }) =>
      postJson<ModeState>(v1("/system/mode"), body, { "idempotency-key": crypto.randomUUID() }),
    onSuccess: (data) => {
      setError(null);
      setNote(`Mode set to ${data.current} — ${data.label}.`);
      setReason("");
      queryClient.invalidateQueries({ queryKey: ["system-mode"] });
      queryClient.invalidateQueries({ queryKey: ["system-state"] });
    },
    onError: (e) => {
      setNote(null);
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    },
  });

  const onSet = (): void => {
    if (reason.trim().length < 5) {
      setError("A reason of at least 5 characters is required.");
      return;
    }
    setMode.mutate({ mode: nextMode, reason: reason.trim() });
  };

  const current = query.data?.current ?? "M0";

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Failsafe modes</CardTitle>
          <CardDescription>Modes are capability switches, not page errors: what MIZAN may still do right now.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <ModeChip mode={current} />
            <span className="text-xs text-muted-foreground">
              since {fmtTime(query.data?.since ?? null, locale)}
              {query.data?.reason ? ` · reason: ${query.data.reason}` : ""}
            </span>
          </div>
          <Separator />
          <ul className="space-y-2.5">
            {MODES.map((m) => (
              <li key={m} className={cn("flex gap-2 rounded-lg border p-2.5", m === current ? "border-primary/40 bg-secondary" : "border-border")}>
                <ModeChip mode={m} />
                <p className="flex-1 text-xs text-muted-foreground">{t(`mode.${m}`)} — {locale === "ar" ? MODE_INFO[m]!.ar : MODE_INFO[m]!.en}</p>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Operator switcher</CardTitle>
          <CardDescription>Admin and compliance lead only — enforced server-side; every switch is audited with a reason.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {privileged ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="mode-select" className="text-xs">Mode</Label>
                <Select value={nextMode} onValueChange={setNextMode}>
                  <SelectTrigger id="mode-select" size="sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {MODES.map((m) => (
                      <SelectItem key={m} value={m}>{m} · {t(`mode.${m}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mode-reason" className="text-xs">Reason (required, ≥ 5 characters)</Label>
                <Input id="mode-reason" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason for the mode change" />
              </div>
              <Button size="sm" onClick={onSet} disabled={setMode.isPending || reason.trim().length < 5}>
                {setMode.isPending ? <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Settings2 className="me-1.5 h-3.5 w-3.5" aria-hidden />}
                Set mode to {nextMode}
              </Button>
              {note ? (
                <p className="flex items-center gap-1.5 text-xs text-ok" role="status">
                  <CircleCheck className="h-3.5 w-3.5" aria-hidden /> {note}
                </p>
              ) : null}
              {error ? (
                <Alert variant="destructive" role="alert">
                  <OctagonAlert className="h-4 w-4" aria-hidden />
                  <AlertTitle>Mode change rejected</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
            </>
          ) : (
            <Alert className="border-hold/40 bg-hold/10 text-foreground" role="note">
              <TriangleAlert className="h-4 w-4 text-hold" aria-hidden />
              <AlertTitle>Read-only</AlertTitle>
              <AlertDescription>Only an administrator (and the compliance lead) can switch modes. Ask one, or read the runbook.</AlertDescription>
            </Alert>
          )}
          <Alert className="border-sev-critical/30 bg-sev-critical/5 text-foreground" role="note">
            <OctagonAlert className="h-4 w-4 text-sev-critical" aria-hidden />
            <AlertTitle>Caution — safe halt (M5)</AlertTitle>
            <AlertDescription>M5 blocks runs and decisions until an administrator clears it. Use it when the chain fails or data integrity is in doubt.</AlertDescription>
          </Alert>
          <p className="text-[11px] text-muted-foreground">{iso(String(MODES.length))} modes · current {current}</p>
        </CardContent>
      </Card>
    </div>
  );
}

/* ── Outbox ─────────────────────────────────────────────────────────────────── */

function OutboxTab() {
  const { locale, iso } = useI18n();
  const query = useQuery<OutboxResponse>({
    queryKey: ["outbox"],
    queryFn: () => api<OutboxResponse>(v1("/outbox")),
  });

  const channels = query.data?.channels;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Outbox</CardTitle>
        <CardDescription>
          Delivery relay (transactional outbox): notifications are written with the decision, then delivered in-app first. Email and webhook channels are integration stubs in the sandbox.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {channels ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">Channels:</span>
            <Badge variant="outline" className="border-ok/40 bg-ok/10 text-[11px] text-foreground">
              <CircleCheck className="me-1 h-3 w-3 text-ok" aria-hidden /> inapp · {channels.inapp}
            </Badge>
            {(["email", "webhook"] as const).map((ch) => (
              <Badge key={ch} variant="outline" className="border-dashed border-border bg-secondary text-[11px] text-muted-foreground">
                <CircleMinus className="me-1 h-3 w-3" aria-hidden /> {ch} · {channels[ch]}
              </Badge>
            ))}
          </div>
        ) : null}

        {query.isLoading ? <LoadingSkeleton rows={6} /> : null}
        {query.isError ? (
          <ErrorState message={(query.error as Error).message} code={query.error instanceof ApiError ? query.error.code : undefined} onRetry={() => query.refetch()} />
        ) : null}
        {query.data && query.data.items.length === 0 ? (
          <EmptyState title="Outbox is empty" hint="Decisions and notifications land here with their payloads." icon={<Inbox className="h-8 w-8" aria-hidden />} />
        ) : null}

        {query.data && query.data.items.length > 0 ? (
          <div className="max-h-[55vh] overflow-y-auto rounded-lg border">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card shadow-[0_1px_0_0_var(--border)]">
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead className="w-24">Status</TableHead>
                  <TableHead className="w-20 text-end">Attempts</TableHead>
                  <TableHead className="w-40">Created</TableHead>
                  <TableHead>Payload</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.items.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell className="font-mono text-xs">{o.type}</TableCell>
                    <TableCell>
                      <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px]", OUTBOX_STATUS_STYLES[o.status] ?? "border-border bg-secondary text-muted-foreground")}>
                        {o.status}
                      </span>
                    </TableCell>
                    <TableCell className="text-end tabular-nums">{iso(String(o.attempts))}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{fmtTime(o.createdAt, locale)}</TableCell>
                    <TableCell className="font-mono text-[11px] text-muted-foreground">{trunc(JSON.stringify(o.payload), 80)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/* ── Evidence ───────────────────────────────────────────────────────────────── */

function EvidenceTab() {
  const { iso } = useI18n();
  const [kind, setKind] = useState<"run" | "exception">("run");
  const [exceptionKey, setExceptionKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pack, setPack] = useState<EvidencePack | null>(null);
  const [busy, setBusy] = useState(false);

  const runsQuery = useQuery<{ items: RunItem[] }>({
    queryKey: ["runs"],
    queryFn: () => api<{ items: RunItem[] }>(v1("/runs")),
  });

  const latestRunId = runsQuery.data?.items[0]?.id ?? null;
  const scope = kind === "run" ? (latestRunId ? `run:${latestRunId}` : null) : exceptionKey.trim() ? `exception:${exceptionKey.trim()}` : null;

  const onBuild = async (): Promise<void> => {
    if (!scope) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<EvidencePack>(v1(`/evidence-pack?scope=${encodeURIComponent(scope)}`));
      setPack(result);
      const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "evidence-pack.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setPack(null);
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const fileEntries = pack ? Object.entries(pack.manifest.files) : [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Evidence pack</CardTitle>
        <CardDescription>
          Findings, rule pack, interpretations, audit extract and chain verification for one scope — exported with a signed manifest.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <RadioGroup value={kind} onValueChange={(v) => setKind(v as "run" | "exception")} className="grid gap-2 sm:grid-cols-2">
          <Label
            htmlFor="scope-run"
            className={cn("flex cursor-pointer items-start gap-2.5 rounded-lg border p-3", kind === "run" ? "border-primary/50 bg-secondary" : "border-border")}
          >
            <RadioGroupItem id="scope-run" value="run" className="mt-0.5" />
            <span className="space-y-0.5">
              <span className="block text-sm font-medium">Latest run</span>
              <span className="block font-mono text-xs text-muted-foreground">
                run:{latestRunId ? trunc(latestRunId, 24) : "— no run yet, start one first"}
              </span>
            </span>
          </Label>
          <Label
            htmlFor="scope-exception"
            className={cn("flex cursor-pointer items-start gap-2.5 rounded-lg border p-3", kind === "exception" ? "border-primary/50 bg-secondary" : "border-border")}
          >
            <RadioGroupItem id="scope-exception" value="exception" className="mt-0.5" />
            <span className="space-y-0.5">
              <span className="block text-sm font-medium">Paste an exception key</span>
              <span className="block font-mono text-xs text-muted-foreground">exception:F-XXXXXXXX…</span>
            </span>
          </Label>
        </RadioGroup>

        {kind === "exception" ? (
          <div className="space-y-1.5">
            <Label htmlFor="exception-key" className="text-xs">Exception key</Label>
            <Input
              id="exception-key"
              value={exceptionKey}
              onChange={(e) => setExceptionKey(e.target.value)}
              placeholder="F-3KQ9M2P7XW1A"
              className="max-w-sm font-mono text-xs"
              aria-label="Exception key for the evidence pack scope"
            />
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={onBuild} disabled={busy || !scope}>
            {busy ? <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Download className="me-1.5 h-3.5 w-3.5" aria-hidden />}
            Build &amp; download evidence-pack.json
          </Button>
          {busy ? <span className="text-xs text-muted-foreground">Building the pack…</span> : null}
        </div>

        {error ? (
          <Alert variant="destructive" role="alert">
            <OctagonAlert className="h-4 w-4" aria-hidden />
            <AlertTitle>Could not build the pack</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {pack ? (
          <div className="space-y-2 rounded-lg border bg-secondary/40 p-3" role="status">
            <p className="flex items-center gap-1.5 text-xs">
              <PackageCheck className="h-3.5 w-3.5 text-ok" aria-hidden />
              Downloaded · scope <span className="font-mono">{pack.manifest.scope}</span> · signature{" "}
              <span className="font-mono">{pack.manifest.signature.slice(0, 16)}</span>
            </p>
            <div className="overflow-hidden rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>File</TableHead>
                    <TableHead>SHA-256</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {fileEntries.map(([name, sha]) => (
                    <TableRow key={name}>
                      <TableCell className="font-mono text-xs">{name}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground" title={sha}>{sha.slice(0, 16)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        ) : null}

        <p className="rounded-md bg-secondary px-3 py-2 text-xs text-muted-foreground">
          Evidence packs export with a signed manifest; <span className="font-mono">mizan audit verify</span> checks them offline.
        </p>
      </CardContent>
    </Card>
  );
}
