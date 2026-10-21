/**
 * Versioned UAE business calendar (config as data — NON-NEGOTIABLE #22).
 * Effective-dated weekend definition: Sat–Sun from 1 Jan 2022, Fri–Sat before (EC-F04).
 * Public holidays are held as data, provisional ones carry a caveat (EC-F02).
 */

import { LocalDate, addDays, diffDays, localDateToDays } from "./dates";

export interface CalendarHoliday {
  date: LocalDate;
  name: string;
  provisional: boolean;
}

export interface UaeCalendar {
  version: string; // e.g. "uae-2025-2027.1"
  weekends: { from: LocalDate; days: number[] }[]; // 0=Sun..6=Sat (JS convention)
  holidays: CalendarHoliday[];
}

// Held as configuration data (mirrors config/calendars/uae-*.yaml)
export const UAE_CALENDAR: UaeCalendar = {
  version: "uae-2025-2027.1",
  weekends: [
    { from: "2022-01-01", days: [6, 0] }, // Saturday, Sunday
    { from: "1900-01-01", days: [5, 6] }, // Friday, Saturday before
  ],
  holidays: [
    { date: "2025-01-01", name: "New Year's Day", provisional: false },
    { date: "2025-03-30", name: "Eid al-Fitr (1 Shawwal)", provisional: true },
    { date: "2025-03-31", name: "Eid al-Fitr holiday", provisional: true },
    { date: "2025-04-01", name: "Eid al-Fitr holiday", provisional: true },
    { date: "2025-06-05", name: "Arafat Day", provisional: true },
    { date: "2025-06-06", name: "Eid al-Adha", provisional: true },
    { date: "2025-06-08", name: "Eid al-Adha holiday", provisional: true },
    { date: "2025-06-26", name: "Islamic New Year", provisional: true },
    { date: "2025-09-04", name: "Prophet Muhammad's Birthday", provisional: true },
    { date: "2025-12-01", name: "Commemoration Day", provisional: false },
    { date: "2025-12-02", name: "National Day", provisional: false },
    { date: "2025-12-03", name: "National Day holiday", provisional: false },
    { date: "2026-01-01", name: "New Year's Day", provisional: false },
    { date: "2026-03-19", name: "Eid al-Fitr (1 Shawwal)", provisional: true },
    { date: "2026-03-20", name: "Eid al-Fitr holiday", provisional: true },
    { date: "2026-03-21", name: "Eid al-Fitr holiday", provisional: true },
    { date: "2026-05-26", name: "Arafat Day", provisional: true },
    { date: "2026-05-27", name: "Eid al-Adha", provisional: true },
    { date: "2026-05-28", name: "Eid al-Adha holiday", provisional: true },
    { date: "2026-06-16", name: "Islamic New Year", provisional: true },
    { date: "2026-08-25", name: "Prophet Muhammad's Birthday", provisional: true },
    { date: "2026-12-01", name: "Commemoration Day", provisional: false },
    { date: "2026-12-02", name: "National Day", provisional: false },
    { date: "2026-12-03", name: "National Day holiday", provisional: false },
    { date: "2027-01-01", name: "New Year's Day", provisional: false },
  ],
};

const holidayIndex = new Map<string, CalendarHoliday>(UAE_CALENDAR.holidays.map((h) => [h.date, h]));

function weekendDaysFor(date: LocalDate): number[] {
  const defs = UAE_CALENDAR.weekends;
  let chosen = defs[defs.length - 1]!;
  for (const def of defs) {
    if (date >= def.from) chosen = def;
  }
  return chosen.days;
}

export function isWeekend(date: LocalDate): boolean {
  const days = localDateToDays(date);
  const dow = new Date(days * 86_400_000).getUTCDay();
  return weekendDaysFor(date).includes(dow);
}

export function isHoliday(date: LocalDate): CalendarHoliday | null {
  return holidayIndex.get(date) ?? null;
}

export function isBusinessDay(date: LocalDate): boolean {
  return !isWeekend(date) && !holidayIndex.has(date);
}

