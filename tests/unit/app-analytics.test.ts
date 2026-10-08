import { describe, expect, it } from 'vitest';
import type { Entry, MonthSummary } from '@shared/api';
import { biggestEntries, busiestDay, monthPoints, reportMonth, trendWindow } from '@app/lib/analytics';

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
});
