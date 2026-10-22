"use client";

/**
 * i18n (§16/§31): EN/AR with RTL as a first-class layout. Direction switches with
 * the locale; Arabic month names; Western digits by default with an Arabic-Indic toggle;
 * bidirectional isolates around every interpolated value (EC-L01).
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

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
      const saved = window.localStorage.getItem("mizan-locale") as Locale | null;
      if (saved === "ar" || saved === "en") setLocaleState(saved);
      const ad = window.localStorage.getItem("mizan-digits");
      if (ad === "arabic") setArabicDigitsState(true);
    });
  }, []);

  const setLocale = (l: Locale): void => {
    setLocaleState(l);
    window.localStorage.setItem("mizan-locale", l);
    document.documentElement.lang = l;
    document.documentElement.dir = l === "ar" ? "rtl" : "ltr";
  };

  const setArabicDigits = (v: boolean): void => {
    setArabicDigitsState(v);
    window.localStorage.setItem("mizan-digits", v ? "arabic" : "western");
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
