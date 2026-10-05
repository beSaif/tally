import { describe, expect, it } from 'vitest';
import { answerSegments } from '@app/lib/answer';

const CATS = ['Groceries', 'Dining', 'Health', 'Health care', 'Santé'];

describe('answerSegments (design C.3)', () => {
  it('sets amounts in mono and the first category in the accent', () => {
    expect(answerSegments('You spent 1 284.60 CHF. Groceries led at 32%, dining is up.', CATS)).toEqual([
      { text: 'You spent ', kind: 'text' },
      { text: '1 284.60', kind: 'amount' },
      { text: ' CHF. ', kind: 'text' },
      { text: 'Groceries', kind: 'category' },
      { text: ' led at 32%, dining is up.', kind: 'text' },
    ]);
  });

  it('accepts the usual thousands separators and a decimal comma', () => {
    const amounts = (s: string) => answerSegments(s, []).filter((x) => x.kind === 'amount').map((x) => x.text);
    expect(amounts('1 284.60 and 1 002.30 and 1’284.60 and 12,50 and 3.00')).toEqual(['1 284.60', '1 002.30', '1’284.60', '12,50', '3.00']);
    expect(amounts('32% in 2026, 4 times')).toEqual([]);
  });

  it('highlights only the first category, case-insensitively and on word edges', () => {
    const cats = answerSegments('dining beat Groceries', CATS).filter((x) => x.kind === 'category');
    expect(cats).toEqual([{ text: 'dining', kind: 'category' }]);
    expect(answerSegments('Healthy food', CATS).some((x) => x.kind === 'category')).toBe(false);
    expect(answerSegments('Santé : 42.00 CHF', CATS)[0]).toEqual({ text: 'Santé', kind: 'category' });
  });

  it('prefers the longer name at the same position', () => {
    expect(answerSegments('Health care cost 80.00', CATS)[0]).toEqual({ text: 'Health care', kind: 'category' });
  });

  it('returns the text untouched when nothing matches', () => {
    expect(answerSegments('Nothing to say.', CATS)).toEqual([{ text: 'Nothing to say.', kind: 'text' }]);
  });
});
