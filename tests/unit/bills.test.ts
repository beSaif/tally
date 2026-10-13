import { describe, expect, it } from 'vitest';
import { findPatterns, firstOnOrAfter, isOccurrence, monthlyCents, nextAfter, occurrence, occurrencesBetween, patternKey, previousBefore, type PastEntry } from '@shared/bills';

describe('occurrences', () => {
  it('counts every occurrence from the anchor, so month ends clamp without drifting', () => {
    expect([0, 1, 2, 3].map((k) => occurrence('2026-01-31', 'monthly', k))).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    expect(occurrence('2024-02-29', 'yearly', 1)).toBe('2025-02-28');
    expect(occurrence('2024-02-29', 'yearly', 4)).toBe('2028-02-29');
    expect(occurrence('2026-10-28', 'quarterly', 1)).toBe('2027-01-28');
    expect(occurrence('2026-10-14', 'weekly', 3)).toBe('2026-11-04');
  });

  it('finds the first occurrence on or after a day', () => {
    expect(firstOnOrAfter('2026-10-15', 'monthly', '2026-09-01')).toBe('2026-10-15');
    expect(firstOnOrAfter('2026-01-31', 'monthly', '2026-03-15')).toBe('2026-03-31');
    expect(firstOnOrAfter('2026-01-31', 'monthly', '2026-02-28')).toBe('2026-02-28');
    expect(firstOnOrAfter('2026-01-31', 'monthly', '2026-03-01')).toBe('2026-03-31');
    expect(firstOnOrAfter('2026-10-05', 'weekly', '2026-10-13')).toBe('2026-10-19');
    expect(firstOnOrAfter('2026-10-05', 'weekly', '2026-10-12')).toBe('2026-10-12');
    expect(firstOnOrAfter('2025-03-14', 'yearly', '2026-03-15')).toBe('2027-03-14');
  });

  it('steps to the next one, tells days on the beat, and lists a range', () => {
    expect(nextAfter('2026-10-14', 'monthly', '2026-10-14')).toBe('2026-11-14');
    expect(nextAfter('2026-10-30', 'monthly', '2027-01-30')).toBe('2027-02-28');
    expect(isOccurrence('2026-01-31', 'monthly', '2026-02-28')).toBe(true);
    expect(isOccurrence('2026-01-31', 'monthly', '2026-02-27')).toBe(false);
    expect(isOccurrence('2026-01-31', 'monthly', '2025-12-31')).toBe(false);
    expect(occurrencesBetween('2026-09-14', 'monthly', '2026-09-20', '2026-12-31')).toEqual(['2026-10-14', '2026-11-14', '2026-12-14']);
    expect(occurrencesBetween('2026-10-01', 'weekly', '2026-10-01', '2027-12-31', 3)).toHaveLength(3);
  });

  it('steps back to the occurrence before a day, never past the anchor', () => {
    expect(previousBefore('2026-01-31', 'monthly', '2026-03-31')).toBe('2026-02-28');
    expect(previousBefore('2026-01-31', 'monthly', '2026-03-15')).toBe('2026-02-28');
    expect(previousBefore('2026-01-31', 'monthly', '2026-02-28')).toBe('2026-01-31');
    expect(previousBefore('2026-10-05', 'weekly', '2026-10-19')).toBe('2026-10-12');
    expect(previousBefore('2025-03-01', 'yearly', '2027-03-01')).toBe('2026-03-01');
    expect(previousBefore('2026-10-12', 'monthly', '2026-10-12')).toBeNull();
    expect(previousBefore('2026-10-12', 'monthly', '2026-10-01')).toBeNull();
  });

  it('spreads a bill over months', () => {
    expect(monthlyCents(33_500, 'yearly')).toBe(2_792);
    expect(monthlyCents(9_640, 'quarterly')).toBe(3_213);
    expect(monthlyCents(4_500, 'monthly')).toBe(4_500);
    expect(monthlyCents(1_000, 'weekly')).toBe(4_333);
  });
});

describe('findPatterns', () => {
  const at = (description: string, amount_cents: number, occurred_at: string): PastEntry => ({ description, amount_cents, currency: 'CHF', category_id: null, occurred_at });
  const none = new Set<string>();

  it('spots the same price on a monthly beat and says when it comes next', () => {
    const found = findPatterns(
      [at('Salt Home internet', 4_995, '2026-07-20T08:00'), at('Salt home Internet', 4_995, '2026-08-20T08:10'), at('Salt Home internet', 4_995, '2026-09-21T07:55'), at('Coffee', 450, '2026-09-21T09:00')],
      '2026-10-12',
      none,
      none,
    );
    expect(found).toEqual([
      {
        key: patternKey('Salt Home internet', 4_995),
        description: 'Salt Home internet',
        amount_cents: 4_995,
        currency: 'CHF',
        category_id: null,
        cadence: 'monthly',
        seen: ['2026-07-20', '2026-08-20', '2026-09-21'],
        next_due: '2026-10-21',
      },
    ]);
  });

  it('spots weekly and quarterly beats', () => {
    const weekly = ['2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05'].map((d) => at('Cleaner', 6_000, `${d}T10:00`));
    const quarterly = ['2026-01-28', '2026-04-28', '2026-07-28'].map((d) => at('SIG électricité', 9_640, `${d}T10:00`));
    const found = findPatterns([...weekly, ...quarterly], '2026-10-12', none, none);
    expect(found.map((p) => [p.description, p.cadence, p.next_due])).toEqual([
      ['Cleaner', 'weekly', '2026-10-12'],
      ['SIG électricité', 'quarterly', '2026-10-28'],
    ]);
  });

  it('ignores uneven beats, too few payments, stopped habits, known bills and dismissed ones', () => {
    const monthly = (name: string, amount = 1_000) => ['2026-07-05', '2026-08-05', '2026-09-05'].map((d) => at(name, amount, `${d}T10:00`));
    const entries = [
      ...['2026-07-01', '2026-07-20', '2026-09-05'].map((d) => at('Uneven', 1_000, `${d}T10:00`)),
      ...['2026-08-05', '2026-09-05'].map((d) => at('Twice', 1_000, `${d}T10:00`)),
      ...['2026-03-05', '2026-04-05', '2026-05-05'].map((d) => at('Stopped', 1_000, `${d}T10:00`)),
      ...monthly('Netflix', 1_890),
      ...monthly('Gym'),
      ...['2026-07-05', '2026-08-05', '2026-09-05'].map((d, i) => at('Changing', 1_000 + i, `${d}T10:00`)),
    ];
    const found = findPatterns(entries, '2026-10-12', new Set(['netflix']), new Set([patternKey('gym', 1_000)]));
    expect(found).toEqual([]);
  });
});
