/**
 * Transactional outbox relay + DLQ replay (FS-12, FS-10).
 * In-app notifications are delivered by marking them sent. Email/webhook
 * channels are off by default; when enabled they need a configured endpoint.
 * After the final attempt a message moves to DlqItem and is replayable.
 */

import { db } from "@/lib/db";
import { randomUUID } from "node:crypto";
import { withRetry } from "./idempotency";

const MAX_ATTEMPTS = 8;

export interface RelayResult {
  scanned: number;
  sent: number;
  failed: number;
  deadLettered: number;
}

async function channelEnabled(type: string): Promise<boolean> {
  const flag = type.includes("email") ? "notifications.email.enabled" : "notifications.webhook.enabled";
  const row = await db.featureFlag.findUnique({ where: { key: flag } });
  return row?.value === "true";
}

export async function relayOutbox(limit = 100): Promise<RelayResult> {
  const pending = await db.outbox.findMany({ where: { status: "pending" }, orderBy: { createdAt: "asc" }, take: limit });
  let sent = 0;
  let failed = 0;
  let deadLettered = 0;
  for (const row of pending) {
    if (row.type === "notification.inapp" || row.type === "mode.changed" || row.type === "flag.changed") {
      await db.outbox.update({ where: { id: row.id }, data: { status: "sent", sentAt: new Date(), attempts: row.attempts + 1 } });
      sent++;
      continue;
    }
    const enabled = await channelEnabled(row.type);
    if (!enabled) {
      await db.outbox.update({ where: { id: row.id }, data: { status: "suppressed", sentAt: new Date() } });
      continue;
    }
    try {
      await withRetry("notify", async (signal) => {
        if (row.type.includes("email")) {
          const url = process.env.MIZAN_SMTP_URL;
          if (!url) throw new Error("MIZAN_SMTP_URL is not configured");
          const res = await fetch(url, { method: "POST", body: row.payloadJson, signal });
          if (!res.ok && res.status !== 429 && res.status < 500) throw new Error(`SMTP bridge ${res.status}`);
          if (!res.ok) throw new Error(`SMTP bridge ${res.status}`);
        } else {
          const url = process.env.MIZAN_WEBHOOK_URL;
          if (!url) throw new Error("MIZAN_WEBHOOK_URL is not configured");
          const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-mizan-event-id": row.id }, body: row.payloadJson, signal });
          if (!res.ok) throw new Error(`webhook ${res.status}`);
        }
      }, { signal: AbortSignal.timeout(20_000) });
      await db.outbox.update({ where: { id: row.id }, data: { status: "sent", sentAt: new Date(), attempts: row.attempts + 1 } });
      sent++;
    } catch (error) {
      const attempts = row.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await db.$transaction(async (tx) => {
          await tx.dlqItem.create({ data: { id: randomUUID(), jobKey: row.id, queue: "route.notify", type: row.type, payloadJson: row.payloadJson, error: String(error), attempts } });
          await tx.outbox.delete({ where: { id: row.id } });
        });
        deadLettered++;
      } else {
        await db.outbox.update({ where: { id: row.id }, data: { status: "pending", attempts, lastError: String(error).slice(0, 500) } });
        failed++;
      }
    }
  }
  return { scanned: pending.length, sent, failed, deadLettered };
}

export interface DlqItemView {
  id: string;
  queue: string;
  jobKey: string;
  attempts: number;
  error: string;
  createdAt: string;
}

export async function listDlq(): Promise<DlqItemView[]> {
  const items = await db.dlqItem.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  return items.map((i) => ({ id: i.id, queue: i.queue, jobKey: i.jobKey, attempts: i.attempts, error: i.error, createdAt: i.createdAt.toISOString() }));
}

export async function replayDlq(id: string): Promise<{ ok: true; outboxId: string }> {
  const item = await db.dlqItem.findUnique({ where: { id } });
  if (!item) throw new Error(`DLQ item ${id} not found`);
  if (item.queue !== "route.notify") throw new Error(`Queue ${item.queue} has no replay consumer in this deployment; fix the worker and replay from the queue.`);
  const outboxId = randomUUID();
  await db.$transaction(async (tx) => {
    await tx.outbox.create({ data: { id: outboxId, type: item.type, payloadJson: item.payloadJson, status: "pending" } });
    await tx.dlqItem.delete({ where: { id } });
  });
  return { ok: true, outboxId };
}

export async function replayAllDlq(since?: string): Promise<{ replayed: number }> {
  const items = await db.dlqItem.findMany({ where: since ? { createdAt: { gte: new Date(since) } } : undefined });
  let replayed = 0;
  for (const item of items) {
    if (item.queue !== "route.notify") continue;
    await replayDlq(item.id);
    replayed++;
  }
  return { replayed };
}
