"use client";

/**
 * MIZAN shell: the only user-visible route. All views are client-side inside
 * this page (sandbox constraint). Top bar with mode chip, judge ribbon, actor
 * switcher, language/theme/accent toggles, notifications, command palette (⌘K),
 * keyboard shortcuts (J/K/?), judge Reset, and mode banners.
 * Emirates-vibe dressing: Sadu weave strips, gold-ruled brand mark, animated
 * nav underline, gentle view transitions (reduced-motion aware).
 */

import { useEffect, useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { motion, useReducedMotion } from "framer-motion";
import { Bell, Command, HelpCircle, Languages, Moon, RotateCcw, Sun, Monitor, Palette } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { CommandPalette } from "@/components/mizan/command-palette";
import { NotificationPanel } from "@/components/mizan/notification-panel";
import { ShortcutsDialog } from "@/components/mizan/shortcuts-dialog";
import { ExceptionDrawer } from "@/components/mizan/views/exception-drawer";
import { ModeChip, ModeBanner, JudgeRibbon } from "@/components/mizan/primitives";
import { useAppStore, api, v1, VIEW_KEYS, type ViewKey } from "@/lib/client/store";
import { useI18n, I18nProvider } from "@/lib/i18n/use-i18n";
import { useMizanTheme, ACCENTS, type Accent } from "@/components/mizan/theme-provider";
import { BUILD_LINE, EVENTS, POLL, STORAGE_KEYS } from "@/lib/app-config";

interface SystemState {
  mode: { current: string; label: string; labelAr: string; banner: string; bannerAr: string; reason: string | null; operator: string | null };
  profile: string;
  syntheticOnly: boolean;
  actors: { id: string; name: string; role: string }[];
}

/* Nav derives from the canonical VIEW_KEYS — the same list the command palette reads. */
const NAV: { key: ViewKey; labelKey: string }[] = VIEW_KEYS.map((key) => ({ key, labelKey: `nav.${key}` }));

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: POLL.queryStaleMs, retry: POLL.queryRetry } } });

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
  const { mode: themeMode, setMode: setThemeMode, accent, setAccent } = useMizanTheme();
  const queryClient_ = useQueryClient();
  const [resetting, setResetting] = useState(false);
  const reduceMotion = useReducedMotion();

  // First-visit ⌘K hint (retention through empowerment): shown once, stored
  // locally, auto-dismissed after 12s or on first palette open.
  const [kbdHint, setKbdHint] = useState(false);
  const dismissKbdHint = useCallback(() => {
    setKbdHint(false);
    try {
      localStorage.setItem(STORAGE_KEYS.kbdHint, "1");
    } catch {
      // storage unavailable (private mode) — hint just won't persist
    }
  }, []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!localStorage.getItem(STORAGE_KEYS.kbdHint)) {
        setKbdHint(true);
        timer = setTimeout(dismissKbdHint, POLL.kbdHintDismissMs);
      }
    } catch {
      // storage unavailable — skip the hint entirely
    }
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [dismissKbdHint]);
  useEffect(() => {
    if (commandOpen) dismissKbdHint();
  }, [commandOpen, dismissKbdHint]);

  const { data: system } = useQuery<SystemState>({
    queryKey: ["system-state", actor],
    queryFn: () => api<SystemState>(v1("/system/state")),
    refetchInterval: POLL.systemStateMs,
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
        window.dispatchEvent(new CustomEvent(EVENTS.queueNav, { detail: { dir: e.key === "j" ? 1 : -1 } }));
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
      toast({ title: t("common.resetComplete"), description: iso(`${(r.elapsedMs / 1000).toFixed(1)}s`) });
    } catch (err) {
      toast({ title: t("common.error"), description: err instanceof Error ? err.message : t("common.error"), variant: "destructive" });
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col overflow-x-hidden" data-view={view}>
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground">
        {t("app.skipToContent")}
      </a>

      <div className="sadu-strip" aria-hidden />

      <header className="sticky top-0 z-40 border-b bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
        <div className="mx-auto flex min-h-14 max-w-7xl flex-wrap items-center gap-2 px-4 py-2">
          <div className="flex shrink-0 items-center gap-2">
            <div className="brand-mark flex h-8 w-8 shrink-0 items-center justify-center rounded-md font-bold text-primary-foreground" aria-hidden>
              م
            </div>
            <div className="leading-tight">
              <p className="text-sm font-bold">{t("app.name")}</p>
              <p className="hidden max-w-52 truncate text-[10px] text-muted-foreground xl:block">{t("app.tagline")}</p>
            </div>
          </div>

          {system?.profile === "judge" ? (
            <JudgeRibbon label={t("mode.judge")} />
          ) : null}
          {system?.syntheticOnly ? (
            <span className="hidden shrink-0 rounded-full border border-border bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground lg:inline">
              {t("app.synthetic")}
            </span>
          ) : null}

          <div className="ms-auto flex flex-wrap items-center gap-1.5">
            <ModeChip mode={mode} />
            <div className="relative">
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("shortcuts.palette")}
                onClick={() => setCommandOpen(true)}
              >
                <Command className="h-4 w-4" />
              </Button>
              {kbdHint && !commandOpen ? (
                <div
                  className="absolute end-0 top-10 z-50 w-max rounded-md border border-gold/40 bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-lg"
                  role="note"
                >
                  <kbd className="me-1 rounded border border-border bg-secondary px-1 font-mono text-[10px]">⌘K</kbd>
                  {t("app.kbdHint")}
                </div>
              ) : null}
            </div>
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
                <Button variant="ghost" size="icon" aria-label={t("app.themeMenu")}>
                  {themeMode === "dark" ? <Moon className="h-4 w-4" /> : themeMode === "projector" ? <Monitor className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-52">
                <DropdownMenuItem onClick={() => setThemeMode("light")} className={themeMode === "light" ? "bg-accent" : ""}>
                  {t("theme.light")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setThemeMode("dark")} className={themeMode === "dark" ? "bg-accent" : ""}>
                  {t("theme.dark")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setThemeMode("system")} className={themeMode === "system" ? "bg-accent" : ""}>
                  {t("theme.system")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setThemeMode("projector")} className={themeMode === "projector" ? "bg-accent" : ""}>
                  {t("theme.projector")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Palette className="me-2 h-4 w-4 text-gold" aria-hidden />
                    {t("theme.accent")}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="min-w-48">
                    {ACCENTS.map((a) => (
                      <DropdownMenuItem key={a} onClick={() => setAccent(a as Accent)} className={accent === a ? "bg-accent" : ""}>
                        <span aria-hidden className="me-2 inline-block h-3.5 w-3.5 rounded-full border border-border" data-accent-preview={a} />
                        {t(`theme.${a}`)}
                        {accent === a ? <span className="ms-auto text-xs text-ok" aria-hidden>✓</span> : null}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
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
                <Button variant="secondary" size="sm" className="min-w-32" aria-label={`${t("app.roleSwitcher")}: ${actor}`}>
                  <span className="truncate">{system?.actors.find((a) => a.id === actor)?.name ?? actor}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
                <DropdownMenuLabel>{t("app.roleSwitcher")}</DropdownMenuLabel>
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
        <nav aria-label="Main" className="mx-auto flex max-w-7xl items-center gap-1 overflow-x-auto px-4 pb-2">
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
        <motion.div
          key={view}
          initial={reduceMotion ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
        >
            {view === "overview" ? <OverviewView /> : null}
            {view === "queue" ? <QueueView /> : null}
            {view === "runs" ? <RunsView /> : null}
            {view === "rules" ? <RulesView /> : null}
            {view === "patterns" ? <PatternsView /> : null}
            {view === "audit" ? <AuditView /> : null}
            {view === "settings" ? <SettingsView /> : null}
        </motion.div>
      </main>

      <footer className="mt-auto border-t bg-card pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="sadu-strip-fine" aria-hidden />
        <p className="py-3 text-center text-xs text-muted-foreground">
          {iso(BUILD_LINE)} · {t("app.footer.principles")}
        </p>
      </footer>

      <ExceptionDrawer />
      <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <ResetSpinner open={resetting} />
    </div>
  );
}

/* View imports keep the shell readable; all views live in components/mizan/views. */
import OverviewView from "@/components/mizan/views/overview-view";
import QueueView from "@/components/mizan/views/queue-view";
import RunsView from "@/components/mizan/views/runs-view";
import RulesView from "@/components/mizan/views/rules-view";
import PatternsView from "@/components/mizan/views/patterns-view";
import AuditView from "@/components/mizan/views/audit-view";
import SettingsView from "@/components/mizan/views/settings-view";

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
