/**
 * Integration registry — one catalog of every seam between MIZAN and the
 * outside world, with live health and a config checklist per adapter.
 *
 * The sandbox ships STUBS ONLY (synthetic-data red line). Each entry declares:
 *  - what the production integration is,
 *  - which env keys flip it on,
 *  - whether it can ever write (only writeback, humans first).
 *
 * The /api/v1/integrations surface reads from here; the Integrations view
 * renders it. Dry-runs are recorded as audit events (actor-scoped, redacted).
 */

import { getErpAdapter, type ErpAdapter } from "./finance-adapter";
import { getHrmsAdapter, type HrmsAdapter } from "./hrms-adapter";
import { OIDC_STUB, emailChannel, webhookChannel, cache } from "./stubs";
import { writebackAdapter, type WritebackAdapter } from "./writeback-adapter";

export type IntegrationCategory = "identity" | "hrms" | "finance" | "writeback" | "notify" | "storage" | "cache";

export interface IntegrationConfigKey {
  key: string;
  purpose: string;
  present: boolean;
  secret: boolean; // masked in every surface, never echoed back
}

export interface IntegrationEntry {
  id: string;
  label: string;
  labelAr: string;
  category: IntegrationCategory;
  /** What the production integration is (docs/INTEGRATIONS.md has the runbook). */
  production: string;
  productionAr: string;
  mode: "stub" | "live";
  canWrite: boolean;
  /** Human-in-the-loop guarantees this seam upholds. */
  guardrails: string[];
  guardrailsAr: string[];
  configKeys: IntegrationConfigKey[];
  /** Probe the adapter; never throws. */
  health: () => Promise<{ ok: boolean; detail: string; mode: string }>;
}

function cfg(key: string, purpose: string, secret = false): IntegrationConfigKey {
  return { key, purpose, present: Boolean(process.env[key]), secret };
}

