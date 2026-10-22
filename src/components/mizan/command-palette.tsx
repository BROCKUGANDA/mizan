"use client";

import { useEffect, useState } from "react";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { useAppStore, api, v1, type ViewKey } from "@/lib/client/store";
import { useI18n } from "@/lib/i18n/use-i18n";
import { useMizanTheme, ACCENTS, type Accent } from "@/components/mizan/theme-provider";
import { useQuery } from "@tanstack/react-query";

interface ExceptionsList { items: { exceptionKey: string; displayId: string; headlineEn: string; severity: string }[] }

/** ⌘K command palette: navigate, switch theme/accent, jump to exceptions. */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t, locale } = useI18n();
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
      <CommandInput placeholder={locale === "ar" ? "ابحث عن وجهة أو استثناء…" : "Search views or exceptions…"} />
      <CommandList>
        <CommandEmpty>{locale === "ar" ? "لا نتائج" : "No results"}</CommandEmpty>
        <CommandGroup heading={locale === "ar" ? "التنقل" : "Go to"}>
          {(["overview", "queue", "runs", "rules", "patterns", "audit", "integrations", "settings"] as ViewKey[]).map((v) => (
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
          <CommandGroup heading={locale === "ar" ? "استثناءات" : "Exceptions"}>
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
    window.addEventListener("mizan-queue-nav", handler);
    return () => window.removeEventListener("mizan-queue-nav", handler);
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
