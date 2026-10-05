import { describe, expect, it } from 'vitest';
import type { Entry } from '@shared/api';
import {
  amountInputValue,
  dayLabel,
  deltaPercent,
  elapsedDays,
  elapsedMonths,
  formatDuration,
  groupByDay,
  monthLong,
  monthShortYear,
  normalizeMinute,
  periodLabel,
  signedPercent,
  sumCents,
  weekRangeLabel,
  whenLabel,
} from '@app/lib/format';

const TODAY = '2026-10-05'; // a Monday

const entry = (id: string, occurred_at: string, amount_cents: number, created_at = 0): Entry => ({
  id,
  amount_cents,
  currency: 'CHF',
  description: id,
  category_id: null,
  category_name: null,
  occurred_at,
  note: null,
  source: 'text',
  created_at,
  updated_at: created_at,
});

describe('day and time labels', () => {
  it('names day groups Today / Yesterday / weekday + day', () => {
    expect(dayLabel(TODAY, TODAY, 'en')).toBe('Today');
    expect(dayLabel('2026-10-04', TODAY, 'en')).toBe('Yesterday');
    expect(dayLabel('2026-10-03', TODAY, 'en')).toBe('Sat 03');
    expect(dayLabel('2026-10-04', TODAY, 'fr')).toBe('Hier');
    expect(dayLabel('2026-10-03', TODAY, 'fr')).toBe('sam. 03');
  });

  it('writes the confirm sheet "When"', () => {
    expect(whenLabel('2026-10-05T20:14', TODAY, 'en')).toBe('Today, 20:14');
    expect(whenLabel('2026-10-04T12:40', TODAY, 'en')).toBe('Yesterday, 12:40');
    expect(whenLabel('2026-10-03T11:20', TODAY, 'en')).toBe('Sat 03, 11:20');
    expect(whenLabel('2026-10-05T20:14', TODAY, 'fr')).toBe('Aujourd’hui, 20:14');
  });

  it('labels months and periods', () => {
    expect(monthShortYear(TODAY, 'en')).toBe('Oct 2026');
    expect(monthLong('2026-09-01', 'en')).toBe('September');
    expect(monthLong('2026-09-01', 'fr')).toBe('septembre');
    expect(periodLabel('month', { from: '2026-10-01', to: '2026-10-31' }, 'en')).toBe('October 2026');
    expect(periodLabel('year', { from: '2026-01-01', to: '2026-12-31' }, 'en')).toBe('2026');
    expect(periodLabel('week', { from: '2026-10-05', to: '2026-10-11' }, 'en')).toBe('Week 41 · 5–11 Oct');
    expect(periodLabel('week', { from: '2026-10-05', to: '2026-10-11' }, 'fr')).toBe('Semaine 41 · 5–11 oct.');
    expect(weekRangeLabel({ from: '2026-09-28', to: '2026-10-04' }, 'en')).toBe('28 Sept – 4 Oct');
  });

  it('formats the recording timer', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(6_400)).toBe('0:06');
    expect(formatDuration(60_000)).toBe('1:00');
  });
});

describe('grouping', () => {
  it('groups newest day first, newest entry first, with day totals', () => {
    const groups = groupByDay([
      entry('a', '2026-10-04T09:00', 100),
      entry('b', '2026-10-05T12:00', 250, 1),
      entry('c', '2026-10-05T12:00', 50, 2),
      entry('d', '2026-10-05T08:00', 1000),
    ]);
    expect(groups.map((g) => [g.day, g.totalCents, g.entries.map((e) => e.id)])).toEqual([
      ['2026-10-05', 1300, ['c', 'b', 'd']],
      ['2026-10-04', 100, ['a']],
    ]);
    expect(sumCents(groups.flatMap((g) => g.entries))).toBe(1400);
  });
});

describe('overview maths', () => {
  it('counts the days and months of a period that have started', () => {
    expect(elapsedDays({ from: '2026-10-01', to: '2026-10-31' }, TODAY)).toBe(5);
    expect(elapsedDays({ from: '2026-09-01', to: '2026-09-30' }, TODAY)).toBe(30);
    expect(elapsedDays({ from: '2026-11-01', to: '2026-11-30' }, TODAY)).toBe(0);
    expect(elapsedMonths({ from: '2026-01-01', to: '2026-12-31' }, TODAY)).toBe(10);
    expect(elapsedMonths({ from: '2025-01-01', to: '2025-12-31' }, TODAY)).toBe(12);
  });

  it('shows a delta only against a previous total', () => {
    expect(deltaPercent(28610, 24250)).toBe(18);
    expect(deltaPercent(100, 0)).toBeNull();
    expect(deltaPercent(100, undefined)).toBeNull();
    expect(signedPercent(18)).toBe('+18');
    expect(signedPercent(-5)).toBe('−5');
    expect(signedPercent(0)).toBe('0');
  });
});

describe('inputs', () => {
  it('normalises what Gemini or a datetime input gives back', () => {
    expect(normalizeMinute('2026-10-05T20:14', 'x')).toBe('2026-10-05T20:14');
    expect(normalizeMinute('2026-10-05 20:14:33', 'x')).toBe('2026-10-05T20:14');
    expect(normalizeMinute('2026-10-03', '2026-10-05T20:14')).toBe('2026-10-03T20:14');
    expect(normalizeMinute('yesterday', '2026-10-05T20:14')).toBe('2026-10-05T20:14');
    expect(normalizeMinute(null, 'fallback')).toBe('fallback');
  });

  it('writes amounts for inputs without grouping', () => {
    expect(amountInputValue(2100)).toBe('21.00');
    expect(amountInputValue(128460)).toBe('1284.60');
  });
});
