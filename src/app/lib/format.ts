/**
 * Pure date/label helpers for the UI. Inputs are the app's local wall-clock strings
 * (day 'YYYY-MM-DD', minute 'YYYY-MM-DDTHH:MM'); labels are built from Intl parts so the order is
 * the same in every engine ("Sun 04", "dim. 04"). Uppercasing is left to CSS.
 */
import type { Entry, ResolvedLanguage } from '@shared/api';
import { addDays, daysBetween, parseDay, type DayRange, type PeriodKind, isoWeek, toLocalDay } from '@shared/dates';
import { localeOf, translate } from '../i18n';

const pad = (n: number) => String(n).padStart(2, '0');

/** Noon local time on a calendar day: safe from DST edges when only the date is formatted. */
export function dayToDate(day: string): Date {
  const { y, m, d } = parseDay(day);
  return new Date(y, m - 1, d, 12, 0, 0);
}

function parts(date: Date, language: ResolvedLanguage, options: Intl.DateTimeFormatOptions): Partial<Record<Intl.DateTimeFormatPartTypes, string>> {
  const out: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const p of new Intl.DateTimeFormat(localeOf(language), options).formatToParts(date)) out[p.type] = p.value;
  return out;
}

/** "Sun 04" / "dim. 04". */
export function weekdayAndDay(day: string, language: ResolvedLanguage): string {
  const p = parts(dayToDate(day), language, { weekday: 'short', day: '2-digit' });
  return `${p.weekday ?? ''} ${p.day ?? ''}`.trim();
}

/** "Oct 2026" / "oct. 2026". */
export function monthShortYear(day: string, language: ResolvedLanguage): string {
  const p = parts(dayToDate(day), language, { month: 'short', year: 'numeric' });
  return `${p.month ?? ''} ${p.year ?? ''}`.trim();
}

/** "October 2026" / "octobre 2026". */
export function monthLongYear(day: string, language: ResolvedLanguage): string {
  const p = parts(dayToDate(day), language, { month: 'long', year: 'numeric' });
  return `${p.month ?? ''} ${p.year ?? ''}`.trim();
}

/** "Oct" / "oct.". */
export function monthShort(day: string, language: ResolvedLanguage): string {
  return parts(dayToDate(day), language, { month: 'short' }).month ?? '';
}

/** "September" / "septembre". */
export function monthLong(day: string, language: ResolvedLanguage): string {
  return parts(dayToDate(day), language, { month: 'long' }).month ?? '';
}

/** "5 Oct" / "5 oct." (numeric day, short month). */
export function dayShortMonth(day: string, language: ResolvedLanguage): string {
  const p = parts(dayToDate(day), language, { day: 'numeric', month: 'short' });
  return `${p.day ?? ''} ${p.month ?? ''}`.trim();
}

/** 'YYYY-MM-DDTHH:MM' → 'HH:MM'. */
export function timeOf(minute: string): string {
  return minute.slice(11, 16);
}

export function dayOf(minute: string): string {
  return minute.slice(0, 10);
}

/** Day-group label: "Today" / "Yesterday" / "Sun 04". */
export function dayLabel(day: string, today: string, language: ResolvedLanguage): string {
  if (day === today) return translate(language, 'home.today');
  if (day === addDays(today, -1)) return translate(language, 'home.yesterday');
  return weekdayAndDay(day, language);
}

/** Confirm-sheet "When": "Today, 20:14" / "Yesterday, 12:40" / "Sat 03, 11:20". */
export function whenLabel(minute: string, today: string, language: ResolvedLanguage): string {
  const day = dayOf(minute);
  const time = timeOf(minute);
  if (day === today) return translate(language, 'when.today', { time });
  if (day === addDays(today, -1)) return translate(language, 'when.yesterday', { time });
  return translate(language, 'when.day', { day: weekdayAndDay(day, language), time });
}

/** "5–11 Oct" within a month, "28 Sep – 4 Oct" across months. */
export function weekRangeLabel(range: DayRange, language: ResolvedLanguage): string {
  const a = parseDay(range.from);
  const b = parseDay(range.to);
  if (a.m === b.m && a.y === b.y) {
    const month = parts(dayToDate(range.to), language, { month: 'short' }).month ?? '';
    return `${a.d}–${b.d} ${month}`;
  }
  return `${dayShortMonth(range.from, language)} – ${dayShortMonth(range.to, language)}`;
}

/** Overview period label: "October 2026", "Week 41 · 5–11 Oct", "2026". */
export function periodLabel(kind: PeriodKind, range: DayRange, language: ResolvedLanguage): string {
  if (kind === 'month') return monthLongYear(range.from, language);
  if (kind === 'year') return range.from.slice(0, 4);
  return translate(language, 'overview.weekLabel', { week: isoWeek(range.from).week, range: weekRangeLabel(range, language) });
}

/** "0:06" from milliseconds. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${pad(total % 60)}`;
}

export function monthKeyOf(day: string): string {
  return day.slice(0, 7);
}

export function todayLocal(now: Date = new Date()): string {
  return toLocalDay(now);
}

export interface DayGroup {
  day: string;
  totalCents: number;
  entries: Entry[];
}

/** Sort newest first: occurred_at desc, then created_at desc (same order as the API). */
export function sortEntries(entries: readonly Entry[]): Entry[] {
  return [...entries].sort((x, y) => (x.occurred_at === y.occurred_at ? y.created_at - x.created_at : x.occurred_at < y.occurred_at ? 1 : -1));
}

/** Groups already-sorted entries by local day, newest day first. */
export function groupByDay(entries: readonly Entry[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const e of sortEntries(entries)) {
    const day = dayOf(e.occurred_at);
    let g = groups[groups.length - 1];
    if (!g || g.day !== day) {
      g = { day, totalCents: 0, entries: [] };
      groups.push(g);
    }
    g.entries.push(e);
    g.totalCents += e.amount_cents;
  }
  return groups;
}

export function sumCents(entries: ReadonlyArray<{ amount_cents: number }>): number {
  return entries.reduce((s, e) => s + e.amount_cents, 0);
}

/** Totals per category name, largest first, like the summary's by_category (null: uncategorised). */
export function totalsByCategory(entries: ReadonlyArray<{ category_name: string | null; amount_cents: number }>): Array<{ name: string | null; totalCents: number }> {
  const totals = new Map<string | null, number>();
  for (const e of entries) totals.set(e.category_name, (totals.get(e.category_name) ?? 0) + e.amount_cents);
  return [...totals].map(([name, totalCents]) => ({ name, totalCents })).sort((a, b) => b.totalCents - a.totalCents);
}

/** Days of the period that have started (the current period counts up to today). */
export function elapsedDays(range: DayRange, today: string): number {
  if (today < range.from) return 0;
  const end = today < range.to ? today : range.to;
  return daysBetween(range.from, end);
}

/** Months of a year period that have started. */
export function elapsedMonths(range: DayRange, today: string): number {
  if (today < range.from) return 0;
  if (today > range.to) return 12;
  return parseDay(today).m;
}

/** Signed whole percentage change, or null when there is nothing to compare with. */
export function deltaPercent(current: number, previous: number | undefined): number | null {
  if (previous === undefined || previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

/** "+18" / "−5" / "0" (true minus sign, as in print). */
export function signedPercent(n: number): string {
  if (n > 0) return `+${n}`;
  if (n < 0) return `−${Math.abs(n)}`;
  return '0';
}

/** Plain decimal for an amount input ("21.00"), never grouped so it round-trips through parseAmount. */
export function amountInputValue(cents: number): string {
  return (cents / 100).toFixed(2);
}
