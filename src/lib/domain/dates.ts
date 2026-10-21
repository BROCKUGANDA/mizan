/**
 * Dates & time: LocalDate (YYYY-MM-DD, Asia/Dubai), instants (ISO UTC),
 * day-month order inference (EC-B01/B02), spreadsheet serials (EC-B03),
 * Asia/Dubai default offset (EC-B04, FS-21 clock discipline), month arithmetic
 * with end-of-month clamping (EC-F07).
 * Pure: no wall-clock reads anywhere in the engine.
 */

export type LocalDate = string; // YYYY-MM-DD
export type Instant = string;   // ISO 8601 UTC with Z

export const GST_OFFSET_MINUTES = 240; // Asia/Dubai, UTC+4, no DST

export function isValidLocalDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function parseLocalDate(s: string): { y: number; m: number; d: number } | null {
  if (!isValidLocalDate(s)) return null;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  return { y, m, d };
}

export function toLocalDate(y: number, m: number, d: number): LocalDate {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Days-from-epoch for a LocalDate (UTC noon anchor to avoid DST edges). */
export function localDateToDays(s: LocalDate): number {
  const p = parseLocalDate(s);
  if (!p) return NaN;
  return Math.floor(Date.UTC(p.y, p.m - 1, p.d) / 86_400_000);
}

export function daysToLocalDate(days: number): LocalDate {
  const ms = days * 86_400_000;
  const dt = new Date(ms);
  return toLocalDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function addDays(s: LocalDate, n: number): LocalDate {
  return daysToLocalDate(localDateToDays(s) + n);
}

/** Signed day difference a − b, in calendar days. */
export function diffDays(a: LocalDate, b: LocalDate): number {
  return localDateToDays(a) - localDateToDays(b);
}

/** Month arithmetic with end-of-month clamping: 2026-01-31 + 1 month = 2026-02-28. */
export function addMonths(s: LocalDate, n: number): LocalDate {
  const p = parseLocalDate(s);
  if (!p) return s;
  const targetMonth = (p.y * 12 + (p.m - 1)) + n;
  const y = Math.floor(targetMonth / 12);
  const m = (targetMonth % 12) + 1;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return toLocalDate(y, m, Math.min(p.d, lastDay));
}

/**
 * Parse a timestamp. Explicit offsets are honoured; offset-less timestamps are
 * Asia/Dubai (UTC+4, no daylight saving). Stored as UTC instant with a precision flag.
 */
export function parseTimestamp(raw: string): { instant: Instant; precision: "timestamp" | "date" | "none" } | null {
  const s = raw.trim();
  if (!s || s === "-" || s.toLowerCase() === "n/a" || s.toLowerCase() === "null") return null;
  // ISO with explicit offset or Z
  const iso = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.exec(s);
  if (iso) {
    const norm = s.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
    const d = new Date(norm.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(norm) ? norm : norm + "Z");
    if (!isNaN(d.getTime())) return { instant: d.toISOString().replace(".000Z", "Z"), precision: "timestamp" };
  }
  // ISO without offset → Asia/Dubai
  const naive = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?$/.exec(s);
  if (naive) {
    const d = new Date(`${naive[1]}T${naive[2]}${naive[3] ?? ":00"}Z`);
    if (!isNaN(d.getTime())) {
      const utc = new Date(d.getTime() - GST_OFFSET_MINUTES * 60_000);
      return { instant: utc.toISOString().replace(".000Z", "Z"), precision: "timestamp" };
    }
  }
  // Date-only
  const dateOnly = /^(\d{4}-\d{2}-\d{2})$/.exec(s);
  if (dateOnly && isValidLocalDate(s)) return { instant: `${s}T00:00:00Z`, precision: "date" };
  return null;
}

/** Convert an instant to a LocalDate in Asia/Dubai. */
export function instantToDubaiDate(instant: Instant): LocalDate {
  const d = new Date(instant);
  const dubai = new Date(d.getTime() + GST_OFFSET_MINUTES * 60_000);
  return toLocalDate(dubai.getUTCFullYear(), dubai.getUTCMonth() + 1, dubai.getUTCDate());
}

/** Day-month order inference per column (EC-B01). */
export type DayMonthOrder = "day_month" | "month_day";

export interface InferredDateOrder {
  order: DayMonthOrder;
  defaulted: boolean; // true → DQ-003 on affected evidence records
}

/**
 * Infer day-month order from unambiguous values in a column.
 * A fully ambiguous column defaults to day-month (UAE convention) with DQ-003.
 */
export function inferDayMonthOrder(values: string[]): InferredDateOrder {
  let dayFirst = 0;
  let monthFirst = 0;
  for (const raw of values) {
    const m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/.exec(raw.trim());
    if (!m) continue;
    const a = parseInt(m[1]!, 10);
    const b = parseInt(m[2]!, 10);
    if (a > 12 && b <= 12) dayFirst++;
    else if (b > 12 && a <= 12) monthFirst++;
  }
  if (dayFirst > 0 && dayFirst >= monthFirst) return { order: "day_month", defaulted: false };
  if (monthFirst > 0) return { order: "month_day", defaulted: false };
  return { order: "day_month", defaulted: true }; // DQ-003
}

/** Parse a cell date given the column's inferred order. Returns null when unparseable (DQ-002). */
export function parseCellDate(raw: string, order: DayMonthOrder): LocalDate | null {
  const s = raw.trim();
  if (!s) return null;
  // ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return isValidLocalDate(s) ? s : null;
  // Spreadsheet serial (EC-B03): integers 20,000–80,000
  if (/^\d{4,5}$/.test(s)) {
    const n = parseInt(s, 10);
    if (n >= 20000 && n <= 80000) {
      const ms = (n - 25569) * 86_400_000; // Excel serial → Unix epoch
      const dt = new Date(ms);
      return toLocalDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    }
    return null;
  }
  // d/m/yyyy or m/d/yyyy with / - . separators
  const m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/.exec(s);
  if (m) {
    let a = parseInt(m[1]!, 10);
    let b = parseInt(m[2]!, 10);
    let y = parseInt(m[3]!, 10);
    if (y < 100) y += y < 70 ? 2000 : 1900; // pivot 2000
    let day: number;
    let month: number;
    if (order === "day_month") { day = a; month = b; } else { day = b; month = a; }
    if (month < 1 || month > 12) return null;
    if (!isValidLocalDate(toLocalDate(y, month, day))) return null;
    return toLocalDate(y, month, day);
  }
  // Month names (English)
  const named = /^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/.exec(s) || /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (named) {
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const mi = months.findIndex((mo) => (named[1]!.toLowerCase().startsWith(mo) || named[2]!.toLowerCase().startsWith(mo)));
    if (mi >= 0) {
      const day = parseInt(/^\d/.test(named[1]!) ? named[1]! : named[2]!, 10);
      const y = parseInt(named[3]!, 10);
      if (isValidLocalDate(toLocalDate(y, mi + 1, day))) return toLocalDate(y, mi + 1, day);
    }
  }
  return null;
}

export const MONTH_NAMES_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTH_NAMES_AR = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];

/** Format a LocalDate for display: "25 Mar 2026" (en) or "٢٥ مارس ٢٠٢٦" style (ar uses Arabic month names, Western digits by default). */
export function formatLocalDate(s: LocalDate, locale: "en" | "ar" = "en"): string {
  const p = parseLocalDate(s);
  if (!p) return s;
  return locale === "en"
    ? `${p.d} ${MONTH_NAMES_EN[p.m - 1]} ${p.y}`
    : `${p.d} ${MONTH_NAMES_AR[p.m - 1]} ${p.y}`;
}

/** Compare two date-times at day precision in Asia/Dubai (EC-B05): equal-day satisfies "not before". */
export function sameDay(a: Instant, b: Instant): boolean {
  return instantToDubaiDate(a) === instantToDubaiDate(b);
}
