"use client";

/**
 * MIZAN shell: the only user-visible route. All views are client-side inside
 * this page (sandbox constraint). Top bar with mode chip, judge ribbon, actor
 * switcher, language/theme toggles, notifications, command palette (⌘K),
 * keyboard shortcuts (J/K/?), judge Reset, and mode banners.
 */

import { useEffect, useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Bell, Command, HelpCircle, Languages, Moon, RotateCcw, Sun, Monitor } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { CommandPalette } from "@/components/mizan/command-palette";
import { NotificationPanel } from "@/components/mizan/notification-panel";
import { ShortcutsDialog } from "@/components/mizan/shortcuts-dialog";
import { ExceptionDrawer } from "@/components/mizan/views/exception-drawer";
import { ModeChip, ModeBanner, JudgeRibbon } from "@/components/mizan/primitives";
import { useAppStore, api, v1, type ViewKey } from "@/lib/client/store";
import { useI18n, I18nProvider } from "@/lib/i18n/use-i18n";
import { useMizanTheme } from "@/components/mizan/theme-provider";

interface SystemState {
  mode: { current: string; label: string; labelAr: string; banner: string; bannerAr: string; reason: string | null; operator: string | null };
  profile: string;
  syntheticOnly: boolean;
  actors: { id: string; name: string; role: string }[];
}

const NAV: { key: ViewKey; labelKey: string }[] = [
  { key: "overview", labelKey: "nav.overview" },
  { key: "queue", labelKey: "nav.queue" },
  { key: "runs", labelKey: "nav.runs" },
  { key: "rules", labelKey: "nav.rules" },
  { key: "patterns", labelKey: "nav.patterns" },
  { key: "audit", labelKey: "nav.audit" },
  { key: "settings", labelKey: "nav.settings" },
];

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: 1 } } });

export default function Home() {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <Shell />
      </I18nProvider>
    </QueryClientProvider>
  );
}