/** Add N business days (EC-F02). Returns the resulting date and any provisional holidays crossed. */
export function addBusinessDays(from: LocalDate, n: number): { date: LocalDate; provisional: string[] } {
  const provisional: string[] = [];
  let d = from;
  let remaining = Math.abs(n);
  const step = n >= 0 ? 1 : -1;
  while (remaining > 0) {
    d = addDays(d, step);
    const h = isHoliday(d);
    if (h?.provisional) provisional.push(h.date);
    if (isBusinessDay(d)) remaining--;
  }
  return { date: d, provisional };
}

/** Count business days in the inclusive interval [a, b]. */
export function businessDaysBetween(a: LocalDate, b: LocalDate): number {
  let count = 0;
  const sign = a <= b ? 1 : -1;
  let d = a;
  const end = b;
  while (sign > 0 ? d <= end : d >= end) {
    if (isBusinessDay(d)) count++;
    d = addDays(d, sign);
  }
  return sign > 0 ? count : -count;
}

/** A date outside the loaded calendar years → DQ-015 (EC-F03). */
export function dateOutsideCalendar(date: LocalDate): boolean {
  const years = UAE_CALENDAR.holidays.map((h) => parseInt(h.date.slice(0, 4), 10));
  const min = Math.min(...years, 2025);
  const max = Math.max(...years, 2027);
  const y = parseInt(date.slice(0, 4), 10);
  return y < min || y > max;
}

export function calendarVersion(): string {
  return UAE_CALENDAR.version;
}

// ── SLA business-hours clock ────────────────────────────────────────────────
// Business hours default: Mon–Fri 08:00–17:00 Asia/Dubai (config/sla.yaml equivalent),
// excluding calendar holidays. Read-only and safe-halt windows are credited (EC-J10).

export const SLA_CONFIG = {
  version: "sla-1.0.0",
  workStartHourGST: 8,
  workEndHourGST: 17,
  workDaysDow: [1, 2, 3, 4, 5], // Mon..Fri
};

export interface SlaWindow {
  ackHours: number; // business hours
  resolveHours: number;
}

export const SLA_BY_SEVERITY: Record<string, SlaWindow> = {
  CRITICAL: { ackHours: 4, resolveHours: 16 }, // 2 business days ≈ 16 business hours
  HIGH: { ackHours: 8, resolveHours: 40 },     // 5 business days
  MEDIUM: { ackHours: 24, resolveHours: 120 }, // 15 business days
  LOW: { ackHours: 40, resolveHours: 240 },    // 30 business days
};

export const ESCALATION_LADDER = [0.75, 1.0, 1.5]; // 75%, 100%, 150%

/**
 * Compute SLA deadlines from the run's as-of date, counting business hours.
 * Deterministic: as-of is an input (FS-21). Returns LocalDate strings for due dates.
 */
export function slaDeadlines(severity: string, from: LocalDate): { ackDueAt: LocalDate; resolveDueAt: LocalDate } {
  const cfg = SLA_BY_SEVERITY[severity] ?? SLA_BY_SEVERITY.LOW!;
  return {
    ackDueAt: addBusinessDaysForHours(from, cfg.ackHours),
    resolveDueAt: addBusinessDaysForHours(from, cfg.resolveHours),
  };
}

/** Advance a LocalDate by N business hours using the SLA config (simplified day-granular model). */
function addBusinessDaysForHours(from: LocalDate, hours: number): LocalDate {
  const days = Math.ceil(hours / (SLA_CONFIG.workEndHourGST - SLA_CONFIG.workStartHourGST));
  if (days <= 0) return from;
  let d = from;
  let remaining = days;
  while (remaining > 0) {
    d = addDays(d, 1);
    if (isBusinessDay(d)) remaining--;
  }
  return d;
}

export function slaEscalationLevel(severity: string, asOf: LocalDate, dueAt: LocalDate): 0 | 1 | 2 | 3 {
  const cfg = SLA_BY_SEVERITY[severity] ?? SLA_BY_SEVERITY.LOW!;
  const overdueDays = diffDays(asOf, dueAt);
  if (overdueDays <= 0) return 0;
  const totalDays = Math.ceil(cfg.resolveHours / 8);
  const ratio = overdueDays / Math.max(1, totalDays);
  if (ratio >= ESCALATION_LADDER[2]!) return 3;
  if (ratio >= ESCALATION_LADDER[1]!) return 2;
  if (ratio >= ESCALATION_LADDER[0]!) return 1;
  return 0;
}
