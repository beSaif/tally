import { describe, expect, it } from 'vitest';
import {
  addDays, addMonths, daysLeftInMonth, floorToSlot, isoWeek, isoWeekKey, monthRange, previousRange,
  shiftAnchor, weekRange, yearRange, zonedParts, isValidDay, isValidMinute, daysBetween,
} from '@shared/dates';

describe('ranges', () => {
  it('week is Monday..Sunday', () => {
    expect(weekRange('2026-10-05')).toEqual({ from: '2026-10-05', to: '2026-10-11' }); // Monday
    expect(weekRange('2026-10-11')).toEqual({ from: '2026-10-05', to: '2026-10-11' }); // Sunday
    expect(weekRange('2026-10-04')).toEqual({ from: '2026-09-28', to: '2026-10-04' });
  });
  it('month and year', () => {
    expect(monthRange('2026-10-05')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(monthRange('2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(yearRange('2026-10-05')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });
  it('previous ranges', () => {
    expect(previousRange('month', monthRange('2026-10-05'))).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(previousRange('week', weekRange('2026-10-05'))).toEqual({ from: '2026-09-28', to: '2026-10-04' });
    expect(previousRange('year', yearRange('2026-10-05'))).toEqual({ from: '2025-01-01', to: '2025-12-31' });
  });
  it('shifting anchors clamps days', () => {
    expect(shiftAnchor('month', '2026-10-31', 1)).toBe('2026-11-30');
    expect(shiftAnchor('month', '2026-01-31', -2)).toBe('2025-11-30');
    expect(shiftAnchor('week', '2026-10-05', -1)).toBe('2026-09-28');
    expect(shiftAnchor('year', '2028-02-29', 1)).toBe('2029-02-28');
  });
});

describe('calendar helpers', () => {
  it('ISO weeks', () => {
    expect(isoWeek('2026-10-05')).toEqual({ year: 2026, week: 41 });
    expect(isoWeek('2027-01-01')).toEqual({ year: 2026, week: 53 });
    expect(isoWeekKey('2026-01-01')).toBe('2026-W01');
  });
  it('day arithmetic', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(daysBetween('2026-10-01', '2026-10-31')).toBe(31);
    expect(daysLeftInMonth('2026-10-05')).toBe(26);
  });
  it('slots and validation', () => {
    expect(floorToSlot('20:37', 15)).toBe('20:30');
    expect(floorToSlot('09:00', 15)).toBe('09:00');
    expect(isValidDay('2026-02-30')).toBe(false);
    expect(isValidMinute('2026-10-05T18:05')).toBe(true);
    expect(isValidMinute('2026-10-05T24:00')).toBe(false);
  });
  it('zoned parts', () => {
    const p = zonedParts(new Date('2026-10-05T18:30:00Z'), 'Europe/Zurich');
    expect(p.day).toBe('2026-10-05');
    expect(p.hhmm).toBe('20:30');
    expect(p.weekday).toBe(1);
    const q = zonedParts(new Date('2026-10-05T23:30:00Z'), 'Asia/Tokyo');
    expect(q.day).toBe('2026-10-06');
    expect(q.hhmm).toBe('08:30');
  });
});
