"use client";

import { useEffect, useState } from "react";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { useAppStore, api, v1, VIEW_KEYS, type ViewKey } from "@/lib/client/store";
import { EVENTS } from "@/lib/app-config";
import { useI18n } from "@/lib/i18n/use-i18n";
import { useMizanTheme, ACCENTS, type Accent } from "@/components/mizan/theme-provider";
import { useQuery } from "@tanstack/react-query";

interface ExceptionsList { items: { exceptionKey: string; displayId: string; headlineEn: string; severity: string }[] }

/** ⌘K command palette: navigate, switch theme/accent, jump to exceptions. */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t } = useI18n();
  const { setView, setSelectedException } = useAppStore();
  const { mode, setMode, accent, setAccent } = useMizanTheme();

  const { data } = useQuery<ExceptionsList>({
    queryKey: ["palette-exceptions"],
    queryFn: () => api<ExceptionsList>(v1("/exceptions?limit=10")),
    enabled: open,
  });

  const go = (v: ViewKey): void => {
    setView(v);
    onOpenChange(false);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder={t("palette.placeholder")} />
      <CommandList>
        <CommandEmpty>{t("palette.empty")}</CommandEmpty>
        <CommandGroup heading={t("palette.goto")}>
          {VIEW_KEYS.map((v) => (
            <CommandItem key={v} onSelect={() => go(v)}>
              {t(`nav.${v}`)}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading={t("theme.accent")}>
          {ACCENTS.map((a) => (
            <CommandItem
              key={a}
              value={`${t(`theme.${a}`)} ${a}`}
              onSelect={() => {
                setAccent(a as Accent);
                onOpenChange(false);
              }}
            >
              <span aria-hidden className="me-2 inline-block h-3 w-3 rounded-full border border-border brand-mark" data-accent-preview={a} />
              {t(`theme.${a}`)}
              {accent === a ? <span className="ms-auto text-xs text-ok">✓</span> : null}
            </CommandItem>
          ))}
          {(["light", "dark", "system", "projector"] as const).map((m) => (
            <CommandItem key={m} value={`${t(`theme.${m}`)} ${m}`} onSelect={() => { setMode(m); onOpenChange(false); }}>
              {t(`theme.${m}`)}
              {mode === m ? <span className="ms-auto text-xs text-ok">✓</span> : null}
            </CommandItem>
          ))}
        </CommandGroup>
        {data?.items?.length ? (
          <CommandGroup heading={t("palette.exceptions")}>
            {data.items.map((e) => (
              <CommandItem
                key={e.exceptionKey}
                value={`${e.displayId} ${e.headlineEn}`}
                onSelect={() => {
                  setSelectedException(e.exceptionKey);
                  setView("queue");
                  onOpenChange(false);
                }}
              >
                <span className="font-mono text-xs">{e.displayId}</span>
                <span className="ms-2 truncate">{e.headlineEn}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>
    </CommandDialog>
  );
}

export function useKeyboardListNav(refresh: () => void): void {
  useEffect(() => {
    const handler = (): void => refresh();
    window.addEventListener(EVENTS.queueNav, handler);
    return () => window.removeEventListener(EVENTS.queueNav, handler);
  }, [refresh]);
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    queueMicrotask(() => setMatches(mq.matches));
    const fn = (e: MediaQueryListEvent): void => setMatches(e.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, [query]);
  return matches;
}
