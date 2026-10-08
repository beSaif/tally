/**
 * Pure helpers behind Analytics' category drill-down and the monthly report: the months a trend
 * covers, one category's line through them, the busiest day and the biggest entries.
 */
import type { Entry, MonthSummary } from '@shared/api';
import { addMonths, isValidDay, type DayRange } from '@shared/dates';

/** How many months a trend shows, the period's own month included. */
export const TREND_MONTHS = 6;

export interface MonthPoint {
  month: string; // 'YYYY-MM'
  cents: number;
}

/** The trend's months, oldest first: TREND_MONTHS ending at the period's last month that has begun. */
export function trendWindow(range: DayRange, today: string): { from: string; to: string } {
  const end = range.to > today ? today : range.to;
  return { from: addMonths(end, -(TREND_MONTHS - 1)).slice(0, 7), to: end.slice(0, 7) };
}

/** One category's month totals (null: uncategorised, "Other"), or every category's when `categoryId` is undefined. */
export function monthPoints(months: readonly MonthSummary[], categoryId?: string | null): MonthPoint[] {
  return months.map((m) => ({
    month: m.month,
    cents: categoryId === undefined ? m.total_cents : (m.by_category.find((c) => c.category_id === categoryId)?.total_cents ?? 0),
  }));
}

/** The day with the highest total; the earliest wins a tie. Null when nothing was spent. */
export function busiestDay(days: ReadonlyArray<{ day: string; total_cents: number }>): { day: string; total_cents: number } | null {
  let best: { day: string; total_cents: number } | null = null;
  for (const d of days) if (d.total_cents > 0 && (!best || d.total_cents > best.total_cents)) best = d;
  return best;
}

/** The `n` largest entries, largest first; the earlier entry wins a tie. */
export function biggestEntries(entries: readonly Entry[], n: number): Entry[] {
  return [...entries].sort((a, b) => b.amount_cents - a.amount_cents || (a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : 0)).slice(0, n);
}

/** The month a report shows: `?m=YYYY-MM` when valid and begun, else last month. */
export function reportMonth(param: string | null, today: string): string {
  const current = today.slice(0, 7);
  if (param && /^\d{4}-\d{2}$/.test(param) && isValidDay(`${param}-01`) && param <= current) return param;
  return addMonths(today, -1).slice(0, 7);
}
