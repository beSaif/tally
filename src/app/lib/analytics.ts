/**
 * Pure helpers behind Analytics' category drill-down and the monthly report: the months a trend
 * covers, one category's line through them, the busiest day and the biggest entries.
 */
import type { Category, Entry, MonthSummary, Summary, SummaryCategory } from '@shared/api';
import { addMonths, isValidDay, type DayRange } from '@shared/dates';
import { formatAmount } from '@shared/money';

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

/**
 * The average month to compare `exclude` with: the other months of the window in which anything
 * at all was logged (months before someone started using Tally would drag it down). Null when
 * there is no such month.
 */
export function averageCents(months: readonly MonthSummary[], exclude: string, categoryId?: string | null): number | null {
  const others = months.filter((m) => m.month !== exclude && m.count > 0);
  if (others.length === 0) return null;
  const points = monthPoints(others, categoryId);
  return Math.round(points.reduce((n, p) => n + p.cents, 0) / points.length);
}

/** A period's total split into fixed costs (categories flagged fixed) and day-to-day spending. */
export function splitFixed(rows: readonly SummaryCategory[], categories: readonly Category[]): { fixed: number; daily: number } {
  const fixedIds = new Set(categories.filter((c) => c.fixed === true).map((c) => c.id));
  let fixed = 0;
  let daily = 0;
  for (const r of rows) {
    if (r.category_id !== null && fixedIds.has(r.category_id)) fixed += r.total_cents;
    else daily += r.total_cents;
  }
  return { fixed, daily };
}

/** The anchor day Analytics shows: `?d=` when it is a valid day not after today, else today. */
export function anchorDay(param: string | null, today: string): string {
  return param && isValidDay(param) && param <= today ? param : today;
}

/** The report summary's request to Gemini: what to write, with the comparison totals that the period's context lacks. */
export function summaryQuestion(title: string, comparedWith: string, s: Summary, other: string): string {
  const previous = s.by_category
    .filter((c) => (c.prev_total_cents ?? 0) > 0)
    .map((c) => `${c.name ?? other} ${formatAmount(c.prev_total_cents ?? 0)}`)
    .join(', ');
  return [
    `Sum up ${title} in two short sentences: where the money went, and the biggest change compared with ${comparedWith}. No greeting, no advice.`,
    s.previous && s.previous.total_cents > 0
      ? `${comparedWith}: total ${formatAmount(s.previous.total_cents)}; by category: ${previous || 'none'}.`
      : `Nothing was logged in ${comparedWith}.`,
  ].join('\n');
}
