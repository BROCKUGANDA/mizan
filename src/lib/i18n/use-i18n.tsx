"use client";

/**
 * i18n (§16/§31): EN/AR with RTL as a first-class layout. Direction switches with
 * the locale; Arabic month names; Western digits by default with an Arabic-Indic toggle;
 * bidirectional isolates around every interpolated value (EC-L01).
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { STORAGE_KEYS } from "@/lib/app-config";

export type Locale = "en" | "ar";

type Dict = Record<string, { en: string; ar: string }>;

export const MESSAGES: Dict = {
  "app.name": { en: "MIZAN", ar: "ميزان" },
  "app.tagline": { en: "Continuous HR policy assurance — a census, not a sample", ar: "ضمان مستمر لسياسات الموارد البشرية — تعداد كامل لا عينة" },
  "app.synthetic": { en: "Synthetic data only", ar: "بيانات تركيبية فقط" },
  "nav.overview": { en: "Overview", ar: "نظرة عامة" },
  "nav.queue": { en: "Queue", ar: "قائمة الاستثناءات" },
  "nav.runs": { en: "Runs", ar: "التشغيلات" },
  "nav.rules": { en: "Rule studio", ar: "استوديو القواعد" },
  "nav.patterns": { en: "Patterns", ar: "الأنماط" },
  "nav.audit": { en: "Audit", ar: "التدقيق" },
  "nav.integrations": { en: "Integrations", ar: "التكاملات" },
  "nav.settings": { en: "Settings", ar: "الإعدادات" },
  "integrations.title": { en: "Integration seams", ar: "نقاط التكامل" },
  "integrations.subtitle": { en: "Stubs by design — each card is the exact seam a production adapter will fill", ar: "محاكاة بالتصميم — كل بطاقة هي نقطة التكامل التي سيملؤها المحوّل الإنتاجي" },
  "integrations.banner": { en: "Live Emirates systems are intentionally not connected. The synthetic-data red line keeps this environment isolated; every stub documents the production swap.", ar: "أنظمة الإمارات الحية غير متصلة عمداً. يحافظ الخط الأحمر للبيانات التركيبية على عزل هذه البيئة؛ وكل محاكاة توثق التبديل الإنتاجي." },
  "integrations.dryRun": { en: "Dry run", ar: "تشغيل تجريبي" },
  "integrations.dryRunning": { en: "Running…", ar: "جارٍ التشغيل…" },
  "integrations.dryRunOk": { en: "Dry run complete", ar: "اكتمل التشغيل التجريبي" },
  "integrations.recordCount": { en: "records in page", ar: "سجلاً في الصفحة" },
  "integrations.shape": { en: "Payload shape", ar: "شكل الحِمل" },
  "integrations.sample": { en: "Sample record", ar: "سجل عينة" },
  "integrations.configKeys": { en: "Configuration", ar: "الإعدادات" },
  "integrations.set": { en: "set", ar: "مُعرَّف" },
  "integrations.unset": { en: "not set", ar: "غير معرَّف" },
  "integrations.secret": { en: "vault-injected", ar: "يُحقن من الخزنة" },
  "integrations.guardrails": { en: "Guardrails upheld at this seam", ar: "ضمانات محفوظة عند نقطة التكامل" },
  "integrations.production": { en: "Production target", ar: "الهدف الإنتاجي" },
  "integrations.canWrite": { en: "Can write", ar: "قادر على الكتابة" },
  "integrations.readOnly": { en: "Read-only", ar: "قراءة فقط" },
  "integrations.stub": { en: "STUB", ar: "محاكاة" },
  "integrations.live": { en: "LIVE", ar: "مباشر" },
  "integrations.audited": { en: "Every dry-run is an audit event", ar: "كل تشغيل تجريبي حدث تدقيق" },
  "integrations.humanNote": { en: "Changing transactions automatically is impossible by design — corrections are proposals a human applies.", ar: "تغيير المعاملات تلقائياً مستحيل بالتصميم — التصحيحات مقترحات يطبقها البشر." },
  "theme.accent": { en: "Accent theme", ar: "سمة اللون" },
  "theme.emirates": { en: "Emirates Crimson", ar: "قرمزي الإمارات" },
  "theme.oasis": { en: "Oasis", ar: "الواحة" },
  "theme.pearl": { en: "Pearl", ar: "اللؤلؤة" },
  "theme.dawn": { en: "Desert Dawn", ar: "فجر الصحراء" },
  "theme.majlis": { en: "Majlis", ar: "المجلس" },
  "theme.saffron": { en: "Saffron", ar: "الزعفران" },
  "theme.projector": { en: "Projector (1280×720)", ar: "البروجكتور (1280×720)" },
  "theme.light": { en: "Light", ar: "فاتح" },
  "theme.dark": { en: "Dark", ar: "داكن" },
  "theme.system": { en: "System", ar: "النظام" },
  "common.view": { en: "Open view", ar: "افتح العرض" },
  "mode.M0": { en: "Normal", ar: "طبيعي" },
  "mode.M1": { en: "Degraded AI", ar: "ذكاء اصطناعي متدهور" },
  "mode.M2": { en: "Degraded analytics", ar: "تحليلات متدهورة" },
  "mode.M3": { en: "Degraded storage", ar: "تخزين متدهور" },
  "mode.M4": { en: "Read-only", ar: "قراءة فقط" },
  "mode.M5": { en: "Safe halt", ar: "توقف آمن" },
  "severity.CRITICAL": { en: "Critical", ar: "حرجة" },
  "severity.HIGH": { en: "High", ar: "عالية" },
  "severity.MEDIUM": { en: "Medium", ar: "متوسطة" },
  "severity.LOW": { en: "Low", ar: "منخفضة" },
  "status.NEW": { en: "New", ar: "جديد" },
  "status.TRIAGED": { en: "Triaged", ar: "مُفرز" },
  "status.ASSIGNED": { en: "Assigned", ar: "مُسند" },
  "status.IN_PROGRESS": { en: "In progress", ar: "قيد المعالجة" },
  "status.PENDING_VERIFICATION": { en: "Pending verification", ar: "بانتظار التحقق" },
  "status.CLOSED": { en: "Closed", ar: "مغلق" },
  "status.DISMISSED": { en: "Dismissed", ar: "مستبعد" },
  "status.ACCEPTED_RISK": { en: "Accepted risk", ar: "مخاطرة مقبولة" },
  "status.DUPLICATE": { en: "Duplicate", ar: "مكرر" },
  "status.REOPENED": { en: "Reopened", ar: "معاد فتحه" },
  "queue.title": { en: "Exception queue", ar: "قائمة الاستثناءات" },
  "queue.empty": { en: "No exceptions match the filters. Clear filters or start a run.", ar: "لا توجد استثناءات مطابقة للمرشحات. امسح المرشحات أو ابدأ تشغيلاً." },
  "queue.empty.noRun": { en: "No run yet. Start the first run to fill the queue.", ar: "لا يوجد تشغيل بعد. ابدأ التشغيل الأول لملء القائمة." },
  "decision.triage": { en: "Triage", ar: "فرز" },
  "decision.assign": { en: "Assign", ar: "إسناد" },
  "decision.start": { en: "Start work", ar: "بدء المعالجة" },
  "decision.record_fix": { en: "Record fix", ar: "تسجيل الإصلاح" },
  "decision.verify": { en: "Verify & close", ar: "تحقق وإغلاق" },
  "decision.dismiss": { en: "Dismiss", ar: "استبعاد" },
  "decision.accept_risk": { en: "Accept risk", ar: "قبول المخاطرة" },
  "decision.mark_duplicate": { en: "Mark duplicate", ar: "وسم كمكرر" },
  "decision.reopen": { en: "Reopen", ar: "إعادة فتح" },
  "decision.countersign": { en: "Countersign", ar: "توقيع مشترك" },
  "common.loading": { en: "Loading…", ar: "جارٍ التحميل…" },
  "common.error": { en: "Something went wrong", ar: "حدث خطأ ما" },
  "common.retry": { en: "Retry", ar: "إعادة المحاولة" },
  "common.cancel": { en: "Cancel", ar: "إلغاء" },
  "common.close": { en: "Close", ar: "إغلاق" },
  "common.save": { en: "Save", ar: "حفظ" },
  "common.confirm": { en: "Confirm", ar: "تأكيد" },
  "common.reset": { en: "Reset", ar: "إعادة تعيين" },
  "common.language": { en: "العربية", ar: "English" },
  "common.startRun": { en: "Start run", ar: "بدء تشغيل" },
  "common.export": { en: "Export", ar: "تصدير" },
  "overview.census": { en: "Census", ar: "التعداد" },
  "overview.readiness": { en: "Audit readiness", ar: "جاهزية التدقيق" },
  "overview.hotspots": { en: "Hotspots", ar: "البؤر الساخنة" },
  "overview.trends": { en: "Trends", ar: "الاتجاهات" },
  "overview.coverage": { en: "Coverage matrix", ar: "مصفوفة التغطية" },
  "shortcuts.title": { en: "Keyboard shortcuts", ar: "اختصارات لوحة المفاتيح" },
  "shortcuts.palette": { en: "Command palette", ar: "لوحة الأوامر" },
  "shortcuts.next": { en: "Next item", ar: "العنصر التالي" },
  "shortcuts.prev": { en: "Previous item", ar: "العنصر السابق" },
  "shortcuts.help": { en: "Show shortcuts", ar: "إظهار الاختصارات" },
  "stillWorking": { en: "Still working…", ar: "ما زلنا نعمل…" },
  "stale": { en: "Showing results from an earlier projection", ar: "تُعرض نتائج من إسقاط سابق" },

  /* ── Shell (header / footer / popover chrome) ──────────────────────────── */
  "app.skipToContent": { en: "Skip to content", ar: "تخطَّ إلى المحتوى" },
  "app.themeMenu": { en: "Appearance", ar: "المظهر" },
  "app.roleSwitcher": { en: "Role switcher", ar: "تبديل الدور" },
  "app.kbdHint": { en: "for anything, instantly", ar: "للوصول السريع إلى كل شيء" },
  "app.notifications": { en: "Notifications", ar: "الإشعارات" },
  "mode.judge": { en: "Judge mode", ar: "وضع المُقيِّم" },
  "common.resetComplete": { en: "Reset complete", ar: "تمت إعادة التعيين" },
  "app.footer.principles": {
    en: "synthetic data only · the engine decides, the model explains",
    ar: "بيانات تركيبية فقط · المحرك يقرر، والنموذج يفسّر",
  },

  /* ── Notification centre ───────────────────────────────────────────────── */
  "notifications.empty": { en: "Nothing here yet", ar: "لا إشعارات بعد" },
  "notifications.justNow": { en: "just now", ar: "الآن" },

  /* ── Command palette ───────────────────────────────────────────────────── */
  "palette.placeholder": { en: "Search views or exceptions…", ar: "ابحث عن وجهة أو استثناء…" },
  "palette.empty": { en: "No results", ar: "لا نتائج" },
  "palette.goto": { en: "Go to", ar: "التنقل" },
  "palette.exceptions": { en: "Exceptions", ar: "استثناءات" },

  /* ── Overview view ─────────────────────────────────────────────────────── */
  "overview.greetingMorning": { en: "Good morning", ar: "صباح الخير" },
  "overview.greetingAfternoon": { en: "Good afternoon", ar: "مساء الخير" },
  "overview.greetingEvening": { en: "Good evening", ar: "مساء الخير" },
  "overview.censusCurrent": { en: "Census current", ar: "التعداد محدَّث" },
  "overview.runStarted": { en: "Run started", ar: "بدأ التشغيل" },
  "overview.asOf": { en: "as of", ar: "كما في" },
  "overview.outputHash": { en: "Output hash (sha-256, truncated)", ar: "هاش المخرجات" },
  "overview.noCensus.title": { en: "No census yet", ar: "لا يوجد تعداد بعد" },
  "overview.noCensus.hint": { en: "Start the first run to evaluate every transaction against every active rule and produce the full census (FS-02).", ar: "ابدأ التشغيل الأول لتحليل كل معاملة مقابل كل قاعدة نشطة وإنتاج التعداد الكامل (FS-02)." },
  "overview.censusReconciliation": { en: "Census reconciliation", ar: "معادلة التعداد" },
  "overview.transactions": { en: "transactions", ar: "معاملة" },
  "overview.rules": { en: "rules", ar: "قاعدة" },
  "overview.checks": { en: "checks", ar: "فحص" },
  "overview.applicable": { en: "applicable", ar: "منطبق" },
  "overview.evaluated": { en: "evaluated", ar: "مُقيَّم" },
  "overview.notEvaluable": { en: "not evaluable", ar: "غير قابل للتقييم" },
  "overview.failed": { en: "failed", ar: "فشل" },
  "overview.passed": { en: "passed", ar: "ناجح" },
  "overview.notApplicable": { en: "not applicable", ar: "غير منطبق" },
  "overview.quarantined": { en: "quarantined", ar: "محجور" },
  "overview.held": { en: "held", ar: "محتجز" },
  "overview.dqExceptions": { en: "data-quality exceptions", ar: "استثناءات جودة بيانات" },
  "overview.hold": { en: "Hold", ar: "احتجاز" },
  "overview.auditReady": { en: "Audit ready", ar: "جاهز للتدقيق" },
  "overview.hardening": { en: "Hardening in progress", ar: "قيد التحصين" },
  "overview.compositeScore": { en: "Composite score out of ", ar: "الدرجة المركّبة من " },
  "overview.weight": { en: "w", ar: "وزن" },
  "overview.nextBestAction": { en: "Next best action", ar: "أفضل إجراء تالٍ" },
  "overview.openBySeverity": { en: "Open by severity", ar: "المفتوحة حسب الخطورة" },
  "overview.openTotal": { en: "Open total", ar: "إجمالي المفتوحة" },
  "overview.allExceptions": { en: "All exceptions", ar: "كل الاستثناءات" },
  "overview.noHotspots.title": { en: "No hotspots", ar: "لا توجد بؤر ساخنة" },
  "overview.noHotspots.hint": { en: "Process × rule cells appear here after the first run.", ar: "ستظهر العمليات × القواعد هنا بعد التشغيل الأول." },
  "overview.process": { en: "Process", ar: "العملية" },
  "overview.rule": { en: "Rule", ar: "القاعدة" },
  "overview.count": { en: "Count", ar: "العدد" },
  "overview.per1000": { en: "Per 1,000", ar: "لكل ١٠٠٠" },
  "overview.noTrends.title": { en: "No trend data", ar: "لا توجد بيانات اتجاهات" },
  "overview.noTrends.hint": { en: "Monthly trend appears after the first run.", ar: "تظهر الاتجاهات الشهرية بعد أول تشغيل." },
  "overview.trendsAria": { en: "Exceptions per month by severity", ar: "استثناءات لكل شهر حسب الخطورة" },
  "overview.topGroups": { en: "Top groups", ar: "أكبر المجموعات" },
  "overview.topGroupsHint": { en: "click to open the queue", ar: "اضغط للانتقال إلى القائمة" },
  "overview.noGroups.title": { en: "No groups yet", ar: "لا توجد مجموعات" },
  "overview.noGroups.hint": { en: "Similar exceptions are grouped automatically after a run.", ar: "تُجمَّع الاستثناءات المتشابهة تلقائياً بعد التشغيل." },
  "overview.sentencesClassified": { en: "sentences classified — every written rule accounted for", ar: "جملة مصنَّفة — كل قاعدة مكتوبة محسوبة" },
  "overview.compiledChecks": { en: "Compiled checks", ar: "مُجمَّعة (فحوص)" },
  "overview.definitions": { en: "Definitions", ar: "تعريفات" },
  "overview.attestations": { en: "Human attestations", ar: "إقرارات بشرية" },
  "overview.scopeNotes": { en: "Scope notes", ar: "ملاحظات نطاق" },
  "overview.measuredPrecision": { en: "Measured precision (Wilson lower bound)", ar: "الدقة المقاسة (حد ويلسون الأدنى)" },
  "overview.confirmedDecisions": { en: "confirmed decisions", ar: "قرارات مؤكدة" },
  "overview.noDecisions": { en: "No hand-labelled decisions yet.", ar: "لا توجد قرارات مُصنَّفة يدوياً بعد." },
  "overview.patternAlerts": { en: "advisory pattern alerts awaiting review", ar: "تنبيهات أنماط استشارية في انتظار المراجعة" },

  /* ── Runs view ─────────────────────────────────────────────────────────── */
  "runs.started": { en: "Run started", ar: "بدأ التشغيل" },
  "runs.startNew": { en: "Start a new run", ar: "بدء تشغيل جديد" },
  "runs.startHint": { en: "Each run evaluates every transaction × every active rule (a full census).", ar: "كل تشغيل يُقيِّم كل معاملة × كل قاعدة نشطة (تعداد كامل)." },
  "runs.kindAria": { en: "Run kind", ar: "نوع التشغيل" },
  "runs.kindStandard": { en: "Standard", ar: "قياسي" },
  "runs.kindShadow": { en: "Shadow (no side effects)", ar: "ظلّي (بدون تأثير)" },
  "runs.kindBacktest": { en: "Backtest", ar: "اختبار رجعي" },
  "runs.asOfAria": { en: "As-of date (optional)", ar: "تاريخ البيانات (اختياري)" },
  "runs.checks": { en: "checks", ar: "فحص" },
  "runs.noRuns.title": { en: "No runs yet", ar: "لا توجد تشغيلات بعد" },
  "runs.noRuns.hint": { en: "Start the first run with the controls above to fill the exception queue.", ar: "ابدأ التشغيل الأول بالأزرار أعلاه لملء قائمة الاستثناءات." },
  "runs.asOf": { en: "as of", ar: "كما في" },
  "runs.failed": { en: "failed", ar: "فشل" },
  "runs.notEvaluable": { en: "not evaluable", ar: "غير قابل للتقييم" },
  "runs.held": { en: "held", ar: "محتجز" },
  "runs.holdCount": { en: "hold(s)", ar: "احتجاز" },
  "runs.startedAt": { en: "started", ar: "بدأ" },
  "runs.detail": { en: "Run detail", ar: "تفاصيل التشغيل" },
  "runs.manifest": { en: "Run manifest", ar: "بيان التشغيل (manifest)" },
  "runs.hold": { en: "Hold", ar: "احتجاز" },
  "runs.perRuleMatrix": { en: "Per-rule coverage matrix", ar: "مصفوفة التغطية لكل قاعدة" },
  "runs.noPerRule": { en: "No per-rule results", ar: "لا توجد نتائج لكل قاعدة" },
  "runs.perRuleAria": { en: "Per-rule coverage matrix", ar: "مصفوفة التغطية" },
  "runs.colRule": { en: "Rule", ar: "القاعدة" },
  "runs.colTotal": { en: "Total", ar: "الإجمالي" },
  "runs.colPass": { en: "Pass", ar: "ناجح" },
  "runs.colNA": { en: "N/A", ar: "غير منطبق" },
  "runs.colNotEvaluable": { en: "Not evaluable", ar: "غير قابل للتقييم" },
  "runs.colFailed": { en: "Failed", ar: "فشل" },
  "runs.exportTitle": { en: "Export (FS-20)", ar: "التصدير (FS-20)" },
  "runs.exportLocked": { en: "Export unlocks when the run completes (COMPLETED, COMPLETED_WITH_HOLDS or COMPLETED_WITH_DQ).", ar: "يتاح التصدير بعد اكتمال التشغيل (COMPLETED أو WITH_HOLDS أو WITH_DQ)." },
  "runs.validatorPassedPrefix": { en: "Export validator passed —", ar: "اجتاز مُصادِق التصدير — أُعيد إنتاج" },
  "runs.validatorPassedSuffix": { en: "worked examples reproduced", ar: "من الأمثلة المرجعية" },
  "runs.profile": { en: "profile", ar: "الملف الشخصي" },
  "runs.findingsSha": { en: "findings sha-256", ar: "هاش الملف" },
  "runs.validatorFailed": { en: "Export validator failed — downloads are disabled", ar: "فشل مُصادِق التصدير — التنزيل معطّل" },
  "runs.colTransaction": { en: "Transaction", ar: "المعاملة" },
  "runs.colColumn": { en: "Column", ar: "العمود" },
  "runs.colExpected": { en: "Expected", ar: "المتوقع" },
  "runs.colActual": { en: "Actual", ar: "الفعلي" },
  "runs.downloadFindings": { en: "Download findings CSV", ar: "تنزيل ملف النتائج" },
  "runs.downloadFindingsDisabled": { en: "Download findings CSV (disabled: validator failed)", ar: "تنزيل ملف النتائج (معطّل: فشل المُصادِق)" },
  "runs.downloadDq": { en: "Download data quality CSV", ar: "تنزيل ملف جودة البيانات" },
  "runs.selectRun.title": { en: "Select a run to inspect", ar: "اختر تشغيلاً لعرض التفاصيل" },
  "runs.selectRun.hint": { en: "The manifest, coverage matrix, holds and the export panel appear here.", ar: "يعرض البيان، مصفوفة التغطية، الاحتجازات ولوحة التصدير." },

  /* ── Audit view ────────────────────────────────────────────────────────── */
  "audit.verifyCommand": { en: "`mizan audit verify`", ar: "mizan audit verify" },
};