function buildRegistry(): IntegrationEntry[] {
  const hrms: HrmsAdapter = getHrmsAdapter();
  const erp: ErpAdapter = getErpAdapter();
  const wb: WritebackAdapter = writebackAdapter;

  return [
    {
      id: "hrms",
      label: "HRMS — employee master",
      labelAr: "نظام الموارد البشرية — البيانات الأساسية للموظفين",
      category: "hrms",
      production: "SAP SuccessFactors / Oracle HCM OData pull of grades, org placement and roles (read-only). Feeds rule evaluation joins.",
      productionAr: "سحب OData من SuccessFactors أو Oracle HCM للدرجات والهيكل التنظيمي والأدوار (قراءة فقط). يغذي تقييم القواعد.",
      mode: "stub",
      canWrite: false,
      guardrails: [
        "Synthetic data only in this environment",
        "Least-attributes pull — never nationality or free-text HR notes",
        "Source hash recorded in the run manifest",
      ],
      guardrailsAr: [
        "بيانات تركيبية فقط في هذه البيئة",
        "سحب الحد الأدنى من السمات — لا جنسية ولا ملاحظات نصية",
        "تُسجَّل بصمة المصدر في بيان التشغيل",
      ],
      configKeys: [cfg("MIZAN_HRMS_MODE", "stub | live"), cfg("MIZAN_HRMS_URL", "https base URL of the HRMS OData endpoint")],
      health: async () => {
        const h = await hrms.health();
        return { ok: h.ok, detail: h.detail, mode: h.mode };
      },
    },
    {
      id: "finance",
      label: "Finance ERP — transaction feed",
      labelAr: "نظام المالية — تغذية المعاملات",
      category: "finance",
      production: "SAP FI / Oracle Fusion pull of claims and approvals with watermark cursoring and exactly-once inbox dedup.",
      productionAr: "سحب المعاملات والموافقات من SAP FI أو Oracle Fusion مع ترميز مائي وإلغاء تكرار دقيق.",
      mode: "stub",
      canWrite: false,
      guardrails: [
        "Amounts cross as integer fils — floating-point money never enters",
        "Payload signature verified before ingest",
        "Source hash recorded in the run manifest",
      ],
      guardrailsAr: [
        "تُمرَّر المبالغ كأعداد صحيحة (فلس) — لا فواصل عشرية",
        "التحقق من توقيع الحِمل قبل الإدخال",
        "تُسجَّل بصمة المصدر في بيان التشغيل",
      ],
      configKeys: [cfg("MIZAN_ERP_MODE", "stub | live"), cfg("MIZAN_ERP_URL", "https base URL of the ERP OData/IDoc gateway")],
      health: async () => {
        const h = await erp.health();
        return { ok: h.ok, detail: h.detail, mode: h.mode };
      },
    },
    {
      id: "writeback",
      label: "Write-back — correction proposals",
      labelAr: "الكتابة العكسية — مقترحات التصحيح",
      category: "writeback",
      production: "Correction proposals from human-verified closures. Target system's own workflow applies and confirms; MIZAN verifies the echo.",
      productionAr: "مقترحات تصحيح من الإغلاقات التي تحقق منها البشر. يطبّقها سير العمل في النظام الهدف ويؤكدها، ويتحقق MIZAN من الصدى.",
      mode: "stub",
      canWrite: true,
      guardrails: [
        "No automatic mutation — ever: proposals only by default",
        "Proposer ≠ verifier enforced in code",
        "Every proposal carries the evidence hash chain",
      ],
      guardrailsAr: [
        "لا تعديل تلقائي مطلقاً — مقترحات فقط افتراضياً",
        "المُقترِح لا يُحقّق من عمله (مفروض في الكود)",
        "كل مقترح يحمل سلسلة بصمة الدليل",
      ],
      configKeys: [
        cfg("MIZAN_WRITEBACK", "proposals_only (default) | human_approved_api"),
      ],
      health: async () => {
        const h = await wb.health();
        return { ok: h.ok, detail: h.detail, mode: h.transport };
      },
    },
    {
      id: "identity",
      label: "Identity — OIDC SSO",
      labelAr: "الهوية — تسجيل الدخول الموحد",
      category: "identity",
      production: "Entra ID / Emirates IdP, Authorization Code + PKCE; directory groups map to MIZAN roles (admin/compliance_lead/team_lead/auditor/analyst).",
      productionAr: "Entra ID / مزوّد هوية الإمارات مع رمز التفويض و PKCE؛ مجموعات الدليل تُربط بأدوار ميزان.",
      mode: "stub",
      canWrite: false,
      guardrails: ["No passwords in MIZAN — IdP owns auth", "Group mapping is versioned config", "Judge profile uses the role switcher instead"],
      guardrailsAr: ["لا كلمات مرور في ميزان — مزوّد الهوية يدير المصادقة", "ربط المجموعات إعدادات مُصوغة", "يستخدم ملف المُقيِّم مبدّل الأدوار"],
      configKeys: [cfg("OIDC_ISSUER", "IdP issuer URL"), cfg("OIDC_CLIENT_ID", "client id"), cfg("OIDC_CLIENT_SECRET", "vault-injected", true)],
      health: async () => ({
        ok: true,
        mode: "stub",
        detail: OIDC_STUB.issuer === "stub://local" ? "stub: local role-switcher auth; set OIDC_ISSUER/OIDC_CLIENT_ID (+ vault secret) to integrate" : "config present; live OIDC handshake is an integration point",
      }),
    },
    {
      id: "notify",
      label: "Notifications — email / Teams / webhook",
      labelAr: "الإشعارات — البريد والفرق وويب هوك",
      category: "notify",
      production: "SMTP or Microsoft Graph for severity digests (routing rules own who and when); webhooks for GRC fan-out with event-ID dedup.",
      productionAr: "SMTP أو Microsoft Graph لملخصات الحدة؛ ويب هوكات للتوزيع مع إلغاء تكرار معرّف الحدث.",
      mode: "stub",
      canWrite: false,
      guardrails: ["Severity + sign-on link only — never personal data", "Outbox is the durable record; channels are best-effort"],
      guardrailsAr: ["الحدة ورابط الدخول فقط — لا بيانات شخصية", "صندوق الصادر هو السجل الدائم؛ القنوات قابلة للتكرار بأمان"],
      configKeys: [cfg("MIZAN_SMTP_URL", "SMTP relay", true), cfg("MIZAN_WEBHOOK_URL", "GRC webhook", true)],
      health: async () => {
        const e = await emailChannel.send({ to: "probe", subject: "probe", body: "probe" });
        const w = await webhookChannel.send({ to: "probe", subject: "probe", body: "probe" });
        return { ok: false, mode: "stub", detail: `${e.error ?? "ok"}; ${w.error ?? "ok"} — the outbox viewer shows every message instead` };
      },
    },
    {
      id: "storage",
      label: "Object storage — evidence packs (WORM)",
      labelAr: "التخزين — حزم الأدلة (كتابة مرة واحدة)",
      category: "storage",
      production: "S3-compatible bucket with Object Lock (WORM, compliance mode) and SSE-KMS; sandbox uses a local filesystem adapter with the same interface.",
      productionAr: "دلو S3 مع قفل الكائنات وكشف تشفير KMS؛ تستخدم الحاوية نظام ملفات محلي بنفس الواجهة.",
      mode: "stub",
      canWrite: false,
      guardrails: ["Immutable once written", "SHA-256 etag per object", "Evidence pack hashes surface in exports"],
      guardrailsAr: ["غير قابل للتغيير بعد الكتابة", "بصمة SHA-256 لكل كائن", "تظهر بصمات الحزم في التصدير"],
      configKeys: [cfg("OBJECT_STORE_ROOT", "local root (sandbox)"), cfg("MIZAN_S3_BUCKET", "S3 bucket (production)")],
      health: async () => ({ ok: true, mode: "stub", detail: "local filesystem adapter — swap for the S3 client in production (docs/INTEGRATIONS.md)" }),
    },
    {
      id: "cache",
      label: "Cache — Valkey-compatible",
      labelAr: "الذاكرة المؤقتة — متوافقة مع Valkey",
      category: "cache",
      production: "Valkey with short TTLs for reads only; CACHE_DISABLED=true must leave the product fully correct (chaos-tested).",
      productionAr: "Valkey بمدد قصيرة للقراءة فقط؛ يجب أن يبقى المنتج صحيحاً تماماً مع تعطيل الذاكرة المؤقتة.",
      mode: "stub",
      canWrite: false,
      guardrails: ["Never authoritative", "Correct with cache OFF", "Rate limiter shares the same client in production"],
      guardrailsAr: ["غير مرجعية أبداً", "صحيح مع تعطيل الذاكرة المؤقتة", "مُحدِّد المعدل يشارك العميل نفسه في الإنتاج"],
      configKeys: [cfg("CACHE_DISABLED", "true disables the cache"), cfg("MIZAN_VALKEY_URL", "Valkey endpoint (production)")],
      health: async () => {
        await cache.set("mizan-probe", "1", 5);
        const v = await cache.get("mizan-probe");
        return { ok: v === "1", mode: "stub", detail: v === "1" ? "in-memory cache answering" : "cache disabled (chaos mode) — product remains correct by design" };
      },
    },
  ];
}

let registryCache: IntegrationEntry[] | null = null;

export function getIntegrationRegistry(): IntegrationEntry[] {
  registryCache ??= buildRegistry();
  return registryCache;
}

export function getIntegration(id: string): IntegrationEntry | undefined {
  return getIntegrationRegistry().find((i) => i.id === id);
}

/** Public (masked) shape for API responses — secret values never leave the process. */
export function serializeIntegration(e: IntegrationEntry, health: { ok: boolean; detail: string; mode: string }) {
  return {
    id: e.id,
    label: e.label,
    labelAr: e.labelAr,
    category: e.category,
    production: e.production,
    productionAr: e.productionAr,
    mode: e.mode,
    liveConfigured: e.configKeys.filter((k) => !k.secret).every((k) => k.present),
    canWrite: e.canWrite,
    guardrails: e.guardrails,
    guardrailsAr: e.guardrailsAr,
    configKeys: e.configKeys.map((k) => ({ key: k.key, purpose: k.purpose, present: k.present, secret: k.secret })),
    health,
  };
}
