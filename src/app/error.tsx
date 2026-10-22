"use client";

/**
 * Global error boundary (10 screen states, §31): renders the error, the MZ
 * correlation hint, and a retry — never a blank screen. Errors keep the
 * Sadu dressing so the shell never looks broken.
 */

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { OctagonAlert } from "lucide-react";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Client-side beacon only; production forwards to the observability sink.
    console.error("mizan:render-error", error.digest ?? error.message);
  }, [error]);

  return (
    <div className="flex min-h-64 flex-col items-center justify-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-8 text-center" role="alert">
      <div className="sadu-band w-24" aria-hidden />
      <OctagonAlert className="h-8 w-8 text-destructive" aria-hidden />
      <p className="text-sm font-semibold">Something went wrong rendering this view</p>
      <p className="max-w-md text-xs text-muted-foreground">
        The failure was logged with a correlation id. Retry the view; if it persists, use the Audit room to check for integrity incidents.
      </p>
      {error.digest ? <p className="font-mono text-[10px] text-muted-foreground">digest: {error.digest}</p> : null}
      <Button size="sm" variant="outline" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
