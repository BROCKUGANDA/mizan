"use client";

import { useQuery } from "@tanstack/react-query";
import { Bell, Inbox } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SeverityBadge } from "@/components/mizan/primitives";
import { api, v1, useAppStore } from "@/lib/client/store";
import { useI18n } from "@/lib/i18n/use-i18n";
import { useEffect, useState } from "react";

interface Notifications {
  items: { id: string; at: string; exceptionKey: string | null; team: string | null; severity: string | null; headline: string; event: string | null }[];
}

/**
 * In-app notification centre (in-app first, §14). Digest note: more than 10
 * notifications for one owner within 15 minutes are grouped server-side.
 */
export function NotificationPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { locale, iso } = useI18n();
  const { setSelectedException, setView } = useAppStore();
  const [seen, setSeen] = useState(0);
  const { data } = useQuery<Notifications>({
    queryKey: ["notifications"],
    queryFn: () => api<Notifications>(v1("/notifications")),
    refetchInterval: 8_000,
  });

  const count = data?.items.length ?? 0;
  useEffect(() => {
    if (open) queueMicrotask(() => setSeen(count));
  }, [open, count]);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button className="relative rounded-md p-2 hover:bg-secondary" aria-label={locale === "ar" ? "الإشعارات" : "Notifications"}>
          <Bell className="h-4 w-4" aria-hidden />
          {count - seen > 0 ? (
            <span className="absolute -end-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[9px] font-bold text-primary-foreground">
              {iso(String(count - seen))}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <ScrollArea className="max-h-96">
          <div className="border-b px-3 py-2 text-sm font-medium">{locale === "ar" ? "الإشعارات" : "Notifications"}</div>
          {!data?.items.length ? (
            <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-xs text-muted-foreground">
              <Inbox className="h-6 w-6" aria-hidden />
              {locale === "ar" ? "لا إشعارات بعد" : "Nothing here yet"}
            </div>
          ) : (
            data.items.map((n) => (
              <button
                key={n.id}
                className="flex w-full items-start gap-2 border-b px-3 py-2 text-start text-xs hover:bg-secondary"
                onClick={() => {
                  if (n.exceptionKey) {
                    setSelectedException(n.exceptionKey);
                    setView("queue");
                    onOpenChange(false);
                  }
                }}
              >
                {n.severity ? <SeverityBadge severity={n.severity as never} /> : null}
                <span className="flex-1">
                  <span className="line-clamp-2">{n.headline}</span>
                  <span className="block text-[10px] text-muted-foreground">{n.team ?? n.event ?? ""}</span>
                </span>
              </button>
            ))
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
