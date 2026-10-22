"use client";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useI18n } from "@/lib/i18n/use-i18n";

/** Keyboard shortcuts dialog (?). */
export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t } = useI18n();
  const rows: [string, string][] = [
    ["⌘ / Ctrl + K", t("shortcuts.palette")],
    ["J", t("shortcuts.next")],
    ["K", t("shortcuts.prev")],
    ["Esc", t("common.close")],
    ["?", t("shortcuts.help")],
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm" aria-label={t("shortcuts.title")}>
        <DialogHeader>
          <DialogTitle>{t("shortcuts.title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          {rows.map(([k, label]) => (
            <div key={k} className="flex items-center justify-between rounded-md border border-border bg-secondary px-3 py-2 text-sm">
              <span>{label}</span>
              <kbd className="rounded border border-border bg-card px-2 py-0.5 font-mono text-xs">{k}</kbd>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
