/**
 * Mode controller (§3): M0..M5 with precedence M5 > M4 > M3 > M2 > M1 > M0.
 * Source of truth is the database (system_mode). Mode changes write an audit
 * event and an outbox row. Hysteresis lives in the (stubbed) controller loop.
 */

import { db } from "@/lib/db";
import { appendAudit } from "../audit/chain";
import { randomUUID } from "node:crypto";

export type HealthMode = "M0" | "M1" | "M2" | "M3" | "M4" | "M5";

export const MODE_META: Record<HealthMode, { label: string; labelAr: string; banner: string; bannerAr: string; severity: number }> = {
  M0: { label: "Normal", labelAr: "طبيعي", banner: "", bannerAr: "", severity: 0 },
  M1: { label: "Degraded AI", labelAr: "ذكاء اصطناعي متدهور", banner: "Explanations are shown from approved templates. Narrative polish is off.", bannerAr: "تُعرض الشروحات من قوالب معتمدة. الصياغة بالذكاء الاصطناعي متوقفة.", severity: 1 },
  M2: { label: "Degraded analytics", labelAr: "تحليلات متدهورة", banner: "Dashboards show the last good projection with an as-of label.", bannerAr: "تعرض اللوحات آخر إسقاط صحيح مع تسمية زمنية.", severity: 2 },
  M3: { label: "Degraded storage", labelAr: "تخزين متدهور", banner: "File uploads and evidence packs are paused. Decisions still work.", bannerAr: "تحميل الملفات وحزم الأدلة متوقفة. القرارات تعمل.", severity: 3 },
  M4: { label: "Read-only", labelAr: "قراءة فقط", banner: "MIZAN is read-only: writes are paused. Drafts are kept locally.", bannerAr: "النظام في وضع القراءة فقط: الكتابة متوقفة. تُحفظ المسودات محلياً.", severity: 4 },
  M5: { label: "Safe halt", labelAr: "توقف آمن", banner: "Evaluation halted: an integrity check failed. No new exceptions will be created until this is resolved.", bannerAr: "توقف التقييم: فشل فحص السلامة. لن تُنشأ استثناءات جديدة حتى تُحل المشكلة.", severity: 5 },
};

export function moreSevere(a: HealthMode, b: HealthMode): HealthMode {
  return MODE_META[a].severity >= MODE_META[b].severity ? a : b;
}

export async function getMode(tenantId = "default"): Promise<{ mode: HealthMode; reason: string | null; operator: string | null; since: string }> {
  const row = await db.systemMode.findUnique({ where: { tenantId } });
  if (!row) return { mode: "M0", reason: null, operator: null, since: new Date().toISOString() };
  return { mode: row.mode as HealthMode, reason: row.reason, operator: row.operator, since: row.since.toISOString() };
}

export async function setMode(mode: HealthMode, reason: string, operator: string, tenantId = "default"): Promise<void> {
  const prev = await getMode(tenantId);
  if (prev.mode === mode) return;
  await db.systemMode.upsert({
    where: { tenantId },
    create: { tenantId, mode, reason, operator, signalsJson: "[]" },
    update: { mode, reason, operator, since: new Date(), signalsJson: "[]" },
  });
  await appendAudit({ tenantId, actor: operator, type: "mode.changed", entity: "system_mode", entityId: tenantId, payload: { from: prev.mode, to: mode, reason } });
  await db.outbox.create({
    data: { id: randomUUID(), type: "mode.changed", payloadJson: JSON.stringify({ tenantId, from: prev.mode, to: mode, reason }) },
  });
}