function Shell() {
  const { t, locale, setLocale, iso } = useI18n();
  const { view, setView, actor, setActor, setSelectedException, commandOpen, setCommandOpen, shortcutsOpen, setShortcutsOpen, notificationsOpen, setNotificationsOpen } = useAppStore();
  const { mode: themeMode, setMode: setThemeMode } = useMizanTheme();
  const queryClient_ = useQueryClient();
  const [resetting, setResetting] = useState(false);

  const { data: system } = useQuery<SystemState>({
    queryKey: ["system-state", actor],
    queryFn: () => api<SystemState>(v1("/system/state")),
    refetchInterval: 10_000,
  });

  const mode = system?.mode.current ?? "M0";

  // Keyboard: ⌘K palette, J/K navigation on the queue, ? shortcuts
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName) || target?.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandOpen(!commandOpen);
        return;
      }
      if (typing) return;
      if (e.key === "?") {
        e.preventDefault();
        setShortcutsOpen(true);
      }
      if ((e.key === "j" || e.key === "k") && view === "queue") {
        // queue view handles J/K via its own listener bound to the store index
        window.dispatchEvent(new CustomEvent("mizan-queue-nav", { detail: { dir: e.key === "j" ? 1 : -1 } }));
      }
      if (e.key === "Escape") {
        setSelectedException(null);
      }
    },
    [commandOpen, setCommandOpen, setShortcutsOpen, setSelectedException, view]
  );
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);

  const onReset = async (): Promise<void> => {
    setResetting(true);
    try {
      const r = await api<{ ok: boolean; elapsedMs: number }>(v1("/judge/reset"), { method: "POST", body: {} });
      await queryClient_.invalidateQueries();
      toast({ title: locale === "ar" ? "تمت إعادة التعيين" : "Reset complete", description: iso(`${(r.elapsedMs / 1000).toFixed(1)}s`) });
    } catch (err) {
      toast({ title: t("common.error"), description: err instanceof Error ? err.message : "reset failed", variant: "destructive" });
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground">
        {locale === "ar" ? "تخطَّ إلى المحتوى" : "Skip to content"}
      </a>

      <header className="sticky top-0 z-40 border-b bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4">
          <div className="flex shrink-0 items-center gap-2">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary font-bold text-primary-foreground" aria-hidden>
              م
            </div>
            <div className="leading-tight">
              <p className="text-sm font-bold">{t("app.name")}</p>
              <p className="hidden max-w-52 truncate text-[10px] text-muted-foreground xl:block">{t("app.tagline")}</p>
            </div>
          </div>

          {system?.profile === "judge" ? (
            <JudgeRibbon label={locale === "ar" ? "وضع المُقيِّم" : "Judge mode"} />
          ) : null}
          {system?.syntheticOnly ? (
            <span className="hidden shrink-0 rounded-full border border-border bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground lg:inline">
              {t("app.synthetic")}
            </span>
          ) : null}

          <nav aria-label="Main" className="ms-2 hidden min-w-0 flex-1 items-center gap-1 overflow-x-auto lg:flex">
            {NAV.map((n) => (
              <button
                key={n.key}
                onClick={() => setView(n.key)}
                aria-current={view === n.key ? "page" : undefined}
                className={`rounded-md px-3 py-1.5 text-sm transition-colors duration-200 ${
                  view === n.key ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                }`}
              >
                {t(n.labelKey)}
              </button>
            ))}
          </nav>

          <div className="ms-auto flex items-center gap-1.5">
            <ModeChip mode={mode} />
            <Button variant="ghost" size="icon" aria-label={t("shortcuts.palette")} onClick={() => setCommandOpen(true)}>
              <Command className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" aria-label={t("shortcuts.help")} onClick={() => setShortcutsOpen(true)}>
              <HelpCircle className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("common.language")}
              onClick={() => setLocale(locale === "en" ? "ar" : "en")}
            >
              <Languages className="h-4 w-4" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="theme">
                  {themeMode === "dark" ? <Moon className="h-4 w-4" /> : themeMode === "projector" ? <Monitor className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {([["light", "Light"], ["dark", "Dark"], ["system", "System"], ["projector", "Projector (1280×720)"]] as const).map(([m, label]) => (
                  <DropdownMenuItem key={m} onClick={() => setThemeMode(m)} className={themeMode === m ? "bg-accent" : ""}>
                    {label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <NotificationPanel open={notificationsOpen} onOpenChange={setNotificationsOpen} />
            {system?.profile === "judge" ? (
              <Button variant="outline" size="sm" onClick={onReset} disabled={resetting} aria-busy={resetting}>
                <RotateCcw className="me-1 h-3.5 w-3.5" aria-hidden />
                {t("common.reset")}
              </Button>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" size="sm" className="min-w-32" aria-label={`actor: ${actor}`}>
                  <span className="truncate">{system?.actors.find((a) => a.id === actor)?.name ?? actor}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
                <DropdownMenuLabel>{locale === "ar" ? "تبديل الدور" : "Role switcher"}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {(system?.actors ?? []).map((a) => (
                  <DropdownMenuItem key={a.id} onClick={() => setActor(a.id)} className={a.id === actor ? "bg-accent" : ""}>
                    <span className="flex w-full items-center justify-between gap-4">
                      <span>{a.name}</span>
                      <span className="text-[10px] text-muted-foreground">{a.role}</span>
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <nav aria-label="Sections" className="mx-auto flex max-w-7xl items-center gap-1 overflow-x-auto px-4 pb-2 lg:hidden">
          {NAV.map((n) => (
            <button
              key={n.key}
              onClick={() => setView(n.key)}
              aria-current={view === n.key ? "page" : undefined}
              className={`whitespace-nowrap rounded-md px-3 py-1.5 text-xs ${view === n.key ? "bg-accent font-medium" : "text-muted-foreground"}`}
            >
              {t(n.labelKey)}
            </button>
          ))}
        </nav>
      </header>

      <ModeBanner
        mode={mode}
        banner={(locale === "ar" ? system?.mode.bannerAr : system?.mode.banner) ?? ""}
        reason={system?.mode.reason}
        operator={system?.mode.operator}
      />

      <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
        {view === "overview" ? <OverviewLazy /> : null}
        {view === "queue" ? <QueueLazy /> : null}
        {view === "runs" ? <RunsLazy /> : null}
        {view === "rules" ? <RulesLazy /> : null}
        {view === "patterns" ? <PatternsLazy /> : null}
        {view === "audit" ? <AuditLazy /> : null}
        {view === "settings" ? <SettingsLazy /> : null}
      </main>

      <footer className="mt-auto border-t bg-card py-3 text-center text-xs text-muted-foreground pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {iso("MIZAN v1.0 · engine-1.0.0 · pack emirates-hr-1.0.0 · synthetic data only · the engine decides, the model explains")}
      </footer>

      <ExceptionDrawer />
      <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <ResetSpinner open={resetting} />
    </div>
  );
}

/* Lazy view imports keep the shell readable; all views live in components/mizan/views. */
import OverviewView from "@/components/mizan/views/overview-view";
import QueueView from "@/components/mizan/views/queue-view";
import RunsView from "@/components/mizan/views/runs-view";
import RulesView from "@/components/mizan/views/rules-view";
import PatternsView from "@/components/mizan/views/patterns-view";
import AuditView from "@/components/mizan/views/audit-view";
import SettingsView from "@/components/mizan/views/settings-view";

function OverviewLazy() { return <OverviewView />; }
function QueueLazy() { return <QueueView />; }
function RunsLazy() { return <RunsView />; }
function RulesLazy() { return <RulesView />; }
function PatternsLazy() { return <PatternsView />; }
function AuditLazy() { return <AuditView />; }
function SettingsLazy() { return <SettingsView />; }

function ResetSpinner({ open }: { open: boolean }) {
  const { t } = useI18n();
  return (
    <Dialog open={open}>
      <DialogContent className="max-w-xs" aria-busy>
        <DialogHeader>
          <DialogTitle>{t("common.reset")}…</DialogTitle>
        </DialogHeader>
        <div className="mizan-skeleton h-2 w-full rounded" />
      </DialogContent>
    </Dialog>
  );
}
