/**
 * Background jobs for the single-process deployment: integrity verification
 * hourly and the deadline tick every five minutes. On a split deployment these
 * are the worker's cron entries; the functions are the same.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NODE_ENV === "test") return;
  const g = globalThis as unknown as { __mizanJobs?: boolean };
  if (g.__mizanJobs) return;
  g.__mizanJobs = true;

  const { verifyChain } = await import("@/lib/audit/chain");
  const { getMode, setMode } = await import("@/lib/server/mode");
  const { runDeadlineTick } = await import("@/lib/server/deadlines");
  const { relayOutbox } = await import("@/lib/server/outbox");

  const verify = async (): Promise<void> => {
    try {
      const result = await verifyChain();
      if (!result.ok) {
        const mode = await getMode();
        if (mode.mode !== "M5") await setMode("M5", `integrity.verify failed at seq ${result.firstBadSeq}`, "system:integrity");
      }
    } catch {
      // The job must not crash the process; the next interval retries and the
      // /audit/verify endpoint remains an explicit on-demand check.
    }
  };

  const tick = async (): Promise<void> => {
    try {
      await runDeadlineTick();
    } catch {
      // Same discipline: a failed tick is retried on the next interval; the
      // durable deadline state means no reminder is lost.
    }
  };

  const relay = async (): Promise<void> => {
    try {
      await relayOutbox();
    } catch {
      // The outbox is durable; the next relay pass retries.
    }
  };

  setTimeout(() => { void verify(); }, 2_000);
  setTimeout(() => { void relay(); }, 5_000);
  setInterval(() => { void verify(); }, 60 * 60 * 1000);
  setInterval(() => { void tick(); }, 5 * 60 * 1000);
  setInterval(() => { void relay(); }, 30 * 1000);
}