interface I18nCtx {
  locale: Locale;
  dir: "ltr" | "rtl";
  setLocale: (l: Locale) => void;
  t: (key: string) => string;
  arabicDigits: boolean;
  setArabicDigits: (v: boolean) => void;
  /** Wrap an interpolated value in bidirectional isolates (EC-L01). */
  iso: (value: string) => string;
}

const Ctx = createContext<I18nCtx>({
  locale: "en",
  dir: "ltr",
  setLocale: () => undefined,
  t: (k) => MESSAGES[k]?.en ?? k,
  arabicDigits: false,
  setArabicDigits: () => undefined,
  iso: (v) => v,
});

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en");
  const [arabicDigits, setArabicDigitsState] = useState(false);

  useEffect(() => {
    queueMicrotask(() => {
      const saved = window.localStorage.getItem(STORAGE_KEYS.locale) as Locale | null;
      if (saved === "ar" || saved === "en") setLocaleState(saved);
      const ad = window.localStorage.getItem(STORAGE_KEYS.digits);
      if (ad === "arabic") setArabicDigitsState(true);
    });
  }, []);

  const setLocale = (l: Locale): void => {
    setLocaleState(l);
    window.localStorage.setItem(STORAGE_KEYS.locale, l);
    document.documentElement.lang = l;
    document.documentElement.dir = l === "ar" ? "rtl" : "ltr";
  };

  const setArabicDigits = (v: boolean): void => {
    setArabicDigitsState(v);
    window.localStorage.setItem(STORAGE_KEYS.digits, v ? "arabic" : "western");
  };

  const t = (key: string): string => MESSAGES[key]?.[locale] ?? key;

  const convertDigits = (s: string): string =>
    arabicDigits ? s.replace(/\d/g, (d) => ARABIC_INDIC[Number(d)]!) : s;

  const iso = (value: string): string => convertDigits(value);

  return (
    <Ctx.Provider
      value={{ locale, dir: locale === "ar" ? "rtl" : "ltr", setLocale, t, arabicDigits, setArabicDigits, iso }}
    >
      {children}
    </Ctx.Provider>
  );
}

export const useI18n = (): I18nCtx => useContext(Ctx);
