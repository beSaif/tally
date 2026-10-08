import { describe, expect, it } from 'vitest';
import type { Category, Entry, MonthSummary } from '@shared/api';
import { anchorDay, averageCents, biggestEntries, busiestDay, monthPoints, reportMonth, splitFixed, summaryQuestion, trendWindow } from '@app/lib/analytics';

const entry = (id: string, amount_cents: number, occurred_at: string): Entry => ({
  id,
  amount_cents,
  currency: 'CHF',
  description: id,
  category_id: null,
  category_name: null,
  occurred_at,
  note: null,
  source: 'text',
  created_at: 0,
  updated_at: 0,
});

describe('analytics helpers', () => {
  it('trendWindow: six months ending at the period, or at today for the current one', () => {
    expect(trendWindow({ from: '2026-10-01', to: '2026-10-31' }, '2026-10-05')).toEqual({ from: '2026-05', to: '2026-10' });
    expect(trendWindow({ from: '2026-09-01', to: '2026-09-30' }, '2026-10-05')).toEqual({ from: '2026-04', to: '2026-09' });
    expect(trendWindow({ from: '2026-01-01', to: '2026-12-31' }, '2026-10-05')).toEqual({ from: '2026-05', to: '2026-10' });
    expect(trendWindow({ from: '2026-02-23', to: '2026-03-01' }, '2026-10-05')).toEqual({ from: '2025-10', to: '2026-03' });
  });

  it('monthPoints: one category per month (0 when absent), or the totals', () => {
    const months: MonthSummary[] = [
      { month: '2026-09', total_cents: 500, count: 2, by_category: [{ category_id: 'a', name: 'A', total_cents: 300, count: 1 }, { category_id: null, name: null, total_cents: 200, count: 1 }] },
      { month: '2026-10', total_cents: 0, count: 0, by_category: [] },
    ];
    expect(monthPoints(months, 'a')).toEqual([{ month: '2026-09', cents: 300 }, { month: '2026-10', cents: 0 }]);
    expect(monthPoints(months, null)).toEqual([{ month: '2026-09', cents: 200 }, { month: '2026-10', cents: 0 }]);
    expect(monthPoints(months)).toEqual([{ month: '2026-09', cents: 500 }, { month: '2026-10', cents: 0 }]);
  });

  it('busiestDay: the largest day, the earliest on a tie, null when empty', () => {
    expect(busiestDay([{ day: '2026-09-01', total_cents: 100 }, { day: '2026-09-02', total_cents: 300 }, { day: '2026-09-03', total_cents: 300 }])).toEqual({ day: '2026-09-02', total_cents: 300 });
    expect(busiestDay([])).toBeNull();
  });

  it('biggestEntries: largest first, earlier first on a tie, at most n', () => {
    const list = [entry('a', 100, '2026-09-05T10:00'), entry('b', 900, '2026-09-02T10:00'), entry('c', 500, '2026-09-09T10:00'), entry('d', 500, '2026-09-01T10:00')];
    expect(biggestEntries(list, 3).map((e) => e.id)).toEqual(['b', 'd', 'c']);
  });

  it('reportMonth: a valid, begun ?m=, else last month', () => {
    expect(reportMonth('2026-09', '2026-10-05')).toBe('2026-09');
    expect(reportMonth('2026-10', '2026-10-05')).toBe('2026-10');
    expect(reportMonth('2026-11', '2026-10-05')).toBe('2026-09');
    expect(reportMonth('2026-13', '2026-10-05')).toBe('2026-09');
    expect(reportMonth(null, '2026-01-15')).toBe('2025-12');
  });

  it('averageCents: the other months that had any entries', () => {
    const month = (m: string, total: number, count: number, dining = 0): MonthSummary => ({
      month: m,
      total_cents: total,
      count,
      by_category: dining ? [{ category_id: 'd', name: 'Dining', total_cents: dining, count: 1 }] : [],
    });
    const months = [month('2026-05', 0, 0), month('2026-06', 1000, 2, 400), month('2026-07', 3000, 3), month('2026-08', 9999, 9, 900)];
    expect(averageCents(months, '2026-08')).toBe(2000);
    expect(averageCents(months, '2026-08', 'd')).toBe(200);
    expect(averageCents([month('2026-08', 100, 1)], '2026-08')).toBeNull();
  });

  it('splitFixed: fixed categories apart from the rest, Other counted as day-to-day', () => {
    const cats: Category[] = [
      { id: 'b', name: 'Bills', position: 0, budget_cents: null, fixed: true },
      { id: 'g', name: 'Groceries', position: 1, budget_cents: null, fixed: false },
    ];
    const rows = [
      { category_id: 'b', name: 'Bills', total_cents: 500, count: 1 },
      { category_id: 'g', name: 'Groceries', total_cents: 300, count: 2 },
      { category_id: null, name: null, total_cents: 200, count: 1 },
    ];
    expect(splitFixed(rows, cats)).toEqual({ fixed: 500, daily: 500 });
  });

  it('anchorDay: a valid ?d= not after today', () => {
    expect(anchorDay('2026-09-14', '2026-10-05')).toBe('2026-09-14');
    expect(anchorDay('2026-10-28', '2026-10-05')).toBe('2026-10-05');
    expect(anchorDay('2026-02-30', '2026-10-05')).toBe('2026-10-05');
    expect(anchorDay(null, '2026-10-05')).toBe('2026-10-05');
  });

  it('summaryQuestion: carries the totals it is compared with', () => {
    const q = summaryQuestion('September 2026', 'August', {
      from: '2026-09-01',
      to: '2026-09-30',
      total_cents: 110230,
      count: 10,
      by_category: [
        { category_id: 'g', name: 'Groceries', total_cents: 38000, count: 3, prev_total_cents: 39000 },
        { category_id: 'f', name: 'Fun', total_cents: 6180, count: 1, prev_total_cents: 0 },
      ],
      by_day: [],
      previous: { total_cents: 115000, count: 5 },
    }, 'Other');
    expect(q).toContain('Sum up September 2026 in two short sentences');
    expect(q).toContain('compared with August');
    expect(q).toMatch(/August: total 1\s150\.00; by category: Groceries 390\.00\.$/);
  });
});
